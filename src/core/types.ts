// Core type definitions for fs-sync.

export type Binary = Uint8Array | Buffer | ArrayBuffer | string;

export interface FileMeta {
  path: string;
  type: 'file';
  size: number;
  mtime: number; // epoch ms
  contentHash: string;
  version: number; // local monotonic version
  deleted: boolean; // tombstone marker for sync
}

export interface DirMeta {
  path: string;
  type: 'dir';
  mtime: number;
}

export type MetaEntry = FileMeta | DirMeta;

export interface RemoteMeta {
  path: string;
  size: number;
  mtime: number;
  etag?: string;
  version?: number;
}

export type ConflictStrategy =
  | 'lastWriteWins'
  | 'keepLocal'
  | 'keepRemote'
  | 'manual'
  | 'threeWayMerge';

export interface Conflict {
  path: string;
  local: FileMeta;
  remote: RemoteMeta;
  base?: BaselineEntry | null;
  localData?: Uint8Array;
  remoteData?: Uint8Array;
  baseData?: Uint8Array | null;
}

export type ConflictAction = 'local' | 'remote' | 'merge' | 'skip';

export interface ConflictResolution {
  action: ConflictAction;
  mergedContent?: Uint8Array;
  keepLosersCopy?: boolean;
}

export interface ConflictResolver {
  resolve(conflict: Conflict): Promise<ConflictResolution> | ConflictResolution;
}

export interface WriteOptions {
  mtime?: number;
  source?: 'local' | 'sync';
}

export interface SyncOptions {
  mode: 'manual' | 'auto' | 'interval';
  intervalMs?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  concurrency?: number;
}

export interface SyncResult {
  ok: boolean;
  pushed: number;
  pulled: number;
  removed: number;
  conflicts: number;
  errors: number;
  durationMs: number;
  provider: string;
}

export type SyncState =
  | 'idle'
  | 'detecting'
  | 'pushing'
  | 'pulling'
  | 'resolving'
  | 'conflict'
  | 'finalizing'
  | 'error';

export type SyncPhase = 'detect' | 'push' | 'pull' | 'resolve' | 'finalize';

export interface SyncStatus {
  state: SyncState;
  pending: number;
  lastSyncedAt: number | null;
  providerStates: Record<string, SyncState>;
}

export interface SyncTriggerOptions {
  provider?: string;
  full?: boolean;
  signal?: AbortSignal;
  concurrency?: number;
}

export interface Logger {
  debug?(...args: unknown[]): void;
  info?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
  error?(...args: unknown[]): void;
}

export interface FsSyncEvents {
  statechange: SyncState;
  progress: { phase: SyncPhase; done: number; total: number; path?: string };
  conflict: Conflict;
  error: { path?: string; error: Error; provider: string };
  synced: SyncResult;
}

export interface BaselineEntry {
  localVersion: number;
  remoteEtag: string;
  remoteVersion?: number;
  baseContent?: Uint8Array;
}
