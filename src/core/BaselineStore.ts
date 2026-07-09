import type { BaselineEntry } from './types';

// Persists the last-successful-sync state: for each path, the local version and
// remote etag captured at baseline. The engine compares current state against
// this to decide push / pull / conflict.
export interface BaselineStore {
  load(): Promise<Map<string, BaselineEntry>>;
  saveAll(map: Map<string, BaselineEntry>): Promise<void>;
}

export class MemoryBaselineStore implements BaselineStore {
  private data = new Map<string, BaselineEntry>();

  async load(): Promise<Map<string, BaselineEntry>> {
    return new Map(this.data);
  }

  async saveAll(map: Map<string, BaselineEntry>): Promise<void> {
    this.data = new Map(map);
  }
}

const DB_NAME = 'fs-sync-baseline';
const STORE = 'baseline';
const KEY = 'map';

export class IndexedDbBaselineStore implements BaselineStore {
  private dbName: string;
  private db: IDBDatabase | null = null;

  constructor(dbName: string = DB_NAME) {
    this.dbName = dbName;
  }

  private req<T>(r: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }

  private txDone(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  private async open(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    this.db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.db;
  }

  async load(): Promise<Map<string, BaselineEntry>> {
    const db = await this.open();
    const tx = db.transaction(STORE, 'readonly');
    const rec = await this.req<{ key: string; value: [string, BaselineEntry][] } | undefined>(
      tx.objectStore(STORE).get(KEY) as IDBRequest<{ key: string; value: [string, BaselineEntry][] } | undefined>,
    );
    return new Map(rec ? rec.value : []);
  }

  async saveAll(map: Map<string, BaselineEntry>): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ key: KEY, value: [...map.entries()] });
    await this.txDone(tx);
  }
}
