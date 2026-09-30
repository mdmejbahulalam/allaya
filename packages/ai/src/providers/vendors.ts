import type { ProviderId } from '@allaya/types';
import { inferCapabilities, inferTier, isChatModel } from '../catalog';
import { postJson } from '../http';
import type { ModelInfo } from '../types';
import { OpenAICompatibleProvider, type OpenAICompatibleConfig } from './openai-compatible';

export interface VendorSpec {
  id: ProviderId;
  name: string;
  defaultBaseUrl: string;
}

/** Vendors that speak the OpenAI format at a fixed address. Adding one is a line here and an id in `@allaya/types`. */
export const VENDORS: readonly VendorSpec[] = [
  { id: 'groq', name: 'Groq', defaultBaseUrl: 'https://api.groq.com/openai/v1' },
  { id: 'mistral', name: 'Mistral', defaultBaseUrl: 'https://api.mistral.ai/v1' },
  { id: 'deepseek', name: 'DeepSeek', defaultBaseUrl: 'https://api.deepseek.com/v1' },
  { id: 'xai', name: 'xAI', defaultBaseUrl: 'https://api.x.ai/v1' },
  { id: 'together', name: 'Together AI', defaultBaseUrl: 'https://api.together.xyz/v1' },
  // The address of these two is the person's: this is only where a local model server usually is.
  { id: 'ollama', name: 'Ollama (this computer)', defaultBaseUrl: 'http://localhost:11434/v1' },
  { id: 'custom', name: 'Custom (OpenAI-compatible)', defaultBaseUrl: 'http://localhost:1234/v1' },
];

interface ModelListEntry {
  id?: unknown;
  created?: unknown;
  /** Together returns `{ id, type: 'chat' | 'image' | … }`. */
  type?: unknown;
}

/** Accepts both `{ data: [...] }` (the standard) and a bare array (some servers). */
export function modelEntries(body: unknown): ModelListEntry[] {
  const list = Array.isArray(body) ? body : (body as { data?: unknown } | null)?.data;
  return Array.isArray(list) ? (list as ModelListEntry[]) : [];
}

/**
 * A provider that speaks the OpenAI chat format under a name and address of its own. Models are discovered from
 * `GET {base}/models`, filtered to chat models, and described by name — their sizes and abilities are guesses,
 * flagged as such (`capabilitySource: 'inferred'`), so the person always chooses from what the service really lists.
 */
export class OpenAICompatibleVendor extends OpenAICompatibleProvider {
  readonly id: ProviderId;
  readonly name: string;
  protected readonly defaultBaseUrl: string;
  protected readonly config: OpenAICompatibleConfig = { maxTokensParam: 'max_tokens' };

  constructor(
    spec: VendorSpec,
    context: ConstructorParameters<typeof OpenAICompatibleProvider>[0],
  ) {
    super(context);
    this.id = spec.id;
    this.name = spec.name;
    this.defaultBaseUrl = spec.defaultBaseUrl;
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const body = await postJson<unknown>(this.http(), {
      url: `${this.baseUrl}/models`,
      method: 'GET',
      headers: await this.headers(),
      signal,
    });
    const seen = new Set<string>();
    return modelEntries(body)
      .filter((entry): entry is ModelListEntry & { id: string } => typeof entry.id === 'string')
      .filter(
        (entry) => entry.type === undefined || entry.type === 'chat' || entry.type === 'language',
      )
      .filter((entry) => /^[\w./:@+-]{1,200}$/.test(entry.id) && isChatModel(this.id, entry.id))
      .filter((entry) => (seen.has(entry.id) ? false : (seen.add(entry.id), true)))
      .sort((a, b) => (Number(b.created) || 0) - (Number(a.created) || 0))
      .map((entry): ModelInfo => ({
        providerId: this.id,
        modelId: entry.id,
        displayName: entry.id,
        capabilities: inferCapabilities(this.id, entry.id),
        tier: inferTier(entry.id),
        capabilitySource: 'inferred',
      }));
  }
}
