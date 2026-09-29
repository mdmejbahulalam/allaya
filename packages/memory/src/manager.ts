import { AllayaError, newId } from '@allaya/shared';
import type { MemoryCategory } from '@allaya/types';
import {
  MAX_MEMORIES,
  MAX_MEMORY_KEY_CHARS,
  MAX_MEMORY_VALUE_CHARS,
  memoryInputSchema,
  type MemoryInput,
} from '@allaya/validation';
import { checkText } from './guard';
import { memoryBlock, fitToBudget } from './prompt';
import { rank } from './retrieve';
import type { MemoryOrigin, MemoryRecord, MemoryStore } from './store';
import { fold } from './text';

/** Categories only the person may write: standing orders that would shape every reply. */
export const PERSON_ONLY_CATEGORIES: ReadonlySet<MemoryCategory> = new Set(['instructions']);

export interface MemoryManagerDeps {
  store: MemoryStore;
  /** The person's master switch. */
  enabled: () => boolean;
  now?: () => number;
  onChange?: () => void;
}

export interface MemoryOverviewData {
  memories: MemoryRecord[];
  enabled: boolean;
  limit: number;
}

export interface PromptMemories {
  /** The text for the system prompt, or none when nothing is relevant (or memory is off). */
  text?: string | undefined;
  /** What was included, for the "used" line under a reply. */
  used: Array<{ id: string; key: string }>;
}

const same = (a: string, b: string) =>
  fold(a).replace(/\s+/g, ' ') === fold(b).replace(/\s+/g, ' ');
const tidy = (text: string) => text.normalize('NFC').replace(/\s+/g, ' ').trim();

const refuse = (
  reason: string,
  message: string,
  code: 'INVALID_INPUT' | 'PERMISSION_DENIED' = 'INVALID_INPUT',
) => new AllayaError(message, { code, details: { reason } });

/**
 * What Allaya remembers. The person owns it: they can add, change, remove and export every entry, and switch the
 * whole thing off. Allaya (the model) can only *propose* an entry, through `remember`, and that goes through the tool
 * pipeline's confirmation first — nothing it proposes is stored without a yes on the screen.
 */
export class MemoryManager {
  private readonly now: () => number;

  constructor(private readonly deps: MemoryManagerDeps) {
    this.now = deps.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.deps.enabled();
  }

  // ── what the screen uses ──────────────────────────────────────────────────
  overview(): MemoryOverviewData {
    return { memories: this.deps.store.list(), enabled: this.enabled, limit: MAX_MEMORIES };
  }

  get(id: string): MemoryRecord | undefined {
    return this.deps.store.get(id);
  }

  /** The person adds one on the Memory screen. */
  create(input: MemoryInput): MemoryRecord {
    return this.add(input, 'user', 'screen');
  }

  /** The person changes one. It is theirs from then on, whoever proposed it first. */
  update(id: string, input: MemoryInput): MemoryRecord {
    const current = this.require(id);
    const clean = this.check(input, false);
    const clash = this.findSame(clean.category, clean.key);
    if (clash && clash.id !== id) {
      throw refuse('duplicate', 'There is already a memory with that title in that category');
    }
    const updated = this.deps.store.update(current.id, {
      ...clean,
      source: 'user',
      updatedAt: this.now(),
    });
    this.changed();
    return updated;
  }

  remove(id: string): void {
    this.require(id);
    this.deps.store.remove(id);
    this.changed();
  }

  removeAll(): number {
    const removed = this.deps.store.removeAll();
    this.changed();
    return removed;
  }

  exportJson(): string {
    return JSON.stringify(
      {
        exportedAt: new Date(this.now()).toISOString(),
        memories: this.deps.store.list().map((m) => ({
          category: m.category,
          key: m.key,
          value: m.value,
          source: m.source,
          createdAt: new Date(m.createdAt).toISOString(),
        })),
      },
      null,
      2,
    );
  }

  // ── what the model's tools use ────────────────────────────────────────────
  /** What is already remembered under this title (so the question can say what would be replaced). */
  existing(category: MemoryCategory, key: string): MemoryRecord | undefined {
    return this.findSame(category, tidy(key));
  }

  /** A proposal from the model, after the person said yes. Replaces an entry with the same title. */
  remember(input: MemoryInput): { record: MemoryRecord; replaced?: string | undefined } {
    if (!this.enabled) throw refuse('memory_off', 'Memory is switched off', 'PERMISSION_DENIED');
    if (PERSON_ONLY_CATEGORIES.has(input.category)) {
      throw refuse(
        'person_only',
        'Only the user can add standing instructions',
        'PERMISSION_DENIED',
      );
    }
    const clean = this.check(input, true);
    const previous = this.findSame(clean.category, clean.key);
    if (previous) {
      const record = this.deps.store.update(previous.id, {
        value: clean.value,
        key: clean.key,
        source: 'inferred',
        origin: 'chat',
        updatedAt: this.now(),
      });
      this.changed();
      return { record, replaced: previous.value };
    }
    return { record: this.add(clean, 'inferred', 'chat') };
  }

  /** Memories matching a search, best first (the model's `recall`). Does not count as a use. */
  search(query: string, limit = 5): MemoryRecord[] {
    if (!this.enabled) return [];
    return rank(this.deps.store.list(), query)
      .slice(0, limit)
      .map((r) => r.memory);
  }

  /** The model asks to forget one, after the person said yes. */
  forget(id: string): void {
    if (!this.enabled) throw refuse('memory_off', 'Memory is switched off', 'PERMISSION_DENIED');
    this.remove(id);
  }

  // ── what the prompt uses ──────────────────────────────────────────────────
  /** The memories to give the AI for a request, marked as used. Nothing at all when memory is off. */
  forPrompt(query: string): PromptMemories {
    if (!this.enabled) return { used: [] };
    const ranked = rank(this.deps.store.list(), query).map((r) => r.memory);
    const chosen = fitToBudget(ranked);
    if (chosen.length === 0) return { used: [] };
    this.deps.store.touch(
      chosen.map((m) => m.id),
      this.now(),
    );
    return {
      text: memoryBlock(chosen),
      used: chosen.map((m) => ({ id: m.id, key: m.key })),
    };
  }

  // ── plumbing ──────────────────────────────────────────────────────────────
  private add(input: MemoryInput, source: 'user' | 'inferred', origin: MemoryOrigin): MemoryRecord {
    const clean = this.check(input, source === 'inferred');
    if (this.findSame(clean.category, clean.key)) {
      throw refuse('duplicate', 'There is already a memory with that title in that category');
    }
    if (this.deps.store.list().length >= MAX_MEMORIES) {
      throw new AllayaError('The memory is full', {
        code: 'LIMIT_EXCEEDED',
        details: { limit: MAX_MEMORIES },
      });
    }
    const at = this.now();
    const record: MemoryRecord = {
      id: newId('mem'),
      ...clean,
      source,
      origin,
      useCount: 0,
      createdAt: at,
      updatedAt: at,
    };
    this.deps.store.insert(record);
    this.changed();
    return record;
  }

  /** Validates, tidies and runs the guard. Throws with a reason the caller can turn into words. */
  private check(input: MemoryInput, fromModel: boolean): MemoryInput {
    const parsed = memoryInputSchema.safeParse({
      category: input.category,
      key: tidy(input.key),
      value: tidy(input.value),
    });
    if (!parsed.success) {
      throw refuse('invalid', parsed.error.issues[0]?.message ?? 'That is not a valid memory');
    }
    const reason = checkText([parsed.data.key, parsed.data.value], fromModel);
    if (reason === 'looks_secret') {
      throw refuse(
        'looks_secret',
        'That looks like a password, key or card number, which Allaya does not keep',
      );
    }
    if (reason === 'tries_to_change_rules') {
      throw refuse(
        'tries_to_change_rules',
        'A memory cannot change how Allaya asks for permission',
      );
    }
    return parsed.data;
  }

  private findSame(category: MemoryCategory, key: string): MemoryRecord | undefined {
    return this.deps.store.list().find((m) => m.category === category && same(m.key, key));
  }

  private require(id: string): MemoryRecord {
    const found = this.deps.store.get(id);
    if (!found) throw new AllayaError('Memory not found', { code: 'NOT_FOUND' });
    return found;
  }

  private changed(): void {
    this.deps.onChange?.();
  }
}

export const MEMORY_LIMITS = {
  items: MAX_MEMORIES,
  keyChars: MAX_MEMORY_KEY_CHARS,
  valueChars: MAX_MEMORY_VALUE_CHARS,
} as const;
