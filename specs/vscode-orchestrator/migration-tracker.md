# VS Code Orchestrator 迁移追踪器 — 现态投影

> 任务专属现态投影；非通用标准。Git 拥有历史，本文档仅投影当前状态，原位更新；不作日志。

## 1 写作契约（原则驱动）

每项内容须自证准入；不满足即省略。无机械行/表/格上限：

1. 仅属其一：活跃决策/边界、当前可执行状态、下一步已授权方向。
2. 改变或约束当前决策/行动；否则不入。
3. 权威归源文档/代码/测试所有；本表仅链接，不抄写、不清单化。
4. 状态变更原位替换既有条目；禁止时序累积；历史以 Git 为准。
5. 已实现/Done 不设独立行；仅当解释仍 Open/Blocked 状态确需时，以精简上下文附于该活跃项，非归档。
6. 无活跃决策后果、无当前可执行后果、无权威来源或无明确移除/替换条件者，不可准入。
7. 可读性下降时，优先删重复/过期/已完成上下文并修复信息归属；不以压缩密文或另建归档/日志应对。

禁止：commit hash、验证计数/时长/exit code、命令输出、文件清单、转录/日志、完整历史/流水/归档表、重复治理文本、推测性 ready-now。

## 2 活跃决策与边界

- 本追踪器仅服务本次迁移任务，不扩展为通用流程/skill/command。
- 现态投影，原位更新；历史以 Git 为准。
- 不修改 `AGENTS.md`、skill、产品 ADR、架构文档、配置/源码/测试。
- 身份/持久化/迁移/多窗口决策以既有 ADR 为准；越界需治理决策。
- 文档持久化决策与方向，不作日志。

## 3 当前状态

| 域 | 状态 | 说明与存量上下文 |
|---|---|---|
| Phase 4 出口 | Open | 生命周期登记 + 单次分发已落地；可观测性仅覆盖驻留生命周期/读路径有界标量子集，非 Phase 4 完整闭环 |
| B-01..B-05 | Blocked 未采纳 | 待校准，阈值未生效；非 ready-now |
| S6.4/S6.5 | Blocked 未授权 | 候选，非 ready-now |

- Phase 4 存量上下文（附于 Open，非独立 Done 行）：B-06..B-09 renderer-local 已落地（视口/滚动/搜索/闭包）；B-01..B-05 未采纳待校准；可观测性为标量只读、无策略/持久化变更的生命周期/读路径子集。
- S6 存量上下文（附于 Blocked，非独立 Done 行）：S6.1-S6.3 已落地（窗口读/权威动作/闭包连接）作理解上下文；S6.4/S6.5 未授权。
- 驻留登记：renderer-local 非持久化（见 `docs/architecture.md` Redux `residentRegistry`）；证据以源码与测试路径指针为准，不列提交/次数。

## 4 下一步授权方向

- Phase 4 出口：仍 Open；不以性能绝对阈值为门槛。
- B-01..B-05：Blocked，需校准与决策后方可实现；当前非 ready-now。
- S6.4/S6.5：Blocked，未授权候选；需 ADR/证据门槛，不预设工作。
- 语义合批（本追踪器内局部约束，非通用工作流规则）：仅适用于本表已准入且独立已授权的 ready-now 条目在同一语义-风险边界内的合批；不得引入本表未列的新工作、不得绕过独立交付/授权/治理边界；当前无 ready-now 条目可合批。

## 5 规范引用

- [架构演进方案 Phase 4](../../docs/architecture-evolution-program.md#65-phase-4-bounded-memory-and-cache)
- [架构演进方案 Phase 6 切片](../../docs/architecture-evolution-program.md#67-phase-6-db-health-implementation)
- [架构现状 residentRegistry](../../docs/architecture.md#redux-store-srcrenderersrcstore)
- [上下文窗口治理](../../docs/context-window.md)
- [同步 MVP 边界](../../docs/sync-mvp.md)
- [架构演进方案 · 决策触发图](../../docs/architecture-evolution-program.md#10-adrdecision-trigger-map)

## 6 维护清单

- [ ] 每项 ∈ {活跃决策/边界, 当前可执行状态, 下一步已授权方向} 且改变/约束当前决策或行动
- [ ] 权威归源文档/代码/测试；本表仅链接，未抄写/清单化
- [ ] 状态变更为原位替换，无历史/流水/归档累积
- [ ] 已实现/Done 无独立行；仅作附于仍 Open/Blocked 项的精简上下文
- [ ] 无 hash/计数/时长/exit code/命令输出/文件清单/日志转录
- [ ] Blocked 未标为 ready-now；语义合批仅限本表已准入的独立已授权 ready-now
