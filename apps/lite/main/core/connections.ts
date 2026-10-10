import { randomBytes } from 'node:crypto';
import {
  AnthropicProvider,
  GoogleProvider,
  OpenAICompatibleVendor,
  OpenAIProvider,
  OpenRouterProvider,
  requireEndpointUrl,
  type AIProvider,
  type FetchLike,
  type ModelInfo,
  type ProviderContext,
} from '@allaya/ai';
import { AllayaError, toSerializedError } from '@allaya/shared';
import type { ConnectionView, ModelList, ModelRef, ModelView } from '../../shared/ipc';
import { presetById, type ConnectionKind } from '../../shared/presets';
import type { Db } from './db';
import type { Events } from './events';
import type { SecretStore } from './secrets';

interface Row {
  id: string;
  preset_id: string | null;
  kind: ConnectionKind;
  name: string;
  base_url: string | null;
  manual_models: string;
}

/** Stored in place of a key for a server on this computer that needs none. */
const NO_KEY = 'no-key-needed';
const MODEL_LIST_TTL_MS = 5 * 60_000;
const MODEL_LIST_TIMEOUT_MS = 20_000;

export interface ConnectionDeps {
  db: Db;
  secrets: SecretStore;
  events: Events;
  fetch?: FetchLike;
  /** Test hook: send a service's calls to a local fake. Keyed by preset id (or kind). */
  baseUrlOverrides?: Record<string, string>;
  now?: () => number;
}

export interface ResolvedModel {
  provider: AIProvider;
  ref: ModelRef;
  displayName: string;
  connectionName: string;
  contextWindow: number;
  maxOutputTokens: number;
}

/**
 * The services the person has connected for the model. Each is a row (name, kind, address) plus an encrypted key. A
 * model list is read from the service itself and kept for a few minutes; the person never has to type a model name
 * (except for a service that has no list, where they may add names by hand).
 */
export class ConnectionService {
  private readonly cache = new Map<string, { at: number; models: ModelInfo[] }>();

  constructor(private readonly deps: ConnectionDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  // ── what is connected ─────────────────────────────────────────────────────
  private rows(): Row[] {
    return this.deps.db
      .prepare(
        'select id, preset_id, kind, name, base_url, manual_models from connections order by created_at, rowid',
      )
      .all() as Row[];
  }

  private row(id: string): Row {
    const row = this.deps.db
      .prepare(
        'select id, preset_id, kind, name, base_url, manual_models from connections where id = ?',
      )
      .get(id) as Row | undefined;
    if (!row) throw new AllayaError('That connection does not exist', { code: 'NOT_FOUND' });
    return row;
  }

  private view(row: Row): ConnectionView {
    const preset = row.preset_id ? presetById(row.preset_id) : undefined;
    const keyOptional = preset?.keyOptional === true;
    const secretName = this.secretName(row.id);
    const hasKey = this.deps.secrets.has(secretName);
    const hint = hasKey ? this.deps.secrets.hint(secretName) : undefined;
    return {
      id: row.id,
      ...(row.preset_id ? { presetId: row.preset_id } : {}),
      kind: row.kind,
      name: row.name,
      ...(row.base_url ? { baseUrl: row.base_url } : {}),
      hasKey: hasKey && this.deps.secrets.get(secretName) !== NO_KEY,
      ...(hint && this.deps.secrets.get(secretName) !== NO_KEY ? { keyHint: hint } : {}),
      keyOptional,
      manualModels: JSON.parse(row.manual_models) as string[],
    };
  }

  private secretName = (id: string) => `llm:${id}`;

  list(): ConnectionView[] {
    return this.rows().map((row) => this.view(row));
  }

  // ── adding, changing, removing ────────────────────────────────────────────
  add(input: {
    presetId: string;
    name?: string | undefined;
    baseUrl?: string | undefined;
    apiKey?: string | undefined;
    manualModels?: string[] | undefined;
  }): ConnectionView {
    const preset = presetById(input.presetId);
    if (!preset) {
      throw new AllayaError('That service is not in the list', {
        code: 'INVALID_INPUT',
        details: { reason: 'unknown_preset' },
      });
    }
    const name = (input.name?.trim() || preset.name).slice(0, 60);
    let baseUrl: string | null = null;
    if (preset.kind === 'compatible') {
      baseUrl = requireEndpointUrl(input.baseUrl?.trim() || preset.baseUrl || '');
    }
    const apiKey = input.apiKey?.trim() ?? '';
    if (!apiKey && !preset.keyOptional) {
      throw new AllayaError('This service needs an API key', {
        code: 'INVALID_INPUT',
        details: { reason: 'key_required' },
      });
    }
    this.checkKey(apiKey);
    const id = `c_${randomBytes(4).toString('hex')}`;
    // The key first: if secure storage refuses, nothing is left half-added.
    this.deps.secrets.set(this.secretName(id), apiKey || NO_KEY);
    this.deps.db
      .prepare(
        `insert into connections (id, preset_id, kind, name, base_url, manual_models, created_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        preset.id,
        preset.kind,
        name,
        baseUrl,
        JSON.stringify(input.manualModels ?? []),
        this.now(),
      );
    this.changed();
    return this.view(this.row(id));
  }

  update(input: {
    id: string;
    name?: string | undefined;
    baseUrl?: string | undefined;
    apiKey?: string | undefined;
    manualModels?: string[] | undefined;
  }): ConnectionView {
    const row = this.row(input.id);
    const preset = row.preset_id ? presetById(row.preset_id) : undefined;
    const name = input.name?.trim() || row.name;
    let baseUrl = row.base_url;
    if (input.baseUrl !== undefined && row.kind === 'compatible') {
      baseUrl = requireEndpointUrl(input.baseUrl);
    }
    if (input.apiKey !== undefined) {
      const key = input.apiKey.trim();
      if (key) {
        this.checkKey(key);
        this.deps.secrets.set(this.secretName(row.id), key);
      } else if (preset?.keyOptional) {
        this.deps.secrets.set(this.secretName(row.id), NO_KEY);
      } else {
        this.deps.secrets.remove(this.secretName(row.id));
      }
    }
    this.deps.db
      .prepare('update connections set name = ?, base_url = ?, manual_models = ? where id = ?')
      .run(
        name,
        baseUrl,
        input.manualModels ? JSON.stringify(input.manualModels) : row.manual_models,
        row.id,
      );
    this.cache.delete(row.id);
    this.changed();
    return this.view(this.row(row.id));
  }

  remove(id: string): void {
    this.row(id);
    this.deps.db.prepare('delete from connections where id = ?').run(id);
    this.deps.secrets.remove(this.secretName(id));
    this.cache.delete(id);
    this.changed();
  }

  private checkKey(key: string): void {
    if (!key) return;
    // eslint-disable-next-line no-control-regex
    if (key.length < 8 || /[\s\u0000-\u001f\u007f]/.test(key)) {
      throw new AllayaError('That API key is not in a valid format', {
        code: 'INVALID_INPUT',
        details: { reason: 'bad_key' },
      });
    }
  }

  private changed(): void {
    this.deps.events.publish('connections:changed', {});
  }

  // ── talking to a service ──────────────────────────────────────────────────
  provider(id: string): AIProvider {
    const row = this.row(id);
    const override =
      this.deps.baseUrlOverrides?.[row.preset_id ?? ''] ?? this.deps.baseUrlOverrides?.[row.kind];
    const context: ProviderContext = {
      getApiKey: () => {
        const key = this.deps.secrets.get(this.secretName(id));
        if (!key) {
          throw new AllayaError(`No API key is saved for ${row.name}`, {
            code: 'PROVIDER_NOT_CONFIGURED',
            details: { connection: id },
          });
        }
        return Promise.resolve(key);
      },
      ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      ...(override ? { baseUrl: override } : {}),
    };
    switch (row.kind) {
      case 'anthropic':
        return new AnthropicProvider(context);
      case 'openai':
        return new OpenAIProvider(context);
      case 'google':
        return new GoogleProvider(context);
      case 'openrouter':
        return new OpenRouterProvider(context);
      case 'compatible':
        return new OpenAICompatibleVendor(
          { id: 'custom', name: row.name, defaultBaseUrl: row.base_url ?? '' },
          context,
        );
    }
  }

  /** Where the audio calls of a connection go, with its key read at the moment of the call. */
  audioEndpoint(id: string): {
    getApiKey: () => Promise<string>;
    baseUrl?: string;
    fetch?: FetchLike;
  } {
    const row = this.row(id);
    const override =
      this.deps.baseUrlOverrides?.[row.preset_id ?? ''] ?? this.deps.baseUrlOverrides?.[row.kind];
    const baseUrl =
      override ?? (row.kind === 'compatible' ? (row.base_url ?? undefined) : undefined);
    return {
      getApiKey: () => {
        const key = this.deps.secrets.get(this.secretName(id));
        if (!key) {
          throw new AllayaError(`No API key is saved for ${row.name}`, {
            code: 'PROVIDER_NOT_CONFIGURED',
            details: { connection: id },
          });
        }
        return Promise.resolve(key);
      },
      ...(baseUrl ? { baseUrl } : {}),
      ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
    };
  }

  async test(id: string, signal?: AbortSignal) {
    const result = await this.provider(id).testConnection(signal);
    if (result.ok) this.cache.delete(id);
    return result;
  }

  // ── models ────────────────────────────────────────────────────────────────
  private toView(row: Row, info: ModelInfo): ModelView {
    return {
      connectionId: row.id,
      connectionName: row.name,
      modelId: info.modelId,
      displayName: info.displayName,
      tier: info.tier,
      vision: info.capabilities.vision,
      reasoning: info.capabilities.reasoning,
      contextWindow: info.capabilities.contextWindow,
      inferred: info.capabilitySource === 'inferred',
    };
  }

  private manualInfo(row: Row): ModelInfo[] {
    return (JSON.parse(row.manual_models) as string[]).map((modelId) => ({
      providerId: 'custom',
      modelId,
      displayName: modelId,
      tier: 'balanced',
      capabilitySource: 'inferred',
      capabilities: {
        vision: false,
        tools: true,
        streaming: true,
        reasoning: false,
        contextWindow: 32_000,
      },
    }));
  }

  private async discover(row: Row, refresh: boolean): Promise<ModelInfo[]> {
    const cached = this.cache.get(row.id);
    if (!refresh && cached && this.now() - cached.at < MODEL_LIST_TTL_MS) return cached.models;
    const signal = AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS);
    const models = await this.provider(row.id).listModels(signal);
    this.cache.set(row.id, { at: this.now(), models });
    return models;
  }

  async models(options: { refresh?: boolean | undefined } = {}): Promise<ModelList> {
    const models: ModelView[] = [];
    const problems: ModelList['problems'] = [];
    await Promise.all(
      this.rows().map(async (row, index) => {
        const manual = this.manualInfo(row);
        const preset = row.preset_id ? presetById(row.preset_id) : undefined;
        let found: ModelInfo[] = [];
        let failure: { code: string; message: string } | undefined;
        if (!this.deps.secrets.has(this.secretName(row.id))) {
          failure = { code: 'PROVIDER_NOT_CONFIGURED', message: 'No API key is saved' };
        } else {
          try {
            found = await this.discover(row, options.refresh === true);
          } catch (error) {
            const { code, message } = toSerializedError(error);
            failure = { code, message };
          }
        }
        const seen = new Set(found.map((m) => m.modelId));
        const all = [...found, ...manual.filter((m) => !seen.has(m.modelId))];
        // A service that has no list is expected to fail the lookup; that is only a problem with nothing to offer.
        if (failure && !(manual.length > 0 || (preset?.manualModels && all.length > 0))) {
          problems.push({ connectionId: row.id, connectionName: row.name, ...failure });
        }
        // Keep the order connections were added in, whichever answered first.
        (models as Array<ModelView & { order?: number }>).push(
          ...all.map((m) => Object.assign(this.toView(row, m), { order: index })),
        );
      }),
    );
    models.sort(
      (a, b) =>
        ((a as { order?: number }).order ?? 0) - ((b as { order?: number }).order ?? 0) ||
        a.displayName.localeCompare(b.displayName),
    );
    for (const m of models) delete (m as { order?: number }).order;
    return { models, problems };
  }

  /** The provider and facts to run a model with. Uses the cached list; a model not in it still runs. */
  async resolve(ref: ModelRef): Promise<ResolvedModel> {
    const row = this.row(ref.connectionId);
    // Read the list first if it is not known yet: it holds the model's proper name and real size.
    await this.discover(row, false).catch(() => undefined);
    const known = this.cache.get(row.id)?.models.find((m) => m.modelId === ref.modelId);
    const info = known ?? this.manualInfo(row).find((m) => m.modelId === ref.modelId);
    const inferred = !info || info.capabilitySource === 'inferred';
    const window = info?.capabilities.contextWindow ?? 32_000;
    return {
      provider: this.provider(row.id),
      ref,
      displayName: info?.displayName ?? ref.modelId,
      connectionName: row.name,
      contextWindow: inferred ? Math.max(window, 32_000) : window,
      maxOutputTokens: Math.min(info?.capabilities.maxOutputTokens ?? 8192, 16_000),
    };
  }

  /**
   * Any model at all, for when the person has not chosen: the first one offered. When services are connected but none
   * can be read, the reason is raised as the error (a key the service refused, say) instead of "nothing is connected".
   */
  async firstModel(): Promise<ModelRef | undefined> {
    const { models, problems } = await this.models();
    const first = models[0];
    if (first) return { connectionId: first.connectionId, modelId: first.modelId };
    const problem = problems[0];
    if (problem) {
      throw new AllayaError(problem.message, {
        code: problem.code as 'PROVIDER_AUTH_FAILED',
        details: { connection: problem.connectionId },
      });
    }
    return undefined;
  }
}
