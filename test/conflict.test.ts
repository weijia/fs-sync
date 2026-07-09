import { describe, it, expect } from 'vitest';
import {
  LastWriteWinsResolver,
  KeepLocalResolver,
  KeepRemoteResolver,
  ManualResolver,
  ThreeWayMergeResolver,
  createConflictResolver,
} from '../src/core/ConflictResolver';
import type { Conflict, ConflictResolution, FileMeta } from '../src/core/types';

const enc = new TextEncoder();
const dec = new TextDecoder();

function makeConflict(localMtime: number, remoteMtime: number): Conflict {
  const L: FileMeta = {
    path: '/c',
    type: 'file',
    size: 1,
    mtime: localMtime,
    contentHash: 'l',
    version: 2,
    deleted: false,
  };
  const R = { path: '/c', size: 1, mtime: remoteMtime, etag: 'r', version: 2 };
  return { path: '/c', local: L, remote: R, base: null, localData: enc.encode('L'), remoteData: enc.encode('R'), baseData: null };
}

describe('ConflictResolver', () => {
  it('lastWriteWins picks the newer mtime', () => {
    const r = new LastWriteWinsResolver();
    expect(r.resolve(makeConflict(100, 200)).action).toBe('remote');
    expect(r.resolve(makeConflict(200, 100)).action).toBe('local');
  });

  it('lastWriteWins keeps loser copy by default', () => {
    const res = new LastWriteWinsResolver().resolve(makeConflict(100, 200));
    expect(res.keepLosersCopy).toBe(true);
  });

  it('keepLocal / keepRemote', () => {
    expect(new KeepLocalResolver().resolve(makeConflict(1, 1)).action).toBe('local');
    expect(new KeepRemoteResolver().resolve(makeConflict(1, 1)).action).toBe('remote');
  });

  it('manual returns skip', () => {
    expect(new ManualResolver().resolve(makeConflict(1, 1)).action).toBe('skip');
  });

  it('threeWayMerge merges with conflict markers', () => {
    const c = makeConflict(1, 1);
    c.baseData = enc.encode('base');
    c.localData = enc.encode('baseA');
    c.remoteData = enc.encode('baseB');
    const res = new ThreeWayMergeResolver().resolve(c);
    expect(res.action).toBe('merge');
    expect(dec.decode(res.mergedContent!)).toContain('<<<<<<<');
  });

  it('threeWayMerge falls back to LWW without base', () => {
    const res = new ThreeWayMergeResolver().resolve(makeConflict(100, 200));
    expect(res.action).toBe('remote');
  });

  it('threeWayMerge picks single-side change', () => {
    const c = makeConflict(1, 1);
    c.baseData = enc.encode('same');
    c.localData = enc.encode('same');
    c.remoteData = enc.encode('remoteOnly');
    expect(new ThreeWayMergeResolver().resolve(c).action).toBe('remote');

    const c2 = makeConflict(1, 1);
    c2.baseData = enc.encode('same');
    c2.localData = enc.encode('localOnly');
    c2.remoteData = enc.encode('same');
    expect(new ThreeWayMergeResolver().resolve(c2).action).toBe('local');
  });

  it('createConflictResolver factory', () => {
    const r1 = createConflictResolver('manual').resolve(makeConflict(1, 1)) as ConflictResolution;
    expect(r1.action).toBe('skip');
    const r2 = createConflictResolver('keepLocal').resolve(makeConflict(1, 1)) as ConflictResolution;
    expect(r2.action).toBe('local');
  });
});
