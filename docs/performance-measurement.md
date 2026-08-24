# 性能测量契约（Performance Measurement Contract）

> **定位**：本文件是**持久测量契约**——性能工作的测量必须满足的稳定规则。非 ADR，不新增治理权威（PERF-LOCK-001）。
> **稳定**：本文件内容随时间不因单个工作流/运行而变；会话流水、校验和、日期明细与重复运行叙述由 Git 历史承担（DOC-002）。
> **权威来源**：方法论入口见 [`performance-program.md`](./performance-program.md)；当前可行动状态见 [`performance-workstreams.md`](./performance-workstreams.md)。

## 1. 固定工具链与 Lane 规则（Pinned Toolchain & ABI Lane）

测量必须满足以下契约，否则结果不进入基线：

1. **固定工具链**：Node 24.11.1 / pnpm 10.27.0（`.nvmrc` / `.node-version` / `package.json`）；任何 `pnpm` 命令前先核对 `node -v` 与 `pnpm -v`。
2. **Lane 契约**：`bench:*` 走 Node lane（ABI 137）；`test:e2e` / `ui:observe` / `build` 走 Electron lane（ABI 145）；结果必须标注所用 lane（AGENTS.md「Native ABI lanes」）。Lane 是**包命令运行时契约**，绝不由目录/测试/导入推断。
3. **数据隔离**：基准使用确定性语料与临时数据库，不触碰用户数据；PRAGMA/schema 不指向真实 profile。
4. **指标与报告**：p50/p95/mean、ops/sec 等数值指标 + 结构性不变量（正确性 parity、零 sibling UPDATE、原子性）。**正确性校验先于计时**，parity 失败即 abort。
5. **无历史对比值时显式报告**：不得虚构对照基线；无历史对比值须显式声明。
6. **阈值策略**：只有已提交断言阈值可进入测试/基准 gate；其余数值一律为暂定（§7）。
7. **机器可读结果**：结果以机器可读形式输出并存放到策略规定位置（§4）；大体积数据不提交仓库。
8. **可复现性标注**：任何基线/证据必须伴随命令、环境（Node/ABI/lane）、日期与结果位置；无法复现的不进入基线。

## 2. 证据层级（Evidence Hierarchy）

证据类型不可互换（PERF-LOCK-003）。判断回归、验收、优先级时按下表引用证据：

| 层级 | 证据 | 示例 | 能否作为回归判断 |
|---|---|---|---|
| **L1 仓库可验证回归证据** | 在 fresh 生产构建或确定性临时库上，由仓库内命令产生的**确定性断言** | Playwright E2E（fresh 生产构建 + 标准 fixture）；`vitest bench` 内强制 parity 与 gate；常规测试中的确定性正确性/结构断言 | **是**（集成契约级 / 结构级） |
| **L2 诊断性证据** | 观察性、非断言的运行时信息 | `pnpm ui:observe`、截图、CDP、dev 模式观察 | 否（仅定位，`ui-verify-change` 分类） |
| **L3 手工基准证据** | 本地手动运行基准的数值输出，未提交为 artifact/阈值 | 手工 `vitest bench` 的 p50/p95 输出 | 仅可参考，需按本契约重测确认 |
| **L4 用户报告历史结果** | 无 artifact 支撑的数值/通过声明（提交消息、会话记录） | `performance-workstreams.md` 记录的 L4 报告 | **否**（不可作为当前基线） |

规则：L1 是唯一可进入「已验证」的证据；L3/L4 只用于方向判断；L2 用于问题定位。证据与所跨边界匹配（AGENTS.md「Evidence and Judgment」）。

> **L1 运行 + L3 数值并存**：一次生产构建 E2E 运行可同时产生 **L1 确定性证据**（正确性 gate、结构断言、退出码）与 **L3 暂定数值**（p50/p95 等机器可读输出）——两者并存但不可互换（PERF-LOCK-003）。

## 3. 机器可读结果契约（Schema v1，PERF-001）

**Schema 版本常量**：`BENCH_RESULT_SCHEMA_VERSION = 1`（`src/main/services/chatDb/__tests__/benchResult.ts` 导出）。**变更 schema 必须升版**并同步更新本文件。

**Schema**：两个 chatDb 基准（`search.bench.ts`、`sqlite-runtime.perf.bench.ts`）在完整运行结束（全部正确性校验与 gate 通过、且**所有已注册 tinybench 任务成功完成后**，由文件级 `afterAll` 生命周期钩子写入）写一个小体积 JSON summary artifact，顶层字段固定为：

| 字段 | 内容 |
|---|---|
| `schemaVersion` | 固定 `1`（PERF-001 契约版本；变更必须升版并同步更新本文件） |
| `benchmark` | `id`（稳定身份，用于文件名与基线引用）、`name`、`scale`（确定性规模：语料数量/轮次/批量/分页等，全部为有限数值） |
| `environment` | 可复现性元数据：`timestamp`（ISO-8601 UTC，写入前校验格式）、`node`（版本）、`pnpm`（**仅从真实 `pnpm/` UA 解析**；npm/yarn/其他 UA 或缺失时记 `unknown`，绝不把其他包管理器版本标注为 pnpm）、`abiLane`（`node`/`electron`）、`abi`（`process.versions.modules`，Node=137/Electron=145）、`command`（**显式安全规范命令，必需**；绝不从 argv 派生，写入前校验不得含路径段）、`git`（`commit` SHA + `dirty` worktree 脏标记；git 不可用时 commit 为空串） |
| `metrics` | 数值指标数组 `{ id, name, value, unit? }`（p50/p95/p99/mean/min/max/ops-per-sec 等；禁止 NaN/Infinity；`unit` 出现时必须为非空字符串） |
| `gates` | gate 结果数组 `{ id, name, kind: 'correctness'\|'threshold', passed, detail? }`（parity 正确性 gate 与冷开 `<500ms` 阈值 gate 逐条记录；`detail` 出现时必须为非空字符串） |

Schema 为**封闭集**：不包含消息内容、凭据、用户路径、附件内容、原始数据库大小或 profile 数据字段（PERF-LOCK-006/007）；写入前经运行时校验器逐字段验证（未知字段/类型错误/非有限数值/空 unit 或 detail/非 ISO 时间戳/含路径段命令即拒绝并 abort，不产出 artifact），类型级形状由 `src/main/services/chatDb/__tests__/benchResult.ts` 的 `BenchmarkResult` 类型锁定。

**实现**：`src/main/services/chatDb/__tests__/benchResult.ts`（schema 常量、环境/git 元数据收集、运行时校验器、输出路径解析、写入器、**任务完成度门控发射器**）+ `benchResult.test.ts`（聚焦测试：元数据/序列化/路径行为/敏感字段封闭性）。

**发射时机**：artifact 只在**所有已注册 tinybench 任务以 `pass` 状态完成**后写入。两个基准把发射挂到**文件级** `afterAll` 钩子（`emitBenchmarkResultAfterSuccessfulTasks`，在 `describe` 之外注册）——Vitest bench 模式只执行文件级钩子、不执行 describe 级钩子，且抛异常的 bench 任务会被静默吞掉（运行可退出 0、任务停留在 `run` 状态），因此只有显式门控才能保证「artifact 存在 = 完整基准任务运行成功结束」。parity/冷开 gate 失败仍在收集期 abort（既有行为不变），artifact 不会产生。

**命名**：`<benchmark.id>-<YYYYMMDD-HHmmss.SSS>.json`（本地时间，ASCII，可排序，**毫秒级精度**）；自动命名在目标文件已存在时追加 `-1`、`-2`… 后缀，**同秒/同毫秒重复运行不再覆盖**；显式 `fileName` 按原样使用。

## 4. Artifact 存储 / 隐私 / 保留（Storage, Privacy & Retention）

- **默认位置**：`test-results/bench-results/`（仓库根下；`.gitignore` 已覆盖整个 `test-results/`，与 Playwright 输出、`ui:observe` 同一既有 artifact 约定）。
- **配置**：环境变量 `BENCH_RESULTS_DIR` 覆盖输出目录；写入器显式 `dir` 选项优先于环境变量。
- **保留/提交策略**：artifact 为**本地生成物，绝不提交仓库**；保留到被后续同 id artifact 取代或主动清理；大体积/原始数据（DB 文件、trace、profile）不落仓库。每次完整运行在末尾输出 artifact 绝对路径到 console。
- **隐私边界（PERF-LOCK-006）**：诊断有界——不记录消息内容、凭据、附件内容、原始数据库大小、路径。**数据库体积维度只记录确定性合成目标体积**，绝不记录观测到的用户/profile 原始 DB 体积。
- **资产保留治理**：快速确定性结构测试 → 常规测试（进入每次提交 CI）；生产构建 UI 契约 → Playwright E2E；可复用确定性生成器 → 共享模块；有界诊断 → 非持久、失败时附上；大规模/profile/trace/churn → 按需/定时（PERF-LOCK-007），不进入每次提交 CI。**不保留**：2GB 级 DB 文件、一次性 throwaway 脚本、无 schema artifact 的 console-only 基准输出。

## 5. 规模维度与 Profile（Scale Dimensions & Profiles）

测量与基准必须声明规模级别；**跨级别结论不得直接外推**。规模由**多维矩阵**与 **S0–S3 profile 规模分类**共同刻画：

**维度轴（dimension）**：一个可独立取值的规模轴（话题消息数、FTS 语料、DB 体积、流长度、可见窗口、并发度）；每次测量须声明各维度的取值点。

**Profile 规模分类（S0–S3，正交）**：

| 级别 | 规模 | 用途 / 边界 |
|---|---|---|
| **S0 单话题小规模** | 1 topic / ≤100 messages / ≤1000 blocks | 快速确定性回归（常规测试）；确定性放大候选上限 ≤100 messages |
| **S1 典型** | ~100 topics / ~10k messages / ~20k blocks（暂定示意） | 常规基准规模 |
| **S2 大 profile（真实 artifact）** | 2707 topics / 129150 messages / 158441 blocks（L2 真实导入 artifact 计数） | 按需/定时基准（不进入每次提交 CI） |
| **S3 极限 / 压力** | S2 之上的放大，或极端长消息 / 长列表渲染 | 专项审计，需明确环境与机器配置 |

**三个不同概念（测量时须分别声明）**：
- **话题规模（topic size）**：单话题的消息/块总数——驱动 O(N) 全话题计算（分组、上下文、窗口重建）。
- **可见窗口（visible window）**：单次渲染的消息数（`displayCount`）——驱动渲染 fanout/重挂载成本。小话题+大窗口与大话题+小窗口是两个不同测量点。
- **整体 profile 规模（whole-profile size）**：全部话题/消息/DB 体积——驱动冷开、加载、导入与 DB 体积轴。

## 6. Harness 清单与命令（Harness Inventory & Commands）

| Harness / 文件 | 命令 | Lane | 测量内容 | Claim 边界 |
|---|---|---|---|---|
| chatDb 运行时基准 — `src/main/services/chatDb/__tests__/sqlite-runtime.perf.bench.ts` | `pnpm bench:main:native` | Node | 消息加载 p50/p95、批量写入 ops/sec、冷库打开延迟 | 确定性临时库、不触碰用户数据；无历史对比值显式报告；仅 `<500ms` 冷开阈值断言；全部 gate 与已注册任务成功后输出 schema v1 artifact |
| 搜索基准 — `src/main/services/chatDb/__tests__/search.bench.ts` | `pnpm bench:main:native` | Node | 1k/10k/50k 语料 LIKE vs 混合 FTS p50/p95 + 全分页有序 parity | 正确性 parity **先于**计时、失败即 abort；确定性语料；无 CI 绝对阈值 |
| 渲染算法基准 — `src/renderer/src/pages/home/Messages/__tests__/Messages.bench.ts` | `pnpm bench:renderer` | Node | 消息列表倒序展示算法对比 | 纯算法对比（vitest bench），非端到端；结论需结合 E2E |
| 50k 尾端归因基准 — `bench:search-stage` / `bench:search-stage-plan` | 显式按需命令 | Node | 50k FTS fetch 子阶段归因 / query-plan 结构诊断 | 按需；默认 skip；无 CI 门槛；schema v1 |
| Sort-order shift controlled scale curve (M1) — `src/main/services/chatDb/__tests__/sortOrderShift.bench.ts` + `sortOrderShiftBench.ts` (pure helper) | `pnpm bench:sort-order-shift` | Node | 确定性临时库 middle/batch insert `sort_order` 移位规模曲线（100/500/1000 × 1/10/50, index floor(N/2), TEMP trigger 移位行数 + 插入计时）| 测量-only 按需诊断（diagnostic-only, default-gated, privacy-safe），默认 skip（`SORT_ORDER_SHIFT_BENCH=1`），隔离临时库 + `registerChatDbNormalize` + `runMigrations` schema-v1 + 现有 `insertAt`/`insertManyAt` API，**有界 3×3 矩阵方向性证据、非阈值**，正确性/parity（稠密序、期望 N-index 移位行数）先于计时且计时不含 trigger 搭建/语料生成，**已修正为计时区间不含输入构造（input construction）**，schema v1 artifact 仅在全部 tinybench 任务成功后发射（audit F1），`test-results/bench-results` gitignored |
| 共享 / aiCore 基准命令 | `pnpm bench:shared` / `pnpm bench:aicore` | Node | 现有命令入口 | 命令入口存在但**当前无任何已注册基准资产**；补覆盖须显式授权 |
| 测量辅助 — `src/main/services/chatDb/__tests__/benchMetrics.ts` | 随 `pnpm test` / 基准复用 | Node | percentile/mean/opsPerSec/sum/sortTimings 数值计算 | 数值计算一致性有测试锁定 |
| 结果契约 — `src/main/services/chatDb/__tests__/benchResult.ts` + `benchResult.test.ts` | 随 `pnpm test` 与基准运行复用 | Node | schema v1：元数据收集、校验、写入、门控发射 | schema 封闭集；写前校验失败即拒绝；pnpm 仅取真实 UA、命令显式无路径段、完成序门控 |
| 常规测试 — `pnpm test` | Node | 快速确定性正确性/结构性回归 | bench 文件**不进入**常规测试（按 project 单独 `benchmark.include` 收集） |
| 10k 导入/校验/恢复集成 harness — `src/main/services/chatDbImport/__tests__/importBenchmark.integration.test.ts`、`verification/__tests__/verificationBenchmark.integration.test.ts`、`promotion/__tests__/recoveryV2.test.ts` | 随 `pnpm test`（Main lane） | Node | 10k 级确定性导入、校验契约与恢复执行 | 集成契约/结构级；确定性合成数据；Main 进程 lane |
| 稠密序零 sibling UPDATE 结构不变量 — `src/main/services/chatDb/__tests__/repositories.test.ts` + `aggregate.test.ts`（LOCK-002 fast path） | 随 `pnpm test` | Node | 稠密零基序追加/插入保持零 sibling UPDATE；损坏/稀疏话题单趟修复回稠密序 | 结构级 L1 断言（正确性/结构不变量），非数值阈值 |
| Playwright E2E — `tests/e2e/specs/conversation/*`（PERF-100/101/102/103/104 测量 spec） | `pnpm build`（fresh 生产构建）+ `pnpm test:e2e` | Electron | 集成 UI 契约（编辑/粘贴/答案切换、话题切换、多模型流、回显、IPC RTT） | **集成 UI 契约的唯一回归证据**；标准 fixture + mock provider；规范见 `tests/e2e/README.md` |
| PERF-101 cache-hit repeat-switch — `tests/e2e/specs/conversation/perf101-cache-hit-repeat-switch.spec.ts` | `pnpm build` + each of `PERF101_CACHE_HIT=1 PERF101_SCALE=n20-w10 pnpm test:e2e -- tests/e2e/specs/conversation/perf101-cache-hit-repeat-switch.spec.ts`, `PERF101_CACHE_HIT=1 PERF101_SCALE=s0-20 pnpm test:e2e -- tests/e2e/specs/conversation/perf101-cache-hit-repeat-switch.spec.ts`, and `PERF101_CACHE_HIT=1 PERF101_SCALE=n100-w10 pnpm test:e2e -- tests/e2e/specs/conversation/perf101-cache-hit-repeat-switch.spec.ts` | Electron | deterministic per-message typed ChatDb bridge `appendMessage` seeding before the measured click；hydrated-topic cache-hit repeat switch；cache-miss 与 cache-hit endpoint、W-bound renderer cost | L1 correctness/parity/privacy/ABI gates；p50/p95/mean 为 L3 directional non-threshold；三个 profile aliases 与 cache-miss PERF-101 共享 |
| PERF-103 high-turn echo — `tests/e2e/specs/conversation/perf103-high-turn-echo-measurement.spec.ts` | `pnpm build` + each of `PERF103_HIGH_TURN=1 PERF103_HIGH_TURN_TURNS=20 pnpm test:e2e -- tests/e2e/specs/conversation/perf103-high-turn-echo-measurement.spec.ts` and `PERF103_HIGH_TURN=1 PERF103_HIGH_TURN_TURNS=100 pnpm test:e2e -- tests/e2e/specs/conversation/perf103-high-turn-echo-measurement.spec.ts` | Electron | batch-seeded prior-turn echo：Redux commit、first user DOM render、Redux→DOM、assistant visibility/completion 与 bounded attribution | L1 correctness/parity/privacy/ABI gates；timing/count metrics 为 L3 directional non-threshold；prior history 是 batch-seeded，不代表 sequential-send pressure |
| Phase 2A 阶段归因 harness（PERF-PHASE-001）— `packages/shared/diagnostics/phaseAttr.ts`（共享闭合契约/校验）、`src/renderer/src/services/phaseTimingDiagnostics.ts` + `src/main/services/phaseTimingDiagnostics.ts`（renderer/Main 适配器）、`tests/e2e/utils/perfPhaseAttribution.ts`（spec 侧纯派生/校验适配） | 启用：`PERF_PHASE_ATTR=1 pnpm build` + `PERF_PHASE_ATTR=1 pnpm test:e2e -- tests/e2e/specs/conversation/perf103-echo-latency-measurement.spec.ts`（PERF-103 standard）与 `PERF_PHASE_ATTR=1 PERF101_CACHE_HIT=1 PERF101_SCALE=n20-w10 pnpm test:e2e -- tests/e2e/specs/conversation/perf101-cache-hit-repeat-switch.spec.ts`（PERF-101 cache-hit；`s0-20`/`n100-w10` aliases 同构）——**env gate 必须同时作用于构建与 focused E2E 进程**；`perf103-high-turn-echo-measurement.spec.ts` **不发射 Phase 2A 阶段分解**；默认未设置时构建/E2E 均 inert；共享契约与纯派生单测随 `pnpm test` | Electron（生产构建 + specs）；Node（纯逻辑单测） | 每样本每阶段函数跨度时长（echo / topic 两路径；cache-miss 与 cache-hit 分离系列）、opaque correlation ID、DOM 端点冻结快照、Main-clock `echo.mainAppend` | 默认-off 构建门控（`resolvePhaseAttrGate` fail-closed）；closed `PhaseStage` union；512 有界环形缓冲 + overflow 即失败；启用态 fail-closed 完整性（required stages / singular multiplicity / 显式 causal order / exact count）；`phase.span.*` 为直接捕获时长之和、非端到端、可与 DOM endpoint 重叠/超出（LOCK-2A-008）；L1 正确性/privacy/ABI gates vs L3 timing；schema v1 输出；不改变生产行为。完整契约见 §6.1 |
| 流式响应 E2E — `tests/e2e/specs/conversation/streaming-responsiveness.spec.ts` | `pnpm build`（fresh 生产构建）+ `pnpm test:e2e` | Electron | 流式/多模型输出交互契约（可视流畅度回归面） | L1 集成契约（scroll/input/exact completion gates）；当前 cadence 模型为 50ms 候选（workstreams §2.2.1），历史 150ms 为对比条件 |
| 流式 cadence 测量 E2E（PERF-STREAM-CADENCE-001）— `tests/e2e/specs/conversation/perf-stream-cadence.spec.ts` + `tests/e2e/utils/perfStreamCadence.ts` | fresh `pnpm build` + `PERF_STREAM_CADENCE=1 pnpm test:e2e -- tests/e2e/specs/conversation/perf-stream-cadence.spec.ts` | Electron | N=1 确定性慢流：Redux/visible 区间、chars/update、ratio、frame delta、long-task 时间戳关联、startup/steady/completion 阶段处理 | 测量-only 默认 off（`PERF_STREAM_CADENCE=1` opt-in，plain `pnpm test:e2e` 保持 green）；L1 正确性/DOM/Main parity/reference 完整性/ABI/privacy gates vs L3 timing/count metrics（schema v1，PERF-LOCK-006 privacy）；无 React commit/component-local smooth-state 声明；Electron lane ABI145；昂贵 E2E 默认 off；纯 helper 测试在 Node `e2e-utils` 通过正常 `pnpm test` 始终 on |
| 流式持久化差分基准（PERF-STREAM-ATTR-001）— `src/main/services/chatDb/__tests__/streamPersistDifferential.bench.ts` | `pnpm bench:stream-persist` | Node | 确定性临时 DB 上 trigger-on vs base-only 的 SQLite 投影差分（growth/nochange/completion 三 profile、200-block 语料） | L3 方向性差分（LOCK-STREAM-ATTR-006），**非直接 trigger 内部剖析、非根因**；正确性/parity/completeness 为 L1 gate；确定性临时数据、无内容/凭据/路径；gate 全过后输出 schema v1 artifact |
| 流式持久化归因 E2E（PERF-STREAM-ATTR-001）— `tests/e2e/specs/conversation/streaming-persist-attribution.spec.ts` | `PERF_STREAM_ATTR=1 pnpm build` + `PERF_STREAM_ATTR=1 pnpm test:e2e`（focused spec） | Electron | 生产构建下真实 renderer/IPC/Main 流式写路径归因（renderer schedule/serialize/IPC/total + Main handler/aggregate/convert/tx + changed-vs-unchanged 计数） | 测量-only 开关默认 inert（LOCK-STREAM-ATTR-001）；仅 L1 正确性/parity/completeness 断言，计时为 L3 非阈值；`renderer.ipc − main.handler` 为 IPC 开销**估计**（非直接 IPC 剖析）；trigger 投影成本在 Node 差分测、不在 E2E 测；opaque correlation id 配对 + 有界环形缓冲；标准 fixture + mock provider |
| 流式渲染归因 E2E（PERF-STREAM-ATTR-002）— `tests/e2e/specs/conversation/perf-stream-render-attr.spec.ts` + 纯派生 `tests/e2e/utils/perfStreamRenderAttr.ts` | fresh `pnpm build`（无 PERF_STREAM_ATTR）+ `PERF_STREAM_RENDER_SCALE=n1\|n2\|n3 pnpm test:e2e`（focused spec） | Electron | 生产构建下真实 renderer 稳态放大归因（每助手 Redux 块内容提交序列、`.markdown` DOM 解析内容提交序列、调度包含式 Redux→next-DOM 提交间隔、累计内容体积轴、long task、帧间隔、输入延迟探针） | 测量-only 默认 `test.skip`（LOCK-STREAM-RENDER-005 默认关闭，plain `pnpm test:e2e` 保持 green）；仅 L1 正确性/parity/completeness 断言，计时为 L3 非阈值（LOCK-STREAM-RENDER-003）；`render.reduxToDom.interval` 为调度包含式聚合渲染/提交间隔、**非 Markdown parse CPU**（LOCK-STREAM-RENDER-006）；smooth-stream 配对非 1:1，用文档化 next-DOM/单调配对规则 + 正确性 gate；稳态区间排除 completion-tail（final-flush 边界）；纯派生逻辑（pairing/cutoff/metrics/profile/env-gate）在 `perfStreamRenderAttr.ts` + Node `e2e-utils` lane 单测锁定；标准 fixture + mock provider |
| 观察者负载控制 E2E（PERF-STREAM-ATTR-003）— `tests/e2e/specs/conversation/perf-stream-render-observer-control.spec.ts` + `tests/e2e/utils/perfStreamObserverControl.ts` | fresh `pnpm build` + `PERF_STREAM_OBSERVER_MODE=scan\|noscan PERF_STREAM_RENDER_SCALE=n1\|n2\|n3 pnpm test:e2e`（focused spec，6 runs） | Electron | 生产构建下 ATTR-002 DOM 观察者自身负载量化：scan（单次 DOM 遍历同时记录 DOM 系列并累计 textContent 字节数）vs noscan（仅 MutationObserver dirty 信号 + 同 rAF 调度/观察者生命周期）对照；共同因果指标（Redux first-content/commit interval/content axes、longtask phases/total、frame deltas、input latency）+ scan-only 机制指标（scan invocations/time/bytes） | 测量-only 默认 `test.skip`（LOCK-OBSERVER-003 默认关闭，plain `pnpm test:e2e` 保持 green）；仅 L1 正确性/parity/completeness 断言，计时为 L3 非阈值（LOCK-OBSERVER-005）；noscan 模式排除 DOM-first-content/reduxToDom/pairing 因果比较（LOCK-OBSERVER-004）；visible-fold-stream DOM final-state 两种 treatment 均验证；artifact id 编码 profile+treatment（`chatdb-stream-render-observer-e2e-{scan\|noscan}-n1/n2/n3`）；schema v1 不变；`perfStreamObserverControl.ts` + Node `e2e-utils` lane 单测锁定；标准 fixture + mock provider；**不修改已提交的 ATTR-002 spec/helper**（LOCK-OBSERVER-006） |
| 逻辑保留负载校准基准（Phase 4 C-01）— `src/main/services/chatDb/__tests__/logicalPayload.bench.ts` | `pnpm bench:logical-payload` | Node | B-02 规范编码（`phase4-logical-payload-v1` canonical JSON UTF-8 字节）的确定合成 profile 校准：count-first / byte-first 绑定、B-05 单话题超限分类、canonicalization 吞吐；全部 gate 与已注册任务成功后输出 schema v1 artifact（id `logical-retained-payload-calibration`） | 测量-only 合成校准证据，**方向性、非采纳**：不是阈值/基线/容量策略/缓存上界/逐出策略，不关闭 Phase 4/5，不授权 Phase 6；正确性 gate 失败即无 artifact |
| 渲染进程堆校准 E2E（Phase 4 C-02）— `tests/e2e/specs/conversation/perf-c02-heap-calibration.spec.ts` + `tests/e2e/utils/perfHeapCalibration.ts` | fresh `pnpm build` + `C02_HEAP_CALIBRATION=1 pnpm test:e2e -- tests/e2e/specs/conversation/perf-c02-heap-calibration.spec.ts`（opt-in，fixture 自动加 `--enable-precise-memory-info --js-flags=--expose-gc`） | Electron | 生产构建下真实 renderer 进程堆采样（`performance.memory`）：确定合成投影激活前后的堆 delta、heap/logical 放大比、规范逻辑字节数与 production DOM 归属证明（final-topic-owned `#messages` proof）；全部 L1 gate 通过且 authoritative complete 后输出 schema v1 artifact（id `chatdb-c02-renderer-heap-e2e`） | 测量-only 默认 `test.skip`（plain `pnpm test:e2e` 保持 green）；**方向性合成证据，非采纳**：非阈值/基线/堆容量策略/逐出策略，不关闭 Phase 4/5，不授权 Phase 6；bucketed/非精确堆或 fallback/global DOM 即 fail-closed 无 artifact；helper 纯逻辑单测在 Node `e2e-utils` lane 锁定 |
| 固定工作集校准基准（pinned working-set calibration harness）— `src/main/services/chatDb/__tests__/pinnedWorkingSet.bench.ts` + `pinnedWorkingSet.ts`（helper）+ `pinnedWorkingSet.test.ts` | `pnpm bench:pinned-working-set` | Node | 合成 pinned / evictable / combined / unlimited-context 四分区矩阵（全部为 `synthetic calibration inputs`，非策略/阈值）基于 `phase4-logical-payload-v1` canonical JSON UTF-8 逻辑字节计量；partition-sum（pinned+evictable=combined 精确求和）与 unlimited-enlargement（unlimited/pinned 放大比）gates、canonical/orphan/non-finite correctness gates；Node lane 堆放大不可测覆盖限制（仅逻辑字节与放大比，不以 Node heap 代理 renderer，C-02 单 profile/GC-sensitive 保持独立） | 测量-only 合成校准证据，**方向性、非采纳**：不关闭 Phase 4/5，不满足完整 §5.10，不授权 Phase 6/S6.1/S6.2/S6.3；非阈值/基线/容量/逐出/窗口/闭包/通道/SQL/游标/N-K 值，未采纳任何数值；helper 纯逻辑单测在 Node lane 锁定；全部 gate 与已注册任务成功后输出 schema v1 artifact（id `pinned-working-set-calibration`，`test-results/bench-results` 既有保留路径） |
| UI 观察诊断 — `scripts/ui-observe` | `pnpm ui:observe` | Electron | 渲染/交互诊断观察 | 诊断性证据（L2），**非回归证明**；程序化使用走 `ui-verify-change` |

> **M1 provenance note (2026-08-24, diagnostic L3 only)**: M1 `chatdb-sort-order-shift` via `pnpm bench:sort-order-shift` (commit `701eb4f17be9d2d68c1c62f875a06da5bc3acdc6` dirty=true, Node v24.11.1, pnpm 10.27.0, Node ABI 137, schema v1, isolated temp DB, 9 combos N=100/500/1000×M=1/10/50 floor(N/2) 3+20, gates 9/9 each — 9/9 parity, 9/9 shifted-count, 9/9 sample-completeness —, `test-results/bench-results/chatdb-sort-order-shift-20260824-104446.700.json` gitignored, **corrected timing excludes input construction from the timed interval**); p50 directional M=1 N100 6.073 ms / N500 29.093 ms / N1000 68.589 ms (M10 N100 2.552 ms / N500 3.040 ms / N1000 4.993 ms; M50 N100 10.852 ms / N500 11.490 ms / N1000 14.020 ms, `insertAt` vs `insertManyAt` paths not comparable), single-machine synthetic temp DB, directional L3 only, dirty worktree, no threshold/adoption/S6.4/S6.5 authorization — detail in `performance-workstreams.md` §2.4 (measurement-only, default-gated, privacy-safe).

### 6.1 阶段归因测量契约（PERF-PHASE-001 · PERF_PHASE_ATTR）

PERF-101/PERF-103 的 Phase 2A 阶段归因子切片是**默认关闭**的测量契约。本节只记录其**持久**契约（LOCK-002/DOC-002）：运行历史、数值、校验和与日期明细一律不进本文件。

1. **默认关闭（default-off）**：构建期 define `__PERF_PHASE_ATTR__` 由环境变量 `PERF_PHASE_ATTR` 解析（`resolvePhaseAttrGate` fail-closed：未设置/为空 → 关闭；非 `1`/`true`/空 的值直接报错，绝不静默启用）。关闭时 renderer/Main 适配器编译为 inert，plain `pnpm build` 与 plain `pnpm test:e2e` 保持 green 且**不发射任何 phase 指标**。启用只能通过文档化测量构建/运行：先 `PERF_PHASE_ATTR=1 pnpm build`，再 `PERF_PHASE_ATTR=1 pnpm test:e2e -- <标准 focused spec>`——**env gate 需同时作用于构建与 focused E2E 进程**（构建 define 与 spec 运行期解析均要求 `1`/`true`）。Phase 2A 发射 spec 为 PERF-103 standard `perf103-echo-latency-measurement.spec.ts` 与 PERF-101 cache-hit repeat-switch `perf101-cache-hit-repeat-switch.spec.ts`；**`perf103-high-turn-echo-measurement.spec.ts` 不发射 Phase 2A 阶段分解**，仅保持正确性/基线 endpoint 证据。
2. **指标身份恒等（metric identity）**：未启用时 PERF-103 = 37 metrics / 10 gates、PERF-101 = 20 baseline metrics；启用时 PERF-103 = 64 metrics / 10 gates（+27 phase IDs）、PERF-101 = 64 metrics（+22 cache-miss +22 cache-hit）。基线 metric/gate IDs 作为子集**原样保留**；cache-miss 与 cache-hit 使用**分离指标系列**，不混合路径（LOCK-2A-010）。
3. **闭合阶段联合（closed `PhaseStage` union）**：`PhaseStage` 由 `ECHO_REQUIRED_PHASE_STAGES` / `TOPIC_REQUIRED_PHASE_STAGES` / `echo.mainAppend` 字面量数组派生；联合外 stage 在写时（`appendPhaseRecord`）与校验时（`validatePhaseRecords`）双重拒绝。
4. **有界环形缓冲（bounded ring buffer）**：`PHASE_ATTR_MAX_RECORDS = 512`；溢出置 `overflowed` 标记并使校验失败（fail-closed）。
5. **opaque correlation ID + 冻结端点快照**：样本 correlation ID 由 spec 生成（`<specPrefix>-sample-<n>`，不透明、不携带内容/凭据）；DOM 端点时刻经 `__perfPhaseAttrSnapshot` **深拷贝**为冻结快照，后续 live 变更不进入样本；快照是 spec 级 phase 指标派生的**唯一来源**，无 live fallback。
6. **启用态 fail-closed 完整性**：required stages 必须全在；非 multiplicity stage 严格单次出现（LOCK-2A-009：render/context/window/group span 有界多次，其余单次）；causal order 仅校验代码可证的显式因果对（React render/layout 全局顺序不可强制，默认不校验）；精确样本计数 gate（LOCK-2A-011）。任一失败即 spec 失败，不产出部分 artifact。
7. **诚实 span/endpoint 边界（LOCK-2A-008）**：`phase.span.*` 为**直接捕获的每阶段时长之和（sum+count）**，不是端到端区间；span 总时长可与 DOM endpoint 重叠或超出；DOM endpoint 为 renderer 时钟自 correlation 起点捕获；`echo.mainAppend` 为 main 时钟独立记录并经 mainState 校验，跨钟不混算。
8. **schema / 隐私 / lane**：启用运行输出 schema v1 artifact（§4 既有存储/保留约定）；仅数字与固定字符串、opaque ID、确定性合成规模——无消息内容/凭据/路径/原始 DB 体积（PERF-LOCK-006）；生产构建 Electron lane（ABI 145）；共享契约与纯派生逻辑（validation/pairing/metric derivation/env-gate）单测在 Node `e2e-utils` lane 常开锁定。
9. **边界（不改变生产语义）**：测量-only，不改变生产行为；Main SQLite authority、IPC 顺序、50ms cadence、context-window/anchor 治理、兼容语义、schema v1 与既有 PERF-LOCK 语义全部保持不变（PERF-LOCK-002/006/008）。阶段 span 只覆盖被捕获阶段，不覆盖未仪器化的 Main/IPC/SQLite 或 React 路径。

## 7. 阈值策略与唯一已提交阈值（Threshold Policy）

- **唯一已提交断言阈值**：冷库打开延迟 `<500ms`（`sqlite-runtime.perf.bench.ts` 冷开 gate，LOCK-5.4.3）。它是唯一可作为 gate 的数值阈值。
- **其余一切数值为暂定（calibration candidates）**：在按 §1 重测并记录 artifact 前**一律视为未验证**，不得作为事实引用（PERF-LOCK-003）。暂定数值不会因测量完成而自动升级为阈值。
- **无历史对比值时显式报告**：不虚构对照基线；不得把跨运行/跨 artifact 数值差异当作回归证据（除非在同一 committed-state、同一工具链/环境下的受控对比）。
- **基线/参考采纳前置条件（committed-state）**：采纳为参考基线（或校准候选）只允许来自**已提交状态（clean committed-state）**的运行；dirty worktree 运行必须显式标注为**非基线候选**。git 提交/脏状态元数据照实记录（schema v1 `environment.git` 的 `commit` 完整 HEAD SHA + `dirty` 标记）；未提交工作树内容不计入基线。
- **校准决策**：把暂定数值采纳为参考基线或创建新阈值，须经 Main/用户显式校准决策；决策不改变 L3/非阈值分类。

**决策规则（PERF-LOCK，语义持久）**：

| 规则 | 内容 |
|---|---|
| PERF-LOCK-001 | 本套性能文档非 ADR，不新增治理权威 |
| PERF-LOCK-002 | 既有身份/SQLite/迁移/兼容/隐私/生产构建 E2E 治理全部保持不变 |
| PERF-LOCK-003 | 证据 L1–L4 不可互换；L3 数值不自动升级为阈值/基线 |
| PERF-LOCK-004 | 优先级 = 用户影响 ×（时长、频率、规模曲线、阻塞线程/进程） |
| PERF-LOCK-005 | 集成 UI 契约必须用生产构建 Playwright E2E 验证 |
| PERF-LOCK-006 | 诊断有界：不记录消息内容、凭据、附件内容、原始 DB 大小、路径 |
| PERF-LOCK-007 | 大规模/profile 级基准按需或定时，不进入每次提交 CI |
| PERF-LOCK-008 | 不改变架构/持久化/生命周期/遥测隐私/兼容语义；涉及即走 ADR 决策点 |
