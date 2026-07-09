import type { Binary } from './types';

export function toUint8Array(data: Binary): Uint8Array {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  // Node Buffer (structural cast avoids global typing conflicts)
  const buf = data as unknown as { buffer: ArrayBufferLike; byteOffset: number; byteLength: number };
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa !== 'undefined') {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  return Buffer.from(bytes).toString('base64');
}

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/\s+/g, '');
  if (typeof atob !== 'undefined') {
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(clean, 'base64'));
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function decodeText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  async function worker(): Promise<void> {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  const n = Math.max(1, Math.min(concurrency || 1, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}
