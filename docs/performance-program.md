# Cherry Chat 性能优化项目（Performance Program）— 活性跨会话上下文

> **文档状态**：Active（活性程序上下文文档，非 ADR；本文件是性能优化工作的单一事实源）
> **最后更新**：2026-08-13
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

---

## 5. 测量契约（Measurement Contract）

所有测量必须满足以下契约，否则结果不进入基线：

1. **固定工具链**：Node 24.11.1 / pnpm 10.27.0（`.nvmrc` / `.node-version` / `package.json`）；任何 `pnpm` 命令前先核对 `node -v` 与 `pnpm -v`。
2. **Lane 契约**：`bench:*` 走 Node lane（ABI 137）；`test:e2e` / `ui:observe` / `build` 走 Electron lane（ABI 145）；结果必须标注所用 lane（AGENTS.md「Native ABI lanes」）。
3. **数据隔离**：基准使用确定性语料与临时数据库，不触碰用户数据（承接 `sqlite-runtime.perf.bench.ts` 的 LOCK-5.4.1；PRAGMA/schema 不指向真实 profile）。
4. **指标与报告**：p50/p95/mean、ops/sec 等数值指标 + 结构性不变量（正确性 parity、零 sibling UPDATE、原子性）。**正确性校验先于计时**，parity 失败即 abort（`search.bench.ts` 既定行为）。
5. **无历史对比值时显式报告**：不得虚构对照基线（`sqlite-runtime.perf.bench.ts` LOCK-5.4.2 声明无历史 Dexie 对比值，输出中显式报告）。
6. **阈值策略**：只有已提交的断言阈值可进入测试/基准 gate（当前唯一：冷库打开 `<500ms`，LOCK-5.4.3）；其余数值一律为**暂定预算**（§7），在重测并记录 artifact 前不当作事实。
7. **机器可读结果**：结果应以机器可读形式输出并存放到策略规定的位置；**大体积数据不提交仓库**。结果 schema 与存放位置策略由 PERF-001 定义（§16）。
8. **可复现性标注**：任何基线/证据必须伴随命令、环境（Node/ABI/lane）、日期与结果位置；无法复现的不进入基线。

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

---

## 7. 暂定预算（Provisional Budgets — 校准前）

以下为**暂定预算（校准候选）**，仅在对应测量按 §5 契约重测并记录 artifact 后才有资格成为基线；在重测前**一律视为未验证**，不得作为事实引用（PERF-LOCK-003）。

| 指标 | 暂定预算（校准前） | 来源 / 状态 |
|---|---|---|
| 冷库打开延迟（fresh open + pragmas + migrations） | `<500ms` | **已提交断言阈值**（`sqlite-runtime.perf.bench.ts` LOCK-5.4.3，L1 证据），保持为 gate |
| 消息加载（全话题 `listByTopic` + `listByMessages`）p50/p95 | 待校准（无已提交对比值；LOCK-5.4.2 声明无历史 Dexie 对比值） | 校准候选；PERF-002 重测后定 |
| 批量写入吞吐（batch message+block inserts，ops/sec） | 待校准 | 校准候选；PERF-002 重测后定 |
| 健康稠密话题追加零 sibling UPDATE | 结构性不变量（非数值） | 由 `c03a5c392c` 引入 dense-order fast path；结构性不变量已由已提交测试断言（`repositories.test.ts`、`aggregate.test.ts`），仅剩基准校准 |
| FTS 搜索（10k 语料 LIKE vs 混合 FTS）p50/p95 | 待校准（`search.bench.ts` 可报告，无绝对阈值） | 校准候选；数值需重跑生成 |
| 渲染 Markdown 解析节奏 | 150ms（提交内定值） | **代码事实**（`2aeb55760f`），非数值预算；交互可用性由 streaming E2E 验证 |
| 流式期间 UI 响应 | streaming-responsiveness E2E（滚动/输入不断流） | 集成契约验证（L1），非数值预算（LOCK-005） |

校准流程：PERF-001 建立结果策略 → PERF-002（提案）按 §5 重测既有基准并生成首批 machine-readable 基线 → 校准上表并更新状态。

---

## 8. 规模矩阵（Scale Matrix）

测量与基准必须声明规模级别；跨级别结论不得直接外推。

| 级别 | 规模 | 用途 / 边界 |
|---|---|---|
| **S0 单话题小规模** | 1 topic / ≤100 messages / ≤1000 blocks | 快速确定性回归（常规测试，LOCK-007） |
| **S1 典型** | ~100 topics / ~10k messages / ~20k blocks（暂定示意） | 常规基准规模（与 10k FTS 语料同量级，`search.bench.ts`） |
| **S2 大 profile（真实 artifact）** | 2707 topics / 129150 messages / 158441 blocks；最大字符串约 2.67MB（L2 真实导入 artifact，`sqlite-migration.md` 提交内证据） | 按需/定时基准（LOCK-007），不进入每次提交 CI |
| **S3 极限 / 压力** | S2 之上的放大，或极端长消息 / 长列表渲染 | 专项审计，需明确环境与机器配置 |

说明：S2 数值来自 `sqlite-migration.md` 记录的 L2 真实导入 artifact（仓库可验证的规模事实，非性能测量）；S1 为暂定示意规模，PERF-001+ 可校准。

---

## 9. 基线 0（Baseline 0）

**基线 0 定义**：性能优化工作的起点 = 以下三个已提交 commit。仓库可验证事实为提交内容及其随附测试/基准；**数值提升与验证通过仅存在于用户报告（§10），不属于基线 0 的已提交基准 artifact**。

| Commit | 标题 | 仓库可验证内容 |
|---|---|---|
| `c03a5c392c` | fix(chatdb): eliminate append and FTS streaming stalls | 稠密排序 fast path（追加零 sibling UPDATE）、批量分支克隆单事务、FTS rowid 稳定寻址、**migration 004**（normalized 投影稳定 rowid + parity preflight + 原子回滚）、startup diagnostics 有界计时；随附 `migration004.test.ts` 等测试 |
| `ad73468eb3` | feat(diagnostics): add bounded send and cold-path timing instrumentation | send/cold-path 有界计时（阶段名、时长、序号、非敏感计数、成败标记、不透明非敏感关联 ID；无内容/路径/凭据，对应 PERF-LOCK-006）；`packages/shared/diagnostics/sendTiming.ts` 等 |
| `2aeb55760f` | perf(renderer): keep UI responsive during streamed responses | 消息块订阅按属主消息收窄、Markdown 解析绑定 150ms cadence、完成时同步 flush；随附 fanout/cadence/race 测试与 `tests/e2e/specs/conversation/streaming-responsiveness.spec.ts`（fresh 生产构建） |

**基线边界**：基线与测量**仅引用已提交状态**。测量应在干净 worktree 或显式标注范围的 worktree 上进行；未提交工作树内容不计入基线，也不归属于本程序（§15）。

---

## 10. 历史证据 — 用户报告（Historical Evidence — User-Reported）

> ⚠️ 本节内容**全部为未验证的用户报告历史结果**（L4，§6）。它们不以任何方式代表当前可复现基线；引用前必须按 §5 重测。

- **内容**：用户报告基线 0 对应工作（§9 三提交）带来性能数值提升，且相关验证已通过。
- **绑定提交**：`c03a5c392c` / `ad73468eb3` / `2aeb55760f`（工作由这些提交承载；**数值本身没有 machine-readable artifact 提交到仓库**）。
- **复现性注意事项**：数值依赖当时环境（Node/ABI/硬件/负载）；无机器可读输出留存；未与当前 schema（migration 004 现状）核对；不可作为基线、验收或回归判定的依据。
- **程序立场**：本文件不含任何声称「已验证」的数值基线；在按 §5 契约重测并记录 artifact 前，一切数值视为未验证。数值基线从 PERF-002（提案）重测产物开始建立。

---

## 11. 持久化 Harness 清单（Durable Harness Inventory）

现有可复用资产（命令、文件、claim 边界均已在仓库内核实）。PERF-001 负责逐项补全/校验本清单（调用命令、输出位置、lane、claim 边界），并登记到 §14。

| Harness / 文件 | 命令（已核实存在） | Lane | 测量内容 | Claim 边界 |
|---|---|---|---|---|
| chatDb 运行时基准 — `src/main/services/chatDb/__tests__/sqlite-runtime.perf.bench.ts` | `pnpm bench:main:native`（Node ABI137；文件头另注明等价的 `npx vitest bench --run --project main-native …`） | Node | 消息加载 p50/p95、批量写入 ops/sec、冷库打开延迟 | 确定性临时库、不触碰用户数据（LOCK-5.4.1）；无历史对比值显式报告（LOCK-5.4.2）；仅 `<500ms` 冷开阈值断言（LOCK-5.4.3）；输出为 console 报告，**无 machine-readable artifact**（PERF-001 待解决） |
| 搜索基准 — `src/main/services/chatDb/__tests__/search.bench.ts` | 同上（`pnpm bench:main:native`） | Node | 10k 语料 LIKE vs 混合 FTS p50/p95 + 全分页有序 parity | 正确性 parity **先于**计时、失败即 abort；确定性 10k 语料；无 CI 绝对阈值；输出为 console 报告 |
| 渲染算法基准 — `src/renderer/src/pages/home/Messages/__tests__/Messages.bench.ts` | `pnpm bench:renderer`（Node ABI137） | Node | 消息列表倒序展示算法对比（baseline vs 原生索引倒序遍历） | 纯算法对比（vitest bench），非端到端；结论需结合 E2E（LOCK-005） |
| 共享 / aiCore 基准命令 | `pnpm bench:shared` / `pnpm bench:aicore` | Node | 现有命令入口 | 当前 bench 文件覆盖待 PERF-001 盘点 |
| 测量辅助 — `src/main/services/chatDb/__tests__/benchMetrics.ts` + `metric-helpers.test.ts` | 随 `pnpm test` / 基准复用 | Node | percentile/mean/opsPerSec/sum/sortTimings 数值计算 | 数值计算一致性有测试锁定 |
| 常规测试 — `pnpm test` | `pnpm test`（Node ABI137） | Node | 快速确定性正确性/结构性回归 | bench 文件**不进入**常规测试（`vitest.config.ts` 按 project 单独 `benchmark.include` 收集，LOCK-007） |
| Playwright E2E — `tests/e2e/specs/conversation/streaming-responsiveness.spec.ts` 等 | `pnpm build`（fresh 生产构建，Electron ABI145）+ `pnpm test:e2e` | Electron | 集成 UI 契约（流式期间滚动/输入等） | **集成 UI 契约的唯一回归证据**（LOCK-005）；标准 fixture（`tests/e2e`）+ mock provider；规范见 `tests/e2e/README.md` |
| UI 观察诊断 — `scripts/ui-observe`（`pnpm ui:observe`） | `pnpm ui:observe`（Electron ABI145） | Electron | 渲染/交互诊断观察 | 诊断性证据（L2），**非回归证明**；程序化使用走 `ui-verify-change` |

---

## 12. 工作流（Workstreams）

| ID | 名称 | 状态 | 说明 |
|---|---|---|---|
| **PERF-001** | Harness 清单与测量元数据整合 · chatDb 基准 migration-004 核验 · 机器可读结果策略 | **Active（下一可执行单元，§16）** | 不优化新的运行时路径 |
| **PERF-002**（提案） | 基线重测与暂定预算校准 | Planned（提案，未批准） | 在 PERF-001 完成后，按 §5 重测既有基准并生成首批 machine-readable 基线，校准 §7 |
| **PERF-003**（提案） | 用户影响驱动的优先级清单 | Planned（提案，未批准） | 按 PERF-LOCK-004 对候选热点排序，产出正式工作流提案 |

> PERF-002+ 仅保留稳定 ID 与方向草案，**范围未批准**；具体范围由 Main 在本程序推进时决策，并回写本表。

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
| R1 | 数值基线缺失（无 machine-readable artifact） | 无法判定回归 / 验收 | PERF-001 定义结果策略；PERF-002 重测并建立首批基线 |
| R2 | 环境漂移（Node/ABI/硬件/负载） | 基准不可复现 | §5 固定工具链与 lane；结果伴随环境元数据 |
| R3 | migration 004 后既有 chatDb 基准是否在当前 schema 上正确运行 | 基线失真 / bench abort | **PERF-001 核验**（parity 全过、冷开 gate 成立、无 abort） |
| R4 | 机器可读结果存放位置与体积策略未定 | 结果丢失 / 仓库膨胀 | PERF-001 定义（不提交大体积数据，LOCK-007） |
| R5 | 渲染性能除 E2E 外无可复现测量 | 渲染回归难判定 | L2 诊断 + E2E（LOCK-005/006）组合；必要时提案新增测量 |
| R6 | 用户报告数值不可复现 | 误作基线 | §10 显式标注 + §5 重测要求 |
| R7 | 诊断隐私边界 | 内容 / 凭据 / 路径泄漏 | PERF-LOCK-006 与 `ad73468eb3` 的 bounded 设计持续约束 |
| Q1 | 各工作流的 E2E 门槛分级（LOCK-005 已要求集成契约 E2E） | 成本 / 覆盖平衡 | 待 Main 决策 |
| Q2 | 大 profile 基准的触发方式（按需 / 定时）与承载位置 | 运行成本 | LOCK-007；待 Main 决策 |
| Q3 | PERF-002+ 优先级如何按 PERF-LOCK-004 落地 | 方向不清 | PERF-003（提案）产出优先级清单 |

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

## 16. 会话交接（Session Handoff）— 下一可执行单元：PERF-001

> 新会话（或任何接手本程序的会话）从本节开始执行，不需要回顾历史会话。

**目标（必须全部完成）**：

1. **整合/盘点既有 harness**：对照 §11 逐项核实每个 harness 的调用命令、所属 lane、输出位置、claim 边界，补全缺失项并登记到 §14。
2. **核验受 migration 004 影响的既有 chatDb 基准**：`search.bench.ts` 与 `sqlite-runtime.perf.bench.ts` 在 fresh 当前 schema（含 migration 004，`src/main/services/chatDb/migration.ts`）上运行——parity 全过、冷开 `<500ms` gate 成立、无 abort；记录输出与环境元数据（§5）。
3. **定义机器可读结果 schema 与存放位置策略**：约定结果文件命名/格式/位置，**不提交大体积数据**（PERF-LOCK-007）；输出不落仓库时明确承载位置。
4. **建立验收标准**：为上述产出（清单完整性、基准核验通过条件、结果策略）定义可判定标准，并回写本文件（§5/§11/§14/§12）。

**非目标（不得做）**：

- 不优化任何新的运行时路径。
- 不改架构、持久化、兼容、隐私语义（PERF-LOCK-008、§13）。
- 不把用户报告数值（§10）当作基线或验收依据。

**环境要求**：固定工具链（Node 24.11.1 / pnpm 10.27.0）；基准走 Node lane（ABI 137）；需要集成 UI 契约证据时走 fresh 生产构建 + Playwright E2E（Electron ABI 145，LOCK-005）。

**成功退出条件**：

- §11/§5 已更新（harness 清单核实完成；结果 schema/位置策略已定义并文档化）。
- R3 已关闭或已登记可复现的失败证据（§14）。
- 首个 machine-readable 结果 artifact 位置就绪（未提交大体积数据）。
- §16 交接段更新为指向 PERF-002（提案）或 Main 批准的下一个单元。

**参考**：§9（基线 0 提交）、§10（用户报告，只引用「存在」事实，不引用数值）、§7（暂定预算，校准候选）、migration 004（`src/main/services/chatDb/migration.ts`）、harness 文件（§11 表内路径）。

---

## 17. 变更记录（Change Log）

| 日期 | 变更 |
|---|---|
| 2026-08-13 | 创建本文件：基线 0 = `c03a5c392c` / `ad73468eb3` / `2aeb55760f`；决策锁 PERF-LOCK-001…008；证据层级 L1–L4；暂定预算（校准前）；规模矩阵 S0–S3；harness 清单；工作流表（PERF-001 Active）；PERF-001 为下一可执行单元 |
