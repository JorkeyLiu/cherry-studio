# 性能工作流状态（Performance Workstreams — 当前可行动状态）

> **定位**：本文件只承载**当前可行动状态**——开放产品问题、证据、有界成本模型/假设、明确未知项、下一实验/分析目标、验收框架。非 ADR，不新增治理权威（PERF-LOCK-001）。
> **可变**：本文件随工作推进更新；会话流水、校验和、日期明细与重复运行叙述由 Git 历史承担（DOC-002）。
> **权威来源**：方法论入口见 [`performance-program.md`](./performance-program.md)；持久测量契约见 [`performance-measurement.md`](./performance-measurement.md)。
> **测量完成 ≠ 产品问题关闭**（DOC-004）：下文「测量切片状态」为 `Done` 不代表其对应的产品问题已解决；产品问题保持 `Open` 直至 §4 关闭条件满足。

## 1. 优先级原则（Priority Rubric）

优先级按放大优先方法论（`performance-program.md` §4）评估：**优先级 = 用户影响 ×（时长、频率、规模曲线、阻塞线程/进程）**（PERF-LOCK-004）。以下开放工作流按用户可见性排序；每个工作流的推进须经 Main/用户显式授权（Active 同一层级唯一，关闭不自动激活）。

## 2. 开放产品问题工作流（Open Product-Problem Workstreams）

产品问题状态与测量切片状态**分离**：问题保持 `Open` 直至关闭条件满足，其历史测量资产（legacy PERF-101/102/103）仅作为**证据身份**保留，不是关闭。

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

### 2.3 PERF-ECHO — 消息回显（Open）

- **产品问题状态**：`Open`。回显延迟为用户可见交互路径（测量基线已建立，但问题未关闭）。
- **历史测量资产**：legacy `PERF-103`（回显延迟测量基线 + interval-scoped 归因扩展 + 本地 viewport 收敛实验）——**证据身份**，非关闭。已测回显三段分割（reduxCommit / firstRender / reduxToDom）中 **reduxToDom 占 firstRender 的 58–64%** 并主导已测分割（方向性观察）；over `[reduxCommitAt, domCommitAt]` 区间 20/20 样本具**恰一个 interval-overlapping 长任务**（单阻塞长任务覆盖该区间，方向性观察）。`<50ms/<100ms` 参考值保持**未验证参考**，不按通过/失败阈值对待。本地 viewport 收敛实验因可测量收益未获证明而被拒绝并完整回退、无生产提交。
- **有界成本模型/假设（不声称根因）**：代码证据指向**可见消息 viewport 渲染链**——回显从 Redux 提交到首个 `.message-user` DOM commit 之间存在单一阻塞长任务（方向性观察）；静态证据显示 fresh 首次消息 viewport 需空 pass + passive-effect 窗口应用 + 消息 pass（冗余 commit/work 候选，未证明收益）。
- **明确未知项**：单阻塞长任务内的具体阶段归属（无 whole-echo/React-pass 归属）；viewport 生命周期修复能否消除实际冗余 commit/work；跨运行基线差异非回归证据，需受控复测。
- **下一实验/分析目标**（候选，未授权）：对 Redux→DOM 区间内单阻塞长任务的阶段级归属，或一个新的受控 viewport 收敛实验（须证明消除实际冗余 commit/work，不接受仅推进端点的 display-only fallback）。
- **验收框架**：关闭要求回显延迟的已接受用户可见结果 + 需要时集成实现 + 匹配边界回归证据；候选修复必须证明消除实际冗余工作。

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
