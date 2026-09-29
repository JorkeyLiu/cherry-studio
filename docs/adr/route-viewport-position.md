# 路由视口位置（Route Viewport Position）— 路由本地稳定视口规范

> **文档状态**：Authoritative（权威规范，描述已验证的 durable 语义）。本文档是路由本地稳定视口（route-local stable viewport）的**唯一权威规范**：定义每路由稳定视口的归属、选中/展示/视口三元区分、恢复意图与所有权的生命周期、快照与无快照目标的定位语义、可见性原子性、分隔线恢复的稳定完成条件、终态回退与超前失效、回归契约边界，禁止以中间几何冒充稳定位置或以发出侧滚动冒充目标位置。
> **决策锁**：VIEWPORT-1 … VIEWPORT-12（§3 决策表，durable decision IDs）。
> **最后更新**：2026-09-29
> **Owner**：Personal fork（jorkeyliu）
> **关联**：`AGENTS.md` 与 `docs/architecture/architecture.md` 链接本文档而非复制其决策表；应用身份、兼容标识、发布/更新、平台范围由 [Application Identity ADR](./cherry-chat-application-identity.md) 治理，SQLite 聊天权威与 L2 导入由 [SQLite migration governance](../archived/sqlite-migration.md) 治理，稳定 topic 上下文锚点语义由 [Context window governance](./context-window.md) 治理，投影完备性与权威意图由 [Projection Completeness and Authority Intents](./projection-completeness-authority.md)（PROJ-1…PROJ-12）治理，分支路由的变更权限与有效路由算法由 [Topic Branches ADR](./topic-branches.md)（BRANCH-1…BRANCH-12）唯一治理——本文档不改变、不重述这些治理域的边界。
>
> **去 conflation 链接（不重复决策表）**：视口快照不是上下文锚点（context-window anchor 定义窗口起点，见 [Context window](./context-window.md) CW-2/CW-6）；视口不是完备性能力（`loaded-projection` / `MessageWindow` 的投影性质与能力隔离见 [Projection](./projection-completeness-authority.md) PROJ-2/PROJ-4）；路由切换永不改变 topic 身份、分支锚点定义路由构成（见 [Topic Branches](./topic-branches.md) BRANCH-7/11），本文档只定义切换时的视口归属与定位。

---

## 1. 背景与问题（Background and Problem）

路由切换时的滚动恢复长期存在三类漂移：把发出侧（outgoing）滚动位置写成目标路由的视口；把程序化中间几何（过渡帧、边缘停靠、未对齐的首绘）提交为稳定快照；在新路由增量取数尚未完成时，让旧展示 DOM 以新路由身份写入位置。若不锁定每路由视口的归属、恢复意图的生命周期与稳定完成的判定条件，同一份“看起来在正确位置”的 UI 可能对应三种不同的语义：真实稳定恢复、中间过渡、错误路由的残留。

本文档以 VIEWPORT-1…VIEWPORT-12 锁定一个模型：**每路由拥有其上次稳定视口；目标路由只按自身快照或自身确定性默认定位；中间几何永不成为稳定位置；不可见过渡失败时 fail-visible**。`docs/architecture/architecture.md` 描述实现位置，演进计划文档仅引用本文档。

---

## 2. 术语（Terminology）

| 术语 | 标识符 | 定义 |
|---|---|---|
| 路由 | route | 一次权威读写所寻址的逻辑 topic 内分支（main 或某分支）。构成与权限语义由 [Topic Branches](./topic-branches.md)（BRANCH-2/11）唯一治理；本文档只定义路由的视口归属 |
| 选中路由 | selected route | 选择器/导航状态当前指向的路由（用户意图的去向） |
| 展示路由 | displayed route | 当前已提交渲染的投影所归属的路由（DOM 内容的来源身份） |
| 路由本地稳定视口 | route-local stable viewport | 某路由上次验证有效的视口位置：稳定消息身份 + 行内偏移/底部语义。它是该路由的本地属性，与用户是否输入/滚动无关 |
| 视口快照 | viewport snapshot | 路由本地稳定视口的已提交记录（按路由键索引）。快照是可丢弃的渲染投影，不是聊天权威 |
| 恢复意图 | restore intent | 指向目标路由的待完成恢复（目标稳定身份 + 期望偏移）。意图在稳定完成或终态回退前一直存活 |
| 恢复所有权 | restore ownership | 当前过渡由哪一次路由切换拥有。所有权决定谁可以分页、谁可以提交、谁可以释放；过期所有者的一切完成均无效 |
| 定位中 / 已放置 / 搜索中 / 已对齐 / 稳定 / 终态回退 | positioning / placed / searching / aligned / stable / terminal fallback | 恢复生命周期的互斥阶段（§5）。首绘已放置不等于稳定 |
| 边缘停靠 | edge parking | `searching` 阶段在可滚动边缘的临时停靠（中间几何），用于使恢复拥有的分页得以推进 |
| 分隔线 | divider | 上下文窗口起始边界的 UI 表现（稳定身份）。分隔线恢复是视口恢复的一类目标形态 |
| 共享消息回退 | shared-message fallback | 当所请求的稳定身份缺席时，显式声明的同代有效替代身份（目标路由内驻留且被覆盖的消息）。隐式就近替代不是合法回退 |
| 恢复拥有的分页 | restore-owned pagination | 由当前恢复所有者驱动的窗口扩展（按状态/驻留驱动，不由滚动事件驱动） |
| 路由代际 | route epoch | 区分连续路由切换的单调代际。展示提交与揭示必须与目标代际一致 |
| 发出侧来源 | outgoing provenance | 离开路由时保存的快照所标注的来源路由身份。保存只允许展示路由来源 |

---

## 3. 决策表（Decision Table）

| # | 决策 | 状态 |
|---|---|---|
| **VIEWPORT-1** | **每路由拥有其上次稳定视口**。位置有效性独立于用户是否输入或滚动：无滚动不等于无位置，无输入的路由仍可持有有效快照 | **Locked** |
| **VIEWPORT-2** | **选中路由、展示路由、路由本地稳定视口三者严格区分**。离开保存只允许展示路由来源（displayed-route provenance），永不以选中路由身份保存展示内容 | **Locked** |
| **VIEWPORT-3** | **成功的程序化恢复是合法的稳定视口**；程序化中间几何不是。是否稳定取决于是否走完稳定完成判定（§6），不取决于触发方式是用户滚动还是程序化定位 | **Locked** |
| **VIEWPORT-4** | **进入路由增量取数期间，旧展示 DOM 不得以进入路由身份写入位置**。来源身份与写入身份必须一致；身份不一致的写入一律丢弃 | **Locked** |
| **VIEWPORT-5** | **有快照的目标按稳定消息身份 + 行内偏移/底部语义恢复**；同路由原始滚动值只允许作为本地回退。**无快照的目标使用确定性目标路由默认**；永不使用发出侧滚动值 | **Locked** |
| **VIEWPORT-6** | **目标投影从提交到有效首绘定位完成前保持隐藏但可测量；揭示按路由/代际守卫；失败 fail-visible**。永不展示错位内容冒充恢复成功，永不静默停留在隐藏状态 | **Locked** |
| **VIEWPORT-7** | **生命周期语义互斥且不可跳级**：`positioning` → `placed` →（`searching`）→ `aligned` → `stable`，另有 `terminal fallback` 终态。首绘已放置不自动成为稳定 | **Locked** |
| **VIEWPORT-8** | **`searching` 边缘停靠是中间几何**。它可以使恢复拥有的分页得以推进，但**不能**提交稳定快照、清除恢复意图、释放恢复所有权 | **Locked** |
| **VIEWPORT-9** | **分隔线恢复的稳定完成要求四者合取**：所请求的稳定身份分隔线、或显式合法的共享消息回退已驻留且被覆盖；恢复拥有的分页已完成；目标已对齐；布局已安静。分页由状态/驻留驱动，不由滚动事件驱动；意图与偏移在窗口增长中存活 | **Locked** |
| **VIEWPORT-10** | **终态回退释放并可见失败，不提交虚假中间几何；保留已有的合法目标快照**（如有）。回退永不伪造一次稳定完成 | **Locked** |
| **VIEWPORT-11** | **超前/路由切换/删除/卸载使过期完成失效；释放恰好一次**。过期所有者的迟到完成（稳定提交、揭示、释放）一律丢弃，不得复用新代际 | **Locked** |
| **VIEWPORT-12** | **回归契约冻结**（§9）：无滚动顶部分隔线往返、普通用户滚动后无滚动往返、无快照目标默认、快速超前、分隔线缺席锚点分页/偏移、原子可见性与失败路径。任一契约回归即判定违反本文档 | **Locked** |

> 决策锁 ID 是编排内部协调令牌的产物语义表达：VIEWPORT-* 是本文档的 durable 决策 ID，不进入代码注释、配置或提交信息。

---

## 4. 状态与不变量（State and Invariants）

### 状态（State）

| 状态 | 归属 | 语义 |
|---|---|---|
| 路由本地稳定视口快照（按路由键） | Renderer 本地 | 每路由上次稳定视口；可丢弃、可重建（VIEWPORT-1） |
| 选中路由 / 展示路由 | Renderer 本地 | 意图去向 vs 已提交渲染身份；切换期间两者可短暂不一致（VIEWPORT-2） |
| 恢复意图 + 恢复所有权（目标路由 + 代际） | 当前过渡作用域 | 从提交存活到稳定完成或终态回退；超前即失效（VIEWPORT-8/9/11） |
| 生命周期阶段 | 当前过渡作用域 | `positioning` / `placed` / `searching` / `aligned` / `stable` / `terminal fallback`（VIEWPORT-7） |

### 不变量（Invariants）

- **I-1**：任一路由的快照只表达该路由的稳定视口；快照的路由键与写入来源（展示路由）一致（VIEWPORT-1/2）。
- **I-2**：程序化定位的中间帧永不成为快照；只有走完 §6 稳定完成判定的位置才是稳定视口（VIEWPORT-3）。
- **I-3**：身份不一致的位置写入不存在：旧展示内容永不以新路由身份落快照（VIEWPORT-4）。
- **I-4**：目标定位的输入只来自目标自身（自身快照或自身确定性默认）；发出侧滚动值永不是目标定位输入（VIEWPORT-5）。
- **I-5**：未揭示的过渡对外不可见；揭示只发生在目标路由与目标代际一致时；揭示失败对外可见（VIEWPORT-6）。
- **I-6**：`searching` 停靠不改变意图、所有权与快照；分页完成不等于稳定完成（VIEWPORT-8）。
- **I-7**：过期代际的任何完成（提交、揭示、释放）均无效；释放恰好一次（VIEWPORT-11）。

---

## 5. 生命周期（Lifecycle）

阶段按序推进，不可跳级，不可回退到更早阶段冒充完成：

1. **`positioning`**：过渡已提交，目标投影隐藏但可测量，恢复意图已建立。等待有效首绘定位。
2. **`placed`**：首绘已按目标意图放置（程序化几何已生效）。此时**不是**稳定：对齐与安静尚未验证（VIEWPORT-7）。
3. **`searching`**（条件进入）：目标稳定身份尚未驻留/覆盖，需要恢复拥有的分页。允许边缘停靠以推进分页；停靠本身是中间几何（VIEWPORT-8）。
4. **`aligned`**：目标身份已驻留且被覆盖，分页已完成，布局已安静，但稳定提交尚未落快照。
5. **`stable`**：§6 合取条件满足，快照已提交，或等价的非分隔线目标完成判定满足；恢复意图清除，所有权释放（恰好一次）。
6. **`terminal fallback`**：稳定路径不可达（缺席且无合法回退、超前、删除/卸载、验证失败）。释放所有权并可见失败，不提交中间几何；保留已有的合法目标快照（VIEWPORT-10）。

分隔线目标在 `searching` 中可多次分页；意图与偏移在窗口增长中存活，不重置（VIEWPORT-9）。

---

## 6. 稳定完成判定（Stable Completion）

- **分隔线目标**（VIEWPORT-9，四者合取，缺一即未完成）：
  1. 所请求的稳定身份分隔线、或显式合法的共享消息回退已驻留且被覆盖（隐式就近替代不计）；
  2. 恢复拥有的分页已完成（无未完成的窗口扩展）；
  3. 目标已对齐（意图身份与实际展示身份一致）；
  4. 布局已安静（无未结算的布局变化）。
- **非分隔线目标**：目标身份驻留且被覆盖、已对齐、布局安静；有快照时按快照身份 + 行内偏移/底部语义，无快照时按确定性目标路由默认（VIEWPORT-5）。
- **驱动规则**：分页由状态/驻留驱动，永不由滚动事件驱动；滚动事件不得作为完成信号（VIEWPORT-9）。
- **禁止**：以 `placed` 首绘几何、以 `searching` 边缘停靠、以发出侧滚动值提交稳定快照（VIEWPORT-3/7/8）。

---

## 7. 可见性原子性（Visibility Atomicity）

- 目标投影从提交到有效首绘定位完成前保持**隐藏但可测量**（占位可度量，不向用户展示错位内容）（VIEWPORT-6）。
- 揭示条件：展示路由 == 目标路由，且代际 == 目标代际，且首绘定位已验证。任一不一致即不揭示。
- 失败路径 fail-visible：定位失败、超前失效、删除/卸载导致的终态回退必须使用可见的确定性 fallback（目标默认或保留的合法快照路径），永不静默停留在隐藏状态，也永不展示错位内容冒充成功（VIEWPORT-6/10）。

---

## 8. 持久化与权威边界（Persistence and Authority Boundary）

- 聊天权威持久化是 Main SQLite（Drizzle + better-sqlite3），经版本化迁移治理；本文档不改变其 schema、迁移流程与 L2 兼容导入语义，一律以 [SQLite migration governance](../archived/sqlite-migration.md) 为准。
- 路由本地稳定视口快照、选中/展示路由、恢复意图与所有权、生命周期阶段均为**一次性、可丢弃、可重建的 renderer 本地投影**；不得经 StoreSync 或任何持久化通道变成第二权威，不得写入 SQLite/Dexie 聊天权威（VIEWPORT-1；PROJ-2 仍然适用）。
- 上下文锚点与 `contextCount` 属普通 renderer 设置持久化，其有效性/默认/继承/闭包派生由 [Context window governance](./context-window.md) 治理；视口快照与上下文锚点是两种不同的状态——前者是“切回来时看哪里”（本规范），后者是“请求带哪段上下文”（CW-2/CW-6）。视口变化永不移动上下文锚点，锚点变化永不提交视口快照。
- 路由构成、分支锚点、变更权限由 [Topic Branches](./topic-branches.md) 治理；路由切换永不改变 topic 身份（BRANCH-2/11）。视口快照按路由键隔离，分支路由各持其快照，互不写入。
- 完备性能力（`window` / `answer-group` / `context-closure` / `whole-topic` / `naming-context` / `topic-activity` / renderer-only `loaded-projection`）由 [Projection Completeness](./projection-completeness-authority.md)（PROJ-3…PROJ-5）治理；视口定位只消费已加载投影与窗口读取结果，永不以视口位置推导权威成员、顺序或闭包范围。

---

## 9. 失败、超前与测试契约（Failure, Supersession, Test Contract）

### 失败与超前（VIEWPORT-10/11）

- 终态回退：释放恢复所有权（恰好一次），对外可见失败，不提交任何中间几何；已有的合法目标快照原样保留，供下次同路由进入使用。
- 超前（新切换在旧过渡完成前提交）、目标路由变更、topic/分支删除、组件卸载：旧过渡的恢复意图与所有权立即失效；旧所有者的迟到稳定提交、迟到揭示、重复释放一律丢弃。
- 释放恰好一次：稳定完成与终态回退是互斥终态；同一过渡不得既提交稳定又执行回退，不得释放两次。

### 回归契约（VIEWPORT-12）

以下六组为必需回归契约；实现位置与用例组织见架构文档，语义判定以本文档为准：

1. **无滚动顶部分隔线往返**：两路由均无用户滚动时反复切换，目标始终回到各自稳定视口，无漂移、无发出侧污染。
2. **普通用户滚动后无滚动往返**：一侧经普通用户滚动形成稳定视口后，无滚动切离再返回，恢复该侧用户视口而非发出侧位置。
3. **无快照目标默认**：从未形成快照的目标路由进入时落确定性目标路由默认，不采用发出侧滚动值。
4. **快速超前**：连续快速切换只承认最新代际；过期代际的迟到完成不揭示、不提交、不干扰最新过渡。
5. **分隔线缺席锚点分页与偏移**：所请求分隔线缺席时经恢复拥有的分页使回退身份驻留且被覆盖，意图与偏移在窗口增长中存活，最终稳定位置与偏移正确；无合法回退时走终态回退而非虚假提交。
6. **原子可见性与失败路径**：过渡期间不展示错位内容；失败时可见失败而非静默隐藏；不提交中间几何为快照。

### 证据层级

- 按 `AGENTS.md`「Testing and UI/E2E Evidence」路由；UI 变更的渲染/交互验证经 `ui-verify-change`。跨路由切换、分页/驻留、显隐原子性的合同级回归以 Playwright E2E 为准；隔离的定位纯逻辑以 Vitest/组件测试为先。诊断性观察（`pnpm ui:observe`、截图、dev-mode 运行）永不作为回归证据。

---

## 10. 非目标（Non-goals）

- 不定义应用身份、兼容性标识、发布/更新、平台范围——由 [Application Identity ADR](./cherry-chat-application-identity.md) 治理。
- 不定义 SQLite schema、迁移 mechanics、L2 ZIP 导入管线——由 [SQLite migration governance](../archived/sqlite-migration.md) 治理。
- 不定义上下文锚点的有效性/默认/继承/修复策略——由 [Context window governance](./context-window.md)（CW-1…CW-8）治理；本文档不移动锚点、不推导窗口、不改变 `contextCount` 语义。
- 不定义分支构成、分支锚点、变更权限、有效路由算法——由 [Topic Branches ADR](./topic-branches.md)（BRANCH-1…BRANCH-12）治理。
- 不定义投影完备性能力、稳定 ID 导航/变更、调用者本地读取、请求本地执行覆盖——由 [Projection Completeness and Authority Intents](./projection-completeness-authority.md)（PROJ-1…PROJ-12）治理。
- 不定义同步收敛（基线/操作日志/帧合并/水位）——现状由 [Personal Multi-Device Sync](../work/multi-device-sync.md) 治理，目标由 [Sync Connection & Channel ADR](./sync-connection-channel.md) 与 [Sync Data Convergence ADR](./sync-data-convergence.md) 治理。
- 不定义模型元数据、provider/model 解析与缓存——由 [Model Metadata Governance](./model-metadata.md) 治理。
- 不引入节流时长、安静阈值、选择器、内部标识符命名、分页容量数值、测试固件标识等实现细节；不重复实现位置与调用链细节（见 `AGENTS.md` 与 `docs/architecture/architecture.md`）；不引入性能阈值、基线或容量策略。

---

## 11. 后果与验收（Consequences and Acceptance）

- **后果**：路由切换的视口行为获得唯一语义基准；后续视口改动按 §9 六组契约回归；与上下文锚点、分支权限、投影完备性相关的改动在各自 ADR 判定，本文档只收敛视口归属争议。
- **AC-1**：本文档完整覆盖 VIEWPORT-1…VIEWPORT-12 决策表、术语（§2）、状态与不变量（§4，I-1…I-7）、生命周期（§5）、稳定完成判定（§6）、可见性原子性（§7）、持久化边界（§8）、失败/超前与测试契约（§9）、非目标（§10）。
- **AC-2**：全文内部一致——快照恒按路由键隔离且来源恒为展示路由；中间几何（首绘放置、边缘停靠、发出侧滚动）永不成为快照；分隔线完成四条件合取；释放恰好一次；失败可见；无实现细节数值/选择器/内部命名；无与 CW/PROJ/BRANCH 决策表的重复或冲突，交叉处均为链接。
- **AC-3**：`docs/architecture/architecture.md` 治理段落与视口/renderer 相关行链接本文档，且不复制决策表。
- **AC-4**：`AGENTS.md` Detailed References 含本文档单条链接；既有 MUST/NEVER/gate/security 规则零改动；`CLAUDE.md` 仍为 `AGENTS.md` 的符号链接。
- **AC-5（history）**：ADR 引入时的变更集为文档-only（新增本文档并修改 `docs/architecture/architecture.md`、`AGENTS.md` 与三份邻接 ADR 的去 conflation 链接行；无生产代码/测试改动，无提交）。后续视口增量在 VIEWPORT-1…VIEWPORT-12 约束下演进生产代码与测试，本文档决策表与验收语义不受影响、不新增未决定语义。

(End of file - total 11 sections)
