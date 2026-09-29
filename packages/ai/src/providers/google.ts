import { AllayaError, redactString } from '@allaya/shared';
import { BaseProvider } from '../base-provider';
import { inferCapabilities, inferTier, isChatModel } from '../catalog';
import { postJson, send } from '../http';
import { parseSse } from '../sse';
import type {
  AIMessage,
  AIRequest,
  FinishReason,
  ModelInfo,
  StreamEvent,
  ToolChoice,
} from '../types';

// ── Wire types ──────────────────────────────────────────────────────────────
type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiChunk {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        functionCall?: { name: string; args?: Record<string, unknown> };
      }>;
    };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { message?: string; status?: string };
}

interface GeminiModelEntry {
  name: string;
  displayName?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
  thinking?: boolean;
}

// ── Schema sanitising ───────────────────────────────────────────────────────
/** Keys the Gemini function-declaration schema (an OpenAPI 3.0 subset) does not accept. */
const UNSUPPORTED_KEYS = new Set([
  '$schema',
  '$id',
  '$ref',
  '$defs',
  'definitions',
  'additionalProperties',
  'default',
  'examples',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'patternProperties',
  'const',
  'title',
  'if',
  'then',
  'else',
  'not',
  'oneOf',
  'allOf',
  'contentMediaType',
  'contentEncoding',
  'readOnly',
  'writeOnly',
  'deprecated',
]);

export function sanitizeGeminiSchema(schema: unknown): Record<string, unknown> {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return {};
  const input = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    if (UNSUPPORTED_KEYS.has(key)) continue;
    if (key === 'type' && Array.isArray(value)) {
      // ["string","null"] → type: string, nullable: true
      const types = value.filter((t): t is string => typeof t === 'string');
      const concrete = types.filter((t) => t !== 'null');
      if (concrete[0]) out['type'] = concrete[0];
      if (types.includes('null')) out['nullable'] = true;
    } else if (key === 'properties' && value && typeof value === 'object') {
      out['properties'] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([name, sub]) => [
          name,
          sanitizeGeminiSchema(sub),
        ]),
      );
    } else if (key === 'items') {
      out['items'] = sanitizeGeminiSchema(value);
    } else if (key === 'anyOf' && Array.isArray(value)) {
      // Optional/nullable unions are the common case: collapse `anyOf: [X, {type:null}]` to X + nullable.
      const nonNull = value.filter(
        (v) => !(v && typeof v === 'object' && (v as { type?: unknown }).type === 'null'),
      );
      if (nonNull.length === 1) {
        Object.assign(out, sanitizeGeminiSchema(nonNull[0]));
        if (nonNull.length !== value.length) out['nullable'] = true;
      }
    } else out[key] = value;
  }
  // `const` → single-value enum, which Gemini does understand.
  if ('const' in input) out['enum'] = [input['const']];
  return out;
}

// ── Translation ─────────────────────────────────────────────────────────────
export function toGeminiContents(messages: AIMessage[]): GeminiContent[] {
  // Gemini identifies function results by *name*, not id: look the name up from the earlier call.
  const nameById = new Map<string, string>();
  for (const message of messages) {
    if (typeof message.content === 'string') continue;
    for (const part of message.content)
      if (part.type === 'tool_call') nameById.set(part.id, part.name);
  }

  const out: GeminiContent[] = [];
  for (const message of messages) {
    const role = message.role === 'assistant' ? 'model' : 'user';
    const parts: GeminiPart[] = [];
    if (typeof message.content === 'string') {
      if (message.content.trim()) parts.push({ text: message.content });
    } else {
      for (const part of message.content) {
        switch (part.type) {
          case 'text':
            if (part.text.trim()) parts.push({ text: part.text });
            break;
          case 'image':
            parts.push({ inlineData: { mimeType: part.mediaType, data: part.dataBase64 } });
            break;
          case 'tool_call':
            parts.push({ functionCall: { name: part.name, args: part.arguments } });
            break;
          case 'tool_result':
            parts.push({
              functionResponse: {
                name: nameById.get(part.toolCallId) ?? part.toolCallId,
                response: part.isError ? { error: part.content } : { result: part.content },
              },
            });
            break;
        }
      }
    }
    if (parts.length === 0) continue;
    const previous = out[out.length - 1];
    if (previous && previous.role === role) previous.parts.push(...parts);
    else out.push({ role, parts });
  }
  return out;
}

function toToolConfig(choice: ToolChoice | undefined): Record<string, unknown> | undefined {
  if (choice === undefined) return undefined;
  if (choice === 'auto') return { functionCallingConfig: { mode: 'AUTO' } };
  if (choice === 'none') return { functionCallingConfig: { mode: 'NONE' } };
  if (choice === 'required') return { functionCallingConfig: { mode: 'ANY' } };
  return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [choice.name] } };
}

export function toGeminiBody(request: AIRequest): Record<string, unknown> {
  const toolConfig = request.tools?.length ? toToolConfig(request.toolChoice) : undefined;
  return {
    contents: toGeminiContents(request.messages),
    ...(request.system ? { systemInstruction: { parts: [{ text: request.system }] } } : {}),
    ...(request.tools?.length
      ? {
          tools: [
            {
              functionDeclarations: request.tools.map((tool) => {
                const parameters = sanitizeGeminiSchema(tool.inputSchema);
                const hasProperties =
                  parameters['properties'] && Object.keys(parameters['properties']).length > 0;
                return {
                  name: tool.name,
                  description: tool.description,
                  // Gemini rejects an object schema with no properties: omit it for zero-argument tools.
                  ...(hasProperties ? { parameters } : {}),
                };
              }),
            },
          ],
        }
      : {}),
    ...(toolConfig ? { toolConfig } : {}),
    generationConfig: {
      ...(request.maxTokens !== undefined ? { maxOutputTokens: request.maxTokens } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    },
  };
}

const FINISH: Record<string, FinishReason> = {
  STOP: 'stop',
  MAX_TOKENS: 'length',
  SAFETY: 'content_filter',
  RECITATION: 'content_filter',
  BLOCKLIST: 'content_filter',
  PROHIBITED_CONTENT: 'content_filter',
  SPII: 'content_filter',
  IMAGE_SAFETY: 'content_filter',
};

const modelPath = (model: string) => encodeURIComponent(model.replace(/^models\//, ''));

export class GoogleProvider extends BaseProvider {
  readonly id = 'google' as const;
  readonly name = 'Google';
  protected readonly defaultBaseUrl = 'https://generativelanguage.googleapis.com/v1beta';
  private callCounter = 0;

  /** The key travels in a header, never the URL, so it cannot end up in logs or error messages. */
  private async headers(): Promise<Record<string, string>> {
    return { 'x-goog-api-key': await this.context.getApiKey(), 'content-type': 'application/json' };
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const models: ModelInfo[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const body = await postJson<{ models?: GeminiModelEntry[]; nextPageToken?: string }>(
        this.http(),
        {
          url: `${this.baseUrl}/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`,
          method: 'GET',
          headers: await this.headers(),
          signal,
        },
      );
      for (const entry of body.models ?? []) {
        const id = entry.name.replace(/^models\//, '');
        if (
          !(entry.supportedGenerationMethods ?? []).includes('generateContent') ||
          !isChatModel('google', id)
        )
          continue;
        const inferred = inferCapabilities('google', id);
        models.push({
          providerId: 'google',
          modelId: id,
          displayName: entry.displayName ?? id,
          tier: inferTier(id),
          capabilitySource: typeof entry.inputTokenLimit === 'number' ? 'provider' : 'inferred',
          capabilities: {
            ...inferred,
            contextWindow: entry.inputTokenLimit ?? inferred.contextWindow,
            reasoning: entry.thinking ?? inferred.reasoning,
            ...(typeof entry.outputTokenLimit === 'number'
              ? { maxOutputTokens: entry.outputTokenLimit }
              : {}),
          },
        });
      }
      pageToken = body.nextPageToken;
      if (!pageToken) break;
    }
    return models;
  }

  async *stream(request: AIRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    const { response, dispose } = await send(this.http(), {
      url: `${this.baseUrl}/models/${modelPath(request.model)}:streamGenerateContent?alt=sse`,
      headers: await this.headers(),
      body: toGeminiBody(request),
      signal,
    });

    try {
      if (!response.body)
        throw new AllayaError('google: empty response body', { code: 'PROVIDER_ERROR' });
      let finishReason: FinishReason | undefined;
      let sawToolCall = false;
      yield { type: 'start', model: request.model };

      for await (const message of parseSse(response.body)) {
        let chunk: GeminiChunk;
        try {
          chunk = JSON.parse(message.data) as GeminiChunk;
        } catch {
          continue;
        }
        if (chunk.error) {
          throw new AllayaError(`google: ${redactString(chunk.error.message ?? 'stream error')}`, {
            code: 'PROVIDER_ERROR',
            details: { provider: 'google', status: chunk.error.status },
          });
        }
        if (chunk.promptFeedback?.blockReason) finishReason = 'content_filter';

        const candidate = chunk.candidates?.[0];
        for (const part of candidate?.content?.parts ?? []) {
          if (part.text) yield { type: 'text_delta', text: part.text };
          if (part.functionCall) {
            sawToolCall = true;
            this.callCounter += 1;
            yield {
              type: 'tool_call',
              call: {
                id: `gemini_call_${this.callCounter}`,
                name: part.functionCall.name,
                arguments: part.functionCall.args ?? {},
              },
            };
          }
        }
        if (candidate?.finishReason) finishReason = FINISH[candidate.finishReason] ?? 'error';

        if (chunk.usageMetadata) {
          yield {
            type: 'usage',
            usage: {
              ...(chunk.usageMetadata.promptTokenCount !== undefined
                ? { inputTokens: chunk.usageMetadata.promptTokenCount }
                : {}),
              ...(chunk.usageMetadata.candidatesTokenCount !== undefined
                ? { outputTokens: chunk.usageMetadata.candidatesTokenCount }
                : {}),
            },
          };
        }
      }

      if (finishReason !== undefined) {
        yield {
          type: 'finish',
          reason: sawToolCall && finishReason === 'stop' ? 'tool_calls' : finishReason,
        };
      }
    } finally {
      dispose();
    }
  }
}
