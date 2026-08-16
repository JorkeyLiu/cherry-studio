# 性能工作流状态（Performance Workstreams — 当前可行动状态）

> **定位**：本文件只承载**当前可行动状态**——开放产品问题、证据、有界成本模型/假设、明确未知项、下一实验/分析目标、验收框架。非 ADR，不新增治理权威（PERF-LOCK-001）。
> **可变**：本文件随工作推进更新；会话流水、校验和、日期明细与重复运行叙述由 Git 历史承担（DOC-002）。
> **权威来源**：方法论入口见 [`performance-program.md`](./performance-program.md)；持久测量契约见 [`performance-measurement.md`](./performance-measurement.md)。
> **测量完成 ≠ 产品问题关闭**（DOC-004）：下文「测量切片状态」为 `Done` 不代表其对应的产品问题已解决；产品问题保持 `Open` 直至 §4 关闭条件满足。

## 1. 优先级原则（Priority Rubric）

优先级按放大优先方法论（`performance-program.md` §4）评估：**优先级 = 用户影响 ×（时长、频率、规模曲线、阻塞线程/进程）**（PERF-LOCK-004）。以下开放工作流按用户可见性排序；每个工作流的推进须经 Main/用户显式授权（`Active` 同一层级唯一，关闭不自动激活；状态与授权规则见 `performance-program.md` §6/§8）。

## 2. 产品问题与登记工作流（Product-Problem & Registry Workstreams）

产品问题状态与测量切片状态**分离**：问题保持 `Open` 直至关闭条件满足，其历史测量资产（legacy PERF-101/102/103）仅作为**证据身份**保留，不是关闭。§2.1–2.3 为当前 `Open` 的用户可见产品问题；§2.4 是 `Planned` 方向草案登记（非 active Open 工作流），状态语义见 `performance-program.md` §6。

### 2.1 PERF-TOPIC-SWITCH — 话题切换（Open）

- **产品问题状态**：`Open`。用户报告点击切换话题到首次可用渲染存在延迟（L4 报告，未复现为当前基线）。
- **历史测量资产**：legacy `PERF-101`（缓存未命中话题切换测量：对角线 + 正交六点部分网格）——**证据身份**，非关闭。既有 S0 六点证据显示：固定生产默认窗口 W=10 时话题规模 N20→N100 非单调（未见持续话题规模放大）；固定 N=100 时窗口 W10→W50→W100 强增长——**L3 方向性证据，非阈值、非根因归属**。L4 秒级报告未在 S0 复现（大话题/复杂内容案例未覆盖）。
- **有界成本模型/假设（不声称根因）**：代码证据指向两个候选成本载体——
  1. **话题切换冷挂载**：缓存未命中切换路径穿越全话题 Main 加载 + IPC（`loadTopicMessagesThunk` → `dbService.fetchMessages` 全量 `listByTopic` + `listByMessages`）与 renderer 侧重复全话题计算（`createLatestMessageWindow`/`reconcileMessageWindow`、`computeContextInfo`）。
  2. **Markdown 可见窗口缩放**：已测数据中固定 N 下可见窗口 W 的强增长（164→529→858 ms）指向可见窗口渲染 fanout/重挂载成本，但**未做根因归属**。
- **明确未知项**：大话题规模（300+，LOCK-007 按需）与受控内容复杂度下的行为；内容复杂度轴；用户频率数据；O(N) 全话题工作与 O(W) 窗口渲染 fanout 的分离归属（残余分离需更多受控规模点）。
- **下一实验/分析目标**（候选，未授权）：N300/W10 与受控内容复杂度规模的按需测量，或 renderer 窗口侧缩放的结构归因。**未授权不执行**。
- **验收框架**：关闭要求点击→首次可用渲染的已接受用户可见结果 + 需要时集成实现 + 匹配边界回归证据。**不把 L3 数值当阈值**。
- **已批准校准候选（approved · provisional/unverified · non-threshold）**：300 轮话题切换/加载 `<1–2s` 为已批准但**未验证**的暂定参考值——**非通过/失败 gate、非当前基线**；重测并记录 artifact 前不得当作事实（PERF-LOCK-003，`performance-measurement.md` §7）。

### 2.2 PERF-STREAMING — 流式 / 多模型输出（Open）

- **产品问题状态**：`Open`。用户报告并行多条窄流输出时可视流畅度不佳（L4 报告，未复现为当前基线）。
- **历史测量资产**：legacy `PERF-102`（并发多模型流放大测量：首切片 + 归因诊断切片 + assistant-stub 子阶段切片）——**证据身份**，非关闭。已测 N=1→2→3 下可见流 first-content 与 renderer 长任务/帧尾端呈**方向性放大**（L3 方向性观察），但**归属未知**；归因切片把到达段定位到顺序式 assistant-stub 持久化/请求准备/本地传输，**不能把成本归属到 IPC/SQLite**；进一步拆分需跨测量-only 边界的 Main/IPC/SQLite 仪器化（未授权）。
- **有界成本模型/假设（不声称根因）**：代码证据指向两个候选成本载体——
  1. **流式双 150ms**：`MARKDOWN_PARSE_CADENCE_MS = 150` 的块提交/Markdown 解析 cadence 与 `useSmoothStream.ts` 逐字符呈现并存，构成双节流节奏候选（放大背景，非根因）。
  2. **全内容处理**：流式期间对已接收全文内容的重处理（渲染长任务、全量计算）在 N 并发时放大——L3 方向性观察，非根因。
- **明确未知项**：N 并发放大的确切归属（fanout 成本 vs 渲染竞争 vs 调度延迟 vs 测量负载）；双 150ms 是否构成实际冗余；多模型流与单流的差异边界；用户频率数据。
- **下一实验/分析目标**（候选，未授权）：并发 fanout 成本与渲染竞争的分离归因；或双 150ms 节流结构的静态/运行时检查。**未授权不执行**（进一步仪器化须新显式范围决策）。
- **验收框架**：关闭要求并行窄流可视流畅度的已接受用户可见结果 + 需要时集成实现 + 匹配边界回归证据。
- **已批准校准候选（approved · provisional/unverified · non-threshold）**：流式持久化拖累 `<10%`、渲染长任务无持续性 `>50ms` 为已批准但**未验证**的暂定参考值——**非通过/失败 gate、非当前基线**；重测并记录 artifact 前不得当作事实（PERF-LOCK-003，`performance-measurement.md` §7）。
- **测量切片状态（PERF-STREAM-ATTR-001 · 已完成 · 不关闭本产品问题）**：measurement-only 切片（默认开关 inert，LOCK-STREAM-ATTR-001）已落地并完成受控测量，产出 artifact 家族 `chatdb-stream-persist-*`（LOCK-STREAM-ATTR-004）。按 LOCK-STREAM-ATTR-006 双面互补——
  1. **生产构建 E2E**：真实 renderer/IPC/Main 流式写路径（`chatdb:update-single-block` 稳态 + `chatdb:update-blocks` 完成 flush），以 opaque correlation id 配对 renderer 侧 schedule/serialize/IPC/total 与 Main 侧 handler/aggregate/convert/tx，并分类 changed-vs-unchanged 计数；正确性/parity/completeness 为 L1 gate，计时为 **L3 方向性非阈值**。
  2. **Node 确定性差分**：临时 DB 上 trigger-on vs base-only 的 SQLite 投影差分（growth/nochange/completion 三 profile），量化为**方向性差分估计**，非直接 trigger 内部剖析、非根因。
  **诚实边界/重叠说明**：`renderer.ipc − main.handler` 为 IPC 开销**估计**（renderer 往返含 IPC 传输 + Main 队列 + Main handler，减去 Main 自身 handler 后仅剩传输/调度部分）；trigger 投影成本仅在 Node 差分量测、不在 E2E 直接量测（真实计时无法分离 trigger 体与 UPDATE）；unchanged 写仍触发内容 trigger（unchanged 块仍计入 trigger 成本）。**不把任何 L3 数值当阈值/基线，本切片不关闭 §2.2 的 `Open` 产品问题，不改变任何生产行为/模式/迁移/索引/cadence/阈值**（LOCK-STREAM-ATTR-001/002/005）。归属仍为方向性；明确未知项（见上）不变。

### 2.3 PERF-ECHO — 消息回显（Open）

- **产品问题状态**：`Open`。回显延迟为用户可见交互路径（测量基线已建立，但问题未关闭）。
- **历史测量资产**：legacy `PERF-103`（回显延迟测量基线 + interval-scoped 归因扩展 + 本地 viewport 收敛实验）——**证据身份**，非关闭。已测回显三段分割（reduxCommit / firstRender / reduxToDom）中 **reduxToDom 占 firstRender 的 58–64%** 并主导已测分割（方向性观察）；over `[reduxCommitAt, domCommitAt]` 区间 20/20 样本具**恰一个 interval-overlapping 长任务**（单阻塞长任务覆盖该区间，方向性观察）。`<50ms/<100ms` 参考值保持**未验证参考**，不按通过/失败阈值对待。本地 viewport 收敛实验因可测量收益未获证明而被拒绝并完整回退、无生产提交。
- **有界成本模型/假设（不声称根因）**：代码证据指向**可见消息 viewport 渲染链**——回显从 Redux 提交到首个 `.message-user` DOM commit 之间存在单一阻塞长任务（方向性观察）；静态证据显示 fresh 首次消息 viewport 需空 pass + passive-effect 窗口应用 + 消息 pass（冗余 commit/work 候选，未证明收益）。
- **明确未知项**：单阻塞长任务内的具体阶段归属（无 whole-echo/React-pass 归属）；viewport 生命周期修复能否消除实际冗余 commit/work；跨运行基线差异非回归证据，需受控复测。
- **下一实验/分析目标**（候选，未授权）：对 Redux→DOM 区间内单阻塞长任务的阶段级归属，或一个新的受控 viewport 收敛实验（须证明消除实际冗余 commit/work，不接受仅推进端点的 display-only fallback）。
- **验收框架**：关闭要求回显延迟的已接受用户可见结果 + 需要时集成实现 + 匹配边界回归证据；候选修复必须证明消除实际冗余工作。

### 2.4 PERF-DB-HEALTH — SQLite 数据健康与优化（Planned）

- **工作流状态**：`Planned`（`performance-program.md` §6：范围未批准的方向草案）。本文档更新仅**记录方向草案与风险/测量切片，不激活任何实验、测量或实现**；`Active` 同一层级唯一，激活须 Main/用户显式授权（`performance-program.md` §6/§8）。
- **产品问题状态**：与 2.1–2.3 的单一用户可见 L4 症状不同，本工作流登记的是**持久的数据/数据库健康风险与测量切片**（非单一用户症状）。任何改动——尤其涉及 schema、迁移、索引或搜索语义者——均落入 `sqlite-migration.md` 与 `performance-program.md` §9（PERF-LOCK-008）治理面，须显式范围授权，本工作流不提前锁定任何方案。
- **持久事实（recorded · non-threshold · 非根因归属）**：
  1. **FTS 块更新写放大 + 存储重复（写路径已修复，存储成本仍存）**：migration 003 的 FTS 同步触发器以 `UNINDEXED block_id` **整表扫描**方式删除旧 FTS 文档（`migration.ts` 的 `MIGRATION_003_CREATE_MESSAGE_BLOCKS_*_TRIGGER_SQL`）；migration 004 引入稳定 rowid 身份（`message_blocks_normalized.rowid INTEGER PRIMARY KEY AUTOINCREMENT` 复用为 FTS rowid）改 **rowid 定点删除**（`CREATE_MESSAGE_BLOCKS_*_TRIGGER_SQL`，LOCK-FTS-2/6）。**记录的（L3/代码注释证据，非阈值）**：整表扫描在 2.15GB/120k 行时每块更新约 1.6–2.4s、churn 后 >4s、约占更新成本 95–99%（migration 004 注释）。该**写放大已由 004 结构性修复**；仍存的持久成本是**归一化内容在 `message_blocks_normalized` 与 `message_blocks_fts` 两处重复存储**（派生投影成本，非权威）。
  2. **短 <3 码点查询走 LIKE 全表扫描**：`SearchRepository.ts` `collectCandidates`/`likeCandidates`——term <3 Unicode 码点不满足 FTS5 trigram 表示，改对 `message_blocks_normalized` 执行 `%term%` 前导通配 `LIKE`（`message_blocks_normalized WHERE normalized_content LIKE ? ESCAPE '\\'`），无法利用索引，为**全表扫描**。诊断切片 `searchStage.bench.ts`（50k 语料、`bench:search-stage` 按需）记录该路径成本。
  3. **索引/查询机会（假设，非已证收益）**：现有一级索引包括 `message_blocks_normalized_message_id_idx` 与 migration 001/002 的 `(topic_id, sort_order)` / `(message_id, sort_order)` 复合索引；哪些查询缺少可利用索引为**待测假设**。`searchStagePlan.bench.ts`（`bench:search-stage-plan` 按需）为 query-plan 结构诊断，供归因使用。
  4. **稠密 sort_order 的 O(N) 平移操作**：`MessagesRepository.ts` 稠密零基序——**尾部追加走 LOCK-002 快速路径（零 sibling UPDATE，O(1)）**；但**中部插入/批量插入**仍以单条 `sort_order = sort_order + 1`（`insertAt`）或 `sort_order += M`（`insertManyAt`）**平移所有兄弟行（O(N) sibling UPDATE）**；稀疏/损坏话题回退到单趟稠密修复 `normalizeOrdersInTx`（O(N)）。放大随**话题规模**轴增长；实际频率未知。
  5. **文件双状态（file dual-state）**：`file_references` 表（`FileReferencesRepository.ts`）为 Main/SQLite 侧文件引用；降级导入附件**无 payload、无 catalog 行**，仅靠块 overflow 标记 `l2AttachmentUnavailable`（`attachmentAvailability.ts`，LOCK-UI-1..6）。文件元数据/引用状态在 **Main(SQLite)** 与 **renderer（Dexie/文件系统）** 间双轨承载——一致性/状态收敛为**待测风险，非已证缺陷**。
  6. **缺失同步元数据（absent sync metadata）**：当前 schema（migration 001/002）**无变更集/版本/游标类同步元数据列**；`sync-mvp.md`（SYNC-003）明确将同步能力排除在派生物/兼容域之外。为同步引入所需元数据将改变 schema/持久化语义——**ADR 级决策（PERF-LOCK-008）**，本工作流不提前锁定方案。
- **有界成本模型/假设（不声称根因）**：放大轴集中在 **DB 体积 / 话题规模 / FTS 语料**（`performance-measurement.md` §5 规模维度），落点多为 **Main 进程 SQLite 写路径与查询路径**；上述 1–6 为**已记录/待测成本载体**，未经受控微基准与 query-plan 归因前不做根因归属。
- **明确未知项**：真实 profile（S2/S3）规模下各载体的实际成本；中部插入 O(N) 平移的实际用户频率；FTS 存储重复的具体体积占比；短 term LIKE 扫描在真实语料下的实际影响；文件双状态是否发生一致性漂移；同步元数据方案（不在此锁定）。
- **下一测量目标（M1–M8 蒸馏 · 诊断性 · 未授权）**：以下切片为**规划产物**，全部 `未授权`、**不执行**（`performance-program.md` §6 `Planned`/§8 授权规则），激活前须逐项显式授权——
  - M1 中部/批量插入 O(N) sort_order 平移的受控规模曲线；
  - M2 短 <3 码点 LIKE 全表扫描在 S1/S2 语料下的归因（衔接 `searchStage.bench.ts`）；
  - M3 索引/查询机会的 query-plan 结构诊断（衔接 `searchStagePlan.bench.ts`）；
  - M4 FTS 存储重复的体积与写放大残量测量（只读、非授权重建）；
  - M5 文件双状态一致性/状态收敛的诊断切片；
  - M6 同步元数据缺口的 schema 影响分析（**仅分析，不建 schema、不迁移**）；
  - M7 冷开/加载路径受 DB 体积影响的归因（衔接 `sqlite-runtime.perf.bench.ts`）；
  - M8 备份/恢复（L3 archive metadata）健康切片。
  **以上 M1–M8 均为诊断/规划 artifact，非授权测量、非阈值来源。**
- **建议推进顺序（推荐上下文 · 非授权 · 不构成优先级决策）**：① 归因测量（M1/M2/M3/M7）→ ② 低风险 DB 优化 → ③ 串行 renderer 工作流 → ④ 语义性 DB 决策 → ⑤ 同步使能。此顺序仅为**推荐上下文**，不批准任何实现/测量优先级。
- **验收框架**：关闭须满足已接受的用户可见/数据健康结果 + 需要时集成实现 + 匹配边界回归证据（`performance-program.md` §8）；任何 schema/迁移/搜索语义改动走 ADR 决策点（PERF-LOCK-008）。**不把 L3 数值当阈值**（PERF-LOCK-003）。

## 3. 已完成的生产优化成果摘要（Completed Production Outcomes）

以下为实际合并的生产优化组（非详细运行历史；完整交付记录由 Git 历史承担）。对应 legacy 测量资产仅作证据身份引用。

| 优化组 | 成果摘要 | 生产实现 | 回归证据 |
|---|---|---|---|
| 编辑模式进入/退出 | 编辑模式不再重挂载可见消息子树（renderer-only 稳定宿主 + 显式 `resetToken`） | 已集成 | renderer 测试 + fresh 生产构建 E2E（编辑 gate） |
| 多消息中部插入（粘贴） | 逐条串行 IPC 改为批量插入（单次 `insertManyAt` 稠密 zero normalization + 单 renderer 提交） | 已集成 | fresh 生产构建 E2E（粘贴 gate） |
| 多模型答案标签切换 | 两次 DB-first foldSelected 写入收敛为单原子 `select-answer-message` 契约（单事务 + 单 plural Redux 提交） | 已集成 | 新增契约/聚合/IPC/Redux 测试 + fresh 生产构建 E2E |

> 生产基线资产：`PERF-002` 已建立**首批 committed-state machine-readable 参考基线**（schema v1 artifacts，gitignored 本地 deliverable）——数值为 **L3 非阈值参考基线**，唯一已提交阈值仍为冷开 `<500ms`（`performance-measurement.md` §7）。`PERF-001` 已落地 schema v1 结果契约；`PERF-004` 首切片已落地 FTS 1k/10k 快速确定性参数化与只读 schema-v1 artifact 曲线/方差/knee 方向性消费者。以上均为测量/基础设施成果，不关闭本文件 §2 的任何 Open 产品问题。

## 4. 关闭条件与推进规则

1. **产品问题保持 Open** 直至：已接受的用户可见结果 + 需要时集成实现 + 匹配边界回归证据（`performance-program.md` §8）。
2. **测量完成不关闭产品问题**（DOC-004）：legacy PERF-101/102/103 测量资产为证据身份，其 `Done` 不关闭对应 Open 问题。
3. **不把 L3 数值当作阈值/根因**（PERF-LOCK-003）：本文件所有数值均为 L3 方向性/参考，非阈值、非根因归属。
4. **推进须显式授权**：任何新实验/分析/实现须经 Main/用户显式授权；未授权不执行；关闭不自动激活新工作流。
