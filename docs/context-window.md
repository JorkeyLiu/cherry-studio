# 上下文窗口治理（Context Window Governance）— 稳定锚点规范

> **文档状态**：Authoritative（权威规范，实现阶段的目标契约）。本文档是上下文窗口（context window）语义的**唯一权威规范**：定义默认上下文数量（`contextCount`）、稳定 topic 锚点（`contextWindowAnchor`）、上下文窗口、允许的锚点迁移、持久化归属、兼容性修复与测试边界，防止既有语义漂移再次发生。
> **决策锁**：CW-1 … CW-8（§3 决策表，durable decision IDs）。
> **最后更新**：2026-08-13
> **Owner**：Personal fork（jorkeyliu）
> **关联**：`AGENTS.md` 与 `docs/architecture.md` 链接本文档而非复制其决策表；应用身份由 [Application Identity ADR](./cherry-chat-application-identity.md) 治理，SQLite/Dexie 聊天权威与导入由 [SQLite migration governance](./sqlite-migration.md) 治理——本文档不改变、不重述这两个治理域的边界。

---

## 1. 背景与问题（Background and Problem）

上下文窗口的语义在本仓库经历了多轮实现与反复漂移。漂移的根源是没有一份权威规范锁定「锚点是什么、何时建立、何时移动、归谁持久化」：

- **现状实现仍使用 `contextStartOverride` + 动态推导回退**：持久化的只有 per-topic 用户起点 override；无 override 时，有效窗口起点由 `contextCount` 与当前消息**动态推导**（`computeContextInfo` 每次调用重新计算），推导出的锚点是投影、不持久化。这使「锚点是否稳定」「重锚定是否产生无锚点状态」「改变 `contextCount` 是否移动既有窗口」等语义随实现者理解而漂移。
- **重复漂移症状**：出现过 fixed/sliding 双模式的反复讨论与复活尝试；出现过把「点击已锚定消息」实现为取消锚定、使非空已初始化 topic 变成无锚点；出现过把 `contextCount` 变更理解为对既有 topic 生效。

本文档以 CW-1…CW-8 锁定一个模型：**稳定锚点到末尾（stable anchor-to-end）**。锚点是持久化的 topic 上下文起点；非空已初始化 topic 恒有且仅有一个锚点；窗口 = 锚点 turn 至 topic 末尾；仅 CW-4 列举的显式情形移动锚点。实现阶段以本文档为契约目标，现状的 override + 动态回退由「兼容性修复」（§10）与「持久化与迁移边界」（§11）一次性收敛。

---

## 2. 术语（Terminology）

| 术语 | 标识符 | 定义 |
|---|---|---|
| 默认上下文数量 | `contextCount` | assistant 级默认/初始/重置窗口大小（turn 数；`null` = 不限）。滑块域 1..99 + ∞ 端点。仅影响未来的初始建立与显式的重锚定动作 |
| topic 锚点 | `contextWindowAnchor[topicId]` | 持久化的稳定 topic 上下文起点。值为起始 turn 的 **group key**。它不是 override，也不是渲染投影（CW-2） |
| 上下文窗口 | context window | 锚点 turn 至 topic 末尾的连续 turn 区间（anchor-to-end） |
| turn / 组键 | turn / group key | 语义问答组：user 消息 + 其 assistant 响应（按 askId 归组）。组键 = 该 turn 的 user 消息 id；assistant 消息属于其 askId 的组。窗口按整 turn 选取 |
| 边界分隔线 | boundary divider | 窗口起始边界的 UI 表现（`boundaryMessageId`） |
| 重锚定 | re-anchor | 显式把锚点移动到某位置的用户动作（TokenCount 点击或消息锚点控件点击） |
| 消息锚点控件 | message anchor control | 每条可作为窗口起点的 turn 上的锚点控件（选中/点击该控件即移动锚点） |
| 初始建立 | initialization | 非空 topic 首次建立锚点（默认窗口位置） |
| 默认窗口位置 | default window position | 由 `contextCount` 唯一确定的窗口起点位置（有限 N → 至多含 N 个 turn 的 turn；`null` → topic 首 turn），见 §6 |
| 兼容性修复 | compatibility repair | 对缺少锚点的遗留非空 topic 恰好一次初始化锚点（CW-5） |
| 现状标识符映射 | legacy mapping | 现状 `contextStartOverride[topicId]`（`{ kind: 'active'; groupKey }`）即旧版锚点表达；其 `active.groupKey` 语义等价于本规范的锚点值，由 §10/§11 字段演进为 `contextWindowAnchor` |

---

## 3. 决策表（Decision Table）

| # | 决策 | 状态 |
|---|---|---|
| **CW-1** | **`contextCount` 是 assistant 级默认/初始/重置窗口大小**（turn 数；`null` = 不限）。单独改变它**永不移动**已存在的 topic 锚点；它只作用于未来的初始建立与未来的显式重锚定动作 | **Locked** |
| **CW-2** | **`contextWindowAnchor[topicId]` 是持久化的稳定 topic 上下文起点**（起始 turn 的 group key）。它不是 override，也不是渲染投影 | **Locked** |
| **CW-3** | **非空且已初始化的 topic 恰好有一个锚点**；其上下文窗口 = 锚点 turn 至 topic 末尾。新消息使窗口增长，**不移动锚点** | **Locked** |
| **CW-4** | **锚点仅在以下情形变化**：首次建立；用户点击 TokenCount 以当前 `contextCount` 重锚定；用户选择/点击消息锚点控件；确定性删除转移/修复；分支继承；显式迁移/兼容性修复 | **Locked** |
| **CW-5** | **应用启动/重启、topic 加载、消息渲染、新 assistant 响应、改变 `contextCount` 均不是普通锚点迁移**。兼容性修复可对缺少锚点的遗留非空 topic **恰好一次**初始化锚点；它**永不重算**有效锚点 | **Locked** |
| **CW-6** | **UI 高亮、TokenCount、边界分隔线、模型请求必须从同一持久化锚点与上下文窗口解析** | **Locked** |
| **CW-7** | **持久化是普通 renderer assistant-settings 持久化**。迁移测试覆盖字段演进；**不需要**锚点专用重启 E2E | **Locked** |
| **CW-8** | **不恢复 fixed/sliding 双模式**。只有一种模型：稳定锚点到末尾（stable anchor-to-end） | **Locked** |

> 决策锁 ID 是编排内部协调令牌的产物语义表达：CW-* 是本文档的 durable 决策 ID，不进入代码注释、配置或提交信息。

---

## 4. 状态与不变量（State and Invariants）

### 状态（State）

| 状态 | 归属 | 语义 |
|---|---|---|
| `contextCount` | assistant 设置（renderer） | 标量；`number \| null`；默认/初始/重置窗口大小 |
| `contextWindowAnchor[topicId]` | assistant 设置（renderer） | per-topic 映射；值为起始 turn 的 group key |

两者均属普通 renderer assistant-settings 配置（§11），不是聊天权威数据。

### 不变量（Invariants）

- **I-1**：非空已初始化的 topic **恰好有一个锚点**；空 topic **没有锚点**。
- **I-2**：上下文窗口 = 锚点 turn 至 topic 末尾；新 turn 使窗口增长，窗口永不收缩、锚点永不移动（CW-3）。
- **I-3**：锚点是持久化状态，不是投影；UI 高亮、TokenCount、边界分隔线、模型请求均从同一锚点解析（CW-6）。
- **I-4**：改变 `contextCount` 永不移动既有锚点（CW-1）；该改变只作用于未来的初始建立与显式重锚定。
- **I-5**：锚点迁移的完整集合 = CW-4 六类；其余事件（CW-5 列表）均不是迁移。
- **I-6**：删除锚点 turn 时锚点确定性转移（§9）；删除非锚点 turn 不移动锚点。
- **I-7**：已初始化的非空 topic 在任何时刻（含重锚定交互之后）都保留恰好一个锚点；「无锚点」只对空 topic 或尚未修复的遗留 topic 存在。

---

## 5. 领域迁移表（Domain Transition Table）

| 事件 | 锚点行为 | 是否迁移 |
|---|---|---|
| 新 topic 首条消息（空 → 非空初始化） | 在默认窗口位置**建立**锚点（首次建立） | 是（CW-4 · 首次建立） |
| 应用启动 / 重启 | 锚点原样保留 | 否（CW-5） |
| topic 加载 / 消息渲染 | 锚点原样保留 | 否（CW-5） |
| 新 assistant 响应（窗口增长） | 窗口扩展至 topic 末尾，锚点不动 | 否（CW-5） |
| 改变 `contextCount` | 既有锚点不动；仅影响未来初始建立与显式重锚定 | 否（CW-1/CW-5） |
| 用户点击 TokenCount | 以**当前** `contextCount` 重锚定到默认窗口位置 | 是（CW-4 · TokenCount 重锚定） |
| 用户点击/选择消息锚点控件 | 锚点移动到该消息所在 turn | 是（CW-4 · 消息锚点控件） |
| 用户点击**当前已锚定** turn 的锚点控件 | 重锚定到当前默认窗口位置；**绝不**使已初始化非空 topic 无锚点 | 是（CW-4 · 消息锚点控件；§8） |
| 删除锚点 turn | 确定性转移：落到更旧一侧的前一组；若锚点组为首组则落到新首组；topic 变空则移除锚点 | 是（CW-4 · 确定性删除转移/修复） |
| 删除非锚点 turn | 锚点相对位置不动 | 否 |
| 分支创建 | 确定性继承父 topic 锚点（分支继承），不从 `contextCount` 重算 | 是（CW-4 · 分支继承） |
| 兼容性修复（遗留非空 topic 缺锚点） | 恰好一次在默认窗口位置初始化锚点；永不重算有效锚点 | 是（CW-4/CW-5 · 兼容性修复） |
| topic 清空为空 | 锚点移除（空 topic 无锚点，I-1） | 否（不变量推论） |

---

## 6. 初始建立（Initial Establishment）

**默认窗口位置定义**（与 TokenCount 重锚定共享同一位置定义，CW-1）：

- `contextCount = N`（有限，N ≥ 1）→ 起始 turn 索引 = `max(0, totalTurns − N)`；窗口至多含 N 个 turn。
- `contextCount = null`（不限）→ 起始 turn 索引 = 0（topic 首 turn）；窗口 = 整个 topic。

**建立时机**：topic 由空变为非空（首条 user 消息出现）时完成初始化并建立锚点，锚点位置为当时的默认窗口位置。**建立之后锚点稳定**：topic 继续增长时窗口沿锚点向末尾扩展，默认位置计算**不再应用**——对已建锚点的 topic 重新应用默认位置计算即「动态推导」，是本文档消除的漂移（CW-3/CW-5）。

---

## 7. TokenCount 重锚定（TokenCount Re-anchor）

- 点击 TokenCount 是显式重锚定（CW-4）：以**点击时**的 `contextCount` 计算默认窗口位置，并把锚点写入该位置。
- 改变 `contextCount` 本身不重锚定既有 topic（CW-1/CW-5）；重锚定只在用户显式点击时发生，且使用点击时的 `contextCount` 值。
- 该交互取代现状的「删除 override → 动态回退」：交互结束后 topic 仍有且仅有一个锚点，**不产生无锚点状态**（I-1/I-7）。

---

## 8. 消息锚点交互（Message Anchor Interaction）

- 每条可作为窗口起点的 turn 暴露消息锚点控件。点击/选择某 turn 的控件 = 显式重锚定（CW-4），锚点移动到该 turn。
- 点击**当前已锚定** turn 的锚点控件：**重锚定到当前默认窗口位置**（按当前 `contextCount` 计算），而不是移除锚点。理由：非空已初始化 topic 恒有且仅有一个锚点（CW-3），「取消锚定 / anchorless」不是合法状态；该交互返回当前默认窗口位置（I-7）。
- UI 高亮必须反映同一锚点（CW-6）：被高亮的 turn 与 TokenCount、边界分隔线、模型请求解析自同一持久化锚点。

---

## 9. 删除与分支行为（Deletion and Branch Behavior）

**确定性删除转移（CW-4）**，规则与现状纯函数 `transferAnchorOnDeletion` 一致，作为确定性契约：

- 锚点组仍在删除后的组列表中 → 锚点不动。
- 锚点组被删除 → 转移到**更旧一侧的前一组**（原位置前一组的相对索引）。
- 被删的是首组 → 转移到删除后的新首组。
- 删除后 topic 为空 → 锚点移除（空 topic 无锚点，I-1）。

**删除非锚点 turn**：锚点相对位置不动（I-6）。

**分支继承（CW-4）**：topic 分支创建时，新分支**确定性继承**父 topic 的锚点；该动作不使用 `contextCount` 重新推导，也不使任何已初始化 topic 无锚点。确切映射（CW-FIX-1，实现契约）：以父锚点在父 group list 中的**索引**映射进分支 group list——

- 分支为空 → 无锚点（空 topic 无锚点，I-1）。
- 父锚点缺失或无效（非 active、父 list 中不存在该 group key）→ 分支不继承；**非空分支必须立即获得锚点**（按 §6 默认位置建立），不允许已初始化的非空分支保持无锚点。
- 索引在分支范围内（`index < branchGroups.length`）→ 锚点 = 分支 group list 同索引组。
- 索引超出分支范围（分支是父 list 的严格前缀）→ **钳制到分支最后一个可用组**（最近可用前驱），而非放弃继承。

---

## 10. 兼容性修复（Compatibility Repair）

- **触发条件**：非空 topic 无锚点——即遗留数据（旧版 `contextStartOverride` 表达、无锚点的历史/导入数据）。
- **触发时机**：topic 消息成功载入 Redux 后（`loadTopicMessagesThunk`）——**包括缓存命中路径**（消息已在 Redux 中的非空缓存 topic，如分支克隆预填充）与取数路径；**空缓存 topic 不触发**（落入取数路径，仍为空则保持无锚点）。
- **行为**：以当前 `contextCount` 在默认窗口位置**恰好一次**初始化锚点（CW-5）。
- **约束**：有效锚点**永不重算**（CW-5）；修复幂等（exactly-once）；不得批量改写已有锚点的 topic。
- **现状映射**：`contextStartOverride[topicId]` 中 `{ kind: 'active'; groupKey }` 的 `groupKey` 即锚点值；修复/迁移时字段演进为 `contextWindowAnchor`（§11）。

---

## 11. 持久化与迁移边界（Persistence and Migration Boundary）

- 锚点与 `contextCount` 同属**普通 renderer assistant-settings 持久化**（Redux `assistants` slice + redux-persist），不是 SQLite/Dexie 聊天权威、不是 IPC 聊天存储、不是渲染投影（CW-2/CW-7）。
- 聊天数据权威由 [SQLite migration governance](./sqlite-migration.md) 治理，应用身份由 [Application Identity ADR](./cherry-chat-application-identity.md) 治理；本文档不改变这两个治理域的边界，也不把锚点移入任何聊天权威存储。
- **迁移**：`contextStartOverride` → `contextWindowAnchor` 的字段演进由**迁移测试**覆盖（§13）；**不需要**锚点专用重启 E2E（CW-7）。

---

## 12. 请求与 UI 一致性（Request/UI Consistency）

- 单一解析器（现状 `computeContextInfo` 的演进形态）从**同一持久化锚点 + topic turns** 计算全部消费方：锚点高亮（anchor group key）、TokenCount（current/max）、边界分隔线（`boundaryMessageId`）、模型请求消息列表（CW-6）。
- 任何组件不得自行推导窗口；运行时不存在「动态推导」语义（§6）。锚点缺失只出现在空 topic 或未修复的遗留 topic，由 §6/§10 处理，而非每次调用时重新推导。

---

## 13. 测试与证据契约（Test/Evidence Contract）

- **纯函数单元测试**：默认窗口位置计算、TokenCount 重锚定、删除确定性转移、分支继承、兼容性修复 exactly-once、字段演进迁移（`contextStartOverride` → `contextWindowAnchor`）。
- **组件测试**：TokenCount 点击重锚定、消息锚点控件点击（含「点击已锚定 turn → 返回默认窗口位置」）。删除转移采用双层证据：转移语义（§9 确定性契约）由**纯函数单元测试**确立；删除后的锚点高亮/边界分隔线等 UI 表现由**共享的已解析锚点组件测试**确立——不要求专用的删除转移组件测试。
- **证据层级**：按 `AGENTS.md`「Testing and UI/E2E Evidence」路由；UI 变更的渲染/交互验证经 `ui-verify-change`。**不要求**锚点专用重启 E2E（CW-7）。

---

## 14. 非目标（Non-goals）

- **不恢复 fixed/sliding 双模式**（CW-8）：只有一种模型——稳定锚点到末尾。
- 不把锚点移入聊天权威存储（SQLite/Dexie/IPC）；不改变身份与 SQLite 迁移治理边界。
- 不做 message 粒度（非 turn）锚定；窗口一律按整 turn 选取。
- 不做启动/渲染/增长导致的自动锚点移动，不做静默锚点重算，「动态推导」不作为运行时语义。
- 本文档不重复架构细节与实现位置（见 `AGENTS.md` 与 `docs/architecture.md`）。

---

## 15. 验收标准（Acceptance Criteria）

- **AC-1**：本文档完整覆盖 CW-1…CW-8 决策表、状态与不变量（§4）、领域迁移表（§5）及全部六个领域章节（§6–§11）、一致性（§12）、测试契约（§13）、非目标（§14）。
- **AC-2**：全文内部一致——目标模型只用 stable anchor-to-end；「动态推导」仅出现于遗留现状与兼容性修复语境（§1/§6/§10/§14），不存在矛盾或滑窗（sliding）语言。
- **AC-3**：`docs/architecture.md` 治理段落与 Redux `assistants` 行链接本文档，且不复制决策表。
- **AC-4**：`AGENTS.md` Detailed References 含单条链接；既有 MUST/NEVER/gate/security 规则零改动；`CLAUDE.md` 仍为 `AGENTS.md` 的符号链接。
- **AC-5**：本会话仅新增 `docs/context-window.md`、修改 `docs/architecture.md` 与 `AGENTS.md`；`docs/performance-program.md` 与 chatDb benchmark 文件的既有工作树改动保持原样。
