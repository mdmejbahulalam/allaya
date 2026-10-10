import { describe, expect, it } from 'vitest';
import { shouldHideOnClose, shouldNotify, shouldQuitWhenAllClosed } from '@lite/main/shell-rules';

describe('closing the window', () => {
  it('hides it to the tray when asked to keep running, and a tray exists', () => {
    expect(shouldHideOnClose({ background: true, hasTray: true, quitting: false })).toBe(true);
  });

  it('really closes when the person turned that off, when there is no tray to find it in, or when quitting', () => {
    expect(shouldHideOnClose({ background: false, hasTray: true, quitting: false })).toBe(false);
    expect(shouldHideOnClose({ background: true, hasTray: false, quitting: false })).toBe(false);
    expect(shouldHideOnClose({ background: true, hasTray: true, quitting: true })).toBe(false);
  });
});

describe('desktop notices', () => {
  it('appear only when the person is not looking at the app, and only if they want them', () => {
    expect(shouldNotify({ notifyTasks: true }, false)).toBe(true);
    expect(shouldNotify({ notifyTasks: true }, true)).toBe(false);
    expect(shouldNotify({ notifyTasks: false }, false)).toBe(false);
  });
});

describe('when the last window is gone', () => {
  const quits = (platform: string, background: boolean, hasTray: boolean) =>
    shouldQuitWhenAllClosed({ platform, background, hasTray });

  it('ends the app, unless it is meant to stay in the tray', () => {
    expect(quits('win32', false, true)).toBe(true);
    expect(quits('win32', true, false)).toBe(true);
    expect(quits('win32', false, false)).toBe(true);
    expect(quits('win32', true, true)).toBe(false);
  });

  it('leaves a Mac app running, as Mac apps do', () => {
    expect(quits('darwin', false, false)).toBe(false);
  });
});
