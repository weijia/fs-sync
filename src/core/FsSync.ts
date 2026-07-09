import { Emitter } from './events';
import { MemoryStorage } from './MemoryStorage';
import { IndexedDbStorage } from './IndexedDbStorage';
import { MemoryBaselineStore, IndexedDbBaselineStore, type BaselineStore } from './BaselineStore';
import { createConflictResolver } from './ConflictResolver';
import { SyncEngine } from './SyncEngine';
import { ENOENT, EEXIST, EISDIR, FsError } from './errors';
import { normalizePath, dirname } from './path';
import { toUint8Array, decodeText, bytesToBase64, bytesToHex } from './util';
import type { StorageAdapter } from './StorageAdapter';
import type { SyncProvider } from '../providers/SyncProvider';
import type {
  FileMeta,
  DirMeta,
  ConflictResolver,
  Conflict,
  ConflictStrategy,
  SyncOptions,
  SyncResult,
  SyncState,
  SyncStatus,
  SyncTriggerOptions,
  FsSyncEvents,
  Logger,
  Binary,
} from './types';

export interface FsSyncOptions {
  root?: string;
  storage?: 'auto' | 'memory' | 'indexeddb' | StorageAdapter;
  providers?: SyncProvider[];
  conflictResolver?: ConflictStrategy | ConflictResolver;
  sync?: SyncOptions;
  logger?: Logger;
}

class Dirent {
  constructor(public name: string, public type: 'file' | 'dir') {}
  isFile(): boolean {
    return this.type === 'file';
  }
  isDirectory(): boolean {
    return this.type === 'dir';
  }
  isSymbolicLink(): boolean {
    return false;
  }
}

class Stats {
  constructor(private meta: FileMeta | DirMeta) {}
  get size(): number {
    return (this.meta as FileMeta).size ?? 0;
  }
  get mtimeMs(): number {
    return this.meta.mtime;
  }
  get birthtimeMs(): number {
    return this.meta.mtime;
  }
  isFile(): boolean {
    return this.meta.type === 'file';
  }
  isDirectory(): boolean {
    return this.meta.type === 'dir';
  }
  isSymbolicLink(): boolean {
    return false;
  }
}

// Top-level fs-compatible facade. Wraps a StorageAdapter (local cache) and a
// SyncEngine, exposing a Node-fs-like async API plus sync control + events.
export class FsSync {
  private storage!: StorageAdapter;
  private baselineStore!: BaselineStore;
  private engine!: SyncEngine;
  private resolver: ConflictResolver;
  private providers = new Map<string, SyncProvider>();
  private index = new Map<string, FileMeta | DirMeta>();
  private readyPromise: Promise<void> | null = null;
  private state: SyncState = 'idle';
  private lastSyncedAt: number | null = null;
  private emitter = new Emitter<FsSyncEvents>();
  private logger?: Logger;
  private syncOptions: SyncOptions;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private options: FsSyncOptions = {}) {
    this.logger = options.logger;
    this.resolver =
      typeof options.conflictResolver === 'string' || options.conflictResolver === undefined
        ? createConflictResolver(options.conflictResolver ?? 'lastWriteWins')
        : options.conflictResolver;
    this.syncOptions = options.sync ?? { mode: 'manual' };
  }

  async open(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = (async () => {
        const { storage, baseline } = await this.resolveStorage();
        this.storage = storage;
        this.baselineStore = baseline;
        await this.storage.open();
        await this.reindex();
        this.engine = new SyncEngine({
          storage: this.storage,
          baselineStore: this.baselineStore,
          conflictResolver: this.resolver,
          logger: this.logger,
          onConflict: (c) => this.emitter.emit('conflict', c),
          onProgress: (p) => this.emitter.emit('progress', p),
        });
        for (const p of this.options.providers ?? []) this.use(p);
        if (this.syncOptions.mode !== 'manual') this.startAutoSync();
      })().catch((e) => {
        this.readyPromise = null;
        throw e;
      });
    }
    return this.readyPromise;
  }

  private async ready(): Promise<void> {
    await this.open();
  }

  private async resolveStorage(): Promise<{ storage: StorageAdapter; baseline: BaselineStore }> {
    const s = this.options.storage ?? 'auto';
    if (typeof s !== 'string') {
      return { storage: s, baseline: new MemoryBaselineStore() };
    }
    if (s === 'memory') return { storage: new MemoryStorage(), baseline: new MemoryBaselineStore() };
    const isBrowser = typeof indexedDB !== 'undefined';
    if (s === 'indexeddb' || (s === 'auto' && isBrowser)) {
      return { storage: new IndexedDbStorage(), baseline: new IndexedDbBaselineStore() };
    }
    return { storage: new MemoryStorage(), baseline: new MemoryBaselineStore() };
  }

  private async reindex(): Promise<void> {
    this.index.clear();
    const files = await this.storage.listAllFiles();
    for (const f of files) this.index.set(f.path, f);
    const dirs = await this.storage.listAllDirs();
    for (const d of dirs) this.index.set(d.path, d);
    if (!this.index.has('/')) this.index.set('/', { path: '/', type: 'dir', mtime: Date.now() } as DirMeta);
  }

  // —— FS API ——

  async readFile(path: string, options?: { encoding?: string }): Promise<Uint8Array | string> {
    await this.ready();
    const p = normalizePath(path);
    const data = await this.storage.readFile(p);
    const meta = await this.storage.statFile(p);
    if (meta) this.index.set(p, meta);
    const enc = options?.encoding;
    if (enc && enc !== 'binary' && enc !== null) {
      if (enc === 'utf8' || enc === 'utf-8') return decodeText(data);
      if (enc === 'base64') return bytesToBase64(data);
      if (enc === 'hex') return bytesToHex(data);
      return decodeText(data);
    }
    return data;
  }

  async writeFile(
    path: string,
    data: Binary,
    options?: { encoding?: string; flag?: 'w' | 'a'; mtime?: number },
  ): Promise<void> {
    await this.ready();
    const p = normalizePath(path);
    let buf = toUint8Array(data);
    if (options?.flag === 'a') {
      const existing = await this.storage.readFile(p).catch(() => null);
      if (existing) {
        const merged = new Uint8Array(existing.length + buf.length);
        merged.set(existing, 0);
        merged.set(buf, existing.length);
        buf = merged;
      }
    }
    const meta = await this.storage.writeFile(p, buf, { mtime: options?.mtime });
    this.index.set(p, meta);
    const parent = dirname(p);
    if (!this.index.has(parent)) {
      this.index.set(parent, { path: parent, type: 'dir', mtime: Date.now() } as DirMeta);
    }
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await this.ready();
    const p = normalizePath(path);
    const parts = p.split('/').filter(Boolean);
    let cur = '';
    for (const part of parts) {
      cur += '/' + part;
      const entry = this.index.get(cur);
      if (entry) {
        if (entry.type === 'file') throw new EEXIST(cur);
        continue;
      }
      await this.storage.mkdir(cur);
      this.index.set(cur, { path: cur, type: 'dir', mtime: Date.now() } as DirMeta);
    }
  }

  async readdir(path: string, options?: { withFileTypes?: boolean }): Promise<string[] | Dirent[]> {
    await this.ready();
    const p = normalizePath(path);
    const entries = await this.storage.readdir(p);
    if (options?.withFileTypes) return entries.map((e) => new Dirent(e.name, e.type));
    return entries.map((e) => e.name);
  }

  async rmdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await this.ready();
    const p = normalizePath(path);
    if (p === '/') throw new FsError('EINVAL', 'cannot remove root');
    const entries = await this.storage.readdir(p);
    if (entries.length && !options?.recursive) throw new FsError('ENOTEMPTY', `directory not empty: ${p}`);
    if (options?.recursive) {
      await this.removeRecursive(p);
    } else {
      await this.storage.rmdir(p);
    }
    this.index.delete(p);
  }

  private async removeRecursive(dir: string): Promise<void> {
    const entries = await this.storage.readdir(dir);
    for (const e of entries) {
      if (e.type === 'dir') await this.removeRecursive(e.path);
      else await this.storage.markDeleted(e.path);
    }
    await this.storage.rmdir(dir);
  }

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    await this.ready();
    const p = normalizePath(path);
    const entry = this.index.get(p);
    if (!entry) {
      if (options?.force) return;
      throw new ENOENT(p);
    }
    if (entry.type === 'dir') await this.rmdir(p, { recursive: options?.recursive });
    else await this.unlink(p);
  }

  async unlink(path: string): Promise<void> {
    await this.ready();
    const p = normalizePath(path);
    const entry = this.index.get(p);
    if (!entry) throw new ENOENT(p);
    if (entry.type === 'dir') throw new EISDIR(p);
    await this.storage.markDeleted(p);
    this.index.delete(p);
  }

  async stat(path: string): Promise<Stats> {
    await this.ready();
    const p = normalizePath(path);
    const entry = this.index.get(p);
    if (!entry) throw new ENOENT(p);
    return new Stats(entry);
  }

  async exists(path: string): Promise<boolean> {
    await this.ready();
    return this.index.has(normalizePath(path));
  }

  existsSync(path: string): boolean {
    return this.index.has(normalizePath(path));
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.ready();
    const o = normalizePath(oldPath);
    const n = normalizePath(newPath);
    if (o === n) return;
    const entry = this.index.get(o);
    if (!entry) throw new ENOENT(o);
    if (entry.type === 'dir') await this.renameDir(o, n);
    else {
      const content = await this.storage.readFile(o);
      await this.storage.writeFile(n, content, { mtime: entry.mtime });
      await this.storage.markDeleted(o);
      this.index.delete(o);
      const meta = await this.storage.statFile(n);
      if (meta) this.index.set(n, meta);
    }
  }

  private async renameDir(o: string, n: string): Promise<void> {
    const files = await this.storage.listAllFiles();
    const dirs = await this.storage.listAllDirs();
    const prefix = o + '/';
    const movedDirs = dirs
      .filter((d) => d.path === o || d.path.startsWith(prefix))
      .sort((a, b) => a.path.length - b.path.length);
    const movedFiles = files.filter((f) => f.path === o || f.path.startsWith(prefix));
    for (const d of movedDirs) {
      const np = d.path === o ? n : n + d.path.slice(o.length);
      await this.storage.mkdir(np);
      this.index.set(np, { path: np, type: 'dir', mtime: Date.now() } as DirMeta);
    }
    for (const f of movedFiles) {
      const np = f.path === o ? n : n + f.path.slice(o.length);
      const content = await this.storage.readFile(f.path);
      await this.storage.writeFile(np, content, { mtime: f.mtime });
      await this.storage.markDeleted(f.path);
      const meta = await this.storage.statFile(np);
      if (meta) this.index.set(np, meta);
    }
    this.index.delete(o);
  }

  // —— Sync control ——

  use(provider: SyncProvider): void {
    this.providers.set(provider.name, provider);
  }

  unuse(name: string): void {
    this.providers.delete(name);
  }

  async syncNow(opts?: SyncTriggerOptions): Promise<SyncResult> {
    await this.ready();
    let targets: SyncProvider[];
    if (opts?.provider) {
      const p = this.providers.get(opts.provider);
      targets = p ? [p] : [];
    } else {
      targets = [...this.providers.values()];
    }
    const none: SyncResult = {
      ok: true,
      pushed: 0,
      pulled: 0,
      removed: 0,
      conflicts: 0,
      errors: 0,
      durationMs: 0,
      provider: '(none)',
    };
    if (!targets.length) {
      this.emitter.emit('synced', none);
      return none;
    }
    const combined: SyncResult = {
      ok: true,
      pushed: 0,
      pulled: 0,
      removed: 0,
      conflicts: 0,
      errors: 0,
      durationMs: 0,
      provider: targets.map((t) => t.name).join(','),
    };
    for (const prov of targets) {
      this.setState('detecting', prov.name);
      const res = await this.engine.sync(prov, { full: opts?.full, concurrency: opts?.concurrency });
      combined.ok = combined.ok && res.ok;
      combined.pushed += res.pushed;
      combined.pulled += res.pulled;
      combined.removed += res.removed;
      combined.conflicts += res.conflicts;
      combined.errors += res.errors;
      combined.durationMs += res.durationMs;
    }
    await this.reindex();
    this.lastSyncedAt = Date.now();
    this.setState('idle');
    this.emitter.emit('synced', combined);
    return combined;
  }

  status(): SyncStatus {
    return {
      state: this.state,
      pending: this.index.size,
      lastSyncedAt: this.lastSyncedAt,
      providerStates: {},
    };
  }

  on<E extends keyof FsSyncEvents>(event: E, cb: (payload: FsSyncEvents[E]) => void): () => void {
    return this.emitter.on(event, cb);
  }

  off<E extends keyof FsSyncEvents>(event: E, cb: (payload: FsSyncEvents[E]) => void): void {
    this.emitter.off(event, cb);
  }

  private setState(state: SyncState, _provider?: string): void {
    this.state = state;
    this.emitter.emit('statechange', state);
  }

  private startAutoSync(): void {
    const interval = this.syncOptions.intervalMs ?? 30000;
    this.intervalTimer = setInterval(() => {
      this.syncNow().catch((e) => this.logger?.error?.('auto sync failed', e));
    }, interval);
    if (typeof this.intervalTimer.unref === 'function') this.intervalTimer.unref();
  }
}

export function createFsSync(options?: FsSyncOptions): FsSync {
  return new FsSync(options);
}
