import type { SettingsRepository } from '@allaya/database';
import {
  SETTING_KEYS,
  isSettingKey,
  settingsDefaults,
  settingsSchemas,
  type SettingKey,
  type SettingUpdate,
  type SettingsSnapshot,
} from '@allaya/validation';
import { AllayaError, TypedEventBus } from '@allaya/shared';

export type SettingsEvents = { changed: SettingsSnapshot };

/** Validated, default-merged access to persisted settings. */
export class SettingsService {
  readonly events = new TypedEventBus<SettingsEvents>();

  constructor(private readonly repo: SettingsRepository) {}

  getAll(): SettingsSnapshot {
    const stored = this.repo.getAll();
    const snapshot: Record<string, unknown> = { ...settingsDefaults };
    for (const key of SETTING_KEYS) {
      if (!stored.has(key)) continue;
      const parsed = settingsSchemas[key].safeParse(stored.get(key));
      // A stored value that no longer validates (e.g. after an upgrade) falls back to the default.
      if (parsed.success) snapshot[key] = parsed.data;
    }
    return snapshot as SettingsSnapshot;
  }

  get<K extends SettingKey>(key: K): SettingsSnapshot[K] {
    return this.getAll()[key];
  }

  set(update: SettingUpdate): SettingsSnapshot {
    if (!isSettingKey(update.key)) {
      throw new AllayaError('Unknown setting', { code: 'INVALID_INPUT' });
    }
    const parsed = settingsSchemas[update.key].safeParse(update.value);
    if (!parsed.success) {
      throw new AllayaError(`Invalid value for ${update.key}`, { code: 'INVALID_INPUT' });
    }
    this.repo.set(update.key, parsed.data);
    return this.emitChanged();
  }

  reset(key: SettingKey): SettingsSnapshot {
    this.repo.delete(key);
    return this.emitChanged();
  }

  private emitChanged(): SettingsSnapshot {
    const snapshot = this.getAll();
    this.events.emit('changed', snapshot);
    return snapshot;
  }
}
