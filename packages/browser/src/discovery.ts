import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

export type BrowserKind = 'edge' | 'chrome' | 'chromium';

export interface FoundBrowser {
  kind: BrowserKind;
  path: string;
}

/**
 * Where Microsoft Edge and Google Chrome install themselves. Only these standard, administrator-owned locations
 * are ever used — there is no user-configurable path to an arbitrary program (that would be a way to make Allaya
 * run anything).
 */
export function browserCandidates(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): FoundBrowser[] {
  if (platform === 'win32') {
    const join = (...parts: string[]) => win32.join(...parts);
    const roots = [env['ProgramFiles(x86)'], env['ProgramFiles'], env['LOCALAPPDATA']].filter(
      (root): root is string => !!root,
    );
    return [
      ...roots.map((r) => ({
        kind: 'edge' as const,
        path: join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      })),
      ...roots.map((r) => ({
        kind: 'chrome' as const,
        path: join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      })),
    ];
  }
  if (platform === 'darwin') {
    return [
      { kind: 'edge', path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
      { kind: 'chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
      { kind: 'chromium', path: '/Applications/Chromium.app/Contents/MacOS/Chromium' },
    ];
  }
  return [
    { kind: 'edge', path: '/usr/bin/microsoft-edge' },
    { kind: 'chrome', path: '/usr/bin/google-chrome' },
    { kind: 'chrome', path: '/usr/bin/google-chrome-stable' },
    { kind: 'chromium', path: '/usr/bin/chromium' },
    { kind: 'chromium', path: '/usr/bin/chromium-browser' },
  ];
}

/** The first installed browser, Edge first (it ships with Windows), or `undefined`. */
export function findBrowser(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  exists: (path: string) => boolean = existsSync,
): FoundBrowser | undefined {
  return browserCandidates(platform, env).find((candidate) => exists(candidate.path));
}
