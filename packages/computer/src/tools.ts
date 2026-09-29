import { z } from 'zod';
import { AllayaError } from '@allaya/shared';
import { defineTool, type ToolDefinition, type ToolLanguage } from '@allaya/tools';
import { resolveApp } from './apps';
import type { ComputerEngine } from './engine';
import { formatChord, parseChord } from './keys';
import type { WindowInfo } from './types';

/** Where a screenshot is stored. Supplied by the host: the engine itself never writes files. */
export interface ScreenshotStore {
  save(bytes: Uint8Array): Promise<{ path: string; bytes: number }>;
  /** Re-reads the stored file for verification: its size and first bytes (`undefined` if it is missing). */
  inspect(path: string): Promise<{ bytes: number; head: Uint8Array } | undefined>;
}

const pick = (language: ToolLanguage, en: string, bn: string) => (language === 'bn' ? bn : en);
const preview = (text: string, max = 40) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : flat;
};
const windowSummary = (w: WindowInfo) => ({
  id: w.id,
  title: w.title.slice(0, 120),
  app: w.processName,
  focused: w.focused,
  minimized: w.minimized,
  ...(w.elevated ? { elevated: true } : {}),
});

const windowId = z.string().regex(/^\d{1,20}$/, 'a window id from list_windows');
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];

/**
 * The computer-control tools the model may call. Only tools whose capability exists on this machine are
 * returned, so on a platform without input control the model is never offered `type_text`.
 */
export function createComputerTools(
  engine: ComputerEngine,
  screenshots?: ScreenshotStore,
): ToolDefinition[] {
  const caps = engine.capabilities();
  const tools: ToolDefinition[] = [];
  // Each `defineTool` keeps its own argument types; the list stores the erased form.
  const add = (...list: unknown[]) => void tools.push(...(list as ToolDefinition[]));

  if (caps.launch) {
    add(
      defineTool({
        name: 'open_app',
        description:
          'Opens an installed application by its name (for example "Chrome", "Notepad", "VS Code", "Calculator"). Only well-known applications can be opened; you cannot run commands or open arbitrary programs. Tell the user it is open only if the result says a window appeared.',
        category: 'applications',
        parameters: z.object({ app: z.string().min(1).max(60) }).strict(),
        readOnly: false,
        risk: (args) => resolveApp(args.app)?.risk ?? 'LOW',
        requires: ['application_launch'],
        describe: (args, l) => pick(l, `Open ${args.app}`, `${args.app} খোলা হচ্ছে`),
        timeoutMs: 30_000,
        async execute(args, ctx) {
          const result = await engine.openApp(args.app, ctx.signal);
          return {
            app: result.app.name,
            alreadyOpen: result.alreadyOpen,
            windowAppeared: result.window !== undefined,
            ...(result.window ? { window: windowSummary(result.window) } : {}),
          };
        },
        async verify(_args, output) {
          return output.windowAppeared
            ? {
                verified: true,
                evidence: `A ${output.app} window is open${output.window ? `: "${output.window.title}"` : ''}.`,
              }
            : { verified: false, evidence: `No ${output.app} window appeared.` };
        },
      }),
    );
  }

  if (caps.windows) {
    add(
      defineTool({
        name: 'close_app',
        description:
          "Asks an open application to close, exactly as the window's close button does. The app may ask the user to save first, in which case it stays open. It never force-quits anything.",
        category: 'applications',
        parameters: z.object({ app: z.string().min(1).max(60) }).strict(),
        readOnly: false,
        // Closing can discard unsaved work, so it always asks (under the default "ask" setting).
        risk: 'MEDIUM',
        requires: ['application_launch'],
        describe: (args, l) => pick(l, `Close ${args.app}`, `${args.app} বন্ধ করা হচ্ছে`),
        timeoutMs: 20_000,
        async execute(args, ctx) {
          const result = await engine.closeApp(args.app, ctx.signal);
          return {
            app: result.app.name,
            windowsClosed: result.closed,
            windowsStillOpen: result.remaining,
          };
        },
        async verify(_args, output) {
          return output.windowsStillOpen === 0
            ? { verified: true, evidence: `${output.app} has no open windows.` }
            : {
                verified: false,
                evidence: `${output.app} still has ${output.windowsStillOpen} window(s) open (it may be asking to save).`,
              };
        },
      }),
    );

    add(
      defineTool({
        name: 'list_windows',
        description:
          'Lists the windows currently open on the desktop (title, application, which one is focused). Use it to find a window id before focusing or typing into it. Does not change anything.',
        category: 'computer',
        parameters: z.object({}).strict(),
        readOnly: true,
        risk: 'LOW',
        requires: ['computer_control'],
        describe: (_a, l) => pick(l, 'Looking at the open windows', 'খোলা উইন্ডোগুলো দেখা হচ্ছে'),
        async execute() {
          const windows = await engine.listWindows();
          return { count: windows.length, windows: windows.slice(0, 50).map(windowSummary) };
        },
      }),
    );

    add(
      defineTool({
        name: 'focus_window',
        description:
          'Brings a window to the front so the next keyboard input goes to it. Use an id from list_windows.',
        category: 'computer',
        parameters: z.object({ windowId }).strict(),
        readOnly: false,
        // Raising a window changes nothing the user could lose, so it never needs a confirmation.
        risk: () => 'LOW',
        requires: ['computer_control'],
        describe: (_a, l) => pick(l, 'Bring a window to the front', 'একটি উইন্ডো সামনে আনা হচ্ছে'),
        async execute(args) {
          const window = await engine.focusWindow(args.windowId);
          return { window: windowSummary(window) };
        },
        async verify(_args, output) {
          return output.window.focused
            ? { verified: true, evidence: `"${output.window.title}" is in front.` }
            : { verified: false, evidence: 'The window did not come to the front.' };
        },
      }),
    );
  }

  if (caps.screenshot && screenshots) {
    add(
      defineTool({
        name: 'take_screenshot',
        description:
          'Takes a screenshot of the whole screen and saves it as a PNG file, returning where it was saved. The picture itself is not shown to you. Use it when the user asks for a screenshot.',
        category: 'computer',
        parameters: z.object({ display: z.number().int().min(1).optional() }).strict(),
        readOnly: false,
        risk: () => 'LOW',
        requires: ['computer_control'],
        describe: (_a, l) => pick(l, 'Take a screenshot', 'স্ক্রিনশট নেওয়া হচ্ছে'),
        timeoutMs: 20_000,
        async execute(args) {
          const shot = await engine.screenshot(args.display);
          const saved = await screenshots.save(shot.bytes);
          return { path: saved.path, width: shot.width, height: shot.height, bytes: saved.bytes };
        },
        async verify(_args, output) {
          const file = await screenshots.inspect(output.path);
          if (!file || file.bytes === 0)
            return { verified: false, evidence: 'The screenshot file was not found.' };
          const isPng = PNG_SIGNATURE.every((byte, i) => file.head[i] === byte);
          return isPng
            ? { verified: true, evidence: `The PNG file exists (${file.bytes} bytes).` }
            : { verified: false, evidence: 'The saved file is not a valid PNG image.' };
        },
      }),
    );
  }

  if (caps.clipboard) {
    add(
      defineTool({
        name: 'read_clipboard',
        description:
          'Reads the text currently on the clipboard. The clipboard can hold private data, so only use this when the user asked you to look at what they copied.',
        category: 'computer',
        parameters: z.object({}).strict(),
        readOnly: true,
        risk: 'MEDIUM',
        requires: ['clipboard'],
        describe: (_a, l) => pick(l, 'Read the clipboard', 'ক্লিপবোর্ড পড়া হচ্ছে'),
        auditSummary: (_a, l) => pick(l, 'Read the clipboard', 'ক্লিপবোর্ড পড়া হয়েছে'),
        async execute() {
          const text = await engine.getClipboardText();
          return {
            characters: text.length,
            text: text.slice(0, 4000),
            truncated: text.length > 4000,
          };
        },
      }),
      defineTool({
        name: 'write_clipboard',
        description:
          'Puts text on the clipboard, replacing what was there, so the user can paste it.',
        category: 'computer',
        parameters: z.object({ text: z.string().min(1).max(20_000) }).strict(),
        readOnly: false,
        risk: 'MEDIUM',
        requires: ['clipboard'],
        describe: (a, l) =>
          pick(
            l,
            `Copy “${preview(a.text)}” to the clipboard`,
            `ক্লিপবোর্ডে কপি: “${preview(a.text)}”`,
          ),
        auditSummary: (a, l) =>
          pick(
            l,
            `Copy ${a.text.length} characters to the clipboard`,
            `ক্লিপবোর্ডে ${a.text.length}টি অক্ষর কপি`,
          ),
        redactArgs: (a) => ({ characters: a.text.length }),
        async execute(args) {
          await engine.setClipboard(args.text);
          return { characters: args.text.length };
        },
        async verify(args) {
          const now = await engine.getClipboardText();
          return now === args.text
            ? { verified: true, evidence: 'The clipboard holds the new text.' }
            : { verified: false, evidence: 'The clipboard does not contain the text.' };
        },
      }),
    );
  }

  if (caps.keyboard) {
    add(
      defineTool({
        name: 'type_text',
        description:
          'Types text into a window as if the user typed it (any language, including Bengali). Give a windowId from list_windows to choose the window; otherwise the window in front is used. It cannot type into terminals, command prompts, system tools or administrator windows. The result cannot confirm what the program did with the text, so do not claim more than "typed".',
        category: 'computer',
        parameters: z
          .object({ text: z.string().min(1).max(2000), windowId: windowId.optional() })
          .strict(),
        readOnly: false,
        risk: 'MEDIUM',
        requires: ['computer_control'],
        describe: (a, l) =>
          pick(
            l,
            `Type “${preview(a.text)}”${a.windowId ? '' : ' into the window in front'}`,
            `লেখা হচ্ছে: “${preview(a.text)}”`,
          ),
        auditSummary: (a, l) =>
          pick(l, `Type ${a.text.length} characters`, `${a.text.length}টি অক্ষর টাইপ`),
        redactArgs: (a) => ({
          characters: a.text.length,
          ...(a.windowId ? { windowId: a.windowId } : {}),
        }),
        timeoutMs: 60_000,
        async execute(args) {
          const { target } = await engine.typeText(args.text, args.windowId);
          return { typedCharacters: args.text.length, into: windowSummary(target) };
        },
      }),
      defineTool({
        name: 'press_keys',
        description:
          'Presses a keyboard shortcut or key, for example "Ctrl+S", "Enter", "Alt+Left" or "F5". Shortcuts that use the Windows key, Alt+F4, Ctrl+Alt+Delete and Ctrl+Shift+Esc are refused. It cannot send keys to terminals, system tools or administrator windows.',
        category: 'computer',
        parameters: z
          .object({ keys: z.string().min(1).max(40), windowId: windowId.optional() })
          .strict(),
        readOnly: false,
        risk: 'MEDIUM',
        requires: ['computer_control'],
        describe: (a, l) => {
          let shown = a.keys;
          try {
            shown = formatChord(parseChord(a.keys));
          } catch {
            /* an invalid chord is rejected when it runs; describe the raw text */
          }
          return pick(l, `Press ${shown}`, `${shown} চাপা হচ্ছে`);
        },
        async execute(args) {
          const { chord, target } = await engine.pressKeys(args.keys, args.windowId);
          return { pressed: formatChord(chord), into: windowSummary(target) };
        },
      }),
    );
  }

  if (caps.uiAutomation) {
    add(
      defineTool({
        name: 'click_element',
        description:
          'Clicks a button, menu item, checkbox, tab or link in a window by its visible name (e.g. "Save", "OK"). Prefer this over click_at. Returns found=false if no such control exists. It does not work in terminals, system tools or administrator windows.',
        category: 'computer',
        parameters: z
          .object({
            windowId,
            name: z.string().min(1).max(120),
            role: z
              .enum([
                'button',
                'menuitem',
                'checkbox',
                'radiobutton',
                'tab',
                'link',
                'listitem',
                'edit',
              ])
              .optional(),
          })
          .strict(),
        readOnly: false,
        risk: 'MEDIUM',
        requires: ['computer_control'],
        describe: (a, l) =>
          pick(l, `Click “${preview(a.name, 50)}”`, `“${preview(a.name, 50)}” ক্লিক করা হচ্ছে`),
        async execute(args) {
          const found = await engine.invokeElement({
            windowId: args.windowId,
            name: args.name,
            ...(args.role ? { role: args.role } : {}),
          });
          if (!found)
            throw new AllayaError(
              `No control named "${preview(args.name, 60)}" was found in that window`,
              { code: 'NOT_FOUND' },
            );
          return { clicked: args.name };
        },
      }),
    );
  }

  if (caps.mouse) {
    add(
      defineTool({
        name: 'click_at',
        description:
          'Clicks at screen coordinates (in pixels). This is a last resort: without seeing the screen you cannot know what is under those coordinates. Prefer click_element. Refused inside terminals, system tools and administrator windows.',
        category: 'computer',
        parameters: z
          .object({
            x: z.number().int().min(0).max(20_000),
            y: z.number().int().min(0).max(20_000),
            button: z.enum(['left', 'right', 'middle']).default('left'),
            double: z.boolean().default(false),
          })
          .strict(),
        readOnly: false,
        // A blind click can land on anything, including a "Delete" button.
        risk: 'HIGH',
        requires: ['computer_control'],
        describe: (a, l) =>
          pick(
            l,
            `${a.double ? 'Double-click' : 'Click'} at (${a.x}, ${a.y})`,
            `(${a.x}, ${a.y}) স্থানে ${a.double ? 'ডাবল ' : ''}ক্লিক`,
          ),
        async execute(args) {
          await engine.click(args.x, args.y, args.button, args.double ? 2 : 1);
          return { clicked: { x: args.x, y: args.y, button: args.button, double: args.double } };
        },
      }),
      defineTool({
        name: 'scroll',
        description:
          'Scrolls the window under the mouse pointer. Negative numbers scroll down, positive scroll up (120 is one notch).',
        category: 'computer',
        parameters: z.object({ amount: z.number().int().min(-5000).max(5000) }).strict(),
        readOnly: false,
        risk: () => 'LOW',
        requires: ['computer_control'],
        describe: (a, l) =>
          pick(
            l,
            `Scroll ${a.amount < 0 ? 'down' : 'up'}`,
            `${a.amount < 0 ? 'নিচে' : 'উপরে'} স্ক্রল`,
          ),
        async execute(args) {
          await engine.scroll(args.amount);
          return { scrolled: args.amount };
        },
      }),
    );
  }

  return tools;
}
