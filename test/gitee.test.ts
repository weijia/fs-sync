import { describe, it, expect } from 'vitest';
import { GiteeProvider } from '../src/providers/GiteeProvider';
import { createFsSync } from '../src';
import { gitServer } from './fakes';
import type { FileMeta } from '../src/core/types';
import type { HttpRequestInit } from '../src/providers/http';

const enc = new TextEncoder();
const dec = new TextDecoder();
const API = 'https://gitee.test/api/v5';

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

function makeProvider(fetch: ReturnType<typeof gitServer>['fetch']) {
  return new GiteeProvider({
    owner: 'me',
    repo: 'notes',
    token: 'secret-token',
    branch: 'main',
    apiBase: API,
    fetch,
  });
}

describe('GiteeProvider', () => {
  it('sends access_token as a query parameter', async () => {
    const srv = gitServer(API);
    const seen: string[] = [];
    const spyFetch = async (url: string, init?: HttpRequestInit) => {
      seen.push(url);
      return srv.fetch(url, init);
    };
    const p = new GiteeProvider({ owner: 'me', repo: 'notes', token: 'secret-token', apiBase: API, fetch: spyFetch });
    await p.authenticate();
    expect(seen.some((u) => u.includes('access_token=secret-token'))).toBe(true);
  });

  it('push then pull round-trips content', async () => {
    const srv = gitServer(API);
    const p = makeProvider(srv.fetch);
    await p.push('/a.txt', enc.encode('hello-gitee'), meta('/a.txt', 'hello-gitee'));
    const { content } = await p.pull('/a.txt');
    expect(dec.decode(content)).toBe('hello-gitee');
  });

  it('list and remove work', async () => {
    const srv = gitServer(API);
    const p = makeProvider(srv.fetch);
    await p.push('/a.txt', enc.encode('A'), meta('/a.txt', 'A'));
    await p.push('/b.txt', enc.encode('B'), meta('/b.txt', 'B'));
    expect((await p.list('/')).map((r) => r.path).sort()).toEqual(['/a.txt', '/b.txt']);
    await p.remove('/a.txt');
    expect((await p.list('/')).map((r) => r.path)).toEqual(['/b.txt']);
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
