import { describe, it, expect } from 'vitest';
import { WebDavProvider } from '../src/providers/WebDavProvider';
import { createFsSync } from '../src';
import { webdavServer } from './fakes';
import type { FileMeta } from '../src/core/types';

const enc = new TextEncoder();
const dec = new TextDecoder();

function meta(path: string, content: string): FileMeta {
  return {
    path,
    type: 'file',
    size: enc.encode(content).length,
    mtime: 1000,
    contentHash: 'x',
    version: 1,
    deleted: false,
  };
}

describe('WebDavProvider', () => {
  it('authenticate succeeds against a reachable root', async () => {
    const srv = webdavServer();
    const p = new WebDavProvider({ baseUrl: srv.base, username: 'u', password: 'p', fetch: srv.fetch });
    await expect(p.authenticate()).resolves.toBeUndefined();
  });

  it('push then stat/pull round-trips content and etag', async () => {
    const srv = webdavServer();
    const p = new WebDavProvider({ baseUrl: srv.base, fetch: srv.fetch });
    const pushed = await p.push('/notes/a.txt', enc.encode('hello'), meta('/notes/a.txt', 'hello'));
    expect(pushed.etag).toBeTruthy();

    const s = await p.stat('/notes/a.txt');
    expect(s?.etag).toBe(pushed.etag);

    const { content } = await p.pull('/notes/a.txt');
    expect(dec.decode(content)).toBe('hello');
  });

  it('list returns only files with metadata', async () => {
    const srv = webdavServer();
    const p = new WebDavProvider({ baseUrl: srv.base, fetch: srv.fetch });
    await p.push('/a.txt', enc.encode('A'), meta('/a.txt', 'A'));
    await p.push('/dir/b.txt', enc.encode('BB'), meta('/dir/b.txt', 'BB'));
    const list = await p.list('/');
    const paths = list.map((r) => r.path).sort();
    expect(paths).toEqual(['/a.txt', '/dir/b.txt']);
    expect(list.every((r) => typeof r.size === 'number')).toBe(true);
  });

  it('remove deletes the remote file', async () => {
    const srv = webdavServer();
    const p = new WebDavProvider({ baseUrl: srv.base, fetch: srv.fetch });
    await p.push('/a.txt', enc.encode('A'), meta('/a.txt', 'A'));
    await p.remove('/a.txt');
    expect(await p.stat('/a.txt')).toBeNull();
  });

  it('stat returns null for a missing file', async () => {
    const srv = webdavServer();
    const p = new WebDavProvider({ baseUrl: srv.base, fetch: srv.fetch });
    expect(await p.stat('/nope.txt')).toBeNull();
  });

  it('syncs bidirectionally through FsSync', async () => {
    const srv = webdavServer();
    const alice = createFsSync({
      storage: 'memory',
      providers: [new WebDavProvider({ name: 'dav', baseUrl: srv.base, fetch: srv.fetch })],
    });
    const bob = createFsSync({
      storage: 'memory',
      providers: [new WebDavProvider({ name: 'dav', baseUrl: srv.base, fetch: srv.fetch })],
    });
    await alice.writeFile('/shared.txt', 'from-alice');
    const r1 = await alice.syncNow();
    expect(r1.pushed).toBe(1);
    const r2 = await bob.syncNow();
    expect(r2.pulled).toBe(1);
    expect(await bob.readFile('/shared.txt', { encoding: 'utf8' })).toBe('from-alice');
  });

  it('does not echo on a second sync', async () => {
    const srv = webdavServer();
    const fs = createFsSync({
      storage: 'memory',
      providers: [new WebDavProvider({ name: 'dav', baseUrl: srv.base, fetch: srv.fetch })],
    });
    await fs.writeFile('/a.txt', 'hi');
    await fs.syncNow();
    const res = await fs.syncNow();
    expect(res.pushed).toBe(0);
    expect(res.pulled).toBe(0);
  });
});
