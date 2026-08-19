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
- **历史测量资产**：legacy `PERF-101`（缓存未命中话题切换测量：对角线 + 正交六点部分网格）与缓存命中重复切换扩展 `perf101-cache-hit-repeat-switch.spec.ts`——**证据身份**，非关闭。既有 S0 六点证据显示：固定生产默认窗口 W=10 时话题规模 N20→N100 非单调（未见持续话题规模放大）；固定 N=100 时窗口 W10→W50→W100 强增长。**L1 为正确性/完整性通过，数值为 L3 方向性证据，非阈值、非根因归属**。
- **已完成实现切片（Phase 2B · renderer 边界 · 不等于产品关闭）**：
  1. **共享上下文投影**：`Chat.tsx` 对 Messages/Inputbar 计算**单个共享 `computeContextInfo` 投影**（同一 memo 身份 `[topic messages, topic blocks, assistant, topic id]`），并只订阅 active-topic 消息引用的块（`useTopicReferencedBlocks` = `selectMessageBlocksByIds` + `shallowEqual`）——块-only 更新使投影失效、无关块提交不失效；request-time `ConversationService`/`baseCallbacks` 调用保持独立。
  2. **窗口投影去重**：`MessageWindow` 携带 constructor 创建的 `displayGroups`；`messageViewportProjection.ts` 在**不重新分组** `displayMessages` 的前提下保持旧 newest-group-first、组内顺序、Fragment-key 后缀与 viewport-local index 语义。
  3. **Phase 2A 默认-off 阶段归因**：`PERF_PHASE_ATTR` 构建期仪器化（closed `PhaseStage` union、512 有界环形缓冲、opaque correlation ID、DOM 端点冻结快照、fail-closed 完整性、cache-miss/cache-hit 分离系列、schema v1 输出、默认构建/E2E inert）——持久契约见 `performance-measurement.md` §6.1。
  **审计**：独立审计通过（两个 blocker 已修复）；残余可接受风险为**无直接 full-Chat memo wiring 测试**，selector（`useTopicReferencedBlocks`）与纯计算（`computeContextInfo`、`projectMessageViewportGroups`）已分别覆盖。
- **L1 验证（最终代码表面）**：启用 + 默认-off 共九个生产命令 exit 0，合计 35 个 focused E2E 测试通过；启用态全部 gates（正确性/parity/privacy/completeness/schema/ABI）通过；默认-off 9 tests pass 且**无 phase 指标泄漏**；验证全程 source/test/config 身份保持不变。聚合 `pnpm format` / `pnpm lint` / `pnpm test` 通过（4286 passed / 3 skipped），ABI145 已恢复。
- **L3 Phase 2B 证据（dirty-worktree · 非阈值 · 非基线 · 非根因）**：cache-hit repeat-switch p50 在**两次同机 dirty-worktree 运行**中观测范围为 —— N20/W10 `144.3–164.0ms`、N20/W20 `232.1–265.8ms`、N100/W10 `132.7–172.9ms`。一次启用归因运行的 phase 分解 p50（**单次启用运行，非跨运行汇总**）：DOM endpoint `108.9 / 168.4 / 118.4ms`、render computation `12.4 / 22.2 / 13.1ms`、window lifecycle `0.1ms`（对应 N20/W10 / N20/W20 / N100/W10）。形状边界：**W 增长仍方向性可见**（N20/W20 高于 N20/W10 且范围不重叠）；**固定 W 下 N20→N100 无持续增长**（N100/W10 与 N20/W10 范围重叠）；跨运行方差显著且不受控——范围与形状仅作方向判断，**不构成回归或收益声明**；phase span total 为捕获时长之和、非端到端、可与 DOM endpoint 重叠/超出（LOCK-2A-008）。
- **已评估但未实施（LOCK-005）**：**Markdown parse cache 因缺乏直接 parse-CPU 证据而被跳过**（不得据此声称 parse CPU 已被测量）；**topic-key 移除与虚拟化仍未批准/未实现**。
- **有界成本模型/假设（不声称根因）**：代码证据指向两个候选成本载体——
  1. **话题切换冷挂载**：缓存未命中切换路径穿越全话题 Main 加载 + IPC（`loadTopicMessagesThunk` → `dbService.fetchMessages` 全量 `listByTopic` + `listByMessages`）与 renderer 侧重复全话题计算（`createLatestMessageWindow`/`reconcileMessageWindow`、`computeContextInfo`）。
  2. **Markdown 可见窗口缩放**：已测数据中固定 N 下可见窗口 W 的强增长（164→529→858 ms）指向可见窗口渲染 fanout/重挂载成本，但**未做根因归属**。
- **方向性根因解释（不升级为根因确认）**：cache-hit repeat-switch 的固定 N 对照中，W20 明显高于 W10，而 N20/W10 与 N100/W10 接近；post-2B 仍保持这一形状，方向性支持 **W-bound renderer remount/render work** 为主要可见成本轴，且在固定 W 下未见 N 的持续放大。`anchorService` 的 active-resolvable fast path 减少了切换时不必要的上下文构建；Phase 2B 移除 renderer 侧重复的 `createMessageViewportGroupModel(displayMessages)` 分组与重复 `computeContextInfo`。单次启用归因运行的阶段分解显示被捕获的 render computation（12.4–22.2ms）与 window lifecycle（0.1ms）相对 DOM endpoint（108.9–168.4ms）为小量——endpoint 为自 correlation 起点捕获的包含式时长，**非**对未捕获路径（Main/IPC/React 调度/parse）的根因归属；各改动的单独贡献仍未被隔离。
- **测量条件与命令（2026-08-18）**：fresh production build 后使用 `PERF101_CACHE_HIT=1 PERF101_SCALE=n20-w10 pnpm test:e2e -- tests/e2e/specs/conversation/perf101-cache-hit-repeat-switch.spec.ts`、`PERF101_CACHE_HIT=1 PERF101_SCALE=s0-20 pnpm test:e2e -- tests/e2e/specs/conversation/perf101-cache-hit-repeat-switch.spec.ts`、`PERF101_CACHE_HIT=1 PERF101_SCALE=n100-w10 pnpm test:e2e -- tests/e2e/specs/conversation/perf101-cache-hit-repeat-switch.spec.ts`；`n20-w10`、`s0-20`、`n100-w10` 与 cache-miss `PERF-101` profile aliases 共享。每个 profile 使用 3 个 samples；每个样本的确定性话题数据在测量点击前通过 typed ChatDb bridge 逐消息 `appendMessage` 完成，seed setup 不计入 click→render measured interval；L1 correctness/parity/privacy/ABI gates 全部通过。数值按 `p50/p95/mean` 契约记录；本段仅保留 p50 方向性摘要。阶段归因子切片（topic 路径）仅在 `PERF_PHASE_ATTR=1 pnpm build` 启用构建下发射 phase metrics（默认构建/E2E inert），经 `cacheMiss.phase.*` / `cacheHit.phase.*` 分离系列写入 schema v1 artifact（`performance-measurement.md` §6.1）。
- **明确未知项**：大话题规模（300+）与受控内容复杂度下的行为；内容复杂度轴；用户频率数据；O(N) 全话题工作与 O(W) 窗口渲染 fanout 的独立归属；fast path、共享投影与窗口投影去重对用户可见结果的单独贡献；Markdown parse 的 CPU 贡献（parse cache 因缺乏直接 parse-CPU 证据未实施，LOCK-005）；topic-key 移除与虚拟化的可行性/收益（未批准，LOCK-005）；跨运行噪声界。
- **下一实验/分析目标**（候选，未授权）：N300/W10 与受控内容复杂度规模的按需测量，或 renderer 窗口侧缩放的结构归因（parse cache / topic-key 移除 / 虚拟化须先有直接 parse-CPU 或结构证据并获得显式批准，LOCK-005）。**未授权不执行**。
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
- **已完成实现切片（不等于产品关闭）**：`anchorService` 增加 active-resolvable fast path，避免已可解析 anchor 再次构建 context turns；`useSmoothStream`/`Markdown` 在 completed block 路径绕过 smooth-stream reset/animation-frame 生命周期，直接提交 authoritative final content。Phase 2B 追加 renderer 边界切片：`Chat.tsx` 单一共享 `computeContextInfo` 投影（Messages/Inputbar 共用一次计算 + 仅订阅 active-topic 引用块，`useTopicReferencedBlocks`）与 `MessageWindow` constructor 级 `displayGroups` + `messageViewportProjection.ts`（保持旧视口投影语义、无重新分组）；echo 路径经 `echo.sharedContextInfo`/`echo.visibleGroupModel`/`echo.windowCreate`/`echo.windowReconcile`/`echo.domEndpoint` 阶段归因（默认-off `PERF_PHASE_ATTR`，持久契约见 `performance-measurement.md` §6.1）。实现保持 renderer 边界，不改变 Main SQLite authority、IPC 契约、持久化语义、50ms cadence 或 context-window/anchor 治理。
- **测量条件与命令（2026-08-18）**：fresh production build 后，empty profile 使用 `pnpm test:e2e -- tests/e2e/specs/conversation/perf103-echo-latency-measurement.spec.ts`；batch-seeded profiles 使用 `PERF103_HIGH_TURN=1 PERF103_HIGH_TURN_TURNS=20 pnpm test:e2e -- tests/e2e/specs/conversation/perf103-high-turn-echo-measurement.spec.ts` 与 `PERF103_HIGH_TURN=1 PERF103_HIGH_TURN_TURNS=100 pnpm test:e2e -- tests/e2e/specs/conversation/perf103-high-turn-echo-measurement.spec.ts`。PERF-ECHO 的 prior-turn history 是通过 typed ChatDb bridge batch-seeded；不是 sequential-send pressure。Phase 2A 阶段归因仅在 `PERF_PHASE_ATTR=1 pnpm build` 启用构建下发射（`phase.*` 系列，27 metric IDs）；**high-turn spec 不发射 Phase 2A 阶段分解**，阶段分解由 PERF-103 standard（empty profile）路径捕获；默认构建/E2E 保持 inert。
- **方向性结果（p50，单位 ms；L1 gate 通过，数值 L3 · dirty-worktree · 非阈值/非基线/非根因）**：PERF-103 standard（empty profile）p50 在**两次同机 dirty-worktree 运行**中观测范围为 `reduxCommit 27.1–33.1`、`firstRender 70.2–87.2`、`reduxToDom 42.4–52.7`；一次启用归因运行的 phase 分解 p50（**单次启用运行**）为 `userAction 13.1`、`renderComputation 0`、`windowLifecycle 0`、`DOM endpoint 83.5`——**phase span total 为捕获时长之和、非端到端，可与 DOM endpoint 重叠/超出**（LOCK-2A-008）。High-turn（batch-seeded）p50 观测范围：20 prior `52.5–77.1 / 150.8–199.8 / 96.2–122.7`、100 prior `50.3–71.7 / 140.1–202.4 / 91.4–130.7`（reduxCommit/firstRender/reduxToDom）；**每次运行内 20→100 保持近似平坦/无放大**，而跨运行绝对方差显著且不受控——范围与形状仅作方向判断，不构成阈值、基线或回归判定；每样本 Redux→DOM 仍被一个主导重叠长任务方向性覆盖。
- **方向性根因解释（不升级为根因确认）**：echo full-topic pre/post 对照把主要可见工作仍定位在 renderer 的 full-topic message/viewport lifecycle；post-2B 的共享投影与窗口投影去重、completed-block no-RAF 生命周期及 anchor fast path 均与该定位方向一致，但现有切片不能把收益分别归因到各改动，也没有证明消除所有冗余 React work。`reduxCommit` 相对稳定，不能据此把成本归属到 Main/IPC/SQLite；单次启用运行 phase 分解中 `renderComputation 0` / `windowLifecycle 0`、DOM endpoint 为主导项（方向性观察，非对未捕获路径的根因归属）。
- **PERF103 harness 效率结果（不作为产品延迟证据）**：batch-seeded PERF103 将真实 UI sends 从 `212` 降至 `12`，单次运行从约 `222s` 降至 `41.6s`；这是测量 harness 效率改善，不是产品 latency 改善或回归证据。
- **回归覆盖（2026-08-18）**：post-opt `tests/e2e/specs/conversation/streaming-responsiveness.spec.ts` fresh production-build E2E 通过；focused renderer coverage 通过 `useSmoothStream.test.ts`、`Markdown.streaming.test.tsx`，anchor coverage 通过 `anchorService.test.ts`；Phase 2B 覆盖通过 `contextInfoService.test.ts`（共享投影契约）、`useTopicReferencedBlocks.test.tsx`、`messageViewportProjection.test.ts`、`messageWindow.test.ts`。**Phase 2A/2B L1 验证（最终代码表面）**：九个生产命令（启用 + 默认-off）exit 0，35 个 focused E2E 测试通过，启用 gates 全过、默认-off 无 phase 泄漏；聚合 `pnpm format` / `pnpm lint` / `pnpm test` 通过（4286 passed / 3 skipped），ABI145 恢复。这些是 L1 正确性/边界回归证据，不把 timing 数值升级为阈值，也不替代用户可见验收。
- **明确未知项**：单阻塞长任务内的具体阶段归属（无 whole-echo/React-pass 归属）；anchor fast path、completed-block no-RAF 与 Phase 2B 共享投影/窗口投影去重的独立收益；300 prior turns / 300-turn evidence；更广设备与负载下的方向是否稳定；跨运行噪声界；用户是否接受当前回显结果；匹配边界的长期回归保护尚未记录（Phase 2B 残余风险：无直接 full-Chat memo wiring 测试，selector 与纯计算已分别覆盖）。
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

### 2.5 PERF-RENDER-FLOW — 渲染器可见子树 fanout/lifecycle 优化（Paused）

- **工作流状态**：`Paused`。候选队列已耗尽（A 延迟/未授权，B/C 已完全回退），停止条件已满足。恢复条件：Main/用户对新的有界候选或范围决策的显式批准。暂停期间不推进任何探针或实现。
- **产品问题关联**：PERF-TOPIC-SWITCH 与 PERF-ECHO 的共享 renderer 侧渲染成本轴（用户可感知的切换/回显延迟中 renderer lifecycle 部分）。
- **目标**：提升用户感知的话题切换与回显流体性——减少可见子树的 mount/render/effect work count，方向性改善端点用户可见延迟。

#### 战术操作循环（Tactical Operating Loop）

执行 `performance-program.md` §4A 定义的高流战术循环，适用于 renderer-only presentation/local-state 安全区（§9A）：

1. **代码路径追踪**：沿静态地图追踪用户关键路径（见候选队列下方的静态放大事实）。
2. **候选短列**：每次最多 1–3 个高置信度放大候选（从候选队列中选取）。
3. **最小可逆实验**：实现最小单变量可逆候选；renderer 安全区内直接执行。
4. **廉价证据**：使用最廉价的充分聚焦测试——mount/render count、effect invocation count、focused user-visible 端点观察。
5. **保留或回退**：产生可观测减少且方向正确的保留；否则完全回退。
6. **批量集成验证**：保留的候选在集成时批量执行 fresh 生产构建 E2E 与聚合 gate（`pnpm format`/`pnpm lint`/`pnpm test`），而非每个实验前执行。

#### 决策权利（Decision Rights）

- 子活动独立执行高流循环；Active 唯一性保持在父工作流层级。
- 跨越 §9 任一治理边界时停止并走 ADR（PERF-LOCK-008）。
- 不允许：speculative bulk memoization sweep、声称证据层级升级（§7 不变）。
- 本工作流不授权：topic-key removal（`key={activeTopic.id}`）、virtualization、Markdown parse cache——这些须单独显式批准。

#### 候选队列（Candidate Queue）

不超过三个初始审计候选。每个候选为静态信号假设——代码审计/计数/观察是 provisional probe 证据，可证明实际工作消除方向并决定保留/回退，但不能自行设置 Experiment/Integrated/Protected/Done 状态（见下方生命周期权限）：

| 候选 | 范围 | 保留条件 |
|---|---|---|
| **A: topic-key remount boundary** | `key={activeTopic.id}` 触发的全子树 remount 生命周期爆炸半径 | 证明 key 是实际放大因子（remount count 高且可减少）；否则回退 |
| **B: MessageGroup/projected-array identity** | 静态分析显示 projected array identity 在 switch/echo 路径下可能不稳定，潜在 defeat MessageGroup memo；此为候选信号，非已确认因果 | 证明 unchanged-item render count 下降且端点方向不恶化；否则回退 |
| **C: selector/effect fanout** | MessageItem/Blocks/Markdown 的 per-message/per-block Redux subscription 与 per-Markdown lifecycle effects | 证明 selector notification/effect invocation 减少且内容/流式/上下文正确性不变；否则回退 |

- **当前状态**：所有候选均已非活跃——A（topic-key remount boundary）未授权/延迟，无移除/结构实验被批准；B（MessageGroup/projected-array identity）的 work-count reduction 未转化为端点方向改善，已完全回退；C（selector/effect fanout）的 narrow subscription 已完全回退——安全修正需要 broader action/reasoning ownership 变更，超出 approved single-variable experiment 范围。任何候选均不得推进至 Experiment/Integrated/Protected/Done 状态。
- **group-model O(N) rebuilding** 作为二级事实仅在材料时检查——当前测量的 render computation（12.4–22.2ms）相对 DOM endpoint 为小量，不作为首要候选。

#### 具体探针程序（Concrete Probe Procedures）

每个候选的探针程序轻量、候选局部、不创建通用框架：

**A: topic-key remount boundary**
1. 固定 profile：cache-hit topic switch，W10 与 W20 各一次。
2. Before/after 或 control 计数：一次 switch 中 Message/Block/Markdown 组件的 mount/unmount 次数。
3. 聚焦断言：语义 lifecycle state（anchor、scroll position、streaming state）在 switch 后保持正确。
4. 端点：切换后首次可用渲染时间，仅方向性。
5. 保留条件：mount count 下降且断言通过、端点方向不恶化。

**B: MessageGroup/projected-array identity**
1. 固定 profile：一次 cache-hit switch + 一次 optimistic echo。
2. 计数：unchanged visible MessageGroup/MessageItem 在 switch/echo 后的 re-render 次数（before/after 或 control）。
3. 保留条件：unchanged-item render count 下降且端点方向不恶化。

**C: selector/effect fanout**
1. 固定 profile：与 A/B 相同的 cache-hit switch 与 echo 动作。
2. 计数：相关 selector notification 次数与 effect invocation/cleanup 次数（before/after 或 control）。
3. 保留条件：notification/effect count 下降且内容/流式/上下文正确性不变。

#### 探针记录（Minimal Probe Record）

每次探针仅记录以下最小记录，无需 schema artifact 或 committed numeric threshold：

| 字段 | 内容 |
|---|---|
| 候选 ID | A / B / C |
| 代码变更 | 简述修改了什么 |
| 固定动作/profile | cache-hit switch W10/W20 或 echo，空 profile |
| Before/after work count | mount/render/notification/effect count 的 before 与 after |
| 聚焦断言结果 | PASS/FAIL（语义正确性断言） |
| 端点方向 | 改善/持平/恶化（方向性，非数值阈值） |
| Keep/revert | 保留或回退 |

#### 生命周期权限（Lifecycle Permissions）

Probe evidence（代码审计/counter/focused observation）为 **Candidate 阶段** provisional 证据。它可：
- 决定保留或回退（→ 回退到 Candidate 或进入 Experiment 规划）。
- 为 Experiment planning 提供方向。

它不可：
- 自行将状态推进到 Experiment/Integrated/Protected/Done。
- 替代 production E2E 或 aggregate gate 作为集成验证。

状态推进仍受 `performance-program.md` §5 生命周期与 §8 关闭规则约束。

#### 集成 gate（Integration Gate）

Batch fresh production E2E + aggregate gates（`pnpm format`/`pnpm lint`/`pnpm test`）是**集成检查**，在保留候选进入集成时执行。它不自动关闭产品问题（§2.1/§2.3 的 `Open` 状态不受 probe 结果影响）。

保留的候选在以下时机批量执行验证：
- 候选被保留且进入集成阶段时
- 跨越保护边界前

#### 并行隔离规则（Parallel Isolation Rule）

- **当前状态**：工作流 `Paused`，不执行任何探针。以下为恢复后的规则记录。
- **并行允许条件**：仅在 isolated worktree/build/disposable profile 且 writes/instrumentation 不重叠时允许并行探针。并行不意味着共享状态或跨候选因果依赖。
- **Active 唯一性**：保持在父工作流层级；并行探针不创建额外 Active 工作流。

#### 停止/升级条件（Stop / Escalation）

以下任一条件触发停止，回到 Main/用户决策：

1. 变更跨越 §9 任一治理边界（ADR 级，PERF-LOCK-008）。
2. 候选间无法通过静态分析区分主次。
3. 实验结果模糊——方向不确定。
4. 回归风险高。
5. 候选需要新的通用测量框架——不构建新框架，除非升级条件满足。

#### 非目标（Non-Goals）

- 不构建新的通用测量框架（除非升级条件触发）。
- 不做无边界的 speculative bulk memoization/optimization sweep。
- 不声称证据层级升级（§7 层级约束不变）。
- 不授权 topic-key removal、virtualization、Markdown parse cache——须单独显式批准。
- 不改变 Main SQLite authority、IPC 契约、持久化语义、跨进程/跨窗口/lifecycle/原生边界。
- 不创建 ADR 权威。
- 不设定阈值（PERF-LOCK-003）。

#### 静态放大事实（候选来源 · 非根因确认）

以下为静态分析识别的候选放大事实，是候选不是根因确认：

1. **Key-based full subtree remount**：`key={activeTopic.id}` 在话题切换时触发 Messages 全子树卸载/重挂载，生命周期爆炸半径覆盖所有可见 MessageGroup/MessageItem/Blocks/Markdown。
2. **Unstable projected group-array identity**：`projectMessageViewportGroups` 每次返回新 array 引用，may weaken MessageGroup memo；probe 需确认 switch/echo 路径下 unchanged-group re-render 是否因此增加。
3. **Full group-model rebuild on latest reconciliation**：每次 reconciliation 重建全量 group model（O(N) per message/block）。
4. **Per-message/block Redux subscriptions**：MessageItem/Blocks 层级的独立 Redux selector 导致 granular re-render。
5. **Per-Markdown lifecycle effects**：Markdown 组件的 lifecycle effect（parse/syntax highlight 等）在 remount 时重新触发。

#### 暂停状态说明（Paused State Note）

工作流当前 `Paused`，以下为历史上下文，不构成执行指令：

1. A（topic-key remount boundary）静态确认为高 blast-radius 候选，但无移除/结构实验被授权——延迟。
2. B（MessageGroup/projected-array identity）work-count reduction 未转化为端点方向改善——已完全回退。
3. C（selector/effect fanout）narrow subscription 已完全回退——安全修正需 broader action/reasoning ownership 变更，超出范围。
4. 候选队列已耗尽；恢复需 Main/用户对新的有界候选或范围决策的显式批准。

- **优先级定位**：优先于 PERF-DB-HEALTH（Planned）方向——renderer 可见子树 fanout/lifecycle 是当前用户感知延迟的高放大轴。

## 3. 已完成的生产优化成果摘要（Completed Production Outcomes）

以下为实际合并的生产优化组（非详细运行历史；完整交付记录由 Git 历史承担）。对应 legacy 测量资产仅作证据身份引用。

| 优化组 | 成果摘要 | 生产实现 | 回归证据 |
|---|---|---|---|
| 编辑模式进入/退出 | 编辑模式不再重挂载可见消息子树（renderer-only 稳定宿主 + 显式 `resetToken`） | 已集成 | renderer 测试 + fresh 生产构建 E2E（编辑 gate） |
| 多消息中部插入（粘贴） | 逐条串行 IPC 改为批量插入（单次 `insertManyAt` 稠密 zero normalization + 单 renderer 提交） | 已集成 | fresh 生产构建 E2E（粘贴 gate） |
| 多模型答案标签切换 | 两次 DB-first foldSelected 写入收敛为单原子 `select-answer-message` 契约（单事务 + 单 plural Redux 提交） | 已集成 | 新增契约/聚合/IPC/Redux 测试 + fresh 生产构建 E2E |
| 回显/完成块 renderer 生命周期 | 已可解析 anchor 走 active-resolvable fast path；completed Markdown block 绕过 smooth-stream reset/RAF 生命周期并直接提交最终内容 | 已集成 | `anchorService.test.ts`、`useSmoothStream.test.ts`、`Markdown.streaming.test.tsx` + fresh 生产构建回显/streaming-responsiveness E2E |

> 生产基线资产：`PERF-002` 已建立**首批 committed-state machine-readable 参考基线**（schema v1 artifacts，gitignored 本地 deliverable）——数值为 **L3 非阈值参考基线**，唯一已提交阈值仍为冷开 `<500ms`（`performance-measurement.md` §7）。`PERF-001` 已落地 schema v1 结果契约；`PERF-004` 首切片已落地 FTS 1k/10k 快速确定性参数化与只读 schema-v1 artifact 曲线/方差/knee 方向性消费者。以上均为测量/基础设施成果，不关闭本文件 §2 的任何 Open 产品问题。
>
> **Phase 2B 状态说明**：Phase 2B 的 renderer 投影切片（共享 `computeContextInfo` 投影 + `MessageWindow` constructor 级 `displayGroups`/`messageViewportProjection.ts`）当前为**已实现、未合并提交**状态（dirty worktree），记录于 §2.1/§2.3「已完成实现切片」；其 L1/L3 证据均为 dirty-worktree 证据（LOCK-003）。进入上表「实际合并」语义须待提交/合并后由 Git 历史承载。

## 4. 关闭条件与推进规则

1. **产品问题保持 Open** 直至：已接受的用户可见结果 + 需要时集成实现 + 匹配边界回归证据（`performance-program.md` §8）。
2. **测量完成不关闭产品问题**（DOC-004）：legacy PERF-101/102/103 测量资产为证据身份，其 `Done` 不关闭对应 Open 问题。
3. **不把 L3 数值当作阈值/根因**（PERF-LOCK-003）：本文件所有数值均为 L3 方向性/参考，非阈值、非根因归属。
4. **推进须显式授权**：任何新实验/分析/实现须经 Main/用户显式授权；未授权不执行；关闭不自动激活新工作流。
