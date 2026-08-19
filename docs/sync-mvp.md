# 同步 MVP 提案（Synchronization MVP Proposal）— Cherry Chat 多客户端同步第一阶段边界

> **文档状态**：**Proposal / Draft（提案草案）**。本文档是 Cherry Chat **多客户端实时同步**第一阶段的**边界锁定文档**：只锁定"做什么、不做什么、什么仍是开放决策"，**不锁定技术选型、不锁定生产 schema、不锁定跨设备权威架构**。任何生产代码改动、生产依赖安装、schema 变更、vendor 承诺或隐私政策变更都必须由后续获得授权的实现阶段执行，MVP 提案本身不产生此类产物（一次性 PowerSync spike 的依赖只存在于可丢弃 harness，已按 [spike 计划](./sync-powersync-spike.md) §9 处置）。
> **决策锁（durable IDs）**：SYNC-001 … SYNC-004（§12 决策表；本阶段四个已批准边界）。
> **关联**：设备本地 SQLite 聊天权威由 [SQLite migration governance](./sqlite-migration.md) 治理；应用身份/发布/平台由 [Application Identity ADR](./cherry-chat-application-identity.md) 治理；上下文窗口语义由 [Context window governance](./context-window.md) 治理。PowerSync 可行性实验见 [PowerSync spike 计划](./sync-powersync-spike.md)。**本文档不改变、不重述上述治理域的既有边界**，也不修改 [PRIVACY.md](../PRIVACY.md) 现行文本。
> **架构关系**：应用架构演进程序（[`architecture-evolution-program.md`](./architecture-evolution-program.md)）拥有架构正确性、优雅性、统一性与长期可演进性的决策权。同步相关架构约束见 ARCH-003（架构优先/ vendor 中立）、ARCH-004（PowerSync No-Go）、ARCH-005（同步就绪性质）、ARCH-006（无同步实现授权）。
> **最后更新**：2026-08-19
> **Owner**：Personal fork（jorkeyliu）
> **关联分支**：MVP 提案为纯文档产物，不新建实现分支；一次性 PowerSync spike 在独立实验分支执行，harness 已按 [spike 计划](./sync-powersync-spike.md) §9 处置。

---

## 1. 状态与权威声明（Status and Authority Declaration）

- **MVP 提案为纯文档产物**：本文档锁定第一阶段边界，**不改变任何生产代码、不安装生产依赖、不改生产 schema、不建立业务写路径**。一次性 PowerSync spike 已在独立实验分支执行完毕——其依赖只存在于一次性可丢弃 harness（非生产依赖），**结论为 No-Go**，harness 已按 [spike 计划](./sync-powersync-spike.md) §9 处置，证据留档见 spike 计划 §12。
- **设备本地 `chat.db` 在 MVP 提案及 spike 期间始终是运行时聊天权威（runtime authority）**（SYNC-002）。跨设备权威架构（谁是 canonical、冲突如何裁决、是否引入服务端权威）**不由 spike 最终化**。
- **PowerSync 尚未被选型（vendor not selected）**。本阶段的 spike 是一次**可行性验证**（已执行并结束，**结论 No-Go**），其结果用于 Go/No-Go 判断，不构成对 PowerSync 或任何同步方案的产品承诺。
- 本阶段所有同步语义的表述均为**提案**（proposed），供后续决策与实现阶段引用；标注为"开放决策"的产品选择保持开放，由主会话（Main Agent）回报，不由本阶段裁决。

---

## 2. 目标与非目标（Goals and Non-Goals）

### 目标（Goals）

- 为多客户端实时同步建立**一份权威的第一阶段边界**，把已批准范围与非目标写死，防止后续实现期范围蔓延。
- 明确区分"设备本地权威"与"跨设备权威"两个概念，避免把局部修复误当成跨设备权威架构决策。
- 明确**哪些数据候选进入同步、哪些明确排除**（SYNC-003），并给出排除的理由。
- 定义**可测量的 PowerSync Go/No-Go 判据**（在 spike 计划中细化），使选型实验有明确退出条件。
- 把**仍未解决的产品决策**（账号/认证、端到端加密、隐私政策变更、附件范围、vendor、平台/发布影响）显式列为开放项，防止实现期静默代答。

### 非目标（Non-Goals）

- 实现任何同步功能、安装任何同步依赖、改动任何生产聊天 schema 或业务写路径（SYNC-001）。
- 选定同步 vendor、签订任何供应商承诺或服务条款。
- 修改 [PRIVACY.md](../PRIVACY.md) 现行文本（其中"无云同步服务"的表述在本阶段保持不变）。
- 修改既有身份/发布/平台/迁移/上下文窗口治理（Application Identity ADR、SQLite migration governance、Context window governance）的任何已锁定边界。
- 在本阶段解决或预告"跨设备权威架构"的最终形态（SYNC-002 明确推后）。

---

## 3. 数据范围（Data Scope）

### 候选进入同步（candidate — 提案，非承诺）

仅**稳定的最终块检查点（stable / final block checkpoints）**是同步事件的候选（SYNC-004）。候选数据域按重要性从高到低：

| 数据域 | 候选性 | 说明 |
|---|---|---|
| 聊天消息（`messages`） | 候选 | 稳定/最终状态的消息为同步候选；流式中间态不是（SYNC-004） |
| 消息块（`message_blocks`） | 候选 | 仅最终块的稳定检查点 |
| 话题（`topics`）、话题段（`topic_segments`） | 候选 | 结构元数据；随消息同步语义演进 |
| 排序/顺序元数据 | 候选 | 跨设备需一致性保证，属开放设计（冲突矩阵 §7） |

> 上述"候选"不代表第一阶段会实现，只代表**不在明确排除清单内**。实际同步范围由后续决策在"候选集合 × 冲突矩阵 × 开放决策"约束下收敛。

### 明确排除（excluded — SYNC-003，spike 与 MVP 均不同步）

| 排除域 | 理由 |
|---|---|
| 凭据存储域（API keys、账号令牌、认证凭据及其设置/配置/安全存储） | 高敏感；绝不进入同步通道（见 §6 范围说明） |
| 派生的 FTS/全文搜索数据 | 可本地重建的派生数据，无跨设备价值 |
| Redux UI 状态（配置、设置、快捷键、助手配置等） | 非聊天权威；属 renderer 投影/配置 |
| 上下文窗口锚点（`contextWindowAnchor`） | renderer assistant 设置中的 per-topic 锚点；属配置/投影，非聊天权威，**不得随 topics 同步静默跟随**（由 [Context window governance](./context-window.md) 治理） |
| Knowledge（`KnowledgeBase/*`） | 独立领域，超出 MVP 范围 |
| Memory（`memories.db`） | 独立领域，超出 MVP 范围 |
| Trace（`packages/mcp-trace` 相关） | 诊断/追踪数据，非用户聊天权威 |
| 二进制附件（物理 `Data/Files` payload） | 大对象；附件范围是开放决策（§13）；本阶段不纳入 |
| 文件引用（`file_references`） | `chat.db` 中的文件引用表，含 `file_id`/`file_name`/`file_path`；**设备本地 `file_path` 绝不进入同步通道**（设备路径泄漏风险；附件/文件引用范围同属开放决策 §13） |
| 导入产物（L2 promotion artifacts、`files-catalog.json` 等） | 一次性导入内部态，无跨设备同步价值 |
| 备份/恢复状态（L3 归档、journals、快照） | 与同步是不同产品语义；互不混淆 |

---

## 4. 设备本地 vs 跨设备权威（Device-Local vs Cross-Device Authority）

> 这是本文档最重要的概念区分（SYNC-002 的直接落地）。**权威（authority）不因"多了一个同步通道"而自动转移。**

- **设备本地权威（现状，不变）**：每台设备的 `chat.db` 是**该设备上聊天数据的运行时权威**。读、写、渲染都经由 Main 进程 SQLite，renderer 只经 typed IPC 投影。**这一事实在本阶段及 spike 期间保持不变**。
- **跨设备权威（open）**：多台设备各自持有本地 `chat.db` 后，"哪份是权威/如何合并/冲突如何裁决"是**尚未设计的架构**。同步引擎本质上会引入某种协调机制（last-write-wins、服务端 canonical、CRDT、基于块的最终一致性等），**但本阶段不选择其中任何一种**。
- **边界**：任何在本阶段出现的"本地修复/本地读一致"改动，都**不构成**跨设备权威决策；把局部投影当成权威是一类 bug（与既有的 authority/projection 心智模型一致）。跨设备权威架构由后续专门决策阶段确定，并受 SYNC-002 约束——**spike 不最终化该架构**。

---

## 5. 初始同步拓扑（Initial Sync Topology — 提案）

> 本节是**提案性拓扑示意**，用于指导 spike 的最小架构与风险识别，**不锁定最终架构，也不依赖任何特定 vendor**（vendor 开放决策见 §13）。

```
┌────────────────────────────┐         ┌────────────────────────────┐
│  Device A (Cherry Chat)    │         │  Device B (Cherry Chat)    │
│  ┌──────────────────────┐  │         │  ┌──────────────────────┐  │
│  │ chat.db (SQLite)     │  │         │  │ chat.db (SQLite)     │  │
│  │ 设备本地权威 (SYNC-002) │  │         │  │ 设备本地权威 (SYNC-002) │  │
│  └──────────┬───────────┘  │         │  └──────────┬───────────┘  │
│             │ 稳定最终检查点 │          │             │               │
│  ┌──────────▼───────────┐  │         │  ┌──────────▼───────────┐  │
│  │ Sync Engine (本地)    │  │         │  │ Sync Engine (本地)    │  │
│  │ 读取稳定块检查点        │  │         │  │ 应用远端块检查点        │  │
│  └──────────┬───────────┘  │         │  └──────────┬───────────┘  │
└─────────────┼──────────────┘         └─────────────┼──────────────┘
              │ 上送稳定检查点（SYNC-004，无流式中间态）│
              ▼                                       │
        ┌──────────────────────┐                       │
        │   Sync Backend        │◄─────────────────────┘
        │   （云或自托管，open）  │     拉取远端稳定检查点
        └──────────────────────┘
```

- **设备侧（illustrative/open placement）**：拓扑示意中 sync engine 画在 **Main 进程**（与聊天权威同侧），这是**示意性放置，不是已批准的进程归属决策**——sync engine 的实际进程位置、是否引入独立进程、以及任何 authority 转移均属开放决策，不由本提案锁定。sync engine 只读取稳定/最终块检查点；不读取流式 token 中间态（SYNC-004），不触碰凭据/派生 FTS/UI 状态等排除域（SYNC-003）。
- **服务端**：拓扑/托管形式（云服务 vs 自托管）属开放决策（§13），本节仅以"sync backend"占位。
- **要点**：该拓扑把"同步"定位为**检查点事件驱动的协调层**，叠加在设备本地权威之上，而非替代设备本地权威（SYNC-002）。

---

## 6. 安全与隐私约束（Security and Privacy Constraints）

- **凭据存储域零同步**：**凭据存储域**（API keys、账号令牌、认证凭据及其所在的设置/配置/安全存储）在同步的任意方向上**绝不进入同步通道**（SYNC-003；不可协商）。
- **消息内容中的秘密文本**：用户作为聊天内容输入到候选消息中的密钥/令牌等秘密文本属于**聊天内容**，其是否/如何同步由**端到端加密（E2EE）与内容策略**决定（开放决策 O-2，§13），**不**适用上述凭据存储域的零同步保证。
- **敏感聊天内容**：同步内容含用户聊天数据，必须满足最低程度的传输安全（如 TLS），是否引入**端到端加密（E2EE）**是开放决策（§13）。
- **隐私政策一致性**：[PRIVACY.md](../PRIVACY.md) 目前明确表述"不提供云同步服务，不上传数据到服务器"。**启用任何实际云同步将构成隐私政策变更**，须先完成政策更新与用户披露——这是开放决策（§13），本阶段不修改该文本。
- **本地优先**：同步开启前，设备本地权威与现有本地存储语义不变；同步是显式可选能力，绝不隐式上送。
- **最小数据面**：同步面只覆盖 §3"候选进入同步"集合，排除集合永不进入。

---

## 7. 冲突矩阵（Conflict Matrix — 提案）

> 冲突语义是**提案**，最终裁决规则由跨设备权威架构（§4，open）决定。本矩阵把已知冲突点显式化，供 spike 评估与后续决策使用。`?` 表示该单元格依赖开放决策，未在本阶段裁决。

| 场景 | 冲突本质 | 提案处理倾向 | 状态 |
|---|---|---|---|
| 创建（同侧/两侧新建） | 唯一 ID 冲突 / 语义重复 | 依赖 ID 生成与唯一性策略；ID 方案为 open | ?（open） |
| 编辑（同一消息两侧不同内容） | 值级冲突 | 需要裁决规则（LWW / 服务端 canonical / 块级 merge）；**spike 不裁决** | open |
| 最终流式块（两侧各有不同最终块） | 稳定检查点之间的内容差异 | 只有稳定/最终块是候选（SYNC-004）；中间态不参与 | 候选边界已锁，规则 open |
| 顺序（消息/块排序） | 顺序不一致 | 依赖排序元数据策略；需跨设备一致性保证 | open |
| 删除（一侧删除，另一侧已编辑） | 删除 vs 编辑并发 | 需删除语义（tombstone？）；回收站已存在本地语义 | open |
| 回答选择（assistant 回答/选择） | 多候选回答的选择状态不一致 | 依赖回答选择状态的数据归属；open | open |
| 段（segments / topic_segments） | 段结构跨设备差异 | 段为候选结构元数据；合并规则 open | open |
| 回收站（trash） | 已删 topic 恢复/删除的跨设备差异 | 本地回收站语义保留；跨设备回收站语义 open | open |

> 冲突矩阵的**存在本身**是本阶段的产物：它把"哪些冲突是已知的"写死，供 spike 评估这些冲突对所选方案的冲击。矩阵内所有 `open` 单元格均回报主会话，不在此裁决。

---

## 8. 失败与恢复语义（Failure and Recovery Semantics — 提案）

- **设备本地权威永不因同步失败而回退**：同步是叠加能力；网络中断、服务端不可用、同步引擎错误都不得破坏设备本地 `chat.db` 或阻断本地读写。
- **检查点幂等**：稳定块检查点应设计为**可重放/幂等**，断点续传不产生重复副作用；这是 spike 的一项可验证判据。
- **分区恢复**：设备离线期间本地继续写入；重连后以"稳定检查点差异"同步，而非全量重传。
- **原子性**：应用到本地 `chat.db` 的远端变更应事务化，失败即回滚，保持本地库完整性（`integrity_check` 语义沿用 SQLite migration governance）。
- **诊断与降级**：同步失败必须有明确、可观测、对用户可见的降级状态，绝不静默吞掉；错误经 `loggerService` 记录，不 `console.log`。

---

## 9. Schema / 迁移触发器（Schema and Migration Triggers）

- **本阶段零 schema 变更**（SYNC-001）。下列"触发器"描述**何种情形才会在未来触发 schema/migration 决策**，属于提案性预警，不是当前改动。

### 当前同步就绪性证据（current-state readiness — 现状，非承诺）

> 以下描述的是**当前 `chat.db` 模型客观上能/不能为同步提供什么**，是供后续决策参考的现状证据，**不是架构决策，也不代表任何 sync 能力存在**。它不改写 [SQLite migration governance](./sqlite-migration.md) 或 [Context window governance](./context-window.md) 的任何边界，也不断言 SQLite 存在缺陷——只是说明现有模型尚未为同步内建原语。

- **没有可作同步版本的修订原语**：`topics` / `messages` / `message_blocks` / `topic_segments` 虽有 `updated_at`（nullable TEXT）字段，但**并非每条写路径都会维护它**——它由调用方透传、可为空，不作为自动更新的版本戳，因此**不能把 `updated_at` 当作可靠的同步版本**。当前 schema **不存在** revision、sync cursor、outbox、inbox 或 tombstone 任何一类的同步元数据列/表。
- **当前本地持久化可能包含中间状态**：本地流式持久化行为可能将中间状态写入数据库（取决于现有实现）。只有稳定/最终块检查点才是未来同步的候选（SYNC-004）；中间状态不是同步事件。架构演进程序（§3.5）将此边界作为目标兼容性品质来建立。
- **删除是硬删除且级联**：外键均为 `ON DELETE CASCADE`——删除 `topics` 会级联删除其 `messages`、`message_blocks`、`topic_segments`（及关联成员/文件引用行）；删除 `messages` 级联其 `message_blocks` 与 `file_references`。**当前不存在保留删除记录（tombstone / 删除保留）的机制**，未来实现同步前必须先定义 tombstone / 删除保留语义，否则远端删除无法安全传播。
- **`file_path` 是设备本地路径**：`file_references.file_path` 记录设备本地绝对路径，**绝不进入同步通道**（设备路径泄漏风险，见 §3 排除表）。文件权威（canonical file identity）与附件范围**保持开放**，与开放决策 O-4 关联。

- **触发条件（未来，非现在）**：
  - 引入跨设备唯一 ID / 版本化记录标识（如需要，属 open）。
  - 引入块级版本/时间戳/来源元数据字段以支撑冲突裁决。
  - 为删除/回收站引入 tombstone 或跨设备删除语义。
  - 为同步引入同步状态元数据表（sync cursor / checkpoint / pending outbox）。
- **治理要求**：任何上述 schema 变更**必须**遵循 [SQLite migration governance](./sqlite-migration.md) 的版本化、append-only、回滚感知流程，且须在对应决策阶段获批；本阶段不预写 migration。

---

## 10. 分阶段交付（Phased Delivery — 提案）

| 阶段 | 内容 | 退出条件 | 状态 |
|---|---|---|---|
| **Phase 0 · 文档边界**（本阶段） | MVP 提案 + 一次性 spike 计划，锁定范围/非目标/数据面/开放决策 | 两文档发布并链接（AGENTS.md / architecture.md）；零生产改动 | **本文档即产物** |
| **Phase 1 · Spike** | 按 [spike 计划](./sync-powersync-spike.md) 执行一次性、可丢弃的 PowerSync 可行性验证 | spike Go/No-Go 判据逐一满足/否决 | **执行完成 · No-Go**（零生产变更目标下；harness 已处置，证据留档见 spike 计划 §12） |
| **Phase 2 · 决策** | 基于 spike 结果裁决：vendor（Go/No-Go）、跨设备权威架构、数据面收敛、冲突规则 | 决策锁更新；开放决策逐项关闭 | 未开始 |
| **Phase 3 · MVP 实现** | 在获批的权威架构与数据面下实现最小同步能力 | 验收标准（§11）满足 | 未开始（明确非本阶段） |

> 本提案只承诺 Phase 0。Phase 1 spike 已作为一次性实验执行并结束（No-Go，见 [spike 计划](./sync-powersync-spike.md) §12）；Phase 2/3 的启动都需要独立批准，以后续决策为前提。

---

## 11. 验收标准（Acceptance Criteria）

| # | 验收标准 | 本阶段满足 |
|---|---|---|
| AC-1 | 文档明确声明"本阶段为提案 + spike，零生产改动"（§1） | ✅ |
| AC-2 | 目标/非目标完整且互斥（§2） | ✅ |
| AC-3 | 数据范围区分"候选同步"与"明确排除"，排除清单与 SYNC-003 一致（§3） | ✅ |
| AC-4 | 设备本地 vs 跨设备权威区分清晰，spike 不最终化跨设备权威（SYNC-002，§4） | ✅ |
| AC-5 | 初始拓扑为提案性示意，不锁定 vendor/托管形式（§5） | ✅ |
| AC-6 | 安全/隐私约束明确，PRIVACY.md 文本未改，隐私变更为开放项（§6/§13） | ✅ |
| AC-7 | 冲突矩阵覆盖：创建/编辑/最终流式块/顺序/删除/回答选择/段/回收站（§7） | ✅ |
| AC-8 | 失败/恢复语义明确（设备本地权威不回退、检查点幂等）（§8） | ✅ |
| AC-9 | Schema/迁移触发器明确为零改动 + 未来触发条件（§9） | ✅ |
| AC-10 | 分阶段交付清晰，仅承诺 Phase 0（§10） | ✅ |
| AC-11 | 开放决策显式列出（§13） | ✅ |
| AC-12 | 全文未声称 PowerSync 已选型、未修改任何生产产物 | ✅ |

---

## 12. 决策表（Decision Table / Locks）

> 下列 durable IDs 表达本阶段**四个已批准边界**（对应编排侧已批准的第一阶段锁定决策）；它们只在本文档语境成立，不进入代码、配置或提交信息。产品语义在此文档中以其自身词汇表达。

| # | 决策 | 状态 |
|---|---|---|
| **SYNC-001** | **第一阶段 = 文档化的 MVP 提案 + 隔离的一次性 PowerSync spike**；不做生产聊天 schema 改动、不建业务写路径 | **Locked** |
| **SYNC-002** | **spike 期间设备本地 `chat.db` 始终是运行时权威**；跨设备权威架构与 vendor 选型**不由 spike 最终化** | **Locked** |
| **SYNC-003** | **spike 不同步**：凭据存储域、派生 FTS 数据、Redux UI 状态、`contextWindowAnchor`、`file_references`、Knowledge、Memory、Trace、二进制附件、导入产物、备份/恢复状态 | **Locked** |
| **SYNC-004** | **流式 token 更新不是同步事件**；只有稳定/最终块检查点是同步候选 | **Locked** |

> 历史映射（编排协调令牌 → 本仓库 durable 语义）：阶段内四个已批准边界落为 SYNC-001…004；其编排内部令牌在本文档不出现。

---

## 13. 开放决策（Open Decisions — 回报主会话）

> 下列决策**保持开放**，本阶段不裁决；每一行的解决都需独立决策阶段与（如涉及隐私/发布/平台）对应治理审批。

| # | 开放决策 | 影响 | 关联 |
|---|---|---|---|
| O-1 | 账号/认证模型（匿名设备、账号体系、多设备归属） | 同步拓扑、数据隔离、删除/迁移语义 | §5、§13 |
| O-2 | 端到端加密（E2EE）是否引入及粒度；且决定**消息内容中的秘密文本**（用户键入的密钥/令牌等）的同步策略 | 安全/隐私约束、性能、密钥管理、内容策略 | §6 |
| O-3 | 隐私政策变更（PRIVACY.md"无云同步"表述）何时/如何更新与披露 | 合规、用户信任 | §6 |
| O-4 | 附件/二进制大对象范围（是否/如何纳入同步） | 数据面大小、带宽、成本 | §3、§9 文件权威（canonical file identity / 附件范围）决策 |
| O-5 | 同步 vendor / 自托管选择（spike 结果 Go/No-Go） | 技术栈、运维、成本 | §5、spike 计划 |
| O-6 | 平台/发布影响（macOS-first；云同步能力是否受平台与发布冻结约束） | 发布就绪、平台承诺 | Application Identity ADR |
| O-7 | 跨设备权威架构与冲突裁决规则（§4/§7 内所有 `open` 单元格） | 核心架构 | §4、§7 |

---

## 14. 风险（Risks）

| 风险 | 说明 |
|---|---|
| 范围蔓延 | 本文档锁定 Phase 0 边界；任何超出范围的生产改动视为违规 |
| 权威误判 | 把同步层的局部一致当成跨设备权威决策（SYNC-002 明确禁止） |
| 隐私承诺漂移 | 在未更新 PRIVACY.md 前启用任何云同步将破坏现行承诺（O-3 未决前禁止） |
| schema 过早演进 | 在本阶段预写 migration 或改动聊天 schema（SYNC-001 明确禁止） |
| spike 结论误读 | spike 通过 ≠ 选型完成；vendor 承诺由 O-5 决策阶段决定 |
