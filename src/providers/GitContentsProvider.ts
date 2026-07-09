import type { SyncProvider, ListOptions } from './SyncProvider';
import type { FileMeta, RemoteMeta } from '../core/types';
import { AuthError } from '../core/errors';
import { normalizePath } from '../core/path';
import { base64ToBytes, bytesToBase64 } from '../core/util';
import { type FetchLike, resolveFetch } from './http';

export interface GitContentsOptions {
  name?: string;
  owner: string;
  repo: string;
  token: string;
  branch?: string;
  /** Subdirectory in the repo to treat as the sync root, e.g. "docs". */
  basePath?: string;
  /** Commit message template; `{path}` is substituted. */
  commitMessage?: string;
  apiBase?: string;
  fetch?: FetchLike;
}

interface TreeEntry {
  path: string;
  type: 'blob' | 'tree' | string;
  sha: string;
  size?: number;
}

interface ContentsResponse {
  content?: string;
  encoding?: string;
  sha?: string;
  size?: number;
  type?: string;
}

// Shared implementation for GitHub-style "Contents API" backends (GitHub & Gitee).
// Subclasses only customize the API base and how credentials are applied.
export abstract class GitContentsProvider implements SyncProvider {
  readonly name: string;
  capabilities = { versioned: true, etag: true };
  protected fetch: FetchLike;
  protected owner: string;
  protected repo: string;
  protected token: string;
  protected branch: string;
  protected basePath: string;
  protected abstract apiBase: string;

  constructor(opts: GitContentsOptions, defaultName: string) {
    this.name = opts.name ?? defaultName;
    this.owner = opts.owner;
    this.repo = opts.repo;
    this.token = opts.token;
    this.branch = opts.branch ?? 'main';
    this.basePath = (opts.basePath ?? '').replace(/^\/+|\/+$/g, '');
    this.commitMessageTpl = opts.commitMessage ?? 'fs-sync: update {path}';
    this.fetch = resolveFetch(opts.fetch);
  }

  protected commitMessageTpl: string;

  // —— hooks for subclasses ——
  /** Extra headers (e.g. Authorization for GitHub). */
  protected abstract authHeaders(): Record<string, string>;
  /** Append auth query params (e.g. access_token for Gitee). */
  protected abstract authQuery(): Record<string, string>;

  private repoPath(path: string): string {
    const p = normalizePath(path).replace(/^\/+/, '');
    return this.basePath ? `${this.basePath}/${p}` : p;
  }

  private logicalPath(repoPath: string): string {
    let p = repoPath;
    if (this.basePath && p.startsWith(this.basePath + '/')) p = p.slice(this.basePath.length + 1);
    else if (this.basePath && p === this.basePath) p = '';
    return normalizePath(p);
  }

  private url(pathname: string, query: Record<string, string> = {}): string {
    const q = { ...query, ...this.authQuery() };
    const qs = Object.entries(q)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    const base = `${this.apiBase}${pathname}`;
    return qs ? `${base}${base.includes('?') ? '&' : '?'}${qs}` : base;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Accept: 'application/json', 'User-Agent': 'fs-sync', ...this.authHeaders(), ...extra };
  }

  private encodeRepoPath(repoPath: string): string {
    return repoPath.split('/').map(encodeURIComponent).join('/');
  }

  async authenticate(): Promise<void> {
    const res = await this.fetch(this.url(`/repos/${this.owner}/${this.repo}`), {
      method: 'GET',
      headers: this.headers(),
    });
    if (res.status === 401 || res.status === 403) {
      throw new AuthError(`${this.name} auth failed (${res.status})`);
    }
    if (!res.ok) {
      throw new Error(`${this.name} authenticate failed: ${res.status} ${res.statusText}`);
    }
  }

  async list(_prefix: string, _opts?: ListOptions): Promise<RemoteMeta[]> {
    const res = await this.fetch(
      this.url(`/repos/${this.owner}/${this.repo}/git/trees/${encodeURIComponent(this.branch)}`, {
        recursive: '1',
      }),
      { method: 'GET', headers: this.headers() },
    );
    if (res.status === 404 || res.status === 409) return []; // empty repo / no branch yet
    if (!res.ok) throw new Error(`${this.name} list failed: ${res.status} ${res.statusText}`);
    const body = (await res.json()) as { tree?: TreeEntry[] };
    const tree = body.tree ?? [];
    const out: RemoteMeta[] = [];
    for (const e of tree) {
      if (e.type !== 'blob') continue;
      if (this.basePath && !(e.path === this.basePath || e.path.startsWith(this.basePath + '/'))) {
        continue;
      }
      out.push({
        path: this.logicalPath(e.path),
        size: e.size ?? 0,
        mtime: 0, // trees API carries no timestamp; irrelevant for change detection
        etag: e.sha,
        version: undefined,
      });
    }
    return out;
  }

  async pull(path: string): Promise<{ content: Uint8Array; meta: RemoteMeta }> {
    const p = normalizePath(path);
    const res = await this.fetch(
      this.url(`/repos/${this.owner}/${this.repo}/contents/${this.encodeRepoPath(this.repoPath(p))}`, {
        ref: this.branch,
      }),
      { method: 'GET', headers: this.headers() },
    );
    if (!res.ok) throw new Error(`${this.name} pull failed: ${res.status} ${res.statusText}`);
    const body = (await res.json()) as ContentsResponse;
    let content: Uint8Array;
    if (body.content != null && (body.encoding === 'base64' || body.encoding == null)) {
      content = base64ToBytes(body.content);
    } else if (body.sha) {
      content = await this.pullBlob(body.sha);
    } else {
      content = new Uint8Array(0);
    }
    return {
      content,
      meta: { path: p, size: body.size ?? content.length, mtime: 0, etag: body.sha },
    };
  }

  private async pullBlob(sha: string): Promise<Uint8Array> {
    const res = await this.fetch(this.url(`/repos/${this.owner}/${this.repo}/git/blobs/${sha}`), {
      method: 'GET',
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`${this.name} blob fetch failed: ${res.status}`);
    const body = (await res.json()) as ContentsResponse;
    return body.content ? base64ToBytes(body.content) : new Uint8Array(0);
  }

  async push(path: string, content: Uint8Array, meta: FileMeta): Promise<RemoteMeta> {
    const p = normalizePath(path);
    const existing = await this.stat(p);
    const payload: Record<string, unknown> = {
      message: this.commitMessageTpl.replace('{path}', p),
      content: bytesToBase64(content),
      branch: this.branch,
    };
    if (existing?.etag) payload.sha = existing.etag;
    const res = await this.fetch(
      this.url(`/repos/${this.owner}/${this.repo}/contents/${this.encodeRepoPath(this.repoPath(p))}`),
      {
        method: 'PUT',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload),
      },
    );
    if (!res.ok && res.status !== 200 && res.status !== 201) {
      throw new Error(`${this.name} push failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as { content?: ContentsResponse };
    const sha = body.content?.sha ?? '';
    return { path: p, size: content.length, mtime: meta.mtime, etag: sha || undefined };
  }

  async remove(path: string): Promise<void> {
    const p = normalizePath(path);
    const existing = await this.stat(p);
    if (!existing?.etag) return; // already gone
    const res = await this.fetch(
      this.url(`/repos/${this.owner}/${this.repo}/contents/${this.encodeRepoPath(this.repoPath(p))}`),
      {
        method: 'DELETE',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          message: this.commitMessageTpl.replace('{path}', p),
          sha: existing.etag,
          branch: this.branch,
        }),
      },
    );
    if (!res.ok && res.status !== 200) {
      throw new Error(`${this.name} remove failed: ${res.status} ${res.statusText}`);
    }
  }

  async stat(path: string): Promise<RemoteMeta | null> {
    const p = normalizePath(path);
    const res = await this.fetch(
      this.url(`/repos/${this.owner}/${this.repo}/contents/${this.encodeRepoPath(this.repoPath(p))}`, {
        ref: this.branch,
      }),
      { method: 'GET', headers: this.headers() },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${this.name} stat failed: ${res.status} ${res.statusText}`);
    const body = (await res.json()) as ContentsResponse;
    if (Array.isArray(body)) return null; // a directory
    return { path: p, size: body.size ?? 0, mtime: 0, etag: body.sha };
  }
}
