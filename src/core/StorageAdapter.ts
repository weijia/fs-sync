import type { FileMeta, DirMeta, WriteOptions } from './types';

// Local cache abstraction. Implementations: MemoryStorage (Node/tests),
// IndexedDbStorage (browser). Content and metadata are stored separately so
// that diffing only needs metadata.
export interface StorageAdapter {
  open(): Promise<void>;
  close(): Promise<void>;

  // files
  writeFile(path: string, content: Uint8Array, opts?: WriteOptions): Promise<FileMeta>;
  readFile(path: string): Promise<Uint8Array>;
  /** physical delete */
  deleteFile(path: string): Promise<void>;
  /** soft delete (tombstone) so sync can remove the remote copy */
  markDeleted(path: string): Promise<void>;
  statFile(path: string): Promise<FileMeta | null>;

  // dirs
  mkdir(path: string): Promise<void>;
  statDir(path: string): Promise<DirMeta | null>;
  readdir(path: string): Promise<{ name: string; type: 'file' | 'dir'; path: string }[]>;
  rmdir(path: string): Promise<void>;

  // traversal (files include tombstones)
  listAllFiles(): Promise<FileMeta[]>;
  listAllDirs(): Promise<DirMeta[]>;
}
