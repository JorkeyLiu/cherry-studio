 # Chat 轻量设计：流式生成生命周期归属（切片 1）与 read-window 边界收归（切片 2）

 - 状态：切片 1、切片 2 均已实现（worktree），未合入、无产品语义变更、无 ADR 变更。
- 范围锁：只动 `src/renderer` 流式节流/RAF 的所有权；协议、DB schema、Main/aiCore、产品行为、UI、既有 50ms 刷新节奏、attempt 与 pinned route、DB-first、loaded 门控、RAF 不进 barrier 的语义全部保持。
- 既有 `docs/work/` 三份文档（chat-normal-flow-evaluation、multi-device-sync、pagination-cap-and-browse-render-convergence）与本切片无冲突；ADRs（identity、context-window、projection、branches、viewport、model-metadata）不受影响。

## 1. 目标

聊天链路减熵。终态是让每次生成的全部运行时状态（执行快照、节流器、RAF 任务、写屏障、回调装配）随执行同生共死；删除是唯一合法的跨 execution 操作。本切片只做第一步：流式 throttle/RAF 由 execution 拥有，全局只留下删除所需的显式跨 execution 取消登记。

## 2. 当前 read/send 路径（切片前）

- send：UI → `_sendMessage` → 队列 → `fetchAndProcessAssistantResponseImpl`（`messageThunk.ts`）→ pin `execRoute`（active route 快照）→ 建 `AssistantExecutionState` + `WriteBarrier` + `BlockManager` + callbacks → `transformMessagesAndFetch` 驱动流。
- 流式写：`BlockManager.smartBlockUpdate` 非终态块走 `throttledBlockUpdate`（50ms lodash + RAF 包 Redux mirror + `updateSingleBlock` 直写 DB），终态/切块走即时 DB + flush；`onComplete` 先 `quiesceWrites`（flush 本执行 touched 块 + `barrier.quiesce()`）再单事务终态持久化（Fix B）。
- read：`AssistantExecutionState` 是本执行的快照事实；Redux 只是可选 mirror（`isLoaded()` 活查 + `shouldMirrorToRedux` 在 RAF 执行时求值）。
- 问题：`blockUpdateThrottlers` / `blockUpdateRafs` 是模块级全局 LRU（blockId 为键，跨 execution 共享）。lodash trailing 取 LATEST 调用参数，后一代 execution 的 ctx（attempt/barrier/route/mirror 门）会覆盖前一代同 block 的 pending trailing 写；cancel/flush 只能按裸 blockId 定位，无 execution 维度。

## 3. 三个方向

1. **生成生命周期**（本切片）：throttle + RAF + barrier 的归属从全局 LRU 收归单次执行；`StreamWriteScheduler` 随执行创建、随执行结算释放；删除保留显式跨实例取消。
2. **窗口到视口交接**（后续）：loaded 窗口切换与视口恢复时，执行快照 → 投影的交接边界（`routeSwitch`、`topicSegment` 相关），不在本切片动。
3. **渲染派生**（后续）：Redux mirror 与 markdown/usage 等派生计算的去重与节奏，不在本切片动。

## 4. 本次切片

新增 `src/renderer/src/services/messageStreaming/streamWriteScheduler.ts`：

- `StreamWriteScheduler`：per-execution 拥有 per-block throttle 函数 + RAF 句柄；构造时绑定不可变 `resendAttemptId` / `topicId` / `branchId`（pinned route）/ `isLoaded` / `barrier`，以及注入的 `performWrite`（block-only DB 通道）与 `mirrorToRedux`（Redux 分发）。trailing 写在执行时解析 ctx（调用覆盖优先，缺省回退到执行绑定），DB 写被 tracked 到执行 barrier，RAF 回调只做 mirror 门控后分发。`drainMirrors()` 把 withheld 的 mirror 回调内联执行（只动 Redux 投影，不碰 DB、不等 barrier），供终态在 quiesce 之后调用，保证最终投影文本完整。
- 生命周期：`schedule` / `flush`（不丢弃）/ `cancel` / `drainMirrors` / `dispose`。`dispose` 取消全部 pending throttle timer + RAF（含未执行的 mirror）、从 live registry 注销、此后 `schedule` 直接丢弃（in-flight barrier-tracked DB promise 照常 settle）。任何路径都不允许“dispose 丢尾”：成功路径 `onComplete` 先 `quiesceWrites`（flush 本执行 touched 集合 + `barrier.quiesce()`）再 `drainMirrors` 再单事务终态持久化；abort/error 路径 `onError` 同样先 quiesce + drain 再终态标记与终态持久化；SSE `finally` 与 channel `.finally` 在 `dispose` 之前先 `await blockManager.awaitTerminal()`，从未触发终态时（如 nothing-sendable no-op）立即返回。终态注册遵循 first-wins：成功后再到的 error（或反之）不再二次发布与持久化。
- `BlockManager` 新增本执行终态账户：`tryStartTerminal` 同步抢占（first-wins，重复终态直接返回）、`trackTerminal` 同步登记（observed 处理，不 fire-and-forget）、`awaitTerminal` 永不拒绝的 join、`drainMirrors` 透传；`quiesceWrites` 语义不变。`createCallbacks` 对 `onComplete`/`onError` 做同步登记包装（dispatcher/adapter 不动，仍是同步 void）；channel 装配后移入 try（同步 throw 即 dispose + loading 复位 + 原错重抛），process 拒绝按既有 `callbacks.onError` 收尾再 join。
- 测试：`messageThunk.blockWriteRoute.test.ts` 的 throttled 用例改用局部 scheduler 实例（不再引用已删除的全局入口）；`streamWriteScheduler.test.ts` 8 例 + `drainMirrors` 2 例（内联 withheld mirror 不多写 DB、cancel/dispose 后 drain 无副作用）；新增 `terminalJoin.test.ts` 6 例（成功终态 deferred 时 owner 不完成不 dispose、error/abort 50ms 内 pending 落盘且顺序 pending→终态→dispose、重复终态不二次发布、channel reject 走 error 收尾保留文本、channel 同步装配 throw 注册表无残留）。

## 5. 可验证的结构收益（已由测试锁定，非性能承诺）

- 同 block 相邻两代执行的 trailing ctx 覆盖被消除：各执行有独立 throttler，`cancelBlockEverywhere` 按实例扇出而非共享注册表。
- 删除语义可测试：删除 cancel 跨全部存活实例，后建执行不受影响。
- 释放语义可测试：`dispose` 后无 timer/RAF 残留、无 registry 泄漏、无后续写；`flush + barrier.quiesce` 顺序由测试锁定；RAF 缺席（occluded 窗口）不阻塞 quiesce；终态 `drainMirrors` 内联补齐投影（DB 不动），abort/error 同样先 quiesce 再终态、owner 先 join 再 dispose。
- 不变量保持（由既有测试锁定）：attempt 线程化 + Main fail-closed（resendAttempt）、pinned route 永不重解析（blockWriteRoute）、DB-first 单事务终态（messageStreamingFinalAtomic）、loaded 门控（streamCallback/resendRegenerateCleanup/firstChunk/reasoningFallback）。终态幂等（first-wins，不二次发布/持久化）由 `terminalJoin` 锁定。

明确不声称：任何延迟/吞吐/fps/内存/jank、“更轻/更快/更流畅”类性能结论；E2E 响应性断言是功能契约不是 benchmark；`pnpm test:e2e` 与 build 不在本轮跑（由主代理决定后续集成）。

 ## 6. 后续范围（切片 2 落定后更新）

 - ~~切片 2 候选：窗口到视口交接（route switch + segment restore 时执行快照与投影的一致性）。~~已由下面 §8 以“read-window 边界收归 residentRegistry”的有界形式完成；route switch / segment restore 的执行快照交接仍不在范围内。
 - 切片 3 候选：渲染派生去重（mirror/parse/usage 节奏）。
 - 任何跨越 ADRs（identity、branches、viewport、model-metadata）或改变删除/resend/分支产品语义的事项，先回主代理决策，不在本设计内自行扩大。

 ## 8. 第二阶段：read-window 边界收归 residentRegistry（已实现）

 - 动机：`pages/home/Messages/messageWindow.ts` 的模块全局 `latestWindowCompletenessByTopic` Map 与 `store/index` rootReducer 写 Map 的 side effect、`topicDeletionInvalidation` / `residentRetention` 的分散 clear，是投影适用性（projection applicability）之外的第二份“谁有最新窗口”的事实来源。收归后：最近一次本地权威读取的窗口边界 metadata 是 renderer 非持久、非 StoreSync 的投影自有（projection-owned）状态，随 `publishResidentComplete` 同次 reducer 交付/拒绝，由投影失效统一清理。不新增抽象层、新 service、新全局 cache；`packages/shared`、IPC/Main/DB/StoreSync 语义、ADR、restore/滚动算法均未动。
 - 载体：`residentRegistry` 的 `ResidentEntry` 新增可选 `windowCompleteness?: ResidentWindowCompleteness`（`{ hasMoreBefore, hasMoreAfter }`，字段名沿用 Main 声明原样，不 relabel 为 older/newer）。命名与类型边界强调三重“不是”：不是整话题完备性、不是 viewport `MessageWindow`、不代替 viewport 的 `hasMoreOlder/hasMoreNewer`。union latest/around 的 metadata 语义维持既有，Main `hasMoreBefore/After` 只描述其声明的窗口。
 - 写入：只在 `publishResidentComplete` 同次 reducer 内、同一 generation guard 通过后写；`window` 缺席时不写（与旧 Map “只在 payload.window 存在时 write”一致）；stale/缺 entry 的 joint 拒绝不写。值相同（两字段都不变）时不换引用（Immer 保持原对象引用，与旧 Map 同值行为一致）。
 - 读取：纯类型化 selector `selectTopicWindowCompleteness(state, topicId)`，`undefined` = 该话题无保留窗口。唯一生产消费点 `Messages` 首载分支用 `store.getState()` 快照读一次，不新增订阅（无每 chunk 重渲染、无 effect 依赖变化）。
 - 清理对照（旧 Map 事件 → 新行为，无一扩大旧 `hasMore` 有效性）：
   - joint publish（window 存在）→ 切片内同次写；joint 拒绝（stale/缺 entry）→ 不写（旧 rootReducer 跳过 Map 写）。
   - `RETENTION_EVICT`（旧 rootReducer + `residentRetention` 双 clear）→ 唯一 `retentionEvict` reducer 丢字段。
   - 删除（旧 `bumpDeletionGeneration` 直接 clear + 分发失效）→ 仅 `invalidateForDeletion` reducer 丢字段。
   - 测试 reset（旧 `resetAll/clearAll`）→ `resetAllResidentRegistry`（entries 重置）。
   - unpaired/fromSync segment invalidation（rootReducer 集中重建）→ 保留 spread（只 fence residency，不碰边界）。
   - `bumpGeneration` / `markSegmentsLoaded` → 保留（旧 Map 本就不清）。
 - 已知残留（非语义变更，如实记录）：`clearEntry`/`resetAll` 删除 entry 时连带丢边界（旧 Map 在这些路径下存活；无生产调用方）；`publishSegmentCatalogPublishComplete` 缺 entry/gen-0 分支建空 entry 不带边界（仅 entry 被删后可达，无生产路径）；删掉了零调用方的 `resetAllDeletionStateForTests`。
 - 可验证的结构收益（测试锁定，非性能承诺）：同次 dispatch 下数据与边界同见（`residentLifecycle` 单 dispatch 断言五者）；stale 发布对边界无副作用；空话题已加载（边界在）vs 未加载（`undefined`）可区分且不断言整话题；删除/retention/segment 失效统一清理且 A/B 话题不串（`topicDeletionPrecise` tDel/tKeep、`residentLifecycle` 双话题异值 around/latest）；同值发布引用稳定（`topicActivationDedup` `toBe`）。
 - 实际验证结果（worktree HEAD 044ba34848 + 本切片 dirty）：`pnpm test:renderer` 全量串行（`CI=1 --maxWorkers=1 --no-file-parallelism`）672 文件 / 8354 用例 exit 0；`pnpm typecheck` 五通道 exit 0；fresh `pnpm build` exit 0；E2E 7/7 exit 0（`windowed-message-reads` R-02/R-03×2/R-04/R-05、`route-settings-session`、`top-cross-route-provenance`，2.7m）。收尾：spec 空白修平后 `biome format check` 0、`git diff --check` 0、`pnpm typecheck:e2e` exit 0，同 7 E2E 在复用 fresh build（production inputs 零变更已用 `find -newer` 穷举证实）上复验 exit 0（7 passed，2.6m）；renderer 全量未重跑（E2E 格式改动不触 Vitest inputs）。
 - 本轮两处 test-only 修复，均未改 viewport/controller/生产行为、未删断言/减用例：(1) `Messages.mountedTransition` / `Messages.readingAnchor` 共 38 用例曾因 mock store 缺 `residentRegistry` 在 `Messages.tsx:3083` 首载调用抛错——修复为 fixture 补齐生产形状（`residentRegistry: { entries: {} }`，即 slice `initialState`），真实 selector 读 `undefined` = 未发布；selector 保持严格类型契约（与 `selectResidentEntry` / `selectIsResident` / `selectGeneration` 一致），`shouldDiscardJointPublish` 的既有 `?.` 链仅覆盖 rootReducer 未知 state 场景，不扩展。(2) E2E R-04 夹具漂移：`settings/setmarkdownExportPath` + 读已删除字段改为现有 `settings/setExportPath` / `state.settings.exportPath`（`settings.ts:543`、`migrate.ts:4814-4823` 迁移、`utils/export.ts:421,465` 预设路径分支为锚），断言意图不变；收尾轮已用 targeted `biome format --write` 修平该 spec 本轮新增 6 行缩进，diff 仅限 R-04 三组 fixture 行，无扩散，`biome format check` / `git diff --check` 均为 0。
 - 限制：结论仅覆盖上述命令与用例集合；未跑全量 E2E；无性能结论。
 - 明确不声称：任何延迟/吞吐/fps/内存/jank 结论；全量 E2E（除上述 7 用例）未跑。

## 7. E2E 夹具预算修正（仅测试，产品语义不变）

- 现象：`tests/e2e/specs/conversation/streaming-click-pause.spec.ts` 的主暂停用例（`primary content press pauses follow without moving text; resume and controls hold`）在默认 4145 字符 slow-stream 上，`>=3.5s` 逐帧 sampler 结束时已达 3624–3652 字符，而其后要求 `samplerEnd + HOLD_GROWTH(500) = 4124–4152`；一旦 sampler 结束落在 3652 即 `4152 > 4145`，目标在算术上不可达（baseline 时仅剩 21 字符余量）。
- 修正：该用例的 STREAM B 改用仓库既有 `EXTENDED_SLOW_STREAM_MARKER`（同形状、同 60ms 节奏，300 段 ≈ 8345 字符 / 302 chunks ≈ 18.1s），并把 hold 目标改为对**同一 payload 事实**（`extendedSlowStreamTotalLength()`）判定；`expectedB` 与完成等待同步改用 `getExtendedSlowStreamReply()`。STREAM A 仍用默认 4145 字符 payload，断言未变。
- 保留不变：streaming 状态断言、sampler ≥500 字符 / ≥2 步增长、1/64 CSS px 量子抖动、post-growth 锚点与距底、resume 及其后续增长、默认 timeout 与全部既有阈值；未改全局 mock server 的 payload，也未改其他 spec。
- 实测（fresh build 未变，仅测试改动）：单跑该用例 exit 0（`samplerEndLen=3652 target=4152 total=8345 remaining=4693 → finalLen=4156 status=streaming`，sampler `frames=255 dur=3526ms growth=1599 steps=58 pTopRange=0`）；同 spec 的 control 与 wheel 两腿各自 exit 0。原先的失败是该预算算术，不是暂停行为回归。
- 已知 baseline 失败（非本次修正目标，未重复跑）：zoom 用例（`paused stream holds one quantum at 1.25 effective zoom`）在 `waitForFunction` 于 zoom 收敛处 15s 超时（spec 内 1760 行附近），与本次预算无关。

## 9. 第三阶段：fork-divider 逐组查找收归单次派生索引（已实现）

- 范围（最小切片，仅 `buildMessageFlowNodes` 内）：此前每个 group 执行 `groupMessages.map→new Set` 再对全部 `forkDividers.filter(boundaryMessageId)`（O(G×D) 重复查找）。现改为一次 build 调用内按 `boundaryMessageId` 建 `Map<string, ForkDividerPlacement[]>`（同 boundary 多 divider 保持输入顺序），每组只取相关 divider；同组多边界时按输入序恢复以与原逐组 filter 输出完全一致。注释明确该索引是输入的一次派生 memo，不是第二权威（placement 真值仍在 `resolveForkDividers` + 窗口输入；`head` divider 仍走原独立循环）。
- 保留语义（未动）：消息分组、viewport/window、route/scroll/anchor、Redux/IPC/DB/authority、Message memo、整体 `buildRenderSegments/layers`；输出节点顺序（normal-flow 反转）、稳定 group/layer/segment IDs、divider push-before/reverse-after、data attrs、MessageGroup keys、hasMoreNewer/BackToTop 均不变。
- 结构性收益（测试锁定，非性能承诺）：`messageFlowNodes.forkDividerIndex.test.tsx` 5 例——多组多 divider 只归属边界消息、同 boundary 多条保序、无 divider 与无 group、输出节点顺序/稳定字段不变，以及 naive 逐组 matcher 等价对照（混合输入含共享边界/offscreen/head/单组双边界，节点签名全等）。不测试内部 Map、不声称复杂度/性能数字。
- 未涉及的更大重复链（仍在范围外）：`resolveContextDividerGroupKey` / `resolveReferenceBoundary` / 深层 `resolveReferenceDividers` 的逐组 `some` 扫描、mirror/parse/usage 派生去重（原 §6 切片 3 候选），以及 route switch / segment restore 的执行快照交接。
- 最终可信结果：独立 bounded 审查 0 findings；`CI=1 pnpm test:renderer --maxWorkers=1 --no-file-parallelism` exit 0（673 files / 8359 tests）；`pnpm build` exit 0；`pnpm test:e2e tests/e2e/specs/conversation/windowed-message-reads.spec.ts tests/e2e/specs/conversation/topic-scroll-save-restore.spec.ts tests/e2e/specs/conversation/top-cross-route-provenance.spec.ts tests/e2e/specs/conversation/window-grouped.spec.ts` exit 0（11 passed）。
- Scope 界定：本切片仅 divider 索引局部优化；未解决 full grouping / render layer 重建；不承诺任何性能提升。
 ## 10. 第四阶段：单次分页派生内共享 lazy group model（已实现）

 - 范围（最小切片，仅 `messageWindow.ts` 的 paginate 链路）：`applyWindowTransition` paginate → `derivePaginationWindow` → `canAdvancePaginationWindow`（over-capacity 时建 model）→ `expandOlderWindow` 或 `expandMessageWindowNewer`（又建同 messages model）。此前一次 over-capacity 的 derive 建两次同 messages 的 `createMessageViewportGroupModel`；现改为同一次 derive 操作内共享 lazy `getGroupModel`，最多一次建模；预检 reject 时（under-capacity fast path）零建模，`retention-exceeds-bound` decline 不再进 expand。遵照已有 `reconcileInternal` lazy 单 model 模式（`groupModel ??=`）。
 - 约束：private internal helpers 接 `getModel`（`PaginationGroupModelProvider`）；public legacy 签名与 intent shape 不变（不对外暴露可混不同 messages 的 model 参数，`expandMessageWindowOlder/Newer`、`canAdvancePaginationWindow` 保持原签名，内部各持单次 lazy provider 兼容 wrapper）。禁止跨 commit/module 缓存、`WeakMap`/new service、保存旧 entity 或结构 memo。预检与 expand 读同 messages 数组；guard 仍可 standalone（`Messages` preflight 在 await 前读旧数组，不能与 post-fetch paginate 复用）。directions/retained anchor/cap200/hasMoreBefore/After/groupRange/key/order 全部不变；不改 viewportController/Messages/restoration 分组语义、Main/IPC/DB 或 phase1 scheduler。
 - 测试意义：older/newer 达到容量边界、retained anchor 导致 reject 或 opposite-edge trim、同 askId 连续组不被切断；successive calls 同 IDs 但新 entity/status/blocks/askId 变化必须输出 fresh refs 与正确组（不跨 update 复用；Message 本体无 content 字段，以 `status`/`blocks` 为真实字段证据）；同调用 guard+expand 模型只建一次（1 条 Vitest spy 调用计数边界机制测试，`messageWindow.paginationSharedModel.test.ts`——明确结构验收，不扩散到全部 test implementation）；legacy helper 输出等价由 existing suites 复用。无可观察行为更改。
 - 新增直接证据（tests-only，本轮 production 零改动）：`messageWindow.paginationSharedModel.test.ts` 6 例——(1) over-capacity older 页 guard+expand 共享单 model（spy 计数恰 1，唯一一条实现计数断言）；(2) newer 容量边界 opposite-edge trim，同 askId 三连 assistant 同组不拆（`assistant:qa` 整组、`{50,249}`/200 组/order 全片反转等价、authority 原样）；(3) newer + retained anchor 触发 retention-clamped overshoot（`{10,249}`、`oldestMessageId m10` resident、trim 停在 held row）；(4) 同 IDs successive calls 新 entity：`toBe` 断言输出即新输入 refs（`status ERROR`/`blocks ['b9']`），askId 变更正确重分组（3 组 `[[u1],[a1],[a2]]`，无跨调用 cache）；(5) 空 committed 回退 newest-capacity 重建（`{5,9}`、无 `paginationTarget`、authority/flags/order 边界保持）；(6) retention 冲突 decline 只返回 reason、不碰 committed 窗口的 range/flags/order。结论仅限上述用例集合；不承诺性能与无回归。
 - 未做：更大 full-regroup/render-layer 未动；不做性能承诺。
 - E2E诊断与复验（test-only，未改生产/assert/timeout/growth/Enter→IPC）：原5spec/12用例run（windowed-message-reads、topic-scroll-save-restore、top-cross-route-provenance、window-grouped + streaming-responsiveness）exit 1，其中11 pass，唯一失败为本spec `independent anchors survive`在setup首个createNewTopic内`waitForAssistantResponseComplete`60s超时（第几个send未知，trace丢失未判new/flaky；Target closed为teardown次生）。诊断补足后的单用例control复现了同send路径的另一flaky：当前`uiSendMessage:81 toHaveValue`5s超时、value保持""（synthetic fill被renderer重渲染撤销），确证send路径存在可等待的ready-contract缺口。
 - 一次in-scope夹具修复（`uiSendMessage`为全文件共享helper，改后跑全文件4例）：bounded fill重试（同fill序列重做一遍，同`toHaveValue`断言最终重抛，不吞错）+ Enter后input清空acceptance gate（仍Enter dispatch）；`waitForAssistantResponseComplete`/`createNewTopic`超时catch在teardown关page前附`sendIndex/topicId/role-status/loading/blocks/textarea(valueLength only)`诊断经`test.info().attach`（best-effort，不掩盖原错；无content/API/凭据）。
 - 真实checks：`biome check`0、`typecheck:e2e`exit 0；生产build复用有效（`out/`mtime新于全部非测试build inputs，`find -newer`证实；本轮仅改`tests/e2e`）；修后全文件4 passed/1.7m exit 0。阶段最终生产门（主代理基线，本轮未重跑全量）：`pnpm test:renderer`全量674 files/8365 tests exit 0、`pnpm build` exit 0。
 - 剩余限制：原12-run的单失败仍记unexplained（control复现的是另一send-path flake，非同一超时证据链，不抹掉原记录）；未重跑全量12；本轮诊断attach在复验全过时未触发、线上有效性未经失败路径验证；无性能结论。
 ## 11. 第五阶段：同结构实体刷新的数据→视口交接（已实现）

 - 范围（最小切片，仅 `messageWindow.ts` 的 `reconcile` 链路 + 1 个窄测试文件）：流式纯 text delta 只改 blocks、新 block 引用/status/usage 改 message 实体引用时，loaded 投影的 id 序列与分组标识（role + askId，`getMessageGroupSemanticKey` 的唯一输入）完全不变。此前每次 reconcile 都走全量 `createMessageViewportGroupModel`（latest-edge 甚至建两次：一次 `getGroupModel` + 一次 `createLatestMessageWindow` 内建）。现以显式且局部的结构判定区分“仅实体刷新”和“需要窗口协调”：`reconcileInternal` 顶部新增 `tryRefreshWindowEntities`，同结构时用当前新 Message 实体刷新现有 `displayMessages`/`displayGroups`（保留 range/edge/capacity/authority/observability/anchor 语义），零 group-model 构建；任何协调意图或结构差异保守 fallback 到原完整路径。
 - 判定（缺任一证据即 null → 原路径，不把缺少旧全量结构证据视为相同）：
   - 控制意图门：`retainMessageId` 非空、`atPhysicalBottom === true`、`paginationTarget === true` 任一成立即 fallback（retention/follow/target 仍由原推导拥有，不被吞掉）。
   - Hold-release 门（latest-only）：`edge === 'latest'` 且 `newestMessageId !== messages` 尾 id 即 fallback。前一轮 retention 可把 latest 窗口 park 在 tail 之前；hold 释放后的同 ids 实体提交必须回到原 `createLatestMessageWindow` 重切 newest-capacity（`hasMoreNewer=false`），不得永久保留旧区间。尾部由已提交 newest 行与同结构尾 id 比对证明，不读 `hasMoreNewer` flag（`authoritativeHasMoreAfter=true` 的 tail 窗口该 flag 同样为 true）。fixed-edge 浏览本就 off-tail，不在此门内。`followsAppendedTail` 已核实无需类似门：同序 id 蕴含首尾相同，append 不可能，且 bottom 输入已被控制意图门掉。
   - 全投影同结构证明：`messages.length === previousMessages.length`（append/delete 长短不一 O(1) 拒绝），逐位 id/role/askId 全等（reorder/replace/regroup 拒绝；askId 用 `?? null` 归一，`''` 与缺失不等——保守）。
   - Fixed-edge 完备门：`groupCount !== clampViewportCapacity(groupCapacity)` 即 fallback。原 fixed 推导会对欠容区间向 newer 补齐、对超容区间裁 older，只有满容窗口经同结构提交 provably 不变。简单门代价：全历史小于 capacity 的小话题上 fixed 窗口恒欠容、恒 miss（恒多建模，无语义变化；latest-edge 走行尾门不受影响）。其他分支已核：latest（tail 门）、retention（retain 门）、paginationTarget（target 门）、parked-tail expansion（需增长、同长不可达）、append 意图（独立函数未动）、空/零容（display 空门）。
   - 已有窗口证据（不造第二套生命周期，只读当前 committed window + 已有 previous 快照）：range 非空、display 非空、`displayGroups.length` 与 range 跨度一致；新投影建一次性 id→entity Map（调用内局部，不存旧实体；重复 id 即 fallback）。
   - 新实体一致性：displayMessages/displayGroups 逐 id 解析到新实体（缺失即 fallback，覆盖 route switch/rebase）；每组成员的新实体 semanticKey 与存量 `group.semanticKey` 全等、首消息 key 重算全等；display 与 groups 行集合双向包含（防错位）；刷新后 display 顺序必须恰为 groups chronological 展平的 newest-first 反转（与全量重建输出顺序同一契约）。
 - 输出：`{ ...currentWindow, displayMessages, displayGroups, oldest/newestMessageId }`（id 不变故首尾 id 值不变，重算仅为诚实），`followsAppendedTail: false`（同序 id 蕴含首尾相同，append 不可能；且 bottom 输入已被门掉）。`Messages.tsx`/viewport reducer 零改动：reconcile effect 原有 `areMessageArraysIdentical` + 引用比较即会应用新窗口（新实体引用天然不等），`window/apply` 原样提交。
 - 测试（`messageWindow.entityRefresh.test.ts` 15 例，沿用切片 4 的 `vi.mock('../messageGroups')` 计数 instrumentation）：1 条结构验收断言同结构 reconcile 零构建（blocks/status/usage/folded/modelId 均为新引用，range/edge/capacity/flags/observability/keys 全保留）；fixed-edge 历史区间同结构零构建（窗内新引用、窗外变更不漏入）；`retention→release→entity update` 回 newest-capacity（held {2,11} 释放后同 ids 提交回 {5,14}/`hasMoreNewer=false`）；`underfilled fixed→同结构→{0,4}→{0,9}` 补齐；`cover-all 小 fixed` 恒 miss 代价锁定（输出一致、多建模）；`authoritativeHasMoreAfter=true` 的 tail latest 仍零构建；counter tests 只保护本次（append 挂载新尾、reorder 跟新序、askId/role 改重分组、delete 重切 newest-capacity、held 行保留 resident、physical-bottom 上报 follow、paginationTarget 保留目标、不可解析提交重建、空提交重建——全部走原路径且行为正确，避免实现镜像测试）。
 - 可验证的结构收益（测试锁定，非性能承诺）：同 ids 同 role/askId 的纯实体提交模型构建为 0；其余输入一律沿原完整路径，既有行为不变。无新全局 cache、无新 authority、无跨 commit/module 状态。冻结态最终验证（worktree exactly dirty 三文件，HEAD 315da9f7ee）：`pnpm test:renderer` exit 0（225 files / 2952 tests，含 entityRefresh 15）；fresh `pnpm build` exit 0；`pnpm test:e2e tests/e2e/specs/conversation/windowed-message-reads.spec.ts tests/e2e/specs/conversation/streaming-responsiveness.spec.ts tests/e2e/specs/conversation/topic-scroll-save-restore.spec.ts` exit 0（10 passed = 5+1+4）。无任何 performance measurement（延迟/吞吐/fps/内存/jank 均未测，不声称）。保守取舍：全历史小于 capacity 的小话题上 fixed 窗口恒欠容、恒 miss（恒多建模、零语义差），以语义不变换零优化遗漏；latest-edge 行尾门不受影响。
 - 转换测试：`retention→release→entity update` + `underfilled fixed→同结构→{0,4}→{0,9} 补齐`（旧实现零构建保留旧区间，已反证失败）+ `cover-all 小 fixed` 恒 miss 代价锁定（输出一致、多建模）。既有满容 fixed/latest 零构建保持。
 - 转换测试：`retention→release→entity update`（held {2,11} 释放后同 ids 提交回 {5,14}/`hasMoreNewer=false`；旧实现零构建保留旧区间，已反证失败）+ `authoritativeHasMoreAfter=true` 的 tail latest 仍零构建（门是行身份判定而非 flag 盲判）。
 - UI 证据（不新增资产）：本切片无渲染外观变更（同输入下新旧路径输出同一投影内容），Decision A 由上述 Vitest 行为 + 计数证据覆盖；Decision B 明确拒绝新 E2E 资产——复用既有 `conversation/windowed-message-reads`（5 passed，视口正确性）+ `conversation/streaming-responsiveness`（1 passed，流式实体刷新渲染）+ `conversation/topic-scroll-save-restore`（4 passed，恢复语义），冻结态合跑 exit 0（10 passed），覆盖本切片交接面，无需新资产。
 ## 12. 第六阶段：单次局部 render plan 收敛 grouped→segments→layers→nodes（已实现）

 - 范围（最小切片）：新增 `src/renderer/src/pages/home/Messages/messageRenderPlan.ts`（唯一生产装配：rows 单次派生 → message id→group 索引 → segments → layers → context key → reference placements）；`Messages.tsx` 接入（`useTopicSegments` 只读 `segmentsForTopic` 实体序，不改其行为；单次 `useMemo` render plan 替代原 segments/layers/context/reference 四个 memo；`renderMessageSegments` 内调 `buildMessageFlowNodesFromPlan`，`buildMessageFlowNodes` 不再每 render 求值）；`messageRenderLayers.ts` / `messageFlowNodes.ts` 改为 thin delegates（全部旧导出保留，委托统一 pure 算法，无第二套生产实现；fork 单次 Map 索引与 relation/headLoaded/createdAt-anchor-parent 排序/placement/末尾一次 reverse 原样保留）。非目标未动：viewport/reconcile/authority IPC/DB/stream 调度/Markdown/外观。
 - 收敛掉的生产重复装配：每组多次 `deriveStableGroupId` 编码、每组 3×`segment.find`（membership/first/last）、context/reference 逐层扫描已有组 id。现每组恰一次 identity/live/selected/segment 归属/first-last/ownership/fold 行派生（`useMemo` 已有派生允许，不增跨更新模块 cache/global state/存旧 entity）；flow 只消费行结果。仍允许必要的分段/分层少量线性 pass，未为强行单 loop 做补偿链。
 - 契约保持（测试锁定，非语义更改）：stableLayerId 由最老组身份算；stableSegmentId/groupId 完整长度前缀编码逐值相等；legacyKey 只做 divider 语义（调和仍用 stableGroupId）；data-layer-kind/data-stable-group-id/data-layer-run-id/context-boundary/context-legacy-key/boundaryKey 格式与全部 id、turnAskId、fold `every(folded)` 保留 run 均不变；segment 快照用 `segmentsForTopic` 实体序（非 sortOrder）；membership 按 `includes` 首匹配、first/last 按独立边界 id 查、三者可不一致/重叠，flow 每组首 message 定 segment、首/尾分别定 flags，missing→undefined/false；grouped newest-first 与 displayGroups chronological 不换序；context 首命中含 boundary id 组、无 resident 则 null；message id→group 索引 first-write-wins（newest 组胜）；reference 优先级链不变（missing→beginning ＞ resident boundary→after-boundary ＞ 可证 foreign→owned 相邻 transition→after-boundary 否则 null ＞ 无 foreign→beginning；深层仅 resident 否则 defer；空 topicId 不算 foreign/owned；transition 按原 newest→oldest 遍历/所有权判据单次预计算 + 索引查 boundary）；多 divider 保持输入序；boundary flush selection turn run，不跨 boundary 合并；injectors/typed contracts 不暴露 Node。DOM 顺序：context DOM-before anchor、fork DOM-after anchor、beginning 置顶、节点末尾 reverse 一次；`renderEditFlowNodes` 按 turn-run 包 `EditTurn`（divider 处断 run，非编辑模式无 cover）。
 - 成本减少（测试计数锁定，非性能承诺）：identity 恰每组一次（`deriveGroupId` 可选 seam 计数 = 组数）、segment membership 零 `includes/indexOf/find/filter` 扫描（Proxy 计数 = 0）、liveness 恰每组一次 `some`、context/reference 复用索引与预计算 transition/flags；行为测为主（旧 observable keys/order/tags/selected/live/fold、segment 首匹配、membership/first/last 重叠与分歧、未知 boundary、deep reference fallback/defer、first-write-wins）。
 - 最终验证（branch `jorkey/refactor/chat-lightweight`，基线 HEAD `0416ad8b81`，pinned Node 24.11.1 / pnpm 10.27.0）：新 `messageRenderPlan.test.tsx` 15 例 + 复用既有 7 文件（messageRenderLayers、messageFlowNodes.wiring/reference/forkDividerIndex、messageFoldSelectedShell、Messages.layers.mounted、forkDividers.displayedRoute）66 例，合跑 8 文件 81 passed；完整 `pnpm test:renderer` exit 0（225 files / 3239 tests）；`pnpm typecheck` exit 0；fresh `pnpm build` exit 0。中途修正均为新测试期望偏差（a1 关闭 seg-1 故 last/segmentIsLast 为真、emitter 构造期 newest-first 调用致 injector 对比按 stableGroupId 对齐、`EditTurn` 按 run 包裹致 DOM 期望补 edit-turn、budget 漏传 `deriveGroupId` seam、legacy 调用重复 `forkDividers` prop）及收尾死参 `_targetTopicId` 删除，生产行为与旧导出逐值一致，未改语义。oxlint 0 errors（死参删除后 warning 清零）；eslint clean；biome lint/format clean；`git diff --check` clean。
 - E2E（4 conversation specs，11 项，exit 1：7 pass / 4 fail）：`tests/e2e/specs/conversation/windowed-message-reads.spec.ts`（5）+ `topic-scroll-save-restore.spec.ts`（4）+ `top-cross-route-provenance.spec.ts`（1）+ `window-grouped.spec.ts`（1）。失败 4 项与独立 clean-parent（`0416ad8b81` detached 树，fresh build）对照运行同断言失败一致 → 记为已知基线（见下），未修；除此 4 项外本切片边界内未发现新增差异，不声称 E2E 全绿或无所有 regression。无 performance measurement；不新增 E2E 资产。
 - 已知基线（E2E 4 失败，后续独立修复用；clean-parent 同断言失败对照一致，与本切片无关）：(1) context 锚未出 window；(2) reference 来源删除后 status 仍 available；(3) chain reference order；(4) branch delete button 缺失。
 - 提交态：验证冻结 dirty 恰 6 文件（M `Messages.tsx`/`messageFlowNodes.ts`/`messageRenderLayers.ts`/本设计文档；?? `messageRenderPlan.ts`/`__tests__/messageRenderPlan.test.tsx`），`git commit --signoff` 为 `refactor(chat): unify message rendering plan`（用户授权提交到本分支，不 push）。
