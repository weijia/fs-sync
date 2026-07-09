import type { SyncProvider, ListOptions } from './SyncProvider';
import type { FileMeta, RemoteMeta } from '../core/types';
import { AuthError } from '../core/errors';
import { normalizePath, dirname } from '../core/path';
import {
  type FetchLike,
  resolveFetch,
  basicAuth,
  encodePathSegments,
  joinUrl,
  normalizeEtag,
  readBytes,
} from './http';

export interface WebDavProviderOptions {
  name?: string;
  /** WebDAV collection root, e.g. https://dav.example.com/remote.php/dav/files/user */
  baseUrl: string;
  username?: string;
  password?: string;
  /** Bearer token as an alternative to basic auth. */
  token?: string;
  headers?: Record<string, string>;
  fetch?: FetchLike;
}

// WebDAV sync target. Uses PROPFIND/GET/PUT/DELETE/MKCOL. Works against
// Nextcloud, ownCloud, 坚果云, Apache mod_dav, etc.
export class WebDavProvider implements SyncProvider {
  readonly name: string;
  capabilities = { versioned: false, etag: true };
  private fetch: FetchLike;
  private baseUrl: string;
  private basePathname: string;

  constructor(private options: WebDavProviderOptions) {
    this.name = options.name ?? 'webdav';
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetch = resolveFetch(options.fetch);
    try {
      this.basePathname = new URL(this.baseUrl).pathname.replace(/\/+$/, '');
    } catch {
      // baseUrl without a scheme (used by some fakes) — treat whole thing as prefix.
      this.basePathname = '';
    }
  }

  private authHeaders(): Record<string, string> {
    const h: Record<string, string> = { ...(this.options.headers ?? {}) };
    if (this.options.token) h['Authorization'] = `Bearer ${this.options.token}`;
    else if (this.options.username != null)
      h['Authorization'] = basicAuth(this.options.username, this.options.password ?? '');
    return h;
  }

  private urlFor(path: string): string {
    return joinUrl(this.baseUrl, encodePathSegments(normalizePath(path)));
  }

  // Convert an href from a PROPFIND response into a logical (root-relative) path.
  private hrefToPath(href: string): string {
    let pathname = href;
    try {
      pathname = new URL(href, this.baseUrl).pathname;
    } catch {
      /* href is already a path */
    }
    let decoded = pathname;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      /* leave as-is */
    }
    if (this.basePathname && decoded.startsWith(this.basePathname)) {
      decoded = decoded.slice(this.basePathname.length);
    }
    return normalizePath(decoded);
  }

  async authenticate(): Promise<void> {
    const res = await this.fetch(this.urlFor('/'), {
      method: 'PROPFIND',
      headers: { ...this.authHeaders(), Depth: '0' },
    });
    if (res.status === 401 || res.status === 403) {
      throw new AuthError(`WebDAV auth failed (${res.status})`);
    }
    // 207 Multi-Status, 200, or even 404 (empty root) are acceptable.
    if (res.status >= 500) {
      throw new Error(`WebDAV authenticate failed: ${res.status} ${res.statusText}`);
    }
  }

  async list(prefix: string, _opts?: ListOptions): Promise<RemoteMeta[]> {
    const p = normalizePath(prefix);
    const res = await this.fetch(this.urlFor(p), {
      method: 'PROPFIND',
      headers: { ...this.authHeaders(), Depth: 'infinity' },
    });
    if (res.status === 404) return [];
    if (!res.ok && res.status !== 207) {
      throw new Error(`WebDAV list failed: ${res.status} ${res.statusText}`);
    }
    const xml = await res.text();
    const entries = this.parsePropfind(xml);
    // Only files (collections are represented implicitly by their children).
    return entries.filter((e) => !e.isCollection).map((e) => e.meta);
  }

  async pull(path: string): Promise<{ content: Uint8Array; meta: RemoteMeta }> {
    const p = normalizePath(path);
    const res = await this.fetch(this.urlFor(p), {
      method: 'GET',
      headers: this.authHeaders(),
    });
    if (!res.ok) throw new Error(`WebDAV pull failed: ${res.status} ${res.statusText}`);
    const content = await readBytes(res);
    const etag = normalizeEtag(res.headers.get('etag'));
    const lm = res.headers.get('last-modified');
    const meta: RemoteMeta = {
      path: p,
      size: content.length,
      mtime: lm ? Date.parse(lm) || 0 : 0,
      etag: etag || undefined,
    };
    return { content, meta };
  }

  async push(path: string, content: Uint8Array, meta: FileMeta): Promise<RemoteMeta> {
    const p = normalizePath(path);
    await this.ensureParents(p);
    const res = await this.fetch(this.urlFor(p), {
      method: 'PUT',
      headers: { ...this.authHeaders(), 'Content-Type': 'application/octet-stream' },
      body: content,
    });
    if (!res.ok && res.status !== 201 && res.status !== 204) {
      throw new Error(`WebDAV push failed: ${res.status} ${res.statusText}`);
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
    const res = await this.fetch(this.urlFor(p), {
      method: 'DELETE',
      headers: this.authHeaders(),
    });
    if (!res.ok && res.status !== 404 && res.status !== 204) {
      throw new Error(`WebDAV remove failed: ${res.status} ${res.statusText}`);
    }
  }

  async stat(path: string): Promise<RemoteMeta | null> {
    const p = normalizePath(path);
    const res = await this.fetch(this.urlFor(p), {
      method: 'PROPFIND',
      headers: { ...this.authHeaders(), Depth: '0' },
    });
    if (res.status === 404) return null;
    if (!res.ok && res.status !== 207) {
      throw new Error(`WebDAV stat failed: ${res.status} ${res.statusText}`);
    }
    const xml = await res.text();
    const entries = this.parsePropfind(xml);
    const found = entries.find((e) => e.meta.path === p) ?? entries.find((e) => !e.isCollection);
    return found ? found.meta : null;
  }

  private async ensureParents(path: string): Promise<void> {
    const dir = dirname(path);
    if (dir === '/' || dir === '') return;
    const parts = dir.split('/').filter(Boolean);
    let cur = '';
    for (const part of parts) {
      cur += '/' + part;
      const res = await this.fetch(this.urlFor(cur), {
        method: 'MKCOL',
        headers: this.authHeaders(),
      });
      // 201 created, 405 already exists, 409 handled by ordering — all tolerable.
      if (res.status >= 500) {
        throw new Error(`WebDAV MKCOL failed: ${res.status} ${res.statusText}`);
      }
    }
  }

  // Namespace-agnostic PROPFIND parser (avoids a heavy XML dependency).
  private parsePropfind(xml: string): { meta: RemoteMeta; isCollection: boolean }[] {
    const out: { meta: RemoteMeta; isCollection: boolean }[] = [];
    const responseRe = /<([a-z0-9]+:)?response[\s>][\s\S]*?<\/([a-z0-9]+:)?response>/gi;
    const matches = xml.match(responseRe) ?? [];
    for (const block of matches) {
      const href = this.tag(block, 'href');
      if (href == null) continue;
      const path = this.hrefToPath(href);
      const isCollection =
        /<([a-z0-9]+:)?collection\s*\/?>/i.test(block) ||
        /<([a-z0-9]+:)?resourcetype>\s*<([a-z0-9]+:)?collection/i.test(block);
      const lenStr = this.tag(block, 'getcontentlength');
      const lm = this.tag(block, 'getlastmodified');
      const etag = normalizeEtag(this.tag(block, 'getetag'));
      out.push({
        isCollection,
        meta: {
          path,
          size: lenStr ? parseInt(lenStr, 10) || 0 : 0,
          mtime: lm ? Date.parse(lm) || 0 : 0,
          etag: etag || undefined,
        },
      });
    }
    return out;
  }

  private tag(block: string, name: string): string | null {
    const re = new RegExp(`<([a-z0-9]+:)?${name}[^>]*>([\\s\\S]*?)<\\/([a-z0-9]+:)?${name}>`, 'i');
    const m = block.match(re);
    if (!m) {
      // self-closing / empty element
      const empty = new RegExp(`<([a-z0-9]+:)?${name}\\s*/>`, 'i');
      return empty.test(block) ? '' : null;
    }
    return m[2].trim();
  }
}
