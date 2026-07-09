# fs-sync 接口文档（API Reference）

> 文档版本：v0.1（草案）　|　最后更新：2026-07-09
> 语言：TypeScript（strict）。接口以类型定义为准；本节给出核心类型与签名草案。

---

## 1. 顶层入口

```ts
import { createFsSync, FsSync } from 'fs-sync';

const fs = createFsSync({
  root: '/',                       // 虚拟根（浏览器）或真实目录（Node）
  storage: 'auto',                // 'auto' | 'indexeddb' | 'nodefs'
  providers: [/* SyncProvider[] */],
  conflictResolver: 'lastWriteWins',
  sync: { mode: 'auto', intervalMs: 30000 },
  logger: console,
});

// fs 即为兼容 Node fs 的接口对象（见 §2）
```

### `createFsSync(options: FsSyncOptions): FsSync`

#### `FsSyncOptions`

```ts
interface FsSyncOptions {
  /** 逻辑根路径，默认 '/' */
  root?: string;
  /** 本地缓存后端；'auto' 按运行环境选择 */
  storage?: 'auto' | 'indexeddb' | 'nodefs' | StorageAdapter;
  /** 挂载的同步目标 */
  providers?: SyncProvider[];
  /** 冲突解决策略，或自定义 resolver */
  conflictResolver?: ConflictStrategy | ConflictResolver;
  /** 同步调度配置 */
  sync?: SyncOptions;
  /** 可注入日志器 */
  logger?: Logger;
  /** 容量上限（字节），超出触发 LRU 预警 */
  quotaBytes?: number;
}
```

#### `SyncOptions`

```ts
interface SyncOptions {
  mode: 'manual' | 'auto' | 'interval';
  /** interval 模式下的周期（毫秒） */
  intervalMs?: number;
  /** 单文件失败最大重试次数 */
  maxRetries?: number;
  /** 重试退避基数（毫秒） */
  retryBaseMs?: number;
  /** 并发同步文件数 */
  concurrency?: number;
}
```

---

## 2. FS 兼容接口（`FsSync`）

> 以下为核心方法草案；语义对齐 Node `fs/promises`。同步版（带 `Sync` 后缀）是否提供可在实现阶段决定，建议优先 `async`。

```ts
interface FsSync {
  // —— 文件读写 ——
  readFile(path: string, options?: ReadOptions): Promise<Buffer | string>;
  writeFile(path: string, data: Buffer | string | ArrayBuffer, options?: WriteOptions): Promise<void>;

  // —— 目录 ——
  mkdir(path: string, options?: MkdirOptions): Promise<void>;
  readdir(path: string, options?: ReaddirOptions): Promise<string[] | DirentLike[]>;
  rmdir(path: string, options?: RmdirOptions): Promise<void>;
  rm(path: string, options?: RmOptions): Promise<void>; // 支持 recursive

  // —— 状态 ——
  stat(path: string): Promise<StatsLike>;
  exists(path: string): Promise<boolean>;
  existsSync(path: string): boolean;

  // —— 重命名/移动 ——
  rename(oldPath: string, newPath: string): Promise<void>;

  // —— 删除 ——
  unlink(path: string): Promise<void>;

  // —— 流式（建议） ——
  createReadStream(path: string, options?: StreamOptions): ReadableLike;
  createWriteStream(path: string, options?: StreamOptions): WritableLike;

  // —— 同步控制 ——
  use(provider: SyncProvider): void;            // 挂载 Provider
  unuse(name: string): void;                     // 卸载 Provider
  sync(options?: SyncTriggerOptions): Promise<SyncResult>;
  syncNow(): Promise<SyncResult>;                // 立即触发一次
  status(): SyncStatus;                          // 当前状态快照
  on<E extends keyof FsSyncEvents>(event: E, cb: FsSyncEvents[E]): () => void; // 订阅，返回取消函数
  off<E extends keyof FsSyncEvents>(event: E, cb: FsSyncEvents[E]): void;
}
```

### 关键类型

```ts
type Encoding = 'utf8' | 'utf-8' | 'base64' | 'hex' | 'binary' | 'latin1' | null;

interface ReadOptions { encoding?: Encoding; signal?: AbortSignal; }
interface WriteOptions { encoding?: Encoding; flag?: 'w' | 'a'; signal?: AbortSignal; }

interface MkdirOptions { recursive?: boolean; }
interface RmOptions { recursive?: boolean; force?: boolean; }
interface ReaddirOptions { withFileTypes?: boolean; }

interface DirentLike { name: string; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; }
interface StatsLike {
  size: number;       // 字节
  mtimeMs: number;    // 修改时间（ms）
  birthtimeMs: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}
```

---

## 3. 本地缓存抽象（`StorageAdapter`）

```ts
interface StorageAdapter {
  /** 初始化（打开 IndexedDB / 校验目录等） */
  open(): Promise<void>;
  close(): Promise<void>;

  // —— 文件 ——
  readFile(path: string): Promise<FileRecord>;
  writeFile(path: string, content: Binary, meta?: Partial<FileMeta>): Promise<FileMeta>;
  deleteFile(path: string): Promise<void>;

  // —— 目录 ——
  mkdir(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  rmdir(path: string, recursive: boolean): Promise<void>;

  // —— 元数据 ——
  stat(path: string): Promise<FileMeta | DirMeta>;
  exists(path: string): Promise<boolean>;

  // —— 遍历 ——
  walk(root: string, onItem: (meta: FileMeta) => void | Promise<void>): Promise<void>;
}

interface FileMeta {
  path: string;
  type: 'file';
  size: number;
  mtime: number;       // epoch ms
  contentHash: string; // 内容摘要（如 sha1/xxhash）
  version: number;     // 本地版本号，每次写自增
  deleted?: boolean;   // tombstone 标记
}

interface DirMeta { path: string; type: 'dir'; mtime: number; }

type Binary = Buffer | ArrayBuffer | Blob | Uint8Array;
```

---

## 4. 同步目标抽象（`SyncProvider`）

第三方接入任意兼容 `fs` 的远端，只需实现该接口。

```ts
interface SyncProvider {
  /** 唯一名称，用于挂载/卸载与状态区分 */
  readonly name: string;

  /** 鉴权 / 建立会话；失败抛出 AuthError */
  authenticate(): Promise<void>;

  /** 列出远端某前缀下文件元数据（分页） */
  list(prefix: string, opts?: ListOptions): Promise<RemoteMeta[]>;

  /** 拉取远端文件内容 */
  pull(path: string): Promise<{ content: Binary; meta: RemoteMeta }>;

  /** 推送本地内容到远端 */
  push(path: string, content: Binary, meta: FileMeta): Promise<RemoteMeta>;

  /** 删除远端文件 */
  remove(path: string): Promise<void>;

  /** 获取单个远端元数据 */
  stat(path: string): Promise<RemoteMeta | null>;

  /** 可选项：远端是否支持版本/ETag，用于冲突判定 */
  capabilities?: { versioned?: boolean; etag?: boolean };
}

interface RemoteMeta {
  path: string;
  size: number;
  mtime: number;
  /** 内容摘要或 ETag；缺失时退化为 mtime 比较 */
  etag?: string;
  version?: number;
}

interface ListOptions { cursor?: string; limit?: number; signal?: AbortSignal; }
```

### 内置 Provider 实现要点

| Provider | 关键点 |
| --- | --- |
| `WebDavProvider` | 基于 PROPFIND/GET/PUT/DELETE；`etag` 来自响应头 |
| `GitHubProvider` | 基于 Contents API 或 Git Data API；`version` 用 commit SHA |
| `GiteeProvider` | 同 GitHub，适配 Gitee API 差异 |
| `RemoteStorageProvider` | 遵循 remoteStorage.js 规范，基于 `GET`/`PUT`/`DELETE` 与 `If-Match` |

---

## 5. 冲突解决（`ConflictResolver`）

```ts
type ConflictStrategy = 'lastWriteWins' | 'keepLocal' | 'keepRemote' | 'manual' | 'threeWayMerge';

interface Conflict {
  path: string;
  local: FileMeta;
  remote: RemoteMeta;
  /** 共同祖先（若存在），来自基线 */
  base?: FileMeta | RemoteMeta | null;
}

interface ConflictResolution {
  /** 采用哪一侧，或自定义内容 */
  action: 'local' | 'remote' | 'merge' | 'skip';
  /** 当 action='merge' 时提供合并后内容 */
  mergedContent?: Binary;
  /** 是否保留被放弃的一方为 .conflict 副本 */
  keepLosersCopy?: boolean;
}

interface ConflictResolver {
  resolve(conflict: Conflict): Promise<ConflictResolution> | ConflictResolution;
}
```

### 内置策略

| 策略 | 行为 |
| --- | --- |
| `lastWriteWins` | 比较 `mtime`/`version`/`hash`，新者胜；默认开启 `keepLosersCopy` |
| `keepLocal` | 始终以本地为准，远端被覆盖 |
| `keepRemote` | 始终以远端为准，本地被覆盖 |
| `manual` | 返回 `skip` 并触发 `conflict` 事件，等待 UI 决策 |
| `threeWayMerge` | 基于 `base` 三方 diff；仅文本可合并，二进制退化为 `lastWriteWins` |

---

## 6. 配置与事件

### 6.1 事件类型（`FsSyncEvents`）

```ts
interface FsSyncEvents {
  /** 同步状态切换 */
  statechange: (state: SyncState) => void;
  /** 进度：已处理/总数 */
  progress: (p: { phase: SyncPhase; done: number; total: number; path?: string }) => void;
  /** 发生冲突，等待解决（manual 策略） */
  conflict: (c: Conflict) => void;
  /** 单文件同步错误 */
  error: (e: { path?: string; error: Error; provider: string }) => void;
  /** 一次同步完成 */
  synced: (result: SyncResult) => void;
}

type SyncState = 'idle' | 'detecting' | 'pushing' | 'pulling' | 'resolving' | 'conflict' | 'finalizing' | 'error';
type SyncPhase = 'detect' | 'push' | 'pull' | 'resolve';
```

### 6.2 `SyncResult` / `SyncStatus`

```ts
interface SyncResult {
  ok: boolean;
  pushed: number;
  pulled: number;
  conflicts: number;
  errors: number;
  durationMs: number;
  provider: string;
}

interface SyncStatus {
  state: SyncState;
  pending: number;       // 待同步项数量
  lastSyncedAt: number | null;
  providerStates: Record<string, SyncState>;
}
```

---

## 7. 工具类型

```ts
interface Logger {
  debug?(...args: unknown[]): void;
  info?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
  error?(...args: unknown[]): void;
}

interface SyncTriggerOptions {
  /** 指定仅同步某 Provider */
  provider?: string;
  /** 是否强制全量（忽略基线） */
  full?: boolean;
  signal?: AbortSignal;
}
```

---

## 8. 使用示例

```ts
import { createFsSync } from 'fs-sync';
import { WebDavProvider } from 'fs-sync/webdav';

const fs = createFsSync({
  providers: [new WebDavProvider({ baseUrl: 'https://dav.example.com', username: 'u', password: 'p' })],
  conflictResolver: 'lastWriteWins',
  sync: { mode: 'auto', intervalMs: 20000 },
});

fs.on('conflict', (c) => console.warn('冲突:', c.path));
fs.on('synced', (r) => console.log('已同步', r));

await fs.writeFile('/notes/a.txt', 'hello world');
const txt = await fs.readFile('/notes/a.txt', { encoding: 'utf8' });
await fs.syncNow();
```

---

## 9. 兼容性注意事项

- 路径统一为 POSIX 风格；Windows 调用方传入 `\` 将被归一化为 `/`。
- `encoding: null` 返回 `Buffer`（Node）/ `Uint8Array`（浏览器）。
- 错误对象带 `code`（`ENOENT` 等），与 Node `fs` 的 `ErrnoException` 语义一致。
- 浏览器端 `createWriteStream` 的实现受 IndexedDB 事务模型限制，建议内部以分块 `writeFile` 模拟。
