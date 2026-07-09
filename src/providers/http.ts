// Minimal, self-contained HTTP abstraction so providers do not depend on DOM
// or Node-specific fetch typings, and so tests can inject a fake transport.

import { bytesToBase64 } from '../core/util';

export interface HttpHeaders {
  get(name: string): string | null;
}

export interface HttpResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: HttpHeaders;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  json(): Promise<unknown>;
}

export interface HttpRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}

export type FetchLike = (url: string, init?: HttpRequestInit) => Promise<HttpResponse>;

// Resolve a usable fetch implementation: injected first, else global fetch.
export function resolveFetch(f?: FetchLike): FetchLike {
  if (f) return f;
  const g = (globalThis as { fetch?: unknown }).fetch;
  if (typeof g === 'function') {
    return ((url: string, init?: HttpRequestInit) =>
      (g as (u: string, i?: unknown) => Promise<HttpResponse>)(url, init)) as FetchLike;
  }
  throw new Error('fs-sync: no global fetch available; pass options.fetch');
}

export function basicAuth(username: string, password: string): string {
  return 'Basic ' + bytesToBase64(new TextEncoder().encode(`${username}:${password}`));
}

// Percent-encode each path segment but preserve the slash separators.
export function encodePathSegments(path: string): string {
  return path
    .split('/')
    .map((seg) => (seg ? encodeURIComponent(seg) : ''))
    .join('/');
}

// Join a base URL with a path, collapsing duplicate slashes at the boundary.
export function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : '/' + path;
  return b + p;
}

// Strip surrounding quotes and a weak-validator ("W/") prefix from an ETag.
export function normalizeEtag(etag: string | null | undefined): string {
  if (!etag) return '';
  return etag.replace(/^W\//, '').replace(/^"(.*)"$/, '$1').trim();
}

export async function readBytes(res: HttpResponse): Promise<Uint8Array> {
  const ab = await res.arrayBuffer();
  return new Uint8Array(ab);
}
