# Cherry Studio Documentation / 文档

This directory contains the project documentation in multiple languages.

本目录包含多语言项目文档。

---

## Governance & Architecture

| Document | Role |
|---|---|
| [Architecture Evolution Program](./architecture-evolution-program.md) | Canonical architecture evolution program: strategic intent, approved locks, target qualities, debt registry, phased evolution, decision triggers |
| [Architecture Reference](./architecture.md) | Implemented architecture reference (current reality only; target state in the evolution program) |
| [Application Identity ADR](./cherry-chat-application-identity.md) | Identity, compatibility boundary, updater/release freeze, platform scope |
| [SQLite Migration Governance](./sqlite-migration.md) | SQLite chat authority, L2 Cherry Studio ZIP compatibility import, migration process |
| [Context Window Governance](./context-window.md) | Stable topic context anchor, allowed anchor transitions, compatibility repair, persistence boundary |
| [Performance Program](./performance-program.md) | Performance methodology entry (amplification-first, hypothesis-driven lifecycle, evidence principles) |
| [Performance Measurement](./performance-measurement.md) | Persistent measurement contract (toolchain, evidence hierarchy, schema v1, thresholds) |
| [Performance Workstreams](./performance-workstreams.md) | Current actionable performance state (open product problems, evidence, acceptance framework) |
| [Sync MVP Proposal](./sync-mvp.md) | Synchronization first-phase boundary (scope, data surface, open decisions) |
| [PowerSync Spike Plan](./sync-powersync-spike.md) | PowerSync disposable spike: No-Go conclusion, historical evidence, vendor-specific (not a target constraint) |

---

## Languages / 语言

- **[中文文档](./zh/README.md)** - Chinese Documentation
- **English Documentation** - See sections below

---

## English Documentation

### Guides

| Document | Description |
|----------|-------------|
| [Development Setup](./en/guides/development.md) | Development environment setup |
| [Branching Strategy](./en/guides/branching-strategy.md) | Git branching workflow |
| [i18n Guide](./en/guides/i18n.md) | Internationalization guide |
| [Logging Guide](./en/guides/logging.md) | How to use the logger service |
| [Test Plan](./en/guides/test-plan.md) | Test plan and release channels |

### References

| Document | Description |
|----------|-------------|
| [App Upgrade Config](./en/references/app-upgrade.md) | Application upgrade configuration |
| [CodeBlockView Component](./en/references/components/code-block-view.md) | Code block view component |
| [Image Preview Components](./en/references/components/image-preview.md) | Image preview components |

---

## 中文文档

### 指南 (Guides)

| 文档 | 说明 |
|------|------|
| [开发环境设置](./zh/guides/development.md) | 开发环境配置 |
| [贡献指南](./zh/guides/contributing.md) | 如何贡献代码 |
| [分支策略](./zh/guides/branching-strategy.md) | Git 分支工作流 |
| [测试计划](./zh/guides/test-plan.md) | 测试计划和发布通道 |
| [国际化指南](./zh/guides/i18n.md) | 国际化开发指南 |
| [日志使用指南](./zh/guides/logging.md) | 如何使用日志服务 |
| [中间件开发](./zh/guides/middleware.md) | 如何编写中间件 |
| [记忆功能](./zh/guides/memory.md) | 记忆功能使用指南 |
| [赞助信息](./zh/guides/sponsor.md) | 赞助相关信息 |

### 参考 (References)

| 文档 | 说明 |
|------|------|
| [消息系统](./zh/references/message-system.md) | 消息系统架构和 API |
| [数据库结构](./zh/references/database.md) | 数据库表结构 |
| [服务](./zh/references/services.md) | 服务层文档 (KnowledgeService) |
| [代码执行](./zh/references/code-execution.md) | 代码执行功能 |
| [应用升级配置](./zh/references/app-upgrade.md) | 应用升级配置 |
| [CodeBlockView 组件](./zh/references/components/code-block-view.md) | 代码块视图组件 |
| [图像预览组件](./zh/references/components/image-preview.md) | 图像预览组件 |

---

## Missing Translations / 缺少翻译

The following documents are only available in Chinese and need English translations:

以下文档仅有中文版本，需要英文翻译：

- `guides/contributing.md`
- `guides/memory.md`
- `guides/middleware.md`
- `guides/sponsor.md`
- `references/message-system.md`
- `references/database.md`
- `references/services.md`
- `references/code-execution.md`
