import { basename } from 'node:path';
import type { FileBookmarkRepository } from '@allaya/database';
import type { FileManager, FolderRoot } from '@allaya/filesystem';
import { AllayaError, newId, type Logger, type RunRegistry } from '@allaya/shared';
import type { ToolLanguage } from '@allaya/tools';
import type {
  FileActionView,
  FileListing,
  FileOutcome,
  FileRootView,
  FileSearchResult,
  FilesOverview,
} from '@allaya/validation';
import type { FolderRoots } from '../files/folder-roots';
import { isExistingDirectory } from '../files/folder-roots';
import type { PermissionService } from './permission-service';
import type { SettingsService } from './settings-service';
import type { ToolService } from './tool-service';

export interface FileServiceDeps {
  /** Absent when file access is not configured (some tests): every operation then reports it is unavailable. */
  manager?: FileManager | undefined;
  roots?: FolderRoots | undefined;
  bookmarks: FileBookmarkRepository;
  tools: ToolService;
  permissions: PermissionService;
  runs: RunRegistry;
  settings: SettingsService;
  osLocale: () => string;
  logger: Logger;
  /** The user's profile folder: never a valid root. */
  home: string;
  /** The system folder picker (main process only). Absent where there is none. */
  pickFolder?: (title: string) => Promise<string | undefined>;
  /** Shows a file in Explorer. */
  reveal?: (absolutePath: string) => void;
}

/**
 * What the Files screen can do. Reading and browsing go straight to the guarded file manager (they are the user's
 * own actions in their own window). Anything that *changes* something runs through the same tool pipeline as the
 * model's actions — permission check, confirmation, verification, audit — so there is one set of rules, not two.
 */
export class FileService {
  constructor(private readonly deps: FileServiceDeps) {}

  private manager(): FileManager {
    if (!this.deps.manager) {
      throw new AllayaError('File access is not available here', { code: 'UNSUPPORTED_PLATFORM' });
    }
    return this.deps.manager;
  }

  private assertAccess(): void {
    this.manager();
    if (this.deps.permissions.modeFor('file_access') === 'never') {
      throw new AllayaError('File access is switched off in Permissions', {
        code: 'PERMISSION_DENIED',
      });
    }
  }

  private language(): ToolLanguage {
    const preference = this.deps.settings.get('language.ui');
    if (preference === 'bn' || preference === 'en') return preference;
    return this.deps.osLocale().toLowerCase().startsWith('bn') ? 'bn' : 'en';
  }

  private view(root: FolderRoot): FileRootView {
    return {
      id: root.id,
      label: root.label,
      location: root.path,
      origin: root.origin,
      exists: isExistingDirectory(root.path),
    };
  }

  overview(): FilesOverview {
    const { bookmarks, permissions, roots, manager } = this.deps;
    if (!manager || !roots) {
      return { roots: [], recent: [], actions: [], deletesAreRestorable: false, accessOff: true };
    }
    const actions: FileActionView[] = manager.journal.list(30).map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      label: entry.label,
      ...(entry.target ? { target: entry.target } : {}),
      undoable: entry.undoable,
      undone: entry.undoneAt !== undefined,
      createdAt: entry.createdAt,
      ...(entry.note ? { note: entry.note } : {}),
    }));
    return {
      roots: roots.list().map((root) => this.view(root)),
      recent: bookmarks.list('recent').map((row) => ({ label: row.label, path: row.path })),
      actions,
      deletesAreRestorable: manager.deletesAreRestorable,
      accessOff: permissions.modeFor('file_access') === 'never',
    };
  }

  async list(path: string, showHidden = false): Promise<FileListing> {
    this.assertAccess();
    return this.manager().list(path, { showHidden, limit: 500 });
  }

  /** The names of the files (not folders) in a folder, for watching it. Same access rules as everything else. */
  async names(path: string, limit = 2000): Promise<string[]> {
    this.assertAccess();
    const listing = await this.manager().list(path, { showHidden: false, limit });
    return listing.entries.filter((entry) => entry.kind === 'file').map((entry) => entry.name);
  }

  async search(query: string, folder?: string): Promise<FileSearchResult> {
    this.assertAccess();
    return this.manager().search({ query, folder, maxResults: 100 });
  }

  async addFolder(): Promise<{ added?: FileRootView }> {
    this.assertAccess();
    const { pickFolder, roots, bookmarks, home } = this.deps;
    const manager = this.manager();
    if (!pickFolder || !roots) {
      throw new AllayaError('Choosing a folder is not available here', {
        code: 'UNSUPPORTED_PLATFORM',
      });
    }
    const picked = await pickFolder('Choose a folder for Allaya to use');
    if (!picked) return {};
    if (!isExistingDirectory(picked)) {
      throw new AllayaError('That folder does not exist', { code: 'NOT_FOUND' });
    }
    manager.policy.assertRootAllowed(picked, home);

    const already = roots
      .list()
      .find((root) => manager.policy.isInside(root.path, picked) && isExistingDirectory(root.path));
    if (already) return { added: this.view(already) }; // it is already reachable; nothing to add
    const row = bookmarks.addUserFolder(newId('dir'), roots.uniqueLabel(picked), picked);
    if (!row) return {};
    this.deps.logger.info('Folder added', { label: row.label });
    const added = roots.list().find((root) => root.id === row.id);
    return added ? { added: this.view(added) } : {};
  }

  removeFolder(id: string): void {
    this.assertAccess();
    if (!this.deps.bookmarks.removeUserFolder(id)) {
      throw new AllayaError('That folder cannot be removed', { code: 'NOT_FOUND' });
    }
  }

  async open(path: string): Promise<void> {
    this.assertAccess();
    const opened = await this.manager().open(path);
    this.deps.bookmarks.touchRecent(newId('rec'), basename(opened.path), opened.path);
  }

  async reveal(path: string): Promise<void> {
    this.assertAccess();
    if (!this.deps.reveal) {
      throw new AllayaError('Showing files is not available here', {
        code: 'UNSUPPORTED_PLATFORM',
      });
    }
    const target = await this.manager().policy.resolve(path, { mode: 'read', follow: false });
    this.deps.reveal(target.path);
  }

  createFolder(path: string): Promise<FileOutcome> {
    return this.run('create_folder', { path });
  }

  rename(path: string, newName: string): Promise<FileOutcome> {
    return this.run('rename_file', { path, newName });
  }

  delete(path: string, folder: boolean): Promise<FileOutcome> {
    return this.run(folder ? 'delete_folder' : 'delete_file', { path });
  }

  undo(actionId?: string): Promise<FileOutcome> {
    return this.run('undo_file_action', actionId ? { actionId } : {});
  }

  private async run(tool: string, args: unknown): Promise<FileOutcome> {
    const { runs, tools } = this.deps;
    const id = newId('call');
    const runId = `files-${id}`;
    const source = runs.start(runId, 'files'); // the emergency stop reaches this too
    try {
      const result = await tools.execute(
        { id, name: tool, arguments: args },
        { signal: source.signal, language: this.language() },
      );
      return {
        ok: result.ok,
        status: result.status,
        summary: result.summary,
        ...(result.error ? { message: result.error.message } : {}),
        ...(typeof result.error?.details?.['reason'] === 'string'
          ? { reason: result.error.details['reason'] }
          : {}),
        ...(result.evidence ? { evidence: result.evidence } : {}),
      };
    } finally {
      runs.finish(runId);
    }
  }
}
