import type { StorageAdapter } from './StorageAdapter';
import type { FileMeta, DirMeta, WriteOptions } from './types';
import { contentHash } from './hash';
import { normalizePath, dirname } from './path';
import { ENOENT, EEXIST, EISDIR } from './errors';

interface FileRecord {
  meta: FileMeta;
  content: Uint8Array;
}

// In-memory StorageAdapter. Used in Node and as the test backend.
export class MemoryStorage implements StorageAdapter {
  private files = new Map<string, FileRecord>();
  private dirs = new Map<string, DirMeta>();
  private opened = false;

  async open(): Promise<void> {
    this.opened = true;
  }
  async close(): Promise<void> {
    this.opened = false;
    this.files.clear();
    this.dirs.clear();
  }

  private ensureOpen(): void {
    if (!this.opened) throw new Error('MemoryStorage not open');
  }

  async writeFile(path: string, content: Uint8Array, opts?: WriteOptions): Promise<FileMeta> {
    this.ensureOpen();
    const p = normalizePath(path);
    if ((await this.statDir(p)) !== null) throw new EISDIR(p);
    const existing = this.files.get(p);
    const version = existing ? existing.meta.version + 1 : 1;
    const meta: FileMeta = {
      path: p,
      type: 'file',
      size: content.length,
      mtime: opts?.mtime ?? Date.now(),
      contentHash: contentHash(content),
      version,
      deleted: false,
    };
    await this.mkdir(dirname(p));
    this.files.set(p, { meta, content: content.slice() });
    return { ...meta };
  }

  async readFile(path: string): Promise<Uint8Array> {
    this.ensureOpen();
    const p = normalizePath(path);
    const rec = this.files.get(p);
    if (!rec || rec.meta.deleted) throw new ENOENT(p);
    return rec.content.slice();
  }

  async deleteFile(path: string): Promise<void> {
    this.ensureOpen();
    this.files.delete(normalizePath(path));
  }

  async markDeleted(path: string): Promise<void> {
    this.ensureOpen();
    const p = normalizePath(path);
    const rec = this.files.get(p);
    if (!rec) throw new ENOENT(p);
    rec.meta.deleted = true;
    rec.meta.mtime = Date.now();
  }

  async statFile(path: string): Promise<FileMeta | null> {
    this.ensureOpen();
    const p = normalizePath(path);
    const rec = this.files.get(p);
    if (!rec || rec.meta.deleted) return null;
    return { ...rec.meta };
  }

  async mkdir(path: string): Promise<void> {
    this.ensureOpen();
    const p = normalizePath(path);
    if (this.files.has(p)) throw new EEXIST(p);
    if (this.dirs.has(p)) return;
    if (p !== '/') {
      const parent = dirname(p);
      if (!this.dirs.has(parent)) await this.mkdir(parent);
    }
    this.dirs.set(p, { path: p, type: 'dir', mtime: Date.now() });
  }

  async statDir(path: string): Promise<DirMeta | null> {
    this.ensureOpen();
    const p = normalizePath(path);
    return this.dirs.has(p) ? { ...(this.dirs.get(p) as DirMeta) } : null;
  }

  async readdir(path: string) {
    this.ensureOpen();
    const p = normalizePath(path);
    if (!(await this.statDir(p))) throw new ENOENT(p);
    const prefix = p === '/' ? '/' : p + '/';
    const entries: { name: string; type: 'file' | 'dir'; path: string }[] = [];
    for (const [dp, d] of this.dirs) {
      if (dp !== p && dp.startsWith(prefix) && !dp.slice(prefix.length).includes('/')) {
        entries.push({ name: dp.slice(prefix.length), type: 'dir', path: dp });
      }
    }
    for (const [fp, rec] of this.files) {
      if (!rec.meta.deleted && fp.startsWith(prefix) && !fp.slice(prefix.length).includes('/')) {
        entries.push({ name: fp.slice(prefix.length), type: 'file', path: fp });
      }
    }
    return entries;
  }

  async rmdir(path: string): Promise<void> {
    this.ensureOpen();
    const p = normalizePath(path);
    if (p === '/') throw new Error('cannot remove root');
    const entries = await this.readdir(p);
    if (entries.length) throw new Error('ENOTEMPTY: ' + p);
    this.dirs.delete(p);
  }

  async listAllFiles(): Promise<FileMeta[]> {
    this.ensureOpen();
    return [...this.files.values()].map((r) => ({ ...r.meta }));
  }

  async listAllDirs(): Promise<DirMeta[]> {
    this.ensureOpen();
    return [...this.dirs.values()].map((d) => ({ ...d }));
  }
}
