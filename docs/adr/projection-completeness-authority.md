# 投影完备性与权威意图（Projection Completeness and Authority Intents）

> **文档状态**：Authoritative（权威规范，描述已实现的 durable 语义）。本文档是投影完备性（projection completeness）与跨进程权威意图（authority intents）的**唯一权威规范**：定义 Main SQLite 聊天权威的覆盖范围、普通 Renderer Redux 消息状态的投影性质、不可互换的完备性能力（completeness capabilities）、窗口三元区分、稳定 ID 导航与变更语义、调用者本地（caller-local）完整读取、请求本地（request-local）执行覆盖、集合变更规则与暂定候选（provisional candidate）边界，禁止以外观完整的投影 API 或序号位置推导权威。
> **决策锁**：PROJ-1 … PROJ-12（§3 决策表，durable decision IDs）。
> **最后更新**：2026-09-15
> **Owner**：Personal fork（jorkeyliu）
> **关联**：`AGENTS.md` 与 `docs/architecture/architecture.md` 链接本文档而非复制其决策表；应用身份由 [Application Identity ADR](./cherry-chat-application-identity.md) 治理，SQLite 聊天权威与导入由 [SQLite migration governance](../archived/sqlite-migration.md) 治理，稳定 topic 上下文锚点语义由 [Context window governance](./context-window.md) 治理，多端同步收敛由 [Personal Multi-Device Sync](../work/multi-device-sync.md)（现状）与 [Sync Connection & Channel ADR](./sync-connection-channel.md)、[Sync Data Convergence ADR](./sync-data-convergence.md)（目标）治理——本文档不改变、不重述这些治理域的边界。

---

## 1. 背景与问题（Background and Problem）

窗口化读取落地后，同一 topic 的消息同时存在多种形态：权威侧的完整 topic、窗口读取的有界切片、调用者本地的一次性完整读取、渲染侧的已加载投影。若不锁定每种形态的完备性含义与归属，会出现三类漂移：把已加载投影当作完整 topic 使用；把语义不同的完备性能力混用（例如用窗口覆盖回答组、用通用完整标签满足上下文闭包）；用单实体响应或序号位置推导完整集合与权威顺序。本文档以 PROJ-1…PROJ-12 锁定一个模型：**Main SQLite 是唯一聊天权威；普通 Renderer Redux 消息状态永远只是已加载投影；每种完备性能力有固定的归属、生命周期与合法消费方**。实现阶段以本文档为契约，`docs/architecture/architecture.md` 描述实现位置，演进计划文档仅引用本文档。

---

## 2. 权威边界三元组（Authority-Boundary Triad）

| 极 | 归属 | 语义 |
|---|---|---|
| 聊天权威（authority） | Main SQLite，经 `ChatDbAggregateService` 与类型化 IPC | 完整 topic 消息、确定性顺序、回答组成员/顺序、变更作用域、Segment 成员/目录、上下文闭包派生的唯一决定者 |
| 投影（projection） | Renderer Redux 普通消息/窗口/视口状态 | 一次性、可丢弃、可重建的渲染投影；完备性恒为已加载投影，除非某次权威读取另有声明 |
| 契约（contract） | `packages/shared` 类型 + IPC 通道 + preload 暴露 + Main 处理器 | 跨进程的唯一边界；两侧对同一契约编译；契约变更必须两侧协同，永不同时只改一侧 |

投影不是权威，契约不是归属：`window.api` 的可达性不转移 Main 的所有权；渲染可达的数据不因可达而成为权威。

---

## 3. 术语（Terminology）

| 术语 | 标识符 | 定义 |
|---|---|---|
| 已加载投影 | `loaded-projection` | 普通 Renderer Redux topic 消息状态的唯一完备性标记（renderer-only）。表示“当前驻留窗口的已加载 ID 列表对应的消息”，永不表示完整 topic |
| 驻留/已加载 | resident / loaded | topic 的驻留注册（resident registry）确认其窗口已加载；`messageIdsByTopic[topicId]` 为已加载 ID 列表 |
| 空与未加载的区分 | empty vs unloaded | 驻留 topic 的显式 `[]` 是已定义的空投影；`undefined`（非驻留或无 ID 列表）是未加载，两者不可混同 |
| 块缓存 | block cache | Redux 块实体可能覆盖比消息投影更广的范围（如闭包读取带回的块）；块的存在不证明消息完备性 |
| Main 窗口读取元数据 | window-read metadata | Main 窗口读取返回的声明式边界：意图（`latest` / `around`）、请求界、返回计数、`hasMoreBefore` / `hasMoreAfter`、首尾消息 ID；完备性为 `'window'` |
| Renderer 视口窗口 | `MessageWindow` | Renderer 本地的有界视口投影（组区间、边、展示消息/组、派生 `hasMoreOlder` / `hasMoreNewer`）；一次性、可调节、可裁剪，从不作为权威 |
| 本地最新窗口完备性 | latest-window completeness | Renderer 本地的 per-topic 最新窗口权威边界记录（`hasMoreBefore` / `hasMoreAfter`），由已验证的最新窗口响应写入，供视口装配保留分页边界 |
| 稳定 ID 导航 | stable-ID navigation | 窗口外目标以稳定消息 ID 加 `around` 读取定位，不以序号游标跨变更定位 |
| 已加载交集 | loaded intersection | 变更提交到 Redux 时仅覆盖“权威响应与当前已加载投影的交集”；窗口外记录永不注入以模拟收敛 |
| 调用者本地读取 | caller-local read | 一次性、短生命周期的完整读取（整体/闭包/回答组/命名/活跃度），结果不进入普通 Redux，由调用者消费后丢弃 |
| 请求本地执行覆盖 | request-local execution overlay | 重发/重新生成期间覆盖 Redux 的请求本地块视图，随执行存活，不注入 Redux |
| 暂定已加载候选 | provisional loaded candidate | 显式标注的暂定已加载消息候选，仅用于 §8 所列的三种用途，不得决定权威状态 |
| 权威集合响应 | authority collection response | Main 返回的完整集合（有序成员 ID 列表、完整目录、完整展开），是集合变更后渲染收敛的唯一依据 |

---

## 4. 决策表（Decision Table）

| # | 决策 | 状态 |
|---|---|---|
| **PROJ-1** | **Main SQLite 是完整 topic 消息、确定性顺序（`sort_order` → `id`）、回答组成员/顺序、变更作用域、Segment 成员/目录、上下文闭包派生的唯一权威**。同一权威事务内验证归属并返回确定性顺序；Renderer 永不以本地推导替代权威解析 | **Locked** |
| **PROJ-2** | **普通 Renderer Redux 消息状态的完备性恒为 `'loaded-projection'`**。驻留/已加载与显式空投影是已定义的投影；`undefined`（非驻留或无 ID 列表）是未加载，空与未加载不可混同。块实体可能构成更广的缓存，**块的存在不证明消息完备性** | **Locked** |
| **PROJ-3** | **完备性能力不可互换**：`'window'`、`'answer-group'`、`'context-closure'`、`'whole-topic'`、`'naming-context'`、`'topic-activity'` 与 renderer-only `'loaded-projection'` 各有固定的归属、生命周期与合法消费方（§5）。拼写以代码 token 为准；任何跨能力复用必须经显式派生与同代验证，不得以标签名义隐式满足 | **Locked** |
| **PROJ-4** | **三种窗口概念严格区分**：Main 窗口读取元数据（权威边界声明）、Renderer 视口 `MessageWindow`（本地有界投影）、本地最新窗口完备性记录（分页边界保留）。**永不合并为含糊的通用 window 字段**；视口派生的 `hasMoreOlder` / `hasMoreNewer` 不得冒充权威 `hasMoreBefore` / `hasMoreAfter` | **Locked** |
| **PROJ-5** | **窗口外导航是稳定消息 ID 加 `around` 读取**。读取结果按稳定 ID 去重合并、确定性排序后装配，原子合并但**永不隐含完整 topic**；缺席目标是显式的类型化未命中，不是空窗口 | **Locked** |
| **PROJ-6** | **Main 以稳定 ID 权威意图事务性解析变更**：删除依赖展开/撤销物化、回答选择/重排、稳定插入/分支/重发语义。Renderer 在 Main 成功后提交，且**仅提交已加载交集，永不注入窗口外记录以模拟收敛**；Main 失败则不发布 | **Locked** |
| **PROJ-7** | **整体快照、上下文闭包、回答组、命名上下文、topic 活跃度读取是调用者本地、短生命周期的能力**。完整消息/块永不进入普通 Redux；调用者消费后丢弃，失败时不发布部分结果 | **Locked** |
| **PROJ-8** | **上下文、Segment、Clipboard 与视口无关**。上下文锚点属普通 renderer 设置持久化，但有效性/默认位置/继承/闭包派生由 Main 解析；Segment 目录携带权威顺序/边界/计数；Clipboard 复制/剪切从权威派生完整组/块/Segment，剪切删除是语义动作（先复制载荷，后经权威删除路径执行） | **Locked** |
| **PROJ-9** | **重发/重新生成的请求本地执行覆盖随执行存活**，经受 renderer 驱逐；Redux 只是可选镜像，不是执行生命周期权威。执行写入携带不可变执行标识，终态以原子检查点落盘 | **Locked** |
| **PROJ-10** | **当同级顺序或集合变化时，renderer 必须消费完整权威集合响应或重新读取它；永不从单实体响应推导完整集合**。权威有序 ID 列表/目录/展开是集合收敛的唯一依据 | **Locked** |
| **PROJ-11** | **暂定已加载候选仅允许三用途**：瞬时展示、请求可用性、用量估算回退。它们**不能**移动持久化锚点、决定权威组/变更作用域、替代新鲜闭包、改变最终持久化 | **Locked** |
| **PROJ-12** | **未来变更禁令**：禁止在已加载投影之上提供外观完整的含糊 API（读起来像整体、实际只是投影的接口）；禁止以数字序号（loaded-index）向 Main 发起权威变更。新增读取必须声明 §5 的完备性能力；新增变更必须使用稳定 ID 意图 | **Locked** |

> 决策锁 ID 是编排内部协调令牌的产物语义表达：PROJ-* 是本文档的 durable 决策 ID，不进入代码注释、配置或提交信息。

---

## 5. 完备性能力（Completeness Capabilities）

每种能力一行：归属、生命周期、合法消费方。拼写以代码 token 为准。

| 完备性 | 归属 | 生命周期 | 合法消费方 |
|---|---|---|---|
| `'window'` | Main SQLite 单事务读取；Renderer 视口消费 | 单次响应；边界随响应声明（`latest` / `around`、界、`hasMoreBefore` / `hasMoreAfter`） | 视口装配（最新/环绕/搜索命中导航）、分页与合并 |
| `'answer-group'` | Main SQLite 单事务解析（成员集合声明） | 单次响应；变更后必须重新解析 | 回答选择、分支/克隆定位、回答组重排 |
| `'context-closure'` | Main SQLite 按 renderer 拥有的稳定锚点派生（锚点 turn 至最新） | 单次响应；锚点/结构/代际/指纹任一变化即失效 | 请求上下文构建、锚点建立/重锚定/移动/继承 |
| `'whole-topic'` | Main SQLite 单事务一次性快照 | 调用者本地、短生命周期；永不驻留普通 Redux | 导出、知识任务、剪贴/删除等需完整成员的作业 |
| `'naming-context'` | Main SQLite 有界命名读取（命名元数据、精确计数、首条消息、至多 5 条最新消息及其块） | 调用者本地、短生命周期 | 自动命名 |
| `'topic-activity'` | Main SQLite 有界活跃度读取（精确计数、最新消息 ID/时间戳，无消息/块） | 调用者本地、短生命周期 | 限流检查等只需活跃度的作业 |
| `'loaded-projection'`（renderer-only） | Renderer 普通 Redux 消息状态 | 随驻留窗口存活；驱逐/删除/代际变化即失效 | 瞬时展示、请求可用性、用量估算（§8 暂定用途）、已加载交集计算 |

隔离规则：`window` 永不满足 `whole-topic`；通用完整标签永不隐式满足 `answer-group` / `context-closure`；已移除的含糊完整性辅助不得重新引入，驻留已加载投影恒为 `'loaded-projection'`，驻留注册的联合完备不是 `'whole-topic'` 能力；消费者必须为所需语义派生并验证同代闭包。

---

## 6. 状态与不变量（State and Invariants）

### 状态（State）

| 状态 | 归属 | 语义 |
|---|---|---|
| 权威 topic 消息/块/顺序/组/Segment/闭包 | Main SQLite | 唯一聊天权威（PROJ-1） |
| 普通 Redux 消息投影（`messageIdsByTopic` + 实体） | Renderer | 已加载投影，完备性恒为 `'loaded-projection'`（PROJ-2） |
| 视口 `MessageWindow` | Renderer 本地 | 有界展示投影（PROJ-4） |
| 调用者本地读取结果 | 调用者本地 | 短生命周期完整数据，不进普通 Redux（PROJ-7） |
| 请求本地执行覆盖 | 请求执行作用域 | 随执行存活的块视图（PROJ-9） |

### 不变量（Invariants）

- **I-1**：普通 Redux 消息读取在非驻留或无 ID 列表时返回未加载（`undefined`）；驻留显式空列表返回已定义的空投影。
- **I-2**：任何窗口读取的合并结果不改变其完备性标签；合并后仍是投影，不是整体。
- **I-3**：任何变更的 Redux 提交是权威响应与当前已加载投影的交集；窗口外成员永不因变更提交而出现。
- **I-4**：调用者本地完整读取的任何部分（消息、块、目录）永不写入普通 Redux 消息/块驻留状态；块缓存的扩大不改变消息投影的完备性。
- **I-5**：集合（回答组顺序、Segment 目录、删除展开、插入后顺序）变化后，渲染的集合视图必须来自完整权威集合响应或重新读取；单实体响应不携带集合语义。
- **I-6**：暂定候选不改变持久化、不决定权威、不替代新鲜闭包（PROJ-11）。
- **I-7**：权威变更请求携带稳定 ID 意图；数字序号只表达本地投影位置，永不作为权威变更坐标（PROJ-12）。

---

## 7. 领域迁移表（Domain Transition Table）

| 事件 | 投影/读取行为 | 是否改变权威 |
|---|---|---|
| 最新窗口装配 | `latest` 窗口读取 + 本地最新窗口完备性保留 | 否（读取） |
| 历史滚动/加载更多 | `around` 窗口读取，按稳定 ID 原子合并 | 否（读取；合并仍是投影） |
| 搜索命中导航 | 命中消息 ID 加 `around` 读取；未命中为类型化信号 | 否（读取） |
| 窗口外回答选择/重排 | 仅选定 ID 发往 Main；Main 返回完整组成员/顺序；Renderer 提交已加载交集 | 是（Main 事务） |
| 稳定插入/分支/粘贴 | 稳定锚点意图发往 Main；Main 原子解析位置后写入；Renderer 提交已加载交集 | 是（Main 事务） |
| 语义删除 | 根 ID 发往 Main；Main 返回完整展开、撤销物化与删除后 Segment 目录；Renderer 收敛已加载交集并替换 Segment 目录 | 是（Main 事务） |
| 重发/重新生成 | 稳定 ID 加执行标识；请求本地覆盖存活至终态原子落盘；Redux 仅为镜像 | 是（Main 终态检查点） |
| 上下文锚点建立/重锚定/移动/继承 | Main 解析器在同一快照内解析锚点并返回闭包；调用者仅持久化解析出的锚点键 | 是（锚点键持久化；聊天权威行不变） |
| 导出/知识/剪贴板组装/命名/活跃度 | 调用者本地完整/有界读取；消费后丢弃 | 否（读取；剪切的删除另经权威删除路径） |
| 同级顺序或集合变化后的渲染收敛 | 消费完整权威集合响应或重新读取 | 否（收敛；权威已在 Main 变更） |
| 驱逐/删除/代际变化 | 投影、视口、闭包缓存、暂定候选失效或丢弃 | 否（本地失效） |

---

## 8. 暂定候选与请求/用量边界（Provisional Candidates, Request/Usage Boundary）

- 暂定已加载候选（PROJ-11）仅允许：瞬时展示、请求可用性（请求载荷至少包含触发用户消息）、用量估算回退。
- 禁止：移动持久化锚点；决定权威回答组成员或变更作用域；替代新鲜闭包（闭包新鲜度以代际/指纹/锚点为准）；改变最终持久化内容。
- 请求本地执行覆盖（PROJ-9）与暂定候选不同：前者是执行的权威块视图，随执行存活并经受驱逐；后者是只读的可用性候选，随投影失效而丢弃。两者都不向 Redux 注入窗口外记录。
- 上下文闭包权威永远属于持久化锚点加 Main 闭包响应；暂定候选只用于新鲜度判断，不作为上下文内容来源。

---

## 9. 持久化与迁移边界（Persistence and Migration Boundary）

- 聊天权威持久化是 Main SQLite（Drizzle + better-sqlite3），经版本化迁移治理；本文档不改变其 schema、迁移流程与 L2 兼容导入语义，一律以 [SQLite migration governance](../archived/sqlite-migration.md) 为准。
- 上下文锚点与 `contextCount` 属普通 renderer 设置持久化（`assistants` slice + redux-persist），不是聊天权威；其有效性/默认位置/继承/闭包派生由 Main 解析，详见 [Context window governance](./context-window.md)。
- 驻留注册、视口 `MessageWindow`、本地最新窗口完备性、闭包缓存、调用者本地读取结果、请求本地执行覆盖、暂定候选均为不持久化、可丢弃、可重建的状态；不得经 StoreSync 或任何持久化通道变成第二权威。
- Dexie 表（文件目录、设置、知识笔记、翻译历史/语言、快捷短语）与消息块 UI / 遗留导入兼容例外保持现状；任何跨存储的聊天权威移动都属于迁移治理域，不属于本文档。

---

## 10. 请求与 UI 一致性（Request/UI Consistency）

- 单一权威解析：回答组、分支/插入位置、搜索命中窗口、上下文闭包、命名上下文、活跃度一律由 Main 单事务解析；Renderer 不自行推导权威成员、顺序或闭包范围。
- 变更一致性：所有变更先经 Main 成功，再收敛 Redux 已加载交集、替换权威集合（Segment 目录/有序 ID 列表）、转移渲染锚点；失败时不发布、不回退到整体重取伪装。
- 展示一致性：视口只渲染已加载投影的窗口切片；闭包只来自新鲜的 Main 闭包响应；命名/用量/限流只消费各自的有界能力，不复用视口或投影推导。
- 未来接口一致性（PROJ-12）：任何读起来像整体的新读取必须声明 §5 的完备性能力并接受隔离规则；任何改变权威顺序/成员的新变更必须使用稳定 ID 意图并返回完整权威集合响应。

---

## 11. 测试与证据契约（Test/Evidence Contract）

- **单元测试**：已加载投影判别（`'loaded-projection'`、空与未加载区分）、稳定 ID 合并与确定性排序、回答组选择/重排的已加载交集提交、删除展开的已加载交集与 Segment 目录替换、稳定插入的锚点解析、调用者本地读取不进 Redux、暂定候选三用途边界。
- **组件测试**：窗口装配与分页边界保留、窗口外导航装配、回答选择可见折叠、删除后锚点转移展示。传输中状态不作为回归证据。
- **证据层级**：按 `AGENTS.md`「Testing and UI/E2E Evidence」路由；UI 变更的渲染/交互验证经 `ui-verify-change`。跨组件/IPC/持久化/生命周期行为的合同级回归以 Playwright E2E 为准；隔离的稳定展示/逻辑以 Vitest/组件测试为先。
- **禁令回归**：以外观完整 API 包装投影、或以数字序号发起权威变更的任何新增，必须以契约测试失败为门禁（fail-closed），不得以展示正确为通过条件。

---

## 12. 非目标（Non-goals）

- 不定义应用身份、兼容性标识、发布/更新、平台范围——由 [Application Identity ADR](./cherry-chat-application-identity.md) 治理。
- 不定义 SQLite schema、迁移 mechanics、L2 ZIP 导入管线——由 [SQLite migration governance](../archived/sqlite-migration.md) 治理。
- 不定义上下文锚点的详细有效性/默认/继承/修复策略——由 [Context window governance](./context-window.md) 治理。
- 不定义同步收敛（基线/操作日志/帧合并/水位）——现状由 [Personal Multi-Device Sync](../work/multi-device-sync.md) 治理，目标由 [Sync Connection & Channel ADR](./sync-connection-channel.md) 与 [Sync Data Convergence ADR](./sync-data-convergence.md) 治理。
- 不重复实现位置与调用链细节（见 `AGENTS.md` 与 `docs/architecture/architecture.md`）；不引入性能阈值、基线或容量策略。

---

## 13. 验收标准（Acceptance Criteria）

- **AC-1**：本文档完整覆盖 PROJ-1…PROJ-12 决策表、完备性能力表（§5，七种拼写准确）、状态与不变量（§6）、领域迁移表（§7）、暂定/执行边界（§8）、持久化边界（§9）、一致性（§10）、测试契约（§11）、非目标（§12）。
- **AC-2**：全文内部一致——普通 Redux 消息状态只用 `'loaded-projection'`；`'window'` / `'answer-group'` / `'context-closure'` / `'whole-topic'` / `'naming-context'` / `'topic-activity'` 永不互换；三种窗口概念永不合并为通用 window 字段；数字序号永不作为权威变更坐标。
- **AC-3**：`docs/architecture/architecture.md` 治理段落与 Redux/SQLite/IPC 行链接本文档，且不复制决策表。
- **AC-4**：`AGENTS.md` Detailed References 含单条链接；既有 MUST/NEVER/gate/security 规则零改动；`CLAUDE.md` 仍为 `AGENTS.md` 的符号链接。
- **AC-5**：本次变更仅新增本文档并修改 `docs/architecture/architecture.md`、`docs/archived/architecture-evolution-program.md`、`AGENTS.md`；无代码/测试/配置变更。
