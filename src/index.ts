export { FsSync, createFsSync } from './core/FsSync';
export type { FsSyncOptions } from './core/FsSync';

export { MemoryStorage } from './core/MemoryStorage';
export { IndexedDbStorage } from './core/IndexedDbStorage';
export type { StorageAdapter } from './core/StorageAdapter';

export { MemoryBaselineStore, IndexedDbBaselineStore } from './core/BaselineStore';
export type { BaselineStore } from './core/BaselineStore';

export { SyncEngine } from './core/SyncEngine';

export {
  createConflictResolver,
  LastWriteWinsResolver,
  KeepLocalResolver,
  KeepRemoteResolver,
  ManualResolver,
  ThreeWayMergeResolver,
} from './core/ConflictResolver';

export type { SyncProvider, ListOptions } from './providers/SyncProvider';
export { MemoryProvider } from './providers/MemoryProvider';
export { WebDavProvider } from './providers/WebDavProvider';
export type { WebDavProviderOptions } from './providers/WebDavProvider';
export { GitHubProvider } from './providers/GitHubProvider';
export type { GitHubProviderOptions } from './providers/GitHubProvider';
export { GiteeProvider } from './providers/GiteeProvider';
export type { GiteeProviderOptions } from './providers/GiteeProvider';
export { RemoteStorageProvider } from './providers/RemoteStorageProvider';
export type { RemoteStorageProviderOptions } from './providers/RemoteStorageProvider';
export { GitContentsProvider } from './providers/GitContentsProvider';
export type { GitContentsOptions } from './providers/GitContentsProvider';
export type { FetchLike, HttpResponse, HttpRequestInit } from './providers/http';

export { Emitter } from './core/events';
export { FsError, ENOENT, EEXIST, ENOTDIR, EISDIR, AuthError } from './core/errors';
export { contentHash } from './core/hash';
export { normalizePath, dirname, basename, joinPath, isInside } from './core/path';

export type {
  Binary,
  FileMeta,
  DirMeta,
  MetaEntry,
  RemoteMeta,
  ConflictStrategy,
  Conflict,
  ConflictAction,
  ConflictResolution,
  ConflictResolver,
  WriteOptions,
  SyncOptions,
  SyncResult,
  SyncState,
  SyncPhase,
  SyncStatus,
  SyncTriggerOptions,
  Logger,
  FsSyncEvents,
  BaselineEntry,
} from './core/types';
