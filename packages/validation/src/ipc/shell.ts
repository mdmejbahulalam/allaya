import { z } from 'zod';
import { emergencyStopStatusSchema } from './agent';
import { noPayload, okSchema, spec } from './common';

/** What this computer lets the desktop shell do, so Settings can say so instead of offering dead switches. */
export const shellStatusSchema = z.object({
  /** There is a system tray to keep Allaya running in. */
  trayAvailable: z.boolean(),
  /** "Start with Windows" can be set (only the installed Windows app can). */
  launchAtLoginSupported: z.boolean(),
  /** The system-wide "show Allaya" key: same shape (and reasons) as the emergency-stop key's status. */
  showAppKey: emergencyStopStatusSchema,
});
export type ShellStatus = z.infer<typeof shellStatusSchema>;

export const shellContract = {
  invoke: {
    'desktop:getStatus': spec(noPayload, shellStatusSchema),
    /** Puts the main window in front (used by the floating assistant). */
    'desktop:showApp': spec(noPayload, okSchema),
    /** The emergency stop, from the floating assistant: stops everything and tells the main window. */
    'desktop:stopEverything': spec(
      noPayload,
      z.object({ cancelled: z.number().int().nonnegative() }),
    ),
  },
  events: {
    /** The shell settings that depend on the operating system were re-applied; ask again. */
    'desktop:changed': z.object({}),
    /** Show a screen (someone clicked a notification or the tray). */
    'app:navigate': z.object({
      route: z.enum(['home', 'tasks', 'activity', 'settings']),
      taskId: z.string().max(64).optional(),
    }),
  },
} as const;
