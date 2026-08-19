# PowerSync 一次性 Spike 计划（Disposable PowerSync Spike）— Cherry Chat 多客户端同步可行性验证

> **文档状态**：**Spike Plan / Draft（一次性实验计划）**。本文件定义对 PowerSync 的一次性、可丢弃的可行性验证（spike）：**隔离契约、最小本地架构、依赖策略、测试分层、Go/No-Go 判据、证据分级、清理与处置规则**。spike **不安装生产依赖、不导入生产数据、不触网跑自动化测试、不把任何实验代码带入生产**。
> **决策锁（durable IDs）**：SPIKE-001 … SPIKE-010（§10 决策表）。
> **关联**：范围边界（零生产改动、设备本地权威、排除数据面、流式非同步事件）由 [sync MVP 提案](./sync-mvp.md) 的 SYNC-001…004 锁定，本计划直接承接。PowerSync **尚未选型**——本 spike 仅产出 Go/No-Go 证据，不构成 vendor 承诺。
> **最后更新**：2026-08-16
> **Owner**：Personal fork（jorkeyliu）
> **关联分支**：一次性实验分支（详见 §9 处置规则），不得合并进生产分支。

---

## 1. 目的与前置（Purpose and Prerequisites）

- **目的**：在最小、隔离、可丢弃的前提下回答 PowerSync 对该项目**是否值得进入正式选型评估**。问题聚焦在既有研究识别出的**schema 与写连接风险**上：PowerSync 对当前 `chat.db` schema（拓扑、FTS、触发器、写路径）的适配性，以及它在 Electron Main 进程单写模型下的行为。
- **前置（必须全部成立）**：
  - [sync MVP 提案](./sync-mvp.md) 的 SYNC-001…004 已批准（本文档为承接其范围边界的执行计划）。
  - 本 spike 在**一次性实验分支**上执行；生产分支、生产构建、打包流程**零改动**。
  - 拥有一个**一次性、可丢弃**的临时 profile 与临时 DB 环境（§6），与任何真实用户数据隔离。

---

## 2. 隔离契约（Isolation Contract）

- **代码隔离**：所有 spike 代码位于一次性实验分支与一次性目录/文件（如 `scripts/sync-spike/`、`spike-*` 命名），**不进入生产模块、不被生产 import 引用**（对齐既有 spike 处置惯例：`packages/shared/phase4*.ts`、`scripts/phase4-*.sh` 等历史 spike 曾在验证后被整体移除）。
- **数据隔离**：spike 只读/写**一次性临时 DB**（§6），**绝不读、绝不导入**任何真实用户 `chat.db`、Dexie 数据或 Cherry Studio 数据（SPIKE-001；承接 SYNC-003"无生产导入"）。
- **运行时隔离**：spike 在独立 Electron profile / 独立 userData 下运行；不共享生产 profile、不共享 home/userData 派生路径。
- **依赖隔离**：spike 依赖不写入生产 `package.json`/lockfile（§4；SPIKE-002）。
- **网络隔离（自动化测试）**：spike 的**自动化测试不含任何真实网络/服务端调用**，不携带真实凭据（§5；SPIKE-003）。服务端相关验证只在手工、受控、无真实凭据的服务实例上进行。

---

## 3. 最小本地架构（Minimal Local Architecture）

```
一次性实验目录（非生产）
  ┌────────────────────────────────────────────┐
  │  Spike harness（脚本/测试）                  │
  │    - 生成一次性临时 chat.db（最小 schema）    │
  │    - 写入稳定/最终块检查点（SYNC-004）        │
  │    - 驱动 PowerSync 本地同步引擎              │
  │    - 读回/断言本地同步结果                    │
  └──────────────────┬─────────────────────────┘
                     │
  ┌──────────────────▼─────────────────────────┐
  │  PowerSync SDK（临时依赖，未固定版本）        │
  │  ┌───────────────┐   ┌───────────────────┐ │
  │  │ 本地 SQLite    │   │ 同步引擎/通道       │ │
  │  │（一次性 DB）    │   │（本地回路，不触网）   │ │
  │  └───────────────┘   └───────────────────┘ │
  └────────────────────────────────────────────┘
```

- **本地回路**：spike 优先以**本地回路**（同一进程内本地 sync 实例，无远端服务）验证 schema 适配与写连接行为，把服务端依赖隔离在人工验证步骤（§5"服务端依赖测试"）。
- **最小 schema**：spike 使用**最小化且代表当前 `chat.db` 关键风险点**的一次性 schema（含：关系表、至少一个派生/FTS 形态的触发器或派生表占位、稳定的消息/块检查点表示）。目的不是复刻生产 schema，而是**暴露 PowerSync 对"触发器 + 关系 + 写路径"的真实适配性**。
- **不建生产写路径**：spike 不接入 `ChatDbAggregateService` 或任何生产业务写路径（SYNC-001）；spike 自有独立的最小写入代码。

---

## 4. 依赖策略（Dependency Strategy）

- **依赖视为未固定（unpinned / unresolved），直至验证后锁定**：spike 引入的 PowerSync 相关包为一次性实验依赖，**不写入生产 `package.json` 与 lockfile**（SPIKE-002）。验证完成后的"是否/如何固定"属后续选型决策（sync MVP §13 O-5），不由 spike 决定。
- **安装形式**：spike 依赖以实验分支内的临时声明安装（如临时 manifest 或 spike 专用清单），实验结束随目录一并处置（§9）。
- **不升级/不修改既有固定依赖**：spike 不得改版、替换或移除任何既有生产依赖（含 `better-sqlite3` 原生 ABI 约束——若 spike 需运行，遵循既有 node/electron ABI lane 语义，不手动切 binding）。

---

## 5. 测试分层（Test Tiers）

### 5.1 本地专用测试（local-only，自动化，含于 spike gate）

| # | 测试 | 通过判据 |
|---|---|---|
| T-1 | 一次性临时 DB 生成/关闭生命周期 | 生成、`PRAGMA integrity_check` ok、可干净关闭 |
| T-2 | 稳定/最终块检查点写入 → 同步引擎读取 → 本地回路同步；**并主动构造一个流式中间态** | 稳定检查点被正确识别与同步；**显式构造的流式中间态不产生任何同步事件**（SYNC-004） |
| T-3 | 关系表 + 触发器/派生形态 schema 适配 | PowerSync 对该 schema 形态不报不支持/不破坏触发语义（记录具体行为） |
| T-4 | 写路径行为（Main 单写模型的等价形态） | 单写模型下同步引擎写入不产生连接冲突/竞态 |
| T-5 | 排除数据面**不进入**同步通道（凭据/派生 FTS/UI 状态/附件等占位） | 排除集合零同步（SYNC-003） |
| T-6 | 检查点幂等/可重放 | 重复同步同一检查点不产生重复副作用 |

- **本地测试全部不触网、无真实凭据、无真实用户数据**（SPIKE-003）。
- **本地测试使用 Node 或 Electron 的一次性 ABI lane 语义运行**（对齐仓库既有 `node` lane / `electron` lane 契约；spike 不引入新运行时机制）。

### 5.2 服务依赖的后续测试（service-dependent，**延后**，手工/受控，非自动化 gate）

- 仅当 5.1 本地测试提供 Go 方向的积极信号后，才在**受控**环境下进行服务端/远端同步验证。
- 该类测试**必须**：使用一次性服务实例、**无真实凭据**、mock/隔离环境、一次性临时 profile/DB，**不进入自动化测试套件**。
- 该类测试的目的是评估**端到端拓扑与跨设备路径**，但其结果属于"服务依赖证据"（§7 证据分级），**不作为自动化的 Go 判据**。

---

## 6. 一次性临时环境与清理（Disposable Temp Profile/DB & Cleanup）

- **owned 临时环境**：spike 使用 spike **自有（owned）**的一次性临时 profile 与临时 DB 目录（如 `spike` 命名空间下的临时根），与生产 userData/home 完全隔离；绝不触碰生产 `chat.db`、`Data/`、备份或导入产物。
- **清理职责（owned-cleanup）**：spike 结束后**由 spike 自身**清理其创建的所有临时资源——临时 profile、临时 DB、临时目录、任何一次性依赖产物、临时进程/实例。清理是 ownership-scoped：**只删 spike 拥有的东西**，绝不 kill 宽泛进程树或删除任何非 spike 产物。
- **验证清理**：spike 退出后断言临时根为空/不存在、无残留 spike 进程、无残留 spike DB 连接。
- **无生产导入**：spike 不导入任何生产/Cherry Studio/真实用户数据（SPIKE-001；承接 SYNC-003）。

---

## 7. 证据分级（Evidence Classification）

> 严格区分证据层级，防止把诊断观察当作选型结论（对齐仓库既有证据分层原则）。

| 证据类型 | 分级 | 能否作为 Go/No-Go 依据 |
|---|---|---|
| 5.1 本地自动化测试（一次性 DB，确定性断言） | **决定性（local）** | ✅ 可单独支撑 Go/No-Go 判据 |
| 一次性 DB 的 `PRAGMA integrity_check` / 断言日志 | **决定性（local）** | ✅ 可支撑 T-1/T-6 |
| 5.2 服务依赖验证（受控手工） | **支持性（service）** | ⚠️ 只补充信号，不作为自动化 Go 判据 |
| 日志、观察、人工 CDP/观察 session | **诊断（diagnostic）** | ❌ 不作为结论依据 |
| 截图、非一次性环境观察 | **诊断（diagnostic）** | ❌ 不作为结论依据 |

- Go/No-Go 判定**只**基于 §8 中标注为 local 决定性证据的判据。

---

## 8. Go/No-Go 判据（Go/No-Go Gates）

> 每个判据都是**可测量、可验证**的；Go 要求**全部**必要条件满足。判据的判定基于 §7 中 local 决定性证据。

### Go 必要条件（全部满足 → Go 方向）

| # | 判据 | 证据来源 |
|---|---|---|
| G-1 | 一次性临时 DB 生命周期干净（T-1） | T-1 local |
| G-2 | 稳定/最终块检查点可被正确识别并本地同步，且**主动构造的流式中间态不产生任何同步事件**（T-2，SYNC-004） | T-2 local |
| G-3 | 代表当前 schema 风险点的关系+触发器/派生形态**不**导致 PowerSync 不支持/破坏触发语义（T-3）——若存在限制，必须被精确记录而非忽略 | T-3 local |
| G-4 | Main 单写等价模型下无连接冲突/竞态（T-4） | T-4 local |
| G-5 | 排除数据面零同步（T-5，SYNC-003） | T-5 local |
| G-6 | 检查点幂等/可重放成立（T-6） | T-6 local |
| G-7 | 一次性环境 owned-cleanup 完全（§6） | §6 清理验证 local |
| G-8 | 全部自动化测试无网络、无真实凭据、无真实用户数据（SPIKE-003） | 测试配置 local |

### No-Go 条件（任一满足 → No-Go，报告主会话）

| # | 判据 |
|---|---|
| N-1 | 任一 G-1…G-6 决定性失败（local 证据表明不可满足或无法精确记录的限制） |
| N-2 | 必须修改生产 schema / 生产写路径 / 生产依赖才能继续（违反 SYNC-001） |
| N-3 | spike 无法在隔离一次性环境中完成（被迫触碰生产数据/profile） |
| N-4 | 清理无法做到 owned 完全（残留无法消除的 spike 产物） |
| N-5 | 为通过自动化测试而引入真实网络/凭据/真实数据（违反 SPIKE-003） |

- **记录的限制 → 判定映射（确定性）**：G-3 等判据中**精确记录**的材料限制（material limitation）必须**确定性地**归入下列两类之一，不得含糊：
  - **No-Go**：该限制违反任一 Go 必要条件、或破坏 spike 的核心可行性问题（schema 适配 + 单写连接）、或在 spike 范围内**无已知非阻塞处理方式**（即无法在不改生产 schema/写路径/依赖的前提下绕开）。
  - **非阻塞 Go-with-limitations**：该限制可被明确记录为**残余限制**，且在 spike 范围内存在**确定的非阻塞处理方式**（不涉及生产 schema/写路径/依赖改动，不违反 SYNC-001/SPIKE-002）。此时 Go 方向成立，但 Go 证据必须**附带该残余限制**，供选型阶段（sync MVP §13 O-5）评估其对正式选型的影响。
- **无法归入上述两类（归类歧义）的记录限制一律按 No-Go 处理**；不允许以"部分 Go"或未归类的方式报告。

- **结果形态**：spike 产出**二元结论（Go 方向 / No-Go）**，附逐判据的 local 证据摘要与精确记录的限制项；**不产出** vendor 承诺或选型决策（vendor 由 sync MVP §13 O-5 决策阶段决定）。

---

## 9. Harness 处置规则（Harness Disposal Rules）

- **一次性**：spike harness（脚本/测试/目录/依赖）为一次性实验产物。
- **处置时机**：spike 结束、Go/No-Go 已产出、证据已记录后，spike harness 与一次性依赖**从实验分支整体移除**（对齐既有 spike 处置惯例——历史 `phase4-*` spike 文件在验证后已被删除，生产 import 路径保留）。
- **不合并**：实验分支**不得合并进生产分支**；spike 产物不进生产。
- **证据留档**：Go/No-Go 结论、逐判据结果、精确记录的限制项在**文档/决策记录**中留档（本 spike 计划或 sync MVP 的后续更新），供选型决策引用；留档是证据，不是可运行代码。
- **生产零改动**：移除后生产工作树与 spike 前一致（除本文档类的文档留档）。

---

## 10. 决策表（Decision Table / Locks）

| # | 决策 | 状态 |
|---|---|---|
| **SPIKE-001** | **spike 不读、不导入任何真实用户 / 生产 / Cherry Studio 数据**；只用一次性临时 DB | **Locked** |
| **SPIKE-002** | **spike 依赖不写入生产 `package.json` / lockfile**，版本视为未固定直至验证后由选型阶段锁定 | **Locked** |
| **SPIKE-003** | **spike 自动化测试无网络、无真实凭据、无真实用户数据**；服务端验证仅限受控手工且延后 | **Locked** |
| **SPIKE-004** | **spike 最小 schema 只复刻关键风险点**（关系 + 触发器/派生形态），不复刻生产 schema | **Locked** |
| **SPIKE-005** | **spike 本地回路优先**；服务依赖验证延后、非自动化 gate | **Locked** |
| **SPIKE-006** | **Go/No-Go 只基于 local 决定性证据**；诊断/支持性证据不构成结论 | **Locked** |
| **SPIKE-007** | **spike 使用 owned 一次性临时 profile/DB，owned-cleanup 完全**，只删 spike 自有资源 | **Locked** |
| **SPIKE-008** | **spike 不接入生产业务写路径 / 生产 chat.db**（承接 SYNC-001） | **Locked** |
| **SPIKE-009** | **spike harness 与一次性依赖在结论产出后从实验分支整体移除**；不合并进生产 | **Locked** |
| **SPIKE-010** | **spike 不产生 vendor 承诺 / 选型决策**；vendor 由后续决策阶段决定 | **Locked** |

---

## 11. 风险（Risks）

| 风险 | 说明 |
|---|---|
| 依赖版本漂移 | spike 依赖未固定；结论只对验证时的版本成立，固定与升级验证属选型阶段 |
| 本地回路 ≠ 真实服务 | 5.2 服务依赖信号不足时，不能据此推断端到端表现 |
| schema 代表性不足 | 最小 schema 若未覆盖实际触发器风险点，G-3 可能误判；spike 应在设计期显式列出所覆盖的风险形态 |
| 清理不彻底 | 违反 SPIKE-007/009；处置验证是 Go 必要条件（G-7） |
| 误把 spike 通过当选型完成 | 违反 SPIKE-010；Go 只意味着"值得正式评估"，非选型 |

---

## 12. 一次性结果与证据分级（Disposable Results & Evidence）

> **状态**：一次性本地实验已执行（审计后修正版）。本节记录 **local 决定性证据** 的逐判据分类、Raw Table 与直接写入边界的实测行为、最终本地判定与仅存的服务/打包未知项。证据属"留档"，非可运行代码（§9）。

### 12.1 隔离与依赖修正（审计修正）

- 根 `package.json` / 根 `pnpm-lock.yaml` 已**不含任何 PowerSync 依赖与 spike 脚本**（`grep powersync` → 0）。
- `src/main/services/syncSpike/**` 的 vendor 测试已移除，默认 Vitest 发现不再包含它。
- spike 依赖已收敛到自包含的 `scripts/sync-spike/package.json` + `scripts/sync-spike/pnpm-lock.yaml`（自含 workspace：`scripts/sync-spike/pnpm-workspace.yaml`），精确固定：
  - `@powersync/common@2.1.0`、`@powersync/node@0.21.0`
  - `better-sqlite3` 以 `link:../../node_modules/better-sqlite3` 确定性复用根 lane 管理的 **12.11.1** 绑定（symlink 指向根 `.pnpm/better-sqlite3@12.11.1`，**不产生第二次 ABI 构建**；`build/Release/better_sqlite3.node` 直接复用）。
- 版本标签已统一为 `@powersync/node 0.21.0` / `@powersync/common 2.1.0`（SDK `sdkVersion=0.5.2/c5c23134` 为内核版本标签，非包版本，单独标注）。
- 解析树（spike-local lock，可复现）：`@powersync/node@0.21.0` → `@powersync/common@2.1.0` + `@powersync/shared-internals@1.1.1` + `comlink@4.4.2` + `undici@7.29.0`；`better-sqlite3` 为 link（无下载/无构建）。peer 细节：`@powersync/shared-internals@1.1.1` 声明 `@powersync/common@2.0.0` peer，实际解析 2.1.0（同一 minor 家族内，`@powersync/node` 要求 `^2.1.0`），仅 install 期 WARN，不影响运行，已如实记录。

### 12.2 门控/证据矩阵（Gate / Evidence Matrix）

判定符号：**proven**（local 决定性通过）· **partial**（仅局部证明）· **unproven**（无法离线证明）· **no-go**（决定性失败 / 材料限制）。

| 判据 | 判定 | local 证据 |
|---|---|---|
| G-1 临时 DB 生命周期 | **proven** | 打开 + `PRAGMA integrity_check=ok` + 干净关闭 + 跨打开持久化（m1/8×tx 读回） |
| G-2 稳定检查点识别 / 流式中态排除 | **partial** | **proven**：稳定检查点进入 CRUD batch；流式中态零捕获。**unproven**：本地回路向服务投递——**服务半侧按 §5.2 延后**（无服务实例），非失败原因 |
| G-3 关系 + 触发器/FTS 适配 | **no-go** | **唯一决定性 No-Go 触发**（见 12.3 材料限制 managed-table-as-view 的确定性映射） |
| G-4 单写事务 | **proven** | 8 个并发 `writeTransaction` 收敛、无冲突；rollback 生效 |
| G-5 排除数据面零同步 | **proven** | credentials/ui_state/attachment_refs 上传队列 delta=0 |
| G-6 检查点幂等/可重放 | **unproven** | **proven(local)**：同 id 经 `INSERT OR REPLACE` upsert 收敛到单行（最新值）。**unproven**：服务端重放/幂等离线不可证——**服务半侧按 §5.2 延后**（无服务实例），非失败原因 |
| G-7 owned 清理完全 | **proven** | **harness 断言**：临时根移除、DB 句柄关闭。**by-construction/observed（非 harness 断言）**：无残留 spike 进程——harness 为单一短生命周期进程，退出时不派发独立子进程 |
| G-8 自动化测试无网络/凭据/真实数据 | **proven** | **静态 by-absence**：harness 永不调用 `connect()`、仅 import 本地 SDK、无凭据材料、仅触碰 owned 临时 DB（源码属性，非运行时断言） |
| RAW-1 真实 Raw Table | **proven** | 见 12.4 |
| DW-1 直接写入边界 | **proven** | 见 12.4 |

### 12.3 材料限制（G-3 确定性分类）

PowerSync managed 表是 **JSON-backed view**（`sqlite_master.type='view'`，数据存于 `ps_data__messages`）。因此：

- managed 表上**不能**直接创建 FTS5 虚拟表 / 自定义触发器 / 自定义索引；
- managed 表**拒绝**重复同 id 的裸 `INSERT`（`UNIQUE constraint failed: ps_data__messages.id`）且**不支持** `ON CONFLICT(id) DO UPDATE`（`cannot UPSERT a view`）；幂等写入仅可通过 `INSERT OR REPLACE`。
- 生产 schema 的关键风险形态（消息内容 FTS、消息内容触发器）**无法以 managed 表原样承载**；迁往 raw table（生产需创建 raw 表 + CRUD 触发器 + 迁移管理）属于**生产 schema / 写路径 / 迁移改动**（N-2 / SYNC-001），**超出"零生产改动"的 spike 范围**，无法在本 spike 内非阻塞绕开。

→ 按 §8 确定性映射归为 **No-Go（材料限制，需生产写入/schema 改动）**。

### 12.4 Raw Table 与直接写入边界（实测）

**RAW-1 — 真实 Raw Table 本地写入捕获（proven）**：通过官方 `Schema.withRawTables` + `Schema.rawTableToJson` 声明，以原生 SQLite 建表（`id TEXT PRIMARY KEY` + 自定义索引 `idx_messages_raw_block` + FTS5 `content=` 外部内容表 + FTS 维护触发器），并生成 INSERT/UPDATE/DELETE CRUD 触发器。经 PowerSync 写入后，`ps_crud` 出现 `{"op":"PUT","type":"messages_raw","id":"raw-1",...}`，`getCrudBatch` 亦返回该条目 → **本地写入确实进入 CRUD 队列**。

**DW-1 — 独立第二连接直接写入边界（proven，精确行为）**：对同一 DB 文件打开独立 `better-sqlite3` 连接：

| 直接写入目标 | 实测行为 |
|---|---|
| raw 表 `messages_raw` | **REJECTED**：`no such function: powersync_in_sync_operation`（CRUD 触发器的 `WHEN NOT powersync_in_sync_operation()` 依赖仅存在于 PowerSync 受管连接的 SQLite 内核函数） |
| managed view `messages` | **REJECTED**：`no such function: powersync_strip_subtype`（view 的 INSTEAD OF 触发器依赖内核函数） |
| 内部存储 `ps_data__messages` | **accepted；crud delta=0**（无捕获触发器 → **绕过上传队列**，若直写会与同步数据静默分叉） |

结论：raw 表与 managed view 的写面都被 PowerSync 内核注册的 SQLite 函数保护，**外部连接无法注入"会被同步"的写入**；唯一绕过上传的方式是直写内部存储表（属生产破坏性路径，不适用）。raw 表机制本地可行，但生产落地即生产写入/schema 改动（12.3）。

### 12.5 Electron 冒烟（仅 smoke）

经规范 Electron lane 运行受控探针：Electron 41.2.1 / 内嵌 Node 24.14.1 下 SDK 可加载并执行 SQL（`rows=[e1]`、`integrity_check=ok`）。**仅证明"能跑"，不证明任何同步/服务路径**（诊断性冒烟，非 Go 判据）。

### 12.6 最终本地判定：**No-Go**（在当前"零生产改动"目标下）

- 全部 local 断言通过（12 项），临时清理完全；
- **No-Go 的唯一决定性触发是 G-3**（managed-table-as-view 材料限制需生产写入/schema 改动 → N-2 / SYNC-001 确定性映射）。按 §8：材料限制无法在 spike 内非阻塞绕开 → **No-Go**。
- **G-2 与 G-6 的服务半侧按 §5.2 延后**（service-dependent，受控手工/非自动化 gate），**不是失败原因**：G-2 的"本地回路向服务投递"与 G-6 的"服务端重放/幂等"离线不可证，属延后项而非判据失败；其 local 半侧（捕获/排除、local upsert 收敛）均为 proven。
- 精确含义：PowerSync 的本地 raw-table 写面与直接写入边界已被清晰刻画，但"值得正式选型评估"所需的 schema 适配（G-3）在零生产改动约束下**无法建立**，故 No-Go。
- **No-Go 解释边界**：此 No-Go 是**vendor/约束特定**的——它记录了 PowerSync 在当前"零生产改动"约束下不可行。它**不是**目标架构约束：目标架构演进程序（[`architecture-evolution-program.md`](./architecture-evolution-program.md) ARCH-004）明确要求目标架构不得为 PowerSync 优化或受其约束。未来同步决策必须基于架构演进程序的目标架构品质（§3），保持 vendor 中立。

### 12.7 仅存的服务 / 打包未知项（Remaining Unknowns）

1. **服务投递**：本地回路向 PowerSync Service 的端到端投递/回放（需受控服务实例，§5.2）。
2. **服务侧幂等**：CRUD 重放的真实幂等性（离线不可证）。
3. **生产 schema 落地代价**：把生产 FTS/触发器迁往 raw table 的具体迁移与写路径改造方案。
4. **打包/交付**：Electron 打包后 raw-table 内核扩展（`libpowersync`）的随附与加载（打包流程零改动，未验证）。
5. **依赖固定与升级**：`@powersync/node@0.21.0` / `@powersync/common@2.1.0` 之外的版本行为（未固定，属选型阶段）。

