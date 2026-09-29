/** A folder Allaya may work inside. Everything outside every root is off limits. */
export interface FolderRoot {
  /** Stable id (`desktop`, `documents`, or a bookmark id). Also accepted as the first segment of a path. */
  id: string;
  /** Name shown to the user and accepted as the first segment of a path. */
  label: string;
  /** Absolute path on disk. */
  path: string;
  /** Other names people use for it (translations). Matched case-insensitively. */
  aliases?: readonly string[];
  /** `known` folders come from the OS; `user` folders were added through the folder picker. */
  origin: 'known' | 'user';
}

export type EntryKind = 'file' | 'directory' | 'link' | 'other';

export interface FileEntry {
  name: string;
  kind: EntryKind;
  size: number;
  modifiedAt: number;
  hidden: boolean;
}

export interface FileInfo extends FileEntry {
  path: string;
  createdAt: number;
  extension: string;
}

/** Why an operation was refused. Also the `details.reason` of the thrown error. */
export type RefusalReason =
  | 'outside_roots'
  | 'traversal'
  | 'invalid_name'
  | 'reserved_name'
  | 'network_path'
  | 'stream'
  | 'secret'
  | 'protected'
  | 'program_file'
  | 'is_root'
  | 'symlink_escape'
  | 'exists'
  | 'missing'
  | 'not_directory'
  | 'not_file'
  | 'not_text'
  | 'too_large'
  | 'changed'
  | 'not_undoable';
