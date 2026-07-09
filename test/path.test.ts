import { describe, it, expect } from 'vitest';
import { normalizePath, dirname, basename, isInside } from '../src/core/path';

describe('path', () => {
  it('normalizePath resolves . and ..', () => {
    expect(normalizePath('/a/b/../c')).toBe('/a/c');
    expect(normalizePath('a/b')).toBe('/a/b');
    expect(normalizePath('/a/')).toBe('/a');
    expect(normalizePath('/')).toBe('/');
    expect(normalizePath('/a/../../b')).toBe('/b');
    expect(normalizePath('')).toBe('/');
  });

  it('dirname and basename', () => {
    expect(dirname('/a/b/c')).toBe('/a/b');
    expect(dirname('/a')).toBe('/');
    expect(basename('/a/b/c')).toBe('c');
    expect(basename('/')).toBe('');
  });

  it('isInside', () => {
    expect(isInside('/a', '/a/b')).toBe(true);
    expect(isInside('/a', '/a')).toBe(false);
    expect(isInside('/', '/x')).toBe(true);
    expect(isInside('/a', '/b/c')).toBe(false);
  });
});
