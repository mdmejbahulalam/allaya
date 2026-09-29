import { writeFile } from 'node:fs/promises';
import type { MemoryRecord, MemoryManager } from '@allaya/memory';
import type { MemoryView } from '@allaya/validation';
import type { SettingsService } from '../../services/settings-service';
import type { HandlerRegistry } from '../registry';

const toView = (m: MemoryRecord): MemoryView => ({
  id: m.id,
  category: m.category,
  key: m.key,
  value: m.value,
  source: m.source,
  ...(m.origin ? { origin: m.origin } : {}),
  useCount: m.useCount,
  ...(m.lastUsedAt !== undefined ? { lastUsedAt: m.lastUsedAt } : {}),
  createdAt: m.createdAt,
  updatedAt: m.updatedAt,
});

export function registerMemoryHandlers(
  registry: HandlerRegistry,
  memory: MemoryManager,
  settings: SettingsService,
  deps: {
    changed: () => void;
    pickSaveFile?: (title: string, defaultName: string) => Promise<string | undefined>;
  },
): void {
  registry
    .register('memory:list', () => {
      const overview = memory.overview();
      return {
        memories: overview.memories.map(toView),
        enabled: overview.enabled,
        limit: overview.limit,
      };
    })
    .register('memory:create', (input) => toView(memory.create(input)))
    .register('memory:update', ({ id, changes }) => toView(memory.update(id, changes)))
    .register('memory:delete', ({ id }) => {
      memory.remove(id);
      return { ok: true as const };
    })
    .register('memory:deleteAll', () => ({ removed: memory.removeAll() }))
    .register('memory:setEnabled', ({ enabled }) => {
      settings.set({ key: 'memory.enabled', value: enabled });
      deps.changed();
      return { ok: true as const };
    })
    // The person chooses the file in a system dialog; the renderer never names a path.
    .register('memory:export', async () => {
      if (!deps.pickSaveFile) return { saved: false };
      const path = await deps.pickSaveFile('Save what Allaya remembers', 'allaya-memories.json');
      if (!path) return { saved: false };
      await writeFile(path, memory.exportJson(), { encoding: 'utf8', mode: 0o600 });
      return { saved: true };
    });
}
