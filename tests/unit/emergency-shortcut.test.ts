import { describe, expect, it } from 'vitest';
import { nullLogger } from '@allaya/shared';
import {
  EmergencyStopShortcut,
  type ShortcutRegistrar,
} from '../../apps/desktop/main/security/emergency-shortcut';

function rig(behaviour: 'ok' | 'in_use' | 'invalid' = 'ok') {
  const state = {
    accelerator: 'Ctrl+Shift+Escape',
    behaviour,
    held: new Map<string, () => void>(),
    stops: 0,
    failStop: false,
  };
  const registrar: ShortcutRegistrar = {
    register(accelerator, callback) {
      if (state.behaviour === 'invalid') throw new TypeError('Invalid accelerator');
      if (state.behaviour === 'in_use') return false;
      state.held.set(accelerator, callback);
      return true;
    },
    unregister(accelerator) {
      state.held.delete(accelerator);
    },
  };
  const shortcut = new EmergencyStopShortcut({
    registrar,
    accelerator: () => state.accelerator,
    onStop: () => {
      state.stops += 1;
      if (state.failStop) throw new Error('boom');
    },
    logger: nullLogger,
  });
  return { state, shortcut };
}

describe('the system-wide emergency stop key', () => {
  it('says it is not registered until it is asked to register', () => {
    const { shortcut } = rig();
    expect(shortcut.status()).toEqual({
      accelerator: 'Ctrl+Shift+Escape',
      registered: false,
      reason: 'unavailable',
    });
  });

  it('registers the chosen combination, and pressing it stops everything', () => {
    const { shortcut, state } = rig();
    expect(shortcut.apply()).toEqual({ accelerator: 'Ctrl+Shift+Escape', registered: true });
    expect([...state.held.keys()]).toEqual(['Ctrl+Shift+Escape']);
    state.held.get('Ctrl+Shift+Escape')!();
    state.held.get('Ctrl+Shift+Escape')!();
    expect(state.stops).toBe(2);
  });

  it('follows the setting: the old key is given back before the new one is taken', () => {
    const { shortcut, state } = rig();
    shortcut.apply();
    state.accelerator = 'Ctrl+Alt+X';
    expect(shortcut.apply()).toEqual({ accelerator: 'Ctrl+Alt+X', registered: true });
    expect([...state.held.keys()]).toEqual(['Ctrl+Alt+X']);
  });

  it('applying twice never holds two keys', () => {
    const { shortcut, state } = rig();
    shortcut.apply();
    shortcut.apply();
    expect(state.held.size).toBe(1);
  });

  it('says so — never silently — when another program holds the key', () => {
    const { shortcut, state } = rig('in_use');
    expect(shortcut.apply()).toEqual({
      accelerator: 'Ctrl+Shift+Escape',
      registered: false,
      reason: 'in_use',
    });
    expect(state.held.size).toBe(0);
  });

  it('says so when the combination is not valid', () => {
    const { shortcut } = rig('invalid');
    expect(shortcut.apply()).toMatchObject({ registered: false, reason: 'invalid' });
  });

  it('a failed re-registration does not leave the old key behind', () => {
    const { shortcut, state } = rig();
    shortcut.apply();
    state.behaviour = 'in_use';
    state.accelerator = 'Ctrl+Alt+Y';
    shortcut.apply();
    expect(state.held.size).toBe(0);
    expect(shortcut.status()).toMatchObject({ accelerator: 'Ctrl+Alt+Y', registered: false });
  });

  it('a failure while stopping is contained: the key keeps working', () => {
    const { shortcut, state } = rig();
    shortcut.apply();
    state.failStop = true;
    expect(() => state.held.get('Ctrl+Shift+Escape')!()).not.toThrow();
    state.failStop = false;
    state.held.get('Ctrl+Shift+Escape')!();
    expect(state.stops).toBe(2);
  });

  it('gives the key back on release, and releasing twice is harmless', () => {
    const { shortcut, state } = rig();
    shortcut.apply();
    shortcut.release();
    shortcut.release();
    expect(state.held.size).toBe(0);
    expect(shortcut.status().registered).toBe(false);
  });
});
