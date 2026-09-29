import { AllayaError } from '@allaya/shared';
import type { ProviderId, RoutingPurpose, TaskComplexity } from '@allaya/types';
import type { ModelInfo, ModelTier } from './types';

export interface ModelRef {
  providerId: ProviderId;
  modelId: string;
}

export interface RoutingConfig {
  /** When on, the router picks by task needs and treats assignments as a preference. When off, assignments rule. */
  autoRouting: boolean;
  assignments: Partial<Record<RoutingPurpose, ModelRef>>;
}

export interface RouteRequest {
  purpose?: RoutingPurpose;
  complexity?: TaskComplexity;
  needsVision?: boolean;
  needsTools?: boolean;
  /** Rough prompt size; used only as a hard "must fit" constraint. */
  estimatedInputTokens?: number;
  preferLowLatency?: boolean;
  preferLowCost?: boolean;
  /** A model the user explicitly picked for this conversation. Honoured whenever it is eligible. */
  pinned?: ModelRef;
}

export type RouteSource = 'pinned' | 'user_assignment' | 'auto' | 'only_option';

export interface RouteDecision {
  model: ModelInfo;
  source: RouteSource;
  /** Short, user-presentable explanation ("Vision required → …"). Shown in the UI for transparency. */
  reason: string;
}

const TIER_INDEX: Record<ModelTier, number> = { fast: 0, balanced: 1, frontier: 2 };
const OUTPUT_HEADROOM_TOKENS = 4096;

const sameModel = (model: ModelInfo, ref: ModelRef) =>
  model.providerId === ref.providerId && model.modelId === ref.modelId;

export function desiredTier(request: RouteRequest): ModelTier {
  if (request.purpose === 'reasoning' || request.purpose === 'agent_planning') return 'frontier';
  if (request.purpose === 'fast') return 'fast';
  if (request.complexity === 'complex') return 'frontier';
  if (request.complexity === 'multi_step') return 'balanced';
  if (request.complexity === 'trivial' || request.complexity === 'simple') {
    return request.purpose === 'coding' ? 'balanced' : 'fast';
  }
  return 'balanced';
}

/**
 * Chooses which connected model handles a request. Decision order:
 *   1. hard requirements (vision, tools, context fit) filter the candidates — never violated
 *   2. an explicit per-conversation pin wins
 *   3. with auto-routing OFF, the user's per-purpose assignment wins
 *   4. otherwise score by tier fit, preference, latency, cost (deterministic tie-break)
 */
export class ModelRouter {
  constructor(
    private readonly getModels: () => ModelInfo[],
    private readonly getConfig: () => RoutingConfig,
  ) {}

  select(request: RouteRequest = {}): RouteDecision {
    const available = this.getModels();
    if (available.length === 0) {
      throw new AllayaError('No AI provider is configured', { code: 'PROVIDER_NOT_CONFIGURED' });
    }

    const eligible = available.filter((model) => this.meetsRequirements(model, request));
    if (eligible.length === 0) {
      const missing = [
        request.needsVision && !available.some((m) => m.capabilities.vision) ? 'vision' : undefined,
        request.needsTools && !available.some((m) => m.capabilities.tools) ? 'tools' : undefined,
        request.estimatedInputTokens !== undefined ? 'context length' : undefined,
      ].filter(Boolean);
      throw new AllayaError(
        `No connected model supports: ${missing.join(', ') || 'this request'}`,
        {
          code: 'PROVIDER_NOT_CONFIGURED',
          details: { missing },
        },
      );
    }

    if (request.pinned) {
      const pinned = eligible.find((m) => sameModel(m, request.pinned!));
      if (pinned) return { model: pinned, source: 'pinned', reason: 'Selected by you' };
    }

    const config = this.getConfig();
    const assignedRef = request.purpose ? config.assignments[request.purpose] : undefined;
    const assigned = assignedRef ? eligible.find((m) => sameModel(m, assignedRef)) : undefined;

    if (!config.autoRouting) {
      if (assigned)
        return {
          model: assigned,
          source: 'user_assignment',
          reason: `Your ${request.purpose} model`,
        };
      const general = config.assignments.general;
      const generalModel = general ? eligible.find((m) => sameModel(m, general)) : undefined;
      if (generalModel)
        return { model: generalModel, source: 'user_assignment', reason: 'Your general model' };
    }

    if (eligible.length === 1) {
      return { model: eligible[0]!, source: 'only_option', reason: 'Only eligible model' };
    }

    const wanted = desiredTier(request);
    const ranked = eligible
      .map((model) => ({ model, score: this.score(model, request, wanted, assigned) }))
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.model.providerId.localeCompare(b.model.providerId) ||
          a.model.modelId.localeCompare(b.model.modelId),
      );

    const best = ranked[0]!.model;
    return { model: best, source: 'auto', reason: this.explain(best, request, wanted) };
  }

  private meetsRequirements(model: ModelInfo, request: RouteRequest): boolean {
    if (request.needsVision && !model.capabilities.vision) return false;
    if (request.needsTools && !model.capabilities.tools) return false;
    if (request.estimatedInputTokens !== undefined) {
      const needed = Math.ceil(request.estimatedInputTokens * 1.2) + OUTPUT_HEADROOM_TOKENS;
      if (model.capabilities.contextWindow < needed) return false;
    }
    return true;
  }

  private score(
    model: ModelInfo,
    request: RouteRequest,
    wanted: ModelTier,
    assigned: ModelInfo | undefined,
  ): number {
    let score = 100 - 25 * Math.abs(TIER_INDEX[model.tier] - TIER_INDEX[wanted]);
    if (assigned && sameModel(model, assigned)) score += 15; // user preference
    if (request.preferLowLatency)
      score += model.tier === 'fast' ? 10 : model.tier === 'frontier' ? -10 : 0;
    if (request.preferLowCost && model.cost) score -= Math.min(20, model.cost.inputPerMTok);
    if (wanted === 'frontier' && model.capabilities.reasoning) score += 5;
    if (model.capabilitySource === 'provider') score += 1;
    return score;
  }

  private explain(model: ModelInfo, request: RouteRequest, wanted: ModelTier): string {
    const why: string[] = [];
    if (request.needsVision) why.push('vision required');
    if (request.needsTools) why.push('tool use required');
    why.push(model.tier === wanted ? `${wanted} tier fits the task` : `closest to ${wanted} tier`);
    return why.join(', ');
  }
}
