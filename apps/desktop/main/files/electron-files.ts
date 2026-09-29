import { BrowserWindow, dialog, shell } from 'electron';
import type { TrashProvider } from '@allaya/filesystem';

/**
 * The Windows Recycle Bin. Allaya can send things there but cannot take them back out from code, so deletes are
 * recorded as "restore it from the Recycle Bin" rather than as something `undo` can do.
 */
export class RecycleBin implements TrashProvider {
  readonly name = 'recycle-bin';
  readonly restorable = false;

  async trash(path: string): Promise<Record<string, never>> {
    await shell.trashItem(path);
    return {};
  }
}

/** Opens a file with the program the user chose for that type. `shell.openPath` resolves to an error text. */
export async function openWithDefaultProgram(path: string): Promise<void> {
  const problem = await shell.openPath(path);
  if (problem) throw new Error(problem);
}

export function revealInFileManager(path: string): void {
  shell.showItemInFolder(path);
}

/** The system "Save as" dialog, parented to the focused window. Returns the chosen path, or nothing if cancelled. */
export async function pickSaveFileDialog(
  title: string,
  defaultName: string,
): Promise<string | undefined> {
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const options = {
    title,
    defaultPath: defaultName,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  };
  const result = parent
    ? await dialog.showSaveDialog(parent, options)
    : await dialog.showSaveDialog(options);
  return result.canceled ? undefined : result.filePath;
}

/** The system folder picker, parented to the focused window so it appears in front of it. */
export async function pickFolderDialog(title: string): Promise<string | undefined> {
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const options = { title, properties: ['openDirectory' as const] };
  const result = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? undefined : result.filePaths[0];
}
