import { describe, it, expect } from 'vitest';
import { contentHash } from '../src/core/hash';
import { toUint8Array, bytesToBase64, bytesToHex, decodeText } from '../src/core/util';

describe('hash & util', () => {
  it('contentHash is deterministic', () => {
    const a = contentHash(new TextEncoder().encode('hello'));
    const b = contentHash(new TextEncoder().encode('hello'));
    expect(a).toBe(b);
  });

  it('contentHash changes with content', () => {
    expect(contentHash(new TextEncoder().encode('a'))).not.toBe(contentHash(new TextEncoder().encode('b')));
  });

  it('toUint8Array handles strings', () => {
    expect(toUint8Array('hi')).toEqual(new TextEncoder().encode('hi'));
  });

  it('toUint8Array keeps Uint8Array', () => {
    const u = new Uint8Array([1, 2, 3]);
    expect(toUint8Array(u)).toBe(u);
  });

  it('base64 and hex encode', () => {
    const u = new Uint8Array([0, 1, 2, 255]);
    expect(bytesToBase64(u)).toBe(Buffer.from(u).toString('base64'));
    expect(bytesToHex(u)).toBe('000102ff');
  });

  it('decodeText round-trips', () => {
    const u = new TextEncoder().encode('héllo');
    expect(decodeText(u)).toBe('héllo');
  });
});
