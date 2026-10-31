# 话题分支与引用 — 权威规范

> **文档状态**：Authoritative（权威规范；描述已实现的 durable 语义，并为正在实现的目标语义确立边界）。本文档统一定义话题内分支与跨话题引用的实体、所属、路由、权限与原子性：实体唯一、所属永久、引用只读、owner 完整控制、蝴蝶效应与继承边界前移、Main 权威与 Renderer fail-closed、复合变更的实际写目标与原子性、上下文窗口关系、同步与持久化边界。话题内分支（§5）以继承边界锚点在话题内分叉，并定义目的特定迁移（`moveSelectedTurnsToNewBranch`，“移至新建分支”）与 subtree 删除；跨话题引用（§6）由话题菜单“引用”子菜单创建，历史为经被点击消息捕获的活引用。两域共用同一套实体、路由与权限机制，不建平行子系统。
> **决策锁**：BRANCH-1 … BRANCH-13（§3 决策索引，durable decision IDs；迁移语义为既有 ID 的 bounded 扩展，跨话题引用为 BRANCH-13 bounded 新 ID，不使用会话 LOCK ID）。
> **最后更新**：2026-10-31
> **Owner**：Personal fork（jorkeyliu）
> **关联**：`AGENTS.md` 与 `docs/architecture/architecture.md` 链接本文档而非复制其决策表；其余治理域（应用身份、SQLite 聊天权威与 L2 导入、上下文锚点、投影完备性、视口、同步）的边界与链接集中见 §9。
> **决策状态与实现状态**：BRANCH-1…BRANCH-13 全部 **Locked**——表示治理决策已确定，**不代表已实现或已验证**。除话题内分支的既有 durable 语义外，“移至新建分支”（§5.3）与跨话题引用（§6）是正在实现中的目标语义；本文档只定义合同，不声称代码已完成，也不声称任何测试已通过（验证证据归验证报告）。跨话题引用的持久化与单话题导出/导入、整库备份语义见 §7 唯一定义。已取消的 merge/sync 支持不在本文档范围，分支与引用维持 local-only。

---

## 1. 范围与背景

窗口化读取与分支路由落地后，同一逻辑话题内出现两种易混语义：渲染投影的完备性（哪部分已加载）与分支路由的变更权限（哪一行可经哪条路由变更）。旧权限模型以私有且不可共享、共享前缀语义与活后代保护集（`collectProtectedMessageIdsInTx`、`assertNoLiveDescendantIncludesInTx`）收缩 owner 权限：owner 行一旦被后代引用即不可变。这与“同一逻辑话题内每条消息只有一个权威实体”的直觉冲突——owner 无法编辑被引用的行、上下文锚点与分支锚点混淆、`mutableMessageIds` 排除被引用的 owned 行、回答组/segment/重发因只读引用被误阻断。

本文档以 BRANCH-1…BRANCH-13 确立分支与引用模型：**实体唯一、所属永久、引用只读、owner 完整控制、蝴蝶效应自然发生、继承边界随锚点删除前移**。分支创建收缩的是“后代路由的可写集合”（后代只能写自己的后缀），而不是 owner 的权限；分支删除恢复的是“路由可见性”，而不是 owner 的可变性。

话题内分支以继承边界锚点在话题内分叉，后代有效路由经祖先前缀加自有后缀合成，并提供目的特定迁移与 subtree 删除。跨话题引用由话题菜单“引用”子菜单创建：新建一个独立逻辑话题，其历史是经被点击消息捕获的活引用——引用前缀只读、目标自有后缀可写，不复制源消息/块/文件；同菜单“复制”子菜单维持既有 fresh-ID 跨话题复制不变。

§2 术语、§3 决策索引之后，§4 定义两域共同遵循的权威模型，§5/§6 分别定义话题内分支与跨话题引用的创建与生命周期，§7 为共同边界，§8 为验证与验收，§9 为非目标与治理边界。

---

## 2. 术语

| 术语 | 标识符 | 定义 |
|---|---|---|
| 逻辑话题 | logical topic | 侧边栏的唯一话题身份；路由切换永不改变话题身份 |
| 消息实体 | message entity | SQLite `messages` 的一行；同一逻辑话题内每条消息只有一个权威实体与稳定 ID |
| 路由/有效路由 | route / effective route | 一次权威读写所寻址的逻辑话题内分支：`branchId` 缺席/null 为 main 路由，非空为该分支的有效路由（祖先前缀加自有后缀，稳定 ID 共享、无前缀复制），见 §4.3 |
| 所有者 | owner | 消息的永久所属：`(topicId, branchId)` 二元组；相等性判定同时比较 `topicId` 与 `branchId`（`branchId null` = 该话题 main 路由），见 §4.2 |
| 祖先引用 | ancestor reference | 后代有效路由中来自祖先路由的消息行；仅作构成完整会话与上下文的只读引用，不转移所属权，见 §4.4 |
| 分支锚点 | branch anchor | 分支的继承边界：创建时指定的父有效路由内消息（`anchorMessageId`）；创建后仅由 Main 在该消息被删除时前移到父路由中其之前的最近存活消息，见 §4.5、§5.1 |
| 继承边界 | inheritance boundary | 子路由继承父路由历史的终止点（anchor-inclusive）：锚点存活即该锚点；锚点被删除则为其之前的最近存活消息；无存活前驱则继承历史为空而分支及其自有消息保持可读写，见 §4.3、§4.5 |
| 上下文锚点 | context-window anchor | 每路由独立的稳定上下文起点（`contextWindowAnchor[routeKey]`，起始 turn 的 group key）；与分支锚点严格区分，见 §4.7 |
| 有效前缀 | effective prefix | 后代有效路由中来自祖先的部分（含锚点）；删除/重排 owner 行会自然改变后代前缀 |
| 自有后缀 | owned suffix | 有效路由中属于当前分支/当前话题的行；当前路由只能变更这部分 |
| 缺 anchor | missing anchor | 分支链上某分支锚点已不在父有效路由中；路由不 fail-closed，而是继承到其之前的最近存活消息，无可推导前驱时继承历史为空，见 §4.3、§4.5 |
| 可变消息集 | mutableMessageIds | Main 随每次窗口响应发布的权威能力：该响应窗口 messages 中 `topicId == addressed topic` **且** `branchId == addressed route` 的精确子集，见 §4.8 |
| 实际写目标 | actual mutation target | 一条命令实际写/删/重排的消息行；只读引用（user root 读取、组成员读取、segment 成员引用解析）不构成变更，见 §4.6 |
| 跨话题复制 | cross-topic copy | `branchMessagesToTopic` 的跨话题前缀复制（fresh IDs）；不是话题内分支，“复制”子菜单即此语义，见 §7 |
| 跨话题引用 | cross-topic reference | “引用”子菜单创建的目标逻辑话题：其历史为经被点击消息捕获的活引用——引用源关系 `(sourceTopicId, sourceBranchId, anchorMessageId)`；源消息/块/文件不复制，目标自有后缀可写、引用前缀只读，见 §6 |
| 引用源 | reference source | 被引用的源话题（`sourceTopicId`）及其被捕获的源分支（`sourceBranchId`，`null` = 源 main 路由）与端点消息（`anchorMessageId`） |
| 引用端点 | reference endpoint | 引用冻结的 `(sourceTopicId, sourceBranchId, anchorMessageId)`；端点消息被删除时按 §4.5 同一继承边界规则前移；导航跳转到源话题 + 捕获源分支 + 当前边界消息 |
| 引用前缀 | referenced prefix | 目标话题 main 路由中来自引用源在端点处有效路由的只读部分；端点删除时前缀缩短，源删除时前缀缺席（均不级联） |
| 引文分隔线 | reference divider | 目标话题中渲染的分隔条 `历史消息引用自：[话题名]`，话题名为**实时**源话题标题；源不存在时显示 `历史消息引用不存在` |
| 引用缺失 | missing reference | 源话题已删除/软删除、源分支已删除、或端点已无任何可继承的存活前驱；引用前缀缺席但目标话题与自有后缀保留；端点恢复且完整则前缀重新可用 |
| 所有权迁移 | ownership move | 目的特定 Main 权威命令 `moveSelectedTurnsToNewBranch`（“移至新建分支”）；语义见 §5.3 |
| 连续整 turn 选择 | continuous full-turn selection | 迁移的唯一合法选择形态：按整 turn（含 user 根与所属 assistant 整组）连续选取的源路由自有消息集合；Main 按整 turn 组 ID 展开，不接受任意 per-message rehome |

旧权限模型的私有/共享前缀不可变/后代锁定 owner 等标识不再是权限模型；仅“有效前缀/自有后缀”作为路由构成描述保留，不携带权限含义。

---

## 3. 决策索引

BRANCH-1…BRANCH-13 为本文档 durable decision IDs，全部 **Locked**。下表给出简明决策与其权威细节位置；完整定义在各节正文，不在表中重述。

| # | 决策 | 权威细节 |
|---|---|---|
| **BRANCH-1** | **消息实体唯一**：同一逻辑话题内每条消息只有一个权威实体与稳定 ID；话题内分支不复制、不覆盖、不创建投影、不做 COW，有效路由共享稳定 ID 且无前缀复制 | §4.2 |
| **BRANCH-2** | **永久所属（唯一显式迁移例外）**：消息在哪个 `(topicId, route)` 创建即永久属于该处，owner 相等性同时比较 `topicId` 与 `branchId`；唯一例外是目的特定迁移 `moveSelectedTurnsToNewBranch` | §4.2、§5.3 |
| **BRANCH-3** | **引用只读**：当前路由只能变更自己拥有的消息；祖先消息在后代路由中仅作只读引用，插入/子分支创建的唯一例外见 §4.4 | §4.4 |
| **BRANCH-4** | **Owner 完整控制**：后代是否引用、引用数量、是否位于后代有效前缀都不得收缩 owner 的变更权限；一律只按实际写目标 owner 判权，非 owner fail-closed | §4.4、§4.6 |
| **BRANCH-5** | **蝴蝶效应与继承边界前移**：owner 改动被所有引用路由即时可见；删/排前缀影响所有后代；删分支锚点时边界按同一事务前移到父路由中其之前的最近存活消息（单条与批量一致），无存活前驱则继承历史为空而分支与自有消息保持可读写；禁止复制快照、暗用父路由末条作前驱、引入分叉点之后历史、自动转移 owner、级联删后代、重收缩 owner 权限 | §4.5 |
| **BRANCH-6** | **分支删除即 subtree 删除**：删除分支连同其整个 descendant subtree（分支行与仅属这些分支的 messages/blocks/file refs），祖先引用与 sibling 保留；仅限同一逻辑话题 | §5.2 |
| **BRANCH-7** | **分支创建 owner-only；锚点仅由 Main 前移**：锚点必须父路由自有（owner 相等性同时比较 `topicId` 与 `branchId`），任何继承引用或外来源行一律拒绝 fail-closed；nested 必含父分支自有路由，sibling 互不锁定；创建仅插入一行 `topic_branches` | §5.1 |
| **BRANCH-8** | **上下文窗口关系**：上下文算法 branch-neutral、不参与 ownership；每路由独立 context-window anchor/state，与分支锚点严格区分；route-scoped key（main `topicId`，分支 `topicId:branchId`）保留；context capability 永不作为变更权限 | §4.7 |
| **BRANCH-9** | **Main 权威与 Renderer fail-closed**：Main SQLite（含 `mutableMessageIds` 发布者）为唯一权威；Renderer capability 仅预检，unknown/stale/route mismatch fail-closed；loaded-only 投影永不用作完备权威 | §4.1、§4.8 |
| **BRANCH-10** | **Local-only 与复制区分**：话题内分支、迁移与跨话题引用均 local-only、不进 sync（main 行保持 syncable）；`branchMessagesToTopic` fresh-ID 复制不是话题内分支（“复制”语义不变） | §7 |
| **BRANCH-11** | **有效路由递归算法**：anchor-inclusive 递归合成、稳定 ID、无复制，每层确定性 `sort_order ASC, id ASC`；有效路由基座为「前缀 + main 自有行」，普通话题前缀为空、引用目标前缀为其引用前缀；每层边界取「锚点存活即锚点，否则其之前最近存活消息，否则空继承」 | §4.3、§6 |
| **BRANCH-12** | **复合变更实际写目标与原子性**：answer-group、segment、批量/语义删除、resend/regenerate、reset-core 一律只验证实际写/删/重排目标的 owner；多目标须全体 owner match，先验证后写，失败零部分写（同一根事务）；回答组选择/重排/useful/append 组级原子，retry-all/批量重生成逐项、首败停止 | §4.6 |
| **BRANCH-13** | **跨话题引用（“引用”子菜单，bounded 扩展）**：目标逻辑话题新建一条引用源关系；引用前缀只读、目标自有后缀可写；复用既有路由/capability/权限机制，不建第二子系统；源删除/分支删除 → 前缀缺席但目标与后缀保留；端点删除 → 前缀按同一继承边界缩短；引用 local-only | §6 |

> 决策锁 ID 是编排内部协调令牌的产物语义表达：BRANCH-* 是本文档的 durable 决策 ID，不进入代码注释、配置或提交信息。

---

## 4. 权威模型

本节定义两域共同遵循的权威归属、实体与所属、路由解析、引用只读与 owner 控制、蝴蝶效应、变更权限与实际写目标、上下文关系与 capability 机制；§5/§6 在此基础上分别定义话题内分支与跨话题引用的创建与生命周期。

### 4.1 权威归属

- **Main SQLite 是唯一聊天权威**（含分支路由解析、顺序、回答组成员/顺序、变更作用域、Segment 目录、上下文闭包派生），也是变更权限的唯一权威（含 `mutableMessageIds` 发布者）。Renderer 永不持有 SQLite 连接，经类型化 IPC 访问；Renderer capability 仅预检。
- **Renderer 普通消息状态是已加载投影**（`loaded-projection`）；`window.api` 可达性不转移所有权；loaded-only 投影永不用作完备权威。
- **Preload 是唯一的 capability 门**；`packages/shared` 是跨进程契约，契约变更两侧协同。
- **aiCore 是 provider 请求策略与执行**，不决定分支权限。

### 4.2 实体、所有者与身份

（BRANCH-1/2）一条消息有且仅有一个 `(topicId, branchId)` owner（`branchId null` = main 路由），owner 相等性判定同时比较 `topicId` 与 `branchId`；消息在哪个 `(topic, route)` 创建就永久属于该处，分叉只建立祖先引用，不转移/分享/继承所属权。同一逻辑话题内每条消息只有一个权威实体与稳定 ID：话题内分支不复制、不覆盖、不创建投影、不做 COW，有效路由共享稳定 ID、无前缀复制。

`messages.branch_id` 是 ownership only；`topic_branches` 定义 ancestry（`parentBranchId`、`anchorMessageId`）。身份字段（`id`、`topicId`、`branchId`、`sortOrder`）永不经 patch 变更；Main 在写入时按 route 上下文 authoritative stamping（wire `branchId` 永不信任）。**唯一例外**是目的特定迁移 `moveSelectedTurnsToNewBranch`（§5.3）——它经 Main 权威命令变更所选消息 `branchId`；此外不存在通用 owner 转移 API。

后代有效路由中的祖先行是只读引用：可渲染、可组成上下文，不可经后代路由变更，不 COW；不可作为子分支锚点（§5.1 owner-only），仅可作为 §4.4 所述分叉边界例外中的插入锚点。

### 4.3 有效路由解析

（BRANCH-11）任一话题的有效路由基座为「前缀 + main 自有行」：普通话题前缀为空，引用目标话题前缀为其引用源前缀（语义见 §6）。分支在该基座之上按锚点切片递归合成：

```
effective(topic, null) = prefix(topic) + listByTopic(topic, null)
effective(topic, branch):
  path = branchPath(branch)  // root-first, cycle/depth-guarded
  leaf.topicId must == topic else NOT_FOUND
  eff = effective(topic, null)
  for node in path:
    idx = boundary(eff, node.anchorMessageId)
      // anchor 存活于 eff → 其位置
      // 否则 anchor 行仍存在 → 该段中其之前的最近存活消息（段首则取该段之前的继承尾）
      // 否则（行已不在）→ 无前驱，继承为空
    eff = (idx == -1 ? [] : eff[0..idx]) + listByTopic(topic, node.id)
  return eff
```

- Anchor-inclusive；稳定 ID 共享；无复制；每层确定性 `sort_order ASC, id ASC`。
- **分支锚点**缺失（owner 删除了锚点，或锚点不在父有效路由）不使路由失效：边界前移到锚点之前的最近存活消息，无可推导前驱时该层继承历史为空，而分支元数据与自有后缀照常解析（可读可写）。前驱只能来自原分叉点之前——父路由分叉点之后的任何行永不进入子路由；不得把父路由末条消息当作前驱、不得复制快照或暗修 owner。缺失引用源同样只省略前缀（§6）。
- **分叉分隔线（展示约定）**：话题内分支的分隔线表达**继承关系与分叉边界**，不以“存在 prefix 行”作为存在前提。Main 在只读派生中给出该分支的继承边界事实 `inheritedBoundary`：有存活前驱时是最后一条被继承消息（原分叉锚点，或锚点之前的最近存活消息），无继承历史时是**该父路由的历史头部**（`kind: 'head'`，不携带消息 ID——不得伪造占位消息）。Renderer 只据此放置：边界消息未加载（更老分页尚未加载）时分隔线留在窗口外，绝不因“窗口内找不到 anchor”而上浮到头部；头部边界仅在其父路由自身视图中置于历史头部，空子路由照常显示并可切换父/子/兄弟。分隔线的关系身份仍是 `anchorMessageId`，头部放置仅在展示属性上区分，永不作滚动/导航的消息目标（头部切换不发缺消息的 around 读取）。上下文窗口分隔线仍只依第一上下文消息（§4.7），不参与本约定。
- `forkBoundaryIndex = effective.length - ownedCount` 仅为构成描述，不携带权限；bounded 插入/分支权限由 §4.4/§5.1 定义，不由边界索引推导。

### 4.4 引用只读与 owner 完整控制

（BRANCH-3/4）当前路由只能变更自己拥有的消息；祖先消息在后代路由中仅作构成完整会话与上下文的只读引用。外来源前缀行（引用目标的引用前缀）属于源话题，对目标路由同样只读。

祖先/外来源引用对插入与子分支创建只读，唯一例外是**分叉边界**：在分支路由上，ID 恰好等于被寻址分支当前继承边界 `anchorMessageId` 的继承锚点（fork 边界/父引用终答）；在引用目标的 main 路由上，ID 恰好等于引用端点（引用锚点，或其所在回答组的组尾）。两类插入均把新行盖章为当前路由自有并落自有后缀起始；更老的祖先/外来源引用一律 fail-closed 零写（`VALIDATION_ERROR`）。`createBranch` 为 owner-only（§5.1）。

owner 完整控制：后代是否引用、引用数量、是否位于后代有效前缀，都不得收缩 owner 的变更权限——内容编辑、blocks、删除、批量删除、重排、回答组字段、segment 关系、resend/regenerate 等一律只按实际变更目标的 owner 判权，不得因 live descendants 拒绝 owner；非 owner 仍 fail-closed。跨实体命令只允许写/删/重排当前路由 owned 的实际目标；读取祖先引用本身不构成变更，但祖先引用永不构成插入/分支锚点授权（本段分叉边界例外与 §5.1 owner-only 除外）。事务原子性保留（§4.6）。

### 4.5 蝴蝶效应与继承边界前移

（BRANCH-5）owner 对唯一实体的内容/blocks 修改被所有引用路由以同稳定 ID 立即看到；删除前缀行使后代有效路由自然缩短，不级联删后代分支行；重排 owner 序列使所有引用该序列的后代有效路由自然变化。若 owner 删除某分支锚点（单条删除、批量删除或分支 subtree 删除同样适用），Main 在同一根事务内把该分支的边界前移到父有效路由中该锚点之前的最近存活消息，因此依赖该锚点的后代路由保持分支元数据并继续解析为缩短后的历史；若其前没有任何存活消息，则该层继承历史为空，分支与其自有消息仍可读写。批量删除时前驱计算跳过本批所有待删行，连续删除逐次前移；同一规则同样用于引用端点（§6）。

前移只能落在原分叉点之前的存活前驱上：不得使用父路由分叉点之后的任何行、不得用父路由“最后一条消息”投机取巧、不得复制快照、不得捏造已丢失的历史、不得自动转移 owner、不得级联删后代、不得重新收缩 owner 权限。**自动 owner 转移永禁**；仅 §5.3 显式授权的迁移可变更 owner，且同样不得 reparent/delete 既有分支（锚点删除引起的边界前移不受此限）。仅当锚点行已不存在而无法推导前驱的既有数据才落到空继承：这属于可访问的非阻断降级，不修复、不编造。

### 4.5.1 Undo/Redo 与继承边界回写（BRANCH-5U）

删除操作引起的边界前移（§4.5、§6 端点）是删除语义的一部分，因此 Undo 必须恢复“本次操作实际改变”的继承边界（分支锚点与引用端点），Redo 再次前移；普通同 ID 插入永不反向推断 Undo 意图。

- **值来源唯一**：只允许回写删除事务内采集的 `(kind, id, 删除前边界, 删除后边界)` 快照；Renderer 只搬运、不推导、不构造边界值。
- **同一根事务**：消息恢复与边界回写在 Main 的**同一次插入事务**内完成，不允许分步写（先消息后边界，或反之）。
- **比中即跳过**：请求必须同时满足——关系行仍存在、当前边界仍等于快照记录的删除后值、回写目标属于本命令实际插入的消息、关系所属话题（branch）或引用源话题（reference）等于本命令话题。任一不满足则跳过并报告原因（`missing` / `changed`，属既有响应语义而非错误），更新的状态胜出。
- **永久禁止**：不重建已删关系、不新建关系、不覆盖他人更新的边界、不自动转移 owner，也不提供通用的 branch/reference 写能力。
- **兼容**：无快照的历史 Undo action 与未携带回写请求的插入保持普通传输语义（无边界效果）；级联 subtree 删除与源消失时的引用 clone 保留行为不变。

### 4.6 全部变更权限与实际写目标

（BRANCH-4/12）下表给出各路径的实际写/删/重排目标及其权限判定；一律 `owner == addressed route`，`owner` 相等性同时比较 `topicId` 与 `branchId`，`branchId = null` 寻址 main 路由，未知/跨话题/trashed fail-closed。目的特定复合写（`moveSelectedTurnsToNewBranch` 见 §5.3，创建跨话题引用见 §6）只给指针、不在此复制规则。

| 路径 | 实际写目标 | 权限判定 |
|---|---|---|
| `updateMessage` / `updateMessageAndBlocks`（content/blocks） | 指定 message + 指定 blocks（经父 message） | 每目标 `owner == addressed route`；missing 保持 no-op；跨话题 fail-closed |
| `updateBlocks` / `updateSingleBlock` / `bulkAddBlocks` / `deleteBlocks` | 父 message（经 block） | 父 owner == route（无 topic 通道时按父的 `(topicId, branchId)` 解析）；missing no-op；非 owner fail-closed |
| `deleteMessage` / `deleteMessages` / `deleteMessagesWithSegments` | 列出的 messages | 全体目标 owner match，先验证后删，失败零部分写；missing no-op（单条）/按 guard 语义；非 owner fail-closed |
| `reorderMessages` | 列出的 messages（owner 序列） | 全体 owner match；后代观察蝴蝶效应，不阻断 owner |
| `selectAnswerMessage` / `selectUsefulAnswer` / `reorderAnswerGroup` | 实际写的 assistant 成员（整组原子） | 整组 assistant 成员 owner match；读取 user root 不要求可变；任一非 owner 整批拒绝、无部分写 |
| `insertMessagesAfterAnchor`（含 append） | 新行（owned 后缀）+ 被 patch 的既有行 | 新行按 route stamping 落后缀；既有行按单行 owner 判权；genuinely new suffix 永不要求既有组可变；自有锚点走组尾，分叉边界（§4.4 唯一例外：分支 `anchorMessageId` 或引用端点）允许并落自有后缀起始，更老祖先/外来源引用以 `VALIDATION_ERROR` 拒绝零写 |
| `cloneMessagesToTopic` / `pasteMessagesToTopic` | 新行 + 被 patch 的既有行 | 新行落目标 route；既有行 owner 判权；跨话题冲突 fail-closed |
| `upsertSegment` / `replaceSegmentMembership` | segment 行（成员为引用） | 每成员 `owner == addressed route`（non-owner 拒绝，含祖先引用）；owned 行即使被后代引用仍可 segment；原子替换 |
| `resendUserMessages` | 实际 reset 的 assistants + 新建成员 | user root 仅要求在有效路由可读（不要求可变）；每个实际 reset 的 assistant 须 owned；非 owned 整批拒绝；新建落 owned 后缀 |
| `regenerateAssistantMessage` | 选中的 assistant | 选中须 owned；user root 仅要求存在可读 |
| `resetMessagesCoreInTx`（共享 core） | reset entries + 待删 blocks | candidate messages owner match（missing = 新后缀，允许）；blocks 经父 owner 判权 |
| `deleteMessagesWithDependents`（语义删除） | roots + 展开的 dependents | 每 root 须 owned；user 展开覆盖非 owned assistant 则整批拒绝；展开后全体 owned 方可删；原子快照 + 删除 |
| streaming/translation blocks | 父 message | 父 owned 即可写；owner 可在有 live 后代时继续写（旧 translation lock 已移除） |
| `moveSelectedTurnsToNewBranch`（移至新建分支，§5.3） | 所选连续整 turn（展开后全体）+ 新分支行 | 见 §5.3（目的特定复合写：源自有连续整 turn，原子分支 + owners + 排序） |
| 创建跨话题引用（“引用”子菜单，§6） | 目标话题引用源关系行 + 目标后缀起始 | 见 §6（只读源操作；引用前缀只读 + 目标自有后缀可写） |

所有路径保留：owner/topic/route validation、有效路由 membership、事务原子性、identity-field stripping。**owner 相等性同时比较 `topicId` 与 `branchId`**——跨话题目标行（如引用前缀的源行）`topicId != addressed topic` 一律不可变更、fail-closed；引用前缀只读即由此保证。

**原子性**：

- **回答组变更**分两类执行：选择/重排/useful/append 为组级原子（同一 Main 事务验证全体实际写成员 owned，任一非 owner 整批拒绝，无部分写）；retry-all/批量重生成逐项经 Main 守卫、首败停止，不声称跨项原子。
- **Segment 写**为 segment 级原子；成员 owner 判权如本节表；空成员删除按 repository 语义。
- **批量删除/语义删除**为命令级原子：先验证全体实际目标 owned，再写，失败零部分写；撤销快照来自权威行/块/segments，不来自渲染条目。
- **迁移原子**（§5.3）：分支元数据 + 消息 owners + 排序同一根事务提交，失败零部分写。
- 仅创建新私有后缀且不改变既有回答组的 assistant 插入保持原语义；只读 copy/export/命名/活跃度不受限。

### 4.7 上下文窗口与视口归属

（BRANCH-8）上下文算法 branch-neutral：只关注当前路由的 effective message sequence 与稳定 IDs，按整 turn 选取 anchor-to-end，不判定 ownership/permission。每路由可有独立 context-window anchor/state：`routeKey = topicId`（main）与 `topicId:branchId`（分支）严格隔离、互不写入，不同分支可有不同窗口。分支锚点（fork 消息）与 context-window anchor（起始 turn 的 group key）严格区分：前者定义路由构成，后者定义窗口起点。

分支继承映射（父锚点索引 → 新分支；范围内按索引，clone 重映射 ID 但保留索引）仅在范围内不使用 `contextCount` 重算；缺失/无效/超出范围的非空新分支以当前 `contextCount` 在默认窗口位置建立（与 TokenCount 点击同位，`null` → 首 turn），永不钳制到末尾；空分支无锚点；`contextCount` 变更永不移动既有锚点。上下文锚点的有效性/默认/继承/修复策略由 Context window governance 治理（链接见 §9），本文档只定义分支与上下文的关系；context capability（`context-closure` 等）永不作为变更权限。

**视口归属**：聊天视口定位由 Chat Viewport Position 治理（VIEWPORT-1…VIEWPORT-16，链接见 §9）；路由切换永不改变话题身份，视口快照按路由键隔离。§5.3 新分支沿用既有“分支继承映射 + 路由键隔离”规则，本文档不重定义视口语义。

### 4.8 Capability 与 Renderer fail-closed

（BRANCH-9）Main 随每次窗口响应发布 `mutableMessageIds`：该响应窗口 messages 中 `topicId == addressed topic` **且** `message.branchId == addressed route` 的精确集合；即使被后代引用，owned 行仍在集合中；后代窗口不含祖先 refs，引用目标窗口不含外来源前缀行（它们 `topicId != addressed topic`）。Renderer 只消费 Main capability——`isMutableForActiveRoute` 要求 `mutableRoute == activeRoute`、ID 在 `mutableIds` 且在 loaded 投影中；未知/过期/路由不匹配/非 resident 一律不可变（隐藏/禁用/零调用），`mutableMessageIds` 永不替代 Main 守卫。

Bounded 插入门禁（Main 守卫之外的 Renderer 预检）：`insertMessagesAfterAnchor` 仅在自有 assistant 消息，以及 §4.4 分叉边界例外（恰好等于活跃分支 `anchorMessageId` 的 fork 锚点，或引用目标的引用端点）上可见；继承链上更老引用隐藏；活跃分支在 catalog 中未知/过期/缺失时隐藏且零调用。窗口外锚点不做本地投影门禁，由 Main 同一事务最终裁决。回答组/选集预检只覆盖 loaded 可解析成员，窗口外/依赖展开成员由 Main 同一事务最终裁决。

各创建路径的门禁分别在 §5.1（话题内分支）、§5.3（“移至新建分支”）、§6（跨话题引用）定义；三者一律遵循“Renderer 仅预检、Main 在同一根事务重验全部权威条件、loaded-only 投影永不用作完备权威”。

---

## 5. 话题内分支

### 5.1 分支锚点、创建、嵌套与同级

（BRANCH-7）锚点稳定性：分支行创建后 `parentBranchId` 永不变更；`anchorMessageId` 只能由 Main 在锚点消息被删除时按 §4.5 权威前移（不存在通用改锚点 API），除此以外不变；`name` 可改。创建验证（同一根事务）要求：逻辑话题存在且非 trash；父路由存在（`null` = main，否则为本话题分支）；锚点属于父有效路由 **且**由父路由自有——owner 相等性同时比较 `topicId` 与 `branchId`：main 父要求锚点 `(topicId == 本话题, branchId == null)`，分支父要求 `(topicId == 本话题, branchId == parentBranchId)`。任何继承引用（含父自身继承的 fork 锚点）或外来源行（`topicId != 本话题`，即使 `branchId == null`）一律以 `ChatDbValidationError` 拒绝、零写。创建效果为恰好插入一行 `topic_branches`（`id/topicId/parentBranchId/anchorMessageId/name`），无 sync intent；返回创建节点加有效 wire（有效前缀 + 空后缀）供渲染投影，不存储行。

Nested：父可为分支，但锚点必须取自父分支自有后缀，因此 nested 分支必含父分支经所选锚点的自有路由。Sibling：同 parent 下多分支互不锁定，后缀独立。post-anchor main 行保持可变（它们不在任何后代前缀中）。重命名仅改名，删除见 §5.2。

Renderer 门禁（§4.8）：话题内分支创建仅在自有（owned/mutable）assistant 消息上可见，任何继承消息（含 fork 锚点自身）隐藏；活跃分支在 catalog 中未知/过期/缺失时隐藏且零调用。

### 5.2 分支删除即 subtree 删除

（BRANCH-6）删除分支即删除该分支 + 所有后代分支行 + 仅属于这些分支 ID 的 messages/blocks/file refs；祖先引用与 sibling 子树保留；删除最后一个分支后话题与从未分支不可区分。Local-only：无 sync intent，不碰 main frames（§7）。该 subtree 语义仅限**同一逻辑话题内**。

### 5.3 移至新建分支

（BRANCH-2/5/7/9/12）目的特定 Main 权威原子命令 `moveSelectedTurnsToNewBranch`（UI：“移至新建分支”），将源路由自有的连续整 turn 迁移至新建子分支。示例：源路由 `A-B-C-D`（`B,C` 被选中）→ 父保留 `A-D`（`D` 为源自有后缀续接），新子分支有效路由 `A-B-C`（`A` 为只读祖先引用，`B,C` 转为新分支自有）。

- **源与目标**：同一逻辑话题内；源路由可为 main 或既有分支，但所选消息须全体 source-owned（无 inherited refs）；迁移后 `owner` 转至新分支，稳定 ID、同话题、块/文件引用/`askId`/内容保留，不做 clone/COW（§4.2 保留）。
- **前驱要求**：预选前驱（所选连续 turn 紧邻的前一条消息）必须存在且源路由自有；新分支 `anchorMessageId` = 该稳定前驱；首 turn（无前驱）禁用。
- **选择形态**：仅连续整 turn；非连续、空/未解析、含非自有行的选择禁用/拒绝，选择以整 turn 组 ID 表达、由 Main 展开，不接受任意 per-message rehome。
- **部分加载零隐式迁移**：Renderer 必须随请求传递显示顺序的显式 `expectedSelectedMessageIds`（稳定 IDs）；Main 从 COMPLETE 权威有效路由展开所请求 turn 组 IDs 得完整闭包，与显式期望做精确列表/顺序比较；任何裁剪/孤儿/不完整 turn 或组成员变化在写前整批拒绝零写，部分加载 turn 不得隐式迁移未见消息。
- **身份保留**：保留消息/blocks/files 的稳定身份与引用关系（稳定 ID、同话题，块/文件引用/`askId`/内容保留），不做 clone/COW；不承诺同步语义（§7 local-only）。
- **既有分支保护**：所选 ID 中含任一既有话题分支锚点即整批拒绝零写；不得 reparent/delete 既有分支（锚点删除引起的边界前移不在此列，§4.5）。
- **原子性**：同一根事务原子提交分支元数据 + 消息 owners + 排序，失败零部分写。Segment：完整落入迁移集的 segment 原样保留；横跨所选/非所选边界的既有 segment fail-closed（不新增 split 策略）。
- **分支元数据/capability 刷新**：创建后刷新分支目录与受影响路由 capability；新分支上下文锚点继承与视口规则沿用 §4.7，本文档不重定义。
- **非目标**：不设 merge/sync（已取消，local-only，§7），不设通用 owner 转移 API，普通身份字段 patch 仍禁止。
- **门禁**：Renderer 预检 + Main 同一根事务重验——首 turn/非连续/空/未解析/含非自有/含任一既有分支锚点、catalog/route unknown-stale、capability unknown/stale 时禁用零调用；loaded-only 投影永不用作完备权威，选择合法性以 Main 权威事务为准（§4.8）。

---

## 6. 跨话题引用

话题菜单的“Clone topic”提供 **Reference / Copy 子菜单**：“复制（Copy）”维持既有 `branchMessagesToTopic` 的 fresh-ID 跨话题复制（§7，语义不变）；“引用（Reference）”创建**跨话题引用**——一个独立逻辑话题，其历史是经**被点击消息**捕获的**活引用**，而不是拷贝。示例：源话题有效路由 `A-B-C-D`，在 `C` 上点击“引用”→ 目标话题显示只读前缀 `A-B-C`（稳定 ID 共享、无复制）加分隔线 `历史消息引用自：[源话题名]`，用户可在目标继续追加自有后缀 `E-G`（target-owned、writable）。本节定义 §4.3 中 `prefix(topic)` 的组成与失效语义。

（BRANCH-13）

- **创建校验（同一根事务）**：源话题存在且非 trash；目标话题与源话题相异、且尚未存在（全新目标）；`anchorMessageId` 属于**被捕获的源有效路由**（递归、引用感知解析）。目标话题行与唯一引用源关系行在同一根事务内一并创建，失败零写、不留孤儿话题。
- **端点捕获**：创建时捕获 `(sourceTopicId, sourceBranchId, anchorMessageId)`——被点击消息在其**当前源有效路由**中的精确端点（`sourceBranchId` 为点击时 source route，`null` = 源 main 路由）；端点在端点消息被删除时按 §4.5 同一继承边界前移（不引入分叉点之后历史），导航即“源话题 + 捕获源分支 + 当前边界消息”。
- **只读源操作**：引用创建只读源（不写源行、不复制源消息/块/文件、不改变源 owner），可经被点击的源有效路由消息触发，**即使该消息在源路由中是继承引用**——这正是“引用”与话题内分支创建的关键区别；引用创建不授予话题内分支创建或任何变更（§4.4）。
- **目标构成**：目标话题 main 路由 = 源端点的只读引用前缀 + 目标自有后缀（writable）。引用前缀复用 §4.3 的 `effective` 递归：取 `effective(sourceTopic, sourceBranch)` 中到 `anchorMessageId` 为止的 anchor-inclusive 前缀；稳定 ID 共享、无消息/块/文件复制、无 COW（§4.2 保留）。owner 相等性含 `topicId`，故源行在目标路由永不可变更，也永不出现在目标路由的 `mutableMessageIds`（§4.8）。目标话题的话题内分支以该引用基座作为父有效路由组合（既有锚点规则，§5.1）；引用端点（或其回答组组尾）是目标 main 路由的分叉边界，按 §4.4 唯一例外允许在其后创建目标自有后缀。
- **分隔线与导航**：目标渲染分隔条 `历史消息引用自：[话题名]`，话题名为**实时**源话题标题（源重命名即更新）；点击导航到源话题 + 捕获源分支 + 精确端点消息。
- **缺失与恢复**：端点消息被删除 → 端点在同一根事务内前移到源路由中其之前的最近存活消息，引用前缀缩短（status available）；无存活前驱、源话题删除/软删除、或源分支删除 → 引用前缀缺席（status missing：前缀省略、不自动修复、不级联），目标话题与其自有后缀保留，分隔线显示 `历史消息引用不存在`；端点恢复且**完整**（话题/分支/端点齐备）→ 前缀重新可用。引用与话题内分支共用同一继承边界机制：两者都按“锚点存活即锚点，否则其之前最近存活消息，否则空继承”解析，因此不存在两条互相矛盾的缺锚点规则。
- **递归引用源**：引用源本身可为另一个引用目标，受 bounded cycle/depth guard；越界在**引用边界** fail-closed（前缀省略），保留目标自有后缀。
- **组合与隔离**：目标话题内 subtree 删除语义不变（§5.2）；跨话题引用与话题内 `topic_branches` ancestry 严格区分，不建第二个路由/权限子系统；持久化关系最小（§7），外来源 ID 非级联外键。
- **权限与门禁**：“引用”菜单项为只读源操作，可在被点击的源有效路由消息（含继承引用）上可用，**不**受话题内分支创建/insert 的 owned-only 门禁限制，但同样不写源、不授予变更（§4.8）。
- **local-only**：引用源关系与目标处理 local-only，不进 sync，无引用同步协议、无新发布/平台承诺（§7）；源 main 保持正常 sync。

---

## 7. 共同边界：同步、导出与导入

（BRANCH-10）**话题内分支 local-only**：分支行、分支-owned 消息/块/操作永不进 sync outbox、membership/frame clocks、baseline candidate（在既有 sync 边界内抑制，无 wire 变更）；main 行保持 syncable。目标收敛语义（基线/操作日志/帧合并/水位）由 Sync ADR 治理（链接见 §9），本文档不定义。§5.3 迁移同样 local-only：不产生新的分支-owned sync intent；既往已同步 main ID 迁移至分支后的未来兼容性 deliberately out of scope（不声称已验证兼容）；不做分支同步协议。

**跨话题引用 local-only**：引用源关系与其目标处理不进 sync outbox/membership/frame clocks/baseline，不做引用同步协议；引用前缀不是 main syncable 拷贝；源 main 保持正常 sync。§4 权限机制与 §6 引用基座不改变既有 sync 边界。

**复制区分**：`branchMessagesToTopic` 跨话题前缀复制（fresh IDs）是兼容/导出形态，不是话题内分支；“复制”子菜单即此语义、保持不变；既有复制 API 不重命名，但调用方不得将其当作话题内分支权限语义。

**调用者本地读取**：导出/知识/剪贴板组装/命名/活跃度是 caller-local 读取（`whole-topic`/`naming-context`/`topic-activity`），消费后丢弃；剪切的删除另经权威删除路径。

**持久化与迁移**：跨话题引用对持久化的影响是**增量**的——新增 `topic_references` 表（迁移 `018_topic_references`），每个引用目标话题一行：`target_topic_id` 主键，目标删除时级联清理；`source_topic_id` 为普通列、非外键、不级联，源删除永不删除目标；`source_branch_id` 可空；`anchor_message_id` 为端点稳定 ID（端点删除时由 Main 就地前移到最近存活前驱，仍为非空既有列，无 schema/迁移变化）。既有 legacy 源格式（topics/messages、`branch_id`、`topic_branches` ancestry、既有导入结构）保持不变，既有数据库升级后无引用行、行为不变。L2 ZIP 导入管线与 SQLite schema/迁移 mechanics 由 SQLite migration governance 治理（链接见 §9）。

**单话题导出/导入与整库备份**：单话题导出（阅读格式与原生 JSON）把当前引用到的历史**展开为实际快照数据**——导出物自包含、可移植，不依赖源话题的活引用关系；源缺失时导出既有内容并**显式记录缺失历史**，绝不声称完整。导入为导出物生成全新稳定 ID、成为**独立的目标自有消息**（原引用前缀转为目标自有、可写），与源不留任何活关系。整库备份为原样复制，**保留**原有的消息共享与引用关系。文件/图片依赖沿用既有导出契约，不新增 bundle 系统、不新增导出选择 UI。导出元数据的精确字段形状由实现承担，本文档只定义上述语义。

---

## 8. 验证与验收

**测试契约**（按语义分组；规则定义见对应节，此处不重述）：

- **Main / 分支 owner-only（§4.4/§4.5）**：main owner 行被 live child/grandchild 引用时仍可 update content/blocks/delete/reorder；child 对同 ID 变更拒绝；内容更新在 child 有效路由同稳定 ID 可见；删除普通前缀后 child 路由自然缩短；重排后 child 有效前缀自然变化；删除 child 锚点后 child/grandchild 路由前移到其之前最近存活前驱（连续/批量一致）并保持可读写，分支元数据不自动删除；删光前缀后继承为空而自有后缀可读写。branch-owned suffix 被 nested descendant 引用时 owner branch 同样可变更，descendant 不可。
- **Bounded 插入/创建（§4.4/§5.1）**：分支上自有锚点组尾插入成功；分叉边界继承插入成功（ID 恰好等于分支 `anchorMessageId`，或引用目标的引用端点，盖章当前路由自有、落自有后缀起始）；更老祖先/外来源引用插入以 `VALIDATION_ERROR` 零写；非 main 父以继承引用（含父自身 fork 锚点）创建子分支拒绝（`VALIDATION_ERROR`、零分支行），以父自有后缀锚点创建成功且新路由含父自有前缀；main 父仍接受 main 自有消息；外来源行（`topicId != 本话题`）不作锚点授权。
- **Window capability（§4.8）**：owner route 含窗口内全部 owned IDs（即使被后代引用）；descendant window 只含 descendant-owned suffix，不含 ancestor refs；引用目标窗口的 `mutableMessageIds` 不含外来源前缀行。
- **复合路径（§4.6）**：answer-group/segment/resend/regenerate/批量按实际写目标判定，保留非 owner 拒绝与原子性；回答组选择/重排/useful/append 组级原子，retry-all/批量重生成逐项首败停止；ancestor root 只读引用不得阻断 branch-owned targets，但永不授权插入/分支锚点。
- **Renderer（§4.8/§5.1）**：main owner 共享可见消息有变更 UI；child ancestor ref 无变更 UI；话题内分支在任何继承消息上隐藏（含 fork 锚点），insert 仅在自有消息与 §4.4 分叉边界上可见；unknown/stale/missing 分支元数据隐藏话题内分支/insert 且零调用；unknown/stale capability 仍 fail-closed。
- **迁移（§5.3）**：源 `A-B-C-D` 选 `B,C` 迁移后父有效路由 `A-D`、子有效路由 `A-B-C`（`A` 只读引用，`B,C` 新分支自有，稳定 ID、同话题）；前驱缺失/非连续/空/未解析/含非自有/含任一既有分支锚点整批拒绝零写；整 turn 组 ID 由 Main 从 COMPLETE 权威有效路由展开，与显式 `expectedSelectedMessageIds` 精确列表/顺序比较，不一致（含裁剪/孤儿/不完整 turn、组成员变化）写前整批拒绝零写；段内完整 segment 保留、跨边界 segment 拒绝；分支元数据 + owners + 排序同一根事务原子；Renderer 在禁用条件下零调用。
- **引用/复制菜单（§6/§7）**：“复制”回归既有 fresh-ID 跨话题复制（无话题内分支权限语义）；“引用”不复制源消息/块/文件（源行/块/文件引用计数不变）、稳定 ID 共享、目标自有后缀可写、引用前缀只读且不出现在目标路由的 `mutableMessageIds`，源行不可经目标路由变更（跨话题 fail-closed）。
- **实时名称与稳定端点导航（§6）**：分隔线跟随源话题实时标题（源重命名后更新）；点击从目标导航到源话题 + 捕获源分支 + 精确端点消息。
- **删除存活、恢复与组合（§6）**：端点 anchor 删除 → 前缀按同一继承边界缩短；无存活前驱或源话题删除/软删除、源分支删除 → 前缀缺席 + 分隔线显示缺失文案，目标与自有后缀保留且不级联；端点恢复完整后前缀重新可用；递归引用源越界在引用边界 fail-closed 且保留目标后缀；目标话题的话题内分支以引用基座组合、目标内 subtree 删除语义不变。
- **证据层级**：按 `AGENTS.md` 路由；跨组件/IPC/持久化行为以 Playwright E2E 为合同级回归，隔离逻辑以 Vitest 为先；`pnpm ui:observe` 仅诊断；实现验证证据归验证报告，本文档不预断结果。

**验收标准**：

- **AC-1**：本文档完整覆盖 BRANCH-1…BRANCH-13 决策索引（§3，含 §5.3 迁移扩展与 §6 跨话题引用扩展）、术语（§2）、权威模型（§4）、话题内分支（§5）、跨话题引用（§6）、共同边界（§7）、验证与验收（§8）与非目标（§9）。
- **AC-2**：全文内部一致——同一话题同一消息只有一个权威实体（无复制/COW）；当前路由只能变更 owned 行，owner 权限永不因后代引用收缩；自动 owner 转移永禁、仅 §5.3 显式授权迁移可变 owner；祖先引用对插入/子分支创建只读，唯一例外是 §4.4 分叉边界（分支 `anchorMessageId` 或引用端点）；迁移要求源自有连续整 turn + 前驱存在自有 + 新锚点为稳定前驱（仅在其被删除时按 §4.5 前移），所选含任一既有分支锚点整批拒绝且不 reparent/delete 既有分支，迁移闭包须与显式 `expectedSelectedMessageIds` 精确一致；`mutableMessageIds` 为窗口内同 `topicId`+`branchId` 的 owned 精确子集；缺分支锚点按继承边界前移到其之前最近存活消息、无前驱则空继承，分支与其自有后缀保持可读写；分支锚点与上下文锚点严格区分；`branchMessagesToTopic` 明确不是话题内分支；跨话题引用与话题内 ancestry 严格区分且不建第二子系统，owner 相等性含 `topicId`（源行不可经目标路由变更），引用创建为只读源操作、不授予话题内分支创建/任何变更，引用前缀缺席不级联且目标与后缀保留，递归引用源 bounded cycle/depth 在引用边界 fail-closed；无 branch-from-any-ancestor / insert-after-any-ancestor 授权残留，无通用 owner 转移 API。
- **AC-3**：外部治理文档只链接本文档、不复制其决策表（治理域边界与链接集中见 §9）。
- **AC-4**：目标命令 `moveSelectedTurnsToNewBranch` 按 §5.3/§4.6/§4.8 实施，“引用”子菜单按 §6 实施而“复制”维持既有 fresh-ID 复制；既有 owner-only + bounded 语义（保护集与 descendant 守卫移除，capability 为 owned 精确子集；插入限自有 + 唯一分叉边界例外；分支创建限父路由自有）保持。本文档只定义合同，不声称代码已完成、也不声称任何测试已通过。
- **AC-5**：实现验证证据归验证报告（Focused Vitest + 合同级 Playwright E2E）；本文档仅定义合同，不预断通过结果。

---

## 9. 非目标与治理边界

以下域不在本文档定义，链接相应权威文档（集中列出，正文不重复）：

- 应用身份、兼容性标识、发布/更新、平台范围——[Application Identity ADR](./cherry-chat-application-identity.md)。
- SQLite schema、迁移 mechanics、L2 ZIP 导入管线——[SQLite migration governance](../archived/sqlite-migration.md)。
- 上下文锚点的有效性/默认/继承/修复策略——[Context window governance](./context-window.md)。
- 投影完备性（`loaded-projection`、窗口三元区分、稳定 ID 导航、调用者本地读取、请求本地覆盖）——[Projection Completeness and Authority Intents](./projection-completeness-authority.md)（PROJ-1…PROJ-12）。
- 聊天视口定位——[Chat Viewport Position](./chat-viewport-position.md)（VIEWPORT-1…VIEWPORT-16）。
- 同步收敛（基线/操作日志/帧合并/水位）——现状由 [Personal Multi-Device Sync](../work/multi-device-sync.md) 治理，目标由 [Sync Connection & Channel ADR](./sync-connection-channel.md) 与 [Sync Data Convergence ADR](./sync-data-convergence.md) 治理。
- 实现位置与调用链细节（见 `AGENTS.md` 与 `docs/architecture/architecture.md`）；性能阈值、基线与容量策略。

此外：不做 merge/sync（用户已取消，分支与引用维持 local-only）；不做通用 owner 转移 API（仅 §5.3 目的特定迁移）；不为迁移新增 split 策略，不重定义上下文继承/视口语义；不重命名既有复制 API，单话题导出/导入与整库备份语义见 §7 唯一定义，不新增 sync 协议/发布/平台承诺，不建第二个路由/权限子系统，“复制”维持既有 fresh-ID 复制语义。
