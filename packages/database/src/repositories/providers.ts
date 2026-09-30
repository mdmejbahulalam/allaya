import { and, eq, inArray, sql } from 'drizzle-orm';
import type { AllayaDb } from '../connection';
import { apiCredentials, modelRouting, models, providers } from '../schema';

export interface ProviderRow {
  id: string;
  name: string;
  baseUrl: string | null;
  status: string;
  lastCheckedAt: number | null;
  lastError: string | null;
}

export interface StoredModel {
  providerId: string;
  modelId: string;
  displayName: string;
  capabilitiesJson: string;
  costJson: string | null;
  enabled: boolean;
}

export interface CredentialRow {
  providerId: string;
  encryptedKey: string;
  maskedHint: string;
  lastTestedAt: number | null;
  lastTestOk: boolean | null;
}

export class ProviderRepository {
  constructor(
    private readonly db: AllayaDb,
    private readonly now: () => number = Date.now,
  ) {}

  ensure(id: string, name: string): void {
    this.db.insert(providers).values({ id, name }).onConflictDoNothing().run();
  }

  get(id: string): ProviderRow | undefined {
    return this.db
      .select({
        id: providers.id,
        name: providers.name,
        baseUrl: providers.baseUrl,
        status: providers.status,
        lastCheckedAt: providers.lastCheckedAt,
        lastError: providers.lastError,
      })
      .from(providers)
      .where(eq(providers.id, id))
      .get();
  }

  /** The address of a provider the person points at a server (`null` clears it). */
  setBaseUrl(id: string, baseUrl: string | null): void {
    this.db
      .update(providers)
      .set({ baseUrl, updatedAt: this.now() })
      .where(eq(providers.id, id))
      .run();
  }

  setStatus(id: string, status: string, lastError: string | null = null): void {
    const at = this.now();
    this.db
      .update(providers)
      .set({ status, lastError, lastCheckedAt: at, updatedAt: at })
      .where(eq(providers.id, id))
      .run();
  }

  // ── models ────────────────────────────────────────────────────────────────
  /** In discovery order (providers list newest models first): `rowid` is insertion order. */
  listModels(providerIds?: string[]): StoredModel[] {
    const query = this.db
      .select({
        providerId: models.providerId,
        modelId: models.modelId,
        displayName: models.displayName,
        capabilitiesJson: models.capabilitiesJson,
        costJson: models.costJson,
        enabled: models.enabled,
      })
      .from(models);
    const ordered = sql`rowid`;
    return providerIds
      ? query.where(inArray(models.providerId, providerIds)).orderBy(ordered).all()
      : query.orderBy(ordered).all();
  }

  /** Replaces the discovered model list for a provider atomically, preserving per-model `enabled` flags. */
  replaceModels(
    providerId: string,
    discovered: Omit<StoredModel, 'enabled' | 'providerId'>[],
  ): void {
    const at = this.now();
    this.db.transaction((tx) => {
      const previous = new Map(
        tx
          .select({ modelId: models.modelId, enabled: models.enabled })
          .from(models)
          .where(eq(models.providerId, providerId))
          .all()
          .map((row) => [row.modelId, row.enabled]),
      );
      tx.delete(models).where(eq(models.providerId, providerId)).run();
      for (const model of discovered) {
        tx.insert(models)
          .values({
            id: `${providerId}:${model.modelId}`,
            providerId,
            modelId: model.modelId,
            displayName: model.displayName,
            capabilitiesJson: model.capabilitiesJson,
            costJson: model.costJson,
            enabled: previous.get(model.modelId) ?? true,
            discoveredAt: at,
          })
          .run();
      }
    });
  }

  deleteModels(providerId: string): void {
    this.db.delete(models).where(eq(models.providerId, providerId)).run();
  }

  // ── credentials ───────────────────────────────────────────────────────────
  getCredential(providerId: string): CredentialRow | undefined {
    return this.db
      .select({
        providerId: apiCredentials.providerId,
        encryptedKey: apiCredentials.encryptedKey,
        maskedHint: apiCredentials.maskedHint,
        lastTestedAt: apiCredentials.lastTestedAt,
        lastTestOk: apiCredentials.lastTestOk,
      })
      .from(apiCredentials)
      .where(eq(apiCredentials.providerId, providerId))
      .get();
  }

  upsertCredential(providerId: string, encryptedKey: string, maskedHint: string): void {
    const at = this.now();
    this.db
      .insert(apiCredentials)
      .values({
        id: `cred_${providerId}`,
        providerId,
        encryptedKey,
        maskedHint,
        createdAt: at,
        updatedAt: at,
      })
      .onConflictDoUpdate({
        target: apiCredentials.providerId,
        set: { encryptedKey, maskedHint, updatedAt: at, lastTestedAt: null, lastTestOk: null },
      })
      .run();
  }

  recordCredentialTest(providerId: string, ok: boolean): void {
    this.db
      .update(apiCredentials)
      .set({ lastTestedAt: this.now(), lastTestOk: ok })
      .where(eq(apiCredentials.providerId, providerId))
      .run();
  }

  deleteCredential(providerId: string): void {
    this.db.delete(apiCredentials).where(eq(apiCredentials.providerId, providerId)).run();
  }

  // ── routing ───────────────────────────────────────────────────────────────
  getRouting(): Array<{ purpose: string; providerId: string | null; modelId: string | null }> {
    return this.db
      .select({
        purpose: modelRouting.purpose,
        providerId: modelRouting.providerId,
        modelId: modelRouting.modelId,
      })
      .from(modelRouting)
      .all();
  }

  setRouting(purpose: string, providerId: string | null, modelId: string | null): void {
    const at = this.now();
    this.db
      .insert(modelRouting)
      .values({ purpose, providerId, modelId, updatedAt: at })
      .onConflictDoUpdate({
        target: modelRouting.purpose,
        set: { providerId, modelId, updatedAt: at },
      })
      .run();
  }

  clearRoutingFor(providerId: string): void {
    this.db
      .update(modelRouting)
      .set({ providerId: null, modelId: null, updatedAt: this.now() })
      .where(and(eq(modelRouting.providerId, providerId)))
      .run();
  }
}
