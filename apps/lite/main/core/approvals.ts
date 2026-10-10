import { randomBytes } from 'node:crypto';
import type { ApprovalView } from '../../shared/ipc';
import type { Events } from './events';

export type ApprovalSource = ApprovalView['source'];

/** How long a question during a chat waits: the person is there, so it is not long. */
export const CHAT_APPROVAL_WAIT_MS = 10 * 60_000;

interface Pending {
  view: ApprovalView;
  resolve: (allow: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
  detach: () => void;
}

const DETAIL_CHARS = 600;

/** Arguments as the person will read them: plain, short, and never carrying a secret-looking long token whole. */
function describeArgs(args: Record<string, unknown>): string {
  const lines = Object.entries(args).map(([key, value]) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return `${key}: ${text}`;
  });
  const joined = lines.join('\n');
  return joined.length > DETAIL_CHARS ? `${joined.slice(0, DETAIL_CHARS)}…` : joined;
}

/**
 * Questions Allaya asks before it does something that changes anything outside itself. Each one waits for the person's
 * yes or no — in the app, wherever they are in it — and nothing is assumed: no answer in time is a no, and so is a run
 * being stopped, or the app closing.
 */
export class ApprovalService {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly events: Events,
    private readonly options: {
      now?: () => number;
      /** Told when a new question is asked (a desktop notice, if the window is not in front). */
      onRequest?: (view: ApprovalView) => void;
    } = {},
  ) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  list(): ApprovalView[] {
    return [...this.pending.values()].map((p) => p.view);
  }

  private changed(): void {
    this.events.publish('approvals:changed', this.list());
  }

  request(input: {
    summary: string;
    tool: string;
    args: Record<string, unknown>;
    source: ApprovalSource;
    timeoutMs: number;
    signal?: AbortSignal | undefined;
  }): Promise<boolean> {
    return new Promise((resolve) => {
      const id = `ap_${randomBytes(6).toString('hex')}`;
      const createdAt = this.now();
      const view: ApprovalView = {
        id,
        summary: input.summary,
        tool: input.tool,
        details: describeArgs(input.args),
        source: input.source,
        createdAt,
        expiresAt: createdAt + input.timeoutMs,
      };
      if (input.signal?.aborted) {
        resolve(false);
        return;
      }
      const finish = (allow: boolean) => {
        const entry = this.pending.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        entry.detach();
        this.pending.delete(id);
        this.changed();
        resolve(allow);
      };
      const onAbort = () => finish(false);
      input.signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        view,
        resolve: finish,
        timer: setTimeout(() => finish(false), input.timeoutMs),
        detach: () => input.signal?.removeEventListener('abort', onAbort),
      });
      this.changed();
      try {
        this.options.onRequest?.(view);
      } catch {
        /* a notice that fails to show must not stop the question */
      }
    });
  }

  /** The person's answer. A question that has already gone away (timed out, run stopped) is quietly ignored. */
  decide(id: string, allow: boolean): void {
    this.pending.get(id)?.resolve(allow);
  }

  /** Every open question becomes a no (the app is closing). */
  denyAll(): void {
    for (const entry of [...this.pending.values()]) entry.resolve(false);
  }
}

/** What a chat uses to ask: the question belongs to that chat, and goes away when the reply is stopped. */
export function approverForChat(approvals: ApprovalService) {
  return (request: {
    summary: string;
    tool: { name: string };
    args: Record<string, unknown>;
    signal: AbortSignal;
    chatId: string;
  }): Promise<boolean> =>
    approvals.request({
      summary: request.summary,
      tool: request.tool.name,
      args: request.args,
      source: { kind: 'chat', chatId: request.chatId },
      timeoutMs: CHAT_APPROVAL_WAIT_MS,
      signal: request.signal,
    });
}
