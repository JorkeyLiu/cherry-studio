# Cherry Studio SQLite 迁移文档

> **文档状态**：In progress（Phase 0 清理完成，Phase 1 骨架完成，Repository 实现待进行）  
> **分支**：`jorkey/refactor/sqlite-migration`  
> **最后更新**：2026-07-19  
> **Owner**：Personal fork（jorkeyliu）

---

## 1. 背景与目标

Cherry Studio 当前核心聊天数据存储在 Renderer 进程的 Dexie（IndexedDB `CherryStudio`）中。

Dexie/IndexedDB **支持事务且启用 strict durability**，具备 ACID 基础能力。当前方案的结构性缺口为：

- 无 SQLite 式 integrity check（PRAGMA integrity_check）
- 无 WAL checkpoint 机制（IndexedDB 自管理，不可控）
- 无关系外键约束（仅逻辑引用，无数据库层约束）
- Main 进程无法直接读写聊天数据，IPC 成为唯一通道，无法利用 SQLite 工具链

历史曾存在 agents SQLite 子系统但已删除，留下残留配置和依赖。备份/恢复直接复制 `Data/` 目录，无数据库一致性保障。

**目标**：将核心聊天数据迁移至 Main 进程的 SQLite（`Data/chat.db`），建立连接生命周期管理、schema migration 框架、完整性校验和备份协调基础设施，同时保持迁移期回滚能力。

---

## 2. 范围与非目标

### 首期范围

- `topics`、`messages`、`message_blocks`、`topic_segments` 及必要的 file references
- 新建独立 `Data/chat.db`（A-1 Accepted），Main 进程单写
- 连接生命周期、migration 框架、integrity 校验、backup coordination
- Renderer→Main 的 command-oriented typed IPC 收口
- Dexie 导入 + shadow verification（双读校验）
- 切换后 Dexie 保留回滚数据，不立即删除

### 非目标（首期不涉及）

- Redux 配置数据迁移（settings、shortcuts、llm 等）
- Memory `memories.db` 迁移
- Knowledge `KnowledgeBase/*` 迁移
- 上游 V2 Data&UI Refactoring 依赖
- FTS/全文搜索（首期不实现，schema 预留位置）
- 文件内容 blob 存储（仅迁移元数据和引用）

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

### Group D：切换稳定后处理（依赖 Phase 5 切换完成并观察稳定）

| # | 项目 | 条件 |
|---|---|---|
| C-9 | Dexie `topics`/`message_blocks`/`topic_segments` 表 | 切换完成 + 观察期稳定 + 回滚演练确认后，最终废弃 |
| C-10 | Renderer 直接 Dexie 访问（数十处） | 逐步收口至 DbService→IPC，非一次性清理 |
| C-11 | `DexieMessageDataSource` 实现 | 切换完成后保留回滚能力，最终移除 |

### Group E：用户数据处理（须用户确认）

| # | 项目 | 条件 |
|---|---|---|
| C-12 | 遗留 `agents.db` 用户文件 | **默认保留或提示归档；只有用户明确确认后才可删除，禁止静默自动删除** |

---

## 6. 关键架构决策（ADR 短表）

| # | 决策 | 状态 | 说明 |
|---|---|---|---|
| A-1 | 新建独立 `Data/chat.db`，不复用 `agents.db` | **Accepted** | agents.db 无代码 owner，schema 不兼容，用户文件需保留 |
| A-2 | Main 进程单写，Renderer 通过 IPC 读写 | **Proposed** | 避免多进程并发写；Renderer 不直接持有 SQLite 连接 |
| A-3 | 关系化 schema（非 JSON blob 堆砌） | **Proposed** | topics/messages/blocks 显式关系；JSON 仅用于低查询扩展字段 |
| A-4 | Command-oriented typed IPC | **Proposed** | Renderer 不暴露 SQL 能力；Main 暴露 typed command handlers |
| A-5 | 迁移期一次性切换 + Dexie 快照回滚 | **Accepted** | 个人 repo，无 SLA 约束；导出 Dexie→SQLite 后切换路由，旧 Dexie 文件作为回滚快照；切换后观察数天确认稳定；不采用双写。风险：切换后新增数据回滚时丢失，个人使用可接受 |
| A-6 | 备份策略：checkpoint + online backup | **Proposed** | 当前直接复制 Data 目录无一致性保障；需 WAL checkpoint 或备份锁 |
| A-7 | 技术栈：better-sqlite3 + Drizzle ORM + drizzle-kit | **Accepted** | better-sqlite3 是 Node.js 生态最成熟 SQLite 驱动，同步 API，Drizzle 官方主推组合；与未来 PowerSync 集成兼容（PowerSync 首选 better-sqlite3）。@libsql/client 保留给 Memory/Knowledge 继续使用，不在本阶段统一 |

> **Phase 1 前置**：A-7（技术栈）和 A-5（authoritative 切换方式）两个 ADR 已关闭（Accepted），Phase 1 可启动。

---

## 7. 目标架构简图

```
┌─────────────────────────────────────────────────────┐
│                   Renderer Process                   │
│                                                     │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │  Redux    │  │ Dexie    │  │  Hooks/Components │  │
│  │  Store    │  │ (保留)   │  │  (读写聊天数据)    │  │
│  └────┬─────┘  └────┬─────┘  └───────┬───────────┘  │
│       │              │                │              │
│       │         ┌────▼─────┐          │              │
│       │         │ DbService │◄─────────┘              │
│       │         └────┬─────┘                         │
└───────┼──────────────┼───────────────────────────────┘
        │              │ typed IPC (command)
        │              │
┌───────┼──────────────┼───────────────────────────────┐
│       │              │         Main Process           │
│       │         ┌────▼──────────────┐                 │
│       │         │  ChatDbService    │                 │
│       │         │  (connection mgr) │                 │
│       │         └────┬──────────────┘                 │
│       │              │                               │
│       │         ┌────▼──────┐   ┌───────────────┐    │
│       │         │ chat.db   │   │ Migration     │    │
│       │         │ (SQLite)  │   │ Framework     │    │
│       │         └────┬──────┘   └───────────────┘    │
│       │              │                               │
│       │         ┌────▼──────────────┐                 │
│       │         │ Backup Coord.     │                 │
│       │         │ (checkpoint/lock) │                 │
│       │         └───────────────────┘                 │
│       │                                               │
│  ┌────▼────────────┐  ┌────────────────┐              │
│  │ MemoryService   │  │ KnowledgeSvc   │  (独立)     │
│  │ memories.db     │  │ KnowledgeBase/ │              │
│  └─────────────────┘  └────────────────┘              │
└───────────────────────────────────────────────────────┘
```

---

## 8. 初步目标 Schema（Draft v0 / Proposed）

> 以下为表关系和关键字段规划，表达关系和约束意图，**不锁定 DDL**。待技术栈 ADR 决定后生成最终 DDL。

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
| **状态** | **In progress**（骨架完成：better-sqlite3 + Drizzle ORM 安装；ChatDbService、schema、migration runner、repository 目录已创建；TypeScript 编译通过） |
| **前置** | ~~A-7（技术栈）和 A-5（authoritative 切换方式）ADR 必须先关闭~~ **Done**（A-7 Accepted, A-5 Accepted） |
| **目标** | 建立 SQLite 连接管理、migration 框架、integrity 校验 |
| **主要任务** | 实现 `ChatDbService`（连接池/will-quit 关闭）；schema + migration 生成；WAL 模式；integrity PRAGMA；backup coordination 接口（含互斥锁、WAL checkpoint、恢复后 integrity check） |
| **退出条件** | `chat.db` 可创建/打开/关闭；migration 可执行；integrity 校验通过；will-quit 正确关闭；恢复备份后首次打开自动执行 `PRAGMA integrity_check` |

### Phase 2：Schema 与 Repository

| 属性 | 值 |
|---|---|
| **状态** | Not started |
| **目标** | 实现类型安全的 Repository 层 |
| **主要任务** | TopicsRepository、MessagesRepository、BlocksRepository、FileReferencesRepository；批量操作优化；分页查询 |
| **退出条件** | 所有 Repository 单元测试通过；CRUD + 批量操作覆盖 |

### Phase 3：IPC 与 Renderer 收口

| 属性 | 值 |
|---|---|
| **状态** | Not started |
| **目标** | 建立 Renderer→Main 的 command-oriented typed IPC |
| **主要任务** | 定义 IPC channel + command types（`packages/shared/IpcChannel.ts`）；Main 侧 handler；Renderer 侧 `SqliteMessageDataSource`；收口 DbService 路由 |
| **退出条件** | IPC 调用链路端到端可用；DbService 可切换到 SQLite 数据源 |

### Phase 4：Dexie 导入与 Shadow Verification

| 属性 | 值 |
|---|---|
| **状态** | Not started |
| **目标** | 将 Dexie 数据导入 SQLite，双读校验 |
| **主要任务** | 分页导出 Dexie 数据；幂等导入；数量/ID/顺序/引用/哈希校验；shadow mode（双读比对结果） |
| **退出条件** | 全量数据校验通过；shadow mode 无差异；导入耗时和数据量有记录 |

### Phase 5：切换（受控）

| 属性 | 值 |
|---|---|
| **状态** | **Not started** |
| **目标** | SQLite 成为 authoritative store |
| **切换策略** | 一次性切换 + Dexie 快照回滚（A-5 Accepted）：导出 Dexie 数据到 SQLite 后切换路由，保留旧 Dexie 数据库文件作为回滚快照；切换后观察数天确认稳定；不采用双写机制。风险：切换后新增数据在回滚时丢失，个人使用可接受 |
| **主要任务** | DbService 默认路由切换到 SQLite；Dexie 降级为只读回滚；用户通知；性能基准测试（切换前必须完成） |
| **退出条件** | 主流程功能正常；性能不低于 Dexie 基线；**切换后新增/修改数据回滚演练成功** |

### Phase 6：收尾

| 属性 | 值 |
|---|---|
| **状态** | Not started |
| **目标** | 清理遗留，稳定长期状态 |
| **主要任务** | 清理 Group D + Group E；更新文档；移除 Dexie 回滚代码；确认备份协调完整 |
| **退出条件** | 无 Dexie 残留引用；文档更新；CI 绿色 |

---

## 10. 数据迁移与回滚原则

### 迁移原则

1. **分页导出**：Dexie 数据分页读取（避免内存爆炸），批量写入 SQLite
2. **事务包裹**：每批导入必须在同一 SQLite 事务中完成；事务失败时整批回滚，不产生部分写入
3. **源数据安全**：导入过程中只读取 Dexie，不修改、不删除 Dexie 数据；导入中断后 Dexie 必须保持完整
4. **幂等导入**：导入操作可重复执行，使用 `INSERT OR REPLACE` 或先删后插；中断后续传不得产生重复记录
5. **校验维度**：
   - 数量校验：每个表的记录数一致
   - ID 校验：所有主键匹配
   - 顺序校验：消息 `sort_order` 与 Dexie 插入顺序一致
   - 引用校验：外键引用完整性
   - 哈希校验：关键字段内容哈希比对
6. **单一 authoritative store**：切换后 SQLite 为唯一真实来源，不再双写
7. **避免无事务长期双写**：双读校验期不超过必要的验证周期

### 回滚原则

1. **Dexie 保留**：切换后至少保留一个稳定版本的 Dexie 数据和读取代码
2. **回滚触发条件**：SQLite 数据损坏、性能严重退化、关键功能回归
3. **回滚操作**：DbService 路由切回 Dexie；SQLite 文件保留用于排查
4. **回滚前提**：切换前必须完成回滚演练，验证以下场景：
   - **导入失败**：导入中断后 Dexie 数据未被破坏
   - **部分导入**：导入中途失败，部分数据在 SQLite，部分在 Dexie，回滚后 Dexie 完整
   - **切换后回滚**：切换后用户产生新数据，回滚到 Dexie 后新数据不丢失（需反向导入或双写期间保留）
   - **应用降级**：旧版本应用打开后可正常读取 Dexie 数据

---

## 11. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 流式 IPC 性能 | 大消息量下 IPC 序列化/反序列化开销 | 批次阈值需基准测试确定；考虑 shared memory 或 streaming |
| 备份一致性 | 备份期间数据写入导致不一致 | WAL checkpoint + 备份锁；或 online backup API |
| 备份并发 | 多来源同时触发备份导致临时目录冲突或文件撕裂 | 备份操作全局互斥；同一时间只允许一个备份任务执行 |
| 文件系统非事务 | SQLite 文件操作非原子 | 使用 WAL 模式；备份使用临时文件+rename |
| 多窗口并发 | 多个 Renderer 窗口同时写入 | Main 单写；Renderer 通过 IPC 串行化 |
| 旧备份兼容 | 迁移后备份包含 Dexie 数据 | 备份格式版本化；恢复时检测版本并选择路径 |
| 性能未知 | SQLite 在 Electron 中的实际表现未测试 | Phase 5 切换前必须完成基准测试 |
| 技术栈选型 | ~~libSQL+Drizzle 可能不是最优选择~~ | **Resolved**（A-7 Accepted：better-sqlite3 + Drizzle） |

---

## 12. 验收指标 / Go-No-Go

> 以下指标在 Phase 5 切换前必须确定基准值，切换后对比验证。

| 指标 | 基准 | 目标 | 状态 |
|---|---|---|---|
| 消息加载延迟（p50/p95） | 待测 | 不退化 | Not started |
| 消息写入吞吐 | 待测 | 不退化 | Not started |
| 数据完整性 | 100% | 100% | Not started |
| 冷启动 DB 打开时间 | 待测 | < 500ms | Not started |
| 迁移全量数据耗时 | 待测 | < 60s（10k 消息） | Not started |
| 回滚验证 | — | Dexie 回滚可用 | Not started |

**Go 条件**：
- 所有指标达标 + 功能回归通过 + 回滚验证通过
- **切换后新增/修改数据回滚演练成功**
- **RPO 明确且经用户接受**（定义可接受的数据丢失窗口）
- 分别覆盖：导入失败、部分导入、切换后回滚、应用降级
- **备份恢复演练通过**：在持续写入期间触发备份 → 恢复备份 → 执行 `PRAGMA integrity_check` + 数据抽样比对 → 数据库可用且完整
- **恢复后自动 integrity check**：应用恢复备份后首次打开 chat.db 时，必须执行 `PRAGMA integrity_check`；检查失败则标记数据库为需修复状态

**No-Go 条件**：任一关键指标退化 >20% 或数据完整性 <100%

---

## 13. Open Questions

| # | 问题 | 影响范围 | 状态 |
|---|---|---|---|
| Q-1 | libSQL + Drizzle vs better-sqlite3 / 其他方案？ | A-7 技术栈决策 | **Resolved**：选择 better-sqlite3 + Drizzle ORM（A-7 Accepted） |
| Q-2 | chat.db 是否未来统一为 app.db（合并 Memory/Knowledge）？ | 架构长期演进 | Open |
| Q-3 | 文件元数据首期迁移深度：仅 references 还是包含 files 表全量？ | Phase 2 范围 | Open |
| Q-4 | 流式批次阈值：多大消息量触发分批 IPC？ | Phase 3 IPC 设计 | Open |
| Q-5 | 搜索/FTS 首期是否实现？schema 预留还是 Phase 6 再加？ | Phase 2 schema | Open |
| Q-6 | 遗留 agents.db 用户文件处理：归档提示还是自动清理？ | Group E 清理 | Open |
| Q-7 | 备份协调的具体实现：WAL checkpoint 还是 backup API？ | A-6 备份策略 | Open |

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

---

## 15. 进度日志

| 日期 | 阶段 | 进展 |
|---|---|---|
| 2026-07-19 | Phase 0 | 资产调查完成（Done） |
| 2026-07-19 | Phase 0 | Group A 清理完成（Done）：C-1 agents scripts 已删除，C-6 README 标记废弃，C-8 CLAUDE.md 已清理 |
| 2026-07-19 | Phase 1 | 骨架完成（In progress）：better-sqlite3 + Drizzle ORM 安装；ChatDbService、schema、migration runner、repository 目录已创建；TypeScript 编译通过 |
| 2026-07-19 | 决策 | A-7 Accepted（better-sqlite3 + Drizzle ORM，PowerSync 兼容）；A-5 Accepted（一次性切换 + Dexie 快照回滚） |
| 2026-07-19 | Phase 2 | Not started |
| 2026-07-19 | Phase 3 | Not started |
| 2026-07-19 | Phase 4 | Not started |
| 2026-07-19 | Phase 5 | Not started（切换策略已决策：一次性切换 + Dexie 快照回滚） |
| 2026-07-19 | Phase 6 | Not started |

---

## 16. 代码证据索引

### 当前活跃资产

| 路径 | 说明 |
|---|---|
| `src/renderer/src/databases/index.ts` | Dexie `CherryStudio` 数据库定义，所有表结构 |
| `src/renderer/src/databases/upgrades.ts` | Dexie schema 升级函数 |
| `src/renderer/src/services/db/DbService.ts` | DbService facade，路由 Dexie/Agent 数据源 |
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

### 历史路径（已不存在）

| 路径 | 说明 |
|---|---|
| `src/main/services/agents/` | 已删除的 agents SQLite 子系统目录 |
| `src/main/services/agents/drizzle.config.ts` | agents drizzle 配置（scripts 引用但不存在） |
| `Data/agents.db` | 用户设备上可能遗留的 agents 数据库文件 |
