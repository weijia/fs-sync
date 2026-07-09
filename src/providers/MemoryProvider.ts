import type { SyncProvider, ListOptions } from './SyncProvider';
import type { FileMeta, RemoteMeta } from '../core/types';
import { contentHash } from '../core/hash';
import { normalizePath } from '../core/path';

interface RemoteRecord {
  content: Uint8Array;
  meta: RemoteMeta;
}

// In-memory SyncProvider used for tests and as a reference implementation.
// etag is derived from content so it is comparable to local contentHash.
export class MemoryProvider implements SyncProvider {
  readonly name: string;
  capabilities = { versioned: true, etag: true };
  private store = new Map<string, RemoteRecord>();

  constructor(name = 'memory') {
    this.name = name;
  }

  async authenticate(): Promise<void> {
    /* no-op */
  }

  async list(prefix: string): Promise<RemoteMeta[]> {
    const p = normalizePath(prefix);
    const out: RemoteMeta[] = [];
    for (const [path, rec] of this.store) {
      if (p === '/' || path.startsWith(p)) out.push({ ...rec.meta });
    }
    return out;
  }

  async pull(path: string): Promise<{ content: Uint8Array; meta: RemoteMeta }> {
    const p = normalizePath(path);
    const rec = this.store.get(p);
    if (!rec) throw new Error('ENOENT remote ' + p);
    return { content: rec.content.slice(), meta: { ...rec.meta } };
  }

  async push(path: string, content: Uint8Array, meta: FileMeta): Promise<RemoteMeta> {
    const p = normalizePath(path);
    const prev = this.store.get(p);
    const version = (prev?.meta.version ?? 0) + 1;
    const remoteMeta: RemoteMeta = {
      path: p,
      size: content.length,
      mtime: meta.mtime,
      etag: contentHash(content),
      version,
    };
    this.store.set(p, { content: content.slice(), meta: remoteMeta });
    return remoteMeta;
  }

  async remove(path: string): Promise<void> {
    this.store.delete(normalizePath(path));
  }

  async stat(path: string): Promise<RemoteMeta | null> {
    const rec = this.store.get(normalizePath(path));
    return rec ? { ...rec.meta } : null;
  }
}
