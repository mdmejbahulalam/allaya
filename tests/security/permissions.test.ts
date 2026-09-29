import { describe, expect, it } from 'vitest';
import { isPermissionAllowed, type PermissionQuery } from '@main/security/window-security';

const config = {};
const query = (over: Partial<PermissionQuery> = {}): PermissionQuery => ({
  permission: 'media',
  url: 'allaya-app://app/index.html',
  mediaTypes: ['audio'],
  microphoneEnabled: true,
  ...over,
});

describe('web permission policy', () => {
  it('grants the microphone to our own origin once voice is on', () => {
    expect(isPermissionAllowed(query(), config)).toBe(true);
  });

  it('grants nothing before the user has turned voice on', () => {
    expect(isPermissionAllowed(query({ microphoneEnabled: false }), config)).toBe(false);
  });

  it('never grants the camera — alone or together with the microphone', () => {
    expect(isPermissionAllowed(query({ mediaTypes: ['video'] }), config)).toBe(false);
    expect(isPermissionAllowed(query({ mediaTypes: ['audio', 'video'] }), config)).toBe(false);
    expect(isPermissionAllowed(query({ mediaTypes: ['unknown'] }), config)).toBe(false);
  });

  it('refuses a media request that does not say what it wants', () => {
    expect(isPermissionAllowed(query({ mediaTypes: undefined }), config)).toBe(false);
    expect(isPermissionAllowed(query({ mediaTypes: [] }), config)).toBe(false);
  });

  it('refuses any other origin', () => {
    for (const url of [
      'https://evil.example/',
      'allaya-app://evil/index.html',
      'file:///x.html',
      'javascript:1',
      '',
    ]) {
      expect(isPermissionAllowed(query({ url }), config), url).toBe(false);
    }
  });

  it.each([
    'geolocation',
    'notifications',
    'clipboard-read',
    'clipboard-sanitized-write',
    'display-capture',
    'midi',
    'midiSysex',
    'openExternal',
    'fullscreen',
    'pointerLock',
    'idle-detection',
    'hid',
    'serial',
    'usb',
  ])('denies %s even from our own origin with voice on', (permission) => {
    expect(isPermissionAllowed(query({ permission }), config)).toBe(false);
  });
});
