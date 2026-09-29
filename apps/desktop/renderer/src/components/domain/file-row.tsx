import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  type LucideIcon,
} from 'lucide-react';
import { createElement } from 'react';
import { useT } from '@renderer/lib/i18n';
import { cn } from '@renderer/lib/cn';

export interface FileEntry {
  path: string;
  name: string;
  isDirectory: boolean;
  size?: number;
  modifiedAt?: number;
  extension?: string;
}

const byExtension: Record<string, LucideIcon> = {
  pdf: FileText,
  doc: FileText,
  docx: FileText,
  txt: FileText,
  md: FileText,
  xls: FileSpreadsheet,
  xlsx: FileSpreadsheet,
  csv: FileSpreadsheet,
  png: FileImage,
  jpg: FileImage,
  jpeg: FileImage,
  gif: FileImage,
  webp: FileImage,
  svg: FileImage,
  mp4: FileVideo,
  mkv: FileVideo,
  mov: FileVideo,
  mp3: FileAudio,
  wav: FileAudio,
  zip: FileArchive,
  rar: FileArchive,
  '7z': FileArchive,
  ts: FileCode,
  js: FileCode,
  json: FileCode,
  py: FileCode,
};

export function fileIcon(entry: Pick<FileEntry, 'isDirectory' | 'extension'>): LucideIcon {
  if (entry.isDirectory) return Folder;
  return byExtension[(entry.extension ?? '').replace(/^\./, '').toLowerCase()] ?? File;
}

export function FileTypeIcon({
  entry,
  size = 18,
  className,
}: {
  entry: FileEntry;
  size?: number;
  className?: string;
}) {
  // The icon type comes from a static lookup table; createElement keeps it a stable component type.
  return createElement(fileIcon(entry), {
    'aria-hidden': true,
    size,
    className: cn(entry.isDirectory ? 'text-accent-2' : 'text-muted', className),
  });
}

/** Compact row for recent files and search results. */
export function FileRow({
  entry,
  onOpen,
}: {
  entry: FileEntry;
  onOpen?: (entry: FileEntry) => void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={() => onOpen?.(entry)}
      className="flex w-full items-center gap-3 rounded-control px-3 py-2 text-start transition-colors duration-150 hover:bg-elevated"
    >
      <FileTypeIcon entry={entry} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body text-fg">{entry.name}</span>
        <span className="block truncate text-caption text-muted">{entry.path}</span>
      </span>
      {entry.size !== undefined && !entry.isDirectory && (
        <span className="text-caption text-muted tabular-nums">{t.formatFileSize(entry.size)}</span>
      )}
    </button>
  );
}
