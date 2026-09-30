import { describe, expect, it } from 'vitest';
import { encodeWav } from '@renderer/lib/voice/wav';

describe('encodeWav', () => {
  it('writes a valid 16-bit mono header and scales the samples', () => {
    const wav = encodeWav(new Float32Array([0, 1, -1, 0.5, 2, -2]), 16000);
    const view = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...wav.slice(8, 16))).toBe('WAVEfmt ');
    expect(view.getUint32(4, true)).toBe(36 + 12);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(12);
    const samples = [0, 1, 2, 3, 4, 5].map((i) => view.getInt16(44 + i * 2, true));
    expect(samples).toEqual([0, 32767, -32768, 16383, 32767, -32768]); // beyond ±1 is clipped, not wrapped
  });
});
