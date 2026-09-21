# Cherry Chat 文档索引

> 本文档是 `docs/` 的总览与入口。文档按职责分为四类：`adr/`（当前持久治理决策）、`architecture/`（已实现现状，`architecture.md` 单文件）、`work/`（进行中的阶段性工作文档，扁平，当前仅一个活跃文档）、`archived/`（历史/只读，扁平只读参考，非分类体系）。除归档外，所有链接均为当前权威来源；归档不作为当前治理或实现依据。不设 `work/`/`archived/` 分类子目录。

---

## 目录结构

| 目录 | 作用 | 说明 |
|---|---|---|
| [`adr/`](./adr/) | 当前持久治理 ADR | 经批准的长期决策，跨实现稳定，修改需显式审批 |
| [`architecture/`](./architecture/) | 已实现现状 | 描述当前已实现的架构、目录、数据与 IPC |
| [`work/`](./work/) | 进行中的阶段性工作文档（扁平） | 扁平结构，当前仅一个活跃文档 `multi-device-sync.md`，不设分类子目录；阶段完成后移入 `archived/` |
| [`archived/`](./archived/) | 历史/只读（扁平） | 扁平只读历史参考，非分类体系；已冻结，仅供审计与追溯，不作为当前治理或实现来源；不设分类子目录 |
| `README.md` | 文档总览 | 本文件，索引与导航 |

---

## ADR — 当前持久治理（`adr/`）

| 文档 | 说明 |
|---|---|
| [`adr/cherry-chat-application-identity.md`](./adr/cherry-chat-application-identity.md) | Cherry Chat 应用身份、兼容边界、updater/发布冻结、平台范围 |
| [`adr/context-window.md`](./adr/context-window.md) | 稳定 topic 上下文锚点、允许的锚点迁移、兼容修复、持久化边界 |
| [`adr/model-metadata.md`](./adr/model-metadata.md) | 模型元数据与请求身份（serving vs canonical vs display、enrichment-only、精确查找、缓存边界） |
| [`adr/projection-completeness-authority.md`](./adr/projection-completeness-authority.md) | 已加载投影语义、类型化完备性能力、稳定 ID 导航/变更、调用者本地完整读取、请求级执行覆盖 |
| [`adr/sync-connection-channel.md`](./adr/sync-connection-channel.md) | 同步连接与通道目标语义（中继注册/通道/配对 `SYNC-CC-*`，未实现授权） |
| [`adr/sync-data-convergence.md`](./adr/sync-data-convergence.md) | 同步数据收敛目标语义（全量同步域 `SYNC-DATA-*`，未实现授权） |

---

## Architecture — 已实现现状（`architecture/`）

| 文档 | 说明 |
|---|---|
| [`architecture/architecture.md`](./architecture/architecture.md) | 已实现架构详表（主进程/渲染进程/Redux/AI Core/数据库/IPC/多窗口/tracing/技术栈/源兼容） |

---

## Work — 进行中的阶段性工作文档（`work/`，扁平）

> `work/` 当前为扁平结构，因目前仅有一个活跃工作文档而无需分类子目录。

| 文档 | 说明 |
|---|---|
| [`work/multi-device-sync.md`](./work/multi-device-sync.md) | 个人多端同步进行中工作文档（需求/目标与开发进展，个人自托管中继、操作日志 + 轻量 HTTP 中继，自动在线收敛与游标恢复为目标；有限验证、非生产就绪；完成后归档） |

> `work/` 为活跃的阶段性工作区，与 `archived/` 对应：进行中文档在 `work/`，完成后移入 `archived/`。

---

## Archived — 历史/只读（`archived/`，扁平）

> **历史/只读，扁平结构，不作为当前治理或实现依据。** `archived/` 为扁平只读历史参考，非分类体系，不设分类子目录。归档内容已冻结，仅用于审计、追溯与条件性回退参考；新工作以 `adr/`、`architecture/`、`work/` 为准。归档内的相对链接已修正为可解析路径，但保留原文历史措辞与状态，不重写实质内容。

| 文档 | 原路径 | 说明 |
|---|---|---|
| [`archived/architecture-evolution-program.md`](./archived/architecture-evolution-program.md) | `archived/architecture-evolution-program.md` | 架构演进计划历史归档（目标演进、质量、债务、阶段，终端状态 S7） |
| [`archived/performance-measurement.md`](./archived/performance-measurement.md) | `archived/performance-measurement.md` | 性能测量契约历史归档 |
| [`archived/performance-program.md`](./archived/performance-program.md) | `archived/performance-program.md` | 性能工程方法论历史归档 |
| [`archived/performance-workstreams.md`](./archived/performance-workstreams.md) | `archived/performance-workstreams.md` | 性能工作流历史归档 |
| [`archived/sqlite-migration.md`](./archived/sqlite-migration.md) | `archived/sqlite-migration.md` | SQLite 迁移治理历史归档（L1/L2/L3、ZIP 兼容导入） |
| [`archived/sync-architecture-selection.md`](./archived/sync-architecture-selection.md) | `archived/sync-architecture-selection.md` | 同步架构选型回退参考（条件性复用） |
| [`archived/sync-mvp.md`](./archived/sync-mvp.md) | `docs/archived/sync-mvp.md` | 同步 MVP 提案历史记录（保持不变） |
| [`archived/sync-powersync-spike.md`](./archived/sync-powersync-spike.md) | `docs/archived/sync-powersync-spike.md` | PowerSync 一次性实验历史记录（保持不变） |

---

## 已删除的旧指南

`docs/assets/`、`docs/en/`、`docs/zh/` 已删除。旧语言/开发/分支/赞助指南不再暴露；当前入口为本文档与根 `AGENTS.md`。
