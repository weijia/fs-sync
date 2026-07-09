import { describe, it, expect } from 'vitest';
import 'fake-indexeddb/auto';
import { MemoryStorage } from '../src/core/MemoryStorage';
import { IndexedDbStorage } from '../src/core/IndexedDbStorage';
import type { StorageAdapter } from '../src/core/StorageAdapter';

async function makeStorage(name: string): Promise<StorageAdapter> {
  if (name === 'memory') {
    const s = new MemoryStorage();
    await s.open();
    return s;
  }
  const s = new IndexedDbStorage('test-' + Math.random().toString(36).slice(2));
  await s.open();
  return s;
}

function storageTests(name: string): void {
  describe('StorageAdapter: ' + name, () => {
    it('write / read / stat', async () => {
      const s = await makeStorage(name);
      const meta = await s.writeFile('/a.txt', new TextEncoder().encode('hi'));
      expect(meta.size).toBe(2);
      expect(meta.version).toBe(1);
      expect(meta.deleted).toBe(false);
      expect(await s.readFile('/a.txt')).toEqual(new TextEncoder().encode('hi'));
      const st = await s.statFile('/a.txt');
      expect(st?.path).toBe('/a.txt');
    });

    it('version increments on rewrite', async () => {
      const s = await makeStorage(name);
      await s.writeFile('/a.txt', new TextEncoder().encode('v1'));
      const m2 = await s.writeFile('/a.txt', new TextEncoder().encode('v2'));
      expect(m2.version).toBe(2);
      expect(await s.readFile('/a.txt')).toEqual(new TextEncoder().encode('v2'));
    });

    it('mkdir and readdir', async () => {
      const s = await makeStorage(name);
      await s.mkdir('/dir');
      await s.writeFile('/dir/x.txt', new TextEncoder().encode('1'));
      await s.writeFile('/dir/y.txt', new TextEncoder().encode('2'));
      const entries = await s.readdir('/dir');
      expect(entries.map((e) => e.name).sort()).toEqual(['x.txt', 'y.txt']);
    });

    it('recursive mkdir', async () => {
      const s = await makeStorage(name);
      await s.mkdir('/a/b/c');
      expect(await s.statDir('/a/b/c')).not.toBeNull();
    });

    it('markDeleted hides file and readFile throws', async () => {
      const s = await makeStorage(name);
      await s.writeFile('/f.txt', new TextEncoder().encode('x'));
      await s.markDeleted('/f.txt');
      expect(await s.statFile('/f.txt')).toBeNull();
      await expect(s.readFile('/f.txt')).rejects.toThrow();
    });

    it('rmdir non-empty throws', async () => {
      const s = await makeStorage(name);
      await s.mkdir('/d');
      await s.writeFile('/d/f.txt', new TextEncoder().encode('x'));
      await expect(s.rmdir('/d')).rejects.toThrow();
    });

    it('rmdir empty succeeds', async () => {
      const s = await makeStorage(name);
      await s.mkdir('/empty');
      await s.rmdir('/empty');
      expect(await s.statDir('/empty')).toBeNull();
    });

    it('listAllFiles includes tombstones', async () => {
      const s = await makeStorage(name);
      await s.writeFile('/keep.txt', new TextEncoder().encode('1'));
      await s.writeFile('/gone.txt', new TextEncoder().encode('2'));
      await s.markDeleted('/gone.txt');
      const all = await s.listAllFiles();
      const paths = all.map((f) => f.path).sort();
      expect(paths).toEqual(['/gone.txt', '/keep.txt']);
      expect(all.find((f) => f.path === '/gone.txt')?.deleted).toBe(true);
    });
  });
}

storageTests('memory');
storageTests('indexeddb');
