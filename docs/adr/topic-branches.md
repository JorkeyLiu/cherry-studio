# Topic Branches — True-Branch Authority (唯一权威规范)

> **文档状态**：Authoritative（权威规范，描述已实现的 durable 语义）。本文档是 topic-internal true branch 的**唯一权威规范**：定义消息实体唯一性、永久所属、只读引用、owner 完整控制、蝴蝶效应与缺 anchor fail-closed、删除 subtree、anchor 不可变与创建规则、有效路由递归算法、Main 权威与 Renderer fail-closed、复合变更的实际写目标与原子性、上下文窗口关系、同步与导入导出边界。投影完备性（`loaded-projection`、窗口三元区分、稳定 ID 导航、调用者本地读取、请求本地覆盖）仍由 [Projection Completeness and Authority Intents](./projection-completeness-authority.md)（PROJ-1…PROJ-12）治理，本文档不重复其决策表；上下文锚点的有效性/默认/继承/修复仍由 [Context window governance](./context-window.md) 治理，本文档只定义分支与上下文的关系。
> **决策锁**：BRANCH-1 … BRANCH-12（§3 决策表，durable decision IDs；迁移语义为既有 ID 的 bounded 扩展，不新增 BRANCH 编号，不使用会话 LOCK ID）。
> **最后更新**：2026-10-03 — docs-only finalization: `BRANCH-10` target superseded to syncable per 2026-10-02 user authorization (history `v1`/`v2` local-only wire-kept, `v3`/`v5` syncable); `BRANCH-1`–`BRANCH-9`/`BRANCH-11`–`BRANCH-12` unchanged; `v5` `topic-message-stable-block-order-branch-assistant-attachment-v5`/`sync-baseline-wire-v5` + `branchSuffix` frames now implemented with limited validation and final gate verified for 本次实现的代码状态 on 2026-10-03 (unified upgrade, no old-data compat burden; see `docs/work/multi-device-sync.md` §7 concise known result + scope boundary — limited validation, not production-ready; final gate verified, not pending). 2026-10-04 amendment: §7A move is `v5`-syncable via purpose-specific single-compound `move_turns_to_branch` (`SYNC-DATA-062`/`SYNC-CC-028`, no `v6`); `BRANCH-1`–`BRANCH-9`/`BRANCH-11`–`BRANCH-12` unchanged; history `v1`–`v4` untouched; final gate verified 2026-10-04 (scoped E2E 47: 42 sync + 5 conversation).
> **Owner**：Personal fork（jorkeyliu）
> **关联**：`AGENTS.md` 与 `docs/architecture/architecture.md` 链接本文档而非复制其决策表；应用身份由 [Application Identity ADR](./cherry-chat-application-identity.md) 治理，SQLite 聊天权威与 L2 导入由 [SQLite migration governance](../archived/sqlite-migration.md) 治理，同步现状由 [Personal Multi-Device Sync](../work/multi-device-sync.md) 治理、目标由 [Sync Connection & Channel ADR](./sync-connection-channel.md) 与 [Sync Data Convergence ADR](./sync-data-convergence.md) 治理——本文档不改变、不重述这些治理域的边界。
> **规范目标 vs 实现状态**：本文档 §2/§3/§7A/§8/§9/§11/§12 定义目的特定新命令 `moveSelectedTurnsToNewBranch`（“移至新建分支”）的目标语义；Main/Renderer 实现随集成分支落地，同步语义由 §14 与 Sync ADR 治理（`v5` single-compound move syncable，见 §14）。

---

## 1. 背景与问题（Background and Problem）

窗口化读取与分支路由落地后，同一逻辑 topic 内出现两种易混语义：渲染投影的完备性（哪部分已加载）与分支路由的变更权限（哪一行可经哪条路由变更）。旧分支权限模型以 `private (owned-unshared)` / `shared prefix` / 活后代保护集（`collectProtectedMessageIdsInTx`、`assertNoLiveDescendantIncludesInTx`）收缩 owner 权限：owner 行一旦被后代引用即不可变。这与“同一逻辑 topic 内每条消息只有一个权威实体”的直觉冲突，导致 owner 无法编辑被引用的行、上下文锚点与分支锚点混淆、`mutableMessageIds` 排除被引用的 owned 行、回答组/segment/重发因只读引用被误阻断。

本文档以 BRANCH-1…BRANCH-12 锁定 true-branch 模型：**实体唯一、所属永久、引用只读、owner 完整控制、蝴蝶效应自然发生、缺 anchor 明确失败**。分支创建收缩的是“后代路由的可写集合”（后代只能写自己的后缀），而不是 owner 的权限；分支删除恢复的是“路由可见性”，而不是 owner 的可变性。

---

## 2. 术语（Terminology）

| 术语 | 标识符 | 定义 |
|---|---|---|
| 逻辑 topic | logical topic | 侧边栏的唯一 topic 身份；路由切换永不改变 topic 身份 |
| 消息实体 | message entity | SQLite `messages` 的一行；同一逻辑 topic 内每条消息只有一个权威实体与稳定 ID |
| 路由/有效路由 | route / effective route | 一次权威读写所寻址的逻辑 topic 内分支：`branchId` 缺席/null 为 main 路由，非空为该分支的有效路由（经各锚点的祖先前缀加自有后缀，稳定 ID 共享、无前缀拷贝） |
| 所有者 | owner | 消息的永久所属路由：`branch_id`（null = main 路由）。消息在哪个 route 创建，就永久属于该 route |
| 祖先引用 | ancestor reference | 后代有效路由中来自祖先路由的消息行；仅作为构成完整会话与上下文的只读引用，不转移所属权 |
| 分支锚点 | branch anchor | 创建分支时指定的父有效路由内消息（`anchorMessageId`）；immutable，见 BRANCH-7 |
| 上下文锚点 | context-window anchor | 每路由独立的稳定上下文起点（`contextWindowAnchor[routeKey]`，起始 turn 的 group key）；与分支锚点严格区分，见 BRANCH-8 |
| 有效前缀 | effective prefix | 后代有效路由中来自祖先的部分（含锚点）；删除/重排 owner 行会自然改变后代前缀 |
| 自有后缀 | owned suffix | 有效路由中属于当前分支的行；当前路由只能 mutation 这部分 |
| 缺 anchor | missing anchor | 分支链上某 anchor 不在父有效路由中；路由解析 fail-closed（NOT_FOUND），见 BRANCH-5 |
| 可变消息集 | mutableMessageIds | Main 随每次窗口响应发布的权威能力：该响应窗口 messages 中 `branchId == addressed route` 的精确子集（BRANCH-9） |
| 实际写目标 | actual mutation target | 一条命令实际写/删/重排的消息行；只读引用（user root 读取、组成员读取、segment 成员引用解析）不构成 mutation（BRANCH-4/12） |
| 跨-topic 克隆 | cross-topic clone | `branchMessagesToTopic` 的跨 topic 前缀克隆（fresh IDs）；不是 true branch，见 BRANCH-10 |
| 所有权迁移 | ownership move | 目的特定 Main 权威命令 `moveSelectedTurnsToNewBranch`（“移至新建分支”）：将同一逻辑 topic 内源路由自有的连续整 turn 原子迁移至新建子分支；稳定 ID、同 topic，块/文件引用/`askId`/内容保留，消息 `owner` 由源路由转至新分支，新分支锚点为不可变迁移前驱；普通身份字段 patch 仍禁止，不设通用 owner 迁移 API |
| 连续整 turn 选择 | continuous full-turn selection | 迁移的唯一合法选择形态：按整 turn（含 user 根与所属 assistant 整组）连续选取的源路由自有消息集合；Main 按整 turn 组 ID 展开，不接受任意 per-message rehome |

旧权限模型的 `public/private/owned-unshared/shared-prefix-immutable/descendant-locks-owner` 不再是权限模型；仅“有效前缀/自有后缀”作为路由构成描述保留，不携带权限含义。

---

## 3. 决策表（Decision Table）

| # | 决策 | 状态 |
|---|---|---|
| **BRANCH-1** | **消息实体唯一**：同一逻辑 topic 内每条消息只有一个权威实体与稳定 ID。true branch 不复制、不覆盖、不创建投影、不做 COW。分支有效路由共享稳定 ID，无前缀拷贝 | **Locked** |
| **BRANCH-2** | **永久所属（唯一显式迁移例外）**：消息在哪个 route 创建，就永久属于该 route。main route owner = `branch_id null`；分支 owner = `branch_id`。分叉只建立祖先消息引用，不转移/分享/继承所属权。**唯一例外**是目的特定 Main 权威原子命令 `moveSelectedTurnsToNewBranch`（§7A/§8/§12）：源路由自有（source-owned）的连续整 turn 可整体迁移至新建子分支并变更 `owner` 至新分支（稳定 ID、同 topic；块/文件引用/`askId`/内容保留）。除此之外无通用 owner 迁移 API，普通身份字段 patch 仍禁止 | **Locked** |
| **BRANCH-3** | **引用只读**：当前 route 只能 mutation 自己拥有的消息；祖先消息在后代 route 中仅作为构成完整会话与上下文的只读引用。祖先引用对插入与子分支创建只读：`insertMessagesAfterAnchor` 在分支上仅接受自有锚点，以及唯一例外——ID 恰好等于被寻址分支不可变 `anchorMessageId` 的继承锚点（fork 边界/父引用终答），新行盖章为当前分支自有并落自有后缀起始；更老的祖先引用 fail-closed 零写。`createBranch` 见 BRANCH-7 owner-only。不再使用 public/private/owned-unshared 作为权限模型 | **Locked** |
| **BRANCH-4** | **Owner 完整控制**：后代是否引用、引用数量、是否位于后代有效前缀都不得收缩 owner 的变更权限。内容编辑、blocks、删除、批量删除、重排、回答组字段、segment 关系、resend/regenerate 等均只按实际 mutation target 的 owner 判权；不得因 live descendants 拒绝 owner。非 owner 仍 fail-closed。跨实体命令只允许写/删/重排当前 route owned 的实际目标；读取祖先引用本身不构成 mutation，但祖先引用永不构成插入/分支锚点授权（BRANCH-3/7 bounded 例外除外）。保留事务原子性 | **Locked** |
| **BRANCH-5** | **蝴蝶效应与缺 anchor fail-closed（自动修复禁令 vs 显式授权迁移）**：owner 对唯一实体的内容修改被所有引用 route 立即看到；删除前缀行改变后代前缀；重排 owner 行改变所有引用该 owner 序列的后代有效路由；若 owner 删除某 branch anchor，依赖该 anchor 的后代 route 保持 branch metadata 但解析 fail-closed 为 missing anchor/NOT_FOUND。不得暗中修复、clamp、复制、快照、自动转移 owner、级联删后代或重新收缩 owner 权限。**自动 owner 转移永禁**；仅 BRANCH-2 显式授权的 `moveSelectedTurnsToNewBranch` 可变更 owner，且同样不得 reparent/delete/clamp 既有分支（§7A fail-closed）。保护集对坏 anchor silent-continue 的旧逻辑已移除，route resolver 保持明确 throw | **Locked** |
| **BRANCH-6** | **分支删除即 subtree 删除**：删除 branch 即删除其整个 descendant subtree（含各自分支的 owned messages/blocks/file refs 与分支行），祖先引用与 sibling 保留。删后 topic 与从未分支不可区分（当删除全部的分支持） | **Locked** |
| **BRANCH-7** | **Branch anchor immutable；owner-only 创建规则（含迁移新建分支）**：branch anchor immutable；子分支锚点必须由父路由自有（owner equality）：main 父接受 main 自有消息，非 main 父要求锚点消息 owner == parentBranchId；任何继承引用（含父自身继承的 fork 锚点）一律拒绝 fail-closed。nested 分支因此必含父分支经所选锚点的自有路由；sibling（同 parent 同 anchor 或同 parent 不同 anchor）维持现状；创建只插入一行 `topic_branches`，不触碰父路由、共享消息与 topic 状态。迁移新建分支（§7A）同样新建一行 `topic_branches` 且 anchor = 不可变迁移前驱（须存在且源路由自有），与所选迁移集原子提交 | **Locked** |
| **BRANCH-8** | **上下文窗口关系**：上下文算法/消息选择语义 branch-neutral，只关注当前 route 的 effective message sequence 与稳定 IDs，不参与 ownership/permission；但每个 route 可有独立 context-window anchor/state，不同分支可有不同窗口。Branch anchor 与 context-window anchor 严格区分。保留现有 route-scoped key（main `topicId`，分支 `topicId:branchId`）与 context ADR 的建立/继承规则；context capability 永不作为 mutation permission | **Locked** |
| **BRANCH-9** | **Main 权威与 Renderer fail-closed（含迁移门禁）**：Main SQLite 是变更权限的唯一权威（含 `mutableMessageIds` 发布者）；Renderer capability 仅预检，unknown/stale/route mismatch fail-closed。`mutableMessageIds` 定义为当前 window 中 `message.branchId == addressed route` 的精确子集，不再排除被后代引用的行。Renderer 继续不猜 branchId，只消费 Main capability。“移至新建分支”在无前驱锚点、迁移集含任一既有分支锚点、catalog/route unknown-stale、capability unknown/stale 时禁用（§11），Main 在同一根事务重验全部权威条件；loaded-only 投影永不用作完备权威 | **Locked** |
| **BRANCH-10** | **Local-only 与 clone 区分 — `2026-10-02` target superseded, `v5` now implemented with limited validation (history `v1`/`v2` wire-kept, `v3`/`v5` syncable)**: history `v1`–`v2` true branches were `local-only / excluded from sync`（分支行、分支-owned 消息/块/操作永不进 `v1`/`v2` `sync outbox`/`membership`/`frame clocks`/`baseline`；main 行保持 syncable）— this local-only target is now **superseded** by `2026-10-02` user-authorized expansion. **`v5` is now implemented with limited validation** (`018_branch_sync_frames` `branchSuffix` frames, `projectLocalBaselineToWirePayloadV5`/`mergeValidatedBaselineInTx` + `SyncService.publishBaseline`/`fetchBaseline` at `sync-baseline-wire-v5`) **with unified upgrade and no old-data compat burden**; history `v1`/`v2` local-only stays as locked history, not silently rewritten. Branch `BRANCH-1`–`BRANCH-9`/`BRANCH-11`–`BRANCH-12` unchanged; `branchMessagesToTopic` 跨-topic clone（fresh IDs）仍非 true branch。 Scope authorization is not permission for historical old-wire mutable-keys. | **Locked — superseded 2026-10-02, `v5` implemented with limited validation (BRANCH-1–9/11–12 unchanged)** |
| **BRANCH-11** | **有效路由递归算法**：anchor-inclusive 递归合成、稳定 IDs、无 clone。main = owned rows；分支 = 递归取每层祖先路由经子 anchor（含锚点）的前缀，加当前分支 owned 后缀；每层确定性 `sort_order ASC, id ASC`。任一 anchor 缺失明确 fail-closed（NOT_FOUND），不得自动修复 | **Locked** |
| **BRANCH-12** | **复合变更实际写目标与原子性（含迁移原子）**：answer-group（select/fold、reorder、useful、append）、segment（upsert/replace）、批量删除、语义删除、resend/regenerate、reset-core 均只验证实际写/删/重排的目标 owner；读取的 user root/组成员/anchor 不要求可变，但 `insertMessagesAfterAnchor` 的 anchor 选择受 BRANCH-3 bounded 约束（仅自有锚点 + 唯一 fork 边界例外）。一条命令实际 mutation 多个消息时全体目标须 owner match，先验证后写，失败零部分写（同一根事务）。`moveSelectedTurnsToNewBranch` 为目的特定复合写：分支元数据 + 消息 owners + 排序原子提交；选择为整 turn 组 ID 由 Main 展开；完整落入迁移集的 segment 原样保留，横跨所选/非所选边界的既有 segment fail-closed（不新增 split 策略） | **Locked** |

> 决策锁 ID 是编排内部协调令牌的产物语义表达：BRANCH-* 是本文档的 durable 决策 ID，不进入代码注释、配置或提交信息。

---

## 4. 权威模型（Authority Model）

- **Main SQLite 是唯一聊天权威**（含分支路由解析、顺序、回答组成员/顺序、变更作用域、Segment 目录、上下文闭包派生）。Renderer 永不持有 SQLite 连接，经类型化 IPC 访问。
- **Renderer 普通消息状态是已加载投影**（`loaded-projection`，PROJ-1…PROJ-12）；`window.api` 可达性不转移所有权。
- **Preload 是唯一的 capability 门**；`packages/shared` 是跨进程契约；契约变更两侧协同。
- **aiCore 是 provider 请求策略与执行**，不决定分支权限。

---

## 5. 实体、Owner 与引用（Entity, Owner, Reference）

- 每条消息有且仅有一个 `(topicId, branchId)` owner；`branchId null` = main。
- `messages.branch_id` 是 ownership only；`topic_branches` 定义 ancestry（`parentBranchId`、`anchorMessageId`）。
- 后代有效路由中的祖先行是只读引用：可渲染、可组成上下文，不可经后代路由 mutation，不 COW；不可作为子分支锚点（BRANCH-7 owner-only），仅当 ID 恰好等于被寻址分支不可变 `anchorMessageId` 时可作为 `insertMessagesAfterAnchor` 的 fork 边界例外（BRANCH-3）。
- 身份字段（`id`、`topicId`、`branchId`、`sortOrder`）永不经 patch 变更；Main 在写入时按 route 上下文 authoritative stamping（wire `branchId` 永不信任）。**唯一例外**是 `moveSelectedTurnsToNewBranch` 经目的特定 Main 权威命令变更所选消息 `branchId`（§7A/§12 原子语义）；不存在通用 owner 转移 API。

---

## 6. 有效路由递归算法（Effective Route Resolution, BRANCH-11）

```
effective(topic, null) = listByTopic(topic, null)
effective(topic, branch):
  path = branchPath(branch)  // root-first, cycle/depth-guarded
  leaf.topicId must == topic else NOT_FOUND
  eff = listByTopic(topic, null)
  for node in path:
    idx = eff.find(node.anchorMessageId)
    if idx == -1: throw NOT_FOUND(missing anchor)
    eff = eff[0..idx] + listByTopic(topic, node.id)
  return eff
```

- Anchor-inclusive；稳定 ID 共享；无克隆；每层 `sort_order ASC, id ASC`。
- 任一 anchor 缺失（owner 删除了 anchor，或 anchor 不在父有效路由）→ 明确 `ChatDbNotFoundError`（NOT_FOUND），调用方 fail-closed；不得 silent-continue、clamp、截断、复制或修复。
- `forkBoundaryIndex = effective.length - ownedCount` 仅为构成描述，不携带权限；bounded 插入/分支权限由 BRANCH-3/7 另行定义，不由边界索引推导。

---

## 7. Branch Anchor 与创建/嵌套/同级（BRANCH-7）

- Anchor immutable：分支行创建后 `anchorMessageId`、`parentBranchId` 永不变更；仅 `name` 可改。
- 创建验证（同一根事务）：逻辑 topic 存在且非 trash；parent route 存在（null = main，否则为本 topic 分支）；anchor 属于 parent 有效路由 **且** 由 parent 路由自有（`owner == parentBranchId`，main 父要求 main 自有；任何继承引用——含父自身继承的 fork 锚点——以 `ChatDbValidationError` 拒绝，零写）。
- 创建效果：恰好插入一行 `topic_branches`（`id/topicId/parentBranchId/anchorMessageId/name`）；无 sync intent；返回创建节点加有效 wire（共享前缀 + 空后缀）供渲染投影，不存储行。
- Nested：parent 可为分支，但锚点必须取自父分支自有后缀，因此 nested 分支必含父分支经所选锚点的自有路由；sibling：同 parent 下多分支互不锁定，后缀独立；post-anchor main 行保持可变（它们不在任何后代前缀中）。
- 重命名仅改名；删除见 BRANCH-6。

---

## 7A. 移至新建分支（Move Selected Turns to New Child Branch，BRANCH-2/5/7/9/12 bounded 扩展）

目的特定 Main 权威原子命令 `moveSelectedTurnsToNewBranch`（UI：“移至新建分支”），将源路由自有的连续整 turn 迁移至新建子分支。示例：源路由 `A-B-C-D`（`B,C` 被选中）→ 父保留 `A-D`（`D` 为源自有后缀续接），新子分支有效路由 `A-B-C`（`A` 为只读祖先引用，`B,C` 转为新分支自有）。

- **源与目标**：同一逻辑 topic 内；源路由可为 main 或既有分支，但所选消息须全体 source-owned（无 inherited refs）；迁移后 `owner` 转至新分支，稳定 ID、同 topic，块/文件引用/`askId`/内容保留，不做 clone/COW（BRANCH-1 保留）。
- **前驱要求**：预选前驱（所选连续 turn 紧邻的前一条消息）必须存在且源路由自有；新分支 `anchorMessageId` = 该不可变前驱。首 turn（无前驱）禁用。
- **选择形态**：仅连续整 turn；非连续、空/未解析、含非自有行的选择禁用/拒绝（Renderer 禁用零调用，Main 同一根事务重验拒绝零写）。选择以整 turn 组 ID 表达，由 Main 展开为消息集合，不接受任意 per-message rehome。
- **部分加载零隐式迁移（expected closure fail-closed）**：Renderer 必须随请求传递显示顺序的显式 `expectedSelectedMessageIds`（稳定 IDs）；Main 从 COMPLETE 权威有效路由展开所请求的 turn 组 IDs 得完整闭包，与显式期望做精确列表/顺序比较；任何裁剪/孤儿/不完整 turn 或组成员变化在写前整批拒绝零写。部分加载 turn 的选择不得隐式迁移未见消息。
- **身份保留**：保留的是消息/blocks/files 的稳定身份与引用关系（稳定 ID、同 topic，块/文件引用/`askId`/内容保留），不做 clone/COW；同步语义由 §14 与 Sync ADR 治理（`v5` single-compound move syncable）。
- **既有分支保护**：所选 ID 中含任一既有 topic 分支锚点即整批拒绝零写；不得 reparent/delete/clamp 既有分支（BRANCH-5 自动修复禁令不受影响）。
- **原子性**：同一根事务原子提交分支元数据 + 消息 owners + 排序；失败零部分写。Segment：完整落入迁移集的 segment 原样保留；横跨所选/非所选边界的既有 segment fail-closed（不新增 split 策略）。
- **分支元数据/capability 刷新**：创建后刷新分支目录与受影响路由 capability；新分支上下文锚点继承与视口规则沿用既有治理（BRANCH-8；context-window ADR 与 viewport ADR），本文档不重定义。
- **非目标**：不设通用 owner 转移 API（仅本 §7A 目的特定迁移）；普通身份字段 patch 仍禁止。

---

## 8. 全部 Mutation 权限（BRANCH-4，Owner Equality Only）

| 路径 | 实际写目标 | 权限判定 |
|---|---|---|
| `updateMessage` / `updateMessageAndBlocks`（content/blocks） | 指定 message + 指定 blocks（经父 message） | 每目标 `owner == addressed route`；missing 保持 no-op；跨 topic fail-closed |
| `updateBlocks` / `updateSingleBlock` / `bulkAddBlocks` / `deleteBlocks` | 父 message（经 block） | 父 owner == route（无 topic 通道时按父的 `(topicId, branchId)` 解析）；missing no-op；非 owner fail-closed |
| `deleteMessage` / `deleteMessages` / `deleteMessagesWithSegments` | 列出的 messages | 全体目标 owner match，先验证后删，失败零部分写；missing no-op（单条）/按 guard 语义；非 owner fail-closed |
| `reorderMessages` | 列出的 messages（owner 序列） | 全体 owner match；后代观察蝴蝶效应，不阻断 owner |
| `selectAnswerMessage` / `selectUsefulAnswer` / `reorderAnswerGroup` | 实际写的 assistant 成员（整组原子） | 整组 assistant 成员 owner match；读取 user root 不要求可变；任一非 owner 整批拒绝、无部分写 |
| `insertMessagesAfterAnchor`（含 append） | 新行（owned 后缀）+ 被 patch 的既有行 | 新行按 route stamping 落后缀；既有行按单行 owner 判权； genuinely new suffix 永不要求既有组可变；自有锚点走组尾，分支上继承锚点仅当 ID 恰好等于被寻址分支不可变 `anchorMessageId` 时允许并落自有后缀起始（fork 边界例外），更老祖先引用以 `VALIDATION_ERROR` 拒绝零写 |
| `cloneMessagesToTopic` / `pasteMessagesToTopic` | 新行 + 被 patch 的既有行 | 新行落目标 route；既有行 owner 判权；跨 topic 冲突 fail-closed |
| `upsertSegment` / `replaceSegmentMembership` | segment 行（成员为引用） | 每成员 `owner == addressed route`（non-owner 拒绝，含祖先引用）；owned 行即使被后代引用仍可 segment；原子替换 |
| `resendUserMessages` | 实际 reset 的 assistants + 新建成员 | user root 仅要求在有效路由可读（不要求可变）；每个实际 reset 的 assistant 须 owned；非 owned 整批拒绝；新建落 owned 后缀 |
| `regenerateAssistantMessage` | 选中的 assistant | 选中须 owned；user root 仅要求存在可读 |
| `resetMessagesCoreInTx`（共享 core） | reset entries + 待删 blocks | candidate messages owner match（missing = 新后缀，允许）；blocks 经父 owner 判权 |
| `moveSelectedTurnsToNewBranch`（移至新建分支，§7A） | 所选连续整 turn 消息（展开后全体）+ 新分支行 | 全体所选须 source-owned 且连续整 turn；前驱存在且 source-owned（新 anchor）；所选含任一既有分支锚点整批拒绝零写；同一根事务原子提交分支元数据 + owners + 排序；段内完整 segment 保留，跨边界 segment fail-closed；源可为 main/既有分支，无 inherited refs |
| `deleteMessagesWithDependents`（语义删除） | roots + 展开的 dependents | 每 root 须 owned；user 展开覆盖非 owned assistant 则整批拒绝；展开后全体 owned 方可删；原子快照 + 删除 |
| streaming/translation blocks | 父 message | 父 owned 即可写；owner 可在有 live 后代时继续写（旧 translation lock 已移除） |

所有路径保留：owner/topic/route validation、有效路由 membership、事务原子性、identity-field stripping。`branchId = null` 寻址 main 路由；未知/跨 topic/trashed fail-closed。

---

## 9. 蝴蝶效应与缺 Anchor（BRANCH-5）

- 内容/blocks 更新：owner 写唯一实体，所有引用 route 同稳定 ID 立即可见。
- 删除前缀行：后代有效路由自然缩短（前缀变短），不级联删后代分支行。
- 重排 owner 序列：所有引用该 owner 序列的后代有效路由自然变化。
- 删除某 branch anchor（owner 删 anchor 行）：依赖该 anchor 的后代 route 保持 branch metadata，但解析 fail-closed（`NOT_FOUND`/missing anchor），不自动删除分支行，不 clamp 到前驱，不复制快照，不自动转移 owner（§7A 显式迁移除外）。
- 禁止：暗中修复、clamp、复制、快照、自动转移 owner、级联删后代、重新收缩 owner 权限。§7A 显式授权迁移是唯一的 owner 变更路径，同样不得 reparent/delete/clamp 既有分支。

---

## 10. 删除 Subtree（BRANCH-6）

删除 branch = 删除该分支 + 所有后代分支行 + 仅属于这些分支 ID 的 messages/blocks/file refs。祖先引用与 sibling 子树保留。删除最后一个分支后 topic 与从未分支不可区分。Local-only：无 sync intent，不碰 main frames。

---

## 11. Capability 与 Renderer Fail-Closed（BRANCH-9）

- Main 随每次窗口响应发布 `mutableMessageIds`：该窗口 messages 中 `branchId == addressed route` 的精确集合。即使被后代引用，owned 行仍在集合中；后代窗口不含祖先 refs（它们 `branchId != route`）。
- Renderer 只消费 Main capability：`isMutableForActiveRoute` 要求 `mutableRoute == activeRoute`、ID 在 `mutableIds` 且在 loaded 投影中；未知/过期/路由不匹配/非 resident 一律不可变（隐藏/禁用/零调用）。
- Bounded 创建动作门禁（Main 守卫之外的 Renderer 预检）：true-branch 仅在自有（owned/mutable）assistant 消息上可见，任何继承消息（含 fork 锚点自身）隐藏；insert 仅在自有 assistant 消息与恰好等于活跃分支 `anchorMessageId` 的 fork 锚点上可见，继承链上更老引用隐藏；活跃分支在 catalog 中未知/过期/缺失时两者均隐藏且零调用。窗口外锚点不做本地投影门禁，由 Main 同一事务最终裁决。`mutableMessageIds` 永不替代 Main 守卫。
- “移至新建分支”门禁（Renderer 预检 + Main 同一根事务重验）：所选须为源路由自有的连续整 turn 且前驱存在自有；首 turn/非连续/空/未解析/含非自有/含任一既有分支锚点禁用；catalog/route unknown-stale 或 capability unknown/stale 时禁用零调用；loaded-only 投影永不用作完备权威，选择合法性以 Main 权威事务为准。
- 回答组/选集预检只覆盖 loaded 可解析成员；窗口外/依赖展开成员由 Main 同一事务最终裁决。

---

## 12. 回答组/Segment/批量的实际写目标与原子性（BRANCH-12）

- 回答组变更分两类执行：选择/重排/useful/append 是组级原子（同一 Main 事务验证全体实际写成员 owned，任一非 owner 整批拒绝）；retry-all/批量重生成逐项经 Main 守卫、首败停止，不声称跨项原子。
- Segment 写是 segment 级原子；成员 owner 判权如 §8；空成员删除按 repository 语义。
- 批量删除/语义删除是命令级原子：先验证全体实际目标 owned，再写，失败零部分写；undo 快照来自权威行/块/segments，不来自渲染条目。
- 迁移原子（§7A）：分支元数据 + 消息 owners + 排序同一根事务提交，失败零部分写；整 turn 组 ID 由 Main 展开；完整落入迁移集的 segment 原样保留，横跨所选/非所选边界的既有 segment 整批拒绝（不新增 split 策略）。
- 仅创建新私有后缀且不改变既有回答组的 assistant insert 保持原语义；只读 copy/export/命名/活跃度不受限。

---

## 13. 上下文窗口关系（BRANCH-8）

- 上下文算法 branch-neutral：只关注当前 route 的 effective message sequence 与稳定 IDs，按整 turn 选取 anchor-to-end，不判定 ownership/permission。
- 每 route 独立 anchor/state：`routeKey = topicId`（main）与 `topicId:branchId`（分支）严格隔离、互不写入；不同分支可有不同窗口。
- Branch anchor（fork 消息）与 context-window anchor（起始 turn 的 group key）严格区分：前者定义路由构成，后者定义上下文窗口起点。分支继承映射（父锚点索引 → 新分支）不使用 `contextCount` 重算；`contextCount` 变更永不移动既有锚点。
- Context capability（`context-closure` 等）永不作为 mutation permission；需要分支 capability 的地方链接本文档，不复制决策表。
- **视口归属**：路由切换时的稳定视口归属、恢复意图/所有权生命周期与揭示守卫由 [Route Viewport Position](./route-viewport-position.md)（VIEWPORT-1…VIEWPORT-12）治理；路由切换永不改变 topic 身份（BRANCH-2/11），视口快照按路由键隔离——本文档不定义视口语义。§7A 新分支沿用既有“分支继承映射 + 路由键隔离”规则，不重定义。

---

## 14. 同步/导出/导入边界（Sync/Export/Import Boundary）

- True branches — history `v1`/`v2` `local-only / excluded from sync` (分支行、分支-owned 消息/块/操作永不进 `v1`/`v2` `sync outbox`/`membership`/`frame clocks`/`baseline`) is now **superseded**; per `2026-10-02` authorization `v3`/`v5` are **syncable** (`topic-message-stable-block-order-branch-v3` / `topic-message-stable-block-order-branch-assistant-attachment-v5` at `sync-baseline-wire-v3`/`v5`) with `BRANCH-1`–`BRANCH-9`/`BRANCH-11`–`BRANCH-12` unchanged. **`v5` with `branchSuffix` frames (`018_branch_sync_frames`) is now implemented with limited validation and final gate verified for 本次实现的代码状态 on 2026-10-03 — production baseline `sync-baseline-wire-v5` includes branch ancestry + branch-owned messages/blocks with single-entity/owner/reference/immutable-anchor/butterfly/subtree-delete preserved (`018` `branchSuffix` kind, per-channel `topicMessage`/`messageBlock`/`branchSuffix` LWW, missing-anchor fail-closed) and is covered by `projectLocalBaselineToWirePayloadV5`/`mergeValidatedBaselineInTx`; history `v1`/`v2` local-only remains locked history, not silently rewritten (see `docs/work/multi-device-sync.md` §§3/7 — limited validation, not production-ready; final gate verified 2026-10-03).** **§7A 迁移同样 `v5`-syncable（`2026-10-04` user-authorized current-development amendment, no `v6`）**：`moveSelectedTurnsToNewBranch` 经目的特定单复合 `move_turns_to_branch` 操作同步（同 topic 稳定 ID、分支创建 + 所有权/成员时钟迁移 + 新旧 owner 帧同 Tx 原子捕获，无 sibling；普通 upsert 永不转移 owner 且按字段时钟合并内容；迁移时钟 timestamp-then-operationId LWW，同 ts 不同 id 为有序竞争、完全相同时钟分歧 fail-closed；删除/tombstone 整 op 胜出；跨 topic/锚点/缺锚/帧 fixed-point 违例整 op 回滚），增量与 cursor-`0` `v5` 基线接收方（含已同步 ID）收敛一致——收敛语义由 `SYNC-DATA-062`/`SYNC-CC-028` 治理，`BRANCH-1`–`BRANCH-9`/`BRANCH-11`–`BRANCH-12` 不变。目标收敛语义由 Sync ADR 治理，本文档不定义基线/操作日志/帧合并/水位。 Scope authorization (`BRANCH-10` superseded to syncable) is product meaning only; it must not be read as permission for historical old-wire mutable-keys or invented disabled-sync DTOs.
- `branchMessagesToTopic` 跨-topic 前缀克隆（fresh IDs）是兼容/导出形态，不是 true branch；本任务不重命名 API，但调用方不得将其当作 true-branch 权限语义。
- 导出/知识/剪贴板组装/命名/活跃度是调用者本地读取（`whole-topic`/`naming-context`/`topic-activity`），消费后丢弃；剪切的删除另经权威删除路径。
- L2 ZIP 导入管线与 SQLite schema/迁移由 SQLite migration governance 治理；本语义不需要 migration（`branch_id`/ancestry 存储不变）。

---

## 15. 测试与证据契约（Test/Evidence Contract）

- **Main owner-only**：main owner 行被 live child/grandchild 引用时，main 可 update content/blocks/delete/reorder；child 对同 ID mutation 拒绝；内容更新在 child 有效路由同稳定 ID 可见；删除普通前缀后 child 路由自然缩短；重排后 child 有效前缀自然变化；删除 child anchor 后 child/grandchild 路由明确 NOT_FOUND/fail-closed，branch metadata 不自动删除。
- **Branch owner**：branch-owned suffix 被 nested descendant 引用时 owner branch 同样可 mutation，descendant 不可。
- **Bounded 插入**：分支上自有锚点组尾插入成功；ID 恰好等于分支 `anchorMessageId` 的 fork 边界继承插入成功（盖章当前分支自有、落自有后缀起始、before 为 fork 锚点）；更老祖先引用插入以 `VALIDATION_ERROR` 拒绝且零写（有效路由与 capability 不变）。
- **Bounded 分支创建**：非 main 父以继承引用（含父自身 fork 锚点）创建子分支拒绝（`VALIDATION_ERROR`、零分支行）；以父自有后缀锚点创建成功且新路由含父自有前缀；main 父仍接受 main 自有消息。
- **Window capability**：owner route 包含窗口内全部 owned IDs（即使被后代引用）；descendant window 只含 descendant-owned suffix，不含 ancestor refs.
- **复合路径**：answer-group/segment/resend/regenerate/批量按实际写目标判定；保留非 owner 拒绝与原子性；ancestor root 只读引用不得阻断 branch-owned targets，但永不授权插入/分支锚点（BRANCH-3/7 bounded 例外除外）。
- **Renderer**：main owner 共享可见消息有 mutation UI；child ancestor ref 无 mutation UI；true-branch 在任何继承消息上隐藏（含 fork 锚点），insert 仅在自有消息与精确 fork 锚点上可见；unknown/stale/missing 分支元数据隐藏 true-branch/insert 且零调用；unknown/stale capability 仍 fail-closed.
- **迁移（§7A 持久化新行为合同）**：源 `A-B-C-D` 选 `B,C` 迁移后父有效路由为 `A-D`、子有效路由为 `A-B-C`（`A` 只读引用，`B,C` 新分支自有，稳定 ID、同 topic）；前驱缺失/非连续/空/未解析/含非自有/含任一既有分支锚点整批拒绝零写；整 turn 组 ID 由 Main 从 COMPLETE 权威有效路由展开，与显式 `expectedSelectedMessageIds`（显示顺序）精确列表/顺序比较，不一致（含裁剪/孤儿/不完整 turn、组成员变化）写前整批拒绝零写，部分加载 turn 不得隐式迁移未见消息；段内完整 segment 保留、跨边界 segment 拒绝；分支元数据 + owners + 排序同一根事务原子；Renderer 在无前驱/含分支锚点/catalog-route unknown-stale/capability unknown-stale 时禁用零调用。合同级回归以 Playwright E2E 为准（迁移场景），隔离逻辑以 Vitest 为先；实现验证证据归验证报告，本文档不预断结果。
- **迁移同步（§7A `v5` single-compound，`SYNC-DATA-062`）**：同 ID main/branch 迁移捕获 + 原子远端应用 + cursor-`0` `v5` 基线落至旧 owner 对端（稠密帧/幂等重放/移动中编辑/竞争迁移与删除/tombstone 胜出/失败回滚）以 Main SQLite 真实测试为准（`syncMoveOwnershipTransfer`），覆盖 applied/ignored 与 cursor/outbox 真值；已同步既有 ID 迁移 UI/IPC + 对端有效分支路由/可变 ID、无复制、重启保留以 Playwright E2E 为准（`branch-sync` 迁移场景，2026-10-04 final gate 已验证）。
- **证据层级**：按 `AGENTS.md` 路由；跨组件/IPC/持久化行为以 Playwright E2E 为合同级回归，隔离逻辑以 Vitest 为先；`pnpm ui:observe` 仅诊断。

---

## 16. 非目标（Non-goals）

- 不定义应用身份、兼容性标识、发布/更新、平台范围——由 [Application Identity ADR](./cherry-chat-application-identity.md) 治理。
- 不定义 SQLite schema、迁移 mechanics、L2 ZIP 导入管线——由 [SQLite migration governance](../archived/sqlite-migration.md) 治理。
- 不定义上下文锚点的详细有效性/默认/继承/修复策略——由 [Context window governance](./context-window.md) 治理。
- 不定义同步收敛（基线/操作日志/帧合并/水位）——现状由 [Personal Multi-Device Sync](../work/multi-device-sync.md) 治理，目标由 [Sync Connection & Channel ADR](./sync-connection-channel.md) 与 [Sync Data Convergence ADR](./sync-data-convergence.md) 治理。
- 不重复实现位置与调用链细节（见 `AGENTS.md` 与 `docs/architecture/architecture.md`）；不引入性能阈值、基线或容量策略。
- 不做通用 owner 转移 API（仅 §7A 目的特定迁移）；不为迁移新增 split 策略或重定义上下文继承/视口语义。

---

## 17. 验收标准（Acceptance Criteria）

- **AC-1**：本文档完整覆盖 BRANCH-1…BRANCH-12 决策表（含 §7A bounded 迁移扩展）、术语（§2）、权威模型（§4）、实体/owner/引用（§5）、递归算法（§6）、anchor/创建/迁移（§7/§7A）、全部 mutation 权限表（§8）、蝴蝶效应与缺 anchor（§9）、删除（§10）、capability（§11）、复合原子性（§12）、上下文关系（§13）、同步/导出/导入边界（§14）、测试契约（§15）、非目标（§16）。
- **AC-2**：全文内部一致——同一 topic 同一消息只有一个权威实体（无 clone/COW）；当前路由只能 mutation owned 行，owner 权限永不因后代引用收缩，自动 owner 转移永禁、仅 §7A 显式授权迁移可变更 owner；祖先引用对插入/子分支创建只读，唯一例外是分支上 ID 恰好等于该分支 `anchorMessageId` 的 fork 边界插入；迁移要求源自有连续整 turn + 前驱存在自有 + 新 anchor 不可变，所选含任一既有分支锚点整批拒绝且不 reparent/delete/clamp 既有分支；迁移展开闭包须与显式 `expectedSelectedMessageIds` 精确一致，部分加载 turn 不得隐式迁移未见消息；`mutableMessageIds` 为窗口 owned 精确子集，loaded-only 投影永不用作完备权威；缺 anchor 明确 NOT_FOUND；branch anchor 与 context anchor 严格区分；`branchMessagesToTopic` 明确不是 true branch；无 branch-from-any-ancestor / insert-after-any-ancestor 授权残留，无通用 owner 转移 API。
- **AC-3**：`docs/adr/projection-completeness-authority.md` 已迁出 PROJ-13…PROJ-16 并链接本文档，无悬空编号与旧语义，且直接冲突的分支/插入行已收敛到本文档 bounded 语义；本次若无直接矛盾行则不改动该文档；`docs/adr/context-window.md` 仅有必要澄清/链接（本次不改）；`docs/architecture/architecture.md` 与 `AGENTS.md` 本次不改（仅高价值链接原则保留），无决策表复制；`CLAUDE.md` 仍为符号链接；`jorkey/feat/multi-device-sync` untouched。
- **AC-4**：目标命令 `moveSelectedTurnsToNewBranch` 按 §7A/§8/§11/§12 实施（源自有连续整 turn、前驱 anchor immutable、含分支锚点拒绝、分支元数据 + owners + 排序同一根事务原子、段内 segment 保留/跨边界拒绝、Renderer 禁用零调用 + Main 重验、local-only），既有 owner-only + bounded（保护集与 descendant 守卫移除，capability 为 owned 精确子集；插入限自有 + 唯一 fork 边界例外；分支创建限父自有）保持，无 schema migration。代码完成状态以并行代码 agent 交付与验证报告为准，本文档不声称代码已完成。
- **AC-5**：实现验证证据归验证报告（Focused Vitest + 合同级 Playwright E2E）；本文档仅定义合同，不预断通过结果。
