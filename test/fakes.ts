// In-memory fake HTTP servers implementing each remote protocol, used to test
// the real providers end-to-end without network access.

import type { FetchLike, HttpResponse, HttpRequestInit } from '../src/providers/http';
import { contentHash } from '../src/core/hash';
import { normalizePath } from '../src/core/path';

const enc = new TextEncoder();
const dec = new TextDecoder();

export function makeResponse(
  status: number,
  opts: { body?: string | Uint8Array; headers?: Record<string, string> } = {},
): HttpResponse {
  const headers = new Map(
    Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v] as const),
  );
  const body = opts.body ?? '';
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null },
    async text() {
      return typeof body === 'string' ? body : dec.decode(body);
    },
    async arrayBuffer() {
      const b = typeof body === 'string' ? enc.encode(body) : body;
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    },
    async json() {
      return JSON.parse(typeof body === 'string' ? body : dec.decode(body));
    },
  };
}

function bodyToBytes(body: string | Uint8Array | undefined): Uint8Array {
  if (body == null) return new Uint8Array(0);
  return typeof body === 'string' ? enc.encode(body) : body;
}

// ————————————————————————————————— WebDAV —————————————————————————————————

export function webdavServer(base = 'http://dav.test/dav') {
  const basePath = new URL(base).pathname.replace(/\/+$/, '');
  const files = new Map<string, { content: Uint8Array; mtime: number }>();

  function pathOf(url: string): string {
    let p = decodeURIComponent(new URL(url).pathname);
    if (p.startsWith(basePath)) p = p.slice(basePath.length);
    return normalizePath(p);
  }
  function fileXml(path: string, content: Uint8Array, mtime: number): string {
    return (
      `<d:response><d:href>${basePath}${path.split('/').map(encodeURIComponent).join('/')}</d:href>` +
      `<d:propstat><d:prop>` +
      `<d:getcontentlength>${content.length}</d:getcontentlength>` +
      `<d:getlastmodified>${new Date(mtime).toUTCString()}</d:getlastmodified>` +
      `<d:getetag>"${contentHash(content)}"</d:getetag>` +
      `<d:resourcetype/>` +
      `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
    );
  }
  function collXml(path: string): string {
    return (
      `<d:response><d:href>${basePath}${path}</d:href>` +
      `<d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>` +
      `<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
    );
  }
  function multistatus(inner: string): HttpResponse {
    return makeResponse(207, {
      body: `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${inner}</d:multistatus>`,
      headers: { 'content-type': 'application/xml' },
    });
  }

  const fetch: FetchLike = async (url, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = pathOf(url);
    if (method === 'PROPFIND') {
      const depth = init?.headers?.['Depth'] ?? init?.headers?.['depth'] ?? '0';
      if (files.has(path)) {
        const f = files.get(path)!;
        return multistatus(fileXml(path, f.content, f.mtime));
      }
      // treat as collection
      const prefix = path === '/' ? '/' : path + '/';
      const children = [...files.entries()].filter(
        ([p]) => path === '/' || p.startsWith(prefix),
      );
      if (path !== '/' && children.length === 0) return makeResponse(404);
      let inner = collXml(path);
      if (depth !== '0') {
        for (const [p, f] of children) inner += fileXml(p, f.content, f.mtime);
      }
      return multistatus(inner);
    }
    if (method === 'GET') {
      const f = files.get(path);
      if (!f) return makeResponse(404);
      return makeResponse(200, {
        body: f.content,
        headers: {
          etag: `"${contentHash(f.content)}"`,
          'last-modified': new Date(f.mtime).toUTCString(),
        },
      });
    }
    if (method === 'PUT') {
      const content = bodyToBytes(init?.body);
      files.set(path, { content, mtime: Date.now() });
      return makeResponse(201, { headers: { etag: `"${contentHash(content)}"` } });
    }
    if (method === 'DELETE') {
      files.delete(path);
      return makeResponse(204);
    }
    if (method === 'MKCOL') {
      return makeResponse(201);
    }
    return makeResponse(405);
  };

  return { fetch, files, base };
}

// ———————————————————————— GitHub / Gitee (Contents API) ————————————————————————

export function gitServer(apiBase: string, owner = 'me', repo = 'notes', branch = 'main') {
  // keyed by repo path (no leading slash)
  const files = new Map<string, { content: Uint8Array; sha: string }>();
  const shaOf = (c: Uint8Array) => contentHash(c) + '-' + c.length.toString(16);
  // apiBase may carry a path prefix (e.g. Gitee's /api/v5) that must be stripped.
  const apiPrefix = new URL(apiBase).pathname.replace(/\/+$/, '');

  function contentsPath(pathname: string): string | null {
    const prefix = `/repos/${owner}/${repo}/contents/`;
    if (!pathname.startsWith(prefix)) return null;
    return pathname.slice(prefix.length).split('/').map(decodeURIComponent).join('/');
  }

  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url.startsWith('http') ? url : 'http://x' + url);
    let pathname = u.pathname;
    if (apiPrefix && pathname.startsWith(apiPrefix)) pathname = pathname.slice(apiPrefix.length);
    const method = (init?.method ?? 'GET').toUpperCase();

    if (pathname === `/repos/${owner}/${repo}` && method === 'GET') {
      return makeResponse(200, { body: JSON.stringify({ full_name: `${owner}/${repo}` }) });
    }

    if (pathname === `/repos/${owner}/${repo}/git/trees/${branch}` && method === 'GET') {
      const tree = [...files.entries()].map(([p, f]) => ({
        path: p,
        type: 'blob',
        sha: f.sha,
        size: f.content.length,
      }));
      return makeResponse(200, { body: JSON.stringify({ sha: 'root', tree }) });
    }

    const rp = contentsPath(pathname);
    if (rp != null) {
      if (method === 'GET') {
        const f = files.get(rp);
        if (!f) return makeResponse(404, { body: JSON.stringify({ message: 'Not Found' }) });
        return makeResponse(200, {
          body: JSON.stringify({
            type: 'file',
            content: Buffer.from(f.content).toString('base64'),
            encoding: 'base64',
            sha: f.sha,
            size: f.content.length,
          }),
        });
      }
      if (method === 'PUT') {
        const payload = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
        const content = new Uint8Array(Buffer.from(payload.content, 'base64'));
        const sha = shaOf(content);
        files.set(rp, { content, sha });
        return makeResponse(200, {
          body: JSON.stringify({ content: { path: rp, sha, size: content.length } }),
        });
      }
      if (method === 'DELETE') {
        files.delete(rp);
        return makeResponse(200, { body: JSON.stringify({ commit: {} }) });
      }
    }
    return makeResponse(404, { body: JSON.stringify({ message: 'Not Found' }) });
  };

  return { fetch, files, apiBase, owner, repo, branch };
}

// ———————————————————————————— remoteStorage ————————————————————————————

export function remoteStorageServer(base = 'http://rs.test/storage') {
  const basePath = new URL(base).pathname.replace(/\/+$/, '');
  const files = new Map<string, { content: Uint8Array; mtime: number }>();

  function pathOf(url: string): string {
    let p = decodeURIComponent(new URL(url).pathname);
    if (p.startsWith(basePath)) p = p.slice(basePath.length);
    if (!p.startsWith('/')) p = '/' + p;
    return p;
  }
  function folderListing(folder: string): string {
    // folder is like "/" or "/sub/"
    const items: Record<string, unknown> = {};
    const seenDirs = new Set<string>();
    for (const [p, f] of files) {
      if (!p.startsWith(folder)) continue;
      const rest = p.slice(folder.length);
      if (rest === '') continue;
      const slash = rest.indexOf('/');
      if (slash === -1) {
        items[rest] = {
          ETag: `"${contentHash(f.content)}"`,
          'Content-Length': f.content.length,
          'Last-Modified': f.mtime,
        };
      } else {
        const dir = rest.slice(0, slash + 1);
        if (!seenDirs.has(dir)) {
          seenDirs.add(dir);
          items[dir] = { ETag: `"dir-${dir}"` };
        }
      }
    }
    return JSON.stringify({ '@context': 'http://remotestorage.io/spec/folder-description', items });
  }

  const fetch: FetchLike = async (url, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = pathOf(url);
    if (path.endsWith('/') && method === 'GET') {
      return makeResponse(200, {
        body: folderListing(path),
        headers: { 'content-type': 'application/ld+json' },
      });
    }
    if (method === 'GET') {
      const f = files.get(path);
      if (!f) return makeResponse(404);
      return makeResponse(200, {
        body: f.content,
        headers: {
          etag: `"${contentHash(f.content)}"`,
          'last-modified': new Date(f.mtime).toUTCString(),
        },
      });
    }
    if (method === 'PUT') {
      const content = bodyToBytes(init?.body);
      files.set(path, { content, mtime: Date.now() });
      return makeResponse(200, { headers: { etag: `"${contentHash(content)}"` } });
    }
    if (method === 'DELETE') {
      files.delete(path);
      return makeResponse(200);
    }
    return makeResponse(405);
  };

  return { fetch, files, base };
}
