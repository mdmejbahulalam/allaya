/**
 * Names that usually mean "secrets" or "the operating system's own files". The model can never read or change
 * them, whichever folder they are in: a prompt-injected page or document must not be able to make Allaya hand
 * over an SSH key or a password database. The check is by *name*, so it also protects copies and renames.
 */

const SECRET_DIRECTORIES = new Set([
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.kube',
  '.docker',
  '.password-store',
  'gcloud',
  'keychains',
  'user data', // Chromium/Edge profiles: cookies, saved logins
  'appdata',
]);

const SECRET_EXACT_NAMES = new Set([
  '.env',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '_netrc',
  '.git-credentials',
  '.pgpass',
  'credentials',
  'credentials.json',
  'token.json',
  'tokens.json',
  'secrets.json',
  'secrets.yml',
  'secrets.yaml',
  'wallet.dat',
  'login data',
  'web data',
  'local state',
  'cookies',
  'ntuser.dat',
  'authorized_keys',
  'known_hosts',
]);

const SECRET_PATTERNS: readonly RegExp[] = [
  /^\.env\..+/, // .env.local, .env.production
  /\.(pem|key|pfx|p12|ppk|jks|keystore|kdbx|kdb|gpg|asc|crt|cer)$/,
  /^id_(rsa|dsa|ecdsa|ed25519)/,
  /^service[-_]account.*\.json$/,
  /^ntuser\.dat/,
];

/** Read-only for the model: looking is harmless, changing them breaks tools or history. */
const MANAGED_DIRECTORIES = new Set([
  '.git',
  '$recycle.bin',
  'system volume information',
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
]);

const MANAGED_NAMES = new Set(['desktop.ini', 'thumbs.db', '.ds_store', 'ntuser.ini']);

const norm = (segment: string) => segment.normalize('NFC').toLowerCase();

export interface NameVerdict {
  reason: 'secret' | 'protected';
  segment: string;
}

/** Checks each path segment. `write` also applies the operating-system-managed names. */
export function checkSegments(
  segments: readonly string[],
  mode: 'read' | 'write',
): NameVerdict | undefined {
  for (const raw of segments) {
    const name = norm(raw);
    if (
      SECRET_DIRECTORIES.has(name) ||
      SECRET_EXACT_NAMES.has(name) ||
      SECRET_PATTERNS.some((pattern) => pattern.test(name))
    ) {
      return { reason: 'secret', segment: raw };
    }
    if (mode === 'write' && (MANAGED_DIRECTORIES.has(name) || MANAGED_NAMES.has(name))) {
      return { reason: 'protected', segment: raw };
    }
  }
  return undefined;
}

/** Directories a search never descends into: enormous, generated, or not the user's own content. */
export function isSearchSkipped(name: string): boolean {
  const lower = norm(name);
  return (
    lower === 'node_modules' ||
    lower === '.git' ||
    lower === '$recycle.bin' ||
    lower === 'system volume information' ||
    SECRET_DIRECTORIES.has(lower)
  );
}
