import type { FileMeta, RemoteMeta } from '../core/types';

export interface ListOptions {
  cursor?: string;
  limit?: number;
  signal?: AbortSignal;
}

// A sync target (WebDAV, GitHub, Gitee, RemoteStorage, ...). Third parties
// implement this interface to plug any fs-compatible remote into fs-sync.
export interface SyncProvider {
  readonly name: string;

  /** Authenticate / establish a session. Throw AuthError on failure. */
  authenticate(): Promise<void>;

  /** List remote metadata under a prefix (paginated). */
  list(prefix: string, opts?: ListOptions): Promise<RemoteMeta[]>;

  /** Pull remote content + metadata. */
  pull(path: string): Promise<{ content: Uint8Array; meta: RemoteMeta }>;

  /** Push local content + metadata to remote. Returns the resulting remote metadata. */
  push(path: string, content: Uint8Array, meta: FileMeta): Promise<RemoteMeta>;

  /** Delete a remote file. */
  remove(path: string): Promise<void>;

  /** Fetch a single remote metadata entry. */
  stat(path: string): Promise<RemoteMeta | null>;

  /** Declare capabilities that influence conflict detection. */
  capabilities?: { versioned?: boolean; etag?: boolean };
}
