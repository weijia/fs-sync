import { describe, it, expect } from 'vitest';
import { RemoteStorageProvider } from '../src/providers/RemoteStorageProvider';
import { createFsSync } from '../src';
import { remoteStorageServer } from './fakes';
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

describe('RemoteStorageProvider', () => {
  it('authenticate reads the storage root', async () => {
    const srv = remoteStorageServer();
    const p = new RemoteStorageProvider({ baseUrl: srv.base, token: 't', fetch: srv.fetch });
    await expect(p.authenticate()).resolves.toBeUndefined();
  });

  it('push then pull round-trips content and etag', async () => {
    const srv = remoteStorageServer();
    const p = new RemoteStorageProvider({ baseUrl: srv.base, token: 't', fetch: srv.fetch });
    const r = await p.push('/a.txt', enc.encode('hello'), meta('/a.txt', 'hello'));
    expect(r.etag).toBeTruthy();
    const { content } = await p.pull('/a.txt');
    expect(dec.decode(content)).toBe('hello');
  });

  it('list recurses into subfolders', async () => {
    const srv = remoteStorageServer();
    const p = new RemoteStorageProvider({ baseUrl: srv.base, token: 't', fetch: srv.fetch });
    await p.push('/a.txt', enc.encode('A'), meta('/a.txt', 'A'));
    await p.push('/sub/b.txt', enc.encode('BB'), meta('/sub/b.txt', 'BB'));
    await p.push('/sub/deep/c.txt', enc.encode('CCC'), meta('/sub/deep/c.txt', 'CCC'));
    const paths = (await p.list('/')).map((r) => r.path).sort();
    expect(paths).toEqual(['/a.txt', '/sub/b.txt', '/sub/deep/c.txt']);
  });

  it('stat finds a nested file via its parent folder', async () => {
    const srv = remoteStorageServer();
    const p = new RemoteStorageProvider({ baseUrl: srv.base, token: 't', fetch: srv.fetch });
    await p.push('/sub/b.txt', enc.encode('BB'), meta('/sub/b.txt', 'BB'));
    const s = await p.stat('/sub/b.txt');
    expect(s?.size).toBe(2);
    expect(await p.stat('/sub/missing.txt')).toBeNull();
  });

  it('remove deletes the file', async () => {
    const srv = remoteStorageServer();
    const p = new RemoteStorageProvider({ baseUrl: srv.base, token: 't', fetch: srv.fetch });
    await p.push('/a.txt', enc.encode('A'), meta('/a.txt', 'A'));
    await p.remove('/a.txt');
    expect(await p.stat('/a.txt')).toBeNull();
  });

  it('syncs bidirectionally through FsSync', async () => {
    const srv = remoteStorageServer();
    const alice = createFsSync({
      storage: 'memory',
      providers: [new RemoteStorageProvider({ name: 'rs', baseUrl: srv.base, token: 't', fetch: srv.fetch })],
    });
    const bob = createFsSync({
      storage: 'memory',
      providers: [new RemoteStorageProvider({ name: 'rs', baseUrl: srv.base, token: 't', fetch: srv.fetch })],
    });
    await alice.writeFile('/shared.txt', 'from-alice');
    expect((await alice.syncNow()).pushed).toBe(1);
    expect((await bob.syncNow()).pulled).toBe(1);
    expect(await bob.readFile('/shared.txt', { encoding: 'utf8' })).toBe('from-alice');
  });
});
