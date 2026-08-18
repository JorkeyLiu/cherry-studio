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
- **历史测量资产**：legacy `PERF-101`（缓存未命中话题切换测量：对角线 + 正交六点部分网格）与缓存命中重复切换扩展 `perf101-cache-hit-repeat-switch.spec.ts`——**证据身份**，非关闭。既有 S0 六点证据显示：固定生产默认窗口 W=10 时话题规模 N20→N100 非单调（未见持续话题规模放大）；固定 N=100 时窗口 W10→W50→W100 强增长。2026-08-18 的 post-opt fresh production-build cache-hit repeat-switch E2E 通过：N20/W10 repeat-render p50 `166.7ms`，N20/W20 `297.8ms`，N100/W10 `171.1ms`；对应 pre-opt p50 为 `173.4ms`、`362.2ms`、`176.5ms`。**L1 为正确性/完整性通过，数值为 L3 方向性证据，非阈值、非根因归属**。首次 post-opt 运行出现的 spike 未复现，分类为 L3 noise，不作为回归结论。
- **有界成本模型/假设（不声称根因）**：代码证据指向两个候选成本载体——
  1. **话题切换冷挂载**：缓存未命中切换路径穿越全话题 Main 加载 + IPC（`loadTopicMessagesThunk` → `dbService.fetchMessages` 全量 `listByTopic` + `listByMessages`）与 renderer 侧重复全话题计算（`createLatestMessageWindow`/`reconcileMessageWindow`、`computeContextInfo`）。
  2. **Markdown 可见窗口缩放**：已测数据中固定 N 下可见窗口 W 的强增长（164→529→858 ms）指向可见窗口渲染 fanout/重挂载成本，但**未做根因归属**。
- **方向性根因解释（不升级为根因确认）**：cache-hit repeat-switch 的固定 N 对照中，W20 明显高于 W10，而 N20/W10 与 N100/W10 接近；post-opt 仍保持这一形状，方向性支持 **W-bound renderer remount/render work** 为主要可见成本轴，且在固定 W 下未见 N 的持续放大。`anchorService` 的 active-resolvable fast path 减少了切换时不必要的上下文构建；其对该 W-bound 形状的贡献仍未被单独隔离。
- **测量条件与命令（2026-08-18）**：fresh production build 后使用 `PERF101_CACHE_HIT=1 PERF101_SCALE=n20-w10 pnpm test:e2e -- tests/e2e/specs/conversation/perf101-cache-hit-repeat-switch.spec.ts`、`PERF101_CACHE_HIT=1 PERF101_SCALE=s0-20 pnpm test:e2e -- tests/e2e/specs/conversation/perf101-cache-hit-repeat-switch.spec.ts`、`PERF101_CACHE_HIT=1 PERF101_SCALE=n100-w10 pnpm test:e2e -- tests/e2e/specs/conversation/perf101-cache-hit-repeat-switch.spec.ts`；`n20-w10`、`s0-20`、`n100-w10` 与 cache-miss `PERF-101` profile aliases 共享。每个 profile 使用 3 个 samples；每个样本的确定性话题数据在测量点击前通过 typed ChatDb bridge 逐消息 `appendMessage` 完成，seed setup 不计入 click→render measured interval；L1 correctness/parity/privacy/ABI gates 全部通过，schema v1 本地 artifact 写入既有 `test-results/bench-results/` 约定位置。数值按 `p50/p95/mean` 契约记录；本段仅保留 p50 方向性摘要。
- **明确未知项**：大话题规模（300+）与受控内容复杂度下的行为；内容复杂度轴；用户频率数据；O(N) 全话题工作与 O(W) 窗口渲染 fanout 的独立归属；fast path 对用户可见结果的单独贡献；跨运行噪声界。
- **下一实验/分析目标**（候选，未授权）：N300/W10 与受控内容复杂度规模的按需测量，或 renderer 窗口侧缩放的结构归因。**未授权不执行**。
- **验收框架**：关闭要求点击→首次可用渲染的已接受用户可见结果 + 需要时集成实现 + 匹配边界回归证据。**不把 L3 数值当阈值**。
- **已批准校准候选（approved · provisional/unverified · non-threshold）**：300 轮话题切换/加载 `<1–2s` 为已批准但**未验证**的暂定参考值——**非通过/失败 gate、非当前基线**；重测并记录 artifact 前不得当作事实（PERF-LOCK-003，`performance-measurement.md` §7）。

### 2.2 PERF-STREAMING — 流式输出块状批次到达（Open）

- **产品问题状态**：`Open`。主要产品症状为**单流可视输出以块状批次到达**（非逐字符平滑呈现）；并发多流放大为次要/延迟关联，未与单流块状批次直接关联前保持 defer。
- **主要症状定义**：单流场景下，用户可见文本更新非逐字符连续到达，而是以明显批次/块状出现——更新间隔远大于单字符渲染预期，形成视觉停顿-跳跃感。并发放大未在本阶段归入主要症状（defer，见明确未知项）。
- **历史测量资产**：legacy `PERF-102`（并发多模型流放大测量：首切片 + 归因诊断切片 + assistant-stub 子阶段切片）——**证据身份**，非关闭。已测 N=1→2→3 下可见流 first-content 与 renderer 长任务/帧尾端呈**方向性放大**（L3 方向性观察），但**归属未知**；归因切片把到达段定位到顺序式 assistant-stub 持久化/请求准备/本地传输，**不能把成本归属到 IPC/SQLite**；进一步拆分需跨测量-only 边界的 Main/IPC/SQLite 仪器化（未授权）。

#### 2.2.1 当前证据与候选状态

> **诚实边界**：以下所有数值均为 **L3 方向性/非阈值、dirty-worktree 证据**。L1 为正确性/gate/exit code 层面。不把 L3 数值当形式化基线或通用阈值。候选成功不关闭产品问题；产品问题保持 `Open` 直至用户可见验收满足。

**测量实验状态**：PERF-STREAM-CADENCE-001 测量实验已完成；50ms 候选已集成供用户评估；候选未达 `Protected` 或 `Done`；产品问题 PERF-STREAMING 保持 `Open`。

**150ms 对比条件（历史 cadence）**

| 指标 | 值 |
|---|---|
| 可见更新 interval p50 | 152.4ms |
| 可见更新 interval mean | 150.41ms |
| chars/update p50 | 65 |
| chars/update mean | 63.47 |
| Redux interval p50 | 152.8ms |
| DOM/Redux ratio mean | 1.027 |
| Long tasks | 15 / 1153ms |
| Long task overlap | 0 |
| Frame p95 | 15.7ms |

**50ms 候选（当前候选 · 无架构改动）**

| 指标 | 值 |
|---|---|
| 可见更新 interval p50 | 54.3ms |
| 可见更新 interval mean | 50.77ms |
| chars/update p50 | 23 |
| chars/update mean | 21.79 |
| Redux interval p50 | 55.8ms |
| DOM/Redux ratio mean | 1.209 |
| Long tasks | 14 / 1158ms |
| Long task overlap | 0 |
| Frame p95 | 16.6ms |

- **候选解释**：50ms 候选将 Redux/persistence throttle 与 Markdown parse cadence 分离并统一为 50ms，visible interval p50 从 ~152ms 降至 ~54ms，字符粒度从 ~65 chars/update 降至 ~23 chars/update。Frame p95 与 long task 总量在两次运行间稳定（15.7ms vs 16.6ms / 1153ms vs 1158ms），未观察到帧级差异。DOM/Redux ratio 从 1.027 升至 1.209，方向性观察，需更宽设备/负载确认。**上述数值为单台 dirty-worktree L3 方向性证据**——不构成形式化基线，不证明无回归。

**Responsiveness E2E（正确性门控）**

- `tests/e2e/specs/conversation/streaming-responsiveness.spec.ts`：L1 正确性门控通过（scroll/input/exact completion）。此为 L1 正确性验证，非流式平滑度验收。当前 cadence 模型见上文候选说明。

**持久化归因（PERF-STREAM-ATTR-001 补充数据点）**

| 指标 | 值 |
|---|---|
| 写模式 | 304 single-block + 8 batch writes |
| Content states | 306 |
| Steady unchanged | 0 |
| Completion unchanged | 4 |
| Renderer IPC p50 | ≈1.4ms |
| Main tx p50 | ≈1.0ms |

- **持久化解释**：单流持久化路径以 single-block 写为主（304/312），batch write 仅在 completion flush 时触发。Renderer IPC p50 约 1.4ms，Main tx p50 约 1.0ms——持久化本身不构成单流块状批次的主导成本载体。此为方向性观察，非根因排除。

**已拒绝实验**：隐藏非选中处理回答的 Markdown 渲染延迟实验——集成被拒绝，实现已完整回退。§2.2 产品问题保持 `Open`。

- **有界成本模型/假设（不声称根因）**：代码证据指向两个候选成本载体——
  1. **流式 cadence 节流**：`MARKDOWN_PARSE_CADENCE_MS`（原 150ms）的块提交/Markdown 解析 cadence 与 `useSmoothStream.ts` 逐字符呈现并存。50ms 候选将 cadence 降至 50ms 后 visible interval 随之降低，**方向性支持 cadence 为主要节流因子**（非根因确认）。
  2. **全内容处理**：流式期间对已接收全文内容的重处理（渲染长任务、全量计算）——当前 L3 证据中 long task 总量与帧 p95 在对比条件/候选间稳定，**未观察到 cadence 变更对长任务的显著影响**（方向性，非排除）。
- **明确未知项**：
  1. **用户可见平滑度验收**：50ms cadence 下块状批次是否在用户可接受范围内——需 Main/用户实际感知确认，数值不替代体验判断。
  2. **更广设备/负载验证**：当前证据限于单台 dirty-worktree 运行；不同硬件/GPU/负载下的帧率与感知表现未知。
  3. **并发多流放大**：N>1 下 50ms cadence 的行为（是否出现 cadence 竞争或放大）——deferred，未与单流块状批次直接关联前不纳入主要症状。
  4. **chars/update 粒度的用户感知**：23 chars/update 是否产生新的可察觉批次感——需用户确认。
  5. **DOM/Redux ratio 升高的含义**：1.027→1.209 的方向性变化是否在更宽场景下一致，是否影响感知。
- **下一实验/分析目标**：
  1. **（优先）用户可见平滑度确认**：Main/用户在 50ms 候选下实际感知单流输出是否平滑可接受——此为关闭产品问题的必要前提。
  2. **（条件）更广设备验证**：在用户确认平滑度可接受后，于不同硬件/负载条件下复测以确认无设备级回归。
  3. **（deferred）并发多流 50ms 行为**：仅在并发放大与单流块状批次建立直接关联后推进。
- **验收框架**：关闭要求单流可视输出平滑度的已接受用户可见结果 + 需要时集成实现 + 匹配边界回归证据。**不把 L3 数值当阈值**。
- **已批准校准候选（approved · provisional/unverified · non-threshold）**：流式持久化拖累 `<10%`、渲染长任务无持续性 `>50ms` 为已批准但**未验证**的暂定参考值——**非通过/失败 gate、非当前基线**；重测并记录 artifact 前不得当作事实（PERF-LOCK-003，`performance-measurement.md` §7）。
- **测量切片状态（PERF-STREAM-ATTR-001 · 已完成 · 不关闭本产品问题）**：measurement-only 切片（默认开关 inert，LOCK-STREAM-ATTR-001）已落地并完成受控测量。按 LOCK-STREAM-ATTR-006 双面互补——
  1. **生产构建 E2E**：真实 renderer/IPC/Main 流式写路径（`chatdb:update-single-block` 稳态 + `chatdb:update-blocks` 完成 flush），以 opaque correlation id 配对 renderer 侧 schedule/serialize/IPC/total 与 Main 侧 handler/aggregate/convert/tx，并分类 changed-vs-unchanged 计数；正确性/parity/completeness 为 L1 gate，计时为 **L3 方向性非阈值**。
  2. **Node 确定性差分**：临时 DB 上 trigger-on vs base-only 的 SQLite 投影差分（growth/nochange/completion 三 profile），量化为**方向性差分估计**，非直接 trigger 内部剖析、非根因。
  **诚实边界/重叠说明**：`renderer.ipc − main.handler` 为 IPC 开销**估计**（renderer 往返含 IPC 传输 + Main 队列 + Main handler，减去 Main 自身 handler 后仅剩传输/调度部分）；trigger 投影成本仅在 Node 差分量测、不在 E2E 直接量测（真实计时无法分离 trigger 体与 UPDATE）；unchanged 写仍触发内容 trigger（unchanged 块仍计入 trigger 成本）。**不把任何 L3 数值当阈值/基线，本切片不关闭 §2.2 的 `Open` 产品问题，不改变任何生产行为/模式/迁移/索引/cadence/阈值**（LOCK-STREAM-ATTR-001/002/005）。归属仍为方向性；明确未知项（见上）不变。
  - **测量切片状态（PERF-STREAM-ATTR-002 · 已完成 · 不关闭本产品问题）**：measurement-only 渲染归因切片（默认 `test.skip`，LOCK-STREAM-RENDER-005 默认关闭，plain `pnpm test:e2e` 保持 green）已落地并完成受控测量。复用 legacy PERF-102 的 page-context observer 模式与产品路径（真实 mention-model 多流 + 确定性 slow-stream mock），不改动 PERF-102 的 artifact id/既有声明（LOCK-STREAM-RENDER-004），**无生产源码改动、无 cadence 改动、无 Markdown/render/viewport/Redux/持久化行为改动、无 React memoization/重构**（LOCK-STREAM-RENDER-001）。测量 N=1/2/3 稳态 renderer 放大（每助手 Redux 块内容提交、`.markdown` DOM 解析内容提交、调度包含式 Redux→next-DOM 提交间隔、累计内容体积轴、long task、帧间隔、输入延迟探针）；`render.reduxToDom.interval` 为**调度包含式聚合渲染/提交间隔、非 Markdown parse CPU**（LOCK-STREAM-RENDER-006）；smooth-stream 配对非 1:1，用文档化 next-DOM/单调配对规则 + 正确性 gate；稳态区间排除 completion-tail（final-flush 边界）；完成 batch-tail 归属与 DB/Main/IPC 优化不在范围（LOCK-STREAM-RENDER-002）。**诚实边界/重叠说明**：long task 时长与阶段间隔重叠、**从不求和**（LOCK-STREAM-RENDER-006）；内容体积放大比（accumulated/final）≈31× 为**每流独立**的近常数（N 同时缩放 accumulated 与 final），跨 N 数值为 dirty-worktree L3 方向性、非阈值/非基线（LOCK-STREAM-RENDER-003）；N=1→2→3 方向性观察（重测值，跨运行方差明显，L3 非基线）：per-assistant Redux first-content 均值 472→852→1040 ms、longtask 总量 2291→4084→4481 ms——单调放大方向与初测一致，绝对数值为脏工作树 L3 方向性、非根因归属。**不把任何 L3 数值当阈值/基线，本切片不关闭 §2.2 的 `Open` 产品问题，不改变任何生产行为**（LOCK-STREAM-RENDER-001/003）。归属仍为方向性；明确未知项（见上）不变。
  - **测量切片状态（PERF-STREAM-ATTR-003 · 已完成 · 不关闭本产品问题）**：measurement-only 观察者负载控制切片（默认 `test.skip`，LOCK-OBSERVER-003 默认关闭，plain `pnpm test:e2e` 保持 green）已落地并完成受控测量。使用与 ATTR-002 相同的生产构建 + 确定性 N=1/2/3 多模型 workload，对比 scan（单次 DOM 遍历同时记录 DOM 系列并累计 textContent 字节数）与 noscan（仅 MutationObserver dirty 信号 + 同 rAF 调度/观察者生命周期）两种 treatment，量化 ATTR-002 DOM 观察者自身负载。共同因果指标（Redux first-content/commit interval/content axes、longtask phases/total、frame deltas、input latency）；scan-only 机制指标（scan invocations/time/bytes）；noscan 排除 DOM-first-content/reduxToDom/pairing 因果比较（LOCK-OBSERVER-004）。**单次运行对比（dirty-worktree L3 方向性，不构成形式化噪声底）**：N1 scan vs noscan — Redux first-content p50 302.5ms vs 296.4ms、longtask steady total 1095ms vs 1316ms、frame delta p50 均为 13.9ms、input latency p50 8.0ms vs 8.6ms、frame count 1999 vs 2000；N2 — Redux first-content p50 453.3ms vs 422.6ms、longtask steady total 1469ms vs 1223ms、frame count 1977 vs 1995；N3 — Redux first-content p50 570.7ms vs 605.2ms、longtask steady total 1534ms vs 1722ms、frame count 1966 vs 1963。单次运行不足以确立一致的 treatment 效应或形式化噪声界；跨 N 数值无稳定方向性偏差。scan 机制开销（修正后含单次遍历 byte 累计）：N1 扫描 203 次/总 7.3ms/382k 字节、N2 扫描 281 次/总 20.2ms/1.18M 字节、N3 扫描 384 次/总 31.6ms/2.49M 字节——随 N 增长但绝对量小。**诚实边界**：dirty-worktree L3 非阈值/非基线（LOCK-OBSERVER-005）；每个 treatment×profile 仅一次 artifact 运行，跨运行方差与形式化噪声界未知；scan 机制开销随 N 增长但绝对值小。**不把任何 L3 数值当阈值/基线，本切片不关闭 §2.2 的 `Open` 产品问题，不改变任何生产行为**（LOCK-OBSERVER-001/005）。归属仍为方向性；明确未知项（见上）不变。

### 2.3 PERF-ECHO — 消息回显（Open）

- **产品问题状态**：`Open`。回显延迟为用户可见交互路径（测量基线已建立，但问题未关闭）。
- **历史测量资产**：legacy `PERF-103`（回显延迟测量基线 + interval-scoped 归因扩展 + 本地 viewport 收敛实验）与 batch-seeded high-turn 扩展 `perf103-high-turn-echo-measurement.spec.ts`——**证据身份**，非关闭。`reduxToDom` 在既有测量中占 `firstRender` 的 58–64% 并主导已测分割（方向性观察）；over `[reduxCommitAt, domCommitAt]` 区间 20/20 样本具**恰一个 interval-overlapping 长任务**（单阻塞长任务覆盖该区间，方向性观察）。`<50ms/<100ms` 参考值保持**未验证参考**，不按通过/失败阈值对待。本地 viewport 收敛实验因可测量收益未获证明而被拒绝并完整回退、无生产提交。
- **已完成实现切片（不等于产品关闭）**：`anchorService` 增加 active-resolvable fast path，避免已可解析 anchor 再次构建 context turns；`useSmoothStream`/`Markdown` 在 completed block 路径绕过 smooth-stream reset/animation-frame 生命周期，直接提交 authoritative final content。实现保持 renderer 边界，不改变 Main SQLite authority、IPC 契约或持久化语义。
- **测量条件与命令（2026-08-18）**：fresh production build 后，empty profile 使用 `pnpm test:e2e -- tests/e2e/specs/conversation/perf103-echo-latency-measurement.spec.ts`；batch-seeded profiles 使用 `PERF103_HIGH_TURN=1 PERF103_HIGH_TURN_TURNS=20 pnpm test:e2e -- tests/e2e/specs/conversation/perf103-high-turn-echo-measurement.spec.ts` 与 `PERF103_HIGH_TURN=1 PERF103_HIGH_TURN_TURNS=100 pnpm test:e2e -- tests/e2e/specs/conversation/perf103-high-turn-echo-measurement.spec.ts`。PERF-ECHO 的 prior-turn history 是通过 typed ChatDb bridge batch-seeded；不是 sequential-send pressure。每次通过运行输出 schema v1 本地 artifact 到既有 `test-results/bench-results/` 约定位置。
- **方向性结果（p50/p95/mean，单位 ms；L1 gate 通过，数值 L3）**：pre-opt empty 为 `reduxCommit 44.5/56.4/42.8`、`firstRender 113.1/143.8/113.5`、`reduxToDom 68.5/92.1/70.7`；post-opt empty 为 `42.3/56.3/43.8`、`110.0/142.5/111.4`、`63.2/80.0/65.2`。pre-opt 20 prior turns 为 `88.4/118.6/91.2`、`249.1/316.9/245.6`、`160.7/198.3/154.3`；post-opt 20 为 `88.2/103.6/88.9`、`231.0/268.9/229.7`、`143.8/163.6/145.8`。post-opt 100 为 `93.6/117.3/93.7`、`268.8/322.5/270.1`、`164.6/208.3/165.5`，无 pre-opt 100 对照。方向性上，empty 保持近似稳定，20 prior turns 的 firstRender/reduxToDom 改善且 p95 收窄，100 prior turns 没有显示出超出当前 renderer work 形状的异常跳变；这些数字不构成阈值、基线或回归判定。
- **方向性根因解释（不升级为根因确认）**：echo full-topic pre/post 对照把主要可见工作仍定位在 renderer 的 full-topic message/viewport lifecycle；20 prior turns 的 post-opt 改善与 completed-block no-RAF 生命周期及 anchor fast path 的实现方向一致，但现有切片不能把收益分别归因到两个改动，也没有证明消除所有冗余 React work。`reduxCommit` 基本稳定，不能据此把成本归属到 Main/IPC/SQLite。
- **PERF103 harness 效率结果（不作为产品延迟证据）**：batch-seeded PERF103 将真实 UI sends 从 `212` 降至 `12`，单次运行从约 `222s` 降至 `41.6s`；这是测量 harness 效率改善，不是产品 latency 改善或回归证据。
- **回归覆盖（2026-08-18）**：post-opt `tests/e2e/specs/conversation/streaming-responsiveness.spec.ts` fresh production-build E2E 通过；focused renderer coverage 通过 `useSmoothStream.test.ts`、`Markdown.streaming.test.tsx`，anchor coverage 通过 `anchorService.test.ts`。这些是 L1 正确性/边界回归证据，不把 timing 数值升级为阈值，也不替代用户可见验收。
- **明确未知项**：单阻塞长任务内的具体阶段归属（无 whole-echo/React-pass 归属）；anchor fast path 与 completed-block no-RAF 的独立收益；300 prior turns / 300-turn evidence；更广设备与负载下的方向是否稳定；跨运行噪声界；用户是否接受当前回显结果；匹配边界的长期回归保护尚未记录。
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
| 回显/完成块 renderer 生命周期 | 已可解析 anchor 走 active-resolvable fast path；completed Markdown block 绕过 smooth-stream reset/RAF 生命周期并直接提交最终内容 | 已集成 | `anchorService.test.ts`、`useSmoothStream.test.ts`、`Markdown.streaming.test.tsx` + fresh 生产构建回显/streaming-responsiveness E2E |

> 生产基线资产：`PERF-002` 已建立**首批 committed-state machine-readable 参考基线**（schema v1 artifacts，gitignored 本地 deliverable）——数值为 **L3 非阈值参考基线**，唯一已提交阈值仍为冷开 `<500ms`（`performance-measurement.md` §7）。`PERF-001` 已落地 schema v1 结果契约；`PERF-004` 首切片已落地 FTS 1k/10k 快速确定性参数化与只读 schema-v1 artifact 曲线/方差/knee 方向性消费者。以上均为测量/基础设施成果，不关闭本文件 §2 的任何 Open 产品问题。

## 4. 关闭条件与推进规则

1. **产品问题保持 Open** 直至：已接受的用户可见结果 + 需要时集成实现 + 匹配边界回归证据（`performance-program.md` §8）。
2. **测量完成不关闭产品问题**（DOC-004）：legacy PERF-101/102/103 测量资产为证据身份，其 `Done` 不关闭对应 Open 问题。
3. **不把 L3 数值当作阈值/根因**（PERF-LOCK-003）：本文件所有数值均为 L3 方向性/参考，非阈值、非根因归属。
4. **推进须显式授权**：任何新实验/分析/实现须经 Main/用户显式授权；未授权不执行；关闭不自动激活新工作流。
