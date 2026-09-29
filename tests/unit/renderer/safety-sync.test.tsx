import { act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBackendSync } from '@renderer/app/use-backend-sync';
import { useSafetyStore } from '@renderer/stores/safety';
import { useToastStore } from '@renderer/stores/toasts';
import { useVoiceStore } from '@renderer/stores/voice';
import { renderUi } from '../../helpers/render';

let listeners: Map<string, Array<(payload: unknown) => void>>;
const emit = (channel: string, payload: unknown = {}) =>
  act(() => listeners.get(channel)?.forEach((listener) => listener(payload)));

function Probe() {
  useBackendSync();
  return null;
}

beforeEach(() => {
  listeners = new Map();
  (window as unknown as { allaya: unknown }).allaya = {
    invoke: vi.fn(async () => ({ ok: true, data: [] })),
    subscribe: (channel: string, listener: (payload: unknown) => void) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
      return () => undefined;
    },
  };
  useSafetyStore.setState({ activityVersion: 0, safetyVersion: 0 });
});

describe('what the backend tells the window about safety', () => {
  it('the system-wide stop key silences the microphone and says Stopped, as the STOP button does', () => {
    const interrupt = vi
      .spyOn(useVoiceStore.getState(), 'interrupt')
      .mockImplementation(() => undefined);
    renderUi(<Probe />);
    emit('agent:stopped', { cancelled: 2, via: 'shortcut' });
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual(['Stopped']);
    interrupt.mockRestore();
  });

  it('a recorded call makes the Activity screen look again', () => {
    renderUi(<Probe />);
    emit('activity:changed');
    emit('activity:changed');
    expect(useSafetyStore.getState().activityVersion).toBe(2);
  });

  it('a re-registered key makes the Permissions screen ask again', () => {
    renderUi(<Probe />);
    emit('agent:safetyChanged');
    expect(useSafetyStore.getState().safetyVersion).toBe(1);
  });
});
