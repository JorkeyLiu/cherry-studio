# Cherry Studio SQLite 迁移文档

> **文档状态**：In progress（Phase 0–3 完成；Phase 4.0 Done on macOS arm64；Phase 4.1 Done；Phase 4.2 Done；Phase 4.3+ 未开始）
> **分支**：`jorkey/refactor/sqlite-migration`
> **最后更新**：2026-07-27
> **Owner**：Personal fork（jorkeyliu）
>
> ⚠️ **ADR-8 策略更正（2026-07-20）**：Phase 4+ 的产品策略已更正为**外部应用兼容性导入**模型。原 in-place Dexie→SQLite shadow/cutover 模型已正式废弃。详见 Section 6 A-8。

---

## 1. 背景与目标

Cherry Studio 当前核心聊天数据存储在 Renderer 进程的 Dexie（IndexedDB `CherryStudio`）中。

Dexie/IndexedDB **支持事务且启用 strict durability**，具备 ACID 基础能力。当前方案的结构性缺口为：

- 无 SQLite 式 integrity check（PRAGMA integrity_check）
- 无 WAL checkpoint 机制（IndexedDB 自管理，不可控）
- 无关系外键约束（仅逻辑引用，无数据库层约束）
- Main 进程无法直接读写聊天数据，IPC 成为唯一通道，无法利用 SQLite 工具链

历史曾存在 agents SQLite 子系统但已删除，留下残留配置和依赖。备份/恢复直接复制 `Data/` 目录，无数据库一致性保障。

**最终产品行为**：未来的 SQLite-authoritative Cherry Chat 是一个**独立于当前 Cherry Studio 的应用**。用户在 Cherry Chat 中通过交互（等同于当前备份恢复流程）选择一个 Cherry Studio ZIP 备份文件来导入数据。不扫描磁盘查找其他应用配置、不在启动时静默迁移、不要求两个应用共享目录。

**当前阶段目标（Phase 0–3）**：建立 Main 进程 SQLite 基础设施（连接管理、schema migration、integrity 校验、备份协调）和 command-oriented typed IPC，为最终的外部导入流程提供目标数据库和写入通道。Phase 0–3 的产出是运行时 plumbing，不是最终导入实现。

---

## 2. 范围与非目标

### 当前范围（Phase 0–3：基础设施）

- `topics`、`messages`、`message_blocks`、`topic_segments` 及必要的 file references
- 新建独立 `Data/chat.db`（A-1 Accepted），Main 进程单写
- 连接生命周期、migration 框架、integrity 校验、backup coordination
- Renderer→Main 的 command-oriented typed IPC 收口

### 最终范围（Phase 4–6：外部导入与 SQLite-only runtime）

- 安全解压 Cherry Studio ZIP 到隔离临时工作区
- 通过隔离 Electron Session/Profile + 隐藏 sandboxed import renderer 读取源 IndexedDB
- 分页逻辑数据通过窄 IPC 通道传输
- 构建候选 SQLite 数据库、验证、原子替换
- SQLite-only 运行时完成，Dexie 路由移除
- Cherry Chat 自身备份/恢复与 Cherry Studio ZIP 导入的 UX 分离

### 非目标（明确排除）

- Agent session 数据导入（out of scope）
- 文件内容 blob 迁移（file references 是快照，不建 canonical files 表）
- FTS/全文搜索
- 推断缺失的 ID、ownership、timestamp、role、status、model 等字段
- 历史逻辑格式 `data.json` / `.bak` 兼容（明确放弃）
- 静默数据修复
- Redux 配置数据迁移（settings、shortcuts、llm 等）
- Memory `memories.db` 迁移
- Knowledge `KnowledgeBase/*` 迁移
- 启动时自动扫描磁盘查找其他应用配置
- 两个应用共享目录

---

## 3. 当前数据版图

| 存储层 | 技术 | 数据 | 进程 | 状态 |
|---|---|---|---|---|
| `CherryStudio` (IndexedDB) | Dexie（支持事务，strict durability） | topics, messages, message_blocks, topic_segments, files, settings, knowledge_notes, translate_history, quick_phrases, translate_languages | Renderer | **活跃，核心聊天唯一来源** |
| `Data/Memory/memories.db` | @libsql/client | 记忆条目、向量嵌入 | Main | 可用，生命周期不完整 |
| `Data/KnowledgeBase/*/` | embedjs-libsql (LibSqlDb) | 知识库笔记、嵌入 | Main | 可用，closeAll 访问私有 client |
| `Data/agents.db` | Drizzle ORM + LibSQL | （已删除子系统遗留） | — | **无代码 owner，不可用** |
| Redux store (redux-persist) | JSON in localStorage | 全局设置、助手配置、LLM 配置等 | Renderer | 活跃，不在迁移范围 |

---

## 4. SQLite 资产盘点

| 资产 | 路径 | 状态 | 复用评估 | 问题 | 处置 |
|---|---|---|---|---|---|
| Memory memories.db | `Data/Memory/memories.db` | 可用 | 否（独立领域） | close 未接入 will-quit；初始化并发与失败清理不足 | 修复生命周期，不复用 |
| Knowledge Base | `Data/KnowledgeBase/*/` | 可用 | 否（独立领域） | closeAll 访问 `(db as any).client` 私有属性；未接入 will-quit | 修复生命周期，不复用 |
| agents.db | `Data/agents.db`（用户文件） | 不可用 | 否 | 无代码 owner；package.json scripts 指向不存在的 config | 不创建新文件；**遗留文件默认保留，由用户确认后归档或删除** |
| drizzle-kit | devDependencies | 可用 | **保留，配置指向 chat.db schema**（A-7 Accepted） | config 指向不存在的 agents 路径 | 保留并更新 config 指向 chat.db |
| drizzle-orm | dependencies | 可用 | **保留，配置指向 chat.db schema**（A-7 Accepted） | 当前无活跃 schema | 保留并用于 chat.db schema |

---

## 5. 清理清单

### 说明

本阶段为**文档阶段**，仅记录清理计划，**不执行任何实际代码删除**。所有清理项状态为 Not started。

### Group A：可立即清理（仅无运行时影响的失效 scripts / 过时文档）

| # | 项目 | 说明 |
|---|---|---|
| C-1 | `package.json` 中 `agents:generate/push/studio/drop` scripts | 指向 `src/main/services/agents/drizzle.config.ts`，该文件已不存在 |
| C-6 | `src/renderer/src/services/db/README.md` | 描述不存在的 Agent IPC 实现，需更新或删除 |
| C-8 | 过时 CLAUDE.md / README 中 agents 描述 | 仍引用已删除的 agents SQLite 框架 |

> **清理前提**：确认无其他代码或 CI 依赖这些 scripts/文档。预计零运行时影响。

### Group B：需调用链迁移后清理（涉及代码路径变更）

| # | 项目 | 前置条件 |
|---|---|---|
| C-4 | `AgentMessageDataSource` stub | 先迁调用点（DbService 路由）→ 编译验证 → 功能验证 |
| C-5 | `DbService` 中 agent-session 路由逻辑 | 同上，`isAgentSessionTopicId` 路由到 no-op stub |
| C-7 | 重复 topic ID utility（`types.ts` 中 `isAgentSessionTopicId`/`buildAgentSessionTopicId`/`extractSessionId`） | 同上，仅服务于已删除的 agent 子系统 |

> **操作顺序**：① 迁移调用链到新数据源 → ② 编译通过 + 功能回归通过 → ③ 删除 stub 和路由。

### Group C：技术栈决策后处理（依赖 ADR 完成）

| # | 项目 | 决策依赖 |
|---|---|---|
| C-2 | `package.json` 中 `drizzle-kit` devDependency | A-7 已 Accepted：**保留，配置指向 chat.db schema** |
| C-3 | `package.json` 中 `drizzle-orm` dependency | A-7 已 Accepted：**保留，配置指向 chat.db schema** |

### Group D：SQLite-only 运行时完成后处理（依赖 Phase 5 SQLite-only runtime 完成）

| # | 项目 | 条件 |
|---|---|---|
| C-9 | Dexie `topics`/`message_blocks`/`topic_segments` 表 | Phase 5 SQLite-only runtime 完成后，Dexie 仅保留于隔离 import renderer；普通聊天路径不再访问 Dexie |
| C-10 | Renderer 直接 Dexie 访问（数十处） | Phase 5 逐步收口至 DbService→IPC，非一次性清理 |
| C-11 | `DexieMessageDataSource` 实现 | Phase 5 完成后从普通聊天路径移除；仅保留于隔离 import renderer 的内部实现中 |
| C-13 | Phase 3.4 路由策略代码（`routingPolicy.ts`、注入策略） | Phase 5 临时验证 scaffolding，必须移除 |

### Group E：用户数据处理（须用户确认）

| # | 项目 | 条件 |
|---|---|---|
| C-12 | 遗留 `agents.db` 用户文件 | **默认保留或提示归档；只有用户明确确认后才可删除，禁止静默自动删除** |

---

## 6. 关键架构决策（ADR 短表）

| # | 决策 | 状态 | 说明 |
|---|---|---|---|
| A-1 | 新建独立 `Data/chat.db`，不复用 `agents.db` | **Accepted** | agents.db 无代码 owner，schema 不兼容，用户文件需保留 |
| A-2 | Main 进程单写，Renderer 通过 IPC 读写 | **Accepted** | 避免多进程并发写；Renderer 不直接持有 SQLite 连接；Phase 3 实现确认（ChatDbAggregateService Main 侧单写 + Preload bridge IPC） |
| A-3 | 关系化 schema（非 JSON blob 堆砌） | **Accepted** | topics/messages/blocks 显式关系；JSON 仅用于低查询扩展字段；Phase 1–2 实现确认（migration 001+002 + 5 个 Repository） |
| A-4 | Command-oriented typed IPC | **Accepted** | Renderer 不暴露 SQL 能力；Main 暴露 typed command handlers；Phase 3.1–3.3 实现确认（14 ChatDb channels + shared contracts + typed Preload bridge） |
| A-5 | ~~迁移期一次性切换 + Dexie 快照回滚~~ | **Superseded by A-8** | 原决策基于 in-place 本地 Dexie→SQLite 导入+切换模型。A-8 更正为外部应用兼容性导入模型：源数据来自用户选择的 Cherry Studio ZIP，不是当前运行时 Dexie；导入是 replace-all 而非 merge/shadow；不涉及"切换后新增数据回滚"场景 |
| A-6 | 备份策略：online backup adapter + full-operation coordination | **Accepted** | better-sqlite3 `backup()` API 封装为可替换 adapter（抽象层），`BackupManager` 协调全操作（互斥锁、staging、生产路径过滤、恢复后 integrity check）；未来可替换为 PowerSync 方案；不使用 live WAL raw copy |
| A-7 | 技术栈：better-sqlite3 + Drizzle ORM + drizzle-kit | **Accepted** | better-sqlite3 是 Node.js 生态最成熟 SQLite 驱动，同步 API，Drizzle 官方主推组合；与未来 PowerSync 集成兼容（PowerSync 首选 better-sqlite3）。@libsql/client 保留给 Memory/Knowledge 继续使用，不在本阶段统一 |
| **A-8** | **外部应用兼容性导入：隔离 Session + 候选 SQLite 构建 + 原子替换** | **Accepted (2026-07-20)** | **最终产品行为**：SQLite-authoritative Cherry Chat 是独立于当前 Cherry Studio 的应用。用户在 Cherry Chat 中选择 Cherry Studio ZIP 备份来导入。**技术路线**：安全解压 ZIP 到唯一临时工作区 → 通过 `session.fromPath(absolutePath, { cache: false })`（Electron 静态 API，非 `session.defaultSession.fromPath()`）+ 正确 origin 创建隔离 Electron Session → 隐藏 sandboxed import renderer 加载当前 Dexie schema/upgrades → 窄 import-only IPC 分页读取逻辑数据 → Main 构建候选 SQLite DB → 验证（源 vs 目标 ID/计数/字段/顺序/关系/哈希/完整性/外键/应用层抽样）→ 原子替换 live `chat.db`（失败时回滚）。**约束**：① 不扫描磁盘查找其他应用；② 不在启动时静默迁移；③ 不要求共享目录；④ 不解析 LevelDB（Main 不直接解析）；⑤ 不恢复源到目标 app 的正常 Dexie profile；⑥ 旧 IndexedDB 仅在当前 Dexie declaration/upgrades 可防御性识别并升级为结构有效的当前逻辑形态时才接受；⑦ 缺失值继承当前 Cherry Studio/Dexie 升级和读取语义，不创建 importer-specific 历史修复；⑧ 结构不可用数据被拒绝；⑨ 导入语义是 replace-all，非 merge；⑩ 在导入过程中现有 SQLite 保持 authoritative；⑪ 取消支持至最终 promotion 之前；⑫ promotion 短时不可取消，保留一个回滚快照，重开/检查 DB，成功后 relaunch。**Phase 4.0 spike 结果**（macOS arm64）：`session.fromPath()` 可行；file:// origin 为正确 origin；`IndexedDB/file__0.indexeddb.leveldb` 为观测到的 profile 映射；Dexie logical 4→native 40, 11→native 110, 12→native 120；v12 被当前 Dexie upgrades 正确拒绝；default session 隔离确认；Local Storage 非 discovery/read 必需；10/10 fresh-root 迭代通过；helper 进程回退仍为 contingency，未选用。**未验证**：Windows/Linux、真实 ZIP snapshot 一致性 |

> **Phase 1 前置**：A-7（技术栈）和 A-5（~~authoritative 切换方式~~，已由 A-8 替代）两个 ADR 已关闭（Accepted），Phase 1 可启动。A-5 在 Phase 1 启动时已 Accepted，后因产品策略更正被 A-8 Superseded。

| **A-9** | **Phase 4.1 平台策略：macOS-first + 运行时平台拒绝** | **Accepted (2026-07-21)** | Phase 4.0 spike 只在 macOS arm64 验证 `session.fromPath()` + 退出清理。Windows/Linux 未验证（NTFS 文件锁不能删打开的文件；`session.fromPath` 跨平台锁/缓存语义未知）。**决策**：Phase 4.1 生产代码入口处 `process.platform !== 'darwin'` → 同步抛错并明确提示，非 macOS 不开放导入功能。生产模块的清理分支**预先写好 bounded retry + EBUSY 退避 + crash-recovery scan**——macOS 也用得上（spike 已证明偶尔需要重试），未来开放 Windows 只需删一行平台拒绝 + 跑一轮 Windows spike + 可能调一两个清理退避参数。**为何现在不验 Windows**：① 功能无用户（4.2/4.3/4.4 未完成，整条管线未上线）；② 配 Windows 开发环境成本远超此轮验证价值（Node22 + pnpm + better-sqlite3 原生构建 + Electron 调试链）；③ Phase 4.4 原子替换在 Windows 文件锁下更敏感，未来 4.4 验证会稀释本轮 4.1 验证价值。**Windows Linux 化工作量**≈ 删一行拒绝 + 重跑 Phase 4.0 spike harness + 调清理参数，是确定的增量工作非返工 |
| **A-10** | **Phase 4.0 spike harness 保留至 Phase 5** | **Accepted (2026-07-21)** | Phase 4.0 的 17 个 harness 文件（packages/shared/phase4*.ts + scripts/phase4-*.sh + src/main/phase4-*.ts + src/preload/phase4-spike-preload.ts + src/renderer/phase4Spike.html + src/renderer/src/windows/phase4Spike/）**全部保留至 Phase 5 SQLite-only runtime 完成时一并删除**（与 Group D 清理合并）。保留期间继续由 `electron.vite.config.ts` 的 `PHASE4_SPIKE=1` 门控，不进入生产构建。**理由**：① spike 已验证的语义（session 隔离、file:// origin、版本映射）在生产模块落地后仍可作回归对照基线；② Phase 4.1 source-reader 侧只是迁移管线上游一段，4.2/4.3/4.4 还未做，spike 重跑价值仍在；③ 未来 Windows/Linux 化时可重跑同一套 harness（spike harness 已证明平台可移植），无需重写脚手架。**Phase 4.1 生产模块独立新增**（`src/main/services/chatDbImport/`、`src/preload/chatImport/`、`src/renderer/src/windows/chatImport/`），**不复用 spike 代码**——harness 中的 `process.argv` 解析、`process.exit`、`generateRunId`、fixture 生成器、c2a/c2b IPC 多路复用、A/B marker 隔离断言、wrong-origin 探测、CLI 入口均为 spike 专属，丢弃；可复用的硬事实（`session.fromPath` + `{cache:false}`、`file://` origin、`indexedDB.databases()` 发现、production Dexie 升级链路、`event.sender.id` sender 校验、`will-navigate` deny、`setWindowOpenHandler` deny）在 spike 注释中标明，由生产模块重新干净实现。**终审遗留的 minor**（C2a/C2b 重复 installIpcListeners/registerCase/createSandboxedWindow、fixture generator 手写 store 声明需同步生产 schema、entry 用 process.exit(2) 处理 pre-Electron 启动失败）随 spike 一并在 Phase 5 删除，不在 Phase 4.1 抽取 |

---

## 7. 目标架构简图

### 运行时架构（Phase 5 最终态：SQLite-only Cherry Chat）

```
┌─────────────────────────────────────────────────────┐
│                   Renderer Process                   │
│                                                     │
│  ┌──────────┐  ┌───────────────────┐                │
│  │  Redux    │  │  Hooks/Components │                │
│  │  Store    │  │  (读写聊天数据)    │                │
│  └────┬─────┘  └───────┬───────────┘                │
│       │                │                             │
│       │         ┌──────▼───────┐                     │
│       │         │  DbService   │◄── (Phase 5: 直连  │
│       │         │  (IPC only)  │     SQLite, 无      │
│       │         └──────┬───────┘     Dexie 路由)     │
│                        │                             │
│  ┌─────────────────────▼──────────────────────────┐  │
│  │ Dexie 仅保留于隔离 import renderer（Phase 4）  │  │
│  └────────────────────────────────────────────────┘  │
└────────────────────────┼────────────────────────────┘
                         │ typed IPC (command)
┌────────────────────────┼────────────────────────────┐
│                   Main Process                       │
│         ┌──────────────▼───────────────┐             │
│         │  ChatDbAggregateService      │             │
│         │  (14 commands)               │             │
│         └──────────────┬───────────────┘             │
│         ┌──────────────▼───────┐  ┌──────────────┐  │
│         │ chat.db (SQLite)     │  │ Migration    │  │
│         │ authoritative        │  │ Framework    │  │
│         └──────────────┬───────┘  └──────────────┘  │
│         ┌──────────────▼───────────────┐             │
│         │ Backup Coord. (online backup)│             │
│         └──────────────────────────────┘             │
│                                                      │
│  ┌───────────────────────────────────────────────┐   │
│  │ Import Pipeline (Phase 4)                     │   │
│  │ ┌─────────────┐ ┌──────────────┐ ┌─────────┐ │   │
│  │ │ ZIP Intake  │→│ Isolated     │→│ Bulk    │ │   │
│  │ │ + Extract   │ │ Session +    │ │ Import  │ │   │
│  │ │             │ │ Import Rdr   │ │ + Verify│ │   │
│  │ └─────────────┘ └──────────────┘ └────┬────┘ │   │
│  │                                       │       │   │
│  │ ┌─────────────────────────────────────▼─────┐ │   │
│  │ │ Candidate SQLite → Verify → Atomic Swap   │ │   │
│  │ └───────────────────────────────────────────┘ │   │
│  └───────────────────────────────────────────────┘   │
│                                                      │
│  ┌─────────────────┐  ┌────────────────┐             │
│  │ MemoryService   │  │ KnowledgeSvc   │  (独立)    │
│  │ memories.db     │  │ KnowledgeBase/ │             │
│  └─────────────────┘  └────────────────┘             │
└──────────────────────────────────────────────────────┘
```

### 导入数据流（Phase 4）

```
用户选择 Cherry Studio ZIP
         │
         ▼
┌─────────────────────┐
│ 4.1 Secure ZIP      │  解压到唯一临时工作区
│ Intake + Extract    │  验证 ZIP 内含 Chromium IndexedDB
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│ Isolated Profile    │  session.fromPath() / isolated profile
│ + Import Renderer   │  正确 origin + 当前 Dexie schema/upgrades
│ (hidden, sandboxed) │  不恢复到正常 Dexie profile
└────────┬────────────┘
         │ narrow import-only IPC (分页)
         ▼
┌─────────────────────┐
│ 4.2 Candidate       │  Main 不解析 LevelDB
│ SQLite Bulk Import  │  构建完整候选 chat.db
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│ 4.3 Deterministic   │  ID/计数/字段/顺序/关系/哈希
│ Verification        │  integrity_check / foreign_key_check
│                     │  应用层抽样读取
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│ 4.4 Atomic          │  替换 live chat.db
│ Replace-All Promote │  失败→回滚，保留一个快照
│ (short, non-cancel) │  成功→reopen + relaunch
└─────────────────────┘
```

---

## 8. 初步目标 Schema（Draft v0 → Applied 001+002）

> 以下为表关系和关键字段规划，表达关系和约束意图，**不锁定 DDL**。待技术栈 ADR 决定后生成最终 DDL。
>
> **状态更新（2026-07-20）**：Draft v0 规划已通过 append-only migrations `001`（initial，Phase 1）和 `002`（Phase 2 schema extension）落地为 applied schema。当前 `chat.db` 运行的就是 001+002。`file_references` 表在 002 中以 block-linked 方式实现（见 Q-3 决议）；FTS 未包含（见 Q-5 决议）。

| 表 | 关键字段 | 关系 |
|---|---|---|
| `migration_state` | `key TEXT PK`, `value TEXT`, `updated_at TEXT` | — |
| `topics` | `id TEXT PK`, `assistant_id TEXT`, `name TEXT`, `created_at`, `updated_at`, `deleted_at`, `extra TEXT` (JSON) | — |
| `messages` | `id TEXT PK`, `topic_id TEXT NOT NULL`, `role TEXT`, `content TEXT`, `status TEXT`, `ask_id TEXT`, `model TEXT`, `created_at`, `sort_order INTEGER`, `extra TEXT` (JSON) | → topics(id) |
| `message_blocks` | `id TEXT PK`, `message_id TEXT NOT NULL`, `type TEXT`, `content TEXT`, `sort_order INTEGER`, `extra TEXT` (JSON) | → messages(id) |
| `topic_segments` | `id TEXT PK`, `topic_id TEXT NOT NULL`, `sort_order INTEGER`, `extra TEXT` (JSON) | → topics(id) |
| `topic_segment_messages` | `segment_id TEXT NOT NULL`, `message_id TEXT NOT NULL`, `sort_order INTEGER` | → topic_segments(id), → messages(id)，多对多 |
| `file_references` | `id TEXT PK`, `message_id TEXT`, `file_id TEXT NOT NULL`, `file_name TEXT`, `file_path TEXT`, `file_type TEXT`, `count INTEGER`, `extra TEXT` (JSON) | → messages(id) |

**设计原则**：
- 消息顺序通过 `sort_order` 显式管理，不依赖自增 ID 或插入时间
- JSON `extra` 字段用于扩展属性，避免 schema 频繁变更
- 文件引用首期仅迁移元数据，不迁移文件内容
- 预留索引：`messages(topic_id, sort_order)`，`message_blocks(message_id, sort_order)`，`topic_segments(topic_id, sort_order)`，`file_references(message_id)`，`file_references(file_id)`

---

## 9. 分阶段路线与状态追踪

### 状态约定

- **Phase/task**：Done / In progress / Not started / Blocked
- **ADR**：Accepted / Proposed
- **Open Questions**：Open / Resolved

### Phase 0：资产清理与基线

| 属性 | 值 |
|---|---|
| **状态** | **Done** |
| **目标** | 清理失效残留，建立可测量基线 |
| **主要任务** | Group A 清理项；确认 Dexie 数据量/分布基线；确认无其他代码引用 agents 路径 |
| **退出条件** | Group A 清理项完成；基线数据记录在案；package.json 无失效 scripts |

### Phase 1：基础设施

| 属性 | 值 |
|---|---|
| **状态** | **Done** |
| **前置** | ~~A-7（技术栈）和 A-5（authoritative 切换方式）ADR 必须先关闭~~ **Done**（A-7 Accepted, A-5 Accepted 后由 A-8 Superseded） |
| **目标** | 建立 SQLite 连接管理、migration 框架、integrity 校验 |
| **主要任务** | 实现 `ChatDbService`（连接生命周期/will-quit 关闭）；WAL/fk/synchronous/busy_timeout pragmas；inline build-safe initial migration；integrity check；restored-first-open repair gating；startup/will-quit wiring；replaceable online backup adapter（better-sqlite3 `backup()`）；BackupManager full-operation coordination（staging、filtering、production-path tests） |
| **退出条件** | ✅ `chat.db` 可创建/打开/关闭；migration 可执行；integrity 校验通过；WAL + foreign_keys + synchronous pragmas 正确设置；will-quit 正确关闭；恢复备份后首次打开自动执行 `PRAGMA integrity_check`；repair-required 时 app 继续运行但 chat DB 不可用；BackupManager 协调含互斥锁、staging、生产路径过滤；online backup adapter 可替换 |

### Phase 2：Schema 与 Repository

| 属性 | 值 |
|---|---|
| **状态** | **Done** |
| **目标** | 实现类型安全的 Repository 层 |
| **实际交付范围** | Append-only migration `002`（Phase 2 schema extension）；Main-local DTO/codec/mappers/typed cursors；`TopicsRepository`、`MessagesRepository`、`BlocksRepository`、`TopicSegmentsRepository`、`FileReferencesRepository`；block-linked file references（完整元数据快照，无 canonical files 表）；无 FTS |
| **主要任务** | TopicsRepository、MessagesRepository、BlocksRepository、TopicSegmentsRepository（含）、FileReferencesRepository；批量操作优化；分页查询（keyset pagination + dense ordering）；ownership/cascades/rollback 测试 |
| **退出条件** | ✅ 所有 Repository 单元测试通过（real better-sqlite3）；CRUD + 批量操作 + keyset pagination + dense ordering 覆盖；ownership/cascades/rollback 事务回滚测试通过；TopicSegmentsRepository 含完整 CRUD 和排序 |

### Phase 3：IPC 与 Renderer 收口

| 属性 | 值 |
|---|---|
| **状态** | **Done**（Phase 3.1 Done, Phase 3.2 Done (audit-fixed), Phase 3.3 Done, Phase 3.4 Done） |
| **目标** | 建立 Renderer→Main 的 command-oriented typed IPC |
| **主要任务** | 定义 IPC channel + command types（`packages/shared/IpcChannel.ts`）；Main 侧 handler；Renderer 侧 `SqliteMessageDataSource`；收口 DbService 路由 |
| **退出条件** | ✅ IPC 调用链路端到端可用；✅ DbService 路由可通过注入策略切换到 SQLite 数据源 |

#### Phase 3.1：Shared wire types & contracts

| 属性 | 值 |
|---|---|
| **状态** | **Done** |
| **目标** | 定义 ChatDb IPC channels、JSON wire DTO types、result envelope、runtime validation、command contracts；shared Vitest 测试覆盖 |
| **交付物** | `packages/shared/IpcChannel.ts` 新增 14 个 ChatDb channels；`packages/shared/chatDb/` 新增 types.ts、result.ts、validation.ts、contracts.ts、index.ts；`packages/shared/chatDb/__tests__/validation.test.ts`（99 tests）、`contracts.test.ts`（100 tests） |
| **约束** | 当前 Cherry Studio 运行时 Dexie 保持 authoritative（Phase 4 为外部导入，不影响当前运行时）；不基于 chat.db existence / DB initialized / migration 002 做切换；不实现 per-call SQLite→Dexie fallback；`updateFileCount(s)` 保留在 Dexie/FileManager，不纳入 IPC |
| **排除项** | 不修改 `src/preload/index.ts`；不添加 Main handler / SqliteMessageDataSource；不修改 DbService 路由；不实现 importer / shadow verification / cutover / FTS / canonical files / fallback |
| **退出条件** | ✅ 14 个 ChatDb channel 定义完整；✅ JSON wire 类型覆盖所有 MessageDataSource 命令（除 updateFileCount(s)）；✅ runtime validation 拒绝非法 JSON 值（undefined, bigint, symbol, function, NaN/Infinity, Date, Map/Set, Buffer/TypedArray, class instances, sparse arrays, cyclic, depth>20）；✅ 199 个 shared tests 通过（validation 99 + contracts 100）；✅ typecheck / format 通过 |

#### Phase 3.2：Main aggregate service & IPC handlers

| 属性 | 值 |
|---|---|
| **状态** | **Done**（含审计修复） |
| **目标** | Main ChatDb aggregate service combining five Phase 2 repositories; transaction-bound repository factory; wire adapters; 14 fixed IPC handlers with validation and error mapping |
| **交付物** | `src/main/services/chatDb/ChatDbAggregateService.ts`（14 命令实现）；`src/main/services/chatDb/repository/factory.ts`（仓库工厂）；`src/main/services/chatDb/wireAdapters.ts`（JSON ↔ Domain 适配器）；`src/main/services/chatDb/errors.ts`（错误映射 + typed aggregate errors + SQLite code inspection）；`src/main/services/chatDb/ipc.ts`（14 个 IPC handler 注册 + validateChatDbResult + malformed result containment + re-registration safety + stale-disposer ownership）；`src/main/ipc.ts` 调用 `registerChatDbIpc()`；`__tests__/aggregate.test.ts`（60 tests）、`wireAdapters.test.ts`（29 tests）、`ipc.test.ts`（27 tests）、`errors.test.ts`（39 tests） |
| **审计修复** | ① `fetchMessages` topic priming：absent topic 在同一事务内 ensure/create 并返回空数组；② `updateBlocks`/`updateSingleBlock`/`deleteBlocks`/`clearMessages` 全部使用 root-bound tx + tx-bound repos 实现原子性；③ `clearMessages` 移除语义错误的 `fileRefs.deleteByMessage()` 调用，依赖 FK cascade；④ 引入 typed aggregate errors（ChatDbValidationError 等 6 种）+ SQLite structured code inspection（SQLITE_CONSTRAINT_UNIQUE/FOREIGNKEY/BUSY/LOCKED）+ 优先级排序（typed > SQLite code > message-substring）；⑤ IPC handler 使用 `validateChatDbResult` 验证结果，malformed result 返回 valid ERR_STORAGE fallback；⑥ `handleCommand` channel 类型为 `ChatDbChannel`（通过 cast）；⑦ 错误消息 sanitize（不泄露 SQL/path/stack）；⑧ generic storage error 改为 non-retryable；⑨ 53 个新 tests（跨仓库回滚、cascade、typed error mapping、malformed result containment、topic priming） |
| **Contract 修正** | ① blocks 数组前置验证（validateJsonObjectArray）防止 TypeError；② 消息/块 patch 拒绝 identity/reparenting/sortOrder 字段（id/topicId/messageId/sortOrder）；③ 所有权一致性校验（block.messageId 匹配 message.id）；④ ERR_CONFLICT/ERR_UNAVAILABLE/ERR_BUSY 错误码；⑤ conflict 优先于 FK 检测（"UNIQUE constraint failed" 不误判为 FK）；⑥ "abort due to constraint" 不再匹配 conflict（避免 FK 误分类） |
| **约束** | 当前 Cherry Studio 运行时 Dexie 保持 authoritative（Phase 4 为外部导入，不影响当前运行时）；不基于 chat.db existence / DB initialized / migration 002 做切换；不实现 per-call SQLite→Dexie fallback；`updateFileCount(s)` 保留在 Dexie/FileManager |
| **排除项** | 不修改 `src/preload/index.ts`；不添加 SqliteMessageDataSource；不修改 DbService 路由；不实现 importer / shadow verification / cutover / FTS / canonical files / fallback |
| **退出条件** | ✅ ChatDbAggregateService 实现 14 命令；✅ wire adapters 保留结构化 renderer Message.model/tool-object block content/unknown JSON/nullable 语义；✅ repository factory 支持 root DB 和 transaction executor 绑定；✅ 14 个 IPC handler 含 request/result 运行时验证和结构化错误映射；✅ 155 个 Phase 3.2 tests 通过（aggregate 60 + wireAdapters 29 + ipc 27 + errors 39）；✅ 870+ 个 tests 全部通过（含 Phase 2 161 + shared 199 + 2 persistent renderer timeout failures 被分类为 pre-existing known failures）；✅ typecheck / format 通过 |
| **事务保证** | ① appendMessage: ensure-topic + message insert + block upsert + file-ref sync in one tx；② updateMessageAndBlocks: message patch + block upsert + file-ref sync in one tx；③ updateBlocks: block upsert + file-ref sync in one tx；④ updateSingleBlock: load/merge/update + file-ref delete/create in one tx；⑤ deleteBlocks: one tx, FK cascade for refs；⑥ clearMessages: one tx, FK cascade for refs + segments；⑦ bulkAddBlocks: duplicate check + insert + file-ref sync in one tx |
| **非目标** | 无 Renderer/DbService 路由变更；无 preload 变更；无 per-call fallback；无双写；无 file count 迁移 |

#### Phase 3.3：Preload bridge + Renderer SqliteMessageDataSource + structured model fix

| 属性 | 值 |
|---|---|
| **状态** | **Done** |
| **目标** | Preload fixed named bridge（14 方法）；Renderer SqliteMessageDataSource（exported/unrouted）；Main structured Message.model round-trip 缺陷修复 |
| **交付物** | `src/preload/index.ts` 新增 `window.api.chatDb`（14 个命名方法直接 ipcRenderer.invoke）；`src/renderer/src/services/db/SqliteMessageDataSource.ts`（ChatDbApi 接口 + ChatDbResultError + cloneForWire + MessageDataSource 实现 14 方法）；`src/renderer/src/services/db/index.ts` 导出；`src/main/services/chatDb/wireAdapters.ts` 修复结构化 model round-trip（wireToMessage: 对象→overflow + column null + modelId 提取；messageToWire: 从 overflow 恢复结构化对象；wireToMessagePatch: 对象 model→overflow + null model 清除 overflow）；`__tests__/SqliteMessageDataSource.test.ts`（66 tests）、wireAdapters.test.ts 新增 9 个结构化 model 测试、aggregate.test.ts 新增 5 个结构化 model round-trip 测试 |
| **结构化 model 修复** | ① wire `model` 为结构化 JSON 对象时，完整对象存入 overflow，promoted SQL `model` 列设为 null；② `modelId` 优先使用显式 wire 字段，否则从结构化对象的 `id` 字段提取；③ 读取时 messageToWire 从 overflow 恢复原始结构化对象，不被 column null 覆盖；④ scalar/null 旧行为保留；⑤ patch 传入 null model 时同时清除 overflow（防止历史结构化 model 残留）；⑥ 绝不绑定对象到 SQLite TEXT 列 |
| **Preload bridge** | `window.api.chatDb` 含 14 个命名方法：fetchMessages、getRawTopic、topicExists、ensureTopic、appendMessage、updateMessage、updateMessageAndBlocks、deleteMessage、deleteMessages、updateBlocks、updateSingleBlock、bulkAddBlocks、deleteBlocks、clearMessages；直接 ipcRenderer.invoke，无 tracedInvoke；无通用 command/channel dispatcher；无 SQL/repository API；无 file-count 方法 |
| **Renderer datasource** | 构造函数注入 ChatDbApi（默认 window.api.chatDb）；每个方法调用对应 bridge 方法 + unwrap ChatDbResult；ChatDbResultError 携带 code/message/retryable/details；transport rejection 原样传播；fetchMessages 接受但不发送 forceReload；getRawTopic wire null→renderer undefined；appendMessage -1 sentinel 省略；updateMessageAndBlocks 省略冗余 topicId/sortOrder；updateTopicUpdatedAt 在成功的消息/主题变更后 dispatch；无 file-count 方法；cloneForWire 递归克隆 + 安全验证 |
| **约束** | 当前 Cherry Studio 运行时 Dexie 保持 authoritative（Phase 4 为外部导入，不影响当前运行时）；不修改 DbService 路由；不实现 per-call fallback；不自动切换；`updateFileCount(s)` 保留在 Dexie/FileManager |
| **排除项** | 不修改 DbService 路由或 DexieMessageDataSource；不实现 importer / shadow verification / cutover / FTS / canonical files / fallback；不 commit/push |
| **退出条件** | ✅ 803 个相关 tests 全部通过（shared 199 + Main 538 + renderer 66）；✅ structured model round-trip 通过 aggregate 实测（append+fetch、update+fetch、null-after-structured、coexistence-with-overflow）；✅ preload 14 个方法映射正确；✅ typecheck 通过；✅ 无 DbService/DexieMessageDataSource 变更 |
| **Main 验证边界** | Main 侧 runtime validation 通过 shared contracts 验证 request/result；Renderer 不重复验证 |

#### Phase 3.4：Immutable injected routing policy

> ⚠️ **临时验证 scaffolding**：Phase 3.4 的路由策略注入是用于验证 SQLite 数据源端到端可行性的临时机制。在 Phase 5 SQLite-only runtime 完成时必须移除（C-13）。不是长期运行时开关。

| 属性 | 值 |
|---|---|
| **状态** | **Done** |
| **目标** | DbService 路由策略通过构造注入实现不可变切换；生产环境永久默认 Dexie；SQLite 验证仅限显式构造实例 |
| **交付物** | `src/renderer/src/services/db/routingPolicy.ts`（DbRoutingPolicy 类型 + OrdinaryMessageSource / DexieMessageSource / AgentMessageSource 依赖接口 + DbServiceDeps 构造选项）；`src/renderer/src/services/db/DbService.ts`（公共构造函数 + 不可变注入策略 + 懒加载 SQLite 源 + 永久 Dexie 单例）；`src/renderer/src/services/db/index.ts`（导出路由类型）；`src/renderer/src/services/db/__tests__/DbService.test.ts`（102 tests） |
| **策略语义** | `'dexie'` — 所有普通操作路由到 Dexie；生产默认。`'sqlite-validation'` — 普通操作路由到 SQLite（懒加载，首次普通操作创建一次）；仅限显式构造。`'sqlite-authoritative'` — 保留命名但始终拒绝：构造时同步抛出明确错误；不在运行时使用；Phase 5 移除整个 routingPolicy（C-13） |
| **Agent 路由** | Agent session 操作始终最高优先级、策略无关；不创建 SQLite 源 |
| **文件操作** | `updateFileCount` / `updateFileCounts` 始终使用注入的 Dexie 源，与策略无关；不实例化/调用 SQLite / Agent |
| **混合操作** | `updateBlocks` 按 topicId 分区 agent/ordinary；`updateSingleBlock` 分类 agent/ordinary/unresolved；`bulkAddBlocks` / `deleteBlocks` 路由到配置的普通源 |
| **getSourceType** | Agent 优先返回 `'agent'`；否则返回策略对应的普通源类型（`'dexie'` / `'sqlite'`） |
| **禁止项** | 无环境变量 / Redux / localStorage / 可变 setter / 全局 configure/reset API；无 chat.db 存在检测 / ChatDb 初始化 / migration 002 / 就绪探针；无 per-call fallback / retry-to-Dexie / shadow reads / dual writes |
| **约束** | 当前 Cherry Studio 运行时 Dexie 保持 authoritative（Phase 4 为外部导入，不影响当前运行时）；sqlite-authoritative 构造同步拒绝 |
| **排除项** | 不修改 Main / preload / shared IPC / SqliteMessageDataSource / DexieMessageDataSource / AgentMessageDataSource；不实现 importer / shadow verification / cutover / FTS / canonical files / file-count migration |
| **退出条件** | ✅ 168 个 renderer db tests 通过（DbService 102 + SqliteMessageDataSource 66）；✅ typecheck 通过；✅ format 通过 |

### Phase 4：外部应用兼容性导入管线（A-8 Accepted）

> **产品模型**：用户在 SQLite-authoritative Cherry Chat 中选择一个 Cherry Studio ZIP 备份来导入数据。ZIP 是唯一受支持的源格式，包含原始 Chromium IndexedDB。旧逻辑格式 `data.json` / `.bak` 明确放弃兼容。
>
> **权威语义**：导入过程中现有 SQLite 保持 authoritative。取消支持至最终 promotion 之前。promotion 短时不可取消、保留一个回滚快照、重开/检查 DB、成功后 relaunch。

#### Phase 4.0：Isolated-profile feasibility spike

| 属性 | 值 |
|---|---|
| **状态** | **Done — Go on macOS arm64 (2026-07-21)** |
| **目标** | 验证 `session.fromPath()` / isolated profile + 正确 origin 创建隔离 Electron Session 的跨平台可行性 |
| **方法** | 最小 spike：在 macOS 上从临时路径 `session.fromPath(absolutePath, { cache: false })` 创建 session profile；验证可正确加载 IndexedDB 并通过当前 Dexie declaration + upgrade functions 识别和升级数据 |
| **API 修正** | Electron 41.2.1 API 为静态 `session.fromPath(absolutePath, { cache: false })`；`session.defaultSession.fromPath()` 不存在。代码中已使用正确 API |
| **Origin 观测** | 正确 origin 为 `file://`（通过 `pathToFileURL` 加载 renderer HTML）；一个不同的 loopback HTTP origin（`http://127.0.0.1:<port>`）不暴露 CherryStudio，不创建空 DB（仅使用 `indexedDB.databases()` 时） |
| **Profile 映射观测** | 在测试的 file:// origin 下，IndexedDB 数据位于 `IndexedDB/file__0.indexeddb.leveldb/`。此为观测结果，非通用硬编码规则——不同 origin 类型可能产生不同映射 |
| **Dexie 版本映射** | logical 4 → native 40；logical 11 → native 110；logical 12 → native 120。乘数为 ×10（与 Dexie 1-3 相同）。当前 CherryStudio: logical v11 / native 110 |
| **升级路径验证** | v4 fixture（native 40）通过 production Dexie upgrades (v5→v7→v8→v11) 成功升级到 logical 11/native 110；验证了 v5 date conversion、v5 tavily→webSearch、v7 referential consistency、v8 language settings；topic_segments 表在升级后存在 |
| **未来版本拒绝** | v12 fixture（native 120）在 production opener 启动前被正确拒绝（futureVersionRejected=true，productionOpenerStarted=false） |
| **隔离验证** | default session 在 fresh spike-owned userData 中不含 CherryStudio；A/B markers 不跨 session；sentinel marker 不泄漏到 candidate session；wrong-origin probe 确认 CherryStudio absent at HTTP origin 且不创建空 DB |
| **Local Storage** | IDB-only profile（无 Local Storage 目录）与 full-profile（IndexedDB + Local Storage）产生完全相同的 CherryStudio discovery 和 read 结果。仅 full-profile 暴露 LS control marker。LS 非 discovery/read 必需 |
| **清理验证** | 10/10 fresh-root macOS arm64 迭代全部通过；child 正常退出（exit 0）；owned roots 在 exit 后删除，全部首次成功（cleanupAttempts=1）；无 owned leftovers |
| **No-go 回退** | 专用隔离 Electron helper 进程（非破坏性恢复、非直接 LevelDB 解析）。**状态：contingency only，未选用** — same-process approach 在测试平台上满足 Phase 4.0 Go |
| **未验证** | Windows/Linux；跨平台 fixture 可移植性；真实 ZIP snapshot 一致性/损坏处理（→ Phase 4.1） |
| **退出条件** | ✅ macOS arm64 上 fromPath + origin + Dexie schema 读取验证通过；✅ v4→v11 升级验证通过；✅ v12 拒绝验证通过；✅ session 隔离验证通过；✅ LS 非必需验证通过；✅ 清理稳定性验证通过 |

#### Phase 4.1：Secure ZIP intake + isolated IndexedDB source reader

| 属性 | 值 |
|---|---|
| **状态** | **Done** |
| **前置** | Phase 4.0 spike 通过（或回退 helper 进程设计完成） **Done** |
| **目标** | 安全解压 Cherry Studio ZIP 到唯一临时工作区；通过隔离 Session + 隐藏 sandboxed import renderer 读取源 IndexedDB |
| **主要任务** | ZIP 解压 + 路径校验（必须含 Chromium IndexedDB 结构）；唯一临时工作区创建/清理；隔离 Session profile + 正确 origin 创建；隐藏 sandboxed BrowserWindow 加载 import renderer；import renderer 初始化当前 Dexie schema/upgrades against isolated profile；窄 import-only IPC（分页）将逻辑数据传输到 Main |
| **源数据约束** | 受支持源：Cherry Studio ZIP 备份含原始 Chromium IndexedDB。当前 IndexedDB schema 为主源。旧 IndexedDB 仅在当前 Dexie declaration/upgrades 可防御性识别并升级为当前逻辑形态时才接受 |
| **缺失值规则** | 缺失值继承当前 Cherry Studio/Dexie upgrade 和 reader 语义。不创建 importer-specific 历史修复。不推断缺失 ID、ownership、timestamp、role、status、model 等字段。结构不可用数据被拒绝 |
| **排除项** | 不解析 LevelDB（Main 不直接解析）；不恢复源到目标 app 的正常 Dexie profile；不扫描磁盘查找其他应用；不要求共享目录 |
| **退出条件** | ✅ 安全 ZIP 解压 + IndexedDB 结构校验通过（5 层校验 + 通用 IndexedDB 探测）；✅ 隔离 Session 成功加载源数据（`session.fromPath(destDir, {cache:false})` + file:// origin）；✅ import renderer 通过 current Dexie schema 读取数据（`indexedDB.databases()` discovery + production Dexie upgrades v4→v11 + future-version gate ≥120）；✅ 分页 IPC 将逻辑数据传输到 Main（Main 驱动 Discover→ReadPage cursor progression；源 reader 分页读完后 self-complete 并精确一次（exact-once）发送 `candidate-ready` 信号；Phase 4.2 接收该信号后启动候选 DB 批量写入，非由 Phase 4.1 内 onReadyForBulk 启动 bulk）；✅ 取消支持：用户可在 promotion 前中断，源数据和现有 SQLite 不受影响；✅ 平台拒绝（A-9 macOS-first）；✅ spike harness 保留（A-10）；✅ 主进程 977/977 测试通过；✅ 2 轮独立审计阻塞修复后最终 Clean |

#### Phase 4.2：Candidate SQLite bulk importer

| 属性 | 值 |
|---|---|
| **状态** | **Done** (2026-07-27) |
| **前置** | Phase 4.1 完成（Done） |
| **目标** | 从分页逻辑数据构建完整候选 SQLite 数据库 |
| **实际交付范围** | `CandidateDbResource`（per-session 自有候选目录，内含独立 `chat.db`）；`ChatImportDataPlane`（Main 侧分页数据面，承载 `SourceReadStats`）；`ChatImportWriter`（import-only 保序 writer，order-preserving，`candidate-ready` exact-once）；`startupRecovery`（启动清理：取消/错误/孤儿候选目录清理） |
| **候选布局** | 每个导入会话拥有独立临时目录，目录内持有候选 `chat.db`；会话结束（promotion 成功或取消/失败）后目录被清理，不污染 live `Data/chat.db` |
| **主要任务** | 分页接收 import-only IPC 数据（Main page 背压：Main 驱动 Discover→ReadPage，源 reader 按页就绪后精确一次发送 `candidate-ready`）；通过 Phase 2 repository 层（TopicsRepository 等）批量写入候选 DB；每页一个事务（one transaction/page）；import-only 保序写入（order-preserving，不重排源顺序）；topic/message 扁平化后写入；block/segment/file-reference 精确映射；replace-all 语义（非 merge） |
| **统计语义** | `SourceReadStats`（源读取侧：从源 IndexedDB 读取的待导入逻辑计数）与 `CandidateImportStats`（候选 DB 写入侧：实际写入候选 DB 的计数）分离，验证阶段对照，不混用 |
| **数据流** | import renderer（源 IndexedDB → 逻辑 DTO）→ IPC 分页（Main page 背压）→ Main `ChatImportDataPlane`/`ChatImportWriter`（候选 chat.db 批量写入，每页一事务，保序）→ `candidate-ready`（exact-once）→ Phase 4.3 验证 |
| **失败/清理** | 取消/错误/孤儿候选目录由 `startupRecovery` 在下次启动确定性清理；现有 live SQLite 不受影响；候选 DB 可安全丢弃 |
| **退出条件** | ✅ 10k 消息完整导入到候选 DB；✅ 导入中断后候选 DB 可安全丢弃，现有 SQLite 不受影响；✅ 导入耗时记录（10k 基准见下）；✅ 单元审计 + 最终审计 0 阻塞（final audit 0 blockers）；✅ 聚焦测试证据通过（focused test evidence）；✅ 全量本地验证通过（2026-07-27）：`pnpm format` exit 0 无改动；`pnpm lint` exit 0（node/web/aicore typecheck 全过、i18n 校验通过、0 errors，仅 pre-existing warnings）；`pnpm test` exit 0，252 文件 / 5325 通过 / 72 跳过；无遗留产物（local-only full validation，未涉及 commit/push/CI） |

**10k 基准证据（真实运行）**：
- 数据集：25 个 topics、10,000 条 messages、11,000 个 blocks、26 个 segments、250 条 topic_segment_memberships、667 条 file references、19 页分页
- 两次独立运行耗时：约 1016.2ms 与 978.5ms
- 完整性：`PRAGMA integrity_check` 通过（ok）；`PRAGMA foreign_key_check` 结果为空（无外键违例）
- 不变量：现有 live `chat.db` 未被改动（import 仅写候选 DB）

#### Phase 4.3：Deterministic verification

| 属性 | 值 |
|---|---|
| **状态** | Not started |
| **前置** | Phase 4.2 完成 |
| **目标** | 对候选 SQLite DB 执行全面验证，确保数据完整且结构正确 |
| **验证维度** | ① 源 vs 目标 ID 集合匹配；② 每表记录数一致；③ 关键字段内容哈希比对；④ 消息 sort_order 与源顺序一致；⑤ 外键引用完整性；⑥ 关系正确性（topic→message→block、segment→message）；⑦ file-reference 快照完整性；⑧ segment 完整性；⑨ 结构化 model/tool object 完整性；⑩ overflow 数据；⑪ `PRAGMA integrity_check`；⑫ `PRAGMA foreign_key_check`；⑬ 应用层抽样读取（通过 repository 查询典型数据路径） |
| **退出条件** | ✅ 所有验证维度通过；✅ 验证失败有明确的错误报告和诊断信息 |

#### Phase 4.4：Atomic replace-all promotion

| 属性 | 值 |
|---|---|
| **状态** | Not started |
| **前置** | Phase 4.3 验证通过 |
| **目标** | 将验证通过的候选 SQLite DB 原子替换为 live `chat.db` |
| **主要任务** | 关闭现有 chat.db 连接；保留一个 rollback 快照（当前 live chat.db）；原子 rename 候选 DB → `Data/chat.db`；重新打开并验证新 DB（`PRAGMA integrity_check` + `PRAGMA foreign_key_check`）；成功 → relaunch app；失败 → 回滚到快照 DB 并报告错误 |
| **崩溃恢复** | 如果在快照创建和候选 rename 之间发生崩溃：原始 `chat.db` 保持完整（快照是副本，rename 未执行）。启动时检测孤立的快照/临时工作区文件（例如 `chat.db.pre-import-backup`、候选 DB 临时路径），通过确定性启动清理安全删除或保留（保留用于诊断，下次启动清理）。不影响正常启动路径 |
| **约束** | promotion 短时不可取消；保留一个回滚快照；重开/检查 DB；成功后 relaunch |
| **退出条件** | ✅ 原子替换成功 → reopen → relaunch 流程完成；✅ 失败回滚到快照 DB 流程验证；✅ 一个回滚快照保留 |

### Phase 5：SQLite-only 运行时完成

| 属性 | 值 |
|---|---|
| **状态** | Not started |
| **前置** | Phase 4 完成（至少一次成功端到端导入） |
| **目标** | Cherry Chat 普通聊天路径完全使用 SQLite，移除 Dexie 路由和临时验证 scaffolding |
| **主要任务** | DbService 默认路由直连 SQLite（无 Dexie 路由、无 routingPolicy 注入策略）；移除 Phase 3.4 路由策略代码（C-13）；Dexie 仅保留在隔离 import renderer 内部；从普通聊天路径移除 DexieMessageDataSource（C-11）；清理 Renderer 直接 Dexie 访问（C-10）；性能基准验证（不低于 Dexie 基线） |
| **退出条件** | ✅ 普通聊天路径无 Dexie 依赖；✅ Phase 3.4 routing scaffolding 完全移除；✅ 性能不低于 Dexie 基线；✅ 所有现有测试通过；✅ CI 绿色 |

### Phase 6：Cherry Chat 备份/恢复分离、UX 硬化、清理

| 属性 | 值 |
|---|---|
| **状态** | Not started |
| **前置** | Phase 5 完成 |
| **目标** | Cherry Chat 自身备份/恢复与 Cherry Studio ZIP 导入的 UX 完全分离；清理所有遗留 |
| **主要任务** | Cherry Chat 原生备份/恢复（SQLite online backup）独立于 Cherry Studio ZIP 导入 UX；清理 Group D + Group E 遗留项；更新文档；确认备份协调完整；移除不再需要的隔离 import renderer 代码（如果已完成导入且不再需要） |
| **退出条件** | ✅ Cherry Chat 备份/恢复独立运作；✅ Cherry Studio ZIP 导入作为一次性操作独立运作；✅ Group D/E 清理完成；✅ 文档更新；✅ CI 绿色 |

---

## 10. 导入数据流、权威语义、取消/回滚、验证规则

### 导入数据流（端到端）

```
用户选择 Cherry Studio ZIP
         │
         ▼
┌─── 4.1 Secure ZIP Intake ───┐
│ · 解压到唯一临时工作区       │
│ · 验证 ZIP 内含 Chromium IDB │
│ · 校验 IndexedDB 结构完整性  │
└──────────┬──────────────────┘
           │
           ▼
┌─── Isolated Session + Import Renderer ───┐
│ · session.fromPath() / isolated profile  │
│ · 正确 origin + 当前 Dexie schema        │
│ · 隐藏 sandboxed BrowserWindow           │
│ · 不恢复到正常 Dexie profile              │
│ · 旧 IDB 仅在 Dexie upgrades 可识别时接受 │
└──────────┬───────────────────────────────┘
           │ narrow import-only IPC (分页逻辑 DTO)
           ▼
┌─── 4.2 Candidate SQLite Bulk Import ───┐
│ · Main 不解析 LevelDB                   │
│ · 使用 Phase 2 repository 层批量写入    │
│ · 独立候选 DB 文件                       │
│ · replace-all 语义，非 merge             │
└──────────┬──────────────────────────────┘
           │
           ▼
┌─── 4.3 Deterministic Verification ─────┐
│ · 源 vs 目标 ID/计数/字段/顺序/关系/哈希│
│ · file-reference 快照、segments          │
│ · 结构化 model/tool object、overflow     │
│ · PRAGMA integrity_check                 │
│ · PRAGMA foreign_key_check               │
│ · 应用层抽样读取                          │
└──────────┬──────────────────────────────┘
           │
           ▼
┌─── 4.4 Atomic Replace-All Promotion ───┐
│ · 关闭现有 chat.db 连接                 │
│ · 保留一个 rollback 快照                 │
│ · 原子 rename 候选 → live chat.db       │
│ · reopen + integrity_check               │
│ · 成功 → relaunch                        │
│ · 失败 → 回滚到快照 + 报告               │
│ · promotion 短时不可取消                 │
└─────────────────────────────────────────┘
```

### 权威语义

| 阶段 | authoritative store | 说明 |
|---|---|---|
| Phase 0–3（运行时） | Dexie (IndexedDB) | 当前 Cherry Studio 唯一真实来源 |
| Phase 4（导入过程中） | 现有 live SQLite（如果有） | 导入读取源 ZIP，不影响现有 DB |
| Phase 4.4 promotion | 候选 SQLite → 原子替换 → 新 live SQLite | promotion 短时窗口内无 authoritative（连接已关闭） |
| Phase 5+（最终态） | SQLite (chat.db) | Cherry Chat 唯一真实来源；Dexie 仅存在于隔离 import renderer |

### 取消支持

- **Phase 4.1–4.3**：用户可在任何时刻取消。源 ZIP 解压数据可安全丢弃。候选 DB 可安全丢弃。现有 SQLite 不受影响。
- **Phase 4.4 promotion**：不可取消。promotion 是短时原子操作（关闭连接 → rename → reopen → relaunch）。

### 回滚策略

1. **promotion 失败**：自动回滚到 promotion 前保留的快照 DB
2. **post-promotion 发现问题**：手动恢复快照 DB（保留一个快照）
3. **导入中途取消**：丢弃临时工作区和候选 DB，现有 SQLite 不受影响
4. **ZIP 格式不可识别**：拒绝导入，报告错误，不影响现有 DB

### 安全归档约束

- ZIP 是唯一受支持的源格式（Cherry Studio ZIP 备份含原始 Chromium IndexedDB）
- 不解析 `data.json` / `.bak`（明确放弃）
- 旧 IndexedDB 仅在当前 Dexie declaration/upgrades 可防御性识别时才接受
- 结构不可用数据被拒绝（不修复、不推断）

### 验证/默认规则

- 缺失值继承当前 Cherry Studio/Dexie upgrade 和 reader 语义
- 不创建 importer-specific 历史修复
- 不推断缺失 ID、ownership、timestamp、role、status、model 等字段
- replace-all 语义：导入覆盖整个目标 DB，不与现有数据 merge

---

## 11. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| **Phase 4.0 fromPath 跨平台不可行** | 导入管线无法使用隔离 Session 读取源 IndexedDB | **macOS arm64: Resolved**（`session.fromPath()` 可行）。**Windows/Linux: Open**（未测试）。no-go 回退为专用隔离 Electron helper 进程（非破坏性恢复、非直接 LevelDB 解析）——contingency only，未选用 |
| **源 ZIP 结构不可识别** | 导入被拒绝 | 严格的 ZIP 内 IndexedDB 结构校验；明确的错误报告；不影响现有 DB |
| **旧 IndexedDB schema 不可升级** | 旧版本备份导入被拒 | 仅接受当前 Dexie declaration/upgrades 可防御性识别的版本；版本校验前置 |
| **导入性能（大型 ZIP）** | 大数据量导入耗时过长 | 分页传输；批量写入；性能基准记录（Phase 4.2） |
| **promotion 失败导致数据丢失** | 无法恢复到导入前状态 | promotion 前保留一个 rollback 快照；失败自动回滚；reopen + integrity_check |
| 流式 IPC 性能 | 大消息量下 IPC 序列化/反序列化开销 | 批次阈值需基准测试确定 |
| 备份一致性 | 备份期间数据写入导致不一致 | **Resolved**（A-6 Accepted）：online backup adapter（better-sqlite3 `backup()`）；BackupManager 全操作协调 |
| 备份并发 | 多来源同时触发备份导致冲突 | 备份操作全局互斥 |
| 文件系统非事务 | SQLite 文件操作非原子 | WAL 模式；备份使用临时文件+rename |
| 多窗口并发 | 多个 Renderer 窗口同时写入 | Main 单写；Renderer 通过 IPC 串行化 |
| 旧备份兼容 | 迁移后备份格式变化 | Cherry Chat 原生备份（Phase 6）与 Cherry Studio ZIP 导入分离 |
| 性能未知 | SQLite 在 Electron 中的实际表现未测试 | Phase 5 切换前必须完成基准测试 |
| 技术栈选型 | ~~libSQL+Drizzle 可能不是最优选择~~ | **Resolved**（A-7 Accepted：better-sqlite3 + Drizzle） |

---

## 12. 验收指标 / Go-No-Go

### Phase 4 exit criteria（导入管线）

| 指标 | 目标 | 状态 |
|---|---|---|
| Phase 4.0 spike | fromPath + origin + Dexie schema 跨平台验证通过（或 helper 进程回退设计完成） | **Done — Go on macOS arm64** (Windows/Linux open; helper contingency recorded) |
| ZIP 安全解压 | 唯一临时工作区 + IndexedDB 结构校验 | **Done** |
| 隔离 Session 读取 | import renderer 通过当前 Dexie schema 成功读取源数据 | **Done** |
| 候选 DB 构建 | 10k 消息完整导入；导入中断不损坏现有 DB | **Done** |
| 验证全通过 | ID/计数/字段/顺序/关系/哈希/integrity_check/foreign_key_check/应用层抽样 | Not started |
| 原子 promotion | 成功 → reopen + relaunch；失败 → 回滚到快照 | Not started |
| 取消支持 | promotion 前任意步骤取消不损坏现有 DB | Not started |

### Phase 5 exit criteria（SQLite-only runtime）

| 指标 | 目标 | 状态 |
|---|---|---|
| 消息加载延迟（p50/p95） | 不退化 | Not started |
| 消息写入吞吐 | 不退化 | Not started |
| 数据完整性 | 100% | Not started |
| 冷启动 DB 打开时间 | < 500ms | Not started |
| 普通聊天路径无 Dexie 依赖 | 0 Dexie 引用 | Not started |
| Phase 3.4 routing scaffolding | 完全移除 | Not started |
| 所有测试通过 + CI 绿色 | 100% | Not started |

### Phase 6 exit criteria（备份/恢复分离 + 清理）

| 指标 | 目标 | 状态 |
|---|---|---|
| Cherry Chat 原生备份/恢复 | 独立运作（online backup adapter） | Not started |
| Cherry Studio ZIP 导入 | 作为一次性操作独立运作 | Not started |
| Group D/E 清理 | 全部完成 | Not started |
| 文档更新 | 反映最终状态 | Not started |
| CI 绿色 | 100% | Not started |

**Go 条件（Phase 4→5）**：
- Phase 4 所有 exit criteria 通过
- 至少一次成功端到端导入（真实 Cherry Studio ZIP → SQLite-only runtime）

**No-Go 条件**：
- Phase 4.0 spike 失败且 helper 进程回退不可行
- 验证维度任一关键项失败
- promotion 回滚机制不工作

---

## 13. Open Questions

| # | 问题 | 影响范围 | 状态 |
|---|---|---|---|
| Q-1 | libSQL + Drizzle vs better-sqlite3 / 其他方案？ | A-7 技术栈决策 | **Resolved**：选择 better-sqlite3 + Drizzle ORM（A-7 Accepted） |
| Q-2 | chat.db 是否未来统一为 app.db（合并 Memory/Knowledge）？ | 架构长期演进 | Open |
| Q-3 | 文件元数据首期迁移深度：仅 references 还是包含 files 表全量？ | Phase 2 范围 | **Resolved**：Phase 2 使用 block-linked file references，每条引用携带完整元数据快照（file_name, file_path, file_type 等）；不建 canonical files 表。canonical files 表推迟到 FileManager 全局迁移前做显式决策 |
| Q-4 | 流式批次阈值：多大消息量触发分批 IPC？ | Phase 4.1 import IPC 分页 | Open |
| Q-5 | 搜索/FTS 首期是否实现？schema 预留还是 Phase 6 再加？ | Phase 2 schema | **Resolved**：Phase 2 不含 FTS；后续通过 append-only migration 添加，时机为搜索 projection 设计完成时 |
| Q-6 | 遗留 agents.db 用户文件处理：归档提示还是自动清理？ | Group E 清理 | Open |
| Q-7 | 备份协调的具体实现：WAL checkpoint 还是 backup API？ | A-6 备份策略 | **Closed/Accepted**：online backup API（better-sqlite3 `backup()`）封装为可替换 adapter，`BackupManager` 全操作协调；不使用 live WAL raw copy（A-6 Accepted） |
| **Q-8** | **Phase 4.0 fromPath 跨平台可行性？** | **Phase 4.0 spike** | **Resolved (macOS arm64) / Open (Windows/Linux)**：macOS arm64 上 `session.fromPath()` + file:// origin + isolated profile 成功加载 IndexedDB；v4→v11 升级通过；v12 拒绝通过；session 隔离通过；LS 非必需；10/10 清理稳定。Windows/Linux 未测试。helper 进程回退仍为 contingency |
| **Q-9** | **Windows/Linux `session.fromPath` + 文件锁 + 清理行为** | **Phase 4.1 production 化（A-9）** | **Deferred 至 macOS-first 完成后**。Phase 4.1 实施期间不验证（A-9 Accepted）。未来开放路径：删 `process.platform !== 'darwin'` 拒绝 + 重跑 Phase 4.0 spike harness 于 Windows/Linux（harness 保留至 Phase 5）+ 调 `tempWorkspace.ts`/`isolatedSession.ts` 清理退避参数。重点未验证项：NTFS 不能删打开文件（EBUSY 重试策略）、Windows `session.fromPath` 锁文件/缓存语义、Linux 不同 filesystem 行为 |
| **Q-10** | **真实 ZIP snapshot 损坏/不完整检测策略划分** | **Phase 4.1 vs 4.3** | **4.1 最小，4.3 全面**。Phase 4.1 仅做：① ZIP 结构 5 层校验（大小/条目数/单条/总量/加密；zip-slip 用 `path.resolve` 跨平台防护）；② IndexedDB 目录存在性 + 含 `.ldb` 子目录的通用探测（不硬编码 `file__0.indexeddb.leveldb`，spike 观测仅为 file:// origin 下情况）；③ `indexedDB.databases()` discovery 成功。**完整损坏/不完整检测延后至 Phase 4.3** Verification（源 vs 目标 ID/计数/字段/顺序/关系/哈希/integrity_check/foreign_key_check/应用层抽样）。Phase 4.1 不引入 importer-specific 历史修复（继承 A-8 约束） |
| **Q-11** | **Phase 4.0 17 个 harness 文件去留** | **Phase 4.1 production 化（A-10）** | **Resolved**：保留至 Phase 5（A-10 Accepted）。`PHASE4_SPIKE=1` 门控继续生效，不进生产构建。详见 A-10 |
| **Q-12** | **Import renderer 用专用独立 HTML 入口还是复用 spike 窗口模式** | **Phase 4.1 构建** | **Resolved**：新增专用 `src/renderer/src/windows/chatImport/chatImport.html` 为永久产物入口。不复用 spike `phase4Spike.html`（污染隔离语义）。需 `electron.vite.config.ts` 加入新 HTML 入口 + 新 preload entry（`src/preload/chatImport/index.ts` → `chat-import-preload.js`）。spike HTML 连同 harness 一并 Phase 5 删除 |

---

## 14. 决策日志

| 日期 | 决策 / 事件 | 说明 |
|---|---|---|
| 2026-07-19 | 完成资产调查 | 确认当前无 chat.db、无通用 Main SQLite migration 框架、核心聊天仍在 Renderer Dexie |
| 2026-07-19 | 决定独立 chat.db（A-1 Accepted） | 不复用 agents.db（无代码 owner，schema 不兼容） |
| 2026-07-19 | 确认 agents SQLite 不存在且残留待清理 | agents:* scripts 指向不存在 config；drizzle-kit/drizzle-orm 残留 |
| 2026-07-19 | 创建本迁移文档 | 作为长期决策和阶段状态追踪单一事实源 |
| 2026-07-19 | A-7 Accepted：better-sqlite3 + Drizzle ORM + drizzle-kit | Node.js 生态最成熟 SQLite 驱动，同步 API，Drizzle 官方主推组合；与未来 PowerSync 集成兼容（PowerSync 首选 better-sqlite3） |
| 2026-07-19 | A-5 Accepted：一次性切换 + Dexie 快照回滚 | 个人 repo，无 SLA 约束；导出 Dexie→SQLite 后切换路由，旧 Dexie 文件作为回滚快照；切换后观察数天确认稳定；不采用双写 |
| 2026-07-20 | A-6 Accepted：online backup adapter + full-operation coordination | better-sqlite3 `backup()` API 封装为可替换 adapter；BackupManager 协调互斥锁、staging、生产路径过滤、恢复后 integrity check；未来可替换为 PowerSync；不使用 live WAL raw copy |
| 2026-07-20 | Q-7 Closed/Accepted | 备份协调采用 online backup API（better-sqlite3 `backup()`）作为 adapter，BackupManager 全操作协调 |
| 2026-07-20 | Phase 1 完成 | ChatDbService 生命周期硬化；WAL/fk/synchronous/busy_timeout pragmas；inline build-safe initial migration；integrity check；restored-first-open repair gating；startup/will-quit wiring；replaceable online backup adapter；BackupManager full-operation coordination；production-path tests |
| 2026-07-20 | Phase 2 完成 | Append-only migration 002；Main-local DTO/codec/mappers/typed cursors；TopicsRepository、MessagesRepository、BlocksRepository、TopicSegmentsRepository、FileReferencesRepository；CRUD/batches/keyset pagination/dense ordering/ownership/cascades/rollback 测试（real better-sqlite3） |
| 2026-07-20 | Q-3 Resolved | block-linked file references 携带完整元数据快照；canonical files table 推迟到 FileManager 全局迁移前显式决策 |
| 2026-07-20 | Q-5 Resolved | Phase 2 不含 FTS；后续 append-only migration 添加，时机为搜索 projection 设计完成时 |
| 2026-07-20 | TopicSegmentsRepository 澄清 | 原 Phase 2 规划遗漏 TopicSegmentsRepository；Phase 2 实际交付包含该 Repository |
| 2026-07-20 | Phase 3.1 完成 | 14 个 ChatDb IPC channels 定义；packages/shared/chatDb/ 新增 types/result/validation/contracts/index；JSON wire validation（深度限制 20、拒绝 undefined/bigint/symbol/NaN/Date/Map/Set/Buffer/class instances/sparse arrays）；result envelope（ok/fail/isSuccess/isFailure）；command contracts（allowedKeys + validate）；199 个 shared tests 通过（初始完成时为 107，后续扩展至当前 199）；Dexie-authoritative / no-auto-switch / no-per-call-fallback 约束文档化 |
| 2026-07-20 | Phase 3.2 完成 | ChatDbAggregateService（14 命令实现）；repository factory（root DB / transaction 绑定）；wire adapters（JSON ↔ Domain，保留结构化 renderer model/tool-object/unknown JSON/nullable 语义）；errors.ts（错误映射 9 类）；ipc.ts（14 个 IPC handler 注册 + request/result 运行时验证 + 结构化错误映射 + disposer）；shared contract 修正（blocks 数组前置验证、identity/reparenting 拒绝、所有权一致性、新错误码）；78 个新 tests 通过（aggregate 39 + wireAdapters 20 + ipc 19）；438 个 tests 全部通过（Phase 3.2 初始完成时的快照基线） |
| 2026-07-20 | Phase 3.2 审计修复 | 修复 9 项审计发现：① fetchMessages topic priming（同一事务 ensure + return empty）；② updateBlocks/updateSingleBlock/deleteBlocks/clearMessages 全部使用 root-bound tx + tx-bound repos；③ clearMessages 移除 fileRefs.deleteByMessage()（依赖 FK cascade）；④ 引入 typed aggregate errors（6 种）+ SQLite structured code inspection + 优先级排序；⑤ IPC handler 使用 validateChatDbResult + malformed result ERR_STORAGE fallback；⑥ channel 类型为 ChatDbChannel；⑦ 错误消息 sanitize（不泄露 SQL/path/stack）；⑧ generic storage error non-retryable；⑨ 53 个新 tests（跨仓库回滚、cascade、error mapping、malformed result、topic priming）；131 个 Phase 3.2 tests 通过，932 个 total tests 通过（审计修复后的快照基线） |
| **2026-07-20** | **A-8 Accepted：外部应用兼容性导入（策略更正）** | **产品策略更正**：SQLite-authoritative Cherry Chat 是独立于当前 Cherry Studio 的应用。导入源是用户选择的 Cherry Studio ZIP 备份（含原始 Chromium IndexedDB），不是当前运行时 Dexie。技术路线：安全解压→隔离 Session + import renderer→分页 IPC→候选 SQLite→验证→原子替换。A-5（in-place Dexie→SQLite shadow/cutover）被 A-8 正式替代。旧模型的矛盾：启动时自动迁移、基于本地 Dexie 的 durable cutover、shadow-mode readiness gates、archive source ambiguity、legacy JSON 兼容——全部废弃 |
| **2026-07-21** | **A-9 Accepted：Phase 4.1 macOS-first + 平台拒绝** | Phase 4.0 spike 仅在 macOS arm64 验证。Windows/Linux `session.fromPath` + 文件锁 + 清理未验证，配开发环境成本远超此轮验证价值，且 Phase 4.4 原子替换在 Windows 文件锁下更敏感会稀释本轮价值。生产代码入口 `process.platform !== 'darwin'` → 拒绝。清理分支预先写好 bounded retry + EBUSY 退避 + crash-recovery scan，未来开放 Windows ≈ 删一行拒绝 + 重跑 spike + 调清理参数 |
| **2026-07-21** | **A-10 Accepted：Phase 4.0 harness 保留至 Phase 5** | 17 个 harness 文件保留至 Phase 5（与 Group D 一并）。`PHASE4_SPIKE=1` 门控不进生产构建。Phase 4.1 生产模块独立新增 `src/main/services/chatDbImport/` + `src/preload/chatImport/` + `src/renderer/src/windows/chatImport/`，不复用 spike 代码。spike 专属（argv/exit/fixture/IPc multiplexer/A-B markers）丢弃，可复用硬事实（fromPath + file:// origin + indexedDB.databases + production Dexie upgrades + sender.id 校验 + will-navigate/setWindowOpenHandler deny）由生产模块重新干净实现 |
| **2026-07-21** | **Phase 4.1 只读诊断完成** | Fresh Analyzer 产出 Phase 4.1 source-reader 侧生产化方案：① 模块划分（chatDbImport/ 下 zipIntake/isolatedSession/tempWorkspace/importIpc/index + 专用 preload/import renderer HTML）；② ZIP 库复用 node-stream-zip（BackupManager/DxtService 已用，零新依赖），5 层校验（500MB/10k条目/200MB单条/2GB总量/拒加密 + zip-slip path.resolve 跨平台 + IndexedDB 目录通用探测）；③ Import-only IPC 6 channel（ChatImport_Ready/Discover/ReadPage/Cancel/Complete/Error）独立于 14 个 ChatDb_*；envelope `sessionId+phase+version:1`；DTO 复用 Dexie 逻辑形状不引 import-specific；④ 12 条 correctness risks 全部本轮内处理；⑤ 决策待用户拍板项：跨平台策略、spike 去留、import renderer HTML 入口——均已闭环（A-9/A-10/Q-12） |
| **2026-07-21** | **Phase 4.1 source-reader 生产化完成** | 17 个新文件 + 4 个修改文件：`src/main/services/chatDbImport/`（errors/tempWorkspace/zipIntake/isolatedSession/importIpc/index + 5 tests），`src/preload/chatImport/index.ts`，`src/renderer/src/windows/chatImport/`（chatImport.html + entryPoint.ts），`packages/shared/chatImport/`（types/index/validation.test.ts），`packages/shared/IpcChannel.ts` 6 ChatImport_* entries，`electron.vite.config.ts` chatImport HTML + preload entry，`src/main/ipc.ts` + `src/main/index.ts` 注册/will-quit/app-ready wiring。安全：5 层 ZIP 校验 + `session.fromPath(destDir)` + `location.protocol` origin 校验 + `event.senderFrame` sender 校验 + singleton + R-1..R-12 全部 mitigated。主进程 977/977 测试通过。最终 Auditor Clean。合入 commit `6a1e98e7ef` |
| **2026-07-27** | **Phase 4.2 Done** | Candidate SQLite bulk importer 完成。实际模块：`CandidateDbResource`（per-session 自有候选目录 + 候选 chat.db）、`ChatImportDataPlane`（分页数据面 + `SourceReadStats`）、`ChatImportWriter`（import-only 保序 writer，order-preserving，`candidate-ready` exact-once，`CandidateImportStats`）、`startupRecovery`（取消/错误/孤儿清理）。每页一事务、topic/message 扁平化、block/segment/file-reference 精确映射、replace-all 语义；`SourceReadStats` vs `CandidateImportStats` 分离。10k 基准：25 topics / 10,000 messages / 11,000 blocks / 26 segments / 250 memberships / 667 file refs / 19 pages；两次运行 1016.2ms、978.5ms；`integrity_check` ok、`foreign_key_check` 空、live DB 未改。单元审计 + 最终审计 0 阻塞；聚焦测试通过；全量本地验证通过（2026-07-27）：`pnpm format` exit 0 无改动；`pnpm lint` exit 0（node/web/aicore typecheck 全过、i18n 校验通过、0 errors，仅 pre-existing warnings）；`pnpm test` exit 0，252 文件 / 5325 通过 / 72 跳过；无遗留产物（local-only full validation，未涉及 commit/push/CI） |

---

## 15. 进度日志

| 日期 | 阶段 | 进展 |
|---|---|---|
| 2026-07-19 | Phase 0 | 资产调查完成（Done） |
| 2026-07-19 | Phase 0 | Group A 清理完成（Done）：C-1 agents scripts 已删除，C-6 README 标记废弃，C-8 CLAUDE.md 已清理 |
| 2026-07-19 | Phase 1 | 骨架完成（In progress）：better-sqlite3 + Drizzle ORM 安装；ChatDbService、schema、migration runner、repository 目录已创建；TypeScript 编译通过 |
| 2026-07-19 | 决策 | A-7 Accepted（better-sqlite3 + Drizzle ORM，PowerSync 兼容）；A-5 Accepted（一次性切换 + Dexie 快照回滚） |
| 2026-07-20 | Phase 1 | 完成（Done）：ChatDbService 生命周期硬化；WAL/fk/synchronous/busy_timeout pragmas；inline build-safe initial migration；integrity check；restored-first-open repair gating（repair-required 时 app 继续运行，chat DB 不可用）；startup/will-quit wiring；replaceable online backup adapter（better-sqlite3 `backup()`）；BackupManager full-operation coordination（互斥锁、staging、生产路径过滤）；production-path tests |
| 2026-07-20 | 决策 | A-6 Accepted（online backup adapter + full-operation coordination）；Q-7 Closed/Accepted |
| 2026-07-20 | Phase 2 | 完成（Done）：append-only migration 002；Main-local DTO/codec/mappers/typed cursors；TopicsRepository、MessagesRepository、BlocksRepository、TopicSegmentsRepository、FileReferencesRepository；block-linked file references（完整元数据快照）；CRUD/batches/keyset pagination/dense ordering/ownership/cascades/rollback 测试（real better-sqlite3）；Q-3 Resolved（file references 策略）；Q-5 Resolved（无 FTS） |
| 2026-07-20 | Phase 3.1 | 完成（Done）：14 个 ChatDb IPC channels（IpcChannel.ts）；packages/shared/chatDb/ 新增 types.ts（JSON wire DTO/result envelope/command map）、result.ts（ok/fail/isSuccess/isFailure/envelope）、validation.ts（runtime JSON validator，深度 20，拒绝非法类型）、contracts.ts（channel→allowedKeys+validate 映射）、index.ts（barrel）；199 个 shared tests（validation.test.ts 99 + contracts.test.ts 100；初始完成时为 107，后续扩展至当前 199）；typecheck / format 通过 |
| 2026-07-20 | Phase 3.2 | 完成（Done）：ChatDbAggregateService（14 命令实现）；repository factory（root DB / transaction 绑定）；wire adapters（JSON ↔ Domain，保留结构化 renderer model/tool-object/unknown JSON/nullable 语义）；errors.ts（错误映射 9 类）；ipc.ts（14 个 IPC handler 注册 + request/result 运行时验证 + 结构化错误映射 + disposer）；shared contract 修正（blocks 数组前置验证、identity/reparenting 拒绝、所有权一致性、新错误码）；78 个新 tests 通过；438 个 tests 全部通过（Phase 3.2 初始完成时的快照基线）；typecheck / format 通过 |
| 2026-07-20 | Phase 3.2 审计修复 | 修复 9 项审计发现：fetchMessages topic priming；updateBlocks/updateSingleBlock/deleteBlocks/clearMessages 原子性（root tx + tx-bound repos）；clearMessages 移除 fileRefs.deleteByMessage（FK cascade）；typed aggregate errors + SQLite code inspection；IPC validateChatDbResult + malformed result containment；channel ChatDbChannel 类型；错误消息 sanitize；generic storage error non-retryable；53 个新 tests；932 个 total tests 通过（审计修复后的快照基线） |
| 2026-07-20 | Phase 3.2 评审修复 | 修复 5 项评审发现：① 替换伪回滚测试为基于 SQLite trigger 的确定性回滚测试（appendMessage/updateMessageAndBlocks/updateSingleBlock 三个 genuine rollback cases）；② IPC 注册模块级生命周期管理（activeRegistrationId + activeDisposer + stale-disposer ownership）；③ shared contract updateMessage/updateSingleBlock patch 拒绝 sortOrder 字段；④ 移除 "abort due to constraint" 冲突误分类（避免 unstructured FK message 被分类为 CONFLICT）；⑤ 141 个 Phase 3.2 tests 通过，870+ total tests 通过（评审修复后的快照基线；低于932因伪回滚测试替换为3个真实回滚测试） |
| 2026-07-20 | Phase 3.4 完成 | 不可变注入路由策略（DbRoutingPolicy：dexie / sqlite-validation / sqlite-authoritative）；routingPolicy.ts 定义 OrdinaryMessageSource / DexieMessageSource / AgentMessageSource 依赖接口和 DbServiceDeps 构造选项；DbService 重构为公共构造函数 + 不可变注入策略 + 懒加载 SQLite 源（首次普通操作创建一次）+ 永久 Dexie 单例；sqlite-authoritative 构造同步抛出 Phase 5 错误；Agent 路由策略无关最高优先级；updateFileCount(s) 始终 Dexie；无 readiness 检测 / fallback / shadow / dual-write；102 个新 DbService tests 通过（路由 / 懒加载 / Agent / 分区 / 文件操作 / 错误传播 / 无探针 / 参数保持）；168 个 renderer db tests 通过；typecheck / format 通过 |
| 2026-07-20 | Phase 3.3 完成 | Preload bridge（window.api.chatDb 14 个命名方法 ipcRenderer.invoke）；Renderer SqliteMessageDataSource（ChatDbApi 构造注入 + ChatDbResultError + cloneForWire + 14 方法 + dispatch parity）；Main structured model 缺陷修复（wireToMessage 对象→overflow + column null + modelId 提取；messageToWire overflow 恢复；wireToMessagePatch null model 清除 overflow）；803 个 tests 通过 |
| 2026-07-20 | Phase 3 | **Done**（Phase 3.1 Done, Phase 3.2 Done (audit-fixed), Phase 3.3 Done, Phase 3.4 Done） |
| 2026-07-19 | Phase 4 | Not started |
| 2026-07-19 | Phase 5 | Not started |
| 2026-07-19 | Phase 6 | Not started |
| **2026-07-20** | **策略更正** | **A-8 Accepted：外部应用兼容性导入模型替代 in-place Dexie→SQLite shadow/cutover（A-5 Superseded）。Phase 4 重定义为外部导入管线（4.0 spike → 4.1 ZIP intake → 4.2 bulk import → 4.3 verification → 4.4 atomic promotion）。Phase 5 重定义为 SQLite-only runtime 完成。Phase 6 重定义为 Cherry Chat 备份/恢复分离 + 清理。文档全面更新反映新模型** |
| **2026-07-21** | **Phase 4.0 Done** | **Isolated-profile feasibility spike 完成 — Go on macOS arm64。**验证：`session.fromPath(absolutePath, { cache: false })` 为正确 Electron API（非 `session.defaultSession.fromPath()`）；file:// origin 正确；`IndexedDB/file__0.indexeddb.leveldb` 为观测到的 profile 映射；Dexie logical 4→native 40, 11→native 110, 12→native 120（×10 乘数）；v4 通过 production upgrades (v5→v7→v8→v11) 升级；v12 被正确拒绝；default session 隔离确认；A/B markers 不跨 session；Local Storage 非 discovery/read 必需；10/10 fresh-root 迭代通过，cleanupAttempts=1，无 leftovers。**未验证**：Windows/Linux、真实 ZIP snapshot 一致性。helper 进程回退为 contingency only，未选用 |
| **2026-07-21** | 决策 | A-9 Accepted（Phase 4.1 macOS-first + 平台拒绝）；A-10 Accepted（Phase 4.0 harness 保留至 Phase 5）；Q-12 Resolved（import renderer 专用独立 HTML 入口） |
| **2026-07-21** | Phase 4.1 | 只读诊断完成（In progress）：fresh Analyzer 产出 source-reader 侧生产化方案；3 项 deferred 问题（跨平台/spike/HTML 入口）已闭环并文档化 |
| **2026-07-21** | Phase 4.1 | **Source-reader 生产化完成（Done）**：17 新文件 + 4 修改文件（chatDbImport/ + chatImport preload + chatImport renderer + shared types/IpcChannel + electron.vite.config + main/ipc/index）。审计 4 blockers 修复 + 复审 2 orchestrators 修复 + 最终 Auditor Clean。主进程 977/977。合入 `6a1e98e7ef` |
| **2026-07-27** | Phase 4.2 | **Candidate bulk importer 完成（Done）**：实际模块 `CandidateDbResource` / `ChatImportDataPlane` / `ChatImportWriter` / `startupRecovery`；每页一事务、import-only 保序 writer、`candidate-ready` exact-once、`SourceReadStats` vs `CandidateImportStats` 分离；10k 基准（25 topics / 10,000 messages / 11,000 blocks / 26 segments / 250 memberships / 667 file refs / 19 pages；两次运行 1016.2ms、978.5ms；`integrity_check` ok、`foreign_key_check` 空；live `chat.db` 未改）；最终审计 0 blockers；聚焦测试通过；全量本地验证通过（2026-07-27）：`pnpm format` exit 0 无改动；`pnpm lint` exit 0（node/web/aicore typecheck 全过、i18n 校验通过、0 errors，仅 pre-existing warnings）；`pnpm test` exit 0，252 文件 / 5325 通过 / 72 跳过；无遗留产物（local-only full validation，未涉及 commit/push/CI） |

---

## 16. 代码证据索引

### 当前活跃资产

| 路径 | 说明 |
|---|---|
| `src/renderer/src/databases/index.ts` | Dexie `CherryStudio` 数据库定义，所有表结构 |
| `src/renderer/src/databases/upgrades.ts` | Dexie schema 升级函数 |
| `src/renderer/src/services/db/DbService.ts` | DbService facade，不可变注入路由策略（Phase 3.4），路由 Dexie/SQLite/Agent 数据源 |
| `src/renderer/src/services/db/routingPolicy.ts` | Phase 3.4：DbRoutingPolicy 类型 + OrdinaryMessageSource / DexieMessageSource / AgentMessageSource 依赖接口 + DbServiceDeps 构造选项 |
| `src/renderer/src/services/db/DexieMessageDataSource.ts` | Dexie 消息数据源实现 |
| `src/renderer/src/services/db/AgentMessageDataSource.ts` | Agent 数据源 stub（no-op） |
| `src/renderer/src/services/db/types.ts` | MessageDataSource 接口 + agent topic ID 工具函数 |
| `src/renderer/src/services/db/README.md` | 过时文档，描述不存在的 Agent IPC 实现 |
| `src/main/services/memory/MemoryService.ts` | Memory `memories.db`，直接 `@libsql/client` |
| `src/main/services/KnowledgeService.ts` | Knowledge `KnowledgeBase/*`，`embedjs-libsql` |
| `src/main/services/BackupManager.ts` | 备份/恢复，直接复制 Data 目录 |
| `src/main/index.ts:240` | `will-quit` handler，未调用 Memory/Knowledge close |
| `package.json:35-38` | 失效 `agents:*` scripts |
| `package.json:308-309` | 残留 `drizzle-kit`/`drizzle-orm` 依赖 |
| `packages/shared/IpcChannel.ts` | ChatDb enum entries（14 channels） |
| `packages/shared/chatDb/types.ts` | JSON wire primitives、result envelope、request/response DTOs、command map |
| `packages/shared/chatDb/result.ts` | ok/fail constructors、isSuccess/isFailure type guards、error code constants |
| `packages/shared/chatDb/validation.ts` | Runtime JSON validator（depth limit、type rejection、request/field/array validators） |
| `packages/shared/chatDb/contracts.ts` | Channel→contract registry（allowedKeys + validate per command） |
| `packages/shared/chatDb/index.ts` | Barrel export for chatDb shared domain |
| `packages/shared/chatDb/__tests__/validation.test.ts` | 99 tests: JSON primitives, composites, depth limit, result envelope |
| `packages/shared/chatDb/__tests__/contracts.test.ts` | 100 tests: registry completeness, valid/invalid payloads, JSON round-trip |
| `src/main/services/chatDb/ChatDbAggregateService.ts` | 14-command aggregate service combining five Phase 2 repositories |
| `src/main/services/chatDb/repository/factory.ts` | Repository factory binding all five repos to root DB or transaction executor |
| `src/main/services/chatDb/wireAdapters.ts` | Wire ↔ Domain adapters (JSON ↔ persistence DTOs, tool-object content, file refs, relational blocks) |
| `src/main/services/chatDb/errors.ts` | Structured error mapping (9 error categories → shared codes + retryable semantics) |
| `src/main/services/chatDb/ipc.ts` | 14 fixed IPC handler registration with request/result validation and error mapping |
| `src/main/services/chatDb/__tests__/aggregate.test.ts` | 60 tests: all 14 commands, transaction rollback, ordering, file refs |
| `src/main/services/chatDb/__tests__/wireAdapters.test.ts` | 29 tests: wire ↔ domain round-trip, tool content, file refs, nullable semantics, structured model |
| `src/main/services/chatDb/__tests__/ipc.test.ts` | 27 tests: 14 handlers, validation, identity rejection, error mapping, disposer |
| `src/preload/index.ts` | Preload bridge: `window.api.chatDb` with 14 named IPC methods (ChatDb_FetchMessages etc.) |
| `src/renderer/src/services/db/SqliteMessageDataSource.ts` | Renderer SqliteMessageDataSource: ChatDbApi interface, ChatDbResultError, cloneForWire, 14 methods, updateTopicUpdatedAt dispatch |
| `src/renderer/src/services/db/__tests__/SqliteMessageDataSource.test.ts` | 66 tests: method mapping, forceReload omission, null→undefined, insertIndex, JSON boundary, unsupported types, ChatDbResultError, transport errors, no retry, dispatch parity, no file-count methods |
| `src/renderer/src/services/db/__tests__/DbService.test.ts` | 102 tests: dexie/sqlite-validation routing (14 ops each), lazy factory, agent routing (20 ops), block partitioning, file ops always Dexie, getSourceType, error propagation, no readiness probes, no mutable API, argument preservation |

### 历史路径（已不存在）

| 路径 | 说明 |
|---|---|
| `src/main/services/agents/` | 已删除的 agents SQLite 子系统目录 |
| `src/main/services/agents/drizzle.config.ts` | agents drizzle 配置（scripts 引用但不存在） |
| `Data/agents.db` | 用户设备上可能遗留的 agents 数据库文件 |

### Phase 4 实现区域（实际已创建 / 规划）

| 区域 | 实际/预期路径 | 说明 |
|---|---|---|
| ZIP intake + extract | `src/main/services/chatDbImport/`（zipIntake/tempWorkspace，Phase 4.1 已创建） | 安全解压、IndexedDB 结构校验、临时工作区管理 |
| Isolated session/profile | `src/main/services/chatDbImport/isolatedSession.ts`（Phase 4.1 已创建） | `session.fromPath(absolutePath, { cache: false })` / isolated profile + origin 创建 |
| Import renderer | `src/renderer/src/windows/chatImport/`（Phase 4.1 已创建） | 隐藏 sandboxed renderer，当前 Dexie schema against isolated profile |
| Import IPC | `packages/shared/chatImport/`（Phase 4.1 已创建，ChatImport_* 6 channels） | 窄 import-only IPC channels；`packages/shared/IpcChannel.ts` 已登记 |
| Candidate DB resource | `src/main/services/chatDbImport/CandidateDbResource`（Phase 4.2 已创建） | per-session 自有候选目录，内含独立候选 `chat.db` |
| Import data plane | `src/main/services/chatDbImport/ChatImportDataPlane`（Phase 4.2 已创建） | Main 侧分页数据面，承载 `SourceReadStats`；Main page 背压驱动 |
| Import writer | `src/main/services/chatDbImport/ChatImportWriter`（Phase 4.2 已创建） | import-only 保序 writer（order-preserving），每页一事务，`candidate-ready` exact-once；`CandidateImportStats` |
| Startup recovery | `src/main/services/chatDbImport/startupRecovery`（Phase 4.2 已创建） | 取消/错误/孤儿候选目录确定性清理 |
| Verification | `src/main/services/chatDb/import/verification.ts`（Phase 4.3 规划） | 源 vs 目标全维度验证 |
| Atomic promotion | `src/main/services/chatDb/import/promotion.ts`（Phase 4.4 规划） | 关闭 → 快照 → rename → reopen → relaunch |

### 已废弃/待移除路径

| 路径 | 状态 | 说明 |
|---|---|---|
| `src/renderer/src/services/db/routingPolicy.ts` | **Phase 3.4 scaffolding，Phase 5 移除** | 临时验证用路由策略注入 |
| `src/renderer/src/services/db/DexieMessageDataSource.ts` | **Phase 5 从普通路径移除** | 最终仅保留在隔离 import renderer 内部 |
