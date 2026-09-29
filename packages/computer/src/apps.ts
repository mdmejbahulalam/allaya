import type { RiskLevel } from '@allaya/types';

/**
 * The applications Allaya may launch by name. The model chooses a *name*; this catalog — not the model — decides
 * what actually runs. There is deliberately no "run this command" path: an unknown name is an error, never an
 * executable path or a shell string.
 */
export interface AppEntry {
  /** Canonical display name (matches what the language engine produces: "Chrome", "VS Code"…). */
  name: string;
  /** Windows executable / App Paths name accepted by `Start-Process`. */
  windows: string;
  /** Lower-case process names of its windows, used to find them for verification and closing. */
  processes: readonly string[];
  /** Launching is `LOW` unless the app can run arbitrary commands. */
  risk: RiskLevel;
  /** Apps in which typed text or key presses execute commands: synthetic input to them is refused outright. */
  shell?: boolean;
}

const app = (
  name: string,
  windows: string,
  processes: readonly string[],
  extra: Partial<Pick<AppEntry, 'risk' | 'shell'>> = {},
): AppEntry => ({ name, windows, processes, risk: 'LOW', ...extra });

export const APP_CATALOG: readonly AppEntry[] = [
  app('Chrome', 'chrome', ['chrome']),
  app('Edge', 'msedge', ['msedge']),
  app('Firefox', 'firefox', ['firefox']),
  app('Brave', 'brave', ['brave']),
  app('Opera', 'opera', ['opera']),
  app('VS Code', 'code', ['code']),
  app('Visual Studio', 'devenv', ['devenv']),
  app('Notepad', 'notepad', ['notepad']),
  app('Word', 'winword', ['winword']),
  app('Excel', 'excel', ['excel']),
  app('PowerPoint', 'powerpnt', ['powerpnt']),
  app('Outlook', 'outlook', ['outlook', 'olk']),
  app('Teams', 'ms-teams', ['ms-teams', 'teams']),
  app('Zoom', 'zoom', ['zoom']),
  app('Slack', 'slack', ['slack']),
  app('Discord', 'discord', ['discord']),
  app('Telegram', 'telegram', ['telegram']),
  app('WhatsApp', 'whatsapp', ['whatsapp']),
  app('Spotify', 'spotify', ['spotify']),
  app('VLC', 'vlc', ['vlc']),
  app('Photoshop', 'photoshop', ['photoshop']),
  app('Illustrator', 'illustrator', ['illustrator']),
  app('Premiere Pro', 'premiere', ['adobe premiere pro', 'premiere']),
  app('After Effects', 'afterfx', ['afterfx']),
  app('Blender', 'blender', ['blender']),
  app('3ds Max', '3dsmax', ['3dsmax']),
  app('Maya', 'maya', ['maya']),
  app('AutoCAD', 'acad', ['acad']),
  app('Unity', 'unity', ['unity']),
  app('Unreal Engine', 'unrealeditor', ['unrealeditor']),
  app('Figma', 'figma', ['figma']),
  app('Paint', 'mspaint', ['mspaint']),
  app('Calculator', 'calc', ['calculatorapp', 'calculator', 'calc']),
  app('Task Manager', 'taskmgr', ['taskmgr']),
  app('Control Panel', 'control', ['control']),
  app('File Explorer', 'explorer', ['explorer']),
  app('Steam', 'steam', ['steam']),
  app('OBS', 'obs64', ['obs64', 'obs']),
  app('Postman', 'postman', ['postman']),
  // A shell can run anything the user can: opening one is MEDIUM, and it never receives synthetic input.
  app('Command Prompt', 'cmd', ['cmd'], { risk: 'MEDIUM', shell: true }),
  app('PowerShell', 'powershell', ['powershell', 'pwsh'], { risk: 'MEDIUM', shell: true }),
  app('Terminal', 'wt', ['windowsterminal', 'wt'], { risk: 'MEDIUM', shell: true }),
];

const norm = (s: string) =>
  s
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\s._-]+/g, '');

const byName = new Map(APP_CATALOG.map((entry) => [norm(entry.name), entry]));

/** Finds a catalog entry by (case-insensitive, spacing-insensitive) name. Anything else is `undefined`. */
export function resolveApp(name: string): AppEntry | undefined {
  return byName.get(norm(name));
}

/** Process names that are shells or command prompts, whatever launched them. */
export const SHELL_PROCESSES: ReadonlySet<string> = new Set([
  ...APP_CATALOG.filter((a) => a.shell).flatMap((a) => a.processes),
  'conhost',
  'bash',
  'wsl',
  'wslhost',
  'sh',
  'zsh',
  'mintty',
  'putty',
]);

/** Windows that run commands or change the system: synthetic input must never reach them. */
export const SENSITIVE_PROCESSES: ReadonlySet<string> = new Set([
  ...SHELL_PROCESSES,
  'regedit',
  'mmc',
  'taskmgr',
  'services',
  'secpol',
  'gpedit',
  'lusrmgr',
  'wscript',
  'cscript',
  'powershell_ise',
  'winlogon',
  'logonui',
  'consent', // UAC prompt
  'credentialuibroker',
  'securityhealthsystray',
]);
