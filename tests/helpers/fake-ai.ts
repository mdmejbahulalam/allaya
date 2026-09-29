import type { FetchLike } from '@allaya/ai';
import type { RecordedRequest } from './fetch';
import { modelsResponse, replyStream, toolUseStream } from './anthropic';

export interface FakeCall {
  id: string;
  name: string;
  input: unknown;
}
export type FakeTurn = { text?: string[]; calls?: FakeCall[]; stopReason?: string } | 'hang';

let n = 0;
export const aiCall = (name: string, input: unknown = {}): FakeCall => ({
  id: `toolu_${(n += 1)}`,
  name,
  input,
});
export const aiTurn = (...calls: FakeCall[]): FakeTurn => ({ calls });
export const aiStepDone = (summary: string): FakeTurn =>
  aiTurn(aiCall('finish_step', { outcome: 'done', summary }));
export const aiStepFailed = (summary: string): FakeTurn =>
  aiTurn(aiCall('finish_step', { outcome: 'failed', summary }));
export const aiPlan = (plan: Record<string, unknown>): FakeTurn =>
  aiTurn(aiCall('submit_plan', plan));
export const aiFinish = (
  outcome: 'achieved' | 'partial' | 'not_achieved',
  summary: string,
): FakeTurn => aiTurn(aiCall('finish_task', { outcome, summary }));

export interface FakeAiScript {
  /** Planner turns, in order. */
  plan?: FakeTurn[];
  /** Step turns by the plan's step id, in order (one turn per model round). */
  steps?: Record<string, FakeTurn[]>;
  /** The final answer turn(s). */
  summary?: FakeTurn[];
  /** Ordinary chat turns (no task involved). */
  chat?: FakeTurn[];
}

export interface FakeAi {
  fetch: FetchLike;
  /** Every model request that was not a model-list call, tagged by what it was for. */
  calls: Array<{
    kind: 'plan' | 'step' | 'summary' | 'chat';
    stepId?: string;
    request: RecordedRequest;
  }>;
}

type Body = {
  system?: string;
  messages?: Array<{ role: string; content: unknown }>;
  tools?: Array<{ name: string }>;
};

/** A scripted Anthropic: it recognises what each request is for (plan, a step, the answer, plain chat). */
export function fakeAi(script: FakeAiScript): FakeAi {
  const queues = {
    plan: [...(script.plan ?? [])],
    summary: [...(script.summary ?? [])],
    chat: [...(script.chat ?? [])],
    steps: Object.fromEntries(
      Object.entries(script.steps ?? {}).map(([k, v]) => [k, [...v]]),
    ) as Record<string, FakeTurn[]>,
  };
  const calls: FakeAi['calls'] = [];
  const respond = (turn: FakeTurn | undefined, signal?: AbortSignal): Response => {
    if (!turn) return replyStream(['(the fake model has nothing more to say)']);
    if (turn === 'hang') return hang(signal);
    return toolUseStream(turn);
  };
  const fetch = (async (url: string, init?: RequestInit) => {
    if (url.includes('/v1/models')) return modelsResponse();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    const request: RecordedRequest = {
      url,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    const signal = init?.signal ?? undefined;
    if (signal?.aborted) throw signal.reason ?? new DOMException('aborted', 'AbortError');
    const body = (request.body ?? {}) as Body;
    const system = body.system ?? '';
    if (system.includes('planner of Allaya')) {
      calls.push({ kind: 'plan', request });
      return respond(queues.plan.shift(), signal);
    }
    if (system.includes('A task has finished running')) {
      calls.push({ kind: 'summary', request });
      return respond(queues.summary.shift(), signal);
    }
    if (system.includes('carrying out one step of a task')) {
      const brief = JSON.stringify(body.messages?.[0]?.content ?? '');
      const stepId = /Current step ([\w-]+):/.exec(brief)?.[1] ?? '?';
      calls.push({ kind: 'step', stepId, request });
      return respond(queues.steps[stepId]?.shift(), signal);
    }
    calls.push({ kind: 'chat', request });
    return respond(queues.chat.shift(), signal);
  }) as FetchLike;
  return { fetch, calls };
}

/** A reply that never finishes until the request is aborted. */
function hang(signal: AbortSignal | undefined): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(''));
      signal?.addEventListener('abort', () => {
        try {
          controller.error(signal.reason ?? new Error('aborted'));
        } catch {
          /* already closed */
        }
      });
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
