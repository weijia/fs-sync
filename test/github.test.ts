import { describe, it, expect } from 'vitest';
import { GitHubProvider } from '../src/providers/GitHubProvider';
import { createFsSync } from '../src';
import { gitServer } from './fakes';
import type { FileMeta } from '../src/core/types';

const enc = new TextEncoder();
const dec = new TextDecoder();
const API = 'https://api.github.test';

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

function makeProvider(fetch: ReturnType<typeof gitServer>['fetch'], name = 'gh') {
  return new GitHubProvider({
    name,
    owner: 'me',
    repo: 'notes',
    token: 't',
    branch: 'main',
    apiBase: API,
    fetch,
  });
}

describe('GitHubProvider', () => {
  it('authenticate hits the repo endpoint', async () => {
    const srv = gitServer(API);
    await expect(makeProvider(srv.fetch).authenticate()).resolves.toBeUndefined();
  });

  it('push creates a blob and returns its sha as etag', async () => {
    const srv = gitServer(API);
    const p = makeProvider(srv.fetch);
    const r = await p.push('/a.txt', enc.encode('hello'), meta('/a.txt', 'hello'));
    expect(r.etag).toBeTruthy();
    const s = await p.stat('/a.txt');
    expect(s?.etag).toBe(r.etag);
  });

  it('push updates an existing file (sha changes with content)', async () => {
    const srv = gitServer(API);
    const p = makeProvider(srv.fetch);
    const r1 = await p.push('/a.txt', enc.encode('v1'), meta('/a.txt', 'v1'));
    const r2 = await p.push('/a.txt', enc.encode('v2'), meta('/a.txt', 'v2'));
    expect(r2.etag).not.toBe(r1.etag);
    const { content } = await p.pull('/a.txt');
    expect(dec.decode(content)).toBe('v2');
  });

  it('list maps repo blobs to logical paths (with basePath)', async () => {
    const srv = gitServer(API);
    const p = new GitHubProvider({
      owner: 'me',
      repo: 'notes',
      token: 't',
      branch: 'main',
      basePath: 'docs',
      apiBase: API,
      fetch: srv.fetch,
    });
    await p.push('/guide.md', enc.encode('# hi'), meta('/guide.md', '# hi'));
    const list = await p.list('/');
    expect(list.map((r) => r.path)).toEqual(['/guide.md']);
    // stored under docs/ in the repo
    expect([...srv.files.keys()]).toEqual(['docs/guide.md']);
  });

  it('remove deletes the file', async () => {
    const srv = gitServer(API);
    const p = makeProvider(srv.fetch);
    await p.push('/a.txt', enc.encode('A'), meta('/a.txt', 'A'));
    await p.remove('/a.txt');
    expect(await p.stat('/a.txt')).toBeNull();
  });

  it('syncs bidirectionally through FsSync', async () => {
    const srv = gitServer(API);
    const alice = createFsSync({ storage: 'memory', providers: [makeProvider(srv.fetch)] });
    const bob = createFsSync({ storage: 'memory', providers: [makeProvider(srv.fetch)] });
    await alice.writeFile('/shared.txt', 'from-alice');
    expect((await alice.syncNow()).pushed).toBe(1);
    expect((await bob.syncNow()).pulled).toBe(1);
    expect(await bob.readFile('/shared.txt', { encoding: 'utf8' })).toBe('from-alice');
  });
});
