# 聊天数据生命周期重设计（目标设计，可评审提案）

> 状态：**提案；未实施；不替代现有 ADR；本轮评审不能被解释为治理已批准。**
> 事实来源：分支 `jorkey/refactor/chat-lightweight`，短 HEAD `5ece868`（本文核对源码的固定基线）。
> 本次交付：仅本文档（纯文档交付，不实施代码、不改 ADR、不提交、不跑代码门禁）。
> 保留项：现有 `chat-lightweight-design.md`（dirty）与 `Chat.sharedContextSnapshot.test.tsx`（dirty）保持原样，本轮不触碰。
> 更新（路线 B 已实现，bounded slice）：§1 两条 hydration 写路径已退出，上下文展示改走 Chat 级独立快照 +
> execution-owned overlay（详见末尾 §14 实施记录）；本文提案正文不改，仍不替代 ADR、不构成治理批准。

## 0 读者指南

不读聊天记录的人可按此顺序理解本文：§1 问题 → §2 目标模型 → §3～§6
核心机制 → §7 删/留分阶段表 → §8 治理澄清 → §8A 成本纪律 → §9 迁移与
回滚 → §10 验收 → §11 验证计划（本轮不执行）→ §12 未决问题。§13 为源码索引。

本文约 300 行篇幅，不复制旧设计文档的历史章节，不写成实现 TODO 罗列。
凡写“已存在”的都是基线事实；凡写“提案”的都是尚未实现、不得引用为已落地的内容。

## 1 问题：UI 上下文走了两条 hydration 写路径

当前 UI 上下文链条（基线事实）：

1. `useContextClosure` 取回整包 closure 后，把内容 hydration 写入**普通**
   `messageBlocks`，再把整包记入 cache（`useContextClosure.ts:253-276`）。
2. `useContextWindowAnchor` 是第二个 hydration 入口（`useContextWindowAnchor.ts:208-241`）。
3. `contextClosure.ts:238,413-433` 的 cache 存的是完整 response。
4. `Chat.tsx:167-192` 按 closure roster → live `messageBlocks` selector →
   snapshot → shared context 重新装配。
5. `contextInfoService.ts:374-409` 的 roster/meta 取 closure，body 取 live
   snapshot；`Inputbar:193-200` 的 token 估计共享同一 snapshot。

后果有三：

- **同一权威内容在 renderer 有两个具象**：closure 整包与普通 blocks 互为镜像，
  还需要 `full / v-gapfill` 覆盖保护去弥合两者漂移。
- **流式写入与 closure 上镜同表**：`updateOneBlock`（流 mirror）与 closure
  `upsert` 落同一普通 block 表，才需要 `contentGeneration / contentMirror /
  readOnly / full-v-gapfill` 等多类安排来区分“谁在写”。
- **请求与展示耦合**：provider 实际请求本可用 caller-local 直读，却与 UI
  展示共用同一份可写 cache，展示失效策略会牵连请求正确性。

以下两项**不是**待造能力，本轮不许重造（基线事实）：实际 provider 请求已是
caller-local `fetchContextClosure + overlay` 固定路由、独立 viewport
（`ConversationService.ts:147-190`）；每生成独立 state，`loaded` 只 gate
Redux 镜像，unmount 只是 UI 行为（`BlockManager.ts:61-126`）。

## 2 目标模型（六条，已推荐，待评审批准后才可实施）

1. **三类分离**：持久事实归 Main；单次执行归执行所有者；按用途的读取结果
   分为 window / context presentation / caller-local request，各自生命周期。
   所有权、路由、锚点、原子可见性、取消语义保持现有；**不搬 aiCore 到
   Main，不引事件溯源、全局总 store、跨设备协议、新 feature，不更改身份治理**。
2. **Main read 在单事务内**提供内容 + 原有 completeness / capability +
   可比较的 authority stamp（提案，非已有实现，见 §3）。
3. **Main committed mutation 发布 change envelope**（提案，见 §3），事务成功
   才发布，rollback 不发布；事件只是失效提示，不是第二权威。
4. **ContextPresentation**（提案名，见 §4）：独立 Chat 级内存读取结果，
   不进普通 messages / blocks slice，不能用作 provider 请求。
5. **稳定事实 snapshot + 显式 generation overlays**组成只读展示（见 §5），
   只叠加当前 route accepted 成员的内容/状态。
6. **provider 实际请求继续 caller-local Main direct closure + BlockOverlay**，
   与 UI presentation 不复用 cache（见 §6）；above-anchor / folded
   exclusions 等请求语义保留。

## 3 读取戳与变更通知（均为提案）

### 3.1 authority stamp

- 初步方案：`database-open epoch + topic change epoch`。
- 结构 epoch 与内容 epoch 是否分开：**未决，需取证**（见 §12）。
- 第一版允许**粗粒度保守失效**，但不能默认“每 token 全闭包重读”。
- stamp 是**进程内失效坐标**，不是 schema / sync cursor / 持久版本 /
  跨设备版本；进程重启、数据库替换、恢复必须换 epoch；multiwindow
  不比较 renderer 自产 counter。
- 数据 revision 只判数据新旧，**绝不替代** route request supersession、
  deletion tombstone、DOM epoch 各自的职责。

### 3.2 change envelope

- 内容：committed stamp、受影响 topic（或明示 `unknown` broader scope）、
  变化类别、原 ack payload。
- **事务成功才发布，rollback 不发布**；no-op 语义写清：允许保守通知，
  不假称恰一次（at-most-once 式的诚实表述，不是恰一次保证）。
- 与 IPC 回执是**同事务事实**；事件为失效提示，不构成第二权威。
- 自己发起的 write：ack 与 notification **不能两次推进本地状态**（去重规则
  是实施关卡）。
- stream 批量合并通知；内容 delta 优先本地执行更新；外部内容变化可后台
  重验，**不以每 50ms 写重读全 closure**。
- 未覆盖的 unknown mutation：保守全域 invalidate，或禁止声称覆盖 complete。
- Main canonical route affects descendants / ref topics：**不能只失效 owner**；
  affect index / 保守 topic 集合的界定是实施关卡，不在本文假定已解。
- 本 change 机制**先限定 UI context consumer**，不要求一次迁完所有窗口/guard。

### 3.3 订阅 + 读防 lost wakeup

- 先建立 observer 再读；或订阅握手 + 读取重检：读期间若出现较新 change，
  则丢弃/重读。
- 不用定时轮询证明一致；事件乱序、重复必须容忍。

### 3.4 写路径覆盖关卡（基线缺口，实施前必须补）

mutation 样本结论**仅限样本**：append ack 只有
topic / branch / message / created / mutable；流 blocks 写 response 为 void；
delete 有 ids / branches / segments；`closureInvalidationMiddleware`
（`store/index.ts:573-623`）经 action meta 处理，route / deletion / content
generations 多为 renderer 本地。**此结论限样本，不说全库不存在 revision**；
`catalogRevision / resendAttempt` 不是 commit version。

`import / replay / sync` 可能写 Main（`importTopicData`、clipboard replay
等量级入口），**未完成全部写入口枚举**，必须设为 authority change 机制
实施前的覆盖关卡：枚举不完，不得声称“全部 mutation 已纳入通知”。

## 4 ContextPresentation（提案名，非自动批准的新完备性能力）

- 定义：独立 Chat 级**内存读取结果**，内容 = topic / route / anchor identity
  + authority stamp + accepted full closure snapshot（含 blocks，以支持
  token estimate）+ 必要派生信息。
- 禁止项：不能是第二聊天权威；不能用作 provider 请求；不进普通 messages
  或 blocks slice。
- 有界性：仅当前 / 明确有限 retained；离开清理；**取消挂载不能终止
  generation**（unmount 是 UI-only，见 §1）。
- 失效分两类：
  - **数据需重验**：同 route + anchor 下 pending 仍可保留 accepted，后台重验；
  - **用户不可再消费**：identity change / invalid / delete 按 ADR fail-closed。
- 同步要求：高亮、count、divider、estimate 消费**同一 accepted model**；
  模型 / system prompt 变化时，从同一正文快照重估，不另取一份正文。
- Token 估计的充分性（基线事实）：`TokenCount` 标量 / anchor divider IDs
  足够做标识，但 token 估计必须用选中上下文的**完整 text / reasoning /
  files / images + assistant.prompt**（`TokenService.ts:109-139`、
  `usePromptTokenEstimate:37-48`）；不存在“摘要就够”的承诺。

## 5 只读展示：稳定 snapshot + overlays（提案）

- 稳定事实 snapshot 与显式 generation overlays **组成**只读展示；
  overlay 只叠加**当前 route 中 accepted 成员 blocks 的内容/状态**，
  不自行新增/删改成员、分组、折叠、boundary；变化成员需 Main 权威刷新。
- overlay 来源是 execution-owned 可订阅快照。现状：当前 state 已存在，
  但**尚无给 context 使用的稳定 subscription / delta 接口**；新增 adapter
  有成本，必须写清楚，**禁止称已实现**。
- overlay 寻址：per-attempt monotonic seq + 固定 route + stable id；
  **不能读全局 store 推断 overlay**。
- 终态规则：原子终态 ack 的 stamp 确认 snapshot 已含该 attempt 末态，
  才撤 overlay；失败保留错误状态 / revalidate，不先撤造成回闪；
  迟到旧 snapshot 不盖新 delta；多生成隔离，不以时间戳排序。
- 跨窗口边界：跨窗口执行 overlay **当前无传输保证**；允许仅本地当前既有
  执行可用 overlay，其他窗口靠持久数据重验。体验边界与“是否需新保证”
  由后续产品决定，本文不预设。
- 内存预算：**尚无 proof 证明 overlay 收益大于重复 body 内存**；memory
  budget 须先量后接受，不用虚构数字（见 §11 隐私约束）。

## 6 请求路径：保持 caller-local，不复用 UI cache

provider actual request 继续 caller-local Main direct closure +
BlockOverlay（基线，`ConversationService.ts:147-190`），与 UI
presentation **不能复用 cache 作实际请求**。request above-anchor /
folded exclusions 等语义保留。这一条是“不改项”，列在这里是为了让
评审人确认展示重构不会牵连请求正确性。

## 7 删除 / 保留表（诚实分阶段）

第一切片（本提案实施时可动 Kath 的范围）与非本切片的界限必须诚实：

| 项目 | 本切片 | 说明 |
|---|---|---|
| UI `useContextClosure` 对普通 blocks 的 hydration 写入 | 可删 | 该 consumer 路径退出后不再需要 |
| anchor 第二 hydration 入口对普通 blocks 的写入 | 可删 | 同上，同一 consumer 路径 |
| Chat context 从普通 block selector 重新装配 | 可删 | 改走 ContextPresentation |
| full / gapfill 覆盖保护 | 仅该 UI 路径内退出 | 不得声称全局删除 |
| `closureContentMirror / contentGeneration` 等 | **保留** | 其他 consumer 迁移/coverage 未证明前留 |
| route / deletion / request / DOM guards | **保留** | 职责不同，不互相替代 |
| `Chat.sharedContextSnapshot` 现有 tests | **语义重写（实施时）** | 原 dirty 由用户保留，本轮不碰 |
| 其他窗口/guard 的迁移 | 不在本切片 | §9-D 视需要扩大 |

本切片**不是表层 UI 改动**，而是跨 process contract / read
representation 的变更，评审时按跨边界变更对待（见 §8）。

## 8 治理：表述待澄清，不自授 capability

- ADR projection `PROJ7 / I4` 禁止 caller-local 完整数据入普通 Redux；
  `§5 / §8 / §10` 允许 accepted shared UI result 并保留 background
  revalidation；但**没有直接规定 live body / readonly hydration**。
- 本文对此的立场只有一句话：**这是表述待澄清**——不能据此判现实现违规，
  也不能自授新 capability。
- 独立 UI 短寿命投影、完整性边界、有界保留及 epoch 政策，需在实施前做
  规范澄清；**若改行为，必须用户明确批准并修 ADR。本次不动 ADR。**

## 8A 成本纪律：三条路径比较（主代理判断）

本节是主代理给定的既定方向约束，不是本执行者自设：至少比较三条路径，
推荐以 B 先行验证，再以明确残余问题决定 C。本轮结果只是提案。

- **路径 A：继续局部收口**（已知不足）。在现有双 hydration / 同表镜像上
  继续打补丁：更多覆盖保护、更多豁免谓词。成本看似最小，但每次收口都新增
  一类“谁在写”的特例，与减熵目标背道而驰；展示与请求仍共用可写 cache，
  失效策略继续牵连请求正确性。**结论：不选为方向，只作基线对照。**
- **路径 B：先隔离 context presentation 快照/正文，不马上普及 authority
  变化机制**（推荐的第一切片）。复用既有刷新触发，把 §4 的独立读取结果做
  出来；陈述上仍残留本地 meta / generation（诚实残留，不假装干净）。
  最小可逆实验：只动 UI context consumer（§7 第一切片），回滚即回原路径，
  不碰 DB / schema。B **不声称**权威变化归属已经解决（见下）。
- **路径 C：authority-stamped reads + change envelope + presentation**
  （候选目标方向，非第一切片强制项）。跨 Main 写覆盖（§3.4 关卡）与
  execution overlay adapter（§5 成本）两项成本高；在写入口枚举完成、memory
  实测接受之前，**不把全 Main 变化基础设施设成第一切片的强制前置，
  也不设为既定实施承诺**；既定 C 契约作为候选目标设计保留在 §2～§5。

推荐顺序：**以 B 验证“共享实体表交汇”假设**——即“只要 context 展示不再写
普通 blocks 表，流 mirror 与 closure 上镜的同表交汇是否就消失”；再以 B
结束后仍明确残余的问题（未覆盖的 mutation、跨窗口一致性、adapter 真实成本）
决定是否进入 C。

- B 的诚实边界：规范遵循 / 安全 stale guards 在 B **仍须保留**（fail-closed、
  tombstone、request supersession 各归其位，见 §3.1）；B 的成功不得表述为
  “权威变化归属已解决”。
- 第一切片成功标准（补 §10）：除行为完整外，还须**有一组旧机制实际退出**
  （§7 表中“可删”三项在该 consumer 路径无残留），**不能与旧 consumer 长期
  双驱**；若实测 `adapter + body duplication` 成本大于退出收益，**停止扩大**
  （不进入 §9-D）。
- 动因一句话：避免为了减熵先叠加一套重基础设施——减熵本身不能先增熵。

## 9 迁移 A→D 与回滚（本轮不执行，只定顺序）

- **A（取证与澄清）**：确认写路径覆盖、受影响范围、ADR 澄清与 baseline
  evidence。非现在执行。
- **B（最小可逆实验，shadow compare only）**：先隔离 presentation 快照/正文，
  复用既有刷新触发；只比较元数据 / ID / count / 派生标量，**不写两份权威，
  不记录文本**（仍残留本地 meta / generation，见 §8A）。
- **C（切换主路径）**：新 presentation + execution adapter 切主，移除该
  consumer 的 hydration；**旧路径不能长期双驱**（双驱即双权威，回滚点不清）。
- **D（视需要扩大）**：验证后视需要扩大到 window；**不能默认平台全重构**。
- 回滚：UI consumer 可回滚到原路径而不碰 DB / schema。混版本契约二选一并
  在实施方案中写明：可选字段兼容，或一次性同仓更新；不允许“读了新字段却
  当没读到”的沉默兼容。

## 10 验收（acceptance）

“新增模块”不算完成。以下三条须同时成立：

1. 同能力下**原机制真正退出**（§7 第一切片的三项在该 consumer 路径无残留写入/装配）。
2. 无额外未解释的**全 route scans**。
3. 无**每 token IPC full read**（§3 已禁止以高频写重读全 closure 证明一致）。

## 11 验证计划（本轮不跑，只约定）

- unit（实施时）：snapshot / overlay / order / seq / terminal / rollback /
  noop / impact scope / lost wakeup、memory bounds。
- boundary-matched IPC / Main tests（实施时）。
- 现有相关 e2e：context-window / ordinary-chat / branches / stream /
  switch-back（实施时复用，不新建资产除非符合持久复用价值）。
- UI observe：按仓库 pinned runtime 观察（实施时）。
- 代码门禁：`typecheck / lint / test / build` 只在**实施时**按影响面跑；
  本轮纯文档交付不跑。
- 本轮文档交付只做：`git diff --check` + intended-status 检查 + 文档内相对
  链接可达性检查。
- 运行时收益未测，**禁止承诺性能**；后续 decision evidence 限 Named claim /
  counts / lifetime；隐私约束：不收正文、凭据、路径、DB 原始大小。

## 12 未决问题 vs 已推荐决策

已推荐（待评审批准）：§2 六条目标模型；§7 分阶段删/留界限；§8A 路径判断
（B 先行、C 候选）；§9 A→D 顺序；§10 验收三条（含 §8A 成功标准）。

未决（未知不包装为通过）：结构 epoch 与内容 epoch 是否分开（§3.1）；
affect index / 保守 topic 集合界定（§3.2）；execution adapter 的订阅/delta
接口形状与成本（§5）；跨窗口 overlay 是否需新保证（§5，产品决定）；
memory budget 实测数（§5，先量后接受）；写路径全枚举完成前不封口（§3.4）；
ADR 澄清措辞本身（§8，实施前规范澄清）。

## 13 事实来源与引用索引（文档相对链接）

- 请求 caller-local：`../../src/renderer/src/services/ConversationService.ts:147-190`
- 执行 state：`../../src/renderer/src/services/messageStreaming/BlockManager.ts:61-126`
- UI hydration 入口一：`../../src/renderer/src/hooks/useContextClosure.ts:253-276`
- anchor 入口：`../../src/renderer/src/pages/home/Inputbar/hooks/useContextWindowAnchor.ts:208-241`
- closure cache：`../../src/renderer/src/services/contextClosure.ts:238,413-433`
- Chat 装配：`../../src/renderer/src/pages/home/Chat.tsx:167-192`
- roster/meta vs body：`../../src/renderer/src/services/contextInfoService.ts:374-409`
- token 估计共享 snapshot：`../../src/renderer/src/pages/home/Inputbar/Inputbar.tsx:193-200`
- token 估计充分性：`../../src/renderer/src/services/TokenService.ts:109-139`
- 失效 middleware（样本结论）：`../../src/renderer/src/store/index.ts:573-623`
- 治理：`../adr/projection-completeness-authority.md`（PROJ7/I4、§5/§8/§10）、
  `../adr/context-window.md`、`../adr/topic-branches.md`、`../adr/chat-viewport-position.md`
- 保留的旧设计（dirty，不碰）：`./chat-lightweight-design.md`

## 14 路线 B 实施记录（bounded slice，已实现；提案正文不改）

- 范围：路线 B——上下文展示独立快照 + execution-owned overlay。不新增 Main
  authority stamps/events/schema、不动跨设备协议、不搬执行进程、不改 provider
  请求与模型规则、不改可见产品行为。
- 已退出：`useContextClosure` 与 `useContextWindowAnchor` 两处普通
  `messageBlocks` 闭包 hydration（upsertManyBlocks 发布）已退出，改为纯
  cache → anchor 持久；`Chat.tsx` 按 closure roster 重组 live Redux snapshot
  已退出，改由 Chat 级 `useContextPresentation` 承载显式 `blockSnapshot` +
  `sharedContextInfo`；`closureBlockHydration.ts` 及其专属 tests 已删除
  （无生产消费者）。
- 仍保留：closure 现有 cache 短期复用与结构失效 guard（generation/global/
  deletion/identity/anchor/route）；`closureOwnership` 标记与 middleware
  豁免谓词（`markClosureContentMirror`/`isExemptContentMirrorAction` 严格规则
  不变，命中即 no-op 返回：不 invalidate、不 signal、不写 clock）；普通
  Redux 块仍是 Messages 渲染源；请求路径仍是 caller-local
  （`fetchContextClosure` + request local overlay）；`contextCount`/CW 语义、
  请求/结构/删除/路由失效 guard 不变。`contextInfoService` 只增正文来源注释与
  `ClosureBodySnapshot` 别名，签名不变。
- 内容时钟退出（本 slice）：`contextClosure.ts` 的 `contentGenerations` 及
  `get/ensure/bump*ContentGeneration*` 已删除（生产读者为 0，唯一写点是
  middleware 豁免分支），§28/§30 曾用它作 hydration 模式信号的历史记录保留，
  不改写为“从未存在”；`resetAllClosureStateForTests` 不再清它（map 已不存在）。
- 执行适配：`fetchAndProcessAssistantResponseImpl` 在执行生命周期内注册
  overlay（固定 route + messageId + resendAttempt，per-execution monotonic
  sequence，`executionState.snapshot()` 不可变捕获）；`BlockManager`
  `notifyExecutionDelta` piggyback 现有节流/RAF（含 terminal 邻接直接写），
  无新 timer/RAF、无全表推断、无 wallclock 决胜（同类内注册序后者胜，
  active 优先于 retained terminal）。
- Handoff（无 Main stamp）：terminal Main 事务成功（含落盘 error/cancel）才记
  本地 checkpoint（monotonic ticket + ack 时 load generation）；仅当新已接受
  闭包携带 terminal 成员**且** cached generation 更新时 retire；旧 read 不撤、
  读期间新 delta 不丢、持久化失败不记点；无消费者时 terminal 正文释放，
  下次 read 走 Main 直接恢复；保留 ≤2 terminals/route（计数上限，非字节预算）。
- 治理澄清：`projection-completeness-authority.md` §10 追加一 bullet——已接受
  共享 UI 投影可在 Chat 级短生命周期有界内存保持整包正文（只读快照 +
  execution overlay），普通块不水合、非第二权威、非 provider 输入，
  background 保留/invalid fail-closed 不变，不新增完备性能力、不改
  authority/windows/cancel 保证。
- 测试（observable contracts，非镜像实现）：新增
  `executionOverlayRegistry.test.ts`（7：seq/通知、路由隔离、无订阅不捕获、
  handoff/旧 read 不撤/失败保留、supersession、有界 ≤2 + 离开释放、dispose）
  与 `useContextPresentation.test.tsx`（2：accepted 快照驱动计数/token +
  delta 跟随且成员不动、路由切换 fail-closed）；既有回归保留语义更新
  （`Chat.sharedContextSnapshot` 两场景意图保留、`ContentAdvance`、
  `B09Retention`、`AcceptedRetention`、`SemanticRefresh`、anchor/window/
  selector/routeIsolation/idlePreload 共 20 文件 171 用例全绿）。
  修改了因旧 hydration 机制而失效的断言（hydration 发布→不发布、源文本断言），
  未删功能测试。
- 验证（focused，非最终门禁）：`pnpm typecheck` exit 0；
  `pnpm native:run node -- vitest run <20 focused paths>` exit 0（171 passed）。
  未跑 lint/build/e2e 与 `verify:changed`（主代理后续）。
- 诚实 residuals（无收益承诺）：IM 通道执行路径（`messageThunk.ts` channel
  path）未接线；内存边界仅为保留计数上限，字节预算/memory 实测数无；
  C（Main 侧 invalidations）未动，B 仍是本地 invalidations；§12 未决项中
  “ADR 措辞”与“adapter 订阅/delta 接口形状”按本实现落定，内容 epoch 一项
  已落定（内容时钟退出，无分离 epoch；§12 提案正文不动）；其余未决（结构
  epoch、affect index、跨窗口 overlay 保证、写路径全枚举）不动。

## 14 补记：审阅修复与边界（F1/F2/F3；提案正文仍不改）

- F1 未知 checkpoint 一律 retain（`executionOverlayRegistry.ts`
  `tryHandoffAfterClosure`）：generation readers 在 ack 时未 ready（`genAtAck`
  为 -1/缺失）、ack-time 读取失败或返回无效 generation（NaN/负数）时，该
  terminal 条目没有任何 Main 排序证据——即使后续已接受闭包携带 terminal
  成员也不得提前 handoff。同样，无效/不可读的 cached generation 也不是包含
  证明，一律 retain。清理仍走既有规则（unsubscribe/route-leave 释放、prune、
  ≤2/route 上限）。reader 事后 ready 不回填该条目；只有携带有效 checkpoint
  的后续 ack 才能 handoff。回归覆盖
  `executionOverlayRegistry.test.ts` 新增两用例（reader 缺失全程 retain +
  reader 事后 ready 仍 retain；ack-time NaN 与 cached-undefined 一律 retain），
  且新用例显式安装空 seam（`{}`），不继承默认有效 stub——默认 mock 不得吞缺口。
- F2 普通非 stream 编辑边界：仍走既有 invalidate → background closure 重验后
  更新；同路由已接受投影保留直到权威结果到达（现行 ADR 语义），不恢复普通
  Redux block 订阅。无代码改动。
- F3 通道路径边界：`messageThunk.ts` `setupChannelStream` 无生产调用者，未接
   context overlay；仅在其导出注释说明 non-UI path 与未来统一 wiring 要求，
   未扩实际通道功能。无代码改动。

 ## 14 续补记：显式本地见证替代 lazy generation 读取（已实现；提案正文仍不改）

 - 替换事实：`executionOverlayRegistry.ts` 的 lazy `import('@renderer/services/contextClosure')`
   generation readers（`ensureGenerationReaders`、`getCachedClosureGeneration` /
   `getClosureLoadGeneration` 动态读取、test seam、lazy promise）已删除，不再存在。
   `recordTerminalPersisted` 只在实际 terminal 事务 ack 成功后记录本地 terminal
   token（per-execution sequence），不再读任何闭包 generation。handoff 改由读取方在实际
   `dbService.fetchContextClosure` / `resolveContextClosure` 调用紧前同步捕获的显式
   `TerminalReadWitness`（routeKey + 已完成 terminal 的 execution 身份/token）驱动；
   `useContextClosure` 与 `useContextWindowAnchor` 两处 issuer 经
   `executionOverlayReadReceipt.ts`（`WeakMap` exact response → witness，只存读元数据）
   捕获/绑定，`useContextPresentation` effect 只按 exact accepted response 取回并传入，
   不再从最新 cache 旁取任意 generation。未知/无 witness、读前 ack、读中 ack、失败/无效读、
   跨 route 一律 retain；成员未入 closure 不 retire；内存界限（≤2/route、无订阅释放）不变。
   这只是 renderer-local 顺序证明，不声称 Main commit revision，不作跨窗口保证。
 - 时态校准：§14 “Handoff（无 Main stamp）”段与 F1 段中“cached generation 更新 / genAtAck /
   reader 缺失/NaN”表述是当时的已实现记录，不改写为从未存在。本补记之后，handoff 的唯一
   排序证据是显式本地 witness；“无 Main stamp、无新 capability/schema/provider 变更”的外部
   保证不变，ADR 不改。
 - 测试：`executionOverlayRegistry.test.ts` 按显式 witness 重写（旧动态 import seam 用例改为
   missing-witness fail-closed；覆盖 read-before-ack、ack-during-read、cache-hit 配对原 receipt、
   stale/failed/invalid、route 隔离、双 attempt 同 messageId、multi-terminal token），新增
   `useContextClosureReadReceipt.test.tsx`（真实 hook issuer：绑定/happens-before/无效不绑/
   cache-hit 原 receipt）与 `useContextWindowAnchor.readReceipt.test.ts`（anchor resolve 绑定），
    cache-hit 原 receipt）与 `useContextWindowAnchor.readReceipt.test.ts`（anchor resolve 绑定），
    `useContextPresentation.test.tsx` 增补 receipt 配对 handoff/retain。

 ## 14 续补记：UI token 估算稳定历史按不可变快照复用（bounded slice；提案正文仍不改）

 - 范围：只动 UI token 预览的重复估算工作，不碰过滤语义、不碰请求路径、不碰
   authority/pending/count/boundary。`filterContextMessages`
   全过滤链（useful/error/adjacent/lastAssistant/empty/roleStart 的既有顺序与
   trailing-assistant 分流）原样保留；`estimateMessagesUsage` 与 provider 实际
   历史分支、`ConversationService` 不变；无 snapshot 的 legacy
   `estimateHistoryTokens` 行为不变（store 回退仍在）。
 - 做法：新增 `historyTokenEstimateSession.ts`
  （`createHistoryTokenEstimateSession` 纯工厂）：每实例只保留当前已选消息集的
   per-message 估算 promise/result。输入在同一调用内同步闭合——显式快照直接用，
   无快照时一次同步 store 读后即闭合成 caller-local `SnapshotBlockMap`，异步
   continuation 不再后读全局 map。每条目以“message 对象引用 + 按
   `message.blocks` 顺序的块实体引用（含缺失）+ `includeMedia`”判等复用；任一
   引用变化即整条按当前精确算法重估（不按追加字符串手算 token，tokenizer 非
   线性）。系统 prompt 每轮单独重估，不使 prompt 变化全 history 失效。
   `includeMedia` 变化使结果失效。空集只计系统 prompt。删除/filtered-out/路由
   切换清出 scope 条目，无全局 Map、无新常驻 LRU，条目数恒 ≤ 当前已选集。
   重叠 run 以 promise 同一性比较：旧 run 的迟到拒绝删不掉新 run 条目，失败不
   缓存可重试。hook 侧 `usePromptTokenEstimate` 在 `routeIdentity`
  （topic/branch/anchor）变化与 unmount 时 reset 会话，保留既有
   200ms debounce/requestId/cancel 语义；identity 只做会话边界，不构造 authority。
   `useContextPresentation` 的 `blockSnapshot` memo 不动（overlay 组合仍是 O(B)
   新 Map，诚实说明；会话复用不依赖 map 身份，只依赖块实体引用）。
 - 证据口径：只证明“减少重复估算工作”（per-message estimator 调用计数），不作
   延迟收益承诺——无 runtime 成本证明。O(selectedMessages) 身份检查仍在，全
   filter 每轮仍跑，不谎称总 O(Δ)。
 - 测试：新增 `historyTokenEstimateSession.test.ts`（首轮与 canonical
   `estimateHistoryTokens` 标量一致、次轮零重复、单条/单块/缺失→出现/
   text/reasoning/files/images 引用变化重估、`includeMedia` 失效、prompt 单独
   变化不碰 history、空集、删减裁剪与条目界、顺序不变复用、双 run 重叠旧失败
   不删新条目、拒绝不缓存可重试、store-once 回退等价）与
   `usePromptTokenEstimate.session.test.ts`（debounce/requestId、identity 切换
   全量重估、unmount 清理后重挂载重估、stale 不覆盖、includeMedia 透传）；
   既有 `usePromptTokenEstimate.test.ts` legacy 路径用例全部保留。
 - 残余：in-place mutation 风险经查不成立——Redux 经 immer 更新必换引用，
   `AssistantExecutionState` 的 `blocks.push` 操作的是 deepCopy 后的 request-local
   草稿（`executionState.ts` 构造即拷贝），UI 侧消息/块实体引用变化即可靠失效；
   file 缓存仍沿用既有 `fileCacheKey` 契约，未新增外部保证；overlay 高频 bump
   下全 filter 每轮仍全量跑，内存/耗时无实测数。

## 14 续补记：authority mutation 回执驱动的 context 失效（最小切片；提案正文仍不改）

- 范围（仅两条命令）：`chatdb:append-message`（普通 send 的 user/assistant stub、
  多模型 stub 批量、IM channel append）与 `chatdb:update-message-and-blocks`
  （普通 streaming 终态落盘；顺带覆盖直接编辑的同一命令调用者）。跨 Main /
  shared / preload / dataSource / renderer 同一契约，但**未**改其他
  FileCleanup 家族通道、**未**新增 IPC channel、**未**新增持久 schema、**未**
  引入 revision/event bus/新 sync 协议、**未**改 provider/request 语义、**未**
  触碰 ADR 锁定的产品规则。
- 契约（纯非版本 metadata）：`ContextInvalidationEffect = { scope: 'all' }`。
  `AppendMessageResponse` 增加 **required** `contextInvalidation`；
  新增 `UpdateMessageAndBlocksResponse extends FileCleanupResult` 并带同一
  required 字段（仅该 channel 用独立 validator，其余 FileCleanup 通道照旧，
  只显式拒绝这一新字段）。`scope: 'all'` 的语义是**保守的上下文缓存失效通知**：
  跨分支/引用的受影响范围尚未精确计算，因此所有已接受的 closure 都可能陈旧，
  renderer 必须重新向 Main 读取；它**不删除任何数据**、**不证明真的发生了变化**、
  **不承诺每条通知恰对应一次真实变更**。
- Main 口径：只在根事务成功结束后返回 envelope（`ChatDbAggregateService`
  append / update 成功返回），rollback / conflict / validation failure 一律无成功
  metadata（失败 envelope 不含 `value`）。missing-row no-op 也保守返回 `all`
  （通知而非证明）。`updateMessageAndBlocks` 返回类型为
  `ChatDbResult<UpdateMessageAndBlocksResponse>`。
- 严格校验：append 与 update 的 result validator 都要求该字段存在，且拒绝
  missing / malformed / unknown scope / unknown keys；request 形状不变。
- 回执消费位置（**恰一次**，且必须在权威成功后、任何本地 route-currency /
  loaded / projection guard 之前）：
  - append：`SqliteMessageDataSource.appendMessage` 在 `unwrap` 成功之后、
    `dispatchTopicUpdatedAt` 与任何 publication guard 之前消费一次
    （`consumeAppendAckInvalidation`）。所有生产 append 都经过这一个 typed
    adapter 消费点，thunk **不再**重复消费。
  - update：dataSource **默认不消费**（显式延迟给 ack 拥有者），由
    `saveFinalUpdatesAtomicallyForExec`（普通 execution，先
    `recordTerminalPersisted` 后消费）与 IM channel 终态 wrapper、以及
    `updateMessageAndBlocksThunk` / `removeBlocksThunk` / `initiateTranslationThunk`
    各自在权威成功后消费。Main 失败（`unwrap` 抛出或结构化 reject）**不消费**。
  - 顺序保证：普通终态的 closure 读取见证一定在 terminal token 之后发起
    （record → consume → 任何 projection dispatch 的既有顺序不变）。
- 投影侧去重（renderer 内部处理状态，非 Main authority）：新增单一
  `closureInvalidationHandled` meta 标记 + `AUTHORITY_HANDLED_ACTION_TYPES`
  白名单，middleware 只对「同一 ack 之后的收敛投影」跳过**推断式**失效
  （strict 的 content-mirror 豁免与 `closureReadOnly` 读取水合规则原样保留）。
  覆盖的动作家族：`applyAppendAcknowledgment` / `applyAppendAcknowledgments`
  与同一 ack 之后的 block upsert、终态 success 收敛的
  `updateMessage` / `upsertManyBlocks` / `removeManyBlocks` / `updateOneBlock`、
  以及 DB-first 直接编辑 thunk 的同 ack 提交。未标记/未迁移/流式中间投影
  继续 fail-closed 推断；`setTopicLoading` 之类 loading 标记不触发任何新全量失效。
- 覆盖边界（诚实）：IM channel 的 append/终态虽已消费回执，但该通道当前无
  生产 caller（window 未接线），不宣称「所有 channel 通用已迁移」。remote
  apply / multi-window push / import 等路径仍走既有推断式失效（本切片 bypass），
  未新增版本号或事件推送覆盖。
- 已知成本与局限：`scope: 'all'` 的全域失效频率高于未来的 scoped 方案（明确
  成本，不是性能承诺）；受影响范围未证明时不用「仅 owner」冒充全覆盖。去重只
  覆盖「同一 ack 的投影收敛」，不承诺跨事务/多阶段恰一次；user/assistant stub
  批量仍按各自 ack 保守各 bump 一次（不为「恰一次」追加全局去重 id 状态）。
  分支/引用受影响 topic 的精确范围计算仍是下一目标。
- 测试：shared 契约（append/update 成功必需 metadata、missing/malformed/
  unknown scope/unknown keys 拒绝、失败 envelope 无 metadata、其他 FileCleanup
  通道拒绝新字段且原较宽形状不漂移）；Main aggregate/ack（成功 effect、
  missing-row no-op、conflict 无成功 metadata）；renderer helper（
  well-formed / malformed 保守 bump / 非 ack 不 bump）；dataSource（append 成功
  恰好消费一次且与投影接受无关、失败不消费、update 默认不消费）；middleware
  与 content-mirror（同 ack 标记不产生第二次 semantic 信号、未标记仍推断、
  非白名单家族 fail-closed、scope-all 清空各 route）；append publication
  fail-closed（echo 不匹配不发布）；terminal success 投影均带标记（流式不标记）；
  既有 overlay registry / read receipt / send handover / lifecycle 回归保持通过。 审阅补测（本切片内关闭）：F1——两条迁移通道各一条 IPC 级用例，aggregate 回 ok:true 但缺 `contextInvalidation` 的回执经真实 handler 路径被 `validateChatDbResult` 拒绝，返回无 value 的有效 `STORAGE_ERROR` envelope；F2——`evicted mid-execution` 增 ordinary-exec 路径用例，以真实 `saveFinalMessageAndBlocksAtomically` + 真实 overlay + 真实 consume 按生产顺序 （persist → `recordTerminalPersisted` → consume → projection dispatch 前）驱动真实 `onComplete`，断言 token 先于失效、可捕获 read witness、无重注；生产闭包本身未导出，故未为测试新增架构接缝。
