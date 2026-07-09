import type {
  Conflict,
  ConflictResolver,
  ConflictResolution,
  ConflictStrategy,
} from './types';

const enc = new TextEncoder();
const dec = new TextDecoder();

// Default strategy. Compares mtime, then version, keeping the loser copy to
// avoid data loss.
export class LastWriteWinsResolver implements ConflictResolver {
  resolve(c: Conflict): ConflictResolution {
    const keepLosersCopy = true;
    if (c.local.mtime > c.remote.mtime) return { action: 'local', keepLosersCopy };
    if (c.remote.mtime > c.local.mtime) return { action: 'remote', keepLosersCopy };
    if (c.local.version >= (c.remote.version ?? 0)) return { action: 'local', keepLosersCopy };
    return { action: 'remote', keepLosersCopy };
  }
}

export class KeepLocalResolver implements ConflictResolver {
  resolve(_c: Conflict): ConflictResolution {
    return { action: 'local', keepLosersCopy: false };
  }
}

export class KeepRemoteResolver implements ConflictResolver {
  resolve(_c: Conflict): ConflictResolution {
    return { action: 'remote', keepLosersCopy: false };
  }
}

export class ManualResolver implements ConflictResolver {
  resolve(_c: Conflict): ConflictResolution {
    return { action: 'skip' };
  }
}

// Textual three-way merge based on the common ancestor (base). Falls back to
// last-write-wins when base content is unavailable.
export class ThreeWayMergeResolver implements ConflictResolver {
  resolve(c: Conflict): ConflictResolution {
    if (!c.baseData || !c.localData || !c.remoteData) {
      return new LastWriteWinsResolver().resolve(c);
    }
    const base = dec.decode(c.baseData);
    const local = dec.decode(c.localData);
    const remote = dec.decode(c.remoteData);
    if (base === local) return { action: 'remote', keepLosersCopy: false };
    if (base === remote) return { action: 'local', keepLosersCopy: false };
    const merged = `<<<<<<< local\n${local}\n=======\n${remote}\n>>>>>>> remote`;
    return { action: 'merge', mergedContent: enc.encode(merged), keepLosersCopy: true };
  }
}

export function createConflictResolver(strategy: ConflictStrategy): ConflictResolver {
  switch (strategy) {
    case 'lastWriteWins':
      return new LastWriteWinsResolver();
    case 'keepLocal':
      return new KeepLocalResolver();
    case 'keepRemote':
      return new KeepRemoteResolver();
    case 'manual':
      return new ManualResolver();
    case 'threeWayMerge':
      return new ThreeWayMergeResolver();
  }
}
