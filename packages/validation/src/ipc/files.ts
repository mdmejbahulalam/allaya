import { z } from 'zod';
import { idSchema, noPayload, okSchema, spec } from './common';

const pathText = z.string().min(1).max(1024);

export const fileRootSchema = z.object({
  id: z.string(),
  /** The name that starts a path: `Documents`. */
  label: z.string(),
  /** Where it is on disk, shown to the user. */
  location: z.string(),
  origin: z.enum(['known', 'user']),
  /** `false` when the folder no longer exists (moved or removed). */
  exists: z.boolean(),
});
export type FileRootView = z.infer<typeof fileRootSchema>;

export const fileEntrySchema = z.object({
  name: z.string(),
  kind: z.enum(['file', 'directory', 'link', 'other']),
  size: z.number(),
  modifiedAt: z.number(),
  hidden: z.boolean(),
});
export type FileEntryView = z.infer<typeof fileEntrySchema>;

export const fileListingSchema = z.object({
  /** Folder-relative path (`Documents/Reports`). */
  path: z.string(),
  entries: z.array(fileEntrySchema),
  total: z.number(),
  truncated: z.boolean(),
  /** Entries left out because their names mark them as secrets. */
  omitted: z.number(),
});
export type FileListing = z.infer<typeof fileListingSchema>;

export const fileActionSchema = z.object({
  id: z.string(),
  kind: z.enum(['create_file', 'create_folder', 'overwrite', 'copy', 'move', 'trash']),
  label: z.string(),
  target: z.string().optional(),
  undoable: z.boolean(),
  undone: z.boolean(),
  createdAt: z.number(),
  note: z.string().optional(),
});
export type FileActionView = z.infer<typeof fileActionSchema>;

export const filesOverviewSchema = z.object({
  roots: z.array(fileRootSchema),
  recent: z.array(z.object({ label: z.string(), path: z.string() })),
  actions: z.array(fileActionSchema),
  /** Whether "undo" can bring a deleted item back (not with the Windows Recycle Bin). */
  deletesAreRestorable: z.boolean(),
  /** The user switched file access off: nothing here will work until it is turned back on. */
  accessOff: z.boolean(),
});
export type FilesOverview = z.infer<typeof filesOverviewSchema>;

export const fileSearchResultSchema = z.object({
  hits: z.array(
    z.object({
      path: z.string(),
      name: z.string(),
      kind: z.enum(['file', 'directory', 'link', 'other']),
      size: z.number(),
      modifiedAt: z.number(),
    }),
  ),
  scanned: z.number(),
  truncated: z.boolean(),
});
export type FileSearchResult = z.infer<typeof fileSearchResultSchema>;

/**
 * What became of a change made from the Files screen. These go through the same permission, confirmation and audit
 * pipeline as the model's tools, so `status` can be `rejected` (the user said no) or `denied` (permission is off).
 */
export const fileOutcomeSchema = z.object({
  ok: z.boolean(),
  status: z.string(),
  summary: z.string(),
  message: z.string().optional(),
  /** Why it was refused (`secret`, `outside_roots`…), when it was, so the screen can explain in the user's language. */
  reason: z.string().optional(),
  evidence: z.string().optional(),
});
export type FileOutcome = z.infer<typeof fileOutcomeSchema>;

export const filesContract = {
  invoke: {
    'files:overview': spec(noPayload, filesOverviewSchema),
    'files:list': spec(
      z.object({ path: pathText, showHidden: z.boolean().optional() }),
      fileListingSchema,
    ),
    'files:search': spec(
      z.object({ query: z.string().min(1).max(200), folder: pathText.optional() }),
      fileSearchResultSchema,
    ),
    /** Opens the system folder picker in the main process. Nothing is added if the user cancels. */
    'files:addFolder': spec(noPayload, z.object({ added: fileRootSchema.optional() })),
    'files:removeFolder': spec(z.object({ id: idSchema }), okSchema),
    'files:open': spec(z.object({ path: pathText }), okSchema),
    'files:reveal': spec(z.object({ path: pathText }), okSchema),
    'files:createFolder': spec(z.object({ path: pathText }), fileOutcomeSchema),
    'files:rename': spec(
      z.object({ path: pathText, newName: z.string().min(1).max(255) }),
      fileOutcomeSchema,
    ),
    'files:delete': spec(z.object({ path: pathText, folder: z.boolean() }), fileOutcomeSchema),
    'files:undo': spec(z.object({ actionId: idSchema.optional() }), fileOutcomeSchema),
  },
  events: {
    /** The set of folders, or something Allaya changed, is different now: refresh what is shown. */
    'files:changed': z.object({}),
  },
} as const;
