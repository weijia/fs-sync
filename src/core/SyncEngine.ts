import type { StorageAdapter } from './StorageAdapter';
import type { BaselineStore } from './BaselineStore';
import type { SyncProvider } from '../providers/SyncProvider';
import type {
  ConflictResolver,
  Conflict,
  FileMeta,
  RemoteMeta,
  SyncResult,
  Logger,
} from './types';
import { contentHash } from './hash';
import { mapWithConcurrency } from './util';

interface Progress {
  phase: 'detect' | 'push' | 'pull' | 'resolve' | 'finalize';
  done: number;
  total: number;
  path?: string;
}

export interface SyncEngineDeps {
  storage: StorageAdapter;
  baselineStore: BaselineStore;
  conflictResolver: ConflictResolver;
  logger?: Logger;
  onConflict?: (c: Conflict) => void;
  onProgress?: (p: Progress) => void;
}

// The sync engine: a three-way differ (local vs remote vs baseline) plus an
// executor that push/pulls/removes and resolves conflicts. The baseline makes
// it possible to distinguish "only local changed" from "both changed".
export class SyncEngine {
  constructor(private deps: SyncEngineDeps) {}

  async sync(
    provider: SyncProvider,
    opts?: { full?: boolean; concurrency?: number },
  ): Promise<SyncResult> {
    const start = Date.now();
    const result: SyncResult = {
      ok: true,
      pushed: 0,
      pulled: 0,
      removed: 0,
      conflicts: 0,
      errors: 0,
      durationMs: 0,
      provider: provider.name,
    };

    try {
      await provider.authenticate();
    } catch (e) {
      result.ok = false;
      result.errors++;
      this.deps.logger?.error?.(`[sync:${provider.name}] authenticate failed`, e);
      return result;
    }

    const baseline = await this.deps.baselineStore.load();
    const localFiles = await this.deps.storage.listAllFiles();
    let remoteFiles: RemoteMeta[] = [];
    try {
      remoteFiles = await provider.list('/');
    } catch (e) {
      result.ok = false;
      result.errors++;
      this.deps.logger?.error?.(`[sync:${provider.name}] list failed`, e);
      return result;
    }

    const localMap = new Map(localFiles.map((f) => [f.path, f] as const));
    const remoteMap = new Map(remoteFiles.map((r) => [r.path, r] as const));
    const allPaths = [...new Set([...localMap.keys(), ...remoteMap.keys()])];
    const newBaseline = new Map(baseline);

    this.deps.onProgress?.({ phase: 'detect', done: 0, total: allPaths.length });
    const concurrency = Math.max(1, opts?.concurrency ?? 1);

    await mapWithConcurrency(allPaths, concurrency, async (path) => {
      try {
        await this.processPath(path, provider, localMap, remoteMap, baseline, newBaseline, result);
      } catch (err) {
        result.errors++;
        result.ok = false;
        this.deps.logger?.error?.(`[sync:${provider.name}] error on ${path}`, err);
      }
    });

    this.deps.onProgress?.({ phase: 'finalize', done: allPaths.length, total: allPaths.length });
    await this.deps.baselineStore.saveAll(newBaseline);
    result.durationMs = Date.now() - start;
    return result;
  }

  private async processPath(
    path: string,
    provider: SyncProvider,
    localMap: Map<string, FileMeta>,
    remoteMap: Map<string, RemoteMeta>,
    baseline: Map<string, BaselineEntryLike>,
    newBaseline: Map<string, BaselineEntryLike>,
    result: SyncResult,
  ): Promise<void> {
    const L = localMap.get(path) ?? null;
    const R = remoteMap.get(path) ?? null;
    const B = baseline.get(path) ?? null;
    const localExists = !!L && !L.deleted;
    const localDeleted = !!L && L.deleted;
    const remoteExists = !!R;

    if (!localExists && !remoteExists) {
      if (B) newBaseline.delete(path);
      return;
    }
    if (localExists && !remoteExists) {
      await this.doPush(provider, L!, newBaseline, result);
      return;
    }
    if (localDeleted && !remoteExists) {
      if (B) newBaseline.delete(path);
      return;
    }
    if (!localExists && remoteExists) {
      if (B) await this.doRemoveRemote(provider, path, newBaseline, result);
      else await this.doPull(provider, R!, newBaseline, result);
      return;
    }

    // both exist
    if (!B) {
      if (L!.contentHash === R!.etag) {
        newBaseline.set(path, {
          localVersion: L!.version,
          remoteEtag: R!.etag!,
          remoteVersion: R!.version,
        });
        return;
      }
      await this.doConflict(provider, L!, R!, null, newBaseline, result);
      return;
    }

    const localChanged = B.localVersion !== L!.version;
    const remoteChanged = B.remoteEtag !== R!.etag;
    if (!localChanged && !remoteChanged) return;
    if (localChanged && !remoteChanged) {
      await this.doPush(provider, L!, newBaseline, result);
    } else if (!localChanged && remoteChanged) {
      await this.doPull(provider, R!, newBaseline, result);
    } else {
      await this.doConflict(provider, L!, R!, B, newBaseline, result);
    }
  }

  private async doPush(
    provider: SyncProvider,
    L: FileMeta,
    newBaseline: Map<string, BaselineEntryLike>,
    result: SyncResult,
  ): Promise<void> {
    const content = await this.deps.storage.readFile(L.path);
    const remoteMeta = await provider.push(L.path, content, L);
    newBaseline.set(L.path, {
      localVersion: L.version,
      remoteEtag: remoteMeta.etag ?? '',
      remoteVersion: remoteMeta.version,
      baseContent: content,
    });
    result.pushed++;
  }

  private async doPull(
    provider: SyncProvider,
    R: RemoteMeta,
    newBaseline: Map<string, BaselineEntryLike>,
    result: SyncResult,
  ): Promise<void> {
    const { content, meta } = await provider.pull(R.path);
    // Write locally WITHOUT marking a local change (prevents echo on next sync).
    const localMeta = await this.deps.storage.writeFile(R.path, content, {
      mtime: R.mtime,
      source: 'sync',
    });
    newBaseline.set(R.path, {
      localVersion: localMeta.version,
      remoteEtag: R.etag ?? meta.etag ?? '',
      remoteVersion: R.version,
      baseContent: content,
    });
    result.pulled++;
  }

  private async doRemoveRemote(
    provider: SyncProvider,
    path: string,
    newBaseline: Map<string, BaselineEntryLike>,
    result: SyncResult,
  ): Promise<void> {
    await provider.remove(path);
    const L = await this.deps.storage.statFile(path);
    if (L && L.deleted) await this.deps.storage.deleteFile(path);
    newBaseline.delete(path);
    result.removed++;
  }

  private async doConflict(
    provider: SyncProvider,
    L: FileMeta,
    R: RemoteMeta,
    B: BaselineEntryLike | null,
    newBaseline: Map<string, BaselineEntryLike>,
    result: SyncResult,
  ): Promise<void> {
    const localData = await this.deps.storage.readFile(L.path).catch(() => undefined);
    const pulled = await provider.pull(R.path).catch(() => null);
    const remoteData = pulled?.content;
    const baseData = B?.baseContent ?? null;
    const conflict: Conflict = {
      path: L.path,
      local: L,
      remote: R,
      base: B ?? null,
      localData,
      remoteData,
      baseData,
    };
    const resolution = await this.deps.conflictResolver.resolve(conflict);
    if (resolution.action === 'skip') {
      this.deps.onConflict?.(conflict);
      result.conflicts++;
      return; // baseline unchanged -> deferred to next sync
    }
    if (resolution.keepLosersCopy) {
      await this.keepLosersCopy(L, R, resolution.action, localData, remoteData);
    }
    if (resolution.action === 'local') {
      const content = localData!;
      const remoteMeta = await provider.push(L.path, content, L);
      newBaseline.set(L.path, {
        localVersion: L.version,
        remoteEtag: remoteMeta.etag ?? '',
        remoteVersion: remoteMeta.version,
        baseContent: content,
      });
      result.pushed++;
      result.conflicts++;
    } else if (resolution.action === 'remote') {
      const content = remoteData!;
      const localMeta = await this.deps.storage.writeFile(L.path, content, {
        mtime: R.mtime,
        source: 'sync',
      });
      newBaseline.set(L.path, {
        localVersion: localMeta.version,
        remoteEtag: R.etag ?? '',
        remoteVersion: R.version,
        baseContent: content,
      });
      result.pulled++;
      result.conflicts++;
    } else if (resolution.action === 'merge') {
      const content = resolution.mergedContent!;
      const fileMeta: FileMeta = {
        ...L,
        size: content.length,
        contentHash: contentHash(content),
        mtime: Date.now(),
      };
      const remoteMeta = await provider.push(L.path, content, fileMeta);
      const localMeta = await this.deps.storage.writeFile(L.path, content, {
        mtime: Date.now(),
        source: 'sync',
      });
      newBaseline.set(L.path, {
        localVersion: localMeta.version,
        remoteEtag: remoteMeta.etag ?? '',
        remoteVersion: remoteMeta.version,
        baseContent: content,
      });
      result.pushed++;
      result.conflicts++;
    }
  }

  private async keepLosersCopy(
    L: FileMeta,
    R: RemoteMeta,
    action: string,
    localData?: Uint8Array,
    remoteData?: Uint8Array,
  ): Promise<void> {
    const ts = Date.now();
    try {
      if (action === 'local' && remoteData) {
        await this.deps.storage.writeFile(`${R.path}.conflict-remote-${ts}`, remoteData, {
          mtime: R.mtime,
        });
      } else if (action === 'remote' && localData) {
        await this.deps.storage.writeFile(`${L.path}.conflict-local-${ts}`, localData, {
          mtime: L.mtime,
        });
      }
    } catch {
      /* best effort */
    }
  }
}

// Internal structural type matching BaselineEntry (avoid import cycle noise).
interface BaselineEntryLike {
  localVersion: number;
  remoteEtag: string;
  remoteVersion?: number;
  baseContent?: Uint8Array;
}
