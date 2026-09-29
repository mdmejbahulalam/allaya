import {
  createProviderRegistry,
  ModelRouter,
  type AIProvider,
  type ConnectionTestResult,
  type ModelInfo,
  type ModelRef,
  type ProviderFactoryOptions,
  type RoutingConfig,
} from '@allaya/ai';
import type { ProviderRepository, StoredModel } from '@allaya/database';
import { type CredentialVault } from '@allaya/security';
import { AllayaError, toSerializedError, TypedEventBus, type Logger } from '@allaya/shared';
import {
  PROVIDER_IDS,
  ROUTING_PURPOSES,
  type ProviderId,
  type RoutingPurpose,
} from '@allaya/types';
import { z, type ModelView, type ProviderView, type RoutingView } from '@allaya/validation';
import type { SettingsService } from './settings-service';

const PROVIDER_NAMES: Record<ProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  openrouter: 'OpenRouter',
};

/** Shape persisted in `models.capabilities_json` (capabilities plus the metadata the table has no column for). */
const storedCapabilitiesSchema = z.object({
  vision: z.boolean(),
  tools: z.boolean(),
  streaming: z.boolean(),
  reasoning: z.boolean(),
  contextWindow: z.number(),
  maxOutputTokens: z.number().optional(),
  tier: z.enum(['fast', 'balanced', 'frontier']),
  capabilitySource: z.enum(['provider', 'inferred']),
});
const storedCostSchema = z.object({ inputPerMTok: z.number(), outputPerMTok: z.number() });

export type ProviderEvents = { changed: ProviderView[] };

export interface ProviderServiceDeps {
  repo: ProviderRepository;
  vault: CredentialVault;
  settings: SettingsService;
  logger: Logger;
  providerOptions?: Partial<Omit<ProviderFactoryOptions, 'getApiKey'>>;
}

function toModelInfo(row: StoredModel): ModelInfo | undefined {
  let capabilities: z.infer<typeof storedCapabilitiesSchema>;
  try {
    capabilities = storedCapabilitiesSchema.parse(JSON.parse(row.capabilitiesJson));
  } catch {
    return undefined; // a corrupt row is skipped rather than crashing the router
  }
  const { tier, capabilitySource, ...caps } = capabilities;
  let cost: ModelInfo['cost'];
  if (row.costJson) {
    const parsed = storedCostSchema.safeParse(safeJson(row.costJson));
    if (parsed.success) cost = parsed.data;
  }
  return {
    providerId: row.providerId as ProviderId,
    modelId: row.modelId,
    displayName: row.displayName,
    tier,
    capabilitySource,
    capabilities: caps,
    ...(cost ? { cost } : {}),
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Owns AI provider state: which providers are connected, their discovered models, credentials (via the
 * vault), and routing preferences. The renderer only ever receives `ProviderView`s — masked hints, never keys.
 */
export class ProviderService {
  readonly events = new TypedEventBus<ProviderEvents>();
  private readonly registry;
  readonly router: ModelRouter;

  constructor(private readonly deps: ProviderServiceDeps) {
    for (const id of PROVIDER_IDS) deps.repo.ensure(id, PROVIDER_NAMES[id]);
    this.registry = createProviderRegistry({
      ...deps.providerOptions,
      getApiKey: async (id) => deps.vault.get(id),
    });
    this.router = new ModelRouter(
      () => this.availableModels(),
      () => this.routingConfig(),
    );
  }

  provider(id: ProviderId): AIProvider {
    return this.registry.get(id);
  }

  // ── views ─────────────────────────────────────────────────────────────────
  list(): ProviderView[] {
    return PROVIDER_IDS.map((id) => this.view(id));
  }

  view(id: ProviderId, extra: Partial<ProviderView> = {}): ProviderView {
    const row = this.deps.repo.get(id);
    const models = this.modelsFor(id).map((m) => this.toModelView(m));
    const status = (row?.status ?? 'not_configured') as ProviderView['status'];
    return {
      id,
      name: PROVIDER_NAMES[id],
      status,
      ...(this.deps.vault.has(id) ? { maskedKey: this.deps.vault.maskedHint(id)! } : {}),
      models,
      ...(row?.lastCheckedAt ? { lastCheckedAt: row.lastCheckedAt } : {}),
      ...(status === 'error' && row?.lastError ? { errorMessage: row.lastError } : {}),
      ...extra,
    };
  }

  /** Models the router may use: connected providers only, and only models the user hasn't disabled. */
  availableModels(): ModelInfo[] {
    const connected = PROVIDER_IDS.filter(
      (id) => this.deps.repo.get(id)?.status === 'connected' && this.deps.vault.has(id),
    );
    return this.deps.repo
      .listModels(connected)
      .filter((row) => row.enabled)
      .map(toModelInfo)
      .filter((m): m is ModelInfo => m !== undefined);
  }

  private modelsFor(id: ProviderId): ModelInfo[] {
    return this.deps.repo
      .listModels([id])
      .map(toModelInfo)
      .filter((m): m is ModelInfo => m !== undefined);
  }

  private toModelView(m: ModelInfo): ModelView {
    return { ...m };
  }

  // ── credentials & connection ──────────────────────────────────────────────
  /**
   * Saves a key, verifies it against the provider, and discovers models.
   *  - key rejected by the provider → not kept, error surfaced
   *  - provider unreachable → key kept, status `error` (the user may simply be offline)
   */
  async setKey(id: ProviderId, apiKey: string, signal?: AbortSignal): Promise<ProviderView> {
    const { warning } = this.deps.vault.set(id, apiKey);
    const outcome = await this.probe(id, signal);
    if (!outcome.result.ok && outcome.errorCode === 'PROVIDER_AUTH_FAILED') {
      this.deps.vault.remove(id);
      this.deps.repo.deleteModels(id);
      this.deps.repo.setStatus(id, 'not_configured');
      this.emitChanged();
      throw new AllayaError(outcome.result.errorMessage ?? 'The API key was rejected', {
        code: 'PROVIDER_AUTH_FAILED',
      });
    }
    this.emitChanged();
    return this.view(id, warning ? { keyWarning: warning } : {});
  }

  removeKey(id: ProviderId): ProviderView {
    this.deps.vault.remove(id);
    this.deps.repo.deleteModels(id);
    this.deps.repo.setStatus(id, 'not_configured');
    this.deps.repo.clearRoutingFor(id);
    this.emitChanged();
    return this.view(id);
  }

  async test(
    id: ProviderId,
    signal?: AbortSignal,
  ): Promise<{ result: ConnectionTestResult; provider: ProviderView }> {
    if (!this.deps.vault.has(id)) {
      throw new AllayaError(`No API key is configured for ${PROVIDER_NAMES[id]}`, {
        code: 'PROVIDER_NOT_CONFIGURED',
      });
    }
    const { result } = await this.probe(id, signal);
    this.emitChanged();
    return { result, provider: this.view(id) };
  }

  async refreshModels(id: ProviderId, signal?: AbortSignal): Promise<ProviderView> {
    await this.test(id, signal);
    return this.view(id);
  }

  /** Lists models (a free, token-less request), records the outcome, and persists discovered models. */
  private async probe(
    id: ProviderId,
    signal?: AbortSignal,
  ): Promise<{ result: ConnectionTestResult; errorCode?: string }> {
    const started = performance.now();
    try {
      const models = await this.registry.get(id).listModels(signal);
      this.deps.repo.replaceModels(
        id,
        models.map((m) => ({
          modelId: m.modelId,
          displayName: m.displayName,
          capabilitiesJson: JSON.stringify({
            ...m.capabilities,
            tier: m.tier,
            capabilitySource: m.capabilitySource,
          }),
          costJson: m.cost ? JSON.stringify(m.cost) : null,
        })),
      );
      this.deps.repo.setStatus(id, 'connected');
      this.deps.repo.recordCredentialTest(id, true);
      return {
        result: {
          ok: true,
          latencyMs: Math.round(performance.now() - started),
          modelCount: models.length,
        },
      };
    } catch (error) {
      const serialized = toSerializedError(error);
      if (serialized.code === 'CANCELLED') throw error;
      this.deps.logger.warn('Provider connection test failed', {
        provider: id,
        code: serialized.code,
      });
      this.deps.repo.setStatus(id, 'error', serialized.message);
      this.deps.repo.recordCredentialTest(id, false);
      return {
        errorCode: serialized.code,
        result: {
          ok: false,
          latencyMs: Math.round(performance.now() - started),
          errorCode: serialized.code,
          errorMessage: serialized.message,
        },
      };
    }
  }

  // ── routing ───────────────────────────────────────────────────────────────
  routingConfig(): RoutingConfig {
    const assignments: RoutingConfig['assignments'] = {};
    for (const row of this.deps.repo.getRouting()) {
      if (
        row.providerId &&
        row.modelId &&
        (ROUTING_PURPOSES as readonly string[]).includes(row.purpose)
      ) {
        assignments[row.purpose as RoutingPurpose] = {
          providerId: row.providerId as ProviderId,
          modelId: row.modelId,
        };
      }
    }
    return { autoRouting: this.deps.settings.get('ai.autoRouting'), assignments };
  }

  getRouting(): RoutingView {
    return this.routingConfig();
  }

  setRouting(patch: {
    autoRouting?: boolean;
    assignments?: Partial<Record<RoutingPurpose, ModelRef | null>>;
  }): RoutingView {
    const available = this.availableModels();
    for (const [purpose, ref] of Object.entries(patch.assignments ?? {})) {
      if (
        ref &&
        !available.some((m) => m.providerId === ref.providerId && m.modelId === ref.modelId)
      ) {
        throw new AllayaError('That model is not available from a connected provider', {
          code: 'INVALID_INPUT',
          details: { purpose },
        });
      }
    }
    for (const [purpose, ref] of Object.entries(patch.assignments ?? {})) {
      this.deps.repo.setRouting(purpose, ref?.providerId ?? null, ref?.modelId ?? null);
    }
    if (patch.autoRouting !== undefined)
      this.deps.settings.set({ key: 'ai.autoRouting', value: patch.autoRouting });
    return this.getRouting();
  }

  private emitChanged(): void {
    this.events.emit('changed', this.list());
  }
}
