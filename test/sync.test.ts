import { describe, it, expect, vi } from 'vitest';
import { createFsSync } from '../src';
import { MemoryProvider } from '../src/providers/MemoryProvider';
import type { FileMeta } from '../src/core/types';

const enc = new TextEncoder();
const dec = new TextDecoder();

function remoteMeta(path: string, content: string, mtime: number): FileMeta {
  return {
    path,
    type: 'file',
    size: enc.encode(content).length,
    mtime,
    contentHash: 'x',
    version: 1,
    deleted: false,
  };
}

describe('Sync engine (via MemoryProvider)', () => {
  it('pushes a new local file to remote', async () => {
    const provider = new MemoryProvider('remote');
    const fs = createFsSync({ storage: 'memory', providers: [provider] });
    await fs.writeFile('/a.txt', 'hello');
    const res = await fs.syncNow();
    expect(res.pushed).toBe(1);
    const { content } = await provider.pull('/a.txt');
    expect(dec.decode(content)).toBe('hello');
  });

  it('pulls a new remote file locally', async () => {
    const provider = new MemoryProvider('remote');
    await provider.push('/b.txt', enc.encode('world'), remoteMeta('/b.txt', 'world', Date.now()));
    const fs = createFsSync({ storage: 'memory', providers: [provider] });
    const res = await fs.syncNow();
    expect(res.pulled).toBe(1);
    expect(await fs.readFile('/b.txt', { encoding: 'utf8' })).toBe('world');
  });

  it('does not echo on a second sync', async () => {
    const provider = new MemoryProvider('remote');
    const fs = createFsSync({ storage: 'memory', providers: [provider] });
    await fs.writeFile('/a.txt', 'hi');
    await fs.syncNow();
    const res = await fs.syncNow();
    expect(res.pushed).toBe(0);
    expect(res.pulled).toBe(0);
  });

  it('removes the remote copy when a local file is deleted', async () => {
    const provider = new MemoryProvider('remote');
    const fs = createFsSync({ storage: 'memory', providers: [provider] });
    await fs.writeFile('/d.txt', 'x');
    await fs.syncNow();
    await fs.unlink('/d.txt');
    const res = await fs.syncNow();
    expect(res.removed).toBe(1);
    expect(await provider.stat('/d.txt')).toBeNull();
  });

  it('resolves a conflict with lastWriteWins (remote newer)', async () => {
    const provider = new MemoryProvider('remote');
    const fs = createFsSync({ storage: 'memory', providers: [provider], conflictResolver: 'lastWriteWins' });
    await fs.writeFile('/c.txt', 'v1');
    await fs.syncNow();
    await fs.writeFile('/c.txt', 'local-edit', { mtime: 1000 });
    await provider.push('/c.txt', enc.encode('remote-edit'), remoteMeta('/c.txt', 'remote-edit', 2000));
    const res = await fs.syncNow();
    expect(res.conflicts).toBe(1);
    expect(await fs.readFile('/c.txt', { encoding: 'utf8' })).toBe('remote-edit');
  });

  it('lastWriteWins keeps a loser copy', async () => {
    const provider = new MemoryProvider('remote');
    const fs = createFsSync({ storage: 'memory', providers: [provider], conflictResolver: 'lastWriteWins' });
    await fs.writeFile('/c.txt', 'v1');
    await fs.syncNow();
    await fs.writeFile('/c.txt', 'local-edit', { mtime: 1000 });
    await provider.push('/c.txt', enc.encode('remote-edit'), remoteMeta('/c.txt', 'remote-edit', 2000));
    await fs.syncNow();
    const entries = (await fs.readdir('/')) as string[];
    expect(entries.some((n) => n.startsWith('c.txt.conflict-local-'))).toBe(true);
  });

  it('manual resolver defers the conflict', async () => {
    const provider = new MemoryProvider('remote');
    const fs = createFsSync({ storage: 'memory', providers: [provider], conflictResolver: 'manual' });
    await fs.writeFile('/c.txt', 'v1');
    await fs.syncNow();
    await fs.writeFile('/c.txt', 'local-edit', { mtime: 1000 });
    await provider.push('/c.txt', enc.encode('remote-edit'), remoteMeta('/c.txt', 'remote-edit', 2000));
    const onConflict = vi.fn();
    fs.on('conflict', onConflict);
    const res = await fs.syncNow();
    expect(res.conflicts).toBe(1);
    expect(onConflict).toHaveBeenCalled();
    // file stays as the local version (deferred, not overwritten)
    expect(await fs.readFile('/c.txt', { encoding: 'utf8' })).toBe('local-edit');
  });

  it('two clients converge via a shared provider', async () => {
    const provider = new MemoryProvider('remote');
    const alice = createFsSync({ storage: 'memory', providers: [provider] });
    const bob = createFsSync({ storage: 'memory', providers: [provider] });

    await alice.writeFile('/shared.txt', 'from-alice');
    await alice.syncNow();
    await bob.syncNow();
    expect(await bob.readFile('/shared.txt', { encoding: 'utf8' })).toBe('from-alice');

    await bob.writeFile('/shared.txt', 'from-bob');
    await bob.syncNow();
    await alice.syncNow();
    expect(await alice.readFile('/shared.txt', { encoding: 'utf8' })).toBe('from-bob');
  });

  it('emits synced event with a result', async () => {
    const provider = new MemoryProvider('remote');
    const fs = createFsSync({ storage: 'memory', providers: [provider] });
    await fs.writeFile('/a.txt', 'hi');
    const onSynced = vi.fn();
    fs.on('synced', onSynced);
    await fs.syncNow();
    expect(onSynced).toHaveBeenCalledOnce();
    expect((onSynced.mock.calls[0] as unknown[])[0]).toHaveProperty('pushed');
  });
});
