import type { StorageAdapter } from './StorageAdapter';
import type { FileMeta, DirMeta, WriteOptions } from './types';
import { contentHash } from './hash';
import { normalizePath, dirname } from './path';
import { ENOENT, EEXIST, EISDIR } from './errors';

const DB_NAME = 'fs-sync';
const STORE_FILES = 'files';
const STORE_DIRS = 'dirs';

interface FileRecord {
  path: string;
  meta: FileMeta;
  content: Uint8Array;
}

// Browser StorageAdapter backed by IndexedDB. Each file record stores content
// and metadata; directories are stored separately. Safe for binary content.
export class IndexedDbStorage implements StorageAdapter {
  private dbName: string;
  private db: IDBDatabase | null = null;

  constructor(dbName: string = DB_NAME) {
    this.dbName = dbName;
  }

  async open(): Promise<void> {
    if (this.db) return;
    this.db = await this.openDb();
  }

  private openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_FILES)) {
          db.createObjectStore(STORE_FILES, { keyPath: 'path' });
        }
        if (!db.objectStoreNames.contains(STORE_DIRS)) {
          db.createObjectStore(STORE_DIRS, { keyPath: 'path' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }

  private getDb(): IDBDatabase {
    if (!this.db) throw new Error('IndexedDbStorage not open');
    return this.db;
  }

  private req<T>(r: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }

  private txDone(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  private async put<T>(store: string, value: T): Promise<void> {
    const db = this.getDb();
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value as unknown as IDBValidKey extends never ? never : any);
    await this.txDone(tx);
  }

  private async del(store: string, key: string): Promise<void> {
    const db = this.getDb();
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    await this.txDone(tx);
  }

  private async get<T>(store: string, key: string): Promise<T | undefined> {
    const db = this.getDb();
    const tx = db.transaction(store, 'readonly');
    return this.req(tx.objectStore(store).get(key) as IDBRequest<T>);
  }

  private async getAll<T>(store: string): Promise<T[]> {
    const db = this.getDb();
    const tx = db.transaction(store, 'readonly');
    return this.req(tx.objectStore(store).getAll() as IDBRequest<T[]>);
  }

  async writeFile(path: string, content: Uint8Array, opts?: WriteOptions): Promise<FileMeta> {
    const p = normalizePath(path);
    const existing = await this.get<FileRecord>(STORE_FILES, p);
    if (await this.get<DirMeta>(STORE_DIRS, p)) throw new EISDIR(p);
    const parent = dirname(p);
    if (parent !== '/' && !(await this.get<DirMeta>(STORE_DIRS, parent))) await this.mkdir(parent);
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
    await this.put(STORE_FILES, { path: p, meta, content: content.slice() } as FileRecord);
    return { ...meta };
  }

  async readFile(path: string): Promise<Uint8Array> {
    const p = normalizePath(path);
    const rec = await this.get<FileRecord>(STORE_FILES, p);
    if (!rec || rec.meta.deleted) throw new ENOENT(p);
    return rec.content.slice();
  }

  async deleteFile(path: string): Promise<void> {
    await this.del(STORE_FILES, normalizePath(path));
  }

  async markDeleted(path: string): Promise<void> {
    const p = normalizePath(path);
    const rec = await this.get<FileRecord>(STORE_FILES, p);
    if (!rec) throw new ENOENT(p);
    rec.meta.deleted = true;
    rec.meta.mtime = Date.now();
    await this.put(STORE_FILES, rec);
  }

  async statFile(path: string): Promise<FileMeta | null> {
    const rec = await this.get<FileRecord>(STORE_FILES, normalizePath(path));
    if (!rec || rec.meta.deleted) return null;
    return { ...rec.meta };
  }

  async mkdir(path: string): Promise<void> {
    const p = normalizePath(path);
    if (await this.get<FileRecord>(STORE_FILES, p)) throw new EEXIST(p);
    if (await this.get<DirMeta>(STORE_DIRS, p)) return;
    const parent = dirname(p);
    if (parent !== '/' && !(await this.get<DirMeta>(STORE_DIRS, parent))) await this.mkdir(parent);
    await this.put(STORE_DIRS, { path: p, type: 'dir', mtime: Date.now() } as DirMeta);
  }

  async statDir(path: string): Promise<DirMeta | null> {
    const rec = await this.get<DirMeta>(STORE_DIRS, normalizePath(path));
    return rec ? { ...rec } : null;
  }

  async readdir(path: string) {
    const p = normalizePath(path);
    if (!(await this.statDir(p))) throw new ENOENT(p);
    const prefix = p === '/' ? '/' : p + '/';
    const out: { name: string; type: 'file' | 'dir'; path: string }[] = [];
    const dirs = await this.getAll<DirMeta>(STORE_DIRS);
    for (const d of dirs) {
      if (d.path !== p && d.path.startsWith(prefix) && !d.path.slice(prefix.length).includes('/')) {
        out.push({ name: d.path.slice(prefix.length), type: 'dir', path: d.path });
      }
    }
    const files = await this.getAll<FileRecord>(STORE_FILES);
    for (const f of files) {
      if (!f.meta.deleted && f.path.startsWith(prefix) && !f.path.slice(prefix.length).includes('/')) {
        out.push({ name: f.path.slice(prefix.length), type: 'file', path: f.path });
      }
    }
    return out;
  }

  async rmdir(path: string): Promise<void> {
    const p = normalizePath(path);
    if (p === '/') throw new Error('cannot remove root');
    const entries = await this.readdir(p);
    if (entries.length) throw new Error('ENOTEMPTY: ' + p);
    await this.del(STORE_DIRS, p);
  }

  async listAllFiles(): Promise<FileMeta[]> {
    const files = await this.getAll<FileRecord>(STORE_FILES);
    return files.map((f) => ({ ...f.meta }));
  }

  async listAllDirs(): Promise<DirMeta[]> {
    return this.getAll<DirMeta>(STORE_DIRS);
  }
}
