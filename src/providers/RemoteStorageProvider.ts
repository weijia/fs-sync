import type { SyncProvider, ListOptions } from './SyncProvider';
import type { FileMeta, RemoteMeta } from '../core/types';
import { AuthError } from '../core/errors';
import { normalizePath, dirname, basename } from '../core/path';
import {
  type FetchLike,
  resolveFetch,
  encodePathSegments,
  joinUrl,
  normalizeEtag,
  readBytes,
} from './http';

export interface RemoteStorageProviderOptions {
  name?: string;
  /** Storage root URL (the base for the user's storage). */
  baseUrl: string;
  /** Bearer token (OAuth). */
  token?: string;
  headers?: Record<string, string>;
  fetch?: FetchLike;
}

interface FolderItem {
  ETag?: string;
  'Content-Length'?: number;
  'Content-Type'?: string;
  'Last-Modified'?: number | string;
}

interface FolderListing {
  items?: Record<string, FolderItem>;
}

// remoteStorage protocol sync target (per Unhosted/remoteStorage spec).
// Folders are GET requests on paths ending in "/", returning a JSON listing;
// documents are plain GET/PUT/DELETE with ETag-based optimistic concurrency.
export class RemoteStorageProvider implements SyncProvider {
  readonly name: string;
  capabilities = { versioned: false, etag: true };
  private fetch: FetchLike;
  private baseUrl: string;

  constructor(private options: RemoteStorageProviderOptions) {
    this.name = options.name ?? 'remotestorage';
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetch = resolveFetch(options.fetch);
  }

  private authHeaders(): Record<string, string> {
    const h: Record<string, string> = { ...(this.options.headers ?? {}) };
    if (this.options.token) h['Authorization'] = `Bearer ${this.options.token}`;
    return h;
  }

  private urlFor(path: string): string {
    return joinUrl(this.baseUrl, encodePathSegments(path));
  }

  async authenticate(): Promise<void> {
    const res = await this.fetch(this.urlFor('/'), { method: 'GET', headers: this.authHeaders() });
    if (res.status === 401 || res.status === 403) {
      throw new AuthError(`remoteStorage auth failed (${res.status})`);
    }
    if (res.status >= 500) {
      throw new Error(`remoteStorage authenticate failed: ${res.status} ${res.statusText}`);
    }
  }

  async list(prefix: string, _opts?: ListOptions): Promise<RemoteMeta[]> {
    const start = normalizePath(prefix);
    const out: RemoteMeta[] = [];
    await this.walk(start === '/' ? '/' : start + '/', out);
    return out;
  }

  private async walk(folder: string, out: RemoteMeta[]): Promise<void> {
    const listing = await this.readFolder(folder);
    if (!listing) return;
    const items = listing.items ?? {};
    for (const [name, info] of Object.entries(items)) {
      if (name.endsWith('/')) {
        await this.walk(folder + name, out);
      } else {
        const path = normalizePath(folder + name);
        out.push({
          path,
          size: info['Content-Length'] ?? 0,
          mtime: this.toMtime(info['Last-Modified']),
          etag: normalizeEtag(info.ETag) || undefined,
        });
      }
    }
  }

  private async readFolder(folder: string): Promise<FolderListing | null> {
    // Folder requests must target a path ending in "/".
    const url = this.urlFor(folder.endsWith('/') ? folder : folder + '/');
    const res = await this.fetch(url, {
      method: 'GET',
      headers: { ...this.authHeaders(), Accept: 'application/ld+json' },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`remoteStorage list failed: ${res.status} ${res.statusText}`);
    const body = (await res.json()) as FolderListing;
    return body ?? { items: {} };
  }

  private toMtime(lm: number | string | undefined): number {
    if (lm == null) return 0;
    if (typeof lm === 'number') return lm;
    return Date.parse(lm) || 0;
  }

  async pull(path: string): Promise<{ content: Uint8Array; meta: RemoteMeta }> {
    const p = normalizePath(path);
    const res = await this.fetch(this.urlFor(p), { method: 'GET', headers: this.authHeaders() });
    if (!res.ok) throw new Error(`remoteStorage pull failed: ${res.status} ${res.statusText}`);
    const content = await readBytes(res);
    const lm = res.headers.get('last-modified');
    return {
      content,
      meta: {
        path: p,
        size: content.length,
        mtime: lm ? Date.parse(lm) || 0 : 0,
        etag: normalizeEtag(res.headers.get('etag')) || undefined,
      },
    };
  }

  async push(path: string, content: Uint8Array, meta: FileMeta): Promise<RemoteMeta> {
    const p = normalizePath(path);
    const res = await this.fetch(this.urlFor(p), {
      method: 'PUT',
      headers: { ...this.authHeaders(), 'Content-Type': 'application/octet-stream' },
      body: content,
    });
    if (!res.ok && res.status !== 200 && res.status !== 201) {
      throw new Error(`remoteStorage push failed: ${res.status} ${res.statusText}`);
    }
    let etag = normalizeEtag(res.headers.get('etag'));
    if (!etag) {
      const s = await this.stat(p);
      etag = s?.etag ?? '';
    }
    return { path: p, size: content.length, mtime: meta.mtime, etag: etag || undefined };
  }

  async remove(path: string): Promise<void> {
    const p = normalizePath(path);
    const res = await this.fetch(this.urlFor(p), { method: 'DELETE', headers: this.authHeaders() });
    if (!res.ok && res.status !== 404 && res.status !== 200 && res.status !== 204) {
      throw new Error(`remoteStorage remove failed: ${res.status} ${res.statusText}`);
    }
  }

  async stat(path: string): Promise<RemoteMeta | null> {
    const p = normalizePath(path);
    const parent = dirname(p);
    const name = basename(p);
    const listing = await this.readFolder(parent === '/' ? '/' : parent + '/');
    if (!listing) return null;
    const info = (listing.items ?? {})[name];
    if (!info) return null;
    return {
      path: p,
      size: info['Content-Length'] ?? 0,
      mtime: this.toMtime(info['Last-Modified']),
      etag: normalizeEtag(info.ETag) || undefined,
    };
  }
}
