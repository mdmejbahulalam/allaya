import { lstat, realpath } from 'node:fs/promises';
import * as nodePath from 'node:path';
import { AllayaError, type ErrorCode } from '@allaya/shared';
import { isProgramFile } from './extensions';
import { checkSegments } from './sensitive';
import type { FolderRoot, RefusalReason } from './types';

export type PathPlatform = 'win32' | 'posix';

const MAX_PATH_CHARS = 1024;
const MAX_SEGMENT_CHARS = 255;

/** Builds the error every refusal uses, so callers and tests can rely on `details.reason`. */
export function refusal(
  reason: RefusalReason,
  message: string,
  code: ErrorCode = 'PATH_NOT_ALLOWED',
): AllayaError {
  return new AllayaError(message, { code, details: { reason } });
}

export const isRefusal = (error: unknown, reason?: RefusalReason): boolean =>
  error instanceof AllayaError &&
  error.details?.['reason'] !== undefined &&
  (reason === undefined || error.details['reason'] === reason);

export interface PathPolicyOptions {
  /** The folders Allaya may use. A function so that folders added later take effect immediately. */
  roots: () => readonly FolderRoot[];
  /** Absolute paths that are never touched, even inside a root (Allaya's own data folder). */
  protectedPaths?: readonly string[];
  /** Defaults to the host platform. Tests use `win32` to check the Windows rules on any machine. */
  platform?: PathPlatform;
}

export interface ResolvedPath {
  /** Where to operate: absolute, with every link on the way resolved. */
  readonly path: string;
  readonly root: FolderRoot;
  /** Segments below the root; empty for the root itself. */
  readonly segments: readonly string[];
  readonly isRoot: boolean;
  /** `Documents/Reports/a.txt` — the form shown to the user and given back to the model. */
  readonly display: string;
  /** The last name as it was requested (a link keeps its own name, not its target's). */
  readonly name: string;
}

export interface ResolveOptions {
  /** `write` also refuses operating-system-managed names (`.git`, `desktop.ini`, …). */
  mode: 'read' | 'write';
  /**
   * Whether a link in the last position is followed (read, list) or is itself the subject (delete, rename).
   * Links in *earlier* positions are always resolved, and the result must stay inside a root.
   */
  follow?: boolean;
}

const RESERVED_DEVICE =
  /^(con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9¹²³]|lpt[1-9¹²³])(\..*)?$/i;
const WINDOWS_ILLEGAL = /[<>:"|?*]/;
// eslint-disable-next-line no-control-regex -- control characters are exactly what is being rejected
const CONTROL = /[\u0000-\u001f\u007f]/;

// Bidirectional overrides and invisible separators let a name *display* as something else ("invoice‮gpj.exe" is
// shown as "invoiceexe.jpg"). ZWNJ/ZWJ (U+200C/D) are deliberately allowed: Bengali conjuncts need them.
const SPOOFING = new RegExp(
  '[\\u061C\\u200E\\u200F\\u2028\\u2029\\u202A-\\u202E\\u2066-\\u2069\\uFEFF]',
);

const normText = (text: string) => text.normalize('NFC');

/**
 * Decides which paths Allaya may touch. The rules, in order:
 *
 *  1. The path must be text without control characters, not a URL, not a network/device (`\\server`, `\\?\`) path,
 *     and (on Windows) without alternate data streams, wildcards, reserved device names or 8.3 short names.
 *  2. It must be given as `<Folder>/…` (a known folder's name, in any supported language) or as an absolute path
 *     that lies inside a folder Allaya may use. `..` is refused outright rather than normalised.
 *  3. After links are resolved on disk it must *still* be inside that folder (a shortcut in Documents that points
 *     at C:\Windows does not become a way out), and outside Allaya's own data.
 *  4. Names that hold secrets (SSH keys, `.env`, password databases…) are refused for reading and writing.
 */
export class PathPolicy {
  private readonly flavour: nodePath.PlatformPath;
  readonly platform: PathPlatform;

  constructor(private readonly options: PathPolicyOptions) {
    this.platform = options.platform ?? (process.platform === 'win32' ? 'win32' : 'posix');
    this.flavour = this.platform === 'win32' ? nodePath.win32 : nodePath.posix;
  }

  roots(): readonly FolderRoot[] {
    return this.options.roots();
  }

  /** True when `child` is `parent` or lies below it (case-insensitively on Windows). */
  isInside(parent: string, child: string): boolean {
    const relative = this.flavour.relative(parent, child);
    if (relative === '') return true;
    if (this.flavour.isAbsolute(relative)) return false; // another drive
    return relative !== '..' && !relative.startsWith(`..${this.flavour.sep}`);
  }

  /** Validates one file or folder *name* (no separators). Used for new names. Throws a refusal. */
  assertName(name: string, mode: 'read' | 'write' = 'write'): string {
    const text = normText(name).trim();
    if (text.length === 0) throw refusal('invalid_name', 'The name is empty');
    if (text === '..') throw refusal('traversal', 'A name cannot be ".."', 'UNSAFE_PATH');
    if (text === '.') throw refusal('invalid_name', 'A name cannot be "."');
    if (/[\\/]/.test(text))
      throw refusal('invalid_name', 'A name cannot contain "/" or "\\"; give a folder separately');
    this.assertSegment(text);
    const verdict = checkSegments([text], mode);
    if (verdict) throw this.verdictError(verdict.reason);
    if (mode === 'write' && isProgramFile(text)) {
      throw refusal(
        'program_file',
        `Allaya does not create or rename programs, scripts or shortcuts ("${text}")`,
      );
    }
    return text;
  }

  /** Text-only stage: which root and which segments, without touching the disk. */
  locate(input: string, mode: 'read' | 'write' = 'read'): { root: FolderRoot; segments: string[] } {
    if (typeof input !== 'string') throw refusal('invalid_name', 'The path is not text');
    const text = normText(input).trim();
    if (text.length === 0) throw refusal('invalid_name', 'The path is empty');
    if (text.length > MAX_PATH_CHARS) throw refusal('invalid_name', 'The path is too long');
    if (CONTROL.test(text)) throw refusal('invalid_name', 'The path contains control characters');
    if (SPOOFING.test(text))
      throw refusal('invalid_name', 'The path contains hidden text-direction characters');
    if (/^[a-z][a-z0-9+.-]+:\/\//i.test(text))
      throw refusal('invalid_name', 'Web and file:// addresses are not paths');
    if (/^[\\/]{2}/.test(text))
      throw refusal('network_path', 'Network and device paths are not allowed');

    const roots = this.options.roots();
    if (roots.length === 0) throw refusal('outside_roots', 'No folders are available to Allaya');

    const win = this.platform === 'win32';
    const parts = (win ? text.split(/[\\/]+/) : text.split('/')).filter((p) => p !== '');
    const absolute = win ? /^[a-z]:([\\/]|$)/i.test(text) : text.startsWith('/');

    if (parts.includes('..'))
      throw refusal('traversal', 'Paths with ".." are not allowed', 'UNSAFE_PATH');
    if (win && /^[a-z]:[^\\/]/i.test(text))
      throw refusal('invalid_name', 'Give the full path (a drive-relative path is ambiguous)');

    let root: FolderRoot | undefined;
    let segments: string[];
    if (absolute) {
      const drive = win ? parts.shift()! : undefined; // "C:" — the colon is valid only here
      const normalised = win
        ? this.flavour.normalize(`${drive}\\${parts.join('\\')}`)
        : this.flavour.normalize(text);
      root = [...roots]
        .sort((a, b) => b.path.length - a.path.length)
        .find((candidate) => this.isInside(candidate.path, normalised));
      if (!root) throw this.outside(roots);
      segments = this.flavour
        .relative(root.path, normalised)
        .split(this.flavour.sep)
        .filter((p) => p !== '' && p !== '.');
    } else {
      const first = parts.shift()?.toLowerCase();
      root = roots.find((candidate) => this.rootNames(candidate).includes(first ?? ''));
      if (!root) throw this.outside(roots);
      segments = parts.filter((p) => p !== '.');
    }

    for (const segment of segments) this.assertSegment(segment);
    const verdict = checkSegments(segments, mode);
    if (verdict) throw this.verdictError(verdict.reason);
    return { root, segments };
  }

  /** The full check, including links on disk. Never returns a path that is outside every root. */
  async resolve(input: string, options: ResolveOptions): Promise<ResolvedPath> {
    const { root, segments } = this.locate(input, options.mode);
    const follow = options.follow ?? true;
    const target = this.flavour.join(root.path, ...segments);

    let rootReal: string;
    try {
      rootReal = await realpath(root.path);
    } catch {
      throw refusal(
        'missing',
        `The folder "${root.label}" does not exist on this computer`,
        'NOT_FOUND',
      );
    }

    const real = follow
      ? await this.realOfDeepest(target)
      : this.flavour.join(
          await this.realOfDeepest(this.flavour.dirname(target)),
          this.flavour.basename(target),
        );

    if (follow && segments.length > 0 && (await this.isDanglingLink(target))) {
      throw refusal(
        'symlink_escape',
        'That shortcut points to something that does not exist',
        'UNSAFE_PATH',
      );
    }
    if (!this.isInside(rootReal, real)) {
      throw refusal(
        'symlink_escape',
        'That path leads outside the allowed folders through a link',
        'UNSAFE_PATH',
      );
    }

    // Links and short names can hide a secret name behind an innocent one: check the real location again.
    const realSegments = this.flavour
      .relative(rootReal, real)
      .split(this.flavour.sep)
      .filter((p) => p !== '');
    const verdict = checkSegments(realSegments, options.mode);
    if (verdict) throw this.verdictError(verdict.reason);

    for (const guarded of this.options.protectedPaths ?? []) {
      // Both directions: a path *inside* the protected folder, and a folder that *contains* it.
      if (
        this.isInside(guarded, real) ||
        this.isInside(real, guarded) ||
        this.isInside(guarded, target)
      ) {
        throw refusal('protected', "That location holds Allaya's own data and cannot be used");
      }
    }

    return {
      path: real,
      root,
      segments: realSegments,
      isRoot: realSegments.length === 0,
      display: [root.label, ...segments].join('/'),
      name: segments.at(-1) ?? root.label,
    };
  }

  /**
   * Whether `path` may become a root. Refuses drive roots, the user's whole profile, system folders, folders that
   * contain or sit inside Allaya's data, and anything with a secret name in it.
   */
  assertRootAllowed(path: string, home: string): void {
    const f = this.flavour;
    if (!f.isAbsolute(path)) throw refusal('invalid_name', 'Choose a folder with a full path');
    const normalised = f.normalize(path);
    if (/^[\\/]{2}/.test(normalised))
      throw refusal('network_path', 'Network folders cannot be added');
    if (f.parse(normalised).root === normalised || f.dirname(normalised) === normalised)
      throw refusal('is_root', 'A whole drive cannot be added; choose a folder on it');
    if (this.isInside(normalised, home))
      throw refusal('is_root', 'Your whole user folder cannot be added; choose a folder inside it');
    for (const guarded of this.options.protectedPaths ?? []) {
      if (this.isInside(guarded, normalised) || this.isInside(normalised, guarded))
        throw refusal('protected', "That folder holds Allaya's own data and cannot be added");
    }
    const segments = normalised.split(f.sep).filter((p) => p !== '');
    const verdict = checkSegments(segments.slice(1), 'write');
    if (verdict) throw this.verdictError(verdict.reason);
  }

  private rootNames(root: FolderRoot): string[] {
    return [root.id, root.label, ...(root.aliases ?? [])].map((name) =>
      normText(name).toLowerCase(),
    );
  }

  private outside(roots: readonly FolderRoot[]): AllayaError {
    return refusal(
      'outside_roots',
      `That location is not one Allaya may use. Start the path with one of: ${roots
        .map((r) => r.label)
        .join(', ')}`,
    );
  }

  private verdictError(reason: 'secret' | 'protected'): AllayaError {
    return reason === 'secret'
      ? refusal(
          'secret',
          'Allaya does not open or change files that usually hold passwords or keys',
        )
      : refusal('protected', 'That is a system-managed location and cannot be changed');
  }

  private assertSegment(segment: string): void {
    if (segment.length > MAX_SEGMENT_CHARS)
      throw refusal('invalid_name', 'A name in the path is too long');
    if (CONTROL.test(segment)) throw refusal('invalid_name', 'A name contains control characters');
    if (SPOOFING.test(segment))
      throw refusal('invalid_name', 'A name contains hidden text-direction characters');
    if (this.platform !== 'win32') return;
    if (segment.includes(':'))
      throw refusal('stream', 'Names with ":" (hidden data streams) are not allowed');
    if (WINDOWS_ILLEGAL.test(segment))
      throw refusal(
        'invalid_name',
        'A name contains characters Windows does not allow (< > : " | ? *)',
      );
    if (/[. ]$/.test(segment))
      throw refusal(
        'invalid_name',
        'Windows ignores dots and spaces at the end of a name; remove them',
      );
    if (RESERVED_DEVICE.test(segment))
      throw refusal('reserved_name', `"${segment}" is a reserved Windows device name`);
    // 8.3 short names ("PROGRA~1") can spell a protected name in a way the name checks would not recognise.
    if (/^[^.]{1,6}~\d(\.[^.]{0,3})?$/.test(segment))
      throw refusal('invalid_name', 'Short (8.3) names are not accepted; use the full name');
  }

  /** `realpath` of the deepest ancestor that exists, followed by the not-yet-existing tail. */
  private async realOfDeepest(target: string): Promise<string> {
    const missing: string[] = [];
    let current = target;
    for (;;) {
      try {
        const real = await realpath(current);
        return this.flavour.join(real, ...missing.reverse());
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ELOOP')
          throw refusal('symlink_escape', 'That path contains a link loop', 'UNSAFE_PATH');
        if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
        const parent = this.flavour.dirname(current);
        if (parent === current) throw error;
        missing.push(this.flavour.basename(current));
        current = parent;
      }
    }
  }

  private async isDanglingLink(target: string): Promise<boolean> {
    const info = await lstat(target).catch(() => undefined);
    if (!info?.isSymbolicLink()) return false;
    return realpath(target).then(
      () => false,
      () => true,
    );
  }
}
