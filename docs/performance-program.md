# Cherry Chat 性能工程（Performance Engineering）— 稳定方法论入口

> **文档状态**：本文件是性能工程工作的**稳定方法论入口**——非 ADR，不新增任何架构/身份/数据/发布/治理权威（PERF-LOCK-001）。
> **定位**：本文件是**稳定的方法论**，不是活性跨会话上下文、不是会话交接文档、不是变更日志、不是证据仓库（DOC-003）。本文件是**证据比例与路由的 canonical**（proportionality/routing）；`performance-measurement.md` 拥有**形式化测量机制**；`performance-workstreams.md` / `progress-tracker.md` 为**可变当前态投影**。
> **Git 拥有历史**：会话流水、重复运行叙述、瞬时 artifact 路径、校验和清单与逐日期变更明细**一律不进本套文档**，由 Git 历史承担（DOC-002）。本套文档只保留**持久、可验证、可行动**的内容。

## 1. 定位与非目标（Purpose / Non-goals）

### 1.1 目的

1. 提供性能工程工作的**稳定方法论**：放大优先优先级、假设驱动生命周期、证据比例与任务契约、状态词汇、证据原则、完成/关闭规则、ADR 触发。
2. 固定**三份权威文档**的分工，避免单一巨石文档（DOC-001）。
3. 明确**测量完成 ≠ 产品问题关闭**：Done 要求已接受的用户可见结果、需要时的集成实现，与匹配边界的回归证据（DOC-004）。
4. 明确**产品收益领先、证据比例适配**：合规选项中产品收益与用户体验领先选择；证据成本随风险/不可逆性/不确定性/复用度伸缩；每个证据任务绑定命名决策/断言/方法/停止条件。

### 1.2 非目标

- **不是 ADR**：不锁定架构/身份/数据/发布/平台决策；遇到此类需求走 §9 ADR 触发。
- **不是历史/变更日志**：Git 拥有历史（DOC-002）；本套文档不保留会话流水、校验和、日期明细、重复运行叙述。
- **不是活性跨会话上下文或交接**：不承诺"新会话从本文件恢复状态"（DOC-003）；会话恢复靠 Git 历史 + 本套稳定文档，而非交接段。
- **不替代既有治理**：身份/SQLite 聊天权威/迁移/兼容/隐私/生产构建 E2E 治理由 §2 链接的治理文档保持权威（DOC-006）。
- **不含可变的证据块/校验和/规模曲线数据点**：当前可行动状态在 `performance-workstreams.md`；持久测量契约在 `performance-measurement.md`。

## 2. 治理链接与权威边界（Governance Links）

| 治理领域 | 权威文档 | 本程序的边界 |
|---|---|---|
| 应用身份 / 兼容域 / 发布冻结 / 平台范围 | [`docs/cherry-chat-application-identity.md`](./cherry-chat-application-identity.md) | 不改变；涉及即触发 §9 ADR |
| SQLite 聊天权威 / L1 运行时 / L2 兼容导入 / L3 备份恢复 | [`docs/sqlite-migration.md`](./sqlite-migration.md) | 不改变；迁移/原子性/兼容语义涉及即触发 §9 ADR |
| 架构参考（进程职责、IPC、目录、技术栈） | [`docs/architecture.md`](./architecture.md) | 作为理解与测量的上下文；不修改 |
| 根代理规则 / 发现路径 | 根 [`AGENTS.md`](../AGENTS.md) | 只保留本文件的发现链接；易变状态不进 AGENTS.md |

既有身份/SQLite/迁移/兼容/隐私/生产构建 E2E 治理**全部保持不变**（PERF-LOCK-002、DOC-006）；本程序不创建新的 ADR 权威。

## 3. 三文档分工（Document Responsibilities）

| 文档 | 责任 | 权威边界 |
|---|---|---|
| **本文件** `performance-program.md` | 方法论入口：定位/非目标、治理链接、放大优先、证据比例与任务契约、假设驱动生命周期、状态词汇、证据原则、完成/关闭规则、ADR 触发、Git 拥有历史 | 方法论与生命周期（稳定）— **证据比例/路由与任务契约的 canonical** |
| [`performance-measurement.md`](./performance-measurement.md) | 持久测量契约：固定工具链/lane、证据层级 L1–L4、schema v1 封闭集契约与代码位置、artifact 存储/隐私/保留、规模维度/Profile、harness 清单/命令、阈值策略；通用保障（隐私/真实上下文与溯源/不虚构基线·阈值·根因、适用运行时 lane）始终强制，形式化机制（schema v1 / 产物发射/存储/保留 / 形式化产物元数据与溯源封装）仅在显式选择的形式化定量/可复用测量契约时强制 | 测量契约（稳定）— **通用保障始终强制，形式化机制仅在显式选择的形式化定量/可复用产物时强制** |
| [`performance-workstreams.md`](./performance-workstreams.md) | 当前可行动状态：开放工作流、证据、有界成本模型/假设、明确未知项、下一实验/分析目标、验收框架；产品问题状态与测量切片状态分离；证据-only 工作仅在绑定显式激活的决策/结果且齐备四要素时方可记为进展 | 当前可行动状态（可变）— **证据-only 默认不计进展** |

本文件是**主发现入口**（DOC-007）：从根 `AGENTS.md`「Detailed References」链接到本文件，再由本文件链接到测量契约与工作流状态。

## 4. 放大优先方法论（Amplification-First）

性能问题一律先做**放大分析**（成本如何被放大），再做测量与修复。一条用户可感知路径的成本建模为四个因子的乘积：

**耗时 × 频率 × 数据规模 × 所在线程**

- **耗时（duration）**：单次操作本身的成本（候选成本载体见 `performance-workstreams.md` 各工作流的有界成本模型）。
- **频率（frequency）**：该操作在真实会话中出现的次数；高频低耗时与低频高耗时不可同日而语。
- **数据规模（scale）**：成本随哪个规模轴增长——话题消息数、FTS 语料、DB 体积、流长度、可见窗口、并发度（§5 规模维度，见 `performance-measurement.md`）；**跨级别结论不得直接外推**。
- **所在线程（thread/process）**：成本落在哪个执行环境——renderer 主线程阻塞直接造成卡顿；Main 进程串行 IPC 与 SQLite 写入进入持久化路径；异步路径延迟可见但不等价。

四因子乘积决定放大系数，也决定测量与修复的优先级（PERF-LOCK-004：优先级 = 用户影响 ×（时长、频率、规模曲线、阻塞线程/进程））。

**证据链（evidence chain）**——从用户症状到稳定回归的六个环节，缺环不得跳级断言：

1. **用户症状** → L4 用户报告，不当作事实。
2. **静态/线程分析** → 定位实际操作路径与所在线程/进程（诊断性/静态证据，非 L1）。
3. **操作/查询计划** → 逐操作成本画像：IPC 次数、SQL 计划、O(M×N) 排序、全话题重算、窗口 fanout。
4. **受控规模微基准** → 确定性语料上按测量契约测量（Node lane；结构不变量为 L1、数值为 L3 候选）。
5. **生产构建交互** → 集成 UI 契约走 fresh 生产构建 Playwright E2E（PERF-LOCK-005，L1 集成契约证据）。
6. **稳定回归** → 只有已提交阈值/断言可进入 gate（当前唯一：冷开 `<500ms`）；其余数值保持暂定。

清单任一环节缺失，结论只按已建立证据分层表述，不升级（PERF-LOCK-003、§7）。

## 4A. 高流战术循环（High-Flow Tactical Loop）

**证据链是断言升级要求，不是强制串行工作队列。** 证据链的六个环节定义的是：当要升级断言强度（从方向性到已验证回归）时，必须具备哪些证据环节。它不要求每次实验都从头走完全部环节——尤其是 renderer 安全区内的可逆候选实验，可以在更轻量的证据门槛下快速验证或否决。

### 高流战术循环定义

适用于 renderer-only presentation/local-state 安全区内的候选探测（不跨越 §9 列出的治理边界）：

```
(1) 追踪用户关键代码路径/设计
(2) 通过静态分析短列 1–3 个高置信度放大候选
(3) 实现最小可逆单变量实验（renderer 安全区内直接执行）
(4) 使用最廉价的充分聚焦测试/计数/观察证明实际工作消除与用户可见方向
(5) 保留或完全回退
(6) 在集成/保护边界批量执行生产 E2E 与聚合 gate，而非每个实验前执行
```

**关键语义**：
- **(3) 的"直接执行"**仅限 renderer-only presentation/local-state 安全区——不跨越 §9 任一治理边界。跨越任何边界仍停止并走 ADR（PERF-LOCK-008）。
- **(4) 的"最廉价充分证据"**指：能证明方向的最小证据——count/counter、focused render/mount 计数、单次 user-visible 端点观察——不要求完整基准链或生产 E2E 作为前置条件。
- **(6) 的批量 gate**在以下时机执行：候选已被保留（非回退）、进入集成阶段、或跨越保护边界。不要求每个候选实验前执行全量验证。
- 不允许：无边界的 speculative bulk memoization/optimization sweep、声称证据升级（§7 证据层级不变）。

### 工业级归因的正当条件

以下情况应诉诸完整证据链与工业级归因，而非高流循环：

1. 候选之间无法通过静态分析区分主次。
2. 变更跨越时钟/进程边界（如 Main/IPC/SQLite）。
3. 实验结果仍然模糊——无法判断方向。
4. 回归风险高（跨 authority/persistence/contract 边界）。
5. 持久度量契约本身就是交付物。

### 工作流内子活动

同一 Approved/Active 工作流下可定义多个子活动（candidate probes），各子活动独立执行高流循环。Active 唯一性保持在**父工作流层级**——子活动的独立探测不违反 Active 唯一性约束。子活动默认顺序执行；仅在 isolated worktree/build/disposable profile 且 writes/instrumentation 不重叠时允许并行。并行隔离的具体执行规则由 strategic-orchestration skill 或等效协调机制管辖。

## 4B. 证据比例与任务契约（Proportional Evidence & Evidence-Task Contract）

本节为本文件的 canonical 证据比例/路由与任务契约；`performance-measurement.md` 的形式化机制（schema v1 / 产物发射/存储/保留 / 形式化产物元数据与溯源封装）仅在显式选择的形式化定量/可复用场景时强制，通用保障（隐私/真实上下文与溯源/不虚构基线·阈值·根因、适用运行时 lane）始终强制。

- **产品收益领先**：合规选项中产品收益与用户体验领先选择。
- **证据服务决策**：证据服务于决策，证据生产本身不是交付物。
- **三个独立、不可互换轨道**：
  1. **决策证据（Decision evidence）** — 绑定命名决策/结果、具体断言、最小充分方法与停止条件；成本随风险、不可逆性、不确定性、预期复用度伸缩。
  2. **实现回归证据（Implementation regression evidence）** — 与变更边界匹配；证明变更不回退受保护契约（见 AGENTS.md Change Propagation；匹配边界的 `pnpm test` / E2E / 观察）。
  3. **聚合交付验证（Aggregate delivery validation）** — `pnpm build:check` 为唯一权威聚合 gate（精确 worktree 状态；docs-only 例外见 AGENTS.md Validation gates）。
- **每个证据任务绑定四要素且需显式激活**：仅当绑定显式激活的决策/结果（explicitly activated decision/outcome）并齐备四要素（命名决策/结果、具体断言、最小充分方法、停止条件）时，证据执行方可计为有效/进展；显式激活本身不足 — 缺任一要素即不计为有效/进展。无显式激活或缺要素的证据-only 工作默认**不计为进展**，不关闭阶段/工作流。
- **最小充分证据**：从风险/不可逆性/不确定性/复用度推导所需证据量；可逆 renderer-local 预设可用保守初值 + 聚焦回归证据 + 用户可见观察 + 回滚，无需定制测量基建。
- **停止条件**：达到绑定断言的判定阈值、证伪、或 Main/用户显式接受残余风险；停止条件在任务启动时声明，满足即停止，不因 harness 完整性继续。
- **通用保障与形式化边界**：通用保障（隐私/真实上下文与溯源/不虚构基线·阈值·根因、适用运行时 lane）适用于一切证据活动；形式化机制（schema v1 / 产物发射/存储/保留 / 形式化产物元数据与溯源封装）仅在**显式选择的形式化定量断言或可复用测量契约**时强制（`performance-measurement.md`）；可逆预设不默认要求形式化 artifact。
- **证据-only 不默认进展**：未绑定显式激活的决策/结果或缺任一要素的证据-only 工作（harness/校准/探测）不自动推进 Phase/工作流；仅当服务于显式激活的决策/结果且四要素齐备时方可记为进展。

## 5. 假设驱动生命周期（Hypothesis-Driven Lifecycle）

每个工作流沿以下生命周期推进；每步分配稳定 ID（`performance-workstreams.md`）并伴随对应证据：

```
Problem Open → Cost Model → Attributed → Candidate → Experiment → Integrated → Protected → Done
```

| 阶段 | 含义 | 进入证据 |
|---|---|---|
| **Problem Open** | 用户可见问题已登记，未解决；保持开放直到关闭条件满足 | L4 用户报告或代码证据 |
| **Cost Model** | 有界的代码级成本模型/假设（不声称根因） | 静态调查、§4 放大分析 |
| **Attributed** | 成本已定位到具体操作/线程/规模轴 | 受控微基准或归因测量（L3/L1 gate） |
| **Candidate** | 存在候选实现，未经实验验证 | 代码审查、静态分析 |
| **Experiment** | 候选实现以实验形式验证收益 | 生产构建 E2E 对比、受控基准 |
| **Integrated** | 候选实现被采纳并集成 | 集成实现 + 相关测试 |
| **Protected** | 有已提交阈值/回归证据防止回退 | 常规测试或 E2E 断言 |
| **Done** | 关闭条件全部满足 | 见 §8 |

**关键语义**：状态只进不退需显式决策；生命周期内任何一步失败即回退到先前阶段重新定位，**测量完成（Experiment 结束）不自动到达 Done**。

## 6. 状态词汇（Status Vocabulary）

工作流与生命周期统一使用以下状态，避免自由措辞：

| 状态 | 含义 | 适用对象 |
|---|---|---|
| `Open` | 用户可见问题未解决；保持开放 | 产品问题、工作流 |
| `Active` | 当前正在执行；同一层级唯一 | 工作流 |
| `Paused` | 暂停，恢复条件已记录 | 工作流 |
| `Planned` | 已列入方向草案，范围未批准 | 工作流（提案） |
| `Approved` | 范围已由用户/Main 批准，ID 与优先级锁定 | 工作流 |
| `Blocked` | 阻塞，原因与归属已登记 | 工作流 |
| `Locked` | 决策已锁定，本程序不可单方面改变 | 决策规则（测量契约） |
| `Done` | 关闭条件全部满足（§8） | 工作流、生命周期 |
| `Retired` | 被取代或撤销，保留历史记录 | 决策、工作流 |

**产品问题状态与测量切片状态分离**：一个产品问题可保持 `Open`，而其若干测量切片各自为 `Done`（测量完成不关闭产品问题，DOC-004）。`Open` 的产品问题在 `performance-workstreams.md` 中持续登记。

## 7. 证据原则（Evidence Principles）

证据类型不可互换（PERF-LOCK-003）。判断回归、验收、优先级时引用证据；完整层级与定义见 [`performance-measurement.md`](./performance-measurement.md) §2。本文件拥有比例/路由 canonical；通用保障（隐私/真实上下文与溯源/不虚构基线·阈值·根因、适用运行时 lane）始终适用，测量契约的形式化机制（schema v1 / 产物发射/存储/保留 / 形式化产物元数据与溯源封装）仅在显式选择的形式化定量/可复用场景强制。

- **通用保障适用于一切证据活动**：隐私（不记录内容/凭据/路径/原始 DB 体积）、真实上下文与溯源、不虚构基线/阈值/根因、适用运行时 lane — 适用于一切证据活动，无论是否形式化（PERF-LOCK-006/007, PERF-LOCK-003, DOC-002）。
- **三轨道不可互换**（见 §4B）：决策证据、实现回归证据、聚合交付验证 — 三者用途、方法、停止条件分离，不可互换。
- **L1 仓库可验证回归证据**：唯一可进入"已验证"的实现回归证据。用于集成契约级/结构级回归判断；需匹配所跨边界。
- **L2 诊断性证据**：仅用于问题定位（`ui:observe`、CDP、截图），不构成回归或验收判断。
- **L3 手工基准证据**：仅用于方向判断；须按测量契约重测确认后方可升级为决策证据。
- **L4 用户报告历史结果**：不可作为当前基线。
- **比例原则**：证据成本与方法随风险/不可逆性/不确定性/复用度伸缩；可逆 renderer-local 预设用保守初值 + 聚焦回归 + 用户可见观察 + 回滚即可，不默认要求形式化 artifact。
- **形式化机制条件性**：schema v1 / 产物发射/存储/保留 / 形式化产物元数据与溯源封装 仅在显式选择的形式化定量断言或可复用测量契约时强制（`performance-measurement.md`）；通用保障（隐私/真实上下文与溯源/不虚构基线·阈值·根因、适用运行时 lane）仍适用于一切证据活动；其余场景按 §4B 最小充分证据执行。
- **与边界匹配**：证据须与所跨边界匹配（AGENTS.md「Evidence and Judgment」）；可逆预设与形式化定量分流。

一次生产构建 E2E 运行可同时产生 **L1 确定性证据**（正确性 gate、结构断言、退出码）与 **L3 暂定数值**（p50/p95 等机器可读输出）——两者并存但不可互换。证据须与所跨边界匹配（AGENTS.md「Evidence and Judgment」）。

### 7A. 架构演进交接规则（Architecture Evolution Handoff）

当性能证据暴露的结构性债务需要变更**所有权、生命周期或数据契约**时，该工作进入 [Architecture Evolution Program](./architecture-evolution-program.md) 而非继续在性能补丁循环中扩展。具体规则：

- **触发条件**：性能工作流中出现以下任一情况——变更涉及运行时职责/权威移动、持久化/迁移语义变更、生命周期/多窗口/原生能力变更、兼容语义变更——即停止实现，走 ADR 决策点（PERF-LOCK-008），并将工作交由架构演进程序接管。
- **架构-性能政策（ARCH-009..011 镜像）**：架构重构追求结构更优且自然更快；性能测量记录重构的自然结果——架构推进不以绝对性能指标/阈值为常规门槛，也不要求直接的自然性能提升方可前进（ARCH-009）。但在受控同态对比（controlled same-state comparison）下可复现的实质性回退（material degradation）是对架构正确性的反证，必须在阶段退出前完成归因与处置：修复、经论证接受的权衡，或保持阶段 Open（ARCH-010）。剩余性能问题作为独立的重基线/重评估性能工作在重构后另行处置；架构关闭不等同于关闭 PERF 产品问题（ARCH-011）。
- **工作流重分类**：PERF-TOPIC-SWITCH 和 PERF-ECHO 为**架构重构后的独立参考/重评估工作流**（`performance-workstreams.md` §2.1/§2.3），保持 **Open 且不阻塞架构阶段关闭**（ARCH-011）；均为 **L3 方向性参考**，按 ARCH-012 保留溯源且不被重标为阈值/基线；由于不存在受控同态前后对比，不作改进/回退断言。
- **已取代**：PERF-RENDER-FLOW 的战术候选队列已被架构演进程序取代（`performance-workstreams.md` §2.5）。
- **性能程序不成为架构权威**：性能工作流提出方向和证据，架构决策权属于架构演进程序和 ADR 流程。
- **B-01..B-05 状态**：B-01..B-05 为**已实现的 renderer-local 保留策略强制/默认值**（max 8 inactive evictable topics、32 MiB logical budget、30-minute TTL、deterministic LRU/lexical tie-break、oversized fail-closed 且解钉后可驱逐），非经验最优、非基线/SLA/阈值/容量策略；校准 harness 可选、非阻塞、测量仅方向性/合成隔离；Phase 4 已于 2026-08-29 关闭（outcome/residual-risk）。

## 8. 完成与关闭规则（Completion / Closure Rules）

1. **测量完成不关闭产品问题**（DOC-004）：`Experiment` 结束、`Done` 的测量切片，不代表其对应的用户可见问题已解决。
2. **三轨道分离**：决策证据、实现回归证据、聚合交付验证为独立轨道，不可互换（§4B §7）。
3. **Done 的关闭条件**：
   - **已接受的用户可见结果**（用户/Main 接受该问题已按预期解决，或显式接受为未复现/不可证伪并保持 Open）；
   - **需要时集成实现**（若根因归属后需要修复，候选实现已集成）；
   - **匹配边界的回归证据**（Protected 阶段已建立相应断言/E2E，边界匹配）。
4. **聚合验证强制**：精确 worktree 状态的 `pnpm build:check` 为唯一聚合 gate；docs-only 例外见 AGENTS.md Validation gates。
5. **条件性可观测性不阻塞关闭**：Phase 4 及其他阶段的条件性可观测性/工作集度量与 B-01..B-05 校准为可选、非阻塞；除非绑定显式激活的决策/结果或形式化定量/可复用契约，否则不作为阶段关闭门槛。Harness 完整性本身不关闭阶段/工作流。
6. **未解决的用户可见问题保持 Open**：topic 切换、流式/多模型输出、消息回显当前为 Open 产品问题（`performance-workstreams.md`），其既有 PERF-101/102/103 测量资产仅是**证据**，不是关闭。架构重构后的剩余问题另行重基线/重评估，架构关闭不关闭它们（ARCH-011）。
7. **不把 L3 数值当作阈值/根因**：除非经显式校准决策并提交阈值，否则数值保持暂定（PERF-LOCK-003；唯一已提交阈值见测量契约 §7）。L3 方向性参考保留溯源且不被重标为阈值/基线（ARCH-012）。
8. **受控回退挑战规则（ARCH-010）**：常规阶段不以绝对阈值为门槛（ARCH-009），但在受控同态对比下可复现的实质性回退属于架构正确性反证，必须在退出前完成归因与处置（修复 / 经论证接受的权衡 / 保持 Open），否则不得关闭。
9. **显式残余风险接受**：关闭要求 Main/用户对残余风险的显式接受；harness 完整性不关闭阶段/工作流。
10. **证据任务停止条件与四要素门槛**：每个证据任务在启动时声明停止条件（判定阈值/证伪/接受）；仅当绑定显式激活的决策/结果且齐备四要素时方可计为有效/进展；满足停止条件即停止，不因 harness 完整性继续。
11. **关闭不自动激活**任何新工作流：后续激活须 Main/用户显式授权（显式激活的决策/结果，Active 同一层级唯一）。

## 9. ADR 触发条件（ADR Triggers）

以下任一情况在性能工作中出现时：**停止实现，回 Main，先建立 ADR 决策点，再继续**（PERF-LOCK-008）：

1. 运行时职责/权威移动（如聊天权威离开 Main 进程 SQLite）。
2. 持久化或迁移语义变更（schema、原子性、回滚、版本化、`sqlite-migration.md` 治理面）。
3. 生命周期 / 多窗口 / 原生能力变更。
4. 遥测隐私边界变更（诊断记录范围超出 PERF-LOCK-006）。
5. 兼容语义变更（Cherry Studio 兼容导入、FTS/搜索正确性、身份/兼容标识）。
6. 平台 / 发布范围变更（macOS-arm64-first 之外或发布冻结面）。
7. 性能优化建议本身要求上述变更——先 ADR 后实现，不得以性能为名绕过治理。

### 9A. Renderer 安全区（Renderer Safe-Zone）

Renderer-only presentation/local-state 变更，只要不跨越以下任一边界，不需要 ADR：

- 运行时职责/权威移动（§9.1）
- 持久化或迁移语义变更（§9.2）
- 生命周期/多窗口/原生能力变更（§9.3）
- 遥测隐私边界变更（§9.4）
- 兼容语义变更（§9.5）
- 平台/发布范围变更（§9.6）

**安全区内的操作**包括但不限于：React 组件 memo 策略调整、selector 粒度优化、渲染子树结构重排、projected array identity 稳定化、effect/subscription fanout 缩减——只要这些改动不改变以上任何边界的语义。此类可逆预设适用 §4B 最小充分证据（保守初值 + 聚焦回归 + 用户可见观察 + 回滚），不默认要求形式化测量基建。

跨越上述任一边界仍须停止并走 ADR（PERF-LOCK-008），不论变更幅度大小。

## 10. 相关文档

- **测量契约（持久）**：[`performance-measurement.md`](./performance-measurement.md) — 固定工具链/lane、证据层级、schema v1、artifact 存储/隐私/保留、规模维度、harness 清单、阈值策略；**通用保障与适用运行时 lane 始终强制，形式化机制（schema v1 / 产物发射/存储/保留 / 形式化产物元数据与溯源封装）仅在显式选择的形式化定量/可复用契约时强制**。
- **当前可行动状态（可变）**：[`performance-workstreams.md`](./performance-workstreams.md) — 开放工作流（PERF-TOPIC-SWITCH / PERF-STREAMING / PERF-ECHO）、证据、有界成本模型/假设、未知项、下一实验目标、验收框架；**证据-only 默认不计进展，除非绑定显式激活的决策/结果且齐备四要素**。
- **架构演进程序**：[`architecture-evolution-program.md`](./architecture-evolution-program.md) — 架构正确性/优雅性/统一性引领；性能债务交接入口；Phase 3 基于结构/治理/功能证据关闭（ARCH-009/ARCH-010），PERF-TOPIC-SWITCH/PERF-ECHO 重分类为独立重构后参考/重评估工作流（ARCH-011，Open 非阻塞）；测量溯源按 ARCH-012 保留为方向性 L3（Git 拥有 provenance）；**B-01..B-05 已实现为 renderer-local 保留强制/默认值（max 8 inactive evictable topics、32 MiB logical budget、30-minute TTL、deterministic LRU/lexical tie-break、oversized fail-closed 且解钉后可驱逐），非经验最优/非基线/SLA/阈值/容量策略，校准可选非阻塞、测量仅方向性/合成隔离，Phase 4 已于 2026-08-29 关闭（outcome/residual-risk）**。
- **治理**：[`sqlite-migration.md`](./sqlite-migration.md)、[`cherry-chat-application-identity.md`](./cherry-chat-application-identity.md)、[`architecture.md`](./architecture.md)。
- **根代理规则**：根 [`AGENTS.md`](../AGENTS.md)「Detailed References」发现本文件。
