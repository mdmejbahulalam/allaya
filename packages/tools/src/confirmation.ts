import { TypedEventBus, newId } from '@allaya/shared';
import type { PermissionSubject, RiskLevel } from '@allaya/types';
import type { ConfirmationChannel } from './policy';

export interface ConfirmationRequest {
  id: string;
  callId: string;
  tool: string;
  risk: RiskLevel;
  /** One line, in the user's language, naming exactly what will happen. */
  summary: string;
  subjects: readonly PermissionSubject[];
  /** Where an answer is accepted from. CRITICAL actions accept only `ui`. */
  channels: readonly ConfirmationChannel[];
  conversationId?: string | undefined;
  createdAt: number;
  expiresAt: number;
}

export type ConfirmationDecision = 'approved' | 'rejected' | 'expired' | 'cancelled';

export type RespondResult = { ok: true } | { ok: false; reason: 'unknown' | 'channel_not_allowed' };

type Events = {
  requested: ConfirmationRequest;
  resolved: { id: string; callId: string; decision: ConfirmationDecision };
};

interface Pending {
  request: ConfirmationRequest;
  settle: (decision: ConfirmationDecision) => void;
}

export interface BrokerOptions {
  /** How long a question stays open. Silence is a "no". */
  timeoutMs?: number;
  now?: () => number;
}

/**
 * Holds actions that are waiting for the user's yes/no.
 *
 * The approval belongs to one specific request: the executor freezes the validated arguments *before* asking and
 * runs exactly those after a yes, so an approval can never be applied to something else. Expiry, cancellation and
 * a second answer are all safe no-ops.
 */
export class ConfirmationBroker {
  readonly events = new TypedEventBus<Events>();
  private readonly pendingById = new Map<string, Pending>();
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(options: BrokerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.now = options.now ?? Date.now;
  }

  pending(): ConfirmationRequest[] {
    return [...this.pendingById.values()].map((p) => p.request);
  }

  /** Waits for the user. Resolves `expired` on silence and `cancelled` if `signal` aborts first. */
  request(
    input: Omit<ConfirmationRequest, 'id' | 'createdAt' | 'expiresAt'>,
    signal?: AbortSignal,
  ): Promise<ConfirmationDecision> {
    const createdAt = this.now();
    const request: ConfirmationRequest = {
      ...input,
      id: newId('confirm'),
      createdAt,
      expiresAt: createdAt + this.timeoutMs,
    };
    return new Promise<ConfirmationDecision>((resolve) => {
      let done = false;
      const timer = setTimeout(() => settle('expired'), this.timeoutMs);
      timer.unref?.();
      const onAbort = () => settle('cancelled');
      const settle = (decision: ConfirmationDecision) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.pendingById.delete(request.id);
        this.events.emit('resolved', { id: request.id, callId: request.callId, decision });
        resolve(decision);
      };
      if (signal?.aborted) {
        resolve('cancelled');
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pendingById.set(request.id, { request, settle });
      this.events.emit('requested', request);
    });
  }

  respond(
    id: string,
    decision: 'approved' | 'rejected',
    channel: ConfirmationChannel,
  ): RespondResult {
    const entry = this.pendingById.get(id);
    if (!entry) return { ok: false, reason: 'unknown' };
    // A rejection is always welcome from anywhere; an approval only from a channel the policy allows.
    if (decision === 'approved' && !entry.request.channels.includes(channel)) {
      return { ok: false, reason: 'channel_not_allowed' };
    }
    entry.settle(decision);
    return { ok: true };
  }

  /** Cancels every open question (emergency stop, shutdown). */
  cancelAll(): number {
    const entries = [...this.pendingById.values()];
    for (const entry of entries) entry.settle('cancelled');
    return entries.length;
  }
}
