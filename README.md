# fs-sync

一个与 Node.js `fs` 兼容的跨端文件系统库：内置本地缓存，支持将文件**自动双向同步**到 WebDAV、GitHub、Gitee、RemoteStorage 等远端目标，并提供可插拔的冲突解决与 Provider 扩展机制。

> 本项目已完成 **设计文档 + 可运行的 TypeScript 脚手架（核心实现 + 四个真实 Provider）**，并通过 77 项单元测试与严格类型检查。

**实现状态**
- ✅ FS 兼容层 + 本地缓存层（Memory / IndexedDB 双后端，统一 `StorageAdapter`）
- ✅ 同步引擎（三路差异检测、双向 push/pull/remove、防回声、基线续做）
- ✅ 冲突检测与可插拔解决（`lastWriteWins` / `keepLocal` / `keepRemote` / `manual` / `threeWayMerge`，保留落败方副本）
- ✅ 事件总线（`statechange` / `progress` / `conflict` / `synced`）
- ✅ `SyncProvider` 抽象 + `MemoryProvider` 参考实现（同时用作测试远端）
- ✅ 内置真实 Provider：`WebDavProvider` / `GitHubProvider` / `GiteeProvider` / `RemoteStorageProvider`（零运行时依赖，基于可注入的 `FetchLike`）

---

## 特性

- **fs 兼容 API**：`readFile` / `writeFile` / `mkdir` / `readdir` / `stat` / `rename` / `unlink` / `rm` …，跨端一致。
- **双运行环境**：浏览器（IndexedDB 本地缓存）与 Node.js（磁盘）同一套 API。
- **本地优先**：离线可读写，联网后自动后台同步。
- **多目标双向同步**：可同时挂载多个远端 Provider。
- **冲突解决**：默认"最后写入获胜"，策略可插拔（保留双方副本防丢失）。
- **可扩展**：实现统一 `SyncProvider` 接口即可接入任意兼容 `fs` 的同步目标。

---

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [docs/requirements.md](docs/requirements.md) | 需求文档：背景、目标、功能/非功能需求、边界与用例、验收标准 |
| [docs/architecture.md](docs/architecture.md) | 架构说明：分层、运行环境适配、同步状态机、数据流、部署形态 |
| [docs/api.md](docs/api.md) | 接口文档：FS 兼容接口、StorageAdapter、SyncProvider、ConflictResolver、事件（含 TS 类型定义） |
| [docs/design.md](docs/design.md) | 设计文档：本地缓存数据模型、同步引擎算法、冲突检测与解决、Provider 扩展机制 |

---

## 核心概念速览

```
应用代码
  └─ fs 兼容层 (readFile/writeFile/...)
       ├─ 本地缓存层 (StorageAdapter: IndexedDB / 磁盘)
       └─ 同步引擎 (Differ + Executor + ConflictResolver + BaselineStore)
            └─ SyncProvider (WebDAV / GitHub / Gitee / RemoteStorage / 自定义)
```

- **本地缓存层**：环境无关抽象 `StorageAdapter`，维护目录树、文件内容与元数据（`path`/`mtime`/`size`/`contentHash`/`version`）。
- **同步引擎**：基于元数据差异检测驱动双向同步；状态机 `idle → detecting → pushing/pulling → resolving → finalizing`，支持幂等、重试、断点续传。
- **Provider**：远端统一接口 `SyncProvider`（`authenticate`/`list`/`pull`/`push`/`remove`/`stat`）。
- **冲突**：本地与远端均修改且无共同祖先时触发；默认 `lastWriteWins`，可插拔 `keepLocal`/`keepRemote`/`manual`/`threeWayMerge`。

---

## 快速开始

```bash
npm install
npm test        # 运行 77 项单元测试（Vitest）
npm run build   # 严格类型检查（tsc --noEmit）
```

### 使用示例（已可运行）

```ts
import { createFsSync, WebDavProvider } from 'fs-sync';

const fs = createFsSync({
  storage: 'memory', // 浏览器中改用 'indexeddb'
  providers: [
    new WebDavProvider({
      name: 'dav',
      baseUrl: 'https://dav.example.com/remote.php/dav/files/user',
      username: 'u',
      password: 'p',
    }),
  ],
  conflictResolver: 'lastWriteWins',
});

fs.on('conflict', (c) => console.warn('冲突:', c.path));
fs.on('synced', (r) => console.log('已同步', r));

await fs.writeFile('/notes/a.txt', 'hello world');
const txt = await fs.readFile('/notes/a.txt', { encoding: 'utf8' });
await fs.syncNow(); // 推送到远端
```

### 内置 Provider

| Provider | 说明 | 认证 |
| --- | --- | --- |
| `WebDavProvider` | Nextcloud / ownCloud / 坚果云 / Apache mod_dav | 基本认证或 Bearer |
| `GitHubProvider` | GitHub 仓库（Contents + Git Trees API） | Personal Access Token |
| `GiteeProvider` | Gitee 仓库（REST v5，接口同 GitHub） | `access_token` |
| `RemoteStorageProvider` | remoteStorage 协议（Unhosted） | Bearer（OAuth） |

```ts
import { GitHubProvider, GiteeProvider, RemoteStorageProvider } from 'fs-sync';

new GitHubProvider({ owner: 'me', repo: 'notes', token: 't', branch: 'main', basePath: 'docs' });
new GiteeProvider({ owner: 'me', repo: 'notes', token: 't' });
new RemoteStorageProvider({ baseUrl: 'https://storage.example.com/user', token: 't' });
```

> 所有 Provider 均**零运行时依赖**，通过可注入的 `FetchLike` 传输层实现，默认使用全局 `fetch`（Node 18+ / 浏览器均可）；测试时可注入自定义 `fetch` 做离线验证。

---

## 实现自定义 Provider

任意"兼容 node fs 的远端"只需实现 `SyncProvider` 接口即可接入，无需改动核心：

```ts
import type { SyncProvider, RemoteMeta, FileMeta, ListOptions } from 'fs-sync';
// 实现 authenticate / list / pull / push / remove / stat
```

参考 `src/providers/MemoryProvider.ts`（最小样例）或 `src/providers/WebDavProvider.ts` / `GitContentsProvider.ts` / `RemoteStorageProvider.ts`（真实协议实现）。具体协议调用要点见 `docs/design.md §4`（WebDAV 走 `PROPFIND/GET/PUT/DELETE`，GitHub/Gitee 走 Contents API，RemoteStorage 走文件夹列举 + ETag）。

---

## 测试覆盖

| 测试文件 | 覆盖内容 | 用例数 |
| --- | --- | --- |
| `test/hash.test.ts` | 内容哈希与编解码工具 | 6 |
| `test/path.test.ts` | POSIX 路径归一化 | 3 |
| `test/storage.test.ts` | `MemoryStorage` 与 `IndexedDbStorage` 一致性（fake-indexeddb） | 16 |
| `test/fs.test.ts` | `FsSync` 的 fs 兼容 API | 12 |
| `test/conflict.test.ts` | 五种冲突策略 | 8 |
| `test/sync.test.ts` | 双向推送/拉取/删除同步、防回声、冲突、双客户端收敛、事件 | 9 |
| `test/webdav.test.ts` | `WebDavProvider`：认证/增删查改/列举 + 端到端同步 | 7 |
| `test/github.test.ts` | `GitHubProvider`：sha/etag、basePath 映射 + 端到端同步 | 6 |
| `test/gitee.test.ts` | `GiteeProvider`：`access_token` 查询参数 + 端到端同步 | 4 |
| `test/remotestorage.test.ts` | `RemoteStorageProvider`：递归目录列举/stat + 端到端同步 | 6 |

---

## 路线图

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| M1 | FS 兼容层 + 本地缓存层（浏览器/Node） | ✅ 已实现 |
| M2 | 同步引擎（差异检测、双向、重试、状态机） | ✅ 已实现 |
| M3 | 冲突检测与可插拔解决 | ✅ 已实现 |
| M4 | 内置 Provider（WebDAV / GitHub / Gitee / RemoteStorage） | ✅ 已实现（含端到端测试） |
| M5 | 事件总线、可观测性与文档完善 | ✅ 事件总线已实现；文档已完成 |

---

## 许可证

待定（建议 MIT）。
