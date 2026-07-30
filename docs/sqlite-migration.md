# SQLite 运行时迁移与 Cherry Studio 兼容导入 — 个人 fork 演进记录（面向未来独立 Cherry Chat）

> **文档状态**：In progress（Phase 0–3 完成；Phase 4.0 Done on macOS arm64；Phase 4.1 Done；Phase 4.2 Done；Phase 4.3 Done（已提交/已推送至迁移分支 `85603d0fd5`）；集成同步门 Baseline Sync Gate Done（integration `05a401b711` 已集成同步，已验证）；Phase 4.4.0（Promotion 协议基础，纯协议层）Done；Phase 4.4.1（Durable Preparation Gate，快照就绪准备门）Done；Phase 4.4.2（Destructive Promotion Executor，破坏性替换执行，止于 durable replacement-verified）Done（已提交 `3a81557ac6`）；Phase 4.4.3（Recovery/Finalization：artifact probes、rollback、journal cleanup、terminal take、repair marker、recovery executor/gate、startup reorder）Done（实现 + 独立审计 pass（两项 accepted fixes：real durable repair marker、startup gate fail-closed）+ 全量验证通过：focus 71/1709/72 skipped；format 无改动；lint 0 errors/97 warnings；test 281/6205/72 skipped；typecheck:node pass；两次 ENOENT failures 非复现；未提交/未推送）；Phase 5 In progress（Phase 5.0 Done；Phase 5.1A Done（已提交 `6fa5ff5ef9`）；Phase 5.1B Done（已提交 `e44e413f30`，未推送）；Phase 5.2A Done（已提交 `e9de29ff97`，未推送）；Phase 5.2B 实现 + 独立审计 + 全量验证完成（未提交/未推送）；Phase 5.3 Done（已提交 `b81a35c054`，未推送）；Phase 5.4 Done（实现 + E2E + 性能基准 + A-10 spike harness 清理 + 文档收尾；未提交/未推送；最终仓库验证 Node v24.12.0 ABI 137 / pnpm 10.27.0：format PASS 无改动；lint PASS 0 errors / 17 pre-existing warnings；typecheck+i18n+format recheck PASS；test PASS 304 文件 / 6598 通过 / 72 跳过 / 0 失败；typecheck PASS node/web/aicore；git diff --check PASS；无 generated JS/temp/process artifacts；better-sqlite3 最终本地 binary 为 ABI 137（host Node），Electron ABI 145 E2E 证据已在 earlier targeted rebuild 中记录；agent runtime UI 因无 Main handler/IPC/UI entry 不可用，非 ABI 问题）））
>
> ✅ **集成同步门（Baseline Sync Gate，Done/已合并/已验证）**：integration 分支（`05a401b711`）已集成同步进 migration 分支（pre-merge HEAD `5d50499e80`）；合并自动解决、无兼容性编辑；审计无阻塞/无代码发现，验证全部通过（format 无改动；lint exit 0 / 112 known warnings；typecheck 通过；`pnpm test` 265 文件 / 5664 通过 / 72 跳过 / 0 失败；聚焦测试 201 renderer + 822 chatDb/import）。Phase 4.4 既有架构未改变；合并后统一的 Renderer/context/type/Redux 结构已作为 Phase 5 实施基线。详见 Section 9「集成同步门（Baseline Sync Gate）」与决策日志。
> **分支**：`jorkey/refactor/sqlite-migration`
> **最后更新**：2026-07-30
> **Owner**：Personal fork（jorkeyliu）
>
> ⚠️ **ADR-8 策略更正（2026-07-20）**：Phase 4+ 的产品策略已更正为**外部应用兼容性导入**模型。原 in-place Dexie→SQLite shadow/cutover 模型已正式废弃。详见 Section 6 A-8。

---

> ## 顶层定位（阅读前必读）
>
> 本文档是个人 fork（jorkeyliu）的**演进记录**，该 fork 是通往**未来独立 Cherry Chat 应用 / 新仓库**的**开发载体**。当前每个阶段（自 Phase 0 起）都服务于这个独立目标，而**不是**把现有 Cherry Studio 本体就地升级为 SQLite 版本后发布。
>
> 全文中存在三条必须区分的**生命周期 / 范围**（详细边界见 Section 2「三条生命周期」）：
> - **L1 内部 SQLite 运行时演进**：个人 fork 内演进的 SQLite-authoritative 运行时（连接管理、schema migration、integrity 校验、备份协调，最终 SQLite-only runtime）。
> - **L2 Cherry Studio ZIP 兼容导入**：一次性、用户主动选择的兼容导入——用户在 Cherry Chat 中选定一个 Cherry Studio ZIP 备份导入其数据。
> - **L3 Cherry Chat 备份/恢复**：沿用现有 Cherry Studio 已有的用户侧本地/WebDAV/S3 备份与恢复产品行为，并适配 SQLite-authoritative 的 chat.db；与 L2 是不同产品语义（L2 为跨应用 ZIP 兼容导入，L3 为同应用备份/恢复），二者 UX 可复用既有组件/基础设施但不改变其独立性。底层一致性快照由 Phase 1 已集成的 better-sqlite3 online backup 机制提供，属存储层能力而非新的产品操作。
>
> **关键边界**：最终 Cherry Chat 以自身空数据启动，显式导入用户选定的 Cherry Studio ZIP；不扫描磁盘、不共享目录、不在启动时静默迁移、无就地升级语义。L2 与 L3 虽未来 UI 组件可能复用，但产品语义相互独立。

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

### 三条生命周期（范围边界）

| 生命周期 | 含义 | 对应阶段 | 产品语义 |
|---|---|---|---|
| **L1 · 内部 SQLite 运行时演进** | 个人 fork 内演进的 SQLite-authoritative 运行时：连接管理、schema migration、integrity 校验、备份协调，最终 SQLite-only runtime（Dexie 路由移除） | Phase 0–3、Phase 5 | fork 内部能力演进，为独立 Cherry Chat 提供目标数据库与写入通道 |
| **L2 · Cherry Studio ZIP 兼容导入** | 一次性、用户主动选择的兼容导入操作：用户在 Cherry Chat 中选定 Cherry Studio ZIP 备份，导入其数据 | Phase 4（4.0–4.4） | 跨应用兼容导入；replace-all 语义；非 in-place 升级 |
| **L3 · Cherry Chat 备份/恢复** | 沿用现有 Cherry Studio 本地/WebDAV/S3 备份与恢复产品流程，并适配 SQLite-authoritative 的 chat.db | Phase 6 | 同应用备份/恢复，产品语义独立于 L2（跨应用 ZIP 导入）；底层快照为 Phase 1 的 better-sqlite3 online backup 存储层机制 |

**边界约束**：最终 Cherry Chat 以自身空数据启动，显式导入用户选定的 Cherry Studio ZIP；不扫描磁盘查找其他应用、不要求共享目录、不在启动时静默迁移、无就地升级语义。L2（Cherry Studio 跨应用 ZIP 兼容导入）与 L3（Cherry Chat 备份/恢复，沿用现有产品流程并适配 chat.db）是不同产品语义，未来 UI 组件/基础设施可复用但不改变其独立性。

### 当前范围（Phase 0–3：基础设施）

- `topics`、`messages`、`message_blocks`、`topic_segments` 及必要的 file references
- 新建独立 `Data/chat.db`（A-1 Accepted），Main 进程单写
- 连接生命周期、migration 框架、integrity 校验、backup coordination
- Renderer→Main 的 command-oriented typed IPC 收口

### 最终范围（Phase 4–6：L2 Cherry Studio ZIP 兼容导入 + L1 Cherry Chat SQLite-only 运行时）

- 安全解压 Cherry Studio ZIP 到隔离临时工作区
- 通过隔离 Electron Session/Profile + 隐藏 sandboxed import renderer 读取源 IndexedDB
- 分页逻辑数据通过窄 IPC 通道传输
- 构建候选 SQLite 数据库、验证、原子替换
- Cherry Chat SQLite-only 运行时完成，Dexie 路由移除
- 沿用现有 Cherry Studio 备份/恢复产品流程（适配 chat.db）的 Cherry Chat 同应用备份/恢复，与 Cherry Studio ZIP 导入的 UX 分离

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

### Group D：Cherry Chat SQLite-only 运行时完成后处理（依赖 Phase 5 SQLite-only runtime 完成）

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
| **A-10** | **Phase 4.0 spike harness：保留至 Phase 5 后删除** | **Fulfilled/Deleted (2026-07-30)** | Phase 4.0 的 spike-only 文件（22 个：`packages/shared/phase4*.ts`、`scripts/phase4-*.sh`、`src/main/phase4-*.ts`、`src/preload/phase4-spike-preload.ts`、`src/renderer/phase4Spike.html`、`src/renderer/src/windows/phase4Spike/`、`electron.vite.config.ts` 的 `PHASE4_SPIKE=1` build gate）**在 Phase 5.4 spike gate 通过后已移除**。spike gate 结果：A pass、C1 4/4、C2a 8/8、C2b 10/10。Production imports（`src/main/services/chatDbImport/`、`src/preload/chatImport/`、`src/renderer/src/windows/chatImport/`）保留，不受影响。历史 spike 结果（session 隔离、file:// origin、版本映射等硬事实）已由生产模块重新干净实现，harness 作为回归对照基线的历史使命完成。**Phase 4.1 生产模块独立新增**（`src/main/services/chatDbImport/`、`src/preload/chatImport/`、`src/renderer/src/windows/chatImport/`），**不复用 spike 代码** |

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
| **退出条件** | ✅ 10k 消息完整导入到候选 DB；✅ 导入中断后候选 DB 可安全丢弃，现有 SQLite 不受影响；✅ 导入耗时记录（10k 基准见下）；✅ 单元审计 + 最终审计 0 阻塞（final audit 0 blockers）；✅ 聚焦测试证据通过（focused test evidence）；✅ 全量本地验证通过（2026-07-27）：`pnpm format` exit 0 无改动；`pnpm lint` exit 0（node/web/aicore typecheck 全过、i18n 校验通过、0 errors，仅 pre-existing warnings）；`pnpm test` exit 0，252 文件 / 5325 通过 / 72 跳过；无遗留产物（本地全量验证未涉及 CI） |

**10k 基准证据（真实运行）**：
- 数据集：25 个 topics、10,000 条 messages、11,000 个 blocks、26 个 segments、250 条 topic_segment_memberships、667 条 file references、19 页分页
- 两次独立运行耗时：约 1016.2ms 与 978.5ms
- 完整性：`PRAGMA integrity_check` 通过（ok）；`PRAGMA foreign_key_check` 结果为空（无外键违例）
- 不变量：现有 live `chat.db` 未被改动（import 仅写候选 DB）

#### Phase 4.3：Deterministic verification

| 属性 | 值 |
|---|---|
| **状态** | **Done（本地完成，已提交/已推送，2026-07-27）** |
| **前置** | Phase 4.2 完成（Done） |
| **目标** | 对候选 SQLite DB 执行确定性的全维度验证，确保数据完整且结构正确；验证失败有明确报告与诊断；取消/退出安全 |
| **实际交付范围** | `CandidateVerifier`（只读验证器，返回稳定 13 维度结果 + 有界安全诊断）；`SourceVerificationManifest`（按页证据清单，仅在 DB 事务提交后落盘，stable canonical SHA-256 framing）；`VerificationReport`（紧凑诊断输出 ~1.4KiB）；候选 DB 会话状态机 `candidate-ready → verifying → verified-candidate \| verification-failed`；取消/退出 `close-before-discard` 语义 |
| **Canonicalization 语义** | 验证使用稳定的 canonical SHA-256 framing：同一候选 DB 在同一证据集下产生稳定、可复现的 manifest 哈希（manifest ~5,019KiB），不随运行次序/线程调度抖动；manifest 仅在每页 DB 事务提交后写入，保证证据与已落盘数据强一致 |
| **验证器生命周期 / 状态** | 候选 DB 写入完成发送 `candidate-ready`（exact-once）→ 进入 `verifying`；验证全维度通过 → `verified-candidate`（保留候选 DB 供 Phase 4.4 promotion）；任一维度失败 → `verification-failed`（生成诊断报告后清理候选 DB）；用户在 promotion 前取消或 app 退出 → `close-before-discard`（先关闭候选 DB 句柄，再安全丢弃目录） |
| **13 验证维度** | ① 源 vs 目标 ID 集合匹配；② 每表记录数一致；③ 关键字段内容哈希比对；④ 消息 sort_order 与源顺序一致；⑤ 外键引用完整性；⑥ 关系正确性（topic→message→block、segment→message）；⑦ file-reference 快照完整性；⑧ segment 完整性；⑨ 结构化 model/tool object 完整性；⑩ overflow 数据；⑪ `PRAGMA integrity_check`；⑫ `PRAGMA foreign_key_check`；⑬ 应用层抽样读取（通过 repository 查询典型数据路径） |
| **诊断 / 隐私** | 验证器严格只读（readonly），不修改候选 DB；诊断信息有界（bounded safe diagnostics），仅暴露维度名、计数/哈希差异摘要、失败维度索引；不泄露 SQL、文件路径、堆栈、源内容明细 |
| **失败 / 通过行为** | 通过：保留候选 DB 于自有临时目录，等待 Phase 4.4 原子替换；现有 live `chat.db` 不受影响。失败：生成 `VerificationReport`（~1.4KiB，含失败维度与有界诊断）后清理候选 DB 与临时目录。取消/退出：`close-before-discard`，live SQLite 不受影响。corruption matrix 覆盖全部 13 维度（每个维度可独立检测失效） |
| **测试与基准** | 聚焦验证测试 271 个通过；`pnpm format` exit 0 无改动；`pnpm lint` exit 0（0 errors，109 warnings）；`typecheck:node` 通过；首次全量 `pnpm test` 5420 通过 / 2 失败 / 72 跳过（BackupManager 共享临时目录两例非确定性环境 flakes，与 Phase 4.3 无关）；复跑全量 `pnpm test` 258 文件 / 5422 通过 / 72 跳过 / 0 失败；Main 与全量多次复跑均干净；最终审计 0 findings（本地全量验证，未涉及 CI）；10k 数据集验证耗时 ~250–290ms |
| **退出条件** | ✅ 所有 13 维度验证通过；✅ 验证失败有明确错误报告与有界诊断；✅ 取消/退出安全（close-before-discard）；✅ 通过时候选 DB 安全保留供 4.4；✅ manifest 稳定可复现 |

**10k 验证证据（真实运行）**：
- 数据集：25 个 topics、10,000 条 messages、11,000 个 blocks、26 个 segments、250 条 topic_segment_memberships、667 条 file references、19 页分页
- 13 维度全部通过；corruption matrix 覆盖全部维度（构造性注入验证每个维度可独立检测失效）
- 验证耗时：约 250–290ms（两次独立运行）
- `SourceVerificationManifest`：~5,019KiB；`VerificationReport`：~1.4KiB
- 不变量：现有 live `chat.db` 未被改动（验证仅读候选 DB）

#### 集成同步门（Baseline Sync Gate，Phase 4.4 前置，Done/已合并/已验证）

> ✅ **已合并并验证完成（2026-07-27）**：integration 分支（`05a401b711`）已集成同步进 migration 分支（pre-merge HEAD `5d50499e80`）。合并自动解决（auto-resolved），无兼容性编辑。审计无阻塞/无代码发现；验证全部通过（见下方验证事实）。

| 属性 | 值 |
|---|---|
| **状态** | **Done（已合并 / 已验证）** |
| **基线事实（历史锚点）** | integration `05a401b711`、migration 历史推送 tip `85603d0fd5` 均已稳定；两分支距 merge base `44e6b1b82b` 分别为 15/21 commits（合并前基线事实）。本次合并：migration pre-merge HEAD `5d50499e80` ↔ integration `05a401b711` |
| **目标** | 将 integration 分支集成同步进 migration 分支，使后续 Phase 4.4 与 Phase 5 基于统一的 Renderer/context/type/Redux 结构 |
| **前置依赖** | 已完成 |
| **约束** | 合并**未改变** Phase 4.4 既有架构；Phase 5 须以合并后的结构为实施基线；本门作为 Phase 4.4 实现前置已完成 |
| **验证事实** | format 无改动（exit 0）；lint exit 0（112 known warnings，无错误）；typecheck 通过；`pnpm test` exit 0，265 文件 / 5664 通过 / 72 跳过 / 0 失败；聚焦测试 201 renderer + 822 chatDb/import 通过；审计 0 blocker / 0 code finding |
| **退出条件** | ✅ integration 已合并入 migration 分支；✅ 合并后 Renderer/context/type/Redux 结构统一且可编译；✅ 未引入 Phase 4.4 架构变更 |

**后续影响**：
- Phase 4.4（原子替换 promotion）架构不变，仅需在合并后的统一结构上实现
- Phase 5（SQLite-only runtime）须以合并后的 Renderer/context/type/Redux 结构为实施基线

#### Phase 4.4：Atomic replace-all promotion

| 属性 | 值 |
|---|---|
| **状态** | In progress（Phase 4.4.0 Done；Phase 4.4.1 Done；Phase 4.4.2 Done（已提交 `3a81557ac6`）；Phase 4.4.3 Done（实现 + 独立审计 pass + 全量验证通过，未提交/未推送）） |
| **前置** | Phase 4.3 验证通过；**集成同步门已完成（详见 Section 9「集成同步门（Baseline Sync Gate）」；migration pre-merge HEAD `5d50499e80` ↔ integration `05a401b711` 已合并/已验证，架构未变更）** |
| **目标** | 将验证通过的候选 SQLite DB 原子替换为 live `chat.db` |
| **主要任务** | 关闭现有 chat.db 连接；保留一个 rollback 快照（当前 live chat.db）；原子 rename 候选 DB → `Data/chat.db`；重新打开并验证新 DB（`PRAGMA integrity_check` + `PRAGMA foreign_key_check`）；成功 → relaunch app；失败 → 回滚到快照 DB 并报告错误 |
| **崩溃恢复** | 如果在快照创建和候选 rename 之间发生崩溃：原始 `chat.db` 保持完整（快照是副本，rename 未执行）。启动时检测孤立的快照/临时工作区文件（例如 `chat.db.pre-import-backup`、候选 DB 临时路径），通过确定性启动清理安全删除或保留（保留用于诊断，下次启动清理）。不影响正常启动路径 |
| **约束** | promotion 短时不可取消；保留一个回滚快照；重开/检查 DB；成功后 relaunch |
| **退出条件** | ✅ 原子替换成功 → reopen → relaunch 流程完成；✅ 失败回滚到快照 DB 流程验证；✅ 一个回滚快照保留 |

##### Phase 4.4.0：Promotion 协议基础（纯协议/state/journal/recovery matrix/coordination contract）

| 属性 | 值 |
|---|---|
| **状态** | **Done（实现 + 聚焦验证）** |
| **范围** | 仅纯协议层（LOCK-4405）：无 live/candidate/snapshot 文件操作、无 ChatDbService close/init、无 rename/replace/restore、无 relaunch、无 promotion IPC；不修改 shared/preload/renderer |
| **状态机（LOCK-4401）** | `ImportState` 扩展 `promoting`、`promoted`、`promotion-failed`；`verified-candidate → promoting` 为唯一 promotion 入口（`claimPromotion()`，bounded to `getVerifiedCandidate()`，同步原子转换 + 不可复用 token，exact-once）；`completePromotion(token, outcome)` exact-once 结算终态；`promoting` 后 cancel 拒绝（无状态变化、无清理）；两个结果态为终态 |
| **所有权边界（LOCK-4401）** | promotion-owned 状态（promoting/promoted/promotion-failed）下：异步 `dispose()`、同步 will-quit `disposeActiveImport()` 均保留候选与持久化恢复资产，仅关闭 reader/verifier/IPC 等非 promotion 资源；`promoting` 中失败结算为 `promotion-failed`（绝不 `error`） |
| **Journal v1（LOCK-4404）** | `promotion/journal.ts`：恰好 `version/sessionId/candidateId/phase`（`snapshot-ready\|candidate-installed\|replacement-verified`）；exact-key 严格 codec（多键/缺键/版本/ID/枚举全部运行时拒绝）；ID 复用候选目录严格 allowlist `^[A-Za-z0-9_-]{1,128}$`（不可携带路径）；固定自有文件名 `chat-import-promotion.journal.json`；纯函数 codec，crash-safe 落盘 writer 由 Phase 4.4.1 新增（已落地，见 Phase 4.4.1 / LOCK-4413） |
| **Rollback snapshot 命名（LOCK-4403，仅契约）** | 固定名 `chat.db.pre-import-backup` + staging `chat.db.pre-import-backup.staging`；单份保留顺序：live 打开时 online backup → staging → 验证 → 原子 rename 覆盖旧快照；不复制 WAL/SHM；replacement 验证后快照仍保留；本阶段无任何快照操作 |
| **操作顺序契约** | `promotion/protocol.ts` 定义 12 步 canonical 顺序（snapshot 创建/验证/发布 → journal snapshot-ready → close live → install → journal candidate-installed → reopen → verify → journal replacement-verified → cleanup journal → relaunch）；journal 锚点均在对应操作完成之后 |
| **恢复矩阵（LOCK-4406）** | `promotion/recovery.ts` 纯 `decidePromotionRecovery(input)`：输入 = journal 观察（absent/invalid/valid×3 phase）× live（missing/present-unverified/present-verified）× snapshot（同三态）× candidate（missing/present），共 90 组合全枚举，每组唯一动作 + reason code；动作严格为 `keep-old-live\|accept-verified-replacement\|restore-rollback-snapshot\|repair-required`；无 journal→keep-old-live；journal 无效→repair-required；`candidate-installed` 永不自证——仅 verified snapshot 可 restore，否则 repair-required；`replacement-verified` 仅在 live present-verified 时 accept；不按文件年龄猜测、无空 DB 创建动作；12 个文档化崩溃点由 `PROMOTION_CRASH_POINT_MATRIX` 全覆盖（will-quit 覆盖全部持久化 phase 子窗口） |
| **Maintenance coordination（LOCK-4402）** | `src/main/services/chatDb/maintenanceCoordination.ts`：统一契约覆盖 `backup\|restore\|promotion\|init\|close` 五操作；冲突矩阵全对（含同类互斥）；单持有者 lease（非阻塞 acquire / owner-checked 幂等 release / 唯一 leaseId）；**本阶段（4.4.0）仅定义契约，未接线任何现有 mutex/操作，无第三个独立运行时锁**；实际接线（promotion 接入既有 backup/restore/init/close 互斥协调）在 Phase 4.4.1 完成（LOCK-4411） |
| **Startup recovery seam** | `startupRecovery.ts` 仅 re-export 纯恢复决策契约；不读 journal、不探测文件、不执行恢复；既有孤儿清理行为不变；已注明未来接线时 journal-referenced candidate 必须排除出按年龄清理。**注意**：该「不读 journal / 不探测文件」状态为 Phase 4.4.0 协议层事实；Phase 4.4.1 已将其扩展为读取 promotion journal、探测并保护 journal-referenced 候选目录（LOCK-4414），见 Phase 4.4.1 |
| **实际资产** | `src/main/services/chatDbImport/promotion/{protocol,journal,recovery}.ts` + `promotion/__tests__/{protocol,journal,recovery}.test.ts`；`src/main/services/chatDb/maintenanceCoordination.ts` + `__tests__/maintenanceCoordination.test.ts`；`chatDbImport/index.ts`（状态扩展 + claim/complete + 边界守卫）；`chatDbImport/startupRecovery.ts`（契约 re-export）；`chatDbImport/__tests__/{index,startupRecovery}.test.ts` 扩展 |
| **验证事实** | 聚焦测试 `chatDb` + `chatDbImport`：29 文件 / 895 通过 / 0 失败（基线 822 + 新增 73）；`typecheck:node` 通过；Phase 4.1–4.3 既有测试与 API 无回归 |
| **退出条件** | ✅ 唯一 promotion 入口 + exact-once 经测试证明；✅ cancel/dispose/will-quit 边界经测试证明；✅ journal codec 严格有界、无路径；✅ 恢复矩阵 90 组合穷举 + 12 崩溃点覆盖；✅ 五操作互斥契约成立；✅ 4.4.0 模块零副作用 API |

##### Phase 4.4.1：Durable Preparation Gate（快照就绪准备门，无 live close/install/rollback/relaunch）

| 属性 | 值 |
|---|---|
| **状态** | **Done（实现 + 聚焦验证；已本地提交 `006615aff6`（连同 Phase 4.4.0 `7768b7e30c`），未推送）** |
| **范围** | Durable Preparation Gate：在 Phase 4.4.0 协议层之上，落地统一维护接线、rollback 快照创建（snapshot-ready）、严格持久化 journal store（crash-safe 落盘）、启动候选保护、exact-once prepared handle，以及非破坏性边界。**最大边界止于 snapshot-ready**：不含 live close / install / rename / replace / restore / relaunch（属 Phase 4.4.2+） |
| **统一维护接线（LOCK-4411）** | `maintenanceCoordination.ts`（4.4.0 定义契约、未接线）在 4.4.1 将 promotion 操作实际接入既有的 `backup\|restore\|init\|close` 互斥协调，成为唯一持有者 lease 的真实使用者；冲突矩阵全对（含同类互斥）；无新增第三个独立运行时锁；既有备份/恢复/初始化/关闭路径行为不变 |
| **Rollback 快照（LOCK-4412 / LOCK-4403）** | 在 live `chat.db` 打开时通过 Phase 1 online backup 机制创建单个 rollback 快照 `chat.db.pre-import-backup`：live → staging（`chat.db.pre-import-backup.staging`）→ 验证 → 原子 rename 覆盖旧快照；不复制 WAL/SHM；快照在 replacement 验证后仍然保留。本阶段仅创建并发布快照（journal 落 `snapshot-ready`），不消费快照做 restore |
| **严格持久化 journal store（LOCK-4413）** | 4.4.1 新增独立 `promotion/journalStore.ts` crash-safe 落盘 writer（`promotion/journal.ts` 保持 4.4.0 纯函数 codec）：确保 `chat-import-promotion.journal.json` 以原子 rename 写入；内容恰好 `version/sessionId/candidateId/phase`（`snapshot-ready\|candidate-installed\|replacement-verified`）；exact-key 严格 codec 保持不变（多键/缺键/版本/ID/枚举全部运行时拒绝）；ID allowlist `^[A-Za-z0-9_-]{1,128}$` 不变 |
| **启动候选保护（LOCK-4414）** | `startupRecovery.ts`（4.4.0 仅 re-export 纯决策契约，不读 journal / 不探测文件）在 4.4.1 扩展：启动时读取 promotion journal、探测并保护 journal-referenced 候选目录（排除出按年龄孤儿清理）、依据 Phase 4.4.0 恢复矩阵 `decidePromotionRecovery` 在启动早期对中断的 promotion 资产做安全分类（keep-old-live / repair-required 路径），不影响正常启动路径 |
| **Exact-once prepared handle（LOCK-4415）** | `claimPromotion()`（4.4.0，bound 到 `getVerifiedCandidate()` + 不可复用 token）在 4.4.1 形成 prepared handle；确保该 handle 在进入 live 替换前的准备窗口内可被唯一一次消费，prepared 状态持久化于 journal（snapshot-ready 已落盘）；promotion-owned 状态（promoting/promoted/promotion-failed）下 async `dispose()` / 同步 will-quit `disposeActiveImport()` 仍仅关闭非 promotion 资源、保留候选与持久化恢复资产 |
| **非破坏性边界（LOCK-4416）** | 整个 4.4.1 不对 live `chat.db` 做任何关闭/替换/重命名；现有 SQLite 保持 authoritative；候选 DB 始终处于自有临时目录；任何准备步骤失败均回退到 keep-old-live 或 repair-required（不创建空 DB、不按文件年龄猜测）；所有文件写均为 staging + 原子 rename；journal 无效 → repair-required |
| **审计 / 验证最终门（LOCK-4417）** | 独立审计首轮发现 candidateId 与 session 集成两处阻塞；均已修复；复审 0 findings。全量本地验证通过（未涉及 CI / 未提交 / 未推送） |
| **验证事实** | `pnpm format` 通过（无改动）；`pnpm lint` exit 0（82 oxlint + 33 eslint known warnings，115 emitted warning instances，0 errors）；`pnpm typecheck:node` 通过；`pnpm test` exit 0，272 文件 / 5860 通过 / 72 跳过 / 0 失败；Phase 4.4.0 / 4.1–4.3 既有测试与 API 无回归（本地全量验证，未涉及 CI / 未提交 / 未推送） |
| **退出条件** | ✅ 统一维护接线接入且冲突矩阵全对；✅ rollback 快照创建/发布流程经测试证明且不复制 WAL/SHM；✅ journal 严格持久化（crash-safe 原子写入）经测试证明；✅ 启动候选保护经测试证明（journal-referenced candidate 排除年龄清理、恢复矩阵分类安全）；✅ exact-once prepared handle 可唯一消费、promotion-owned 边界保持；✅ 非破坏性边界证明（live 未被关闭/替换、失败回退 keep-old-live/repair-required）；✅ 复审 0 findings |

**非目标（已由 Phase 4.4.2+4.4.3 落地）**：
- ~~不关闭现有 live `chat.db` 连接~~ → Phase 4.4.2 `closeForPromotion` 落地
- ~~不执行候选 DB → live `chat.db` 的原子 rename/replace~~ → Phase 4.4.2 `install.ts` 落地
- ~~不消费 rollback 快照做 restore~~ → Phase 4.4.3 `rollback.ts` 落地
- ~~不执行 relaunch~~ → Phase 4.4.3 `relaunch.ts` 落地
- 不新增 promotion IPC / Renderer 触发路径（仍排除）

##### Phase 4.4.2：Destructive Promotion Executor（破坏性替换执行，止于 durable replacement-verified）

| 属性 | 值 |
|---|---|
| **状态** | **Done（实现 + 聚焦验证 + 独立审计完成：pass-with-findings，两项已接受的 ownership/isolation 硬化修正已落地并复验；最终全量验证通过；工作区未提交/未推送）** |
| **范围** | 在 Phase 4.4.1 准备门（snapshot-ready）之上，落地唯一 Main-local 破坏性替换执行序列：exact-once prepared→executing capability 转移、授权 live close、closed-live proof、sidecar 处理 + 原子 rename-only install、严格 journal 递进（candidate-installed → replacement-verified）、授权 reopen、identity-bound replacement 验证。**执行终点为 durable `replacement-verified` handoff（LOCK-4428）**：不做 journal/snapshot 清理、不 restore 回滚快照、不 relaunch、不执行启动恢复动作（均属 Phase 4.4.3）；不新增 promotion IPC / preload / Renderer 触发路径 |
| **Exact-once capability（LOCK-4421）** | `preparation.ts`：`PreparedPromotionHandle.consume()` 恰好一次产出 `ExecutingPromotionCapability`（携带 token/sessionId/candidateId/retainedSnapshotPath/candidateDbPath/authorization）；重复 consume / dispose 后 consume 均有界拒绝（`already-consumed` / `disposed`）；consume 成功后 prepared handle 变 stale，其 `dispose()` 成为 lease-preserving no-op（不会从 executing capability 手中抽走 lease）；capability 的 `release()` 是唯一 lease 释放职责。会话集成：`transferPromotionExecution()` 仅允许当前活跃会话、`promoting` 状态、live token 对齐的未消费 handle 转移，同一同步帧内完成；会话仅为**过渡持有者**（interim owner）——执行终局结算时 ownership 显式转移（transfer，非 alias）：成功/post-install recovery-required → 终局 handoff 持有者（`TerminalPromotionOwnership` Main-local 记录），pre-install 失败 → 释放；capability 对象任一时刻恰有一个逻辑 owner（session → executor 窗口 → terminal handoff \| released） |
| **Owner-aware live 生命周期（LOCK-4422）** | `chatDb/index.ts`：新增 Main-internal `closeForPromotion(authorization)` / `reopenForPromotion(authorization)`——在任何生命周期变更前经 `validatePromotionAuthorization` 验证「当前持有的 promotion lease」，拒绝伪造/外来 handle、已释放、foreign-coordinator、非当前持有者；核心复用 `closeCore()`/`runInitCore()`（不嵌套获取 init/close lease——同一持续持有的 promotion lease 即整个 close→install→reopen→verify→journal 窗口的唯一维护授权，无 release/reacquire、无第二把互斥锁）；公共 `init()`/`close()` 语义不变（promotion lease 持有期间仍 busy 拒绝）；reopen 保持 repair-required 门与幂等快路径；candidate 实例（无 coordinator）永不可 promotion-owned。`maintenanceCoordination.ts`：新增 `validatePromotionAuthorization` 验证缝——模块私有 WeakMap grant 注册表 + coordinator holder peek（lease ID 内部比对、绝不外泄），仅验证 promotion 类授权、只给 verdict 不授予/不释放，ownerId 字符串单独永不被接受 |
| **原子安装（LOCK-4423 / LOCK-4426 / LOCK-4427）** | `promotion/install.ts`（有界原语，非 executor）：校验候选归属/存在/sealed（候选 WAL/SHM sidecar 存在即拒绝）→ 验证并消费 closed-live proof → 删除 live WAL/SHM sidecars → 捕获源 bigint stat identity（dev/ino/size）→ fsync 源文件 → 原子 `renameSync` 源→live（仅同文件系统；**EXDEV → 有界 `RENAME_CROSS_DEVICE` 失败，绝无 copy fallback，LOCK-4426**）→ fsync live 父目录 → 目标 stat identity 确认 → 产出模块 brand 的 `InstallReceipt`（绑定 candidateId/livePath/identity）。**成功仅在 rename + 父目录 fsync + 目标 identity 确认全部完成后返回（LOCK-4423）**。closed-live proof（LOCK-4427）：单次使用、模块 brand（WeakMap）、仅 `mintClosedLiveProof` 可铸造——要求当前持有的 promotion lease + live-closed witness；executor 在授权 close 成功后**立即**铸造；install 侧在破坏性窗口开启前重验证（含 owner 与 candidateId 绑定、TOCTOU witness 复查）并消费；路径安全：live 路径由 Data root 派生、源路径由严格 owned candidate ID 派生并做 containment 复查 |
| **严格 journal 递进（LOCK-4423 / LOCK-4424 / LOCK-4425）** | `promotion/journalStore.ts`：通用 durable writer 转为模块私有；新增两个显式 transition API——`advancePromotionJournalToCandidateInstalled`（要求当前 durable journal 有效且恰为 `snapshot-ready`、version/sessionId/candidateId 完全一致）与 `advancePromotionJournalToReplacementVerified`（要求恰为 `candidate-installed`、identity 一致）；任何 absent/invalid/phase 跳跃回退重复/identity 不一致均在**任何 staging/publish 变更之前**拒绝（`TRANSITION_JOURNAL_ABSENT/INVALID/PHASE_MISMATCH/IDENTITY_MISMATCH`）；失败绝不删除/清空现有 durable journal（LOCK-4425）；`snapshot-ready` 仍是唯一无前置 journal 可写的初始 phase（LOCK-4417 保持） |
| **Identity-bound replacement 验证（LOCK-4424）** | `promotion/replacementVerifier.ts`：receipt brand + live-path 绑定校验 → live bigint stat identity（dev/ino）对照 receipt → 完整只读 DB 门（`promotion/readonlyDbValidation.ts` 共享门，与 4.4.1 rollback 快照验证器完全同序：readonly+fileMustExist open → `PRAGMA integrity_check` → `PRAGMA foreign_key_check` → 精确 migration-state 兼容 → 经生产 repository/aggregate 读路径的应用层抽样读）→ 验证后 identity 复查（关闭 TOCTOU 窗口）。**size 有意不做门**（授权 reopen 后 WAL checkpoint 可合法改变主文件大小；receipt 仍携带 install 时 size 作有界证据）；严格只读、零变更、不写 journal（journal `replacement-verified` 仅在验证成功后由 executor 推进） |
| **执行编排（LOCK-4425 / LOCK-4428）** | `promotion/execution.ts`：`createPromotionExecutor` 驱动不可重排序列 `closing-live → minting-proof → installing → journal-candidate-installed → reopening-live → verifying-replacement → journal-replacement-verified → settled`；每个不可逆边界前重验证 capability 授权（stale capability 永不可行动）；`run()` exact-once 且永不 reject。失败分类（LOCK-4425）：`pre-install`（live 字节未被替换；曾关闭则以同一授权 reopen 恢复可用性——**非回滚**；recoveryRequired=false）/ `post-install`（rename 已发生；停止一切前进、保留全部产物——installed live 字节/journal/retained snapshot/candidate 残留，安全时确保 live 关闭，recoveryRequired=true；**绝不回滚/restore 快照/清 journal/relaunch**——确定性启动恢复（Phase 4.4.3）拥有这些决定）。Abort 契约：`requestAbort()` 为协作式请求，在每个 subphase 边界的下一个不可逆动作前检查；install 前 abort 按 pre-install 收尾、install 后按 post-install 收尾；lease 绝不提前释放。成功端点：durable `replacement-verified` 后返回 `PromotionExecutionHandoff`（**仍持有 capability/同一 lease**——在 Phase 4.4.3 前不开启竞争窗口）。会话集成（`chatDbImport/index.ts`）：`startPromotionExecution()` 唯一 Main-local 执行入口（`transferPromotionExecution` 同步帧 consume + 永不重置的 per-session start guard，重复/并发启动有界拒绝）；`promoted` 仅在 durable replacement-verified 后经 `completePromotion(token,'promoted')` 结算；executor 失败结算 `promotion-failed`；raced settle → `stale-settle`（durable 产物留给启动恢复，quiesce 后释放）；终局 ownership 结算（审计硬化后）**唯一归属 `startPromotionExecution` continuation**：成功 → capability 从 session 转移至 `PromotionExecutionHandoff`（`promoted` 记录）；post-install recovery-required → 转移至 `PromotionRecoveryRequiredHandoff`（`recovery-required` 记录，**保留同一 lease 至 Phase 4.4.3 或进程退出**——阻断公共 init/close/backup/restore 打开/变更未验证的 installed 替换件）；仅 pre-install 失败在 quiesce 后释放。两类终局记录存于 Main-local `TerminalPromotionOwnership`（`getTerminalPromotionOwnership()` 可查；即使调用方丢弃返回 handoff 也不泄露 owner）；stale session fail/dispose/will-quit 不能释放已转移的终局 capability；async `dispose()`/同步 will-quit `disposeActiveImport()` 经 `releasePromotionOwnership()`（stale-safe prepared dispose 去重 helper；executor 引用存在期间一律延迟给 continuation，未 settle 时另请求协作式 abort）。live-DB surface 由调用方注入（本模块不自行构造/查找 live chatDbService） |
| **实际资产** | 新增：`src/main/services/chatDbImport/promotion/{execution,install,replacementVerifier,readonlyDbValidation}.ts` + `promotion/__tests__/{execution,install,replacementVerifier}.test.ts`。修改：`src/main/services/chatDb/index.ts`（closeForPromotion/reopenForPromotion + closeCore/runInitCore 提取）、`src/main/services/chatDb/maintenanceCoordination.ts`（validatePromotionAuthorization + grant 注册表/holder peek）、`chatDbImport/promotion/journalStore.ts`（受门控 transition API）、`chatDbImport/promotion/preparation.ts`（consume/ExecutingPromotionCapability）、`chatDbImport/promotion/snapshot.ts`（只读门/durability helpers 去重至 readonlyDbValidation 共享模块）、`chatDbImport/index.ts`（transferPromotionExecution/startPromotionExecution/releasePromotionOwnership/abort 集成 + 审计硬化：`takeExecutingCapability`/`PromotionRecoveryRequiredHandoff`/`TerminalPromotionOwnership`/`getTerminalPromotionOwnership`）+ 对应测试扩展（`chatDb.test.ts`、`maintenanceCoordination.test.ts`、`journalStore.test.ts`、`preparation.test.ts`、`chatDbImport/__tests__/index.test.ts`） |
| **独立审计 / 已接受修正** | 审计结论 **pass-with-findings（无阻塞）**，两项 findings 均被接受为 correctness hardening 并已落地：① 成功 promoted 后 `session.executingCapability` 曾保留别名——stale session fail/dispose 可能释放 handoff 的授权 → 修正为显式 ownership 转移（transfer，非 alias）至成功 handoff（`takeExecutingCapability()` + 终局记录），stale 清理路径不再可释放；② post-install 失败在 quiesce 后曾释放 capability——允许进程内公共 init 打开未验证的 installed DB → 修正为 recovery-required handoff 保留 capability/同一 lease 至 Phase 4.4.3 或进程退出（LOCK-4425 强化不变量），维护隔离持续生效。附带清理：prepared-handle disposal 去重 helper、`transferPromotionExecution` 契约 JSDoc 澄清（interim owner → 终局转移）。修正后复验：受影响聚焦套件 35 文件 / 1141 测试通过 / 0 失败（含新增 C24–C26：post-install 后公共 init/close/backup/restore 在真实 coordinator 上持续被拒、stale fail/dispose 不可释放 promoted/recovery-required handoff、pre-install 仍正常释放、handoff owner 保留 exact-once release） |
| **验证事实（最终全量验证完成）** | 聚焦受影响区域测试（chatDb + chatDbImport）：35 文件 / 1141 测试通过 / 0 失败（审计修正后基线；修正前 1138，保留为聚焦验证证据）；`typecheck:node` 通过；changed-files biome/eslint 干净。**最终全量验证通过（未涉及 CI / 未提交 / 未推送）**：`pnpm format` 通过（无文件改动）；`pnpm lint` 通过（0 errors / 87 warnings）；`pnpm test` 通过，275 文件 / 5983 通过 / 72 跳过；`pnpm typecheck:node` 通过；独立审计与复验均 pass（pass-with-findings，两项硬化修正已落地复验）；工作区未提交/未推送 |
| **退出条件** | ✅ exact-once prepared→executing 转移经测试证明（重复/stale/dispose 边界）；✅ 同一持续持有 lease 授权全窗口、伪造/stale 授权在每个不可逆边界被拒；✅ rename-only install + EXDEV 有界失败 + fsync/identity receipt 经测试证明；✅ journal 严格递进（无跳跃/回退/repeat/跨 identity）经测试证明；✅ identity-bound 验证（前后 identity + 完整只读门）经测试证明；✅ pre-install/post-install 失败收尾与产物保留经测试证明；✅ 执行止于 durable replacement-verified（无清理/restore/relaunch） |

**非目标（已由 Phase 4.4.3 落地）**：
- ~~不消费 rollback 快照执行 restore~~ → Phase 4.4.3 `rollback.ts` 落地
- ~~不执行 relaunch~~ → Phase 4.4.3 `relaunch.ts` + `gate.ts` 落地
- ~~不清理 promotion journal / snapshot / candidate 残留~~ → Phase 4.4.3 `journalStore.ts` cleanup APIs 落地
- ~~不实现启动恢复**动作执行器**~~ → Phase 4.4.3 `recoveryExecutor.ts` + `gate.ts` 落地
- 不新增 promotion IPC / preload / Renderer 触发路径（仍排除）

##### Phase 4.4.3：Recovery / Finalization（恢复/终结：artifact probes、rollback、journal cleanup、terminal take、repair marker、recovery executor/gate、startup reorder）

| 属性 | 值 |
|---|---|
| **状态** | **Done（实现 + 独立审计 pass（两项 accepted fixes：real durable repair marker、startup gate fail-closed）+ 全量验证通过；未提交/未推送）** |
| **范围** | 在 Phase 4.4.2 终点（durable `replacement-verified` handoff）之上，落地恢复/终结管线的全部执行侧：磁盘 truth 等价探测、rollback 快照 staging clone + 原子 rename restore、durable journal 清理、exact-once terminal ownership take、repair-required 硬阻断标记、recovery executor 编排、startup recovery gate 集成、app-ready 启动重排序。**最大边界**：完整的四动作恢复管线（keep-old-live / accept-verified-replacement / restore-rollback-snapshot / repair-required）+ 启动集成。不新增 promotion IPC / preload / Renderer 触发路径 |
| **四动作语义（LOCK-4431..LOCK-4439）** | **keep-old-live**：live DB 为权威状态；若有效 snapshot-ready journal 存在则清理（install 未启动）；无 relaunch，进程正常继续。**accept-verified-replacement**：replacement 已安装并验证（live present-verified）；清理 replacement-verified journal；relaunch。**restore-rollback-snapshot**：authorization 下关闭 live DB、铸造 closed-live proof、staging clone + 原子 rename restore retained snapshot → live、验证 restored live、清理实际 valid journal phase（含 candidate-installed）；relaunch。**repair-required**：标记 durable repair（hard-block init），保留全部 artifacts，无 cleanup/relaunch |
| **Disk truth 等价探测（LOCK-4431/LOCK-4432）** | `promotion/artifactProbe.ts`：只读 promotion artifact 探测，在 `chatDbService.init()` 之前运行。探测 live/retained snapshot/candidate 三个 artifact 的磁盘状态（missing / present-unverified / present-verified）；路径由 Data root 严格派生（LOCK-4434）；candidateId 经 strict allowlist `^[A-Za-z0-9_-]{1,128}$` 校验后才解析路径。**Sidecar-free invariant**（controlled no-residue strategy）：better-sqlite3 readonly 打开仍可能创建 WAL/SHM sidecar；probe 在验证句柄关闭后检测并清理 probe 创建的 sidecar；composite probe 捕获 before/after directory snapshots 证明零净文件系统变更。`probePromotionArtifacts()` 产出完整 `PromotionArtifactProbesResult`（含 mutation evidence / sidecar-free assertion / cleaned sidecars）；`probeResultToRecoveryInput()` 映射为 `decidePromotionRecovery()` 输入 |
| **Rollback staging clone + 原子 rename（LOCK-4434/4435/4437/4439）** | `promotion/rollback.ts`：bounded primitive（非 executor）。**LOCK-4434**：retained snapshot **从不被消费或删除**。rollback 创建 fixed same-directory staging clone（`chat.db.pre-import-backup.staging`）→ 验证 staging → consume closed-live proof → 删除 live sidecars → 原子 rename staging → live（同文件系统 ONLY；EXDEV = structured failure，**无 copy fallback**，LOCK-4426）→ fsync live parent dir → 确认 destination identity → full readonly validation of restored live DB。**pre-rename atomic block**（LOCK-4435）：verify retained → create staging（`fs.copyFileSync`，closed self-contained source；copy + fsync + full validation gate contain partial-copy risk）→ fsync staging → validate staging → consume proof → delete live sidecars → capture staging identity → atomic rename。Clone decision（Phase 4.4.3 decision rights）：retained source 是 closed、self-contained SQLite（online backup API 产出，WAL 已 checkpoint，经 full readonly gate 验证，通过 atomic rename 发布），无 WAL/SHM sidecar；`fs.copyFileSync` 为 faithful duplicate；partial copy 由 integrity check + migration compatibility gates 确定性捕获；SQLite backup API 被拒绝（source closed，需重新打开仅为用其 backup facility，无安全增益）。**LOCK-4437**：任何 failure 保留 journal、retained snapshot 及全部 facts；pre-rename failures 留 live DB untouched（sidecars 可能已删除）；post-rename failures 保留 resulting state |
| **Durable journal cleanup（LOCK-4435..LOCK-4438）** | `promotion/journalStore.ts` Phase 4.4.3 扩展：新增 idempotent fixed-path cleanup primitive（`cleanupPromotionJournalBody`），由三个 phase-gated API 暴露——`cleanupPromotionJournalAfterReplacementVerified`（replacement-verified）、`cleanupPromotionJournalAfterSnapshotReady`（snapshot-ready）、`cleanupPromotionJournalAfterCandidateInstalled`（candidate-installed）。Guard-read validates current journal → absent = idempotent success；invalid → `CLEANUP_JOURNAL_INVALID`（no unlink）；phase/identity mismatch → `CLEANUP_PHASE_MISMATCH` / `CLEANUP_IDENTITY_MISMATCH`（no unlink）；valid + match → unlink fixed journal（ENOENT race after confirmed presence = idempotent）→ best-effort unlink stale staging（never failure）→ fsync parent directory for durability（LOCK-4438，`syncParentDirectoryForCleanup`；win32 skip；POSIX EINVAL/ENOTSUP/EPERM → `CLEANUP_PARENT_DIR_SYNC_UNSUPPORTED`）。**LOCK-4436**：仅 fixed journal 和 stale staging 为 deletion candidates；rollback snapshot / candidate files / live chat.db **永不被触碰**。Unlink failure → `CLEANUP_UNLINK_FAILED`（journal preserved）；dir sync failure → `CLEANUP_PARENT_DIR_SYNC_FAILED`（journal already unlinked，unlink not rolled back）。Staging unlink failure does not mask primary cleanup |
| **Snapshot retention** | Retained snapshot (`chat.db.pre-import-backup`) 在 replacement-verified 后仍然保留。rollback 使用 staging clone 而非直接消费 retained source。cleanup 永不触碰 retained snapshot。Snapshot 由用户显式管理（保留用于诊断/手动恢复） |
| **Exact-once terminal ownership take（LOCK-4433）** | `chatDbImport/index.ts`：`takeTerminalPromotionOwnership()` atomically take-and-clear `TerminalPromotionOwnership` 记录。First caller after settlement → `taken`（caller 成为 sole owner）；subsequent → `not-available`。`setTerminalPromotionOwnership()` production-safety guard：refuse overwrite unconsumed record（LOCK-4433）。Recovery executor 通过此 API 获取 retained capability/lease 以执行 rollback |
| **Repair hard block（LOCK-4437）** | `chatDb/index.ts`：`markRepairRequiredBeforeInit()` Main-internal durable repair-required marker write。Writes marker file with durable sync（file sync + parent dir sync）survives crashes。Idempotent（marker already exists = no-op）。**Refuses to write if service is already initialized**（unsafe state——live DB handle open must be closed first）。Subsequent `init()` calls refuse with descriptive error until marker explicitly cleared。Main-internal only，never exposed over IPC/preload/renderer |
| **Recovery executor 编排（LOCK-4431..LOCK-4439）** | `promotion/recoveryExecutor.ts`：`createRecoveryExecutor()` 产出 `RecoveryExecutor`（`run()` exact-once never rejects + cooperative `requestAbort()` + `whenSettled()`）。7 subphases canonical order：`probing → deciding → authorizing → executing-action → cleanup-journal → relaunching → settled`。Authorization resolution：destructive actions（restore-rollback-snapshot）require capability；尝试 take terminal ownership first（in-process continuation, LOCK-4433），fallback acquire fresh promotion lease（restart after crash, LOCK-4439）；non-destructive actions use `source: 'none'`。Action execution by decision：keep-old-live（verify live fact, cleanup valid snapshot-ready journal if present）、accept-verified-replacement（require live present-verified, cleanup replacement-verified journal）、restore-rollback-snapshot（close live under authorization, mint proof, run rollbackInstall, verify restored live, cleanup actual valid journal phase）、repair-required（mark durable repair, retain all artifacts）。Journal cleanup：phase-matched cleanup API per decision×phase combination。Relaunch：`mintRelaunchReceipt()` → `relaunchApp(receipt)` exact-once（`app.relaunch() + app.exit(0)`）。 Injectable primitives for test isolation；abort checks at every subphase boundary；authorization released on settle/failure |
| **Relaunch（LOCK-4438）** | `promotion/relaunch.ts`：exact-once receipt-gated relaunch。`mintRelaunchReceipt()` mints branded non-forgeable receipt（WeakSet）。`relaunchApp(receipt, app?)` validates receipt brand + exact-once guard → `app.relaunch() + app.exit(0)`。Receipt consumed on first call；second call = no-op `already-relaunched`。LOCK-4438 precondition（verified authoritative live state + durable cleanup）owned by executor，relaunch module does NOT re-verify |
| **Startup recovery gate（LOCK-4431）** | `promotion/gate.ts`：`runStartupRecoveryGate()` called once from `src/main/index.ts` AFTER `BackupManager.handleStartupRestore()` and BEFORE `chatDbService.init()`。**Absent-journal fast path**（common case）：no journal → no destructive promotion ever began → return `keep-old-live` immediately，no snapshot validation，no relaunch。Valid journal → `probePromotionArtifacts()` → `decidePromotionRecovery()` → execute via `createRecoveryExecutor()`。Result carries `decision` + `executorResult` + `repairRequired` flag + `relaunchPending` flag |
| **Startup ordering（LOCK-4431）** | `src/main/index.ts`：startup order contract：① `BackupManager.handleStartupRestore()` completes → ② **this gate runs**（promotion recovery）→ ③ `chatDbService.init()` → ④ ordinary orphan cleanup / window startup。Gate failure is non-fatal for startup（LOCK-L3）。`repairRequired` → skip `chatDbService.init()`（chat DB unavailable this session）。`relaunchPending` → return early（process exiting） |
| **实际资产** | **新增**：`src/main/services/chatDbImport/promotion/{artifactProbe,gate,recoveryExecutor,rollback,relaunch}.ts`。**修改**：`src/main/services/chatDb/index.ts`（`markRepairRequiredBeforeInit()` + durable marker write）、`src/main/services/chatDbImport/promotion/install.ts`（`validateClosedLiveProof()` narrowly reusable proof validation extracted from `installCandidate`；`installCandidate` refactored to use it）、`src/main/services/chatDbImport/promotion/journalStore.ts`（cleanup APIs + error codes + `syncParentDirectoryForCleanup`）、`src/main/services/chatDbImport/startupRecovery.ts`（re-export gate API）、`src/main/services/chatDbImport/index.ts`（`takeTerminalPromotionOwnership()` + `setTerminalPromotionOwnership()` + exports for relaunch/recoveryExecutor/gate）、`src/main/index.ts`（startup reorder：gate + repairRequired/relaunchPending handling）。**测试**：`chatDbImport/promotion/__tests__/install.test.ts`（`validateClosedLiveProof` 7 tests）、`chatDbImport/promotion/__tests__/journalStore.test.ts`（cleanup 606 lines，LOCK-4435..4438 全覆盖：success paths / staging cleanup / guard rejections / exact path confinement / unlink failure / dir sync failure / crash state / rollback-authorized contract / data root rejection / durable ordering / snapshot byte retention）、`chatDb/__tests__/chatDb.test.ts`（`markRepairRequiredBeforeInit` 6 tests：write+block / idempotent / refuse-when-initialized / refuse-when-repair-already-set + durable sync mock）、`chatDbImport/__tests__/index.test.ts`（`takeTerminalPromotionOwnership` 190 lines：take / double-take / not-consumable guard / set-refuse-unconsumed / integration with settlement） |
| **验证事实（独立审计 + 全量验证完成）** | 聚焦测试 `chatDb` + `chatDbImport`：**71 文件 / 1709 通过 / 72 跳过 / 0 失败**（`pnpm test:main`）。独立审计 **pass**（两项 accepted fixes：① real durable repair marker——`markRepairRequiredBeforeInit()` 耐久写入确认；② startup gate fail-closed——`runStartupRecoveryGate()` absent-journal fast path 确认）；复审 0 findings。**全量验证通过（未涉及 CI / 未提交 / 未推送）**：`pnpm format` exit 0 无改动；`pnpm lint` exit 0（0 errors / 97 warnings）；`pnpm test` exit 0，281 文件 / 6205 通过 / 72 跳过；`pnpm typecheck:node` 通过。Prior two ENOENT failures non-reproducible after combined/independent/full reruns。工作区未提交/未推送 |
| **退出条件** | ✅ 四动作语义经测试证明（keep-old-live / accept-verified-replacement / restore-rollback-snapshot / repair-required）；✅ artifact probes 只读 + sidecar-free invariant 经测试证明；✅ rollback staging clone + atomic rename + retained snapshot never consumed 经测试证明；✅ durable journal cleanup（phase-gated + identity-bound + idempotent + unlink/dir-sync failure handling）经测试证明；✅ exact-once terminal ownership take 经测试证明；✅ repair marker durable write + init hard-block 经测试证明；✅ recovery executor 7-subphase orchestration + abort + authorization resolution 经测试证明；✅ startup recovery gate（absent-journal fast path + valid journal → execute）经测试证明；✅ startup ordering（gate before init）经集成测试证明；✅ relaunch exact-once receipt-gated 经测试证明；✅ 独立审计 pass（两项 accepted fixes）；✅ 全量 format/lint/test 通过 |

### Phase 5：Cherry Chat SQLite-only 运行时完成

| 属性 | 值 |
|---|---|
| **状态** | In progress（Phase 5.0 Done；Phase 5.1A Done（已提交 `6fa5ff5ef9`）；Phase 5.1B Done（已提交 `e44e413f30`，未推送）；Phase 5.2A Done（已提交 `e9de29ff97`，未推送）；Phase 5.2B 实现 + 独立审计 + 全量验证完成（未提交/未推送）；Phase 5.3 Done（已提交 `b81a35c054`，未推送）；Phase 5.4 Done（实现 + E2E + 性能基准 + A-10 spike harness 清理 + 文档收尾；未提交/未推送；最终仓库验证 Node v24.12.0 ABI 137：304 文件 / 6598 通过 / 72 跳过 / 0 失败；lint 0 errors / 17 pre-existing warnings；format/typecheck/git-diff-check 全 PASS；Electron ABI 145 E2E 证据已在 earlier targeted rebuild 中记录；agent runtime UI 因无 Main handler/IPC/UI entry 不可用，非 ABI 问题）） |
| **前置** | Phase 4 完成（至少一次成功端到端导入）；**以合并后的 Renderer/context/type/Redux 结构为实施基线（集成同步门见 Section 9「集成同步门（Baseline Sync Gate）」）** |
| **目标** | Cherry Chat 普通聊天路径完全使用 SQLite，移除 Dexie 路由和临时验证 scaffolding |
| **主要任务** | DbService 默认路由直连 SQLite（无 Dexie 路由、无 routingPolicy 注入策略）；移除 Phase 3.4 路由策略代码（C-13）；Dexie 仅保留在隔离 import renderer 内部；从普通聊天路径移除 DexieMessageDataSource（C-11）；清理 Renderer 直接 Dexie 访问（C-10）；性能基准验证（不低于 Dexie 基线） |
| **退出条件** | ✅ 普通聊天路径无 Dexie 依赖；✅ Phase 3.4 routing scaffolding 完全移除；✅ 性能不低于 Dexie 基线；✅ 所有现有测试通过；✅ CI 绿色 |

> **Phase 5 子阶段边界（本 session 确立）**：Phase 5 拆为 5.0（基线就绪与子阶段划分，Done）、5.1A（SQLite 命令面补全：segments / file-ref / reorder，已提交 `6fa5ff5ef9`）、5.1B（主题生命周期 + 复合命令 + 搜索，已提交 `e44e413f30`，未推送）、5.2A（SearchResults 调用方迁移：Dexie → SQLite 搜索，已提交 `e9de29ff97`，未推送）、5.2B（主题生命周期调用方集成 + 复合操作增强，实现 + 独立审计 + 全量验证完成，未提交/未推送）、5.3（权威切换与 scaffolding 移除，已提交 `b81a35c054`，未推送）、5.4（E2E/性能/A-10 spike harness 清理/文档收尾，Done，未提交/未推送）。Phase 4 全部 LOCK-44xx 与历史决策继续有效，不重复声明。Phase 5 全部 LOCK-51xx 见本节末尾「Phase 5 Decision Locks」。

#### Phase 5.0：基线就绪与子阶段划分

| 属性 | 值 |
|---|---|
| **状态** | **Done** |
| **目标** | 在合并后 Renderer/context/type/Redux 基线上确立 Phase 5 子阶段边界、命令面清单与 Decision Lock 框架 |
| **范围** | 不新增代码；确立 5.0–5.4 拆分、Phase 5 命令面总计（Phase 3.2 的 14 + 5.1A 的 9 + 5.1B 的 12 = 35 个 ChatDb_* 命令）、以及 LOCK-5101…5113 / LOCK-5121…5129 的持久化形式 |
| **退出条件** | ✅ Phase 5 子阶段边界文档化；✅ 命令面清单与 Decision Lock 框架确立；✅ 与 Phase 4 基线一致 |

#### Phase 5.1A：SQLite 命令面补全（segments / file-ref / reorder）

| 属性 | 值 |
|---|---|
| **状态** | **Done（已提交 `6fa5ff5ef9`）** |
| **目标** | 在 Phase 3.2 的 14 命令之上补全 segment 生命周期、file-reference 反向查询、消息重排 |
| **9 个命令（ChatDb_*）** | `ListSegments`、`UpsertSegment`、`UpdateSegmentMetadata`、`DeleteSegment`、`ReplaceSegmentMembership`、`ReorderMessages`、`ListFileRefsByFile`、`CountFileRefsByFile`、`ListBlocksByFile` |
| **约束** | 经 `ChatDbAggregateService` + 新增 typed IPC + `window.api.chatDb` 命名方法 + `SqliteMessageDataSource` 实现（与 Phase 3 模式一致）；segment 操作为全量替换语义（`ReplaceSegmentMembership` 非 merge）；file-ref 查询为只读投影；`ReorderMessages` 仅在 topic 内重写 `sort_order`、不跨 topic 移动 |
| **退出条件** | ✅ 9 命令经 shared contract + aggregate + IPC + preload + renderer datasource 全链路落地；✅ 类型检查 / 聚焦测试通过；✅ 已提交 `6fa5ff5ef9`（未推送） |

#### Phase 5.1B：主题生命周期 + 复合命令 + 搜索

| 属性 | 值 |
|---|---|
| **状态** | **Done（已提交 `e44e413f30`，未推送）** |
| **目标** | 补全主题生命周期（metadata / 软删除 / 恢复 / 回收站 / 硬删除 / 过期清理）、复合消息命令（clone / paste / reset / 带 segment 删除 / 带 segment 清空）、以及 FTS5 归一化搜索 |
| **12 个命令 / 表面（ChatDb_*）** | 主题生命周期 6：`UpdateTopicMetadata`、`SoftDeleteTopic`、`RestoreTopic`、`ListTrashTopics`、`HardDeleteTopic`、`PurgeExpiredTopics`；复合命令 5：`CloneMessagesToTopic`、`ResetMessagesForResend`、`DeleteMessagesWithSegments`、`PasteMessagesToTopic`、`ClearTopicWithSegments`；搜索 1：`SearchMessages` |
| **FileCleanupResult 语义（LOCK-5108 / LOCK-5109）** | 复合 / 生命周期命令在 root 事务内执行 FK cascade（topic → messages → blocks → file_references → topic_segment_memberships）后，返回 `{ affectedFileIds, remainingReferenceCounts }`：**仅为数据报告，DB 事务内无任何文件系统副作用**；是否物理删除文件由调用方依据 `remainingReferenceCounts===0` 决定。事务内绝不改动 Dexie 文件计数 |
| **主题 metadata / trash / purge 语义（LOCK-5103 / 5104 / 5105 / 5113）** | `UpdateTopicMetadata`：name 为 null 清除、absent 不变，pinned 等扩展存于 `extra` JSON，单 root 事务。`SoftDeleteTopic` 置 `deleted_at`，仍可被 `ListTrashTopics` 查询。`RestoreTopic` 清除 `deleted_at`，不复活数据。`HardDeleteTopic` 经 FK cascade 彻底删除。`PurgeExpiredTopics(cutoffTimestamp)` 在单事务内原子清除所有 `deleted_at < cutoff` 的主题；**cutoff 由调用方提供，Main 聚合层不启动计时器、不自算 cutoff（LOCK-5113）** |
| **复合事务 / 所有权规则（LOCK-5106 / 5107）** | 每个多表变更在**一个 root SQLite 事务**内完成（clone / paste / reset / delete-with-segments / clear-with-segments / 生命周期 cascade 均如此）。所有权强制：block/message ID 经「block → message → topic」解析，跨 topic 所有权被拒（例如 paste/reset 拒绝不属于目标 topic 的消息） |
| **migration 003（FTS5 归一化投影，LOCK-5121 / 5126 / 5127）** | append-only `003_fts5_normalized_search`：① `message_blocks_normalized`（block_id PK、message_id、normalized_content，仅 MAIN_TEXT 块）；② `message_blocks_fts`（FTS5 trigram 虚表）；③ 回填现有 MAIN_TEXT 块；④ 三个触发器 `message_blocks_normalized_insert/update/delete`，在 `message_blocks` 写时同步投影（非 MAIN_TEXT 或内容变更时清除投影行）。`chatdb_normalize()` 标量函数在任何触发器触发前注册于原始 better-sqlite3 连接，其实现 = `normalizeSearchText`（stripMarkdown → CRLF→LF → lowercase），为单一事实源（LOCK-5126） |
| **搜索路由与精确匹配（LOCK-5122 / 5123 / 5124 / 5125 / 5128）** | `SearchRepository` 复用 `searchTextNormalization`（共享、与仍 Dexie 的 SearchResults 同一归一化顺序，LOCK-5122）。候选生成：**term ≥ 3 Unicode 码点 → FTS5 trigram；< 3 → 归一化 SQL LIKE**；多 term 取各 term 候选集交集（AND，绝不为可表示 term union LIKE，LOCK-5124）。**FTS 仅为候选加速器，非语义权威（LOCK-5125）**：每个候选必须过共享精确 regex 匹配（whole-word 用 Unicode 边界、CJK 走子串、substring 不包围）；FTS 运行时错误经 `wrapResult → mapErrorToResult` 传播为结构化 `ChatDbFailure`，**绝不 catch 成空结果（LOCK-5101）**。结果仅含最小化 JSON 安全字段（blockId/messageId/topicId/topicName/rawContent/messageCreatedAt，LOCK-5128）。块级游标：`(created_at, message_id, block_id)` 三级排序游标，保证同消息内块级完整分页；**不额外引入 deleted-topic 过滤（与既有 SearchResults 语义一致，LOCK-5123）** |
| **调用方迁移显式延后（Phase 5.2A 边界）** | `SearchMessages` 命令面已实现并通过搜索套件，但 `src/renderer/src/pages/history/components/SearchResults.tsx` 调用方**仍为 Dexie**，仅将 `stripMarkdownFormatting`/`normalizeText` 改为从 `@shared/searchTextNormalization` 复用。**调用方切换到 `chatDb.searchMessages` 属 Phase 5.2A，本阶段不声称已迁移** |
| **10k 基准证据（LOCK-5129，真实运行）** | 载体：`search.bench.ts`（仓库 `*.bench.ts` 约定，仅由 `npx vitest bench --run --project main src/main/services/chatDb/__tests__/search.bench.ts` 收集，普通 `pnpm test` 不执行计时循环）。方法学：确定性 10,000 条 MAIN_TEXT 块（ASCII/CJK/markdown/mixed），10 个代表性 query fixtures；**计时前强制跨全部游标页 / 10 个 query 的直接有序 block-ID 完全 parity 断言**；**3 轮 warmup + 10 轮 measured × 10 query**（每方法 100 样本）；报告 LIKE 基线（全表扫描 + 相同 regex 过滤、按 `(messageCreatedAt, messageId, blockId)` 排序）与 FTS（hybrid，FTS+LIKE）的 p50/p95/mean；无不稳定绝对阈值。产品语义 parity 另由普通套件 `search.test.ts` 的小型确定性语料（300 块、pageSize 20 全游标页）持续守护，不依赖 bench 执行。最新数值（独立 bench 运行）：确定性 10k 直接有序 block-ID parity 10/10；LIKE p50 `6.96ms` / p95 `9.35ms` / mean `6.97ms`；FTS（hybrid）p50 `2.36ms` / p95 `5.20ms` / mean `2.77ms`；加速 p50 `2.95x` / p95 `1.80x` |
| **最终全量验证（独立审计 + 全量门完成）** | 独立审计 pass（含修复后复验）。全量门：`pnpm format` exit 0 无改动；`pnpm lint` exit 0（oxlint 95 warnings / 0 errors；ESLint 33 warnings / 0 errors；current-diff warnings 0；i18n 通过）；`pnpm test` exit 0，283 文件 / 6514 通过 / 72 跳过 / 0 失败 / 181.42s（`search.bench.ts` 排除于普通测试门、单独 bench 运行）；`pnpm typecheck` exit 0 全目标；`git diff --check` exit 0。Phase 5.1B 聚焦套件（`search.test.ts`、`search.bench.ts`、`migration003.test.ts`、aggregate/ipc 扩展）与 `typecheck:node` 通过。已提交 `e44e413f30`（未推送） |
| **退出条件（实现侧）** | ✅ 12 命令经 aggregate + IPC + preload + renderer datasource 落地；✅ migration 003 可幂等应用、触发器维持投影 parity；✅ 搜索正确性 parity 与基准证据成立；✅ 聚焦测试与 typecheck 通过；✅ 最终全量 `pnpm format` / `pnpm lint` / `pnpm test` / `pnpm typecheck` / `git diff --check` 通过。已提交 `e44e413f30`（未推送） |

#### Phase 5.2A：SearchResults 调用方迁移（Dexie → SQLite 搜索）

| 属性 | 值 |
|---|---|
| **状态** | **Done（已提交 `e9de29ff97`，未推送）** |
| **目标** | 将 `SearchResults.tsx` 从 Dexie 搜索切换到 `chatDb.searchMessages`，实现历史搜索路径的 SQLite-only 运行 |
| **前置** | Phase 5.1B 搜索命令面 + 基准完成 |
| **主要任务** | `SearchResults.tsx` 调用方切换到 `chatDb.searchMessages`（复用已迁移的归一化函数）；核对结果映射与现有 UI 行为一致；新增 SearchResults 测试套件（620 行）；i18n 字段更新；`SqliteMessageDataSource` 适配 |
| **退出条件** | ✅ SearchResults 走 SQLite 搜索且行为 parity；✅ 测试覆盖完整；✅ 已提交 `e9de29ff97`（未推送） |

#### Phase 5.2B：主题生命周期调用方集成 + 复合操作增强

| 属性 | 值 |
|---|---|
| **状态** | **实现 + 独立审计 + 全量验证完成（未提交 / 未推送）** |
| **目标** | 在 Phase 5.1B 命令面之上，落地主题生命周期调用方集成（metadata 持久化、trash 恢复流、hard delete 流）、助手空 trash 原子操作、restore wire null 修正、普通 topic 所有权在暴露前的保障、agent Dexie 边界、FileCleanupResult 消费、确定性分页 |
| **实际交付范围** | **新增模块**：`topicMetadataPersist.ts`（topic metadata 持久化层）、`topicTrashLifecycle.ts`（topic trash 生命周期流：soft delete / restore / hard delete / purge 编排）、`topicDeletionFlow.ts`（topic 删除 UI 流）；**修改模块**：`useAssistant.ts`（assistant 空 trash 原子操作 + topic metadata 暴露时序）、`useTopic.ts`（trash 生命周期集成）、`Topics.tsx`（确定性分页 + topic 操作增强）、`TopicTrashPanel.tsx`（trash 面板增强）、`TopicManageMode.tsx`（管理模式集成）、`AssistantItem.tsx`（assistant item trash 集成）、`AssistantService.ts`（assistant trash 方法）、`Chat.tsx`（聊天页集成）、`Inputbar.tsx`（输入栏集成）、`Messages.tsx`（消息列表集成）、`Tabs/index.tsx`（tabs 集成）；**aggregate/IPC**：`ChatDbAggregateService.ts` 新增命令、`ipc.ts` 新增 handler、`preload/index.ts` 新增 bridge 方法、`SqliteMessageDataSource.ts` 新增 renderer datasource 方法、`IpcChannel.ts` 新增 channel、`contracts.ts`/`types.ts` 扩展 |
| **FileCleanupResult 消费（LOCK-5108 / LOCK-5109）** | 复合/生命周期命令返回的 `{ affectedFileIds, remainingReferenceCounts }` 在调用方侧被消费——依据 `remainingReferenceCounts===0` 决定是否物理删除文件；DB 事务内无文件系统副作用 |
| **普通 topic 所有权保障** | topic 在暴露于 UI 操作前完成 ownership 解析与验证；跨 topic 所有权被拒（LOCK-5107） |
| **Agent Dexie 边界** | agent session 操作保持 Dexie 路由隔离；普通 topic 操作不穿越 agent 边界 |
| **确定性分页** | Topics 列表使用确定性分页逻辑，保证翻页稳定性 |
| **已知延后范围（LOCK-DOC4）** | MoveTopic ownership transfer 延后；legacy ImportService ownership 延后；assistant-removal compound flows 属后续工作 |
| **已知限制（LOCK-DOC5）** | Agent session focused assertions 通过，但 runtime agent UI 不可用（无 Main handler/IPC/UI entry），非 ABI 问题；Phase 5.4 E2E 验证 ordinary-chat + topic trash + multi-model + topic move 路径通过 |
| **验证事实** | 标准本地全量验证通过（2026-07-28）：`pnpm format` exit 0 无改动；`pnpm lint` exit 0（33 warnings / 0 errors，标准本地 `CI` 未设置）；`pnpm test` exit 0，289 文件 / 6629 通过 / 72 跳过；`pnpm typecheck` pass；`git diff --check` pass。focused/shared/Main/renderer checks 通过。**CI 环境说明**：`CI=true` 下 `pnpm lint` 会触发 30 个 pre-existing Phase 4 no-console errors（baseline `e9de29ff` 同样复现），属环境/baseline 行为，非 Phase 5.2B 回归（不阻塞本地验证结论）。工作区未提交/未推送 |
| **退出条件** | ✅ 主题生命周期调用方集成完成（metadata / trash / hard delete）；✅ 助手空 trash 原子操作完成；✅ FileCleanupResult 消费正确；✅ 确定性分页验证通过；✅ 独立审计 pass；✅ 全量验证通过（289 文件 / 6629 通过 / 72 跳过）。**提交/推送属待办，不声称已完成** |

#### Phase 5.3：权威切换与 scaffolding 移除

| 属性 | 值 |
|---|---|
| **状态** | **Done（实现 + 独立审计 + 全量验证完成；未提交/未推送；Electron ABI 145 已重建，Phase 5.4 E2E 运行时通过）** |
| **目标** | DbService 默认路由直连 SQLite；移除 Phase 3.4 `routingPolicy.ts`（C-13）；从普通路径移除 `DexieMessageDataSource`（C-11）；清理 Renderer 直接 Dexie 访问（C-10）；Dexie 仅保留于隔离 import renderer |
| **前置** | Phase 5.2A + 5.2B 调用方迁移完成 |
| **主要任务** | 翻转默认数据源为 SQLite；删除路由策略注入与 sqlite-authoritative 拒绝路径；Dexie 路由仅留 import renderer 内部 |
| **实际交付范围** | **普通聊天路径直连 SQLite**：`DbService` 默认数据源从 Dexie 切换为 SQLite，所有普通聊天操作经 `SqliteMessageDataSource` → IPC → `ChatDbAggregateService` → `chat.db`。**routingPolicy scaffolding 移除（C-13）**：删除 `src/renderer/src/services/db/routingPolicy.ts`（`DbRoutingPolicy` 类型、`OrdinaryMessageSource`/`DexieMessageSource`/`AgentMessageSource` 依赖接口、`DbServiceDeps` 构造选项、`'dexie'`/`'sqlite-validation'`/`'sqlite-authoritative'` 策略路由）；`DbService` 重构为无注入直连 SQLite（移除构造注入策略、懒加载切换、永久 Dexie 单例）。**DexieMessageDataSource 从普通路径移除（C-11）**：`src/renderer/src/services/db/DexieMessageDataSource.ts` 从普通聊天路径删除（C-10），仅保留于隔离 import renderer 内部。**Agent 边界保留**：agent session 操作仍经 `AgentMessageDataSource` stub（no-op），与 Phase 5.2B agent Dexie 边界一致。**FileCleanupResult / topic 所有权 / composite 事务语义**：Phase 5.1B/5.2B 已实现的 LOCK-5106…5113 不变量在直连 SQLite 路径上继续有效 |
| **Atomic ownership / reset / resend / destructive cleanup** | 原子 ownership 解析（block → message → topic 路径，LOCK-5107）在直连 SQLite 路径上完整保留；reset / resend 操作（`ResetMessagesForResend` / `DeleteMessagesWithSegments` / `ClearTopicWithSegments`）在单 root 事务内执行 FK cascade（LOCK-5106），`FileCleanupResult` 消费语义不变（LOCK-5108/5109） |
| **Agent / import exceptions** | Agent session 操作保持 `AgentMessageDataSource` stub 路由（策略无关最高优先级）；import renderer 内部仍使用 Dexie（Phase 4 隔离 import 架构不变） |
| **已知限制（LOCK-DOC5）** | Agent session focused assertions 通过，但 runtime agent UI 不可用（无 Main handler/IPC/UI entry），非 ABI 问题；Phase 5.4 E2E 验证 ordinary-chat + topic trash + multi-model + topic move 路径通过 |
| **验证事实** | 标准本地全量验证通过（2026-07-29）：`pnpm format` exit 0 无改动；`pnpm lint` exit 0（97 oxlint warnings + 34 ESLint warnings / 0 errors）；`pnpm test` exit 0，295 文件 / 6577 通过 / 72 跳过 / 0 失败；`pnpm typecheck` pass；`git diff --check` pass。独立审计 pass（0 blockers）。工作区已提交 `b81a35c054`，未推送 |
| **退出条件** | ✅ 普通聊天路径无 Dexie 依赖；✅ Phase 3.4 scaffolding 完全移除（routingPolicy.ts 删除）；✅ DexieMessageDataSource 从普通路径移除（C-11）；✅ 直连 SQLite 路径原子 ownership / reset / resend / destructive cleanup 语义完整；✅ agent / import 边界保留；✅ 全部现有测试通过（295 文件 / 6577 通过 / 72 跳过 / 0 失败）；✅ 独立审计 pass；✅ `pnpm format` / `pnpm lint` / `pnpm typecheck` / `git diff --check` 全通过 |

#### Phase 5.4：E2E / 性能 / 清理门

| 属性 | 值 |
|---|---|
| **状态** | **Done（实现 + E2E + 性能基准 + A-10 spike harness 清理 + 文档收尾；未提交/未推送）** |
| **前置** | Phase 5.3 完成 |
| **目标** | 端到端验证、性能不低于 Dexie 基线、A-10 spike harness 清理、Group D/E 清理与文档收尾 |
| **实际交付范围** | **Electron ABI 145 重建**：better-sqlite3 为 Electron 38（ABI 145）重新编译，E2E 运行时验证通过。**E2E 验证矩阵**（4 个 spec 文件通过）：① ordinary-chat：真实 send / edit / resend / regenerate / copy + exact request/SQL 验证；② topic-trash：soft-delete / restore / hard-delete / empty-trash + name/title + cross-assistant isolation；③ multi-model：append + real dnd reorder persisted；④ topic-move：real delete + undo/redo persisted。**Agent session**：focused assertions 通过（185 tests），但 runtime agent UI 不可用——因无 Main handler / IPC / UI entry，非 ABI 问题。**性能基准**（方法学说明见下）：消息加载 p50 7.42ms / p95 8.23ms；repository two-transaction write microbenchmark 38.5 batch ops/s / 385.2 msgs/s（诚实标注为 microbenchmark，非聚合生产吞吐）；cold open p95 6.91ms < 500ms。**历史 Dexie comparator 不可用**，仅报告绝对 SQLite 结果，不做相对非回归声明。**Phase 4 spike gate 已通过后删除**：A pass、C1 4/4、C2a 8/8、C2b 10/10 在 Phase 4 spike gate 通过后，22 个 spike-only 文件 + build gate 已移除（A-10 fulfilled/deleted）；production imports 保留/审计。**零 ordinary runtime Dexie chat-table references** 确认；有效例外：agent / import / Phase 6 backup。**Topic name persistence 和 durable file lifecycle correctness fixes** 在 E2E 过程中发现并实现/审计。**文档收尾**：更新本迁移文档反映 Phase 5.4 最终态 |
| **A-10 spike harness 清理** | Phase 4.0 的 22 个 spike-only 文件（含 `packages/shared/phase4*.ts`、`scripts/phase4-*.sh`、`src/main/phase4-*.ts`、`src/preload/phase4-spike-preload.ts`、`src/renderer/phase4Spike.html`、`src/renderer/src/windows/phase4Spike/`、`electron.vite.config.ts` 的 `PHASE4_SPIKE=1` build gate）已移除。A-10 原始保留决策在 Phase 4 spike gate（A pass、C1 4/4、C2a 8/8、C2b 10/10）通过后 fulfilled/deleted。production imports（`src/main/services/chatDbImport/`、`src/preload/chatImport/`、`src/renderer/src/windows/chatImport/`）保留，不受影响 |
| **E2E 方法学** | Playwright E2E 覆盖普通聊天路径（ordinary-chat / topic-trash / multi-model / topic-move）；每个 spec 使用真实 IPC/SQLite 路径（非 mock）；agent session focused assertions 通过但无 runtime UI 覆盖（无 Main handler/IPC/UI entry） |
| **性能方法学** | 消息加载：真实消息加载延迟测量，p50/p95 统计。Repository two-transaction write microbenchmark：两事务写入微基准，标注为微基准非聚合生产吞吐（LOCK-DOC6）。Cold open：冷启动 DB 打开时间 < 500ms。**历史 Dexie comparator 不可用**：不声明相对非回归，仅报告绝对 SQLite 结果（LOCK-DOC7） |
| **最终仓库验证（Node v24.12.0 ABI 137 / pnpm 10.27.0）** | `pnpm format` PASS（无改动）；`env -u CI pnpm lint` PASS（0 errors / 17 pre-existing warnings）；`pnpm typecheck` + i18n + format recheck PASS；`pnpm test` PASS（**304 文件 / 6598 通过 / 72 跳过 / 0 失败**）；`pnpm typecheck` PASS（node/web/aicore 全过）；`git diff --check` PASS；无 generated JS / temp / process artifacts。**better-sqlite3 final local binary 为 ABI 137（host Node v24.12.0）**。**Electron ABI 145 E2E 证据已在 earlier targeted rebuild 中记录**（E2E 运行时通过），不隐含同一 binary 同时适用于两个 ABI。历史 Dexie comparator 不可用，不做相对非回归声明（LOCK-DOC7） |
| **退出条件** | ✅ E2E 通过（4 个 spec：ordinary-chat / topic-trash / multi-model / topic-move）；✅ 性能基准完成（消息加载 p50/p95、write microbenchmark、cold open < 500ms）；✅ A-10 spike harness 已清理（22 文件 + build gate 移除）；✅ 零 ordinary runtime Dexie chat-table references（有效例外 agent/import/backup）；✅ Group D/E 清理完成（部分：A-10 已清理；剩余 Group D/E 属 Phase 6）；✅ 文档更新反映最终态；✅ **最终仓库验证通过（304 文件 / 6598 通过 / 72 跳过 / 0 失败；lint 0 errors / 17 pre-existing warnings；format/typecheck/git-diff-check 全 PASS；无 artifacts）** |

#### Phase 5 Decision Locks（LOCK-5101…5113, LOCK-5121…5129）

> 全部 LOCK-51xx 在本 session 确立且**保持 active**；Phase 4 全部 LOCK-44xx 与历史 ADR/决策继续有效。下表为合并相关锁的持久化形式，保留 lock ID 与后续阶段必需的精确不变量；不重复本 session 的冗长 prompt。

| Lock | 精确不变量（后续阶段必需） |
|---|---|
| **LOCK-5101** | 搜索 / 聚合运行时错误经 `wrapResult → mapErrorToResult` 传播为结构化 `ChatDbFailure`；**绝不 catch-to-empty（失败返回零结果）** |
| **LOCK-5102** | Phase 5 SQLite 命令面完整性：所有普通聊天路径命令经 `ChatDbAggregateService` + typed IPC 实现（14 + 9 + 12 = 35 个 `ChatDb_*`）；Dexie 路由移除属 5.3 独立关切 |
| **LOCK-5103** | `UpdateTopicMetadata`：name 为 null 清除、absent 不变；pinned 等扩展存 `extra` JSON；单 root 事务 |
| **LOCK-5104** | `SoftDeleteTopic` 置 `deleted_at`，仍可被 `ListTrashTopics` 查询；普通列表排除 trash |
| **LOCK-5105** | `RestoreTopic` 清除 `deleted_at`，仅恢复可见性、不复活数据 |
| **LOCK-5106** | 复合 / 生命周期命令原子性：每个多表变更在**一个 root SQLite 事务**内完成；FK cascade 处理 blocks→file_references→segments |
| **LOCK-5107** | 所有权强制：block/message ID 经「block → message → topic」解析；跨 topic 所有权被拒 |
| **LOCK-5108** | `FileCleanupResult`：命令仅返回 `{ affectedFileIds, remainingReferenceCounts }`；**DB 事务内无文件系统副作用**；物理删除由调用方据 `remainingReferenceCounts===0` 决定 |
| **LOCK-5109** | `HardDeleteTopic` / `PurgeExpiredTopics`：topic→messages→blocks→file_references 经 FK cascade 在单事务删除；`buildFileCleanupResult` 聚合受影响 file ID；事务内不改 Dexie 文件计数 |
| **LOCK-5110** | `ReorderMessages` 仅在 topic 内重写 `sort_order`，不跨 topic 移动 |
| **LOCK-5111** | Segment 生命周期（5.1A）：upsert/update-metadata/delete/replace-membership/list；`ReplaceSegmentMembership` 为全量替换（非 merge） |
| **LOCK-5112** | file-ref 反向查询（5.1A）：`ListFileRefsByFile` / `CountFileRefsByFile` / `ListBlocksByFile` 为只读投影，无变更 |
| **LOCK-5113** | `PurgeExpiredTopics(cutoffTimestamp)` 的 cutoff **由调用方提供**；Main 聚合层不启动计时器、不自算 cutoff |
| **LOCK-5121** | migration 003 append-only 且幂等；在任何触发器触发前于原始 better-sqlite3 连接注册 `chatdb_normalize()`；可安全应用于既有 DB |
| **LOCK-5122** | 搜索文本归一化单一顺序：`normalizeSearchText = normalizeText(stripMarkdownFormatting(content)).toLowerCase()`（先 stripMarkdown，后 CRLF→LF，后 lowercase）；`searchTextNormalization` 为共享单一事实源，Main / renderer / 仍 Dexie 的 SearchResults 共用 |
| **LOCK-5123** | 搜索必须保留既有 SearchResults 语义（归一化、term 解析、whole-word/substring、CJK 子串、`(created_at, message_id, block_id)` 排序）；SQLite 实现**不额外引入 deleted-topic 过滤**以匹配原调用方数据范围 |
| **LOCK-5124** | FTS 候选路由：term ≥ 3 Unicode 码点 → FTS5 trigram 候选；< 3 → 归一化 SQL LIKE；多 term 取各 term 候选集**交集（AND，绝不为可表示 term union LIKE）** |
| **LOCK-5125** | **FTS 仅为候选加速器，非语义权威**：每个候选必须过共享精确 regex 匹配；FTS 运行时错误传播（绝不 catch-to-empty） |
| **LOCK-5126** | `chatdb_normalize()` 与 `searchTextNormalization` 为归一化单一事实源；触发器与 FTS 填充均调用 `chatdb_normalize()`，无分歧归一器 |
| **LOCK-5127** | migration 003 触发器维持投影 parity：对 MAIN_TEXT 块的 INSERT/UPDATE/DELETE 反映进 `message_blocks_normalized` + `message_blocks_fts`；投影为派生，永不作为权威 |
| **LOCK-5128** | 搜索结果契约仅含最小化 JSON 安全字段（blockId/messageId/topicId/topicName/rawContent/messageCreatedAt），不返回结构化/overflow model 对象 |
| **LOCK-5129** | 基准方法学：确定性 10,000 MAIN_TEXT 块；3 warmup + 10 measured × 10 query；报告 LIKE 与 hybrid 的 p50/p95/mean；**强制跨全部游标页 / 10 query 的有序 block-ID parity**；无不稳定绝对阈值 |
| **LOCK-DOC6** | Phase 5.4 性能基准方法学：repository two-transaction write microbenchmark 标注为微基准，非聚合生产吞吐；消息加载 p50/p95 统计；cold open < 500ms。不做相对 Dexie 非回归声明（因历史 Dexie comparator 不可用） |
| **LOCK-DOC7** | 历史 Dexie 性能 comparator 不可用：Phase 5.4 仅报告绝对 SQLite 结果（消息加载 p50 7.42ms / p95 8.23ms；write microbenchmark 38.5 batch ops/s / 385.2 msgs/s；cold open p95 6.91ms），不声明相对 Dexie 性能非回归 |

### Phase 6：Cherry Chat 备份/恢复适配、L2/L3 UX 语义分离、清理

| 属性 | 值 |
|---|---|
| **状态** | Not started |
| **前置** | Phase 5 完成 |
| **目标** | 在 SQLite-authoritative 的 Cherry Chat 上，沿用并适配现有 Cherry Studio 本地/WebDAV/S3 备份与恢复产品流程以对接 chat.db；并将该同应用备份/恢复（L3）与 Cherry Studio ZIP 跨应用兼容导入（L2）的 UX 语义清晰分离；清理所有遗留 |
| **主要任务** | 沿用现有 Cherry Studio 备份/恢复产品行为并适配 chat.db（底层一致性快照由 Phase 1 集成的 better-sqlite3 online backup 机制提供，存储层已就绪，Phase 6 完成产品侧对接与硬化），与 Cherry Studio ZIP 导入 UX 在语义上分离；清理 Group D + Group E 遗留项；更新文档；确认备份协调完整；移除不再需要的隔离 import renderer 代码（如果已完成导入且不再需要） |
| **退出条件** | ✅ Cherry Chat 备份/恢复（沿用现有产品流程、适配 chat.db）独立运作；✅ Cherry Studio ZIP 导入作为一次性操作独立运作；✅ L2/L3 产品语义清晰分离；✅ Group D/E 清理完成；✅ 文档更新；✅ CI 绿色 |

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
│ · 状态机：candidate-ready→verifying→     │
│   verified-candidate | verification-failed│
│ · 取消/退出：close-before-discard         │
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
| 旧备份兼容 | 迁移后备份格式变化 | Cherry Chat 备份/恢复沿用现有 Cherry Studio 产品流程并适配 chat.db（L3），与 Cherry Studio ZIP 导入（L2）语义分离 |
| 性能未知 | SQLite 在 Electron 中的实际表现未测试 | Phase 5 切换前必须完成基准测试 |
| 技术栈选型 | ~~libSQL+Drizzle 可能不是最优选择~~ | **Resolved**（A-7 Accepted：better-sqlite3 + Drizzle） |
| **集成同步门已完成（migration pre-merge HEAD `5d50499e80` ↔ integration `05a401b711` 已合并/已验证）** | 原风险（合并前基于过期结构实现导致返工）已消除；合并自动解决、无兼容性编辑、验证全过 | **Resolved（已合并/已验证）**：migration 与 integration 已合并，统一 Renderer/context/type/Redux 结构已建立；Phase 4.4 架构未变，可在合并后结构上实现 |

---

## 12. 验收指标 / Go-No-Go

### Phase 4 exit criteria（导入管线）

| 指标 | 目标 | 状态 |
|---|---|---|
| Phase 4.0 spike | fromPath + origin + Dexie schema 跨平台验证通过（或 helper 进程回退设计完成） | **Done — Go on macOS arm64** (Windows/Linux open; helper contingency recorded) |
| ZIP 安全解压 | 唯一临时工作区 + IndexedDB 结构校验 | **Done** |
| 隔离 Session 读取 | import renderer 通过当前 Dexie schema 成功读取源数据 | **Done** |
| 候选 DB 构建 | 10k 消息完整导入；导入中断不损坏现有 DB | **Done** |
| 验证全通过 | ID/计数/字段/顺序/关系/哈希/integrity_check/foreign_key_check/应用层抽样 | **Done**（Phase 4.3，已提交/已推送） |
| 原子 promotion | 成功 → reopen + relaunch；失败 → 回滚到快照 | **Done（全量验证通过，独立审计 pass）**（Phase 4.4.0 协议层；Phase 4.4.1 准备门 + rollback 快照 + journal `snapshot-ready`；Phase 4.4.2 破坏性执行止于 durable `replacement-verified`；Phase 4.4.3 落地 recovery executor/gate + artifact probes + rollback staging clone/atomic rename + durable journal cleanup + terminal take + repair marker + startup reorder + relaunch exact-once。独立审计 pass（两项 accepted fixes：real durable repair marker、startup gate fail-closed）；聚焦测试 71 文件/1709 通过/72 跳过；全量验证通过：format 无改动；lint 0 errors/97 warnings；test 281/6205/72 skipped；typecheck:node pass；未提交/未推送） |
| 取消支持 | promotion 前任意步骤取消不损坏现有 DB（含 4.3 close-before-discard） | **Done** |

### Phase 5 exit criteria（Cherry Chat SQLite-only runtime）

> 顶层退出指标保留；子阶段进度见 Section 9 Phase 5 及「Phase 5 Decision Locks」。Phase 5.1A 已提交、5.1B 已提交（`e44e413f30`，未推送）；5.2A 已提交（`e9de29ff97`，未推送）、5.2B 实现 + 独立审计 + 全量验证完成（未提交/未推送）；5.3 实现 + 独立审计 + 全量验证完成（已提交 `b81a35c054`，未推送）；5.4 Done（实现 + E2E + 性能基准 + A-10 spike harness 清理 + 文档收尾，未提交/未推送；最终仓库验证 Node v24.12.0 ABI 137 / pnpm 10.27.0：304 文件 / 6598 通过 / 72 跳过 / 0 失败；lint 0 errors / 17 pre-existing warnings；format/typecheck/git-diff-check 全 PASS；Electron ABI 145 E2E 证据已在 earlier targeted rebuild 中记录；agent runtime UI 因无 Main handler/IPC/UI entry 不可用，非 ABI 问题）。

| 指标 | 目标 | 状态 |
|---|---|---|
| 消息加载延迟（p50/p95） | 不退化 | **Done（5.4）**：p50 7.42ms / p95 8.23ms；历史 Dexie comparator 不可用，仅报告绝对 SQLite 结果（LOCK-DOC7） |
| 消息写入吞吐 | 不退化 | **Done（5.4）**：repository two-transaction write microbenchmark 38.5 batch ops/s / 385.2 msgs/s（标注为 microbenchmark 非聚合生产吞吐，LOCK-DOC6） |
| 数据完整性 | 100% | **Done（5.1A/5.1B/5.2A/5.2B/5.3/5.4）**：E2E 验证 4 spec 通过（ordinary-chat/topic-trash/multi-model/topic-move）；零 ordinary runtime Dexie chat-table references（有效例外 agent/import/backup）；topic name persistence + durable file lifecycle correctness fixes 审计通过 |
| 冷启动 DB 打开时间 | < 500ms | **Done（5.4）**：cold open p95 6.91ms < 500ms |
| 普通聊天路径无 Dexie 依赖 | 0 Dexie 引用 | **Done（5.3）**（5.2A 已迁移 SearchResults 至 SQLite；5.2B 集成主题生命周期调用方；5.3 完成权威切换 + scaffolding 移除，普通聊天路径直连 SQLite） |
| Phase 3.4 routing scaffolding | 完全移除 | **Done（5.3）** |
| A-10 spike harness 清理 | 完全移除 | **Done（5.4）**：22 个 spike-only 文件 + build gate 移除；A-10 fulfilled/deleted；production imports 保留 |
| 所有测试通过 + CI 绿色 | 100% | **Done（Phase 5.4 最终仓库验证，Node v24.12.0 ABI 137 / pnpm 10.27.0）**：`pnpm test` PASS（**304 文件 / 6598 通过 / 72 跳过 / 0 失败**）；`pnpm format` PASS（无改动）；`env -u CI pnpm lint` PASS（0 errors / 17 pre-existing warnings）；`pnpm typecheck` PASS（node/web/aicore）；`git diff --check` PASS；无 generated JS / temp / process artifacts。better-sqlite3 final local binary 为 ABI 137（host Node）。Electron ABI 145 E2E 证据已在 earlier targeted rebuild 中记录（E2E 运行时通过）。历史 Dexie comparator 不可用（LOCK-DOC7）。CI 待推送后验证——`CI=true` 下 pre-existing no-console errors 为 baseline 环境行为，非 Phase 5 回归 |

### Phase 6 exit criteria（备份/恢复适配 + L2/L3 语义分离 + 清理）

| 指标 | 目标 | 状态 |
|---|---|---|
| Cherry Chat 备份/恢复 | 沿用现有产品流程并适配 chat.db，独立运作（底层 better-sqlite3 online backup 为 Phase 1 存储层机制） | Not started |
| Cherry Studio ZIP 导入 | 作为一次性操作独立运作 | Not started |
| Group D/E 清理 | 全部完成 | Not started |
| 文档更新 | 反映最终状态 | Not started |
| CI 绿色 | 100% | Not started |

**Go 条件（Phase 4→5）**：
- Phase 4 所有 exit criteria 通过
- 至少一次成功端到端导入（真实 Cherry Studio ZIP → Cherry Chat SQLite-only runtime）

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
| **Q-9** | **Windows/Linux `session.fromPath` + 文件锁 + 清理行为** | **Phase 4.1 production 化（A-9）** | **Deferred 至 macOS-first 完成后**。Phase 4.1 实施期间不验证（A-9 Accepted）。未来开放路径：删 `process.platform !== 'darwin'` 拒绝 + 重跑 Phase 4.0 spike 验证（spike harness 已在 Phase 5.4 删除，需重建最小验证脚手架）+ 调 `tempWorkspace.ts`/`isolatedSession.ts` 清理退避参数。重点未验证项：NTFS 不能删打开文件（EBUSY 重试策略）、Windows `session.fromPath` 锁文件/缓存语义、Linux 不同 filesystem 行为 |
| **Q-10** | **真实 ZIP snapshot 损坏/不完整检测策略划分** | **Phase 4.1 vs 4.3** | **4.1 最小，4.3 全面**。Phase 4.1 仅做：① ZIP 结构 5 层校验（大小/条目数/单条/总量/加密；zip-slip 用 `path.resolve` 跨平台防护）；② IndexedDB 目录存在性 + 含 `.ldb` 子目录的通用探测（不硬编码 `file__0.indexeddb.leveldb`，spike 观测仅为 file:// origin 下情况）；③ `indexedDB.databases()` discovery 成功。**完整损坏/不完整检测延后至 Phase 4.3** Verification（源 vs 目标 ID/计数/字段/顺序/关系/哈希/integrity_check/foreign_key_check/应用层抽样）。Phase 4.1 不引入 importer-specific 历史修复（继承 A-8 约束） |
| **Q-11** | **Phase 4.0 17 个 harness 文件去留** | **Phase 4.1 production 化（A-10）** | **Resolved（Fulfilled/Deleted, 2026-07-30）**：Phase 5.4 spike gate 通过后已删除（A-10 fulfilled）。spike gate 结果：A pass、C1 4/4、C2a 8/8、C2b 10/10。22 个 spike-only 文件 + `PHASE4_SPIKE=1` build gate 移除。Production imports 保留 |
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
| **2026-07-21** | **A-10 Accepted：Phase 4.0 harness 保留至 Phase 5** | 17 个 harness 文件保留至 Phase 5（与 Group D 一并）。`PHASE4_SPIKE=1` 门控不进生产构建。Phase 4.1 生产模块独立新增 `src/main/services/chatDbImport/` + `src/preload/chatImport/` + `src/renderer/src/windows/chatImport/`，不复用 spike 代码。spike 专属（argv/exit/fixture/IPc multiplexer/A-B markers）丢弃，可复用硬事实（fromPath + file:// origin + indexedDB.databases + production Dexie upgrades + sender.id 校验 + will-navigate/setWindowOpenHandler deny）由生产模块重新干净实现。**Phase 5.4 已 fulfilled/deleted**：spike gate（A pass、C1 4/4、C2a 8/8、C2b 10/10）通过后 22 个 spike-only 文件 + build gate 已移除 |
| **2026-07-21** | **Phase 4.1 只读诊断完成** | Fresh Analyzer 产出 Phase 4.1 source-reader 侧生产化方案：① 模块划分（chatDbImport/ 下 zipIntake/isolatedSession/tempWorkspace/importIpc/index + 专用 preload/import renderer HTML）；② ZIP 库复用 node-stream-zip（BackupManager/DxtService 已用，零新依赖），5 层校验（500MB/10k条目/200MB单条/2GB总量/拒加密 + zip-slip path.resolve 跨平台 + IndexedDB 目录通用探测）；③ Import-only IPC 6 channel（ChatImport_Ready/Discover/ReadPage/Cancel/Complete/Error）独立于 14 个 ChatDb_*；envelope `sessionId+phase+version:1`；DTO 复用 Dexie 逻辑形状不引 import-specific；④ 12 条 correctness risks 全部本轮内处理；⑤ 决策待用户拍板项：跨平台策略、spike 去留、import renderer HTML 入口——均已闭环（A-9/A-10/Q-12） |
| **2026-07-21** | **Phase 4.1 source-reader 生产化完成** | 17 个新文件 + 4 个修改文件：`src/main/services/chatDbImport/`（errors/tempWorkspace/zipIntake/isolatedSession/importIpc/index + 5 tests），`src/preload/chatImport/index.ts`，`src/renderer/src/windows/chatImport/`（chatImport.html + entryPoint.ts），`packages/shared/chatImport/`（types/index/validation.test.ts），`packages/shared/IpcChannel.ts` 6 ChatImport_* entries，`electron.vite.config.ts` chatImport HTML + preload entry，`src/main/ipc.ts` + `src/main/index.ts` 注册/will-quit/app-ready wiring。安全：5 层 ZIP 校验 + `session.fromPath(destDir)` + `location.protocol` origin 校验 + `event.senderFrame` sender 校验 + singleton + R-1..R-12 全部 mitigated。主进程 977/977 测试通过。最终 Auditor Clean。合入 commit `6a1e98e7ef` |
| **2026-07-27** | **Phase 4.2 Done** | Candidate SQLite bulk importer 完成。实际模块：`CandidateDbResource`（per-session 自有候选目录 + 候选 chat.db）、`ChatImportDataPlane`（分页数据面 + `SourceReadStats`）、`ChatImportWriter`（import-only 保序 writer，order-preserving，`candidate-ready` exact-once，`CandidateImportStats`）、`startupRecovery`（取消/错误/孤儿清理）。每页一事务、topic/message 扁平化、block/segment/file-reference 精确映射、replace-all 语义；`SourceReadStats` vs `CandidateImportStats` 分离。10k 基准：25 topics / 10,000 messages / 11,000 blocks / 26 segments / 250 memberships / 667 file refs / 19 pages；两次运行 1016.2ms、978.5ms；`integrity_check` ok、`foreign_key_check` 空、live DB 未改。单元审计 + 最终审计 0 阻塞；聚焦测试通过；全量本地验证通过（2026-07-27）：`pnpm format` exit 0 无改动；`pnpm lint` exit 0（node/web/aicore typecheck 全过、i18n 校验通过、0 errors，仅 pre-existing warnings）；`pnpm test` exit 0，252 文件 / 5325 通过 / 72 跳过；无遗留产物（本地全量验证未涉及 CI） |
| **2026-07-27** | **Phase 4.3 Done** | Deterministic verification 完成（已提交/已推送；本地全量验证未涉及 CI）。实际模块：`CandidateVerifier`（只读验证器，返回稳定 13 维度结果 + 有界安全诊断，不泄露 SQL/path/stack）、`SourceVerificationManifest`（按页证据清单，仅在 DB 事务提交后落盘，stable canonical SHA-256 framing，manifest ~5,019KiB）、`VerificationReport`（~1.4KiB）；候选 DB 会话状态机 `candidate-ready → verifying → verified-candidate | verification-failed`；取消/退出 `close-before-discard`；通过保留候选 DB 供 4.4、失败报告后清理；corruption matrix 覆盖全部 13 维度。10k 验证证据：25 topics / 10,000 messages / 11,000 blocks / 26 segments / 250 memberships / 667 file refs / 19 pages；13 维度全过；验证耗时 ~250–290ms；现有 live `chat.db` 未改。聚焦测试 271 通过；`pnpm format` exit 0 无改动；`pnpm lint` exit 0（0 errors，109 warnings）；`typecheck:node` 通过；首次 `pnpm test` 5420 通过 / 2 失败（BackupManager 共享临时目录非确定性 flakes，排查否定 Phase 4.3 干扰）/ 72 跳过；复跑 `pnpm test` 258 文件 / 5422 通过 / 72 跳过 / 0 失败；Main 与全量多次复跑干净；最终审计 0 findings（本地全量验证，未涉及 CI） |
| **2026-07-27** | **集成同步门（Baseline Sync Gate，Done/已合并/已验证）** | **已完成**：integration（`05a401b711`）已集成同步进 migration（pre-merge HEAD `5d50499e80`）；合并自动解决、无兼容性编辑；审计 0 blocker / 0 code finding；验证全过：format 无改动；lint exit 0（112 known warnings）；typecheck 通过；`pnpm test` 265 文件 / 5664 通过 / 72 跳过 / 0 失败；聚焦测试 201 renderer + 822 chatDb/import。合并未改变 Phase 4.4 既有架构；Phase 5 须以合并后的 Renderer/context/type/Redux 结构为实施基线。历史锚点：migration 推送 tip `85603d0fd5`、两分支距 merge base `44e6b1b82b` 分别 15/21 commits（合并前基线事实）。 |
| **2026-07-27** | **Phase 4.4.0 Done（Promotion 协议基础，纯协议层）** | LOCK-4401…4406 全落地且无副作用（LOCK-4405）。实际模块：`chatDbImport/promotion/{protocol,journal,recovery}.ts`（状态/exact-once/边界纯决策 + journal v1 严格 codec + 90 组合穷举恢复矩阵 + 12 崩溃点映射）、`chatDb/maintenanceCoordination.ts`（backup/restore/promotion/init/close 五操作统一互斥 lease 契约，未接线）、`chatDbImport/index.ts`（`ImportState` + `promoting/promoted/promotion-failed`；`claimPromotion()` 唯一入口 bounded to `getVerifiedCandidate()` + 不可复用 token；`completePromotion()` exact-once 终态结算；cancel 在 promoting 拒绝；async dispose/sync will-quit 保留 promotion-owned 候选）、`startupRecovery.ts`（纯契约 re-export，孤儿清理行为不变）。固定命名：journal `chat-import-promotion.journal.json`、snapshot `chat.db.pre-import-backup`（+`.staging` 单份保留顺序，LOCK-4403）。验证：聚焦 chatDb+chatDbImport 29 文件 / 895 通过 / 0 失败（基线 822 + 新增 73）；`typecheck:node` 通过。资产表旧路径 `chatDb/import/promotion.ts` 已修正为 `chatDbImport/promotion/`。真实文件操作/接线/IPC/relaunch 属 Phase 4.4.1+ |
| **2026-07-27** | **Phase 4.4.1 Done（Durable Preparation Gate，快照就绪准备门）** | LOCK-4411…4417 全落地（当前实现未提交/未推送）。在 Phase 4.4.0 协议层之上落地：① 统一维护接线（LOCK-4411）——`maintenanceCoordination.ts` 将 promotion 实际接入既有 backup/restore/init/close 互斥协调、成为唯一 lease 持有者、无第三个独立运行时锁；② rollback 快照（LOCK-4412 / LOCK-4403）——live 打开时 online backup 创建 `chat.db.pre-import-backup`：live→staging→验证→原子 rename 覆盖（不复制 WAL/SHM），仅创建发布不 restore；③ 严格持久化 journal store（LOCK-4413）——`promotion/journal.ts` 新增 crash-safe 落盘 writer、原子 rename 写入 `chat-import-promotion.journal.json`，内容恰好 version/sessionId/candidateId/phase（snapshot-ready 已落盘），exact-key codec 不变；④ 启动候选保护（LOCK-4414）——`startupRecovery.ts` 扩展为读取 journal、保护 journal-referenced 候选（排除年龄清理）、按 4.4.0 恢复矩阵 `decidePromotionRecovery` 安全分类中断资产，不影响正常启动；⑤ exact-once prepared handle（LOCK-4415）——`claimPromotion()` 不可复用 token 形成 prepared handle、准备窗口唯一可消费、promotion-owned 下 dispose/will-quit 仍保留候选；⑥ 非破坏性边界（LOCK-4416）——整个 4.4.1 不关闭/替换/重命名 live `chat.db`、失败回退 keep-old-live/repair-required、所有写为 staging+原子 rename；⑦ 审计/验证最终门（LOCK-4417）——独立审计首轮发现 candidateId 与 session 集成两阻塞均已修复、复审 0 findings。验证：`pnpm format` 通过（无改动）；`pnpm lint` exit 0（82 oxlint + 33 eslint known warnings，115 emitted warning instances，0 errors）；`pnpm typecheck:node` 通过；`pnpm test` exit 0，272 文件 / 5860 通过 / 72 跳过 / 0 失败；本地全量验证，未涉及 CI / 未提交 / 未推送。最大边界止于 snapshot-ready；live close/install/replace/restore/relaunch 属 Phase 4.4.2+ |
| **2026-07-27** | **Phase 4.4.2 Done（Destructive Promotion Executor，破坏性替换执行）** | LOCK-4421…4428 全落地（当前实现未提交/未推送；独立审计已完成：pass-with-findings，两项接受的 ownership/isolation 硬化修正已落地并复验——见下一条；Phase 4.4.0/4.4.1 已本地提交 `7768b7e30c`/`006615aff6`，未推送）。实际模块：① exact-once prepared→executing capability（LOCK-4421）——`preparation.ts` `consume()` 恰好一次产出 `ExecutingPromotionCapability`，重复/stale 有界拒绝，consume 后 prepared dispose 为 lease-preserving no-op；② owner-aware live 生命周期（LOCK-4422）——`chatDb/index.ts` 新增 `closeForPromotion`/`reopenForPromotion`（变更前验证当前持有 promotion lease，不嵌套 init/close lease；公共 init/close 语义不变），`maintenanceCoordination.ts` 新增 `validatePromotionAuthorization`（WeakMap grant 注册表 + holder peek，仅 verdict）；③ 原子安装（LOCK-4423/4426/4427）——`install.ts`：closed-live proof（单次使用、模块 brand、close 成功后立即铸造、install 前重验证+消费）→ 删除 live sidecars → 源 bigint identity → fsync 源 → 原子 rename-only（EXDEV 有界失败、无 copy fallback）→ fsync 父目录 → 目标 identity 确认 → brand `InstallReceipt`；④ 严格 journal 递进（LOCK-4423/4424/4425）——`journalStore.ts` 两个显式 transition API（snapshot-ready→candidate-installed→replacement-verified，phase/identity 严格前置校验，拒绝均在变更前，失败不清 journal）；⑤ identity-bound 验证（LOCK-4424）——`replacementVerifier.ts`：receipt brand + dev/ino identity 前后校验（size 有意不门）+ `readonlyDbValidation.ts` 共享只读门（integrity/FK/migration/抽样读，与 4.4.1 快照验证器同序）；⑥ 执行编排（LOCK-4425/4428）——`execution.ts` 8 subphase 不可重排序列、每个不可逆边界重验证授权、pre-install（reopen 恢复可用性，非回滚）/post-install（保留全部产物、recovery-required、绝不回滚/清理/relaunch）失败分类、协作式 abort；`chatDbImport/index.ts` `startPromotionExecution()` 唯一入口（同步帧 consume + 永不重置 start guard），`promoted` 仅在 durable replacement-verified 后结算，ownership 释放一律在 executor quiesce 后；执行终点 durable `replacement-verified` handoff（仍持有同一 lease）。验证：聚焦受影响区域 35 文件 / 1141 测试通过 / 0 失败（审计修正前基线 1138，保留为聚焦验证证据）；`typecheck:node` 通过；**最终全量验证通过（未涉及 CI / 未提交 / 未推送）**：`pnpm format` 通过（无文件改动）；`pnpm lint` 通过（0 errors / 87 warnings）；`pnpm test` 通过，275 文件 / 5983 通过 / 72 跳过；`pnpm typecheck:node` 通过；独立审计与复验均 pass。restore/relaunch/启动恢复动作执行属 Phase 4.4.3（Not started） |
| **2026-07-27** | **Phase 4.4.2 独立审计修正落地（终局 ownership 硬化）** | 独立审计结论 pass-with-findings（无阻塞）；两项 findings 接受为 correctness hardening 并已落地：① 成功 promoted 后 `session.executingCapability` 保留别名 → stale session fail/dispose 可释放成功 handoff 的授权；修正为显式 transfer（非 alias）：`takeExecutingCapability()` 将 capability 移出 session，终局记录 `TerminalPromotionOwnership { kind:'promoted' }` 成为唯一逻辑 owner。② post-install 失败在 executor quiesce 后释放 capability → 允许进程内公共 init 打开未验证的 installed DB；修正为 `PromotionRecoveryRequiredHandoff` 保留 capability/同一 lease（LOCK-4425 强化不变量：recovery-required handoff 保留 lease 阻断一切 ordinary maintenance 直至 Phase 4.4.3 或进程退出；pre-install 失败仍在 quiesce 后正常释放）。终局 ownership 结算唯一归属 `startPromotionExecution` continuation（executor 引用存在期间 fail/dispose/will-quit 一律延迟）；附带：prepared-handle disposal 去重 helper、`transferPromotionExecution` interim-owner 契约 JSDoc、`getTerminalPromotionOwnership()` Main-local peek。改动仅 `chatDbImport/index.ts` + `promotion/execution.ts`（doc-only）+ `chatDbImport/__tests__/index.test.ts`（C18 更新、C24–C26 新增）。复验：聚焦 35 文件 / 1141 通过 / 0 失败；`typecheck:node` 通过；changed-files biome/eslint 干净；未提交/未推送 |
| **2026-07-27** | **Phase 4.4.2 已提交 `3a81557ac6`** | Phase 4.4.0（`7768b7e30c`）+ Phase 4.4.1（`006615aff6`）+ Phase 4.4.2 一并提交至 `3a81557ac6`（`feat(chat-db): execute durable candidate promotion`），未推送 |
| **2026-07-28** | **Phase 4.4.3 Done（Recovery/Finalization）** | LOCK-4431…4439 全落地（实现 + 独立审计 pass（两项 accepted fixes：real durable repair marker、startup gate fail-closed）+ 全量验证通过；未提交/未推送）。在 Phase 4.4.2 终点（durable `replacement-verified` handoff）之上落地恢复/终结管线全部执行侧：① **artifact probes**（`artifactProbe.ts`）——只读磁盘 truth 等价探测（live/retained snapshot/candidate 三 artifact 状态：missing/present-unverified/present-verified），路径由 Data root 严格派生（LOCK-4434），candidateId strict allowlist 校验，sidecar-free invariant（controlled no-residue strategy），before/after directory snapshots 证明零净文件系统变更；② **rollback**（`rollback.ts`）——bounded primitive：staging clone（`fs.copyFileSync` from retained snapshot，closed self-contained source）→ fsync → full readonly validation gate → consume closed-live proof → delete live sidecars → capture staging identity → atomic rename staging→live（同文件系统 ONLY，EXDEV=structured failure 无 copy fallback，LOCK-4426）→ fsync live parent dir → confirm destination identity → full readonly validation of restored live。LOCK-4434：retained snapshot **从不被消费或删除**；LOCK-4437：任何 failure 保留全部 artifacts；Clone decision：`fs.copyFileSync` chosen over SQLite backup API（source closed，re-opening 仅为 backup facility 无安全增益）；③ **journal cleanup**（`journalStore.ts` 扩展）——idempotent fixed-path cleanup primitive（`cleanupPromotionJournalBody`），三个 phase-gated API（`cleanupPromotionJournalAfterReplacementVerified` / `AfterSnapshotReady` / `AfterCandidateInstalled`）；guard-read validates journal → absent = idempotent success；invalid/phase mismatch/identity mismatch = reject pre-mutation；unlink → best-effort staging unlink → fsync parent dir（LOCK-4438）；仅 fixed journal + stale staging 为 deletion candidates（LOCK-4436），rollback snapshot / candidate / live 永不触碰；unlink failure → `CLEANUP_UNLINK_FAILED`（journal preserved）；dir sync failure → `CLEANUP_PARENT_DIR_SYNC_FAILED`（journal already unlinked）；④ **terminal ownership take**（`chatDbImport/index.ts`）——`takeTerminalPromotionOwnership()` atomically take-and-clear `TerminalPromotionOwnership`（LOCK-4433）；`setTerminalPromotionOwnership()` refuse overwrite unconsumed record；⑤ **repair marker**（`chatDb/index.ts`）——`markRepairRequiredBeforeInit()` durable repair-required marker write（file sync + parent dir sync），idempotent，refuses if service already initialized；⑥ **recovery executor**（`recoveryExecutor.ts`）——`createRecoveryExecutor()` 7 subphases（probing→deciding→authorizing→executing-action→cleanup-journal→relaunching→settled）；four actions（keep-old-live / accept-verified-replacement / restore-rollback-snapshot / repair-required）；authorization resolution（terminal ownership first，fresh lease fallback）；cooperative abort；injectable primitives；⑦ **relaunch**（`relaunch.ts`）——exact-once receipt-gated（WeakSet brand）`app.relaunch() + app.exit(0)`；⑧ **startup gate**（`gate.ts`）——`runStartupRecoveryGate()` absent-journal fast path（common case）+ valid journal → probe → decide → execute；⑨ **startup reorder**（`src/main/index.ts`）——startup order：BackupManager restore → **gate** → chatDbService.init() → orphan cleanup/window startup；repairRequired → skip init；relaunchPending → return early。Phase 4.4.2 非目标已全部落地。独立审计 pass（两项 accepted fixes：real durable repair marker、startup gate fail-closed）；聚焦测试 71 文件 / 1709 通过 / 72 跳过 / 0 失败；全量验证通过：`pnpm format` exit 0 无改动；`pnpm lint` exit 0（0 errors / 97 warnings）；`pnpm test` exit 0，281 文件 / 6205 通过 / 72 跳过；`pnpm typecheck:node` 通过；prior two ENOENT failures non-reproducible；未提交/未推送 |
| **2026-07-28** | **Phase 5.1B Done（已提交 `e44e413f30`，未推送）** | Phase 5.1B（主题生命周期 + 复合命令 + 搜索）已提交。commit `e44e413f30`（`feat(chat-db): complete phase 5.1b sqlite surfaces`），未推送 |
| **2026-07-28** | **Phase 5.2A Done（已提交 `e9de29ff97`，未推送）** | SearchResults 调用方迁移：`SearchResults.tsx` 从 Dexie 搜索切换到 `chatDb.searchMessages`（复用共享归一化函数）；新增 SearchResults 测试套件（620 行）；i18n 字段更新；`SqliteMessageDataSource` 适配。commit `e9de29ff97`（`feat(chat-db): migrate history search to sqlite`），未推送 |
| **2026-07-28** | **Phase 5.2B 实现 + 独立审计 + 全量验证完成（未提交/未推送）** | 在 Phase 5.1B 命令面之上落地主题生命周期调用方集成：① **新增模块**：`topicMetadataPersist.ts`（metadata 持久化层）、`topicTrashLifecycle.ts`（trash 生命周期流：soft/restore/hard/purge 编排）、`topicDeletionFlow.ts`（删除 UI 流）；② **调用方修改**：`useAssistant.ts`（assistant 空 trash 原子操作 + metadata 暴露时序）、`useTopic.ts`（trash 集成）、`Topics.tsx`（确定性分页 + 操作增强）、`TopicTrashPanel.tsx`（trash 面板增强）、`TopicManageMode.tsx`、`AssistantItem.tsx`、`AssistantService.ts`、`Chat.tsx`、`Inputbar.tsx`、`Messages.tsx`、`Tabs/index.tsx`；③ **aggregate/IPC 扩展**：`ChatDbAggregateService.ts`、`ipc.ts`、`preload/index.ts`、`SqliteMessageDataSource.ts`、`IpcChannel.ts`、`contracts.ts`/`types.ts`；④ **FileCleanupResult 消费**：调用方依据 `remainingReferenceCounts===0` 决定物理删除（LOCK-5108/5109）；⑤ **普通 topic 所有权保障**：暴露前完成 ownership 解析（LOCK-5107）；⑥ **Agent Dexie 边界**：agent session 操作保持 Dexie 路由隔离；⑦ **确定性分页**：Topics 列表分页稳定性。**已知延后范围（LOCK-DOC4）**：MoveTopic ownership transfer 延后；legacy ImportService ownership 延后；assistant-removal compound flows 属后续工作。**已知限制（LOCK-DOC5）**：agent session focused assertions 通过，runtime agent UI 不可用（无 Main handler/IPC/UI entry，非 ABI 问题）。**全量验证**：`pnpm test` 289 文件 / 6629 通过 / 72 跳过；focused/shared/Main/renderer checks 通过；`pnpm format` 无改动；`pnpm lint` exit 0 / 33 warnings / 0 errors；`pnpm typecheck` pass；`git diff --check` pass。CI 环境 `CI=true` 下 30 个 pre-existing no-console errors 为 baseline 行为（非 Phase 5.2B 回归）。未提交/未推送 |
| **2026-07-28** | **Phase 5.0 Done + 5.1A 已提交 + 5.1B 已提交 + 5.2A 已提交 + 5.2B 实现完成** | Phase 5 拆为 5.0（基线就绪与子阶段划分）、5.1A（SQLite 命令面补全，已提交 `6fa5ff5ef9`）、5.1B（主题生命周期 + 复合命令 + 搜索，已提交 `e44e413f30`）、5.2A（SearchResults 调用方迁移，已提交 `e9de29ff97`）、5.2B（主题生命周期调用方集成 + 复合操作增强，实现 + 独立审计 + 全量验证完成，未提交/未推送）、5.3（权威切换与 scaffolding 移除）、5.4（E2E/性能/清理门）。Phase 5 命令面总计 35 个 `ChatDb_*`（Phase 3.2 的 14 + 5.1A 的 9 + 5.1B 的 12）。本 session 确立并激活 LOCK-5101…5113（命令面 / 主题生命周期 / 复合事务所有权 / FileCleanupResult / purge cutoff 所有权）与 LOCK-5121…5129（migration 003 FTS 归一化投影 / 共享归一化单一事实源 / FTS 候选加速器非权威 / 块级游标 / 基准方法学）。Phase 4 全部 LOCK-44xx 与历史 ADR 继续有效 |
| **2026-07-28** | **Phase 5.1A Done（已提交 `6fa5ff5ef9`）** | 9 个命令经 `ChatDbAggregateService` + typed IPC + `window.api.chatDb` + `SqliteMessageDataSource` 全链路落地：`ListSegments` / `UpsertSegment` / `UpdateSegmentMetadata` / `DeleteSegment` / `ReplaceSegmentMembership` / `ReorderMessages` / `ListFileRefsByFile` / `CountFileRefsByFile` / `ListBlocksByFile`。segment 全量替换语义；file-ref 查询只读；reorder 仅 topic 内。已提交 `6fa5ff5ef9`（未推送） |
| **2026-07-28** | **Phase 5.1B Done（已提交 `e44e413f30`，未推送）** | 12 命令/表面：主题生命周期 6（`UpdateTopicMetadata` / `SoftDeleteTopic` / `RestoreTopic` / `ListTrashTopics` / `HardDeleteTopic` / `PurgeExpiredTopics`）+ 复合 5（`CloneMessagesToTopic` / `ResetMessagesForResend` / `DeleteMessagesWithSegments` / `PasteMessagesToTopic` / `ClearTopicWithSegments`）+ 搜索 1（`SearchMessages`）。`FileCleanupResult` 仅返回 `{affectedFileIds, remainingReferenceCounts}`，DB 事务内无文件系统副作用（LOCK-5108/5109）；复合命令单 root 事务 + 所有权强制（LOCK-5106/5107）；purge cutoff 由调用方提供（LOCK-5113）。migration 003（`003_fts5_normalized_search`）append-only 幂等：`message_blocks_normalized` + `message_blocks_fts`（trigram）+ 三触发器，`chatdb_normalize()` 在触发前注册（LOCK-5121/5126/5127）。`SearchRepository`：term≥3 码点走 FTS5、<3 走 LIKE、多 term 交集（LOCK-5124）；FTS 仅候选加速器、过共享精确 regex、错误传播非 catch-to-empty（LOCK-5101/5125）；块级 `(created_at, message_id, block_id)` 游标、不额外 deleted-topic 过滤（LOCK-5123/5128）。`SearchResults.tsx` 调用方仍为 Dexie（仅复用共享归一化函数），切到 `SearchMessages` 属 Phase 5.2A。10k 基准（确定性 10,000 MAIN_TEXT 块、3 warmup + 10 measured × 10 query、强制有序 parity）：LIKE p50 8.96 / p95 10.28 / mean 8.83ms；hybrid p50 2.90 / p95 6.51 / mean 3.40ms；加速 p50 3.09x / p95 1.58x（LOCK-5129）。聚焦验证：Main 1838 passed / 72 skipped / 0 failed；Phase 5.1B 聚焦套件与 typecheck 通过；全量 format/lint/test/typecheck 门通过。已提交 `e44e413f30`（未推送） |

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
| **2026-07-27** | Phase 4.3 | **Deterministic verification 完成（Done，已提交/已推送）**：实际模块 `CandidateVerifier` / `SourceVerificationManifest` / `VerificationReport`；只读 13 维度验证 + 有界安全诊断；manifest 按页事务后落盘 + stable canonical SHA-256（~5,019KiB）；会话状态机 candidate-ready→verifying→verified-candidate | verification-failed；取消/退出 close-before-discard；通过保留候选供 4.4、失败报告后清理；corruption matrix 覆盖全部维度；10k 验证证据（25 topics / 10,000 messages / 11,000 blocks / 26 segments / 250 memberships / 667 file refs / 19 pages；~250–290ms）；聚焦测试 271 通过；`pnpm format` exit 0 无改动；`pnpm lint` exit 0（0 errors，109 warnings）；`typecheck:node` 通过；首次 `pnpm test` 5420 通过 / 2 失败（BackupManager 共享临时目录非确定性 flakes，排查否定 Phase 4.3 干扰）/ 72 跳过；复跑 `pnpm test` 258 文件 / 5422 通过 / 72 跳过 / 0 失败；Main 与全量多次复跑干净；最终审计 0 findings（本地全量验证，未涉及 CI） |
| **2026-07-27** | Phase 4.4.0 | **Promotion 协议基础完成（Done，纯协议层）**：`chatDbImport/promotion/{protocol,journal,recovery}` + `chatDb/maintenanceCoordination` + `chatDbImport/index` 状态扩展（`promoting/promoted/promotion-failed`）+ `claimPromotion()`/`completePromotion()` exact-once + cancel/dispose/will-quit 边界 + startupRecovery 纯契约 re-export；journal v1 严格 codec（无路径）；恢复矩阵 90 组合穷举、12 崩溃点覆盖（LOCK-4406）；五操作互斥 lease 契约（LOCK-4402，未接线）；无任何 live/candidate/snapshot 文件操作或 promotion IPC（LOCK-4405）；聚焦 chatDb+chatDbImport 29 文件 / 895 通过（基线 822 + 新增 73）；`typecheck:node` 通过 |
| **2026-07-27** | Phase 4.4.1 | **Durable Preparation Gate 完成（Done，未提交/未推送）**：在 4.4.0 协议层之上落地 LOCK-4411…4417。统一维护接线（`maintenanceCoordination.ts` promotion 接入既有 backup/restore/init/close 互斥、唯一 lease 持有者、无第三锁）；rollback 快照创建（`chat.db.pre-import-backup`：live→staging→验证→原子 rename，不复制 WAL/SHM，仅发布不 restore）；严格持久化 journal store（`promotion/journal.ts` 新增 crash-safe 原子 rename 落盘 writer，journal `snapshot-ready` 已落盘）；启动候选保护（`startupRecovery.ts` 扩展为读 journal、保护 journal-referenced candidate 排除年龄清理、按 4.4.0 恢复矩阵安全分类中断资产）；exact-once prepared handle（`claimPromotion()` 不可复用 token 准备窗口唯一可消费、promotion-owned dispose/will-quit 保留候选）；非破坏性边界（不关闭/替换/重命名 live `chat.db`、失败回退 keep-old-live/repair-required、全写为 staging+原子 rename）；最大边界止于 snapshot-ready。审计：首轮独立审计发现 candidateId 与 session 集成两阻塞，均已修复，复审 0 findings。验证：`pnpm format` 通过（无改动）；`pnpm lint` exit 0（82 oxlint + 33 eslint known warnings，115 emitted warning instances，0 errors）；`pnpm typecheck:node` 通过；`pnpm test` exit 0，272 文件 / 5860 通过 / 72 跳过 / 0 失败；本地全量验证，未涉及 CI / 未提交 / 未推送 |
| **2026-07-27** | Phase 4.4.2 | **Destructive Promotion Executor 完成（Done，实现 + 聚焦验证 + 独立审计 pass-with-findings、两项接受的 ownership/isolation 硬化修正已落地复验（成功 handoff 独占 capability 转移；post-install recovery-required 保留 lease 阻断 ordinary maintenance 至 Phase 4.4.3 或进程退出）；未提交/未推送）**：exact-once prepared→executing capability 转移（`preparation.ts` consume，LOCK-4421）；owner-aware live 生命周期（`chatDb/index.ts` closeForPromotion/reopenForPromotion + `maintenanceCoordination.ts` validatePromotionAuthorization，同一持续持有 lease 授权全窗口，LOCK-4422）；原子 rename-only install + sidecar 处理 + fsync + identity receipt + closed-live proof（`install.ts`，EXDEV 无 copy fallback，LOCK-4423/4426/4427）；严格 journal 递进 transition API（`journalStore.ts`，snapshot-ready→candidate-installed→replacement-verified，LOCK-4423/4424/4425）；identity-bound replacement 验证（`replacementVerifier.ts` + `readonlyDbValidation.ts` 共享只读门，LOCK-4424）；执行编排 8 subphase + pre/post-install 失败分类 + 协作式 abort + `startPromotionExecution()` 唯一入口（`execution.ts` + `chatDbImport/index.ts`，LOCK-4425/4428）；执行止于 durable `replacement-verified` handoff——无 restore/relaunch/清理；审计硬化后终局 ownership 结算唯一归属 `startPromotionExecution` continuation（成功/post-install → `TerminalPromotionOwnership` 终局记录持有 capability，stale session 清理不可释放；pre-install → quiesce 后释放）。验证：聚焦受影响区域（chatDb + chatDbImport）35 文件 / 1141 测试通过 / 0 失败（修正前基线 1138，保留为聚焦验证证据）；`typecheck:node` 通过；changed-files biome/eslint 干净；**最终全量验证通过（未涉及 CI / 未提交 / 未推送）**：`pnpm format` 通过（无文件改动）；`pnpm lint` 通过（0 errors / 87 warnings）；`pnpm test` 通过，275 文件 / 5983 通过 / 72 跳过；`pnpm typecheck:node` 通过；独立审计与复验均 pass。Phase 4.4.3（rollback restore 执行/relaunch/启动恢复动作执行）Not started |
| **2026-07-27** | Phase 4.4.2 已提交 | Phase 4.4.0+4.4.1+4.4.2 一并提交至 `3a81557ac6`（`feat(chat-db): execute durable candidate promotion`），未推送 |
| **2026-07-28** | Phase 4.4.3 | **Recovery/Finalization 完成（Done，实现 + 独立审计 pass + 全量验证通过，未提交/未推送）**：LOCK-4431…4439 全落地。5 个新文件 + 5 个修改文件 + 4 个测试文件扩展。① artifact probes（`artifactProbe.ts`）：只读磁盘 truth 等价探测，路径 strict derive + candidateId allowlist，sidecar-free invariant + before/after dir snapshots；② rollback（`rollback.ts`）：staging clone（`fs.copyFileSync`）+ fsync + readonly validation + consume proof + atomic rename → fsync + identity confirm + restored live validation；retained snapshot never consumed（LOCK-4434）；③ journal cleanup（`journalStore.ts` 扩展）：idempotent fixed-path cleanup + phase-gated API + guard-read + unlink + best-effort staging + fsync parent dir（LOCK-4438）；④ terminal ownership take（`chatDbImport/index.ts`）：`takeTerminalPromotionOwnership()` atomic take-and-clear（LOCK-4433）；⑤ repair marker（`chatDb/index.ts`）：`markRepairRequiredBeforeInit()` durable write，idempotent，refuse when initialized（LOCK-4437）；⑥ recovery executor（`recoveryExecutor.ts`）：7 subphases + four actions + authorization resolution + cooperative abort；⑦ relaunch（`relaunch.ts`）：exact-once receipt-gated `app.relaunch()+exit(0)`（LOCK-4438）；⑧ startup gate（`gate.ts`）：absent-journal fast path + valid journal → probe → decide → execute；⑨ startup reorder（`src/main/index.ts`）：BackupManager restore → gate → chatDbService.init() → orphan cleanup/window。独立审计 pass（两项 accepted fixes：real durable repair marker、startup gate fail-closed）；聚焦测试 71 文件 / 1709 通过 / 72 跳过；全量验证通过：format 无改动；lint 0 errors/97 warnings；test 281/6205/72 skipped；typecheck:node pass；prior two ENOENT failures non-reproducible |
| **2026-07-28** | Phase 5.0 | **基线就绪与子阶段划分完成（Done）**：在合并后基线上确立 Phase 5 拆为 5.0/5.1A/5.1B/5.2A/5.2B/5.3/5.4；命令面清单（14 + 9 + 12 = 35）；LOCK-5101…5113 / LOCK-5121…5129 持久化框架。不新增代码 |
| **2026-07-28** | Phase 5.1A | **SQLite 命令面补全完成（Done，已提交 `6fa5ff5ef9`，未推送）**：9 命令（segments / file-ref / reorder）经 aggregate + IPC + preload + renderer datasource 全链路；segment 全量替换、file-ref 只读、reorder 仅 topic 内；类型检查与聚焦测试通过 |
| **2026-07-28** | Phase 5.1B | **Done（已提交 `e44e413f30`，未推送）**：主题生命周期 + 复合命令 + 搜索实现完成。12 命令/表面；`FileCleanupResult` 无文件系统副作用（LOCK-5108/5109）；复合单 root 事务 + 所有权强制（LOCK-5106/5107）；purge cutoff 调用方提供（LOCK-5113）；migration 003 FTS 归一化投影 append-only 幂等（LOCK-5121/5126/5127）；搜索 FTS 候选加速器 + 精确 regex + 错误传播（LOCK-5101/5123/5124/5125/5128）；块级游标；SearchResults 调用方仍 Dexie（Phase 5.2A 边界）。10k 基准：LIKE p50 8.96/p95 10.28/mean 8.83ms；hybrid p50 2.90/p95 6.51/mean 3.40ms；加速 p50 3.09x/p95 1.58x（LOCK-5129）。聚焦验证通过；全量 format/lint/test/typecheck 通过 |
| **2026-07-28** | Phase 5.2A | **Done（已提交 `e9de29ff97`，未推送）**：SearchResults 调用方迁移（Dexie → SQLite 搜索）。`SearchResults.tsx` 切到 `chatDb.searchMessages`；新增测试套件（620 行）；i18n 字段更新；`SqliteMessageDataSource` 适配 |
| **2026-07-28** | Phase 5.2B | **实现 + 独立审计 + 全量验证完成（未提交/未推送）**：主题生命周期调用方集成（`topicMetadataPersist.ts` / `topicTrashLifecycle.ts` / `topicDeletionFlow.ts`）+ 助手空 trash 原子操作 + FileCleanupResult 消费 + 普通 topic 所有权保障 + agent Dexie 边界 + 确定性分页。已知延后（LOCK-DOC4）：MoveTopic ownership / legacy ImportService / assistant-removal。已知限制（LOCK-DOC5）：agent session focused assertions 通过，runtime agent UI 不可用（无 Main handler/IPC/UI entry）。全量验证：289 文件 / 6629 通过 / 72 跳过；focused/shared/Main/renderer checks 通过；`pnpm format` 无改动；`pnpm lint` exit 0 / 33 warnings / 0 errors；`pnpm typecheck` pass；`git diff --check` pass。CI 环境 `CI=true` 下 30 个 pre-existing no-console errors 为 baseline 行为（非 Phase 5.2B 回归）。未提交/未推送 |
| **2026-07-29** | Phase 5.3 | **Done（已提交 `b81a35c054`，未推送）**：DbService 默认路由直连 SQLite；routingPolicy scaffolding 移除（C-13：`routingPolicy.ts` 删除、构造注入策略 / 懒加载切换 / 永久 Dexie 单例 / `sqlite-authoritative` 拒绝路径全部移除）；DexieMessageDataSource 从普通聊天路径移除（C-11）；agent session 操作保持 `AgentMessageDataSource` stub 路由（策略无关最高优先级）；import renderer 内部仍使用 Dexie（Phase 4 隔离 import 架构不变）。原子 ownership / reset / resend / destructive cleanup 语义在直连 SQLite 路径上完整保留（LOCK-5106…5109）。**全量验证**：`pnpm format` exit 0 无改动；`pnpm lint` exit 0（97 oxlint + 34 ESLint warnings / 0 errors）；`pnpm test` 295 文件 / 6577 通过 / 72 跳过 / 0 失败；`pnpm typecheck` pass；`git diff --check` pass。独立审计 pass（0 blockers）。未提交/未推送 |
| **2026-07-28** | Phase 5.3 / 5.4 | ~~Not started~~ → Phase 5.3 Done（2026-07-29）；5.4 仍 Not started |
| **2026-07-30** | **Phase 5.4** | **Done（实现 + E2E + 性能基准 + A-10 spike harness 清理 + 文档收尾；未提交/未推送）**。Electron ABI 145 重建成功，E2E 运行时通过。E2E 验证矩阵：4 个 spec 通过（ordinary-chat real send/edit/resend/regenerate/copy + exact request/SQL；topic-trash soft-delete/restore/hard-delete/empty-trash + name/title + cross-assistant isolation；multi-model append + real dnd reorder persisted；topic-move real delete + undo/redo persisted）。Agent session 185 focused assertions 通过，runtime agent UI 不可用（无 Main handler/IPC/UI entry，非 ABI 问题）。性能基准：消息加载 p50 7.42ms / p95 8.23ms；repository two-transaction write microbenchmark 38.5 batch ops/s / 385.2 msgs/s（microbenchmark 非聚合生产吞吐）；cold open p95 6.91ms < 500ms。历史 Dexie comparator 不可用，仅报告绝对 SQLite 结果。Phase 4 spike gate 已通过（A pass、C1 4/4、C2a 8/8、C2b 10/10）后 22 个 spike-only 文件 + build gate 移除（A-10 fulfilled/deleted）。零 ordinary runtime Dexie chat-table references 确认（有效例外 agent/import/backup）。Topic name persistence + durable file lifecycle correctness fixes 在 E2E 过程中发现并实现/审计。文档收尾：更新本迁移文档反映 Phase 5.4 最终态。LOCK-DOC6/LOCK-DOC7 新增（性能方法学/历史 Dexie comparator 不可用）。**最终仓库验证（Node v24.12.0 ABI 137 / pnpm 10.27.0）**：`pnpm format` PASS 无改动；`env -u CI pnpm lint` PASS 0 errors / 17 pre-existing warnings；typecheck+i18n+format recheck PASS；`pnpm test` PASS **304 文件 / 6598 通过 / 72 跳过 / 0 失败**；`pnpm typecheck` PASS node/web/aicore；`git diff --check` PASS；无 generated JS / temp / process artifacts。better-sqlite3 final local binary 为 ABI 137（host Node），Electron ABI 145 E2E 证据已在 earlier targeted rebuild 中记录。未提交/未推送 |

---

## 16. 代码证据索引

### 当前活跃资产

| 路径 | 说明 |
|---|---|
| `src/renderer/src/databases/index.ts` | Dexie `CherryStudio` 数据库定义，所有表结构 |
| `src/renderer/src/databases/upgrades.ts` | Dexie schema 升级函数 |
| `src/renderer/src/services/db/DbService.ts` | DbService facade，Phase 5.3 后直连 SQLite（无路由策略注入、无 Dexie 路由） |
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
| Startup recovery | `src/main/services/chatDbImport/startupRecovery`（Phase 4.2 已创建；Phase 4.4.1 扩展；Phase 4.4.3 re-export gate API） | 取消/错误/孤儿候选目录确定性清理；Phase 4.4.1 扩展为读取 promotion journal、保护 journal-referenced 候选（排除年龄清理）、按 4.4.0 恢复矩阵安全分类中断 promotion 资产（LOCK-4414）；Phase 4.4.3 re-export `runStartupRecoveryGate` + `StartupRecoveryGateResult` |
| Verification | `src/main/services/chatDb/import/`（CandidateVerifier / SourceVerificationManifest / VerificationReport，Phase 4.3 已创建） | 只读 13 维度验证；manifest 按页事务后落盘 + stable canonical SHA-256；有界安全诊断；会话状态机 candidate-ready→verifying→verified-candidate\|verification-failed；close-before-discard |
| Promotion protocol foundations | `src/main/services/chatDbImport/promotion/`（protocol/journal/recovery，Phase 4.4.0 已创建；Phase 4.4.1 新增 journalStore 落盘；Phase 4.4.2 加严 transition；Phase 4.4.3 新增 artifactProbe/gate/recoveryExecutor/rollback/relaunch + cleanup APIs） | 纯协议层：promotion 状态/exact-once claim、journal v1 严格 codec、确定性恢复矩阵；Phase 4.4.1 新增独立 `journalStore.ts` crash-safe 落盘 writer；Phase 4.4.2 受门控 phase transition API；Phase 4.4.3 新增 5 个模块（artifactProbe/gate/recoveryExecutor/rollback/relaunch）+ journal cleanup APIs + `validateClosedLiveProof` extracted from install.ts |
| Maintenance coordination contract | `src/main/services/chatDb/maintenanceCoordination.ts`（Phase 4.4.0 已创建；Phase 4.4.1 接线；Phase 4.4.2 扩展验证缝） | backup/restore/promotion/init/close 统一互斥 lease 契约（LOCK-4402）；Phase 4.4.1 将 promotion 实际接入既有互斥协调；Phase 4.4.2 新增 `validatePromotionAuthorization` 验证缝 + `ChatDbService.closeForPromotion/reopenForPromotion`；Phase 4.4.3 recovery executor 通过此 API 获取 fresh promotion lease（restart path） |
| Atomic promotion executor | `src/main/services/chatDbImport/promotion/`（Phase 4.4.1 交付 Durable Preparation Gate；Phase 4.4.2 交付破坏性执行；Phase 4.4.3 交付恢复/终结管线） | Phase 4.4.1：rollback 快照创建 + journal `snapshot-ready` + exact-once prepared handle + 非破坏性边界。Phase 4.4.2：execution/install/replacementVerifier/readonlyDbValidation，止于 durable `replacement-verified` handoff。**Phase 4.4.3**：`recoveryExecutor.ts`（7 subphases 编排 four actions + authorization resolution + abort）、`rollback.ts`（staging clone + atomic rename restore）、`relaunch.ts`（exact-once receipt-gated）、`gate.ts`（startup recovery gate，absent-journal fast path）、`artifactProbe.ts`（只读磁盘 truth 等价探测）、`journalStore.ts` cleanup APIs（phase-gated idempotent removal）。四动作全部落地：keep-old-live / accept-verified-replacement / restore-rollback-snapshot / repair-required |

### 已废弃/待移除路径

| 路径 | 状态 | 说明 |
|---|---|---|
| `src/renderer/src/services/db/routingPolicy.ts` | **Phase 5.3 已移除（C-13）** | 临时验证用路由策略注入，Phase 5.3 权威切换时删除 |
| `src/renderer/src/services/db/DexieMessageDataSource.ts` | **Phase 5.3 从普通路径移除（C-11）** | 仅保留于隔离 import renderer 内部 |
