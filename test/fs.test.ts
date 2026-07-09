import { describe, it, expect } from 'vitest';
import { createFsSync } from '../src';

describe('FsSync fs API (memory)', () => {
  it('write and read a file', async () => {
    const fs = createFsSync({ storage: 'memory' });
    await fs.writeFile('/a.txt', 'hello');
    expect(await fs.readFile('/a.txt', { encoding: 'utf8' })).toBe('hello');
  });

  it('returns Uint8Array without encoding', async () => {
    const fs = createFsSync({ storage: 'memory' });
    await fs.writeFile('/a.bin', new Uint8Array([1, 2, 3]));
    const data = (await fs.readFile('/a.bin')) as Uint8Array;
    expect(data).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('mkdir and readdir', async () => {
    const fs = createFsSync({ storage: 'memory' });
    await fs.mkdir('/docs', { recursive: true });
    await fs.writeFile('/docs/a.md', 'x');
    await fs.writeFile('/docs/b.md', 'y');
    expect((await fs.readdir('/docs')).sort()).toEqual(['a.md', 'b.md']);
  });

  it('readdir withFileTypes', async () => {
    const fs = createFsSync({ storage: 'memory' });
    await fs.mkdir('/d');
    await fs.writeFile('/d/file.txt', 'x');
    const entries = (await fs.readdir('/d', { withFileTypes: true })) as { name: string; isFile(): boolean; isDirectory(): boolean }[];
    const file = entries.find((e) => e.name === 'file.txt')!;
    expect(file.isFile()).toBe(true);
  });

  it('exists / existsSync', async () => {
    const fs = createFsSync({ storage: 'memory' });
    await fs.writeFile('/x.txt', '1');
    expect(await fs.exists('/x.txt')).toBe(true);
    expect(fs.existsSync('/x.txt')).toBe(true);
    expect(await fs.exists('/nope')).toBe(false);
  });

  it('stat reports size and type', async () => {
    const fs = createFsSync({ storage: 'memory' });
    await fs.writeFile('/x.txt', '12345');
    const st = await fs.stat('/x.txt');
    expect(st.isFile()).toBe(true);
    expect(st.size).toBe(5);
    await fs.mkdir('/d');
    const ds = await fs.stat('/d');
    expect(ds.isDirectory()).toBe(true);
  });

  it('unlink removes file', async () => {
    const fs = createFsSync({ storage: 'memory' });
    await fs.writeFile('/x.txt', '1');
    await fs.unlink('/x.txt');
    expect(await fs.exists('/x.txt')).toBe(false);
  });

  it('rm recursive removes directory tree', async () => {
    const fs = createFsSync({ storage: 'memory' });
    await fs.mkdir('/d');
    await fs.writeFile('/d/a', '1');
    await fs.writeFile('/d/b', '2');
    await fs.rm('/d', { recursive: true });
    expect(await fs.exists('/d')).toBe(false);
  });

  it('rename a file', async () => {
    const fs = createFsSync({ storage: 'memory' });
    await fs.writeFile('/a.txt', 'data');
    await fs.rename('/a.txt', '/b.txt');
    expect(await fs.exists('/a.txt')).toBe(false);
    expect(await fs.readFile('/b.txt', { encoding: 'utf8' })).toBe('data');
  });

  it('append flag', async () => {
    const fs = createFsSync({ storage: 'memory' });
    await fs.writeFile('/a.txt', 'foo');
    await fs.writeFile('/a.txt', 'bar', { flag: 'a' });
    expect(await fs.readFile('/a.txt', { encoding: 'utf8' })).toBe('foobar');
  });

  it('ENOENT on missing file', async () => {
    const fs = createFsSync({ storage: 'memory' });
    await expect(fs.readFile('/missing')).rejects.toThrow();
  });

  it('EISDIR on unlink of a directory', async () => {
    const fs = createFsSync({ storage: 'memory' });
    await fs.mkdir('/d');
    await expect(fs.unlink('/d')).rejects.toThrow();
  });
});
