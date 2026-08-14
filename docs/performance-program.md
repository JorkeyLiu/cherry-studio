# Cherry Chat 性能优化项目（Performance Program）— 活性跨会话上下文

> **文档状态**：Active（活性程序上下文文档，非 ADR；本文件是性能优化工作的单一事实源）
> **最后更新**：2026-08-14
> **Owner**：Personal fork（jorkeyliu）
> **分支**：`jorkey/integration`
> **定位**：本文件是**活性（living）程序上下文**，用于让性能优化工作在任意新会话中可恢复、可交接。它不是 ADR，不新增任何架构/身份/数据/发布权威（PERF-LOCK-001）；既有治理由本文件的治理链接指向的文档保持权威。
> **关联**：治理文件——[`docs/sqlite-migration.md`](./sqlite-migration.md)（SQLite 聊天权威与 L2/L3 迁移治理）、[`docs/cherry-chat-application-identity.md`](./cherry-chat-application-identity.md)（身份/兼容/发布/平台治理）、[`docs/architecture.md`](./architecture.md)（架构参考）；发现路径——根 [`AGENTS.md`](../AGENTS.md)「Detailed References」链接到本文件。

---

## 1. 定位与非目标（Purpose / Non-goals）

### 1.1 目的

1. 提供性能优化工作的**跨会话单一事实源**：当前阶段、基线、证据、工作流、交接段都在此维护，新会话从本文件恢复，不依赖历史会话记忆。
2. 把**仓库可验证的事实**与**用户报告的历史结果**严格分开（PERF-LOCK-003、§6、§9、§10），杜绝把不可复现的数值当作当前基线。
3. 为每个工作流（§12）提供稳定的 ID、边界、验收与交接（§16），保证任意时刻存在**下一个可执行单元**。
4. 明确性能优化的优先级框架（PERF-LOCK-004）与证据门槛（PERF-LOCK-005/006/007），使决策可复现、可审计。

### 1.2 非目标

- **不是 ADR**：不锁定任何架构/身份/数据/发布决策；遇到此类需求走 §13 ADR 触发。
- **不是基准结果仓库**：大体积数据不提交到本仓库（PERF-LOCK-007、§5、PERF-001 结果策略）。
- **不是变更日志**：只记录程序状态与交接，不记录每次代码改动（代码改动由 git 与常规测试承担）。
- **不替代既有治理**：SQLite 聊天权威、迁移原子性、FTS/搜索正确性、Cherry Studio 兼容导入、发布冻结、平台范围均由既有治理文档保持权威（PERF-LOCK-002）。
- **不包含用户报告数值**：数值仅在 §10 以历史证据形式注明，不作为当前基线（PERF-LOCK-003）。

### 1.3 放大优先方法论（Amplification-First Methodology）

性能问题一律先做**放大分析**（成本如何被放大），再做测量与修复。中心放大原则把一条用户可感知路径的成本建模为四个因子的乘积：

**耗时 × 频率 × 数据规模 × 所在线程**

- **耗时（duration）**：单次操作本身的成本（§10.2 静态调查给出各热点路径的候选成本载体）。
- **频率（frequency）**：该操作在真实会话中出现的次数（如每次粘贴 M 条、每次答案标签切换、每次话题切换）。高频低耗时与低频高耗时不可同日而语。
- **数据规模（scale）**：成本随哪个规模轴增长——话题消息数、FTS 语料、DB 体积、流长度、可见窗口、并发度（§8 多维矩阵）。**跨级别结论不得直接外推**。
- **所在线程（thread/process）**：成本落在哪个执行环境——renderer 主线程阻塞直接造成卡顿/不可交互；Main 进程串行 IPC 与 SQLite 写入进入持久化路径；异步路径延迟可见但不等价。**所在线程决定成本的可感知形态**。

四因子乘积决定该路径的放大系数，也决定测量与修复的优先级（承接 PERF-LOCK-004：优先级 = 用户影响 ×（时长、频率、规模曲线、阻塞线程/进程））。

**证据链（evidence chain）**——从用户症状到稳定回归的六个环节，每个环节对应 §6 的既有证据层级，缺环不得跳级断言：

1. **用户症状（user symptom）** → 记录为 L4 用户报告（§10.1），不当作事实。
2. **静态/线程分析（static/thread analysis）** → 定位实际操作路径与所在线程/进程（§10.2，诊断性/静态证据，非 L1）。
3. **操作/查询计划（operation/query plan）** → 逐操作成本画像：IPC 次数、SQL 计划、O(M×N) 排序、全话题重算、窗口 fanout（§10.2 既有静态结论）。
4. **受控规模微基准（controlled scale microbench）** → 在确定性语料上按 §5 测量（Node lane，结构不变量为 L1、数值为 L3 候选）。
5. **生产构建交互（production-build interaction）** → 集成 UI 契约走 fresh 生产构建 Playwright E2E（LOCK-005，L1 集成契约证据）。
6. **稳定回归（stable regression）** → 只有已提交阈值/断言可进入 gate（当前唯一：冷开 `<500ms`）；其余数值保持暂定预算（§7）。

**放大器评审清单（amplifier-review checklist）**——任何被报告/感知的卡顿在测量前先过此清单：

1. 频率：该操作每会话出现多少次？
2. 规模轴：成本随 §8 矩阵的哪个规模轴增长？当前规模点是否只是单一取值的伪结论？
3. 线程：主要成本落在哪个线程/进程，是否阻塞 renderer 主线程？
4. 路径核实：静态调查是否定位到真实操作与查询计划（§10.2），有无未覆盖分支？
5. 受控测量：是否已在确定性语料上按 §5 契约测量，并在多个规模点取值（否则只有单一数据点）？
6. 交互确认：用户可感知行为是否经生产构建 E2E 确认（LOCK-005）？
7. 回归决策：该路径是否需要已提交 gate？无 committed 阈值时数值一律保持暂定（§7）。

清单任一环节缺失，结论只按已建立证据分层表述，不升级（PERF-LOCK-003、§6）。

---

## 2. 治理链接与权威边界（Governance Links）

| 治理领域 | 权威文档 | 本程序的边界 |
|---|---|---|
| 应用身份 / 兼容域 / 发布冻结 / 平台范围 | [`docs/cherry-chat-application-identity.md`](./cherry-chat-application-identity.md) | 不改变；涉及即触发 ADR（§13） |
| SQLite 聊天权威 / L1 运行时 / L2 兼容导入 / L3 备份恢复 | [`docs/sqlite-migration.md`](./sqlite-migration.md) | 不改变；迁移/原子性/兼容语义涉及即触发 ADR（§13） |
| 架构参考（进程职责、IPC、目录、技术栈） | [`docs/architecture.md`](./architecture.md) | 作为理解与测量的上下文；不修改 |
| 性能优化程序本身 | **本文件** | 唯一权威（baseline、workstream、handoff、证据分级、暂定预算） |
| 根代理规则 / 发现路径 | 根 [`AGENTS.md`](../AGENTS.md) | 只保留本文件的发现链接；易变状态不进入 AGENTS.md（§15） |

---

## 3. 状态词汇（Status Vocabulary）

本文档与工作流统一使用以下状态，避免自由措辞：

| 状态 | 含义 | 适用对象 |
|---|---|---|
| `Active` | 当前权威 / 正在执行；同一层级唯一 | 本文档、工作流 |
| `Done` | 交付完成，且证据按 §6 记录（引用 §9/§11/§12） | 工作流、基线 |
| `Paused` | 暂停，交接段已记录恢复点（§16） | 工作流 |
| `Planned` | 已列入 ID 保留与方向草案，范围未批准 | 工作流（提案） |
| `Approved` | 范围已由用户/Main 批准，ID 与优先级已锁定；尚未进入 Active（等待使能切片或执行顺序） | 工作流 |
| `Blocked` | 阻塞，§14 登记阻塞原因与归属 | 工作流 |
| `Locked` | 决策已锁定，本程序不可单方面改变 | 决策锁（§4） |
| `Proposed` | 决策提案，未经治理批准 | 决策锁 |
| `Retired` | 被取代或撤销，保留历史记录 | 决策锁、工作流、基线 |

---

## 4. 决策锁（Decision Locks）

以下决策已由 Main 批准锁定，本程序的所有工作必须遵守；任何挑战须回到 Main，并附证据（见 §14 与本文档维护方）。

| # | 决策 | 状态 |
|---|---|---|
| **PERF-LOCK-001** | 本文件是活性性能程序上下文文档，**不是 ADR**；不新增任何治理权威 | **Locked** |
| **PERF-LOCK-002** | 既有 Cherry Chat 身份、SQLite Main 进程聊天权威、迁移原子性、FTS/搜索正确性、Cherry Studio 兼容导入、发布冻结、平台范围治理**全部保持不变** | **Locked** |
| **PERF-LOCK-003** | 证据分层：仓库可验证回归证据 / 诊断性证据 / 手工基准证据 / 用户报告历史结果，**四类不可互换**（§6） | **Locked** |
| **PERF-LOCK-004** | 性能优先级 = **用户影响** ×（时长、频率、规模曲线、阻塞线程/进程） | **Locked** |
| **PERF-LOCK-005** | 集成 UI 契约必须用**生产构建 Playwright E2E** 验证；Vitest/静态检查/诊断不能替代 | **Locked** |
| **PERF-LOCK-006** | 诊断**有界**：不记录消息内容、凭据、附件内容、原始数据库大小、路径 | **Locked** |
| **PERF-LOCK-007** | 大规模/profile 级基准为**按需或定时资产**，不进入每次提交 CI；快速确定性正确性/结构性回归进常规测试 | **Locked** |
| **PERF-LOCK-008** | 本阶段不改变架构、持久化、生命周期、遥测隐私、兼容语义；遇到此类需求必须走 §13 ADR 决策点 | **Locked** |

> 本文档新增的方法论（§1.3）、三类暂定预算（§7.1）、多维规模矩阵（§8）与资产保留治理（§11.2）均为本程序**内部的执行约定**，不新增任何治理/ADR 权威；数据库体积维度只记录确定性合成目标体积，不记录观测到的用户/profile 原始 DB 体积（PERF-LOCK-001/006/007 不变）。

---

## 5. 测量契约（Measurement Contract）

所有测量必须满足以下契约，否则结果不进入基线：

1. **固定工具链**：Node 24.11.1 / pnpm 10.27.0（`.nvmrc` / `.node-version` / `package.json`）；任何 `pnpm` 命令前先核对 `node -v` 与 `pnpm -v`。
2. **Lane 契约**：`bench:*` 走 Node lane（ABI 137）；`test:e2e` / `ui:observe` / `build` 走 Electron lane（ABI 145）；结果必须标注所用 lane（AGENTS.md「Native ABI lanes」）。
3. **数据隔离**：基准使用确定性语料与临时数据库，不触碰用户数据（承接 `sqlite-runtime.perf.bench.ts` 的 LOCK-5.4.1；PRAGMA/schema 不指向真实 profile）。
4. **指标与报告**：p50/p95/mean、ops/sec 等数值指标 + 结构性不变量（正确性 parity、零 sibling UPDATE、原子性）。**正确性校验先于计时**，parity 失败即 abort（`search.bench.ts` 既定行为）。
5. **无历史对比值时显式报告**：不得虚构对照基线（`sqlite-runtime.perf.bench.ts` LOCK-5.4.2 声明无历史 Dexie 对比值，输出中显式报告）。
6. **阈值策略**：只有已提交的断言阈值可进入测试/基准 gate（当前唯一：冷库打开 `<500ms`，LOCK-5.4.3）；其余数值一律为**暂定预算**（§7），在重测并记录 artifact 前不当作事实。
7. **机器可读结果**：结果应以机器可读形式输出并存放到策略规定的位置（schema v1 与存放策略见 §5.1）；**大体积数据不提交仓库**（PERF-LOCK-007）。
8. **可复现性标注**：任何基线/证据必须伴随命令、环境（Node/ABI/lane）、日期与结果位置；无法复现的不进入基线。

### 5.1 机器可读结果契约（PERF-001，schema v1）

**Schema**：两个 chatDb 基准（`search.bench.ts`、`sqlite-runtime.perf.bench.ts`）在完整运行结束（全部正确性校验与 gate 通过、且**所有已注册 tinybench 任务成功完成**后，由文件级 `afterAll` 生命周期钩子写入）写一个小体积 JSON summary artifact，顶层字段固定为：

| 字段 | 内容 |
|---|---|
| `schemaVersion` | 固定 `1`（PERF-001 契约版本；变更必须升版并同步更新本文档） |
| `benchmark` | `id`（稳定身份，用于文件名与基线引用）、`name`、`scale`（确定性规模：语料数量/轮次/批量/分页等，全部为有限数值） |
| `environment` | 可复现性元数据：`timestamp`（ISO-8601 UTC，写入前校验格式）、`node`（版本）、`pnpm`（**仅从真实 `pnpm/` UA 解析的 pnpm 版本**；npm/yarn/其他 UA 或缺失时记 `unknown`，绝不把其他包管理器版本标注为 pnpm — 审计 F2）、`abiLane`（`node`/`electron`）、`abi`（`process.versions.modules`，Node=137/Electron=145）、`command`（**显式安全规范命令，必需**；绝不从 argv 派生，写入前校验不得含路径段 — 审计 F3）、`git`（`commit` SHA + `dirty` worktree 脏标记；git 不可用时 commit 为空串） |
| `metrics` | 数值指标数组 `{ id, name, value, unit? }`（p50/p95/p99/mean/min/max/ops-per-sec 等；禁止 NaN/Infinity；`unit` 出现时必须为非空字符串） |
| `gates` | gate 结果数组 `{ id, name, kind: 'correctness'\|'threshold', passed, detail? }`（parity 正确性 gate 与冷开 `<500ms` 阈值 gate 逐条记录；`detail` 出现时必须为非空字符串） |

Schema 为**封闭集**：不包含消息内容、凭据、用户路径、附件内容、原始数据库大小或 profile 数据字段（PERF-LOCK-006/007）；写入前经运行时校验器逐字段验证（未知字段/类型错误/非有限数值/空 unit 或 detail/非 ISO 时间戳/含路径段命令即拒绝并 abort，不产出 artifact），类型级形状由 `src/main/services/chatDb/__tests__/benchResult.ts` 的 `BenchmarkResult` 类型锁定。

**实现**：`src/main/services/chatDb/__tests__/benchResult.ts`（schema 常量、环境/git 元数据收集、运行时校验器、输出路径解析、写入器、**任务完成度门控发射器**）+ `benchResult.test.ts`（聚焦测试：元数据/序列化/路径行为/敏感字段封闭性/**审计 F1–F4 修复**）。

**发射时机（审计 F1）**：artifact 只在**所有已注册 tinybench 任务以 `pass` 状态完成**后写入。两个基准把发射挂到**文件级** `afterAll` 钩子（`emitBenchmarkResultAfterSuccessfulTasks`，在 `describe` 之外注册）——Vitest bench 模式只执行文件级钩子、不执行 describe 级钩子，且抛异常的 bench 任务会被静默吞掉（运行可退出 0、任务停留在 `run` 状态），因此只有显式门控才能保证「artifact 存在 = 完整基准任务运行成功结束」。parity/冷开 gate 失败仍在收集期 abort（既有行为不变），artifact 不会产生。

**命名**：`<benchmark.id>-<YYYYMMDD-HHmmss.SSS>.json`（本地时间，ASCII，可排序，**毫秒级精度**）；自动命名在目标文件已存在时追加 `-1`、`-2`… 后缀，**同秒/同毫秒重复运行不再覆盖**（审计 F4）；显式 `fileName` 按原样使用（与 `ui:observe` 约定一致：显式名可与先前 artifact 同名）。

**默认位置**：`test-results/bench-results/`（仓库根下；`.gitignore` 已覆盖整个 `test-results/`，与 Playwright 输出、`ui:observe` 同一既有 artifact 约定）。

**配置**：环境变量 `BENCH_RESULTS_DIR` 覆盖输出目录；写入器显式 `dir` 选项优先于环境变量。

**保留/提交策略**：artifact 为**本地生成物，绝不提交仓库**；保留到被后续同 id artifact 取代或主动清理；大体积/原始数据（DB 文件、trace、profile）不落仓库（LOCK-007，承载另行约定）。每次完整运行在末尾输出 artifact 绝对路径到 console。**验证通过的测量 artifact 可保留为 gitignored 本地 deliverable**（如 PERF-100 修复前测量，§11/§16 引用其身份与文件名）；session-owned 诊断 artifact 仍不引用路径。

**与 gate 的关系**：parity 失败或冷开 gate 失败时，基准在收集期 abort（既有行为不变）；tinybench 任务任一失败时文件级门控抑制发射——两者共同保证 artifact 只在「全部校验、全部 gate、全部已注册任务」都成功时产生；通过结果仍逐条记录在 `gates` 字段。

**已验证运行（2026-08-13，PERF-001 Validation）**：在 HEAD `3d61027bf2`（worktree dirty=true，按设计）上以固定工具链（Node 24.11.1 / pnpm 10.27.0）执行 `pnpm bench:main:native`（Node lane，ABI 137），退出码 0（含 finalizer）；两个 chatDb 基准均按本契约发射 schema v1 JSON summary，逐字段校验通过、forbidden-field 扫描干净。**证据分层**：parity/冷开 gate/无 abort/退出码 0 为 **L1 仓库命令确定性证据**（§6，可作回归判断）；p50/p95 等数值输出为 **L3 手工基准证据**（§6/§7），按 §7 暂定预算规则**不自动升级为已提交阈值**（唯一已提交阈值仍为冷开 `<500ms`，LOCK-5.4.3）。**Artifact 保留/清理**：本次运行产出的两个 JSON artifact 为**会话持有（session-owned）**——按 §5.1 保留/清理策略在检查后删除，**不是仓库持久化文件**；本文档因此不引用这两个 artifact 的路径，数值证据以本节文字记录为准。**例外（持久本地 deliverable）**：PERF-100 验证通过的测量 artifact 作为 **gitignored 本地 deliverable** 保留（`test-results/` 全目录 gitignored，不提交仓库），由 §11/§16 引用其身份与文件名；其余 session-owned 诊断 artifact 仍不引用路径。

---

## 6. 证据层级（Evidence Hierarchy）

证据类型不可互换（PERF-LOCK-003）。判断回归、验收、优先级时按下表引用证据：

| 层级 | 证据 | 示例 | 能否作为回归判断 |
|---|---|---|---|
| **L1 仓库可验证回归证据** | 在 fresh 生产构建或确定性临时库上，由仓库内命令产生的**确定性断言** | Playwright E2E（fresh 生产构建 + 标准 fixture）；`vitest bench` 内强制 parity 与 gate（`search.bench.ts`、`sqlite-runtime.perf.bench.ts`）；常规测试中的确定性正确性/结构断言 | **是**（集成契约级 / 结构级） |
| **L2 诊断性证据** | 观察性、非断言的运行时信息 | `pnpm ui:observe`、截图、CDP、dev 模式观察 | 否（仅定位，`ui-verify-change` 分类） |
| **L3 手工基准证据** | 本地手动运行基准的 console 报告，未提交为 artifact | 手工 `vitest bench` 的 p50/p95 输出 | 仅可参考，需按 §5 重测确认 |
| **L4 用户报告历史结果** | 无 artifact 支撑的数值/通过声明（提交消息、会话记录） | §10 记录的内容 | **否**（不可作为当前基线） |

规则：L1 是唯一可进入「已验证」的证据；L3/L4 只用于方向判断；L2 用于问题定位。证据与所跨边界匹配（AGENTS.md「Evidence and Judgment」）。

> **L1 运行 + L3 数值并存**：一次生产构建 E2E 运行可同时产生 **L1 确定性证据**（正确性 gate、结构断言、退出码）与 **L3 暂定数值**（p50/p95 等机器可读输出）——PERF-100 修复前测量即为此形态（§11/§16）：gate 全过为 L1 风格确定性证据，数值在未提交阈值前一律按 L3 暂定处理（PERF-LOCK-003、§7）。

---

## 7. 暂定预算（Provisional Budgets — 校准前）

以下为**暂定预算（校准候选）**，仅在对应测量按 §5 契约重测并记录 artifact 后才有资格成为基线；在重测前**一律视为未验证**，不得作为事实引用（PERF-LOCK-003）。**唯一已提交断言阈值**仍为冷库打开 `<500ms`（LOCK-5.4.3）。

### 7.1 三类暂定预算（Provisional Budget Classes）

| 类 | 定义 | 判定基准 |
|---|---|---|
| **交互预算（interaction）** | 单次用户交互的端到端可感知耗时（点击→首帧/完成），阻塞 renderer 主线程 | 感知阈值候选（如回显/切换类目标）；按 §1.3 放大分析衡量频率与规模 |
| **热路径预算（hot-path）** | 高频/持续执行的内部操作（IPC、流式增量、渲染长任务），单次成本低但频率高 | 单次成本与节流比上限候选；放大后不可累积阻塞 |
| **规模预算（scale）** | 随 §8 矩阵规模轴增长的路径成本（全话题计算、DB 体积、FTS 语料、长话题分支） | 多规模点上的增长曲线（曲线/方差/knee 消费，§11.1 差距、§12 PERF-004） |

### 7.2 预算表

| 类 | 指标 | 暂定预算（校准前） | 来源 / 状态 |
|---|---|---|---|
| 交互 | 冷库打开延迟（fresh open + pragmas + migrations） | `<500ms` | **已提交断言阈值**（`sqlite-runtime.perf.bench.ts` LOCK-5.4.3，L1 证据），保持为 gate；2026-08-13 已验证运行实测冷开 p95 = **84.31ms**（L3 数值输出，§5.1）——仅记录为该次运行证据，**不**升级为已提交阈值，重测确认前维持暂定性质 |
| 交互 | 消息加载（全话题 `listByTopic` + `listByMessages`）p50/p95 | 待校准（无已提交对比值；LOCK-5.4.2 声明无历史 Dexie 对比值） | 校准候选；PERF-002 重测后定 |
| 规模 | 批量写入吞吐（batch message+block inserts，ops/sec） | 待校准 | 校准候选；PERF-002 重测后定 |
| 交互 | 健康稠密话题追加零 sibling UPDATE | 结构性不变量（非数值） | 由 `c03a5c392c` 引入 dense-order fast path；结构性不变量已由已提交测试断言（`repositories.test.ts`、`aggregate.test.ts`），仅剩基准校准 |
| 规模 | FTS 搜索（10k 语料 LIKE vs 混合 FTS）p50/p95 | 待校准（`search.bench.ts` 可报告，无绝对阈值） | 校准候选；数值需重跑生成；§8.1 FTS 维度当前仅有 10k 单点 |
| 交互 | 渲染 Markdown 解析节奏 | 150ms（提交内定值） | **代码事实**（`2aeb55760f`），非数值预算；交互可用性由 streaming E2E 验证 |
| 交互 | 流式期间 UI 响应 | streaming-responsiveness E2E（滚动/输入不断流） | 集成契约验证（L1），非数值预算（LOCK-005） |
| 交互 | **回显延迟（echo）** | **target `<50ms` / ceiling `<100ms`** | **已批准参考值（校准候选）**——**未验证、非阈值**；按 §5 重测并记录 artifact 前不得引用为事实（PERF-LOCK-003）；待校准 |
| 热路径 | **Main 进程 IPC 单次往返** | **target `<10ms`** | **已批准参考值（校准候选）**——**未验证、非阈值**；同上，待校准 |
| 热路径 | **流式持久化节流** | **persistence 节流 `<10%`**（流式期间持久化对呈现节奏的拖累上限） | **已批准参考值（校准候选）**——**未验证、非阈值**；同上，待校准 |
| 热路径 | **renderer 主线程长任务** | **无持续性 `>50ms` 长任务**（允许偶发单次，不允许持续阻塞） | **已批准参考值（校准候选）**——**未验证、非阈值**；同上，待校准 |
| 规模 | **300-turn 长话题分支（话题切换/加载）** | **`<1–2s`** | **已批准参考值（校准候选）**——**未验证、非阈值**；同上，待校准；与 §8.1 话题消息数规模轴相关 |
| 交互 | **PERF-100 修复前测量（2026-08-13，L3 暂定）** | 编辑进入 p50 **105.5ms** / 退出 p50 **118.4ms**；粘贴总 p50 **1191.9ms** / 首次插入 **63.9ms** / 稳态逐条 **188.4ms**；答案标签切换 p50 **208.6ms** / foldSettle **142.5ms** / scrollStart **225.4ms** | **L3 暂定数值（非阈值、非基线）**；小样本（5/3/4）下 **p95 = max**；来自验证通过的生产构建 E2E artifact（§11/§16），仅作方向判断，重测与校准前不升级 |
| 交互 | **PERF-100 修复后 answer-tab 多规模点（2026-08-14，L3 暂定）** | answerTab switch p50 quick/s0-20/s0-100 = **94.0 / 272.7 / 1410.4 ms**；foldSettle p50 = **36.3 / 77.6 / 278.4 ms**；scrollStart p50 = **204.4 / 364.9 / 1706.0 ms**；与修复前 C（§16 C）的直接比值 switch **0.401x / 0.441x / 0.305x**、foldSettle **0.228x / 0.189x / 0.086x**、scrollStart **0.808x / 0.539x / 0.320x** | **L3 暂定数值（非阈值、非基线）**；来自 2026-08-14 fresh 生产构建验证的 schema v1 artifacts（§16 F：12/12 gate、35 有限指标、Electron ABI 145、git `ded532cdea` dirty）；2026-08-13 单一小样本与 §16 C/E 历史数值**保留不替换**；重测与校准前不升级 |

校准流程：PERF-001 已建立结果 schema v1 与存储策略（§5.1，实现完成），**运行时核验已完成（2026-08-13，§5.1/§11）** → PERF-002（提案）按 §5 重测既有基准并生成首批 machine-readable 基线 → 校准上表并更新状态。P0/P1 热点（PERF-100/101/102）在进入执行时按同一流程为本热点区域建立暂定预算并回写本表。**PERF-100 修复前测量已产生首批热点 L3 数值（§11/§16，2026-08-13），后续 scale 运行产出 quick/s0-20/s0-100 多规模点 L3 数值（2026-08-14，§16 C/E），PERF-100 收尾验证产出修复后 answer-tab 多规模点 L3 数值（2026-08-14，§16 F，本表新行）**，按同一流程不自动升级；PERF-100 已关闭（2026-08-14，§12/§16），下一可执行单元为 **Main 决策检查点（非执行）**：按 PERF-LOCK-004 比较 PERF-101 vs PERF-102 并显式授权至多一个为 Active（§16）。已批准参考候选（回显/IPC/流式节流/长任务/300-turn）**必须先测量后引用**，任何数值不得在重测前被当作事实或阈值（PERF-LOCK-003）。

---

## 8. 多维规模矩阵（Multidimensional Scale Matrix）

测量与基准必须声明规模级别；**跨级别结论不得直接外推**。规模由**多维矩阵**（§8.1 的六个维度轴）与 **S0–S3 profile 规模分类**（§8.2，正交分类）共同刻画：

- **维度轴（dimension）**：一个可独立取值的规模轴（话题消息数、FTS 语料、DB 体积、流长度、可见窗口、并发度）；每次测量须声明各维度的取值点。
- **profile 规模分类（S0–S3）**：整个工作负载/数据集的规模级别（正交分类，不替代维度轴）。

### 8.1 规模维度矩阵（Dimension Matrix）

每个取值点标注：**证据状态/现有资产**、**差距（asset gap）**、**LOCK-007 分级**（快速确定性进常规测试；大规模/放大/profile 级按需或定时，不进入每次提交 CI）。

| 维度 | 取值 | 现有资产 / 证据状态 | 差距（asset gap） | LOCK-007 分级 |
|---|---|---|---|---|
| **话题消息数（topic message count）** | 0 / 20 / 100 | 现有证据：PERF-100 scale 测量覆盖 quick/s0-20/s0-100（2026-08-14，§16 C/E，L3 暂定；2026-08-13 单一小样本为历史记录，§11/§16） | 多规模点已有 L3 数据（非阈值/基线）；300+ 与 profile 级按需未动（§16 非目标）；校准待 PERF-002 | 快速确定性（常规测试/测量，LOCK-007） |
| 同上 | 300 / 600 / 1200 | 无资产；LOCK-007 将 300+ 与 profile 级负载保持在按需 | 需按需/定时 harness 与触发决策（Q2） | **按需/定时**（LOCK-007，不进入每次提交 CI） |
| **FTS 文档数（FTS docs）** | 1k / 10k / 50k / 120k | 10k：`search.bench.ts` 确定性 10k 语料（parity 10/10 fixture，L1 结构级；数值 L3）；1k/50k/120k 无资产 | 多级语料参数化缺失（当前仅 10k 单点） | 1k/10k 快速确定性；50k/120k 按需/定时（大语料） |
| **合成 DB 目标体积（synthetic DB target size）** | 20MB / 200MB / 1GB / 2GB | `sqlite-runtime.perf.bench.ts` 当前为单一小型确定性库（parity 5 topics/1000 msgs/1100 blocks）；无体积参数化 | 合成体积参数化缺失；冷开/加载随体积增长曲线未测量 | 20MB 快速确定性；200MB/1GB/2GB 按需/定时；**不保留 2GB 级文件**（§11.2） |
| **流长度（stream length）** | 1KB / 10KB / 40KB / 100KB | 约 4KB：streaming-responsiveness E2E 合成慢流（~150 段落、60ms/段、约 4KB，`2aeb55760f`）——**合成慢流工作负载，不是 large-profile harness** | 其他长度无资产；多长度参数化缺失 | 全部经生产构建 E2E 契约（LOCK-005）；1KB/10KB/40KB 快速 E2E 候选，100KB 按需 |
| **可见消息数（visible messages）** | 10 / 50 / 100 | 10：renderer 默认 `displayCount = 10`（PERF-100 测量 seed 上限以此为界）；算法基准 `Messages.bench.ts` 场景 100/1000/10000（纯算法，无窗口维度） | 可见窗口（displayCount）维度参数化缺失；算法基准未覆盖窗口大小轴 | 10/50 快速确定性；100 常规/按需边界（窗口渲染规模候选，需测量定级） |
| **并发度（concurrency）** | 单模型 / 多模型 / 跨话题 | 多模型：PERF-100 答案标签切换（每 group 3 模型、4 次切换，L3 数值）；单流：streaming E2E；跨话题无资产 | 跨话题并发加载/多流并行无资产（PERF-102 Approved 覆盖多流并行方向） | 单模型/多模型快速确定性；跨话题按需/定时（需多话题 E2E 场景） |

> **隐私约束（数据库体积维度）**：DB 体积维度**只记录确定性合成目标体积**（20MB/200MB/1GB/2GB 为构造目标，不是实测值），**绝不记录观测到的用户/profile 原始 DB 体积**（PERF-LOCK-006）；真实 S2 profile 仍以**非敏感计数**表示（§8.2），不引入真实路径/内容/原始体积。

### 8.2 Profile 规模分类（S0–S3，正交）

| 级别 | 规模 | 用途 / 边界 |
|---|---|---|
| **S0 单话题小规模** | 1 topic / ≤100 messages / ≤1000 blocks | 快速确定性回归（常规测试，LOCK-007）；**确定性放大候选上限 ≤100 messages**（§16：PERF-100 验收 profile quick/s0-20/s0-100 在此范围内） |
| **S1 典型** | ~100 topics / ~10k messages / ~20k blocks（暂定示意） | 常规基准规模（与 10k FTS 语料同量级，`search.bench.ts`） |
| **S2 大 profile（真实 artifact）** | 2707 topics / 129150 messages / 158441 blocks；最大字符串约 2.67MB（L2 真实导入 artifact，`sqlite-migration.md` 提交内证据） | 按需/定时基准（LOCK-007），不进入每次提交 CI；**真实 profile 规模仅来自 L2 导入证据与 opt-in 导入 harness，与 renderer 流式提交（`2aeb55760f` 合成慢流）无关** |
| **S3 极限 / 压力** | S2 之上的放大，或极端长消息 / 长列表渲染 | 专项审计，需明确环境与机器配置 |

**话题规模 vs 可见窗口 vs 整体 profile 规模**（三个不同概念，测量时须分别声明）：

- **话题规模（topic size）**：单话题的消息/块总数——驱动 O(N) 全话题计算（分组、上下文、窗口重建，§10.2）；矩阵「话题消息数」轴衡量它。
- **可见窗口（visible window）**：单次渲染的消息数（`displayCount`）——驱动渲染 fanout/重挂载成本；矩阵「可见消息数」轴衡量它。小话题+大窗口与大话题+小窗口是两个不同测量点。
- **整体 profile 规模（whole-profile size）**：全部话题/消息/DB 体积——驱动冷开、加载、导入与 DB 体积轴；S0–S3 分类刻画它。

说明：S2 数值来自 `sqlite-migration.md` 记录的 L2 真实导入 artifact（仓库可验证的规模事实，非性能测量）；S1 为暂定示意规模，PERF-001+ 可校准。

---

## 9. 基线 0（Baseline 0）

**基线 0 定义**：性能优化工作的起点 = 以下三个已提交 commit。仓库可验证事实为提交内容及其随附测试/基准；**数值提升与验证通过仅存在于用户报告（§10），不属于基线 0 的已提交基准 artifact**。

| Commit | 标题 | 仓库可验证内容 |
|---|---|---|
| `c03a5c392c` | fix(chatdb): eliminate append and FTS streaming stalls | 稠密排序 fast path（追加零 sibling UPDATE）、批量分支克隆单事务、FTS rowid 稳定寻址、**migration 004**（normalized 投影稳定 rowid + parity preflight + 原子回滚）、startup diagnostics 有界计时；随附 `migration004.test.ts` 等测试 |
| `ad73468eb3` | feat(diagnostics): add bounded send and cold-path timing instrumentation | send/cold-path 有界计时（阶段名、时长、序号、非敏感计数、成败标记、不透明非敏感关联 ID；无内容/路径/凭据，对应 PERF-LOCK-006）；`packages/shared/diagnostics/sendTiming.ts` 等 |
| `2aeb55760f` | perf(renderer): keep UI responsive during streamed responses | 消息块订阅按属主消息收窄、Markdown 解析绑定 150ms cadence、完成时同步 flush；随附 fanout/cadence/race 测试与 `tests/e2e/specs/conversation/streaming-responsiveness.spec.ts`（fresh 生产构建）。其 streaming E2E 使用**合成慢流工作负载**（~150 段落、60ms/段、约 4KB，`__E2E_SLOW_STREAM__` opt-in）——**合成慢流，不是 large-profile harness**（PERF-LOCK 决策，2026-08-13） |

**基线边界**：基线与测量**仅引用已提交状态**。测量应在干净 worktree 或显式标注范围的 worktree 上进行；未提交工作树内容不计入基线，也不归属于本程序（§15）。

---

## 10. 历史证据 — 用户报告与静态调查（Historical Evidence — User-Reported & Static Findings）

### 10.1 用户报告（L4）

> ⚠️ 本小节内容**全部为未验证的用户报告历史结果**（L4，§6）。它们不以任何方式代表当前可复现基线；引用前必须按 §5 重测。

- **内容**：用户报告基线 0 对应工作（§9 三提交）带来性能数值提升，且相关验证已通过。
- **热点症状（用户批准优先级时确认的报告，仍为 L4）**：
  - **P0 编辑模式进入与多消息中部插入**：用户报告进入编辑模式、以及多消息中部插入（粘贴）时存在可感知的卡顿。
  - **P1 话题切换**：用户报告点击切换话题到首次可用渲染（click-to-first-useful-render）存在延迟。
  - **P1 并行窄流可视流畅度**：用户报告并行多条窄流输出时可视流畅度不佳。
  - **P1 多模型答案标签切换（2026-08-13 新增报告）**：用户报告在多模型答案标签间切换时感觉 **1–2 秒**延迟；未测量、未复现，**保持 L4**，不是基线；归属纳入 PERF-100 测量/渲染放大范围（§12），但共享根因未测量前不得断言。
  - **证据边界**：上述热点操作中用户量级表述约 5–6 秒（答案标签切换为 1–2 秒），且伴随定性症状——**全部为 L4 用户报告**，不绑定到特定操作作归属、不是当前基线、不是验收事实（PERF-LOCK-003、§6）；未在任何 fresh 环境复现，无 machine-readable artifact。
- **绑定提交**：`c03a5c392c` / `ad73468eb3` / `2aeb55760f`（工作由这些提交承载；**数值本身没有 machine-readable artifact 提交到仓库**）。
- **复现性注意事项**：数值依赖当时环境（Node/ABI/硬件/负载）；无机器可读输出留存；未与当前 schema（migration 004 现状）核对；不可作为基线、验收或回归判定的依据。
- **程序立场**：本文件不含任何声称「已验证」的数值基线；在按 §5 契约重测并记录 artifact 前，一切数值视为未验证。数值基线从 PERF-002（提案）重测产物开始建立。

### 10.2 静态调查发现（Static Findings — 只读代码事实）

> ⚠️ 本小节为 **2026-08-13 只读静态代码调查**的结论（**诊断性/静态证据**，§6；非 L2 运行时观察、非 L1 证明；`ui-verify-change` 分类）：**仓库内可核实的代码事实，不是运行时测量、不是 L1 回归证据**。它们只用于方向判断（哪些路径可能存在成本），不得当作基线、验收或回归依据；任何结论必须先按 §5 测量。

- **流式节奏已对齐（P1 流式背景）**：基线 `2aeb55760f` 已实现 150ms 块提交 / Markdown 解析 cadence（`src/renderer/src/pages/home/Markdown/Markdown.tsx` 的 `MARKDOWN_PARSE_CADENCE_MS = 150`、`useSmoothStream.ts` rAF+minDelay 逐字符呈现），并有 `tests/e2e/specs/conversation/streaming-responsiveness.spec.ts`（fresh 生产构建）覆盖流式期间滚动/输入契约（§11）。该 E2E 使用**合成慢流工作负载**（~150 段落、60ms/段、约 4KB，`__E2E_SLOW_STREAM__` opt-in）——**合成慢流，不是 large-profile harness**（PERF-LOCK 决策，2026-08-13）；S2 真实 profile 规模仅来自 L2 导入证据与 opt-in 导入 harness（§8.2）。
- **缓存未命中话题切换为全量加载 + 重复全话题计算（P1）**：`loadTopicMessagesThunk`（`src/renderer/src/store/thunk/messageThunk.ts`）→ `dbService.fetchMessages` 一次性加载全话题 messages+blocks（Main `ChatDbAggregateService.fetchMessages` 的 `listByTopic` + `listByMessages`，`src/main/services/chatDb/ChatDbAggregateService.ts`）；渲染侧随后对全量消息重复执行全话题计算——`createLatestMessageWindow`/`reconcileMessageWindow`（`src/renderer/src/pages/home/Messages/messageWindow.ts` → `messageGroups.ts` 的 `createMessageViewportGroupModel`）、`computeContextInfo` 全话题 turn 构建与多步过滤（`src/renderer/src/services/contextInfoService.ts`）。
- **编辑模式进入重挂载可见消息子树（P0）**：`toggleEditMode`（`src/renderer/src/store/editMode.ts`）切换 `isEditMode` 后，`Messages.tsx` 在 `EditModeContextMenu` 与 `ContextMenu` 两棵子树间切换（可见消息子树重挂载），`messageSegments` 按选中态重包 `SelectionBlock`，`MessageGroup`/`Message` 在 `isEditMode` 下重算选择态与点击/右键处理；`useEditMode` 经 `useMessageGroups(messages)` 对全话题执行分组计算（`src/renderer/src/hooks/useEditMode.ts`）。
- **多消息中部插入为串行逐项 IPC + O(M×N) 排序/计算（P0）**：`ClipboardService.pasteMessages` 逐条消息循环 `saveMessageAndBlocksToDB`（每条一次 IPC `dbService.appendMessage`，`src/renderer/src/services/ClipboardService.ts`）；Main 侧 `appendMessage(insertIndex)` → `MessagesRepository.insertAt` 执行 `UPDATE sort_order = sort_order + 1` 兄弟移位 + `normalizeOrdersInTx` 全话题规范化（`src/main/services/chatDb/repository/MessagesRepository.ts`）——M 条中部插入 ≈ M 次 IPC + O(M×N) 排序/计算工作。
- **多模型答案标签切换为两次 DB-first foldSelected 写入 + 全话题计算与窗口级渲染 fanout（2026-08-13 新增，P1 报告对应静态调查）**：点击答案标签触发 `MessageGroup.setSelectedMessage`（`src/renderer/src/pages/home/Messages/MessageGroup.tsx`）——先 `editMessage(旧选中, { foldSelected: false })` 再 `editMessage(新选中, { foldSelected: true })`（两条 DB-first 写入；`foldSelected` 为 O(1) 单字段 UI 状态），随后经 `useMessageGroups`（`src/renderer/src/hooks/useMessageGroup.ts`）对全话题重新执行分组/上下文/窗口计算（`createLatestMessageWindow`/`reconcileMessageWindow`，`src/renderer/src/pages/home/Messages/messageWindow.ts` → `messageGroups.ts`；`computeContextInfo`，`src/renderer/src/services/contextInfoService.ts`），并触发窗口级消息渲染 fanout；`setSelectedMessage` 另注册 200ms `setTimeoutTimer` smooth-scroll（`scrollIntoView`，`MessageGroup.tsx`），`visibleGroupIds` 对 `displayMessages` 做窗口级扫描（`src/renderer/src/pages/home/Messages/Messages.tsx`）。Markdown 块内容保持 memoized 不被重新解析（`src/renderer/src/pages/home/Markdown/Markdown.tsx` 的 `MarkdownBody`/`memo` 按 parsedContent 缓存）。
- **证据边界**：以上全部为**静态代码事实**（诊断性/静态证据；非 L2 运行时观察、非 L1 证明），未在任何运行时复现、无计时数据；不构成对用户症状的证明或证伪；答案标签切换的共享根因（与话题切换/编辑模式是否同源）**未测量前不得断言**（§16 PERF-100 先测量）。

---

## 11. 持久化 Harness 清单（Durable Harness Inventory）

现有可复用资产（命令、文件、claim 边界均已在仓库内核实）。PERF-001 使能切片已实现机器可读结果 schema v1 与存储策略（§5.1），并使两个 chatDb 基准在**全部 gate 与全部已注册 tinybench 任务成功后**发射 artifact（文件级 `afterAll` 门控，审计 F1）；受 migration 004 影响的 chatDb 基准的**运行时核验已完成（2026-08-13）**：`pnpm bench:main:native` 退出码 0（含 finalizer），search parity 10/10 fixture、sqlite parity（5 topics / 1000 messages / 1100 blocks）、冷开 sanity 15/15、冷开 p95 84.31ms `<500ms`、两个 schema v1 artifact 校验通过（forbidden-field 扫描干净）后按清理策略移除（session-owned，非持久文件，§5.1）。本清单更广的逐项补全（调用命令、输出位置、lane、claim 边界）不阻塞热点诊断，可随后跟进并登记到 §14。

| Harness / 文件 | 命令（已核实存在） | Lane | 测量内容 | Claim 边界 |
|---|---|---|---|---|
| chatDb 运行时基准 — `src/main/services/chatDb/__tests__/sqlite-runtime.perf.bench.ts` | `pnpm bench:main:native`（Node ABI137；文件头另注明等价的 `npx vitest bench --run --project main-native …`） | Node | 消息加载 p50/p95、批量写入 ops/sec、冷库打开延迟 | 确定性临时库、不触碰用户数据（LOCK-5.4.1）；无历史对比值显式报告（LOCK-5.4.2）；仅 `<500ms` 冷开阈值断言（LOCK-5.4.3）；console 报告保持不变；全部 gate 与已注册 tinybench 任务成功后输出 schema v1 JSON artifact（§5.1）到 `test-results/bench-results/chatdb-sqlite-runtime-<timestamp>.json`（`BENCH_RESULTS_DIR` 可覆盖）；**运行时核验已完成（2026-08-13）**：parity 5/1000/1100 通过、冷开 sanity 15/15、冷开 p95 84.31ms `<500ms`、退出码 0、artifact 校验通过后清理 |
| 搜索基准 — `src/main/services/chatDb/__tests__/search.bench.ts` | 同上（`pnpm bench:main:native`） | Node | 10k 语料 LIKE vs 混合 FTS p50/p95 + 全分页有序 parity | 正确性 parity **先于**计时、失败即 abort；确定性 10k 语料；无 CI 绝对阈值；console 报告保持不变；parity gate 与全部已注册 tinybench 任务通过后输出 schema v1 JSON artifact（§5.1）到 `test-results/bench-results/chatdb-search-10k-<timestamp>.json`（`BENCH_RESULTS_DIR` 可覆盖）；**运行时核验已完成（2026-08-13）**：parity 10/10 fixture 通过、无 abort、artifact 校验通过后清理 |
| 渲染算法基准 — `src/renderer/src/pages/home/Messages/__tests__/Messages.bench.ts` | `pnpm bench:renderer`（Node ABI137） | Node | 消息列表倒序展示算法对比（baseline vs 原生索引倒序遍历） | 纯算法对比（vitest bench），非端到端；结论需结合 E2E（LOCK-005） |
| 共享 / aiCore 基准命令 | `pnpm bench:shared` / `pnpm bench:aicore` | Node | 现有命令入口 | 命令入口存在但**当前无任何已注册基准资产**（`packages/shared` / `packages/aiCore` 下无 `*.bench.ts`，§11.1）；是否补覆盖由 PERF-004/Q6 决策 |
| 测量辅助 — `src/main/services/chatDb/__tests__/benchMetrics.ts` + `metric-helpers.test.ts` | 随 `pnpm test` / 基准复用 | Node | percentile/mean/opsPerSec/sum/sortTimings 数值计算 | 数值计算一致性有测试锁定 |
| 结果契约 — `src/main/services/chatDb/__tests__/benchResult.ts` + `benchResult.test.ts` | 随 `pnpm test`（聚焦测试）与基准运行复用 | Node | PERF-001 schema v1：环境/git 元数据收集、运行时校验、JSON artifact 写入、**任务完成度门控发射**（默认 `test-results/bench-results/`，`BENCH_RESULTS_DIR` 可覆盖，毫秒级碰撞安全命名） | schema 为封闭集（无内容/凭据/路径/原始数据字段）；写入前校验失败即拒绝；pnpm 仅取真实 pnpm UA、命令必需显式且无路径段、完成序门控（审计 F1–F4）；测试锁定元数据/序列化/路径/敏感字段/门控行为；**已验证运行（2026-08-13）产出两个通过校验的 artifact（forbidden-field 扫描干净），随后按清理策略移除** |
| 常规测试 — `pnpm test` | `pnpm test`（Node ABI137） | Node | 快速确定性正确性/结构性回归 | bench 文件**不进入**常规测试（`vitest.config.ts` 按 project 单独 `benchmark.include` 收集，LOCK-007） |
| Playwright E2E — `tests/e2e/specs/conversation/streaming-responsiveness.spec.ts` 等 | `pnpm build`（fresh 生产构建，Electron ABI145）+ `pnpm test:e2e` | Electron | 集成 UI 契约（流式期间滚动/输入等） | **集成 UI 契约的唯一回归证据**（LOCK-005）；标准 fixture（`tests/e2e`）+ mock provider；规范见 `tests/e2e/README.md` |
| UI 观察诊断 — `scripts/ui-observe`（`pnpm ui:observe`） | `pnpm ui:observe`（Electron ABI145） | Electron | 渲染/交互诊断观察 | 诊断性证据（L2），**非回归证明**；程序化使用走 `ui-verify-change` |
| PERF-100 测量 spec — `tests/e2e/specs/conversation/perf100-measurement.spec.ts` | `pnpm build`（fresh 生产构建，Electron ABI145）+ `pnpm test:e2e`（聚焦该 spec） | Electron | 编辑模式进入/退出、多消息中部粘贴、多模型答案标签切换（正确性 gate 先于计时；全部通过后发射 schema v1 artifact） | 正确性 gate 为 **L1 确定性证据**；数值为 **L3 暂定**（§7/§16）。**验证通过（2026-08-13）**：fresh build 退出码 0、focused E2E 退出码 0、Phase 1/2/3/4 全过、10/10 正确性 gate、40/40 有限指标、Electron ABI 145；artifact `perf100-measurement-20260813-194939.616.json` 保留为 **gitignored 本地 deliverable**（§5.1/§16）。**收尾验证（2026-08-14，§16 F）**：独立审计 pass-with-findings、0 blockers；fresh 未改动 worktree build 退出码 0；quick/s0-20/s0-100 三次 focused E2E 退出码均 0（Phase 1–4 全过、12/12 gate、strict schema-v1、35 有限指标、Electron ABI 145）；三个 artifacts 文件名/备份根/checksums 见 §16 F；`pnpm ui:observe` 不是替代（LOCK-005） |

### 11.1 继承资产与差距映射（Inherited Assets & Gaps）

| 继承资产 | 位置 / 命令 | 覆盖 | 差距（asset gap） |
|---|---|---|---|
| 10k FTS 搜索基准 | `search.bench.ts`（`pnpm bench:main:native`） | FTS 维度 10k 单点（parity 10/10，L1 结构级；数值 L3） | FTS 维度 1k/50k/120k 缺失（§8.1） |
| SQLite 运行时基准 | `sqlite-runtime.perf.bench.ts`（`pnpm bench:main:native`） | 单一小型确定性库（5 topics/1000 msgs/1100 blocks）、冷开 `<500ms` gate | DB 体积维度 20MB/200MB/1GB/2GB 参数化缺失（§8.1）；消息加载/批量写随规模曲线未测 |
| 渲染算法基准 | `Messages.bench.ts`（`pnpm bench:renderer`） | 纯算法对比（baseline vs 原生索引倒序遍历），场景 100/1000/10000 消息 | 可见窗口（displayCount）维度缺失；非端到端（LOCK-005 需 E2E 补足） |
| 慢流 E2E 契约 | `streaming-responsiveness.spec.ts`（fresh 生产构建 + `pnpm test:e2e`） | 流式期间滚动/输入契约（L1 集成契约）；合成慢流 ~150 段落 / 60ms / 约 4KB | 流长度维度 1KB/10KB/40KB/100KB 参数化缺失；**合成慢流不是 large-profile harness**（PERF-LOCK 决策，2026-08-13） |
| 10k 导入重测试 | `benchmarkFixture10k.ts`（25 topics × 400 msgs = 10k msgs / 10.4k blocks）+ `importBenchmark.integration.test.ts`（Phase 4.2）+ `verificationBenchmark.integration.test.ts`（Phase 4.3.4，14 维度）+ `recoveryV2.test.ts` | 确定性大规模集成；专属 `main-heavy` lane（bounded-memory fork，LOCK-MEM-4） | 耗时输出为 console 报告（L3 性质），无 schema artifact；不覆盖 §8.1 全部规模点 |
| S2 真实 ZIP opt-in | L2 导入证据（`sqlite-migration.md` 提交内 artifact 计数）+ opt-in 导入 harness（L2 导入管线） | S2 真实 profile 规模（2707 topics / 129150 msgs / 158441 blocks，非敏感计数） | 按需/定时承载与触发方式仍待 Main 决策（Q2）；**与 renderer 流式提交无关**（PERF-LOCK 决策） |
| PERF-100 测量 spec | `perf100-measurement.spec.ts`（生产构建 E2E，`PERF100_SCALE`） | 三交互路径正确性 gate（L1）+ L3 数值（验证通过 2026-08-13；2026-08-14 产出 quick/s0-20/s0-100 多规模点 §16 C/E，收尾验证 §16 F） | 多规模点已有 L3 数据（非阈值/基线）；300+ 与 profile 级按需未动（§16 非目标）；校准待 PERF-002 |
| **缺失：多级参数化 / 方差 / 拐点消费** | — | — | 无统一规模矩阵 harness；无跨运行曲线/方差/knee 消费者（§12 PERF-004 提案、§14 Q6） |
| `bench:shared` / `bench:aicore` | 命令入口存在（`pnpm bench:shared` / `pnpm bench:aicore`） | **无任何已注册基准资产**（无 `*.bench.ts`） | 是否补覆盖由 PERF-004/Q6 决策 |

### 11.2 资产保留治理（Asset-Retention Governance）

性能资产（测试/基准/harness/诊断产物）按以下五类保留与运行，避免仓库膨胀与无效资产堆积：

1. **快速确定性结构测试**：小型、快速、确定性正确性/结构断言 → 常规测试（`pnpm test` 各 lane），进入每次提交 CI（LOCK-007 快速级）。
2. **生产构建 UI 契约**：集成 UI 契约（流式、PERF-100 测量等）→ Playwright E2E（fresh 生产构建 + 标准 fixture，LOCK-005），作为 E2E 套件运行；不进入单测 gate。
3. **可复用确定性生成器**：语料/规模/seed 工厂（如 `benchmarkFixture10k.ts`、测量 spec 的 `buildGroupSeeds`）→ 保留为共享模块，禁止复制粘贴为一次性脚本。
4. **有界诊断**：诊断/观察产物（生命周期磁带、ui-observe、分诊产物）→ 有界、非敏感（LOCK-006）、非持久；失败时随测试 artifact 附上，成功后清理。
5. **大规模/profile/trace/churn 资产**：10k+ 语料、S2/S3、trace、churn、2GB 级文件 → **按需/定时**运行（LOCK-007），承载与触发由 Main 决策（Q2）；**不进入每次提交 CI**。

**不保留**：2GB 级 DB 文件（合成体积仅按需生成，用后即弃）、一次性 throwaway 脚本、无 schema artifact 的 console-only 基准输出（至少按 §5.1 记录数值）、session-owned 诊断产物。gitignored `test-results/` 下的可复用测量 artifact（如 PERF-100 验证通过产物）作为**本地 deliverable** 保留至被同 id artifact 取代或主动清理（§5.1）。

---

## 12. 工作流（Workstreams）

| ID | 名称 | 状态 | 说明 |
|---|---|---|---|
| **PERF-001** | 使能切片：migration-004 chatDb 加载/写入基准核验 + 机器可读结果 schema/存储策略 | **Done（2026-08-13；证据 §5.1/§7/§11/§14）** | 范围窄化：不再要求一次性完成全部 harness 盘点（§11 更广盘点不阻塞热点诊断）；不优化新的运行时路径。**完成证据**：Validation 会话运行 `pnpm bench:main:native` 退出码 0（HEAD `3d61027bf2`，Node lane ABI 137），search parity 10/10、sqlite parity 5/1000/1100、冷开 sanity 15/15、冷开 p95 84.31ms `<500ms`，两个 schema v1 artifact 校验通过后按策略清理（§5.1）；R3/R4 关闭、R1 缓解（§14） |
| **PERF-100** | P0：编辑模式进入 + 多消息中部插入（renderer 渲染/重挂载 + Main 持久化顺序路径）；**并纳入多模型答案标签切换（§10.1/§10.2，2026-08-13 并入）** | **Done（2026-08-14；证据 §11/§16 A–F）** | **P0 优先级**；ID 已保留。范围来自 §10.2 静态调查；答案标签切换并入其测量/渲染放大（message-interaction amplification）范围，同时保留其独有的持久化与滚动（200ms smooth-scroll）维度。**关闭证据（2026-08-14，§16 A–F）**：crash 分诊/harness 恢复（Q5 有界关闭）、规模方法论就位（验收 profile 仅 quick/s0-20/s0-100）、修复前规模 artifacts（HEAD `ded532cdea` dirty，12/12 gate、40 指标，L3 暂定）、编辑稳定宿主（D）、粘贴批量（E）、**answer-tab 原子选择（F）独立审计 verdict = pass-with-findings、0 blockers + fresh 未改动 worktree `pnpm build` 退出码 0 + quick/s0-20/s0-100 三次 focused E2E 退出码均 0（Phase 1–4 全过、12/12 正确性 gate、strict schema-v1、35 有限指标、Electron ABI 145、git `ded532cdea` dirty、D/E gate green）**；post-fix answer p50 与修复前 C 的直接比值见 §7（L3 暂定）。copy-paste 是隔离插入场景，cut-paste 为延后的独立契约覆盖、不属于当前优化指标（cut 语义保留未基准化）。共享根因判断与下一工作流授权由 Main 决策（§16 下一单元，非执行）。**收尾（2026-08-14）**：最终强制 `pnpm format`/`pnpm lint`/`pnpm test` 已由独立 Validation 会话在本文档写回后的状态上执行并通过——退出码均 0（Node 24.11.1 / pnpm 10.27.0；`pnpm test` Node lane 后 Electron ABI 145 已恢复；`pnpm format` 对 code/test/config 零改动，仅 gitignored `test-results/.last-run.json`，先前 fresh-build PERF-100 E2E 证据保持有效，PERF-LOCK-005，§16） |
| **PERF-101** | P1：话题切换点击→首次可用渲染（click-to-first-useful-render） | **Approved（用户批准，2026-08-13）** | **P1 优先级**；ID 已保留。范围来自 §10.2 静态调查；修复方案未测量、不预先限定 |
| **PERF-102** | P1：并行窄流可视流畅度 | **Approved（用户批准，2026-08-13）** | **P1 优先级**；ID 已保留。范围来自 §10.2 静态调查（流式 cadence 已对齐）；修复方案未测量、不预先限定 |
| **PERF-002**（提案） | 基线重测与暂定预算校准 | Planned（提案，未批准） | 在 PERF-001 完成后，按 §5 重测既有基准并生成首批 machine-readable 基线，校准 §7（**未完成**） |
| **PERF-004**（提案） | 统一规模矩阵 harness + 跨运行曲线/方差/knee 消费（multi-level parameterization / variance / knee consumer） | Planned（提案，未批准） | 目标：把 §8.1 多维矩阵落成可复用参数化 harness，并消费跨运行曲线/方差/拐点（§11.1 差距）；当前无 Active 工作流，进入 Active 需 Main 批准（§3、Q6） |
| **PERF-003**（提案） | 用户影响驱动的优先级清单 | **Retired（2026-08-13）** | 优先级已由用户批准（PERF-100/101/102），本提案的「产出优先级清单」目标由该批准取代；保留历史记录 |

> 优先级顺序（PERF-LOCK-004 落地）：**PERF-100（P0）→ PERF-101 / PERF-102（P1）**（PERF-001 使能切片已完成，2026-08-13）。P1 两工作流在 Main 批准并行时方可并行（§16 允许并行时每个仍保持自己的验收），否则按优先级顺序执行。Approved 工作流只在获准进入执行时标记 Active（§3：Active 同一层级唯一）。
>
> PERF-002 保留稳定 ID 与方向草案，**范围未批准**；具体范围由 Main 在本程序推进时决策，并回写本表。
>
> PERF-004（统一规模矩阵 harness/曲线方差消费，§8.1/§11.1）为 **Planned 提案**，不参与优先级顺序；当前无 Active 工作流（§16），进入 Active 需 Main 批准（§14 Q6）。

---

## 13. ADR 触发条件（ADR Triggers）

以下任一情况在性能工作中出现时：**停止实现，回 Main，先建立 ADR 决策点，再继续**（PERF-LOCK-008）：

1. **运行时职责/权威移动**（如聊天权威离开 Main 进程 SQLite）。
2. **持久化或迁移语义变更**（schema、原子性、回滚、版本化、`sqlite-migration.md` 治理面）。
3. **生命周期 / 多窗口 / 原生能力变更**。
4. **遥测隐私边界变更**（诊断记录范围超出 PERF-LOCK-006）。
5. **兼容语义变更**（Cherry Studio 兼容导入、FTS/搜索正确性、身份/兼容标识）。
6. **平台 / 发布范围变更**（macOS-arm64-first 之外或发布冻结面）。
7. **性能优化建议本身要求上述变更**——先 ADR 后实现，不得以性能为名绕过治理。

---

## 14. 风险与开放问题登记（Risk & Open Questions）

| # | 风险 / 开放问题 | 影响 | 缓解 / 归属 |
|---|---|---|---|
| R1 | 数值基线缺失（无 machine-readable artifact） | 无法判定回归 / 验收 | 部分缓解（进展）：PERF-001 已定义结果 schema v1/存储策略（§5.1）且**运行时发射已验证（2026-08-13，两个 artifact 校验通过，§5.1/§11）**；PERF-100 修复前 artifact（2026-08-13）为**首个持久本地 machine-readable deliverable**（gitignored，§11/§16）；**2026-08-14 规模 artifacts（pre-fix C 与 post-paste-fix E，§16）为会话持有备份**——Playwright 每次运行清空 `test-results`，备份路径可能不持久，新会话在下次 E2E 前检查并保留存留 artifact（§16 保留警示）。**已提交数值基线仍缺失**——首批 durable 基线由 PERF-002 重测生成；L3 数值不得当基线（§7） |
| R2 | 环境漂移（Node/ABI/硬件/负载） | 基准不可复现 | §5 固定工具链与 lane；结果伴随环境元数据 |
| R3 | migration 004 后既有 chatDb 基准是否在当前 schema 上正确运行 | 基线失真 / bench abort | **已关闭（2026-08-13）**：PERF-001 Validation 核验通过——`pnpm bench:main:native` 退出码 0，search parity 10/10 fixture、sqlite parity 5/1000/1100、冷开 sanity 15/15、冷开 p95 84.31ms `<500ms` gate 成立、无 abort（§5.1/§11） |
| R4 | 机器可读结果存放位置与体积策略未定 | 结果丢失 / 仓库膨胀 | **已关闭（2026-08-13）**：策略已定义（§5.1：小体积 summary artifact 落 gitignored `test-results/bench-results/`，`BENCH_RESULTS_DIR` 可覆盖，大体积/原始数据不落仓库 LOCK-007）且**已在真实运行中验证**——两个 artifact 写入指定位置、校验通过、按清理策略移除 |
| R5 | 渲染性能除 E2E 外无可复现测量 | 渲染回归难判定 | L2 诊断 + E2E（LOCK-005/006）组合；PERF-100/101/102 均需先建立可测量指标（§7/§16） |
| R6 | 用户报告数值不可复现（含 5–6 秒热点量级与 2026-08-13 多模型答案标签切换 1–2 秒报告） | 误作基线 | §10.1 显式标注（全部为 L4）+ §5 重测要求 |
| R7 | 诊断隐私边界 | 内容 / 凭据 / 路径泄漏 | PERF-LOCK-006 与 `ad73468eb3` 的 bounded 设计持续约束 |
| R8 | 静态调查发现（§10.2）被误当作运行时证据或验收依据 | 结论失真 / 修复方向错配 | §10.2 显式标注为诊断性/静态证据（非 L2 运行时观察、非 L1 证明）；任何验收必须按 §5 测量（§6） |
| R9 | PERF-100 官方测量运行历史失败（**已分诊，2026-08-13，见 Q5/§16**）：focused E2E 两次运行均**在首个 Phase 3 答案标签切换处**以 `Execution context was destroyed` 确定性失败——历史事件为**执行上下文销毁**，**不是已证明的 renderer 崩溃，也不是已证明的 WindowService 自动重载**（原「与崩溃 + 自动重载一致」仅为未证实机制描述，已更正）；Phase 1/2 两次均通过、Phase 3 零样本、无 artifact、无计时被接受；run-2 存在 18.93s 无匹配超时的 evaluate pending；决定性的失败 profile Main 日志丢失 | 历史失败不可作为测量/基准证据；部分通过有被误当指标的风险 | **已分诊（2026-08-13，Q5 有界结论）**：受控 ui-observe 普通/带仪器 A/B 通过；受控官方 runner 诊断（HEAD `3d61027bf2` 与既有 build）3/3 通过（trace/video on 2/2、off 1/1），原始 Main tapes 显示**零 render-process-gone / child-process-gone / navigation**；可比压力存在但历史瞬时状态未知。H5/H6 仅作为确定性/充分原因被否定（非证明不可能）；H7 保留为未证明的历史瞬时/放大器风险。历史失败记录保留于 §16，不进入基线；分诊产物为非持久 L2 诊断证据（§6）。**后续 harness 加固后 full-pass 成功（2026-08-13，§11/§16）**——成功路径已恢复，未复现历史销毁，不改变 Q5 有界结论与 H5/H6/H7 语义 |
| R10 | Phase 1/2 部分通过或失败运行被误认为基准/被接受指标 | 基线污染 / 验收失真 | **已满足（2026-08-13）**：§16 恢复测量验收条件全部通过——harness 前置条件（`SCALE.scrollFloorMs` evaluate-closure 缺陷）已受控（full-pass 证明）、fresh build 与 focused E2E 退出码均 0、全部 phase（1–4）通过、schema-v1 artifact 按 §5.1 校验（10/10 gate、40/40 有限指标）。**2026-08-14 快速/规模运行同样全过**（quick/s0-20/s0-100 12/12 gate，§16 C/E）。测量数值已按 §7 记录为 **L3 暂定**（非阈值、非基线）；不满足时一律不接受计时/样本（历史失败记录于 §16，不进入基线） |
| Q1 | 各工作流的 E2E 门槛分级（LOCK-005 已要求集成契约 E2E） | 成本 / 覆盖平衡 | 待 Main 决策 |
| Q2 | 大 profile 基准的触发方式（按需 / 定时）与承载位置 | 运行成本 | LOCK-007；待 Main 决策 |
| Q3 | PERF-100/101/102 的测量指标与验收口径（如编辑模式进入耗时、多消息中部插入 IPC/排序成本、话题切换点击→首帧、并行窄流流畅度、**多模型答案标签切换点击→首帧与两次 foldSelected 写入/滚动维度的独立耗时**）如何定义 | 方向不清 / 验收无据 | PERF-001 使能切片先产出测量能力；各工作流在进入执行时按 §7 流程定标 |
| Q4 | PERF-100/101/102 并行执行的条件与顺序 | 与 Active 唯一语义冲突 | §12 顺序（使能 → P0 → P1）；并行需 Main 批准且各保持自身验收（§16） |
| Q5 | 首个 Phase 3 答案标签切换处 `Execution context was destroyed` 的根因是 H5 测试仪器 / H6 正常答案标签切换应用路径 / H7 环境内存压力（或组合）中的哪一个 | 曾阻塞恢复测量 | **已关闭（2026-08-13，有界结论；证据与措辞见 §16）**：历史事件为**执行上下文销毁**，**非已证明的 renderer 崩溃，也非已证明的 WindowService 自动重载**；H5/H6 仅作为**确定性/充分原因**被否定（**未证明不可能**）；H7 在目前可比压力下**既未证明也不充分**，保留为**未证明的历史瞬时/放大器风险**，不与本次失败作因果绑定。恢复测量已不再阻塞：harness 前置条件与全部正式 gate 已于 2026-08-13 满足（§11/§16 full-pass）；分诊与新运行产物均为非持久 L2 诊断证据（§6），**任何数值不进入基线**（§5.1、PERF-LOCK-003）。**后续 full-pass 成功进一步支持有界结论**：加固后成功路径可恢复、未复现历史销毁；不改变 H5/H6/H7 的否定/保留语义 |
| R11 | PERF-100 L3 数值（§7/§16）被误读为阈值/基线，或把当前规模曲线（quick/s0-20/s0-100）当作已校准基线 | 方向失真 / 验收无据 | §7 显式 L3 暂定标注（唯一已提交阈值 = 冷开 `<500ms`）；多规模点曲线已产出但**保持 L3 暂定**（§16 C/E）；小样本 p95 = max 记录在案；未校准前不升级（首批 durable 基线由 PERF-002 生成） |
| Q6 | 统一规模矩阵 harness 与跨运行曲线/方差/knee 消费（§8.1 矩阵落地、§11.1 差距、PERF-004 提案）由谁在何时以何形态执行；`bench:shared`/`bench:aicore` 是否补覆盖 | 方向不清 / 重复造轮子 | 提案已登记（§12 PERF-004，Planned）；当前无 Active 工作流，进入 Active 需 Main 授权（§12/§16）；待 Main 决策 |
| R12 | answer-tab 原子选择（F，§16）未经独立审计与 fresh 生产构建验证即关闭 PERF-100 | PERF-100 关闭决策无据 / 验收失真 | **已满足（2026-08-14）**：独立审计 verdict = pass-with-findings、0 blockers（findings 无 in-scope blocker，无需修正）；fresh 未改动 worktree `pnpm build` 退出码 0 + quick/s0-20/s0-100 三次 focused E2E 退出码均 0（Phase 1–4 全过、12/12 gate、strict schema-v1、35 有限指标、Electron ABI 145，§16 F/§12）；focused 验证数字为实现会话报告（§17 历史），不替代独立审计与 fresh build（已按 §16 F 执行）；PERF-100 关闭决策已由 Main 基于上述证据做出；下一单元为 Main 决策检查点（§16） |

---

## 15. 更新协议（Update Protocol）

1. **新会话从本文件开始**：发现路径为根 `AGENTS.md`「Detailed References」；先读本文件再执行任何性能工作。
2. 任何状态/证据/交接更新**先改本文件**，再谈实现；完成工作流后回写 §12 状态与 §16 交接段，指出下一个可执行单元。
3. 证据按 §6 分层记录；数值必须伴随命令、环境（Node/ABI/lane）、日期与结果位置（§5）。
4. **易变状态不进 AGENTS.md**：worktree 脏文件、临时观察、本次会话细节只留在本文件（§14 可登记持久风险）或会话内；AGENTS.md 仅保留发现链接。
5. 大体积结果数据不进仓库；按 PERF-001 定义的结果策略存放。
6. 每次更新递增「最后更新」日期并追加 §17 变更记录。
7. 治理/架构/兼容变更一律先走 §13 ADR 触发；本程序无权绕过。
8. 基线与测量仅引用已提交状态（§9）；未提交工作树不计入基线。

---

## 16. 会话交接（Session Handoff）— 下一可执行单元：Main 决策检查点（非执行）— 比较 PERF-101 vs PERF-102，按 PERF-LOCK-004 显式授权至多一个 Active

> 新会话（或任何接手本程序的会话）从本节开始执行，不需要回顾历史会话。

**当前状态（2026-08-14，PERF-100 已关闭）**：PERF-100（P0）独立审计与 fresh 生产构建 quick/s0-20/s0-100 验证**全部完成并通过**（§16 F），PERF-100 已标记 **Done**（§12）；**当前无 Active 工作流**。PERF-101/102 保持 Approved、PERF-002/004 保持 Planned——PERF-100 关闭**不自动激活**任何工作流。下一可执行单元为 **Main 决策检查点（非执行）**：按 PERF-LOCK-004 比较 PERF-101 vs PERF-102 并显式授权**至多一个**为 Active，不开始实现。最终强制 `pnpm format` / `pnpm lint` / `pnpm test` 已由独立 Validation 会话在本文档写回后的状态上执行并通过（2026-08-14，退出码均 0，Node 24.11.1 / pnpm 10.27.0；`pnpm test` Node lane 后 Electron ABI 145 已恢复；`pnpm format` 对 code/test/config 零改动，仅 gitignored `test-results/.last-run.json`，先前 fresh-build PERF-100 E2E 证据保持有效，PERF-LOCK-005）。

**已完成证据（A–F）**：

- **A. Crash 分诊与 harness 恢复（完成）**：Q5 以有界结论关闭（§14 Q5/R9）——历史事件为**执行上下文销毁**，非已证明的 renderer 崩溃/WindowService 自动重载；H5/H6 仅作为**确定性/充分原因**被否定（未证明不可能）；H7 保留为**未证明的历史瞬时/放大器风险**。fresh build + quick 测量恢复通过；schema-v1 artifact、生命周期磁带与 scaled profiles（quick/s0-20/s0-100）均已建立。
- **B. Scale 方法论（就位）**：多维规模矩阵（§8）为**程序方向**，非 PERF-100 关闭的必需全集——当前验收 profile 仅 **quick / s0-20 / s0-100** 三个（避免过度设计）。`2aeb55760f` 慢流为**合成慢流**（~4KB / 150 段落 / 60ms 块），**不是 large-profile harness**；S2 真实 profile 规模仅来自 L2 导入 asset（§8.2/§11.1）。copy-paste 为隔离插入场景；**cut 语义保留但未基准化**（cut-paste 为延后独立契约覆盖，不属于当前优化指标）。
- **C. 修复前生产构建规模 artifacts（HEAD `ded532cdea`，dirty）**：quick/s0-20/s0-100 **全部 12/12 gate、40 指标**。p50 曲线（quick / s0-20 / s0-100，单位 ms）：

  | 指标 | quick | s0-20 | s0-100 |
  |---|---|---|---|
  | 编辑进入（D 生效后） | 27.3 | 69.1 | 315.0 |
  | 编辑退出（D 生效后） | 24.8 | 63.4 | 307.3 |
  | 粘贴 total（E 前） | 1407.5 | 2592.7 | 11040.0 |
  | 粘贴 perInsert 后续（subsequent） | 219.6 | 385.4 | 1754.4 |
  | 答案切换（F 前） | 234.4 | 618.3 | 4631.8 |
  | foldSettle | 159.1 | 411.0 | 3225.4 |
  | scrollStart | 253.1 | 677.3 | 5325.2 |

  **Artifact 保留警示**：Playwright 每次运行清空 `test-results`，验证会话把 artifacts 备份到会话临时路径（可能不持久）——按 §5.1 分类为**会话持有、可引用身份但不可依赖路径**；新会话先检查存留并在下次 E2E 前逐个备份（见保留警示）。
- **D. 编辑模式稳定宿主（已实现并验证）**：renderer-only 稳定 `MessageContextMenu`，可见消息子树不再重挂载；显式 boolean `resetToken` 保留内联编辑器关闭行为。renderer 测试/typecheck 通过；fresh build + quick/20/100 Phase 1（编辑模式）gate 通过；D 生效后编辑 p50 即上表 C 数值。**无独立阈值**。
- **E. 粘贴批量（已实现并验证）**：复用既有 `pasteMessagesToTopic`；Main 侧一次 `MessagesRepository.insertManyAt`（健康稠密 zero normalization、稀疏 parity 精确 splice）；renderer 一次 `messagesReceived`/`upsertManyBlocks`；DB 写入前 active-topic 前置条件；cut 语义保留未基准化。fresh build + quick/20/100 **12/12 gate、post-fix artifacts（35 指标）通过**。post-fix 数值（p50，quick/s0-20/s0-100）：paste total **256.4 / 452.2 / 1862.1 ms**；batch.commit **52.5 / 69.4 / 272.0 ms**；与修复前 total 的直接比值 **0.182x / 0.174x / 0.169x**。**L3 暂定**（非阈值、非基线）。
- **F. Answer-tab 原子选择（已实现，独立审计 + fresh 生产构建验证通过）**：实现细节见 §17 2026-08-14 实现行——新 purpose-specific 契约 `chatdb:select-answer-message`、Main 单事务校验/回滚、数据源单次调用 + 恰一次 `updateTopicUpdatedAt`、单 plural Redux 提交、`MessageGroup`/导航/`appendAssistantResponse` 调用方全更新、200ms 滚动不变；PERF gate 按两个 `foldSelected` 字段翻转计数（独立于 store 通知粒度），指标 id 不变。**独立审计（fresh Auditor，非实现会话）**：verdict = **pass-with-findings、0 blockers**——findings 为 1 项 style-only 过时 spec 头 + 2 项投机性/既有覆盖/边缘风险（无 in-scope blocker，按交接规则无需修正）；确认无越界改动（PERF-LOCK-008：无架构/持久化/兼容/隐私变更）。**fresh 生产构建 + 串行 scale 验证（未改动 worktree）**：`pnpm build` 退出码 0（Electron ABI 145）；quick、s0-20、s0-100 三次 focused `perf100-measurement.spec.ts` E2E 退出码均 0——每次 Phase 1–4 全过、**12/12 正确性 gate**、**strict schema-v1 校验**、**35 有限指标**、git `ded532cdea` dirty、编辑（D）与粘贴（E）gate 保持 green。**post-fix answer p50（quick/s0-20/s0-100）**：switch **94.0 / 272.7 / 1410.4 ms**、foldSettle **36.3 / 77.6 / 278.4 ms**、scrollStart **204.4 / 364.9 / 1706.0 ms**；与修复前 C 的直接比值 switch **0.401x / 0.441x / 0.305x**、foldSettle **0.228x / 0.189x / 0.086x**、scrollStart **0.808x / 0.539x / 0.320x**——**L3 暂定**（非阈值、非基线，§7 新行）。**Artifacts（gitignored 本地 deliverable）**：`perf100-measurement-20260814-124609.636.json`（quick，sha256 `0b04bd6e505ce2f9a6758fa71fd6bc4713ddd4461dd36ec8b02e302ef275cc90`）、`perf100-measurement-s0-20-20260814-124714.909.json`（sha256 `77dcd3baec00206032a218f34878f91a768d7cbdd1f85aebb6fc8f1e2a87ad78`）、`perf100-measurement-s0-100-20260814-124835.092.json`（sha256 `fcdc99c73ff61a8a92cd7e44b0e8c382e084dd7b6b3b4e816be9c434ef8bb210`）；备份根 `/var/folders/9v/733tfwtj2jvgwygmtrbwj9gm0000gn/T/kilo/perf100-validation-20260814-124200/`（路径可能不持久，见保留警示）。

**历史记录（2026-08-13，保留）**：PERF-001 **Done**（§5.1/§7/§11/§12/§14）；crash 分诊完整记录（有界负面结论，§14 Q5/R9）；两次官方失败 E2E 运行与 harness 加固记录（诊断/失败证据，不进入基线，见下方引文）；修复前单一规模点 full-pass（artifact `perf100-measurement-20260813-194939.616.json`，gitignored 本地 deliverable；数值 105.5/118.4/1191.9/63.9/188.4/208.6/142.5/225.4 ms 等，L3 暂定，小样本 p95 = max）。以上全部按 §6 分层，无任何数值升级为阈值/基线。

> **2026-08-13 失败运行记录（诊断/失败证据，保留，不进入基线）**：测量 spec 加入后两次官方 E2E 均在首个 Phase 3 答案标签切换处以 `Execution context was destroyed` 确定性失败（执行上下文销毁；原「崩溃 + 自动重载一致」措辞已更正），Phase 1/2 通过、Phase 3 零样本、无 artifact、无计时被接受；环境存在内存压力、历史瞬时状态不可重建；只读 Inspector 调查返回空报告。受控 ui-observe A/B 与官方 runner 诊断 3/3 通过（零 render-process-gone / child-process-gone / navigation）；harness 加固（evaluate-closure 修复、Electron 内嵌 Node 元数据、`>=200ms` smooth scroll、焦点守卫、有界超时等）后 full-pass 恢复。上述记录保留于此，不进入基线，不改变 Q5 有界结论与 H5/H6/H7 语义。

**当前 Active 工作流**：**无**（Active 同一层级唯一，§3）。PERF-100 已 **Done**（§12）；PERF-101/102（P1）保持 **Approved**，仅在 Main 决策检查点显式授权后标记 Active（**至多一个**，§16 下一单元；每个保持自己的验收与交接）；PERF-002（Planned）与 PERF-004（Planned 提案，多维矩阵方向）保持 Planned，范围未批准。

**下一可执行单元（唯一，非执行）— Main 决策检查点**：

1. **Main 授权决策**：使用 PERF-LOCK-004（优先级 = 用户影响 × 时长、频率、规模曲线、阻塞线程/进程）**比较两个已批准工作流 PERF-101（P1 话题切换）vs PERF-102（P1 并行窄流）**，结合 §10.1 用户报告、§10.2 静态调查与 §8 规模矩阵，**显式授权至多一个为 Active**（§3：Active 同一层级唯一；§12）。被授权者标记 Active 并回写 §12/§16；另一保持 Approved 直至另行授权。PERF-100 关闭**不自动激活**任何工作流。
2. **不开始实现**：本单元只做决策与回写，不启动任何实现/测量/验证。未授权前 PERF-101/102 保持 Approved，不得标记 Active；PERF-002/004 保持 Planned。
3. **最终交付 gate（已完成，2026-08-14）**：独立 Validation 会话已对本文档写回后的状态运行强制 `pnpm format`、`pnpm lint`、`pnpm test`（Node lane ABI 137）并全部通过（退出码均 0；`pnpm test` 后 Electron ABI 145 已恢复；`pnpm format` 对 code/test/config 零改动，仅 gitignored `test-results/.last-run.json`，先前 fresh-build PERF-100 E2E 证据保持有效，PERF-LOCK-005）——该 gate 已关闭，本单元仅剩 Main 授权决策（第 1/2 项）。

**成功条件（当前单元 = Main 决策检查点）**：

- Main 完成 PERF-101 vs PERF-102 的 PERF-LOCK-004 比较并**显式授权至多一个为 Active**（或在授权前决定延后/维持现状），§12/§16 同步回写。
- 被授权工作流标记 Active 后保持自身验收与交接；未被授权者保持 Approved；PERF-002/004 保持 Planned。
- 独立 Validation 会话已运行 `pnpm format` / `pnpm lint` / `pnpm test` 且全过（**已完成，2026-08-14**，退出码均 0；本程序处于最终交付状态）。
- 不因 PERF-100 关闭自动启动任何实现（关闭不激活下一工作流）。

**非目标（不得做）**：

- **不做**：新增矩阵级别、cut 基准、DB 体积 harness、广泛 memoization/窗口重设计、新性能阈值（唯一已提交阈值仍为冷开 `<500ms`）；不把任何 L3 数值（2026-08-13 / C / E / F post-fix answer）提升为阈值或基线。
- **本单元不开始实现**：Main 决策检查点只做授权决策；未获授权前 PERF-101/102 保持 Approved，**不启动实现/测量/验证**。
- 不重述最终强制 gate 为待执行/未通过（`pnpm format`/`pnpm lint`/`pnpm test` 已由独立 Validation 会话通过，2026-08-14）；不声称 H7 为历史失败原因、不声称崩溃已修复。
- 不修改生产/运行时代码；不改架构、持久化、兼容、隐私语义（PERF-LOCK-008、§13）。
- **不提交/推送**（git）除非用户明确要求；HEAD `ded532cdea` 为脏 worktree，**不得推断 clean 状态**。
- 不删除历史记录（§17/§16 历史段与 A–E/2026-08-13 数值保留）；不把会话临时路径当作持久 artifact 路径。

**Artifact 保留警示（重要）**：Playwright 每次运行清空 `test-results/`；PERF-100 收尾验证（2026-08-14）把三个 artifacts 备份到**会话临时路径** `/var/folders/9v/733tfwtj2jvgwygmtrbwj9gm0000gn/T/kilo/perf100-validation-20260814-124200/`（子目录 quick/s0-20/s0-100），可能不持久。**新会话第一步检查 `test-results/bench-results/` 与上述备份路径中残留哪些 artifact（文件名与 checksums 见 F），并在运行任何 E2E 之前把每个仍需要的 artifact 复制到本次会话可持久的位置**；`test-results/` 全目录 gitignored，不提交仓库（§5.1）。

**环境要求**：固定工具链（Node 24.11.1 / pnpm 10.27.0）；`pnpm test` 走 Node lane（ABI 137）；`pnpm build` / `pnpm test:e2e` 走 Electron lane（ABI 145，LOCK-005）；`pnpm ui:observe` 仅诊断（L2，`ui-verify-change` 分类）。正式测量按 §5.1 产出 schema v1 artifact（验证通过的产物保留为 gitignored 本地 deliverable）。

**诚实性声明**：本交接只记录已完成证据（A–F 全部完成并验证，2026-08-14）。C/E、2026-08-13 数值与 F 的 post-fix answer 数值均为 **L3 暂定**——不是阈值、不是基线，未提升（PERF-LOCK-003）。F 的 focused 验证数字（实现会话报告）与独立审计 + fresh build/三次 E2E 的集成证据按 §6 分层记录。**最终强制 `pnpm format`/`pnpm lint`/`pnpm test` 已由独立 Validation 会话在本文档写回后的状态上运行并通过（2026-08-14，退出码均 0；Node 24.11.1 / pnpm 10.27.0；lint：oxlint 0 errors/76 baseline warnings、eslint 0 errors、node/web/aiCore typecheck 退出码 0、i18n pass、format clean；test：Node lane 后 Electron ABI 145 已恢复，main 1775 pass/72 skip、renderer 1726 + 53 pass、aiCore 4152 pass、shared 380 pass、scripts 494 pass、e2e-utils 242 pass/3 skip、无 failures；`pnpm format` 对 code/test/config 零改动，仅 gitignored `test-results/.last-run.json`，先前 fresh-build PERF-100 E2E 证据保持有效，PERF-LOCK-005）**。Q5 保持有界关闭（历史事件为执行上下文销毁，非已证明崩溃/重载；H7 未证明）。当前**无 Active 工作流**；PERF-100 关闭不自动激活 PERF-101/102。

**参考**：§9（基线 0）、§10.1/§10.2（L4 用户报告 + 静态调查，方向判断）、§7（暂定预算，L3 数值；含 F post-fix answer 新行）、§8（多维规模矩阵；验收 profile quick/s0-20/s0-100）、§5.1（结果契约）、§11（harness 清单/资产保留）、§14（R1 部分缓解、R3/R4 关闭、R9 已分诊、R10 已满足、Q5 已关闭、R11 保留、**R12 已满足**、Q6）、测量 spec（`tests/e2e/specs/conversation/perf100-measurement.spec.ts`，`PERF100_SCALE` 环境变量）、2026-08-14 实现行与关闭行（§17，F 完整细节）、artifact 身份与 checksums（§16 F，gitignored 本地 deliverable，**路径可能不持久**——见保留警示）。

---

## 17. 变更记录（Change Log）

| 日期 | 变更 |
|---|---|
| 2026-08-13 | 创建本文件：基线 0 = `c03a5c392c` / `ad73468eb3` / `2aeb55760f`；决策锁 PERF-LOCK-001…008；证据层级 L1–L4；暂定预算（校准前）；规模矩阵 S0–S3；harness 清单；工作流表（PERF-001 Active）；PERF-001 为下一可执行单元 |
| 2026-08-13 | 用户批准热点重排：**P0 = 编辑模式进入 + 多消息中部插入（PERF-100）**；**P1 = 话题切换点击→首次可用渲染（PERF-101）与并行窄流可视流畅度（PERF-102）**。PERF-001 窄化为使能切片（migration-004 chatDb 加载/写入基准核验 + 机器可读结果 schema/存储策略），仍是当前唯一 Active 与下一可执行单元；PERF-003 Retired（优先级由用户批准取代）；§10 拆分为用户报告（L4，含 5–6 秒量级与定性症状）与静态调查（§10.2，诊断性/静态证据，非 L2 运行时观察）；PERF-100/101/102 为 Approved、测量先行；§12/§14/§16 相应更新。同日审计修正（F1–F3）：§16 交接仅指向 PERF-100（P0）为下一可执行单元，P1 并行仅在 P0 完成后经 Main 批准考虑；§11 共享/aiCore 行移除「待 PERF-001 盘点」归属，覆盖盘点为后续跟进；§10.2 静态调查不再标注 L2（§6 的 L2 为运行时观察） |
| 2026-08-13 | PERF-001 结果契约实现（schema v1）：新增 `src/main/services/chatDb/__tests__/benchResult.ts`（封闭 schema 类型 + 运行时校验器 + 环境/git 元数据收集 + 写入器，默认 gitignored `test-results/bench-results/`，`BENCH_RESULTS_DIR` 可覆盖，命名 `<id>-<timestamp>.json`）与 `benchResult.test.ts`（元数据/序列化/路径/敏感字段封闭性聚焦测试）；`search.bench.ts` / `sqlite-runtime.perf.bench.ts` 在全部 gate 通过后发射 schema v1 JSON artifact（console 输出与 parity/冷开 gate 语义不变）；§5.1 记录契约、§7/§11/§14/§16 相应更新。**运行时核验（parity/冷开 gate/artifact 实际生成）待 Validation 会话；PERF-001 未标记完成** |
| 2026-08-13 | **审计修正（F1–F4）+ 多模型答案标签切换并入**：F1 — artifact 改为仅在**所有已注册 tinybench 任务成功完成**后发射（文件级 `afterAll` 门控，`emitBenchmarkResultAfterSuccessfulTasks`；Vitest bench 模式静默吞掉抛错任务，门控为唯一保证；describe 级 afterAll 在 bench 模式不执行，cleanup 移至文件级）；F2 — `pnpm` 字段仅从真实 `pnpm/` UA 解析，npm/yarn/bun UA 一律 `unknown`，绝不标注为 pnpm；F3 — `collectEnvironmentMetadata` 的 `command` 改为必需显式安全规范命令（删除 argv 派生回退），写入校验拒绝含路径段命令；F4 — 默认文件名毫秒级 `<id>-<YYYYMMDD-HHmmss.SSS>.json`，自动命名冲突时追加 `-1`/`-2` 后缀不再覆盖（显式 fileName 按原样使用）。新增测试：错误包管理器 UA、必需命令、路径滥用策略（含写入拒绝）、完成序门控结构、unit/detail 非空与时间戳格式校验、文件名唯一性。§10.1 新增多模型答案标签切换 1–2 秒 L4 报告；§10.2 新增对应静态调查（含源引用）；§12 PERF-100 范围并入标签切换（保留其持久化/滚动独有维度）；§14 Q3/R6 相应扩展；§16 交接段更新（Active 与 PERF-001→PERF-100 交接语义不变）。**PERF-001 仍待 Validation 运行时核验，未标记完成** |
| 2026-08-13 | **PERF-001 Validation 核验完成并关闭（PERF-100 交接）**：Validation 会话在 HEAD `3d61027bf2`（worktree dirty=true，按设计）执行 `pnpm bench:main:native`（Node 24.11.1 / pnpm 10.27.0，Node lane ABI 137，Electron ABI 145 已恢复）退出码 0（含 finalizer）——search parity 10/10 fixture、sqlite parity 5 topics/1000 messages/1100 blocks、冷开 sanity 15/15、冷开 p95 **84.31ms** `<500ms`；两个 schema v1 JSON artifact 逐字段校验通过、forbidden-field 扫描干净，随后按保留/清理策略移除（**session-owned，非持久文件；不引用持久 artifact 路径**）。§5.1 新增「已验证运行」段（L1 gate 证据 vs L3 数值输出分层）；§7 校准流程更新、冷开行记录 84.31ms（暂定性质，不升级为已提交阈值，唯一已提交阈值仍为冷开 `<500ms`）；§11 更新运行时核验结果（三行）；§12 **PERF-001 → Done**、**PERF-100 → Active（唯一 Active/下一可执行单元）**、优先级顺序更新；§14 **R3 关闭**（基准在当前 schema 正确运行）、**R4 关闭**（存放/体积策略已定义且真实验证）、R1 部分缓解（发射已验证，持久基线仍待 PERF-002）；§16 整体重写为 PERF-100（P0）测量先行交接。用户报告数值保持 L4（§10.1 未改动）；无运行时/架构/迁移/兼容/生命周期/隐私/发布/平台变更（PERF-LOCK-008） |
| 2026-08-13 | **PERF-100 测量运行失败记录 + 下一可执行单元切换为 crash 分诊**：测量 spec `tests/e2e/specs/conversation/perf100-measurement.spec.ts` 已加入（编辑模式进入 5 进/5 出、多消息中部粘贴 3 样本 × 3 组复制 × 每组 6 次插入、答案标签切换 4 次计划、全通过后发射 schema-v1 artifact）；独立审计无阻塞项、接受的加固已应用。官方序列：fresh `pnpm build` 退出码 0；focused E2E 两次运行均在首个 Phase 3 答案标签切换处以 `Execution context was destroyed` 确定性失败（与 renderer 崩溃 + WindowService 自动重载一致），Phase 1/2 两次均通过、Phase 3 零样本、无 artifact、无计时被接受；环境内存压力与无关进程存在但 H5/H6/H7 未决；只读 Inspector 调查返回空报告。§14 新增 R9（根因未定阻塞测量恢复）/R10（部分通过误当指标）/Q5（H5/H6/H7 根因）；§16 下一可执行单元改为**只读/动态 crash 分诊**（区分 H5 测试仪器 / H6 正常答案标签切换应用路径 / H7 环境内存压力）并给出恢复测量验收条件（根因变更或受控 + fresh build 与 focused E2E 退出码 0 + 全部 3 阶段通过 + schema-v1 artifact 按 §5.1 校验）；两次失败运行记录为诊断/失败证据而非基准。PERF-100 保持 Active（唯一）；PERF-001 保持 Done；用户报告数值保持 L4；无生产/运行时变更（PERF-LOCK-008） |
| 2026-08-13 | **PERF-100 crash 分诊完成、Q5 以有界结论关闭、下一可执行单元切换为测量 harness 加固**：受控 ui-observe 普通/带仪器 A/B 通过；受控官方 runner 诊断（HEAD `3d61027bf2` 与既有 build）3/3 通过（trace/video on 2/2、off 1/1），原始 Main tapes 零 render-process-gone / child-process-gone / navigation；run-2 存在 18.93s 无匹配超时的 evaluate pending、决定性失败 profile Main 日志丢失；可比压力存在但历史瞬时状态未知；独立审计建议有界负面结论关闭 Q5。历史事件措辞更正为**执行上下文销毁**（非已证明的 renderer 崩溃、非已证明的 WindowService 自动重载）；H5/H6 仅作为确定性/充分原因被否定（未证明不可能）；H7 保留为未证明的历史瞬时/放大器风险；不声称 H7 为原因、不声称崩溃已修复；分诊产物与既有保留目录均为非持久 L2 诊断证据、**无任何指标被接受**。§14 R9 已分诊、Q5 已关闭、R10 增补 harness 前置条件（`SCALE.scrollFloorMs` evaluate-closure 缺陷受控）；§16 下一可执行单元改为**测量 harness 加固**（只改测量 spec/辅助逻辑，不恢复正式测量），恢复测量需 harness 前置条件 + 既有四项正式 gate 全部满足。PERF-100 保持 Active（唯一）；PERF-101/102 保持 Approved；PERF-001 保持 Done；用户报告数值保持 L4；无生产/运行时/治理变更（PERF-LOCK-008、§13） |
| 2026-08-13 | **PERF-100 修复前测量 full-pass 验证通过 + scale-aware 方法论与多维矩阵落地**：**§1.3 新增放大优先方法论**（放大原则 `耗时 × 频率 × 数据规模 × 所在线程`、六环证据链、放大器评审清单）；**§7 重构为三类暂定预算**（交互/热路径/规模，§7.1）并加入已批准参考候选（echo target `<50ms`/ceiling `<100ms`、Main IPC `<10ms`、流式持久化节流 `<10%`、无持续性 `>50ms` renderer 长任务、300-turn 分支 `<1–2s`——全部**未验证、非阈值、待校准**）与 PERF-100 L3 数值行；**§8 扩展为多维规模矩阵**（话题消息数 0/20/100/300/600/1200、FTS 文档 1k/10k/50k/120k、合成 DB 目标体积 20MB/200MB/1GB/2GB（隐私约束：只记录确定性合成目标、绝不记录用户/profile 原始体积，LOCK-006）、流长度 1KB/10KB/40KB/100KB、可见消息 10/50/100、并发单/多模型/跨话题），保留 S0–S3 正交分类并解释话题规模 vs 可见窗口 vs 整体 profile 规模；**§11 新增继承资产/差距映射（§11.1）与资产保留治理（§11.2）**（五类保留 + 不保留清单；`bench:shared`/`bench:aicore` 确认无已注册基准资产）；**§12 新增 PERF-004 提案**（统一规模矩阵 harness + 跨运行曲线/方差/knee 消费，Planned，不改变 PERF-100 唯一 Active）；**§14 新增 R11/Q6**、R1 进展、R9/Q5 增补、**R10 已满足**。**PERF-100 验证通过（2026-08-13）**：artifact `test-results/bench-results/perf100-measurement-20260813-194939.616.json`（schema v1，gitignored 本地 deliverable；fresh build 退出码 0、focused E2E 退出码 0、Phase 1/2/3/4 全过、10/10 正确性 gate、40/40 有限指标、Electron ABI 145、HEAD `3d61027bf2950ab62f6a2a21448844ba1c1c4f42` dirty=true、timestamp `2026-08-13T11:49:39.529Z` UTC、node（Electron 运行时内嵌）`v24.14.1`）；**L3 暂定数值**：编辑进入/退出 p50 105.5/118.4ms、粘贴总/首次/稳态逐条 p50 1191.9/63.9/188.4ms、答案切换/foldSettle/scrollStart p50 208.6/142.5/225.4ms，**小样本 p95 = max**，非阈值、非基线；恢复测量验收条件（harness 前置 + 四项正式 gate）**全部满足**；§16 下一可执行单元改为 **S0 中列表规模曲线参数化**（≤100 messages，保留当前快速场景、不新增 cut-paste 场景——copy-paste 为隔离插入场景、cut-paste 延后独立契约覆盖；300+ 与 profile 负载按需 LOCK-007）；`2aeb55760f` 明确为合成慢流（~150 段落/60ms/约 4KB）非 large-profile harness、S2 真实 profile 规模仅来自 L2 导入证据与 opt-in 导入 harness。PERF-100 保持 Active（唯一）；PERF-101/102 保持 Approved；PERF-002/PERF-004 保持 Planned；用户报告数值保持 L4；无生产/运行时/治理变更（PERF-LOCK-008、§13） |
| 2026-08-14 | **PERF-100 多模型答案标签切换 bounded 修复实现（跨进程契约变更切片）**：新增共享命令 `chatdb:select-answer-message`（`SelectAnswerMessageRequest{ topicId, selectedMessageId, messageIds }` → `null`；契约强制非空唯一 ID、selected 恰好一次、无多余字段，注册进 `chatDbContracts` 与 `ChatDbCommands`）；Main 聚合 `selectAnswerMessage` 单根事务先校验每个提供 ID 属于该话题（缺失/跨话题 → `NOT_FOUND`，重复/selected 缺失 → `CONFLICT_ERROR`，整事务回滚无部分写入）再持久化 `foldSelected`（selected=true、其余 false，仅此字段）；IPC 注册（`ChatDb_SelectAnswerMessage`）+ preload + `ChatDbApi`/`MessageDataSource`/`DbService` 全链路由通；数据源成功后恰好一次 `updateTopicUpdatedAt`（thunk 不再重复）；`selectAnswerMessageThunk` DB-first + 一次 plural `updateManyMessages` Redux 提交（adapter `updateMany`）；`MessageGroup.setSelectedMessage`（200ms smooth-scroll 原样保留）、导航 `selectMessageForFold`、`appendAssistantResponseThunk` 同 invariant 双写对全部改用该命令（fire-and-forget 语义保留）；**不**触碰单消息 `updateMessageAndBlocks`、粘贴/编辑实现、schema/迁移/身份/兼容/生命周期。**PERF-100 测量 spec gate 措辞更新**：`answerTab.foldFlips` 改为「恰好两个 foldSelected **字段**变化（旧 true→false、新 false→true），由**一个原子 select-answer-message Main 事务 + 一个 plural Redux 提交**提交」——按实体 map 逐消息计数，不依赖 store 通知粒度（单 plural 提交=单次通知仍满足）；`answerTab.switch/foldSettle/scrollStart` 指标 id 与 200ms 滚动地板 gate 保持原样供前后直接对比。**新增测试**：共享契约 registry/计数/校验（valid/invalid/round-trip/allowedKeys）、聚合 exactly-one/ownership/缺失回滚/跨话题回滚/重复/selected 缺失/触发强制全回滚（真实 SQLite）、IPC 注册（37 handlers）与边界校验、数据源单次调用+恰一次时间戳+失败不派发、thunk DB-first/一次提交/失败不动 Redux/不自派发时间戳、Redux `updateManyMessages` 单提交保序保字段、MessageGroup 调用方/200ms timer、`selectAnswerMessage` 调用方包装。**验证**：`pnpm test:main`（74 文件 1775 通过）、`pnpm test:renderer`（251 文件 4152 通过）、`pnpm test:shared`（670 通过）、`pnpm test:aicore`（380 通过）、`pnpm typecheck` 退出码 0、changed-file Biome format/lint 与 ESLint 0 error。**未执行**：fresh 生产构建 + PERF-100 E2E（本实现会话不运行，按任务约束；修复后数值待后续测量会话按 §5 重测，仍为 L3 暂定）。PERF-100 保持 Active（唯一）；放大目标：一次选择的 DB 写/Redux 提交/`updateTopicUpdatedAt` 各一；PERF-LOCK-008 边界内（无架构/持久化/兼容/隐私变更，新命令为既有能力的聚合化，无 schema/migration） |
| 2026-08-14 | **PERF-100 跨会话交接更新（实现收尾；独立审计 + fresh build 验证为下一可执行单元）**：**A** crash 分诊与 harness 恢复完成——Q5 有界关闭（执行上下文销毁，非已证明崩溃/重载；H5/H6 仅作为确定性/充分原因被否定、H7 未证明保留）、fresh build + quick 测量恢复通过、schema-v1/生命周期磁带/scaled profiles 建立。**B** scale 方法论就位——多维矩阵（§8）为程序方向、当前验收 profile 仅 **quick/s0-20/s0-100**（避免过度设计）、`2aeb55760f` 明确为合成慢流（~4KB/150 段落/60ms 块）非 large-profile harness、S2 仅来自 L2 导入 asset、**cut 语义保留未基准化**。**C** 修复前规模 artifacts（HEAD `ded532cdea` dirty）：quick/s0-20/s0-100 **12/12 gate、40 指标**；p50 编辑进入/退出 27.3/69.1/315.0 与 24.8/63.4/307.3、粘贴 total 1407.5/2592.7/11040.0、perInsert 后续 219.6/385.4/1754.4、答案切换 234.4/618.3/4631.8、foldSettle 159.1/411.0/3225.4、scrollStart 253.1/677.3/5325.2——**session-preserved、路径可能不持久**（§16 保留警示）。**D** 编辑稳定宿主已实现并验证（renderer-only 稳定 `MessageContextMenu` + 显式 boolean `resetToken`；renderer 测试/typecheck、fresh build quick/20/100 Phase 1 gate 通过；编辑 p50 见 C；无独立阈值）。**E** 粘贴批量已实现并验证（复用 `pasteMessagesToTopic`、一次 `insertManyAt` 稠密 zero normalization/稀疏 parity splice、单 renderer 提交、active-topic 前置；fresh build + quick/20/100 12/12 gate、post-fix artifacts 35 指标；post-fix total p50 256.4/452.2/1862.1、batch.commit 52.5/69.4/272.0、比值 0.182x/0.174x/0.169x，L3 暂定）。**F** answer-tab 原子选择实现完成、**尚未生产构建验证**——契约 `chatdb:select-answer-message`、Main 单事务校验/回滚、数据源单次调用 + 恰一次 `updateTopicUpdatedAt`、单 plural Redux 提交、调用方全更新、200ms 滚动不变；focused 验证（实现会话报告，不替代独立审计/fresh build）：test:main 1775 通过/72 skip、renderer 4152、shared 670、aicore 380、scripts 494、e2e-utils 242 通过/3 skip、typecheck + changed-file lint/format 通过。§12 PERF-100 描述更新（F 未生产构建验证、下一单元为收尾验证）；§14 R1/R10/R11 更新、新增 **R12**（answer-tab 未审计/未 fresh-build 验证风险）；§16 重写为收尾交接——**下一可执行单元（唯一）**：① 独立审计（实际 diff/契约/回滚/调用方/gate）→ ② in-scope blockers 分诊 → ③ fresh `pnpm build` + focused `perf100-measurement.spec.ts` quick、`PERF100_SCALE=s0-20`、`s0-100` **串行**验证（answerTab 指标与 C 直接对比、paste/edit gate 保持 green、artifact 逐个保留）→ ④ post-fix answer 指标回写 §7/§12/§14/§16 + Main 关闭决策（**决策前不开始 PERF-101/102**）→ ⑤ 强制 `pnpm format`/`pnpm lint`/`pnpm test` 最终交付 gate。**非目标**：不新增矩阵级别、cut 基准、DB 体积 harness、广泛 memoization/窗口重设计、新阈值；不修改生产/运行时代码（审计 blockers 除外）；不提交/推送（除非用户明确要求；HEAD `ded532cdea` 脏 worktree 不得推断 clean）。**Artifact 保留警示**入 §16：Playwright 清空 `test-results`，先前备份路径可能不持久，新会话在下次 E2E 前检查并保留存留 artifact。PERF-100 保持唯一 Active；PERF-101/102 Approved；PERF-002/PERF-004 Planned。本会话仅更新本文档，无代码/测试改动、无提交/推送 |
| 2026-08-14 | **PERF-100 关闭写回 + 最终交付 gate 通过（PERF-LOCK 合规；本写回后强制 final gates 已由独立 Validation 会话执行并通过）**：独立审计 verdict = **pass-with-findings、0 blockers**（findings：1 项 style-only 过时 spec 头 + 2 项投机性/既有覆盖/边缘风险，均无 in-scope blocker，按交接规则无需修正）；fresh 未改动 worktree `pnpm build` 退出码 0（Electron ABI 145）；quick/s0-20/s0-100 三次 focused `perf100-measurement.spec.ts` E2E 退出码均 0——每次 Phase 1–4 全过、**12/12 正确性 gate**、**strict schema-v1 校验**、**35 有限指标**、git `ded532cdea` dirty、编辑（D）/粘贴（E）gate 保持 green。**post-fix answer p50（quick/s0-20/s0-100）**：switch **94.0 / 272.7 / 1410.4 ms**、foldSettle **36.3 / 77.6 / 278.4 ms**、scrollStart **204.4 / 364.9 / 1706.0 ms**，与修复前 C 的直接比值 **0.401x / 0.441x / 0.305x、0.228x / 0.189x / 0.086x、0.808x / 0.539x / 0.320x**——**L3 暂定**（非阈值/基线，PERF-LOCK-003）。Artifacts（gitignored 本地 deliverable；备份根 `/var/folders/9v/733tfwtj2jvgwygmtrbwj9gm0000gn/T/kilo/perf100-validation-20260814-124200/`，文件名与 checksums 见 §16 F）：`perf100-measurement-20260814-124609.636.json`（quick）、`perf100-measurement-s0-20-20260814-124714.909.json`（s0-20）、`perf100-measurement-s0-100-20260814-124835.092.json`（s0-100）。§12 **PERF-100 → Done**（PERF-101/102 保持 Approved、PERF-002/004 保持 Planned、**当前无 Active**）；§14 **R12 → 已满足**、Q6 stale Active 措辞修正、R11 保留；§7 新增修复后 answer-tab 多规模点 L3 行（2026-08-13 与 §16 C/E 历史数值保留不替换）；§11 PERF-100 spec 行补充收尾验证证据；§16 重写为**关闭后交接**——下一可执行单元 = **Main 决策检查点（非执行）**：按 PERF-LOCK-004 比较 PERF-101 vs PERF-102 并显式授权**至多一个**为 Active，**不开始实现**；PERF-100 关闭**不自动激活**任何工作流。**最终强制 `pnpm format` / `pnpm lint` / `pnpm test` 已由独立 Validation 会话在本文档写回后的状态上执行并通过（2026-08-14，退出码均 0，Node 24.11.1 / pnpm 10.27.0）：`pnpm format` 3s 对 code/test/config 零改动（仅 gitignored `test-results/.last-run.json`，先前 fresh-build PERF-100 E2E 证据保持有效，PERF-LOCK-005）；`pnpm lint` 50s——oxlint 0 errors/76 baseline warnings、eslint 0 errors、node/web/aiCore typecheck 退出码 0、i18n pass、最终 format clean；`pnpm test` 8m42s（Node lane ABI 137）——main 1775 pass/72 skip、renderer 1726 + 53 pass、aiCore 4152 pass、shared 380 pass、scripts 494 pass、e2e-utils 242 pass/3 skip、无 failures，Node lane 后 Electron ABI 145 已恢复**。无生产/运行时/架构/持久化/兼容/隐私变更（PERF-LOCK-008、§13） |
