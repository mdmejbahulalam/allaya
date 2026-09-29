import { z } from 'zod';
import { defineTool, type ToolDefinition, type ToolLanguage } from '@allaya/tools';
import type { FileManager } from './manager';

const pick = (language: ToolLanguage, en: string, bn: string) => (language === 'bn' ? bn : en);

const path = z.string().min(1).max(1024);
const folderName = z.string().min(1).max(255);
const PATH_HELP =
  'Paths start with a folder name: "Desktop", "Documents", "Downloads", "Pictures", "Videos" or "Music" (or a folder the user added), for example "Documents/Reports/summary.txt". Use the paths that earlier results gave you.';

/**
 * The file tools the model may call. They are thin: every path goes through the manager's path policy (known
 * folders only, no `..`, no links out, no secrets, no programs), and the destructive ones are graded by how much
 * they can lose — creating is MEDIUM, replacing is HIGH (the old version is kept), deleting a file is HIGH and a
 * whole folder is CRITICAL (which only an on-screen click can approve).
 */
export function createFileTools(files: FileManager): ToolDefinition[] {
  const tools: unknown[] = [];

  tools.push(
    defineTool({
      name: 'list_folder',
      description: `Lists the files and folders inside a folder (name, type, size, when it was changed). ${PATH_HELP} Does not change anything.`,
      category: 'files',
      parameters: z.object({ path, showHidden: z.boolean().default(false) }).strict(),
      readOnly: true,
      risk: 'LOW',
      requires: ['file_access'],
      describe: (a, l) => pick(l, `Look inside “${a.path}”`, `“${a.path}” ফোল্ডারে দেখা হচ্ছে`),
      async execute(args) {
        const result = await files.list(args.path, { showHidden: args.showHidden, limit: 200 });
        return {
          path: result.path,
          count: result.total,
          truncated: result.truncated,
          entries: result.entries.map((e) => ({
            name: e.name,
            type: e.kind,
            ...(e.kind === 'file' ? { bytes: e.size } : {}),
            modified: new Date(e.modifiedAt).toISOString(),
          })),
        };
      },
    }),

    defineTool({
      name: 'find_files',
      description:
        "Finds files and folders by (part of) their name. Every word in the query must appear in the name. Search all the user's folders, or one folder. It searches names only, not file contents. The result says if the search was cut short, in which case say the search may be incomplete. Does not change anything.",
      category: 'files',
      parameters: z
        .object({
          query: z.string().max(200).default(''),
          folder: path.optional(),
          extension: z.string().max(12).optional(),
          kind: z.enum(['file', 'directory', 'any']).default('any'),
          maxResults: z.number().int().min(1).max(100).default(30),
        })
        .strict(),
      readOnly: true,
      risk: 'LOW',
      requires: ['file_access'],
      describe: (a, l) =>
        pick(
          l,
          `Search for “${a.query || `.${a.extension ?? ''}`}”${a.folder ? ` in ${a.folder}` : ''}`,
          `“${a.query || `.${a.extension ?? ''}`}” খোঁজা হচ্ছে`,
        ),
      timeoutMs: 30_000,
      async execute(args, ctx) {
        const result = await files.search({
          query: args.query,
          folder: args.folder,
          extension: args.extension,
          kind: args.kind,
          maxResults: args.maxResults,
          signal: ctx.signal,
        });
        return {
          found: result.hits.length,
          searchWasCutShort: result.truncated,
          results: result.hits.map((h) => ({
            path: h.path,
            type: h.kind,
            ...(h.kind === 'file' ? { bytes: h.size } : {}),
            modified: new Date(h.modifiedAt).toISOString(),
          })),
        };
      },
    }),

    defineTool({
      name: 'get_file_info',
      description: `Tells the size, type and dates of one file or folder. ${PATH_HELP} Does not change anything.`,
      category: 'files',
      parameters: z.object({ path }).strict(),
      readOnly: true,
      risk: 'LOW',
      requires: ['file_access'],
      describe: (a, l) => pick(l, `Look at “${a.path}”`, `“${a.path}” দেখা হচ্ছে`),
      async execute(args) {
        const info = await files.info(args.path);
        return {
          path: info.path,
          type: info.kind,
          bytes: info.size,
          extension: info.extension,
          modified: new Date(info.modifiedAt).toISOString(),
          created: new Date(info.createdAt).toISOString(),
        };
      },
    }),

    defineTool({
      name: 'read_file',
      description: `Reads a text file (notes, documents saved as text, code, CSV…). The text is sent to the AI provider, and files can be private, so only read what the user asked about. Binary files (images, PDF, Word, Excel) cannot be read. Files that usually hold passwords or keys are refused. ${PATH_HELP}`,
      category: 'files',
      parameters: z
        .object({ path, maxChars: z.number().int().min(100).max(100_000).default(20_000) })
        .strict(),
      readOnly: true,
      // The contents leave the computer (to the AI provider), so reading asks under the default settings.
      risk: 'MEDIUM',
      requires: ['file_access'],
      describe: (a, l) =>
        pick(
          l,
          `Read “${a.path}” (its text will be sent to your AI provider)`,
          `“${a.path}” পড়া হচ্ছে (লেখাটি আপনার AI প্রদানকারীর কাছে যাবে)`,
        ),
      auditSummary: (a, l) => pick(l, `Read “${a.path}”`, `“${a.path}” পড়া হয়েছে`),
      // The audit trail keeps that a file was read, never what was in it.
      auditOutput: (o: { path: string; characters: number; truncated: boolean }) => ({
        path: o.path,
        characters: o.characters,
        truncated: o.truncated,
      }),
      timeoutMs: 20_000,
      async execute(args) {
        const result = await files.readText(args.path, args.maxChars);
        return {
          path: result.path,
          text: result.text,
          characters: result.characters,
          truncated: result.truncated,
          totalBytes: result.bytes,
        };
      },
    }),

    defineTool({
      name: 'create_folder',
      description: `Creates a new folder (and any missing folders above it). Does nothing if it already exists. ${PATH_HELP}`,
      category: 'files',
      parameters: z.object({ path }).strict(),
      readOnly: false,
      // An empty folder cannot lose anything and is undoable; a function keeps the registry's "changes need a reason" rule.
      risk: () => 'LOW',
      requires: ['file_access'],
      describe: (a, l) => pick(l, `Create the folder “${a.path}”`, `“${a.path}” ফোল্ডার তৈরি`),
      async execute(args) {
        const result = await files.createFolder(args.path);
        return {
          path: result.path,
          alreadyExisted: !result.created,
          ...(result.actionId ? { actionId: result.actionId } : {}),
        };
      },
      async verify(args) {
        const found = await files.measure(args.path);
        return found?.kind === 'directory'
          ? { verified: true, evidence: `The folder “${args.path}” exists.` }
          : { verified: false, evidence: `The folder “${args.path}” was not found afterwards.` };
      },
    }),

    defineTool({
      name: 'write_file',
      description: `Saves text as a file. By default it refuses to replace an existing file. Set overwrite=true only when the user asked to replace it; the previous version is kept and can be restored with undo_file_action. It cannot create programs, scripts or shortcuts (.exe, .bat, .ps1, .js, .lnk…). The folder must already exist (use create_folder). Text only, UTF-8. ${PATH_HELP}`,
      category: 'files',
      parameters: z
        .object({
          path,
          content: z.string().max(500_000),
          overwrite: z.boolean().default(false),
        })
        .strict(),
      readOnly: false,
      risk: (a) => (a.overwrite ? 'HIGH' : 'MEDIUM'),
      // Replacing counts as a destructive action: it always asks, whatever "always allow" says.
      requires: (a) => (a.overwrite ? ['file_access', 'delete_files'] : ['file_access']),
      describe: (a, l) =>
        a.overwrite
          ? pick(
              l,
              `Replace “${a.path}” with new text (${a.content.length} characters; the old version is kept)`,
              `“${a.path}” নতুন লেখা দিয়ে বদলানো (${a.content.length}টি অক্ষর; আগের সংস্করণ রাখা থাকবে)`,
            )
          : pick(
              l,
              `Create “${a.path}” (${a.content.length} characters)`,
              `“${a.path}” তৈরি (${a.content.length}টি অক্ষর)`,
            ),
      auditSummary: (a, l) =>
        pick(
          l,
          `${a.overwrite ? 'Replace' : 'Create'} “${a.path}” (${a.content.length} characters)`,
          `“${a.path}” ${a.overwrite ? 'বদলানো' : 'তৈরি'} (${a.content.length}টি অক্ষর)`,
        ),
      redactArgs: (a) => ({ path: a.path, overwrite: a.overwrite, characters: a.content.length }),
      timeoutMs: 30_000,
      async execute(args) {
        const result = await files.writeFile(args.path, args.content, {
          overwrite: args.overwrite,
        });
        return {
          path: result.path,
          bytes: result.bytes,
          created: result.created,
          replacedExisting: result.overwrote,
          ...(result.actionId ? { actionId: result.actionId } : {}),
        };
      },
      async verify(args) {
        const bytes = await files.readBack(args.path);
        if (!bytes)
          return { verified: false, evidence: `“${args.path}” was not found afterwards.` };
        return bytes.equals(Buffer.from(args.content, 'utf8'))
          ? {
              verified: true,
              evidence: `“${args.path}” was read back and holds exactly the text (${bytes.length} bytes).`,
            }
          : {
              verified: false,
              evidence: `“${args.path}” exists but its content is not what was written.`,
            };
      },
    }),

    defineTool({
      name: 'copy_file',
      description: `Copies a file or a whole folder into another folder. It never overwrites: if the name is taken it fails, and you can retry with newName. Very large folders are refused. Links and files that hold secrets inside a copied folder are skipped (the result says how many). ${PATH_HELP}`,
      category: 'files',
      parameters: z
        .object({ source: path, destinationFolder: path, newName: folderName.optional() })
        .strict(),
      readOnly: false,
      risk: 'MEDIUM',
      requires: ['file_access'],
      describe: (a, l) =>
        pick(
          l,
          `Copy “${a.source}” into “${a.destinationFolder}”${a.newName ? ` as “${a.newName}”` : ''}`,
          `“${a.source}” কপি করে “${a.destinationFolder}” এ রাখা${a.newName ? ` (“${a.newName}” নামে)` : ''}`,
        ),
      timeoutMs: 180_000,
      async execute(args, ctx) {
        const r = await files.copy(args.source, args.destinationFolder, {
          newName: args.newName,
          signal: ctx.signal,
        });
        return {
          copiedTo: r.path,
          type: r.kind,
          files: r.files,
          bytes: r.bytes,
          ...(r.skippedLinks + r.skippedSecrets > 0
            ? { skippedLinks: r.skippedLinks, skippedSecretFiles: r.skippedSecrets }
            : {}),
          ...(r.actionId ? { actionId: r.actionId } : {}),
        };
      },
      async verify(_args, output) {
        const found = await files.measure(output.copiedTo);
        return found && found.files === output.files && found.bytes === output.bytes
          ? {
              verified: true,
              evidence: `“${output.copiedTo}” exists with ${output.files} file(s), ${output.bytes} bytes.`,
            }
          : {
              verified: false,
              evidence: `“${output.copiedTo}” is missing or differs from what was copied.`,
            };
      },
    }),

    defineTool({
      name: 'move_file',
      description: `Moves a file or folder into another folder (optionally under a new name). It never overwrites. To only change the name, use rename_file. ${PATH_HELP}`,
      category: 'files',
      parameters: z
        .object({ source: path, destinationFolder: path, newName: folderName.optional() })
        .strict(),
      readOnly: false,
      risk: 'MEDIUM',
      requires: ['file_access'],
      describe: (a, l) =>
        pick(
          l,
          `Move “${a.source}” into “${a.destinationFolder}”${a.newName ? ` as “${a.newName}”` : ''}`,
          `“${a.source}” সরিয়ে “${a.destinationFolder}” এ নেওয়া${a.newName ? ` (“${a.newName}” নামে)` : ''}`,
        ),
      timeoutMs: 180_000,
      async execute(args) {
        const r = await files.move(args.source, args.destinationFolder, { newName: args.newName });
        return {
          from: r.from,
          movedTo: r.path,
          crossDrive: r.crossDrive,
          ...(r.actionId ? { actionId: r.actionId } : {}),
        };
      },
      async verify(_args, output) {
        const [there, gone] = await Promise.all([
          files.measure(output.movedTo),
          files.measure(output.from),
        ]);
        return there && !gone
          ? {
              verified: true,
              evidence: `It is now at “${output.movedTo}” and no longer at “${output.from}”.`,
            }
          : { verified: false, evidence: 'The file is not where it should be after the move.' };
      },
    }),

    defineTool({
      name: 'rename_file',
      description: `Changes the name of a file or folder, keeping it in the same folder. newName is only a name, not a path. It never overwrites. ${PATH_HELP}`,
      category: 'files',
      parameters: z.object({ path, newName: folderName }).strict(),
      readOnly: false,
      risk: 'MEDIUM',
      requires: ['file_access'],
      describe: (a, l) =>
        pick(
          l,
          `Rename “${a.path}” to “${a.newName}”`,
          `“${a.path}” এর নাম বদলে “${a.newName}” করা`,
        ),
      async execute(args) {
        const r = await files.rename(args.path, args.newName);
        return { from: r.from, renamedTo: r.path, ...(r.actionId ? { actionId: r.actionId } : {}) };
      },
      async verify(_args, output) {
        const [there, gone] = await Promise.all([
          files.measure(output.renamedTo),
          files.measure(output.from),
        ]);
        return there && !gone
          ? { verified: true, evidence: `It is now called “${output.renamedTo}”.` }
          : { verified: false, evidence: 'The new name was not found after renaming.' };
      },
    }),

    defineTool({
      name: 'delete_file',
      description: `Moves ONE file to the trash (it is not permanently deleted). Only use it when the user clearly named the file. For a folder use delete_folder. ${PATH_HELP}`,
      category: 'files',
      parameters: z.object({ path }).strict(),
      readOnly: false,
      risk: 'HIGH',
      requires: ['file_access', 'delete_files'],
      describe: (a, l) => pick(l, `Move “${a.path}” to the trash`, `“${a.path}” ট্র্যাশে পাঠানো`),
      async execute(args) {
        const r = await files.trash(args.path, { folder: false });
        return {
          path: r.path,
          movedToTrash: true,
          canBeUndone: r.restorable,
          actionId: r.actionId,
        };
      },
      async verify(args) {
        const found = await files.measure(args.path);
        return found
          ? { verified: false, evidence: `“${args.path}” is still there.` }
          : {
              verified: true,
              evidence: `“${args.path}” is no longer in its folder (it is in the trash).`,
            };
      },
    }),

    defineTool({
      name: 'delete_folder',
      description: `Moves a whole FOLDER and everything in it to the trash (not permanently deleted). This is one of the most serious actions: use it only when the user clearly asked to delete that exact folder, and never to "clean up". The user must approve it on screen. ${PATH_HELP}`,
      category: 'files',
      parameters: z.object({ path }).strict(),
      readOnly: false,
      risk: 'CRITICAL',
      requires: ['file_access', 'delete_files'],
      describe: (a, l) =>
        pick(
          l,
          `Move the folder “${a.path}” and everything in it to the trash`,
          `“${a.path}” ফোল্ডার ও তার ভেতরের সবকিছু ট্র্যাশে পাঠানো`,
        ),
      async execute(args) {
        const r = await files.trash(args.path, { folder: true });
        return {
          path: r.path,
          itemsMovedToTrash: r.items,
          canBeUndone: r.restorable,
          actionId: r.actionId,
        };
      },
      async verify(args) {
        const found = await files.measure(args.path);
        return found
          ? { verified: false, evidence: `“${args.path}” is still there.` }
          : {
              verified: true,
              evidence: `“${args.path}” is no longer in its place (it is in the trash).`,
            };
      },
    }),

    defineTool({
      name: 'open_file',
      description: `Opens a document, picture or other file in the program the user normally uses for it. It refuses programs, scripts and shortcuts. It cannot tell whether the program finished opening, so say "asked to open", not "it is open". ${PATH_HELP}`,
      category: 'files',
      parameters: z.object({ path }).strict(),
      readOnly: false,
      risk: 'MEDIUM',
      requires: ['file_access', 'application_launch'],
      describe: (a, l) => pick(l, `Open “${a.path}”`, `“${a.path}” খোলা হচ্ছে`),
      timeoutMs: 20_000,
      async execute(args) {
        const r = await files.open(args.path);
        return { path: r.path, requestedToOpen: true };
      },
    }),

    defineTool({
      name: 'list_file_actions',
      description:
        'Lists the file changes Allaya made recently (newest first) and whether each can still be undone. Use it to find an actionId for undo_file_action. Does not change anything.',
      category: 'files',
      parameters: z.object({ limit: z.number().int().min(1).max(30).default(10) }).strict(),
      readOnly: true,
      risk: 'LOW',
      requires: ['file_access'],
      describe: (_a, l) =>
        pick(l, 'Look at recent file changes', 'সাম্প্রতিক ফাইল পরিবর্তন দেখা হচ্ছে'),
      async execute(args) {
        return {
          actions: files.journal.list(args.limit).map((e) => ({
            actionId: e.id,
            what: e.kind,
            path: e.label,
            ...(e.target ? { to: e.target } : {}),
            when: new Date(e.createdAt).toISOString(),
            undone: e.undoneAt !== undefined,
            canBeUndone: e.undoable && e.undoneAt === undefined,
            ...(e.note ? { note: e.note } : {}),
          })),
        };
      },
    }),

    defineTool({
      name: 'undo_file_action',
      description:
        "Reverses one of Allaya's recent file changes: removes a file it created (only if untouched since), moves a file back, restores the previous version of a replaced file, or brings a deleted item back from Allaya's trash. Without actionId it undoes the most recent change. It refuses if the file was changed since, so nothing you did is lost.",
      category: 'files',
      parameters: z.object({ actionId: z.string().min(8).max(64).optional() }).strict(),
      readOnly: false,
      risk: 'MEDIUM',
      requires: ['file_access'],
      describe: (a, l) => {
        const entry = files.nextUndo(a.actionId);
        const label = entry?.label ?? pick(l, 'the last file change', 'শেষ ফাইল পরিবর্তন');
        return pick(l, `Undo the change to “${label}”`, `“${label}” এর পরিবর্তন ফিরিয়ে আনা`);
      },
      async execute(args) {
        const r = await files.undo(args.actionId);
        return { undone: r.kind, path: r.label, result: r.outcome };
      },
    }),
  );

  return tools as ToolDefinition[];
}
