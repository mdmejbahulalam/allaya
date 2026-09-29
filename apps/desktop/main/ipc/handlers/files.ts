import type { HandlerRegistry } from '../registry';
import type { FileService } from '../../services/file-service';

export function registerFileHandlers(registry: HandlerRegistry, files: FileService): void {
  registry
    .register('files:overview', () => files.overview())
    .register('files:list', ({ path, showHidden }) => files.list(path, showHidden))
    .register('files:search', ({ query, folder }) => files.search(query, folder))
    .register('files:addFolder', () => files.addFolder())
    .register('files:removeFolder', ({ id }) => {
      files.removeFolder(id);
      return { ok: true as const };
    })
    .register('files:open', async ({ path }) => {
      await files.open(path);
      return { ok: true as const };
    })
    .register('files:reveal', async ({ path }) => {
      await files.reveal(path);
      return { ok: true as const };
    })
    .register('files:createFolder', ({ path }) => files.createFolder(path))
    .register('files:rename', ({ path, newName }) => files.rename(path, newName))
    .register('files:delete', ({ path, folder }) => files.delete(path, folder))
    .register('files:undo', ({ actionId }) => files.undo(actionId));
}
