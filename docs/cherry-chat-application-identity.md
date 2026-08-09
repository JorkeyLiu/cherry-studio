# Cherry Chat 应用身份（Application Identity）ADR — 单一目标身份、兼容边界与退役记录

> **文档状态**：Approved。**Cherry Chat 是唯一目标应用**（LOCK-RETIRE-001）；**IDENTITY-001 已退役**（LOCK-RETIRE-002）：双 flavor 架构是已否决的临时工程决策，不再存在任何 Cherry Studio 目标 flavor 或内部 legacy 构建。Cherry Studio 仅作为**源格式 / profile 保护兼容域**保留（LOCK-COMPAT-003）。Phase A–C 的既有实现与验证为**历史证据**（flavor 架构下取得）；**退役后单一目标构建的打包产物与 packaged 身份/隔离 E2E 已在版本/构建身份实现（VERSION-001..005）落地后重跑并通过**（§9、§11）。本 ADR 是身份治理的单一事实源。
> **最后更新**：2026-08-07
> **Owner**：Personal fork（jorkeyliu）
> **分支**：`jorkey/integration`
> **关联**：`docs/sqlite-migration.md` 治理 L1（SQLite 运行时）/ L2（Cherry Studio ZIP 兼容导入）/ L3（Cherry Chat 备份/恢复）；**应用身份由本文档治理**，二者互补，不互改。`sqlite-migration.md` 第 41 行对本文档的交叉引用仍写「决策锁 IDENTITY-001…006」及其 flavor 措辞——该行是历史交叉引用，语义以本文档当前决策表为准（见 §2）。
> **仓库迁移治理（REPO-MIGRATION-001/002/003）**：当前仓库（名称/路径 `cherry-studio`）是**过渡性载体**——当前工作区/分支状态将被治理为一个新的 **Cherry Chat 仓库**，既有 Cherry Studio 仓库随后退役；源格式/profile 兼容标识（LOCK-COMPAT-003）不变。**创建/更名仓库本身不授权 updater/发布**（REPO-MIGRATION-002）；未来激活需显式审批的 endpoint 与协调变更（REPO-MIGRATION-003）。`electron-builder.yml` 的 `publish: null`（见 §2、§7）抑制 git-remote 推断，在 endpoint 获批前必须保持。

---

## 1. 背景与目标（Context）

个人 fork（jorkeyliu）是**未来独立 Cherry Chat 应用**的开发载体（与 `sqlite-migration.md` 顶层定位一致）。该迁移记录已覆盖运行时与数据层（L1/L2/L3）；**应用身份**是独立关注点：它决定 Cherry Chat「是什么应用、如何与既有 Cherry Studio 安装/数据安全并排存在、用户数据落在哪、更新走哪」——这些约束必须在实现开始前锁定，避免身份与数据层互相污染。

**已批准的完整退役（2026-08-07）**：核心实现移除了双 flavor 选择机制，将 Chat 身份并入默认/base 构建。因此：

- **Cherry Chat 是唯一目标应用**：产品名 `Cherry Chat`、appId `com.jorkeyliu.CherryChat`、协议 `cherrychat://`、独立 profile/home/temp、updater 禁用（LOCK-RETIRE-001）。
- **IDENTITY-001 是已退役的错误临时决策**（LOCK-RETIRE-002）：曾要求「保留默认 Cherry Studio 构建不变、以显式 Cherry Chat flavor 新增」，该路线已被否决并整体移除；不存在任何 Studio 目标 flavor，也不存在内部 legacy 构建。退役理由：双目标并行安装从未被完整验证（旧 AC-5），且同时维护两个目标身份使身份契约、打包路径与发布语义分裂；单一目标显著简化并消除该未验证分支。
- **Cherry Studio 名称仅保留于源格式 / profile 安全契约**（LOCK-COMPAT-003）：Dexie `CherryStudio`、redux/localStorage `cherry-studio`/`persist:cherry-studio`、ZIP/origin/schema/import 声明、受保护 profile 名——这些是兼容契约，不承担目标应用身份。

本 ADR 记录已批准决策与退役记录，不改变既有 SQLite 迁移记录的任何历史事实与 Phase 0–6 状态。

**仓库迁移（REPO-MIGRATION-001）**：当前仓库名/路径（`cherry-studio`）是**过渡性**的——当前分支/worktree 状态日后将成为一个新的 **Cherry Chat 仓库**，既有 Cherry Studio 仓库将退役。该迁移只改变仓库载体，**不改变**应用身份（§3）、源格式/profile 兼容标识（§6）、打包配置或任何锁定决策。仓库迁移本身**不授权** updater/发布（REPO-MIGRATION-002），也不自动继承或推断任何发布 endpoint。

---

## 2. 决策表（Decision Table）

| # | 决策 | 状态 |
|---|---|---|
| **IDENTITY-001** | ~~保留现有默认 Cherry Studio 构建与身份不变；以显式 Cherry Chat build flavor 新增，而非替换默认构建~~ | **Retired / Superseded**（LOCK-RETIRE-002）——错误临时决策，已整体移除；无 Studio 目标 flavor、无内部 legacy 构建 |
| **LOCK-RETIRE-001** | **Cherry Chat 是唯一目标应用身份**：产品名 `Cherry Chat`、appId `com.jorkeyliu.CherryChat`、URL 协议 `cherrychat://`、独立派生的 profile/home/temp、updater 禁用（替代并吸收原 IDENTITY-002 的语义） | **Locked** |
| **LOCK-RETIRE-002** | IDENTITY-001 为退役的错误遗留决策；无 Cherry Studio 目标 flavor，无内部 legacy 构建；构建期不存在 flavor 选择机制（`VITE_APP_FLAVOR`/`__APP_FLAVOR__`/`buildFlavor`/overlay 配置已全部移除） | **Locked** |
| **LOCK-COMPAT-003** | 保留源格式/兼容标识（原 IDENTITY-003 语义）：Dexie `CherryStudio`、localStorage `persist:cherry-studio`、ZIP/origin/schema/import 声明、受保护 profile 名——它们是兼容契约，不是目标应用身份 | **Locked** |
| **LOCK-UPDATER-004** | Cherry Chat 不得消费 Cherry Studio 的 updater/release feed；在独立 release endpoint 存在并获批前，updater 禁用或显式不配置（原 IDENTITY-004 语义） | **Locked** |
| **LOCK-PLATFORM-005** | 首期交付目标为 macOS arm64；Windows/Linux 身份落地推迟（原 IDENTITY-005 语义） | **Locked** |
| **LOCK-PROFILE-006** | 无自动磁盘扫描、无静默迁移、无共享 userData、不删除/修改既有 Cherry Studio profile（原 IDENTITY-006 语义） | **Locked** |
| **LOCK-RELEASE-FREEZE** | 独立 endpoint / 签名 / 公证就绪前，不做正式发布 | **Locked** |
| **LOCK-L3-COMPAT** | 既有 L3 备份/恢复归档 schema 字面量为兼容契约，除非另行版本化否则保持不变 | **Locked** |
| **VERSION-001** | **Cherry Chat 是唯一正式应用目标，版本/构建身份只围绕该目标治理**：不恢复 Cherry Studio 构建 flavor、fallback、overlay 或 legacy 构建路径（承接 LOCK-RETIRE-001/002） | **Locked** |
| **VERSION-002** | **产品版本为手动维护，起始 0.1.0，唯一来源是根 `package.json` 的 `version` 字段**；构建系统不自动改写产品版本 | **Locked** |
| **VERSION-003** | **每个构建自动生成唯一 Build ID**：一个捕获的 UTC 时间戳 + 短 Git SHA + 可选 dirty 标记；Git 元数据不可用时显式降级（不声称有效 SHA）。同一构建内所有消费方（electron-vite 编译 + electron-builder 打包）复用同一身份。含数字 macOS 构建版本（CFBundleVersion） | **Locked** |
| **VERSION-004** | **`app.getVersion()` 保持产品版本（0.1.0）；Build ID 是独立字段**，进入 App_Info 契约（`buildId` / `buildVersion`），不混入产品版本 | **Locked** |
| **VERSION-005** | **不因版本/构建身份引入发布基础设施**：updater 保持禁用，不新增 publish feed、release 工作流、打标签、提交或推送（承接 LOCK-UPDATER-004 / LOCK-RELEASE-FREEZE） | **Locked** |
| **REPO-MIGRATION-001** | **当前仓库状态将迁移为一个新的 Cherry Chat 仓库**：当前分支/worktree 状态日后成为新的 Cherry Chat 仓库；当前仓库名/路径（`cherry-studio`）是过渡性的；既有 Cherry Studio 仓库随后退役。仓库迁移是载体变更，不改变应用身份、源格式/profile 兼容标识（LOCK-COMPAT-003）或任何锁定决策 | **Locked** |
| **REPO-MIGRATION-002** | **创建/更名仓库（或变更 remote）本身不授权 updater/发布**：仓库迁移不使发布 endpoint 获批，不改变 LOCK-UPDATER-004 / LOCK-RELEASE-FREEZE 冻结 | **Locked** |
| **REPO-MIGRATION-003** | **未来 updater 激活必须使用显式审批的 endpoint**（预期仓库 namespace 可能为 `JorkeyLiu/cherry-chat`，但 owner/大小写未经用户审批前不锁定），并协调运行时（`updaterEnabled`）、release 工作流、签名/公证、渠道与回滚验证的同步变更；`publish: null` 在 endpoint 获批前必须保持 | **Locked** |

> 历史语义映射：IDENTITY-002→LOCK-RETIRE-001；IDENTITY-003→LOCK-COMPAT-003；IDENTITY-004→LOCK-UPDATER-004；IDENTITY-005→LOCK-PLATFORM-005；IDENTITY-006→LOCK-PROFILE-006。IDENTITY-001 无继承者，被 LOCK-RETIRE-002 取代。

---

## 3. 身份矩阵（Identity Matrix）

| 维度 | 目标应用（Cherry Chat，唯一） | 源兼容标识（兼容契约，不变） |
|---|---|---|
| 产品名 productName | `Cherry Chat`（`packages/shared/config/identity.ts` `appIdentity.productName`；`electron-builder.yml` `productName`） | — |
| bundle / app ID | `com.jorkeyliu.CherryChat`（`identity.ts` `appIdentity.appId`；`electron-builder.yml` `appId`；`scripts/notarize.js` `resolveAppBundleId()` 从 packager appInfo 动态解析） | — |
| URL 协议 | `cherrychat://`（`identity.ts` `appIdentity.protocolScheme`/`protocolUrlScheme`；`electron-builder.yml` `protocols`；`APP_PROTOCOL`，`src/main/services/ProtocolClient.ts`） | `cherrystudio://` 深度链接格式仍出现在 `urlschema` 处理注释/既有格式引用（LOCK-COMPAT-003），不注册为目标 scheme |
| home 目录 | `~/.cherrychat`（`identity.ts` `appIdentity.homeDirName`；`constant.ts` `HOME_CHERRY_DIR`） | — |
| userData / profile | 单一身份派生：默认 `<appDataRoot>/Cherry Chat`（`userData.ts` `resolveUserDataBase` identity-default；`init.ts` `initAppDataDir()` 在 bootstrap 早期应用）；dev 叠加 `Dev` 后缀（`config.ts` `applyDevSuffix`）；显式 `--user-data-dir=<path>` 优先级最高且逐字节保留（packaged/dev 均生效、dev 不叠加 `Dev` 后缀）；LOCK-PROFILE-006 守卫在最终 userData 上运行，保护 `Cherry Studio` 与 `CherryStudio` 两个默认 profile 名（`userData.ts` `CHERRY_STUDIO_PROTECTED_USER_DATA_NAMES` / `isCherryStudioDefaultUserData`，`init.ts` 拒绝守卫） | — |
| temp 目录 | `cherry-chat`（`identity.ts` `appIdentity.tempDirName`，BackupManager 备份临时根）；generic temp 字面量 `CherryChat`（`genericTempDirName`，历史默认，二者为不同契约） | — |
| Dexie 数据库名 | — | `CherryStudio`（`src/renderer/src/databases/index.ts` `new Dexie('CherryStudio')`） |
| localStorage persist key | — | `persist:cherry-studio`（redux-persist key `cherry-studio`，`src/renderer/src/store/index.ts`；L2 源 Local Storage 读取，`src/renderer/src/windows/chatImport/entryPoint.ts` `PERSISTED_STATE_KEY`） |
| 更新 / release feed | 禁用或不配置（`identity.ts` `appIdentity.updaterEnabled=false`；`electron-builder.yml` **`publish: null`**——显式抑制 git-remote 推断，无 `releaseInfo`；LOCK-UPDATER-004 / LOCK-RELEASE-FREEZE / REPO-MIGRATION-002/003） | — |
| analytics / UA / API 身份 | analytics channel `cherry-chat`、UA product `CherryChat`、API title `Cherry Chat API`（`identity.ts`；`generate-openapi-spec.ts` `resolveSpecIdentity()` 恒返回 `appIdentity`） | — |
| 首期目标平台 | macOS arm64（LOCK-PLATFORM-005）；Windows/Linux 推迟，不做平台承诺 | — |

> 无「默认构建」列：base 构建即 Cherry Chat（LOCK-RETIRE-001/002）。

---

## 4. 单一目标契约（Single-Target Contract，替代原 Flavor 契约）

- **单一身份，无选择分支**：身份输入（productName / appId / 协议 / home / temp / userData 派生 / 更新配置）集中定义于 `packages/shared/config/identity.ts` 的**单一不可变常量 `appIdentity`**，无 flavor 分支、无 fallback（`identity.test.ts` 断言模块不导出 `appFlavor`/`resolveAppIdentity`/`APP_FLAVOR_ENV_VAR` 等已退役 API 面）。
- **base 构建即目标**：`electron-builder.yml` 直接携带 Cherry Chat 身份（appId / productName / protocols `cherrychat`），无 overlay、无 `extends`、无 flavor 注入；构建/打包命令不选择 flavor（`electron-builder.test.ts` 用已安装 electron-builder 26.8.1 加载器验证 base 配置语义：appId/productName/protocols 精确锁定、`publish: null`（抑制 git-remote 推断）、无 release notes、schema 校验通过；并断言不存在 `build:chat*` 专用命令）。
- **退役的 flavor 机制（历史）**：`VITE_APP_FLAVOR` / `__APP_FLAVOR__` 编译期 define（`electron.vite.config.ts`）、`packages/shared/config/buildFlavor.ts`、`electron-builder.cherry-chat.yml` overlay、`scripts/build-chat-mac-arm64.ts` 及配套测试均已删除（LOCK-RETIRE-002）。`env.d.ts` 亦注明不再存在构建期 flavor 选择器。
- **源码兼容标识不参与身份**：Dexie `CherryStudio`、`persist:cherry-studio` 等按 LOCK-COMPAT-003 保留（§6），`identity.ts` 不携带任何 Cherry Studio 身份值（`identity.test.ts` 断言 `appIdentity` 序列化不含 `Cherry Studio`/`cherrystudio`/`com.kangfenmao`）。
- **共享常量派生自单一身份**：`APP_NAME`/`HOME_CHERRY_DIR` 均从 `appIdentity` 派生（`constant.ts`；`identity.test.ts` 锁定）。`CHERRYIN_CONFIG.REDIRECT_URI` 曾为同类共享常量（同样由 `appIdentity` 派生、由 `identity.test.ts` 锁定），该不变量已随 CherryIN 平台整体移除而退役：`CHERRYIN_CONFIG` 及其 OAuth 服务（`CherryINOAuthService.ts`）均已删除，本 ADR 保留此历史治理记录。

> **当前证据（config 层）**：`identity.test.ts`（单一不可变身份逐字段锁定 + 无退役 API 面 + 无 Cherry Studio 值）、`userData.test.ts`（`resolveUserDataBase`/`applyDevSuffix`/`isCherryStudioDefaultUserData`）、`init.test.ts`（16 个 `initAppDataDir()` 直连场景，LOCK-RETIRE-001/002 与 LOCK-PROFILE-006 全覆盖）、`electron-builder.test.ts`（base 配置经真实 electron-builder 加载器锁定）、`notarize.test.ts`（bundle ID 动态解析）、`openapi-spec.test.ts`（恒为 Cherry Chat 元数据）、`title.test.ts`（主窗口标题 seam）。打包层证据见 §9（退役后当前证据 + 历史证据行）。

---

## 5. 运行时隔离面（Runtime Isolation Surfaces）

| 隔离面 | 不变量 |
|---|---|
| userData / profile 目录 | Cherry Chat 的 userData 由单一 Cherry Chat 身份独立派生（默认 `<appDataRoot>/Cherry Chat`；显式 `app.setPath('userData', …)` 仅在 bootstrap/config/运行时 IPC 处按身份计算）；显式 `--user-data-dir=<path>` 优先级最高（Electron 在 JS 运行前应用，bootstrap 逐字节保留、不叠加 `Dev` 后缀）；最终 userData 经守卫拒绝 Cherry Studio 默认 profile（`Cherry Studio` 与 `CherryStudio` 双名保护，LOCK-PROFILE-006） |
| IndexedDB / localStorage | 位于各自 profile 内；数据库名 `CherryStudio` 与 key `persist:cherry-studio` 为源兼容契约（§6），隔离来自 profile/session 而非改名 |
| Session / partition | L2 导入沿用隔离 `session.fromPath()` 源 profile（sqlite-migration.md Phase 4 / A-8）；Cherry Chat 正常运行 profile 与导入源 profile 永不混用 |
| 协议注册 | `cherrychat://` 是唯一注册的目标 scheme（`ProtocolClient.ts` `APP_PROTOCOL`）；`cherrystudio://` 仅作为源数据/既有功能格式引用存在，不注册 |
| 更新 feed | Cherry Chat 不消费 Cherry Studio feed；updater 禁用直至独立 endpoint 获批（LOCK-UPDATER-004 / LOCK-RELEASE-FREEZE） |
| 应用产物 / 名称 | bundle ID、artifact 名、菜单/Dock 名均来自单一 Cherry Chat 身份（`electron-builder.yml` artifactName 模板 `\${productName}-…`） |

> **Phase A 落地（历史）**：userData 解析与拒绝守卫实现于 `packages/shared/config/userData.ts` + `src/main/utils/init.ts`（`initAppDataDir()`，由 bootstrap 在应用早期调用）；协议注册按单一 `cherrychat` scheme（ProtocolClient.ts）；updater 与 assistant release-feed 门（LOCK-UPDATER-004）。聚焦测试覆盖 16 个 `initAppDataDir()` 直连场景（init.test.ts）。
> **Phase C 落地（历史）**：显式 `--user-data-dir=<path>` 为最高优先级且逐字节保留（packaged/dev 均生效；dev 下不再叠加 `Dev` 后缀，config.ts）；LOCK-PROFILE-006 守卫在最终 userData 上运行，保护 `Cherry Studio` 与 `CherryStudio` 两个默认 profile 名（`CHERRY_STUDIO_PROTECTED_USER_DATA_NAMES`，userData.ts）；packaged E2E 在真实打包产物上验证隔离与真实 profile 零改动（§9 历史证据行）。

---

## 6. 源兼容例外（Source-Compatibility Exceptions，LOCK-COMPAT-003）

以下标识符是 **L2 兼容导入的源格式契约**，不是目标应用身份；不得因身份引入而改名或删除。

| 标识符 | 用途 | 证据 |
|---|---|---|
| Dexie 数据库名 `CherryStudio` | L2 导入源 IndexedDB 的识别与读取；现有 Dexie files catalog 运行时架构名（post-closure，LOCK-DOC-1） | `src/renderer/src/databases/index.ts`（`new Dexie('CherryStudio')`） |
| localStorage key `persist:cherry-studio` | redux-persist 持久化（key `cherry-studio`，version 217）；L2 源 Local Storage 导航投影读取 | `src/renderer/src/store/index.ts`（key）；`src/renderer/src/windows/chatImport/entryPoint.ts`（`PERSISTED_STATE_KEY`） |
| `cherrystudio://` deep link 格式 | 既有功能/源数据格式引用（navigate/providers/mcp-install），非 Cherry Chat 目标身份 | `src/main/services/urlschema/` 处理注释（LOCK-COMPAT-003） |
| 其他 L2 导入管线消费的源格式标识符 | 兼容契约（如源 IndexedDB file-origin 映射、投影格式） | LOCK-D2：`src/main/services/chatDbImport/importDataPlane.ts`、`tests/e2e/utils/disposable-dev-origin-seed-zip.ts`（`SEED_DB_NAME='CherryStudio'`、`SEED_PERSIST_KEY='persist:cherry-studio'`）；LOCK-E3：`tests/e2e/utils/disposable-seed-zip.ts`（同）；LOCK-PROD-2：`src/renderer/src/windows/chatImport/entryPoint.ts`、`src/main/services/chatDbImport/navigationProjection.ts` |
| 受保护 profile 名 `Cherry Studio` / `CherryStudio` | LOCK-PROFILE-006 拒绝守卫的兼容保护名（ADR 规范形式 + Electron/包实际派生形式） | `packages/shared/config/userData.ts`（`CHERRY_STUDIO_PROTECTED_USER_DATA_NAMES`） |

**边界**：若实现期发现清单外的新源格式标识符，须按兼容契约追加记录（§12 开放项），不得静默改名。

---

## 7. 更新与发布策略（Updater / Release Policy，LOCK-UPDATER-004 / LOCK-RELEASE-FREEZE / REPO-MIGRATION-002/003）

- 无「默认 Cherry Studio 构建」维护既有 feed——该目标已退役（LOCK-RETIRE-002）。
- Cherry Chat 在**独立 release endpoint 存在并获批前**：updater **禁用或显式不配置**——不得复用或指向 Cherry Studio 的 generic feed / release 渠道（LOCK-UPDATER-004）。
- **显式 `publish: null`（updater 元数据抑制）**：`electron-builder.yml` 声明 `publish: null`。在已安装的 electron-builder 26.8.1 下，**缺失/undefined 或 `[]` 的 `publish` 会让构建器从当前/未来 git remote 推断 GitHub publish endpoint**，并自动产出 `app-update.yml` / `latest-mac.yml` 更新元数据；显式 null 抑制该推断。该值在独立 endpoint 获批前**必须保持 null**（LOCK-UPDATER-004 / REPO-MIGRATION-002/003）。`electron-builder.test.ts` 经真实加载器断言有效配置 `config.publish === null` 且 schema 校验通过，并锁定配置文本显式书写 `publish: null`。
- **正式发布冻结（LOCK-RELEASE-FREEZE）**：在独立 endpoint、代码签名与公证就绪前，不做任何正式发布。`electron-builder.yml` 无 `releaseInfo`/release notes；`publish` 恒为 null。
- **仓库迁移不授权发布（REPO-MIGRATION-002）**：创建/更名仓库、变更 git remote、或在未来新的 Cherry Chat 仓库中构建，均**不**使 `publish` 获批、不启用 updater、不构成发布授权。新 remote 被推断的 metadata 同样受 `publish: null` 抑制。
- **未来激活前置条件（REPO-MIGRATION-003）**：updater 激活必须使用**显式审批的 endpoint 配置**，并同步协调：运行时 `updaterEnabled` 变更、release 工作流、代码签名/公证、渠道与回滚验证。任一缺失即保持冻结。
- 独立 release endpoint 的落地是开放后续（§12），不构成本 ADR 的决策变更。

> **Phase A 落地（历史）**：LOCK-UPDATER-004 已实现——`appIdentity.updaterEnabled`（identity.ts）在 `AppUpdater.checkForUpdates()`（`src/main/services/AppUpdater.ts`）与 assistant MCP `checkUpdate()`（`src/main/mcpServers/assistant.ts`）双重把关；cherry-chat 下零 feed/网络/analytics 调用（`AppUpdater.identityGate.test.ts`、`assistant.identity.test.ts`）。退役后该门语义不变，仍为单一 Cherry Chat 身份的同一常数。
> **当前证据（config 层）**：`electron-builder.test.ts` 经真实 electron-builder 加载器验证 base 配置**显式 `publish: null`**（抑制 git-remote 推断、不含 `releases.cherry-ai.com`）且**无 release notes**；文本级断言锁定 `publish: null` 字面量。
> **已修正验证发现（updater 元数据，LOCK-UPDATER-004 冻结面）**：早前成功构建（§9 所列，`publish` 当时缺失/undefined）经电子构建器**自动推断** git remote（`JorkeyLiu/cherry-studio`）并生成 `app-update.yml`（provider github → fork repo）与 `dist/latest-mac.yml`——这些是构建器默认产物，**不是配置的发布 feed**，也不消费 Cherry Studio feed；运行时 updater 门保持禁用。该发现被 Auditor 归类为 LOCK-UPDATER-004 阻断项，**已通过显式 `publish: null` 修正并结论性验证（resolved）**：post-fix（`publish: null` 生效后）的干净状态验证在仅移除陈旧 `latest-mac.yml`/builder metadata 后重跑，两次构建（`build:unpack` 与 `build:mac:arm64`）均通过且**未生成任何 app-update.yml / latest-mac.yml**，无 owner/repo/feed endpoint 字符串（§9、§12）。此前的推断 metadata 是**已解决的验证发现（resolved validation finding）**，不是当前被接受的行为；pre-fix 产物为**被取代的历史证据（superseded evidence）**，不再视为当前证据（§9、§12）。

---

## 8. 版本与构建身份（Version & Build Identity，VERSION-001..005）

> **状态**：源码/config/编译层已实现并测试锁定；**退役后单一目标打包产物与 packaged 运行验证已在版本/构建身份实现（VERSION-001..005）落地后重跑并通过**（§9 P-B/P-C/P-E、AC-8）。

### 8.1 产品版本（手动，VERSION-002 / VERSION-004）

- **来源与格式**：产品版本为**手动维护**，唯一来源是根 `package.json` 的 `version` 字段，当前为 **`0.1.0`**。格式为 semver（`major.minor.patch`）。
- **边界（手动 vs 自动）**：产品版本只能由人工/显式流程修改（升级走既有手动流程，不属本 ADR 决策范围）；**构建系统不改写产品版本**。`electron-builder.yml` 的 artifactName 继续以 `${version}` 引用产品版本；`app.getVersion()` 在运行时读取该值。
- **`app.getVersion()` 契约**：稳定返回产品版本 `0.1.0`；Build ID 与数字构建版本是**独立字段**，不混入产品版本（VERSION-004）。

### 8.2 Build ID（自动，VERSION-003）

- **格式**：`<UTC时间戳YYYYMMDDHHMMSSmmm>-<短SHA(≤7)>[-dirty]`，文件名安全（仅 `[A-Za-z0-9-]`）；毫秒分量保证同一墙钟秒内的连续构建仍可区分（VERSION-003 唯一性）。
- **一次捕获**：每次构建调用捕获**一个** UTC 时间戳（毫秒精度），同时派生 Build ID 与数字 macOS 构建版本（CFBundleVersion），保证同一构建内各消费方一致。
- **dirty 标记**：工作树有未提交改动时追加 `-dirty`。
- **Git 不可用降级**：Git 元数据不可用（非 repo / 无提交 / git 缺失）时，SHA 位用显式标记 **`nogit`**（不声称有效 SHA），且不追加 dirty 标记。
- **数字 macOS 构建版本**：`macBuildVersion` 为 UTC 时间戳的纯数字串（17 位十进制，含毫秒），作为 CFBundleVersion（macOS 期望的数字构建版本）。

### 8.3 一次构建一个身份（共享机制）

- **生成器**：`scripts/build-identity.ts`（纯函数 `buildIdentity()` 对注入输入确定；`collectGitMetadata()`/`currentBuildIdentity()` 读取实时 Git；CLI `--print` / `--spawn`）。
- **环境桥**：包装命令 `dotenv -- tsx scripts/build-identity.ts --spawn "<build && electron-builder …>"` 在**同一次调用**内计算一次身份并注入 `CHERRY_CHAT_BUILD_ID` / `CHERRY_CHAT_BUILD_VERSION` 环境变量，供全部消费方复用：
  - electron-vite 编译：`electron.vite.config.ts` `define` 注入 `__BUILD_ID__` / `__BUILD_VERSION__`（主进程 `src/main/ipc.ts` App_Info 契约携带 `buildId` / `buildVersion`）；
  - electron-builder 打包：`mac.artifactName` 用 `${env.CHERRY_CHAT_BUILD_ID}`（原生宏插值）→ 产物文件名含 Build ID；
  - CFBundleVersion：electron-builder **不**对 `buildVersion` 做宏展开，因此由 `scripts/apply-build-version.js` 在 `beforePack`（`scripts/before-pack.js`）将 `CHERRY_CHAT_BUILD_VERSION` 应用到 AppInfo，落到 Info.plist `CFBundleVersion`。该 hook **按平台门控**：平台已知且非 macOS 时跳过（LOCK-PLATFORM-005——Windows/Linux 元数据不在范围）。
- **守卫**：绕过包装器直接运行 electron-builder 时，artifactName 的 `${env.CHERRY_CHAT_BUILD_ID}` 因环境缺失而**硬失败**（`ERR_ELECTRON_BUILDER_ENV_NOT_DEFINED`），构建身份无法被静默跳过。
- **部分环境守卫（fail-fast，re-audit Finding A 修复）**：打包路径在 `scripts/before-pack.js`（beforePack 钩子）**第一步**调用 `scripts/assert-build-identity-env.js`——该钩子先于 electron-builder 求值 artifactName 宏、也先于任何 artifact 文件写入（打包流程 `doPack → emitBeforePack → packageInDistributableFormat → target.build`），抛出即中止构建。**恰好只有一半**环境变量存在（空串视为未设置）时立即抛出清晰错误（`split environment: …`，含两个 env 名与包装器指引），不产出任何 artifact——杜绝 artifact 文件名消费 `CHERRY_CHAT_BUILD_ID` 而 apply-build-version 消费 `CHERRY_CHAT_BUILD_VERSION` 的分裂身份。两半都在（包装器路径）或都不在（既有降级路径）时行为不变。
- **无构建期文件副作用**：身份经环境传递，不写入/改写任何受追踪配置文件。
- **部分环境一致处理**：环境桥契约要求 `CHERRY_CHAT_BUILD_ID` 与 `CHERRY_CHAT_BUILD_VERSION` 必须**成对**存在。**打包路径**（electron-builder）：恰好一个存在时由 beforePack 守卫**硬失败**，绝不产出分裂身份的 artifact；两半都在时按包装器值复用；两半都不在时保持既有降级行为。**编译路径**（electron-vite）：部分/缺失时两半均从同一次捕获重新计算，buildId/buildVersion 永不互相矛盾——该回退仅在未伴随打包的调用（`dev`、裸 `electron-vite build`）中可达，因为打包路径已在部分环境下先行失败。
- **dev / 普通编译回退**：未走包装器时（`dev`、裸 `electron-vite build`），`electron.vite.config.ts` 在配置加载时计算回退身份（同样基于 UTC + Git），About 界面仍显示可追溯 Build ID。
- **测试加载无 git 副作用**：Vitest 仅复用该 config 的 plugins/aliases，不消费 `define` 值；`process.env.VITEST` 存在时配置加载**不派生 git 子进程**，测试运行不产生外部 git 依赖。

### 8.4 运行时与界面

- App_Info 契约扩展：`buildId`、`buildVersion`（同时补齐既有 `notesPath` 遗漏字段）；`app.getVersion()` 保持产品版本。
- About 设置页（`AboutSettings.tsx`）在版本徽标旁显示 Build ID 与构建版本，标签走 i18n（`settings.about.build_id` / `settings.about.build_version`，en/zh-CN/zh-TW 及 translate 占位）。
- 反馈邮件正文（mailto）附带 Build ID，便于诊断。

### 8.5 测试覆盖

- `scripts/__tests__/build-identity.test.ts`：确定性格式、UTC 行为、dirty 处理、毫秒唯一性（同一秒内区分）、Git 不可用降级、数字 macOS 构建版本、文件名安全、产品版本恰为 `0.1.0`、环境桥/子进程一致性。
- `scripts/__tests__/apply-build-version.test.ts`：beforePack 构建版本应用（env 存在/缺失/no-op）+ **macOS 平台门控**（Windows/Linux 跳过、平台信息缺失时保留 macOS 行为）。
- `scripts/__tests__/assert-build-identity-env.test.ts`：打包路径**部分环境 fail-fast 守卫**（re-audit Finding A）——恰好一个 env 存在时清晰失败（错误含两个 env 名 + 包装器指引）、两半都在（包装器路径）/都不在（降级路径）时通过、空串视为未设置、beforePack 首步接线契约。
- `scripts/__tests__/electron-builder.test.ts`：artifactName 模板含 `${env.CHERRY_CHAT_BUILD_ID}` 且保留 `${version}`；`buildVersion` 不静态配置（经 beforePack 注入）；`publish: null` 显式抑制 + 无 release notes 不变（LOCK-UPDATER-004 / REPO-MIGRATION-002）。

---

## 9. macOS 优先实施阶段（Implementation Phases）与验证状态

> **Phase A（集中身份与运行时隔离）**、**Phase B（打包与构建产物）**、**Phase C（打包一次性 profile 隔离验证）** 在 **flavor 架构下已完成并经实际证据验证**——这些是**历史证据**，反映的是「默认 Studio 不变 + Cherry Chat flavor」时期的实现与验证。**退役（LOCK-RETIRE-001/002）改变构建路径**：base 配置直接携带 Cherry Chat 身份、无 overlay/flavor 注入。因此 **退役后的单一目标打包构建与 packaged 身份/隔离 E2E 已在版本/构建身份实现（VERSION-001..005）落地后重跑并通过**（见下 P-B/P-C/P-E 退役后当前证据）；`dist/` 下早期 `Cherry Chat.app` 产物（构建于 2026-08-07 11:37）早于退役实现落地（identity.ts 等 12:50 修改），其 app.asar 仍烘焙退役前 flavor 机制——**仅作历史参照，不构成退役后构建的证据**。**updater 元数据修正（LOCK-UPDATER-004）**：pre-fix 退役后重跑产物在 `publish: null` 落地前构建，携构建器从 git remote 推断的 `JorkeyLiu/cherry-studio` 自动生成 metadata（app-update.yml / latest-mac.yml）；该推断已被显式 `publish: null` 修正，且 **post-fix（`publish: null` 生效后）重跑已结论性完成**：干净状态验证后两次构建均通过并**未生成任何 updater manifest**（§7、§12）。pre-fix 产物（Build ID `20260807104723578-ff1a9a7-dirty` / `20260807104836723-ff1a9a7-dirty`）为**被取代的历史证据**，不构成当前证据。

| 阶段 | 内容 | 退出准则 | 状态 |
|---|---|---|---|
| **P-A 集中身份与运行时隔离** | 集中 `appIdentity`（productName `Cherry Chat`、appId `com.jorkeyliu.CherryChat`、`cherrychat://`、home/temp/userData 派生、更新门）；显式早期 userData 解析（`Cherry Chat` / dev `Cherry ChatDev`）；Cherry Studio 默认 profile 拒绝守卫（LOCK-PROFILE-006）；updater 与 assistant release-feed 门（LOCK-UPDATER-004）；聚焦测试（16 个 `initAppDataDir()` 直连测试等） | 集中身份输入与运行时隔离由源码与聚焦测试证明（flavor 时代）；退役后由单一身份常量 + 同套聚焦测试继续覆盖 | **已完成（历史）**；退役后语义由当前源码/测试持续锁定（§4 当前证据） |
| **P-B 打包与构建产物** | 曾以 Cherry Chat flavor 的 packaged `.app` / bundle ID 落地（`electron-builder.cherry-chat.yml` overlay + `build:chat:mac:arm64`）；退役后 base 配置直接携带 Cherry Chat 身份（`electron-builder.yml`），打包命令为普通 `build:mac:arm64`，无 flavor 选择 | 打包产物具备 Cherry Chat 身份，且不含 Cherry Studio feed / release notes（LOCK-UPDATER-004）；无 git-remote 推断的 updater metadata（`publish: null`） | **当前证据（post-fix，结论性）**：退役后以规范包装命令重跑通过（Node 24.12.0 / pnpm 10.27.0）——`pnpm native:check:electron` 通过（Electron 41.2.1 / ABI 145 / darwin arm64）；`pnpm build:unpack` 通过（Build ID `20260807114538113-ff1a9a7-dirty` / buildVersion `20260807114538113`）产出 `dist/mac-arm64/Cherry Chat.app`；`pnpm build:mac:arm64` 通过（Build ID `20260807114817393-ff1a9a7-dirty` / buildVersion `20260807114817393`）产出完整 DMG/ZIP 产物（见下）；Info.plist 身份与 LOCK-UPDATER-004 冻结已验证（见下）。**updater 元数据结论性验证**：两次构建后均无 `app-update.yml` / `latest-mac.yml`，无 owner/repo/feed endpoint 字符串——`publish: null` 抑制 git-remote 推断被**结论性验证**（§7、§12）。pre-fix 产物（`20260807104723578-ff1a9a7-dirty` / `20260807104836723-ff1a9a7-dirty`，携推断的 `JorkeyLiu/cherry-studio` metadata）为**被取代的历史证据**；flavor 时代产物仍为历史证据 |
| **P-C 打包一次性 profile 隔离验证** | packaged 一次性 profile 隔离：显式 `--user-data-dir` 优先级契约、空 profile 首启（无磁盘扫描 / 无静默迁移 / 不共享目录）、同 profile 二次实例单实例锁、真实 Cherry Studio（`CherryStudio` 实际派生名 + ADR 形式 `Cherry Studio`）/ 默认 `Cherry Chat` profile 零改动、owned 资源精确清理 | 一次性 profile harness 可验证者全部通过；完整并行安装（已随 IDENTITY-001 退役取消）与打包环境 L2 导入不在本范围 | **当前证据**：packaged E2E 在退役后单一目标打包产物上重跑通过 1/1（23.0s，见下）；flavor 时代证据仍为历史 |
| **P-D 平台扩展（推迟）** | Windows / Linux 身份落地 | **非目标**：明确推迟（LOCK-PLATFORM-005），不做平台承诺 | **推迟** |
| **P-E 版本与构建身份（VERSION-001..005）** | 产品版本 `0.1.0`（根 package.json，VERSION-002）；每构建唯一 Build ID（UTC 时间戳 + 短 SHA + 可选 dirty，Git 不可用 `nogit` 降级，VERSION-003）；`scripts/build-identity.ts` 生成器 + `--spawn` 包装命令，一次构建一个身份经 `CHERRY_CHAT_BUILD_ID`/`CHERRY_CHAT_BUILD_VERSION` 环境桥复用；electron-vite `define` → App_Info `buildId`/`buildVersion`；`mac.artifactName` 含 `${env.CHERRY_CHAT_BUILD_ID}`；`apply-build-version.js`（beforePack）→ CFBundleVersion；About 界面 + i18n + 反馈邮件含 Build ID | 源码/config/编译层由聚焦测试锁定（build-identity / apply-build-version / electron-builder 测试 + 双 typecheck + i18n:check）；`app.getVersion()` 保持产品版本；updater/feed/release 冻结不变（LOCK-UPDATER-004 / LOCK-RELEASE-FREEZE，`publish: null`） | **当前证据（源码/config/编译层）**：已完成并测试锁定；**打包产物与 packaged 运行验证已在 post-fix（`publish: null` 生效后）重跑通过**——两次独立调用各捕获一次身份：`pnpm build:unpack`（完整 Build ID `20260807114538113-ff1a9a7-dirty`，数字 buildVersion/CFBundleVersion `20260807114538113`）与 `pnpm build:mac:arm64`（完整 Build ID `20260807114817393-ff1a9a7-dirty`，数字 buildVersion/CFBundleVersion `20260807114817393`）身份互不相同；完整 DMG/ZIP 产物文件名（含各自完整 Build ID）已在可分发目标上直接实测（见下，`Cherry-Chat-0.1.0-20260807114817393-ff1a9a7-dirty-arm64.dmg` / `.zip` / `.zip.blockmap`）。**Build ID 定义边界**：完整 Build ID 是「UTC 时间戳-短SHA[-dirty]」复合串（如 `20260807114817393-ff1a9a7-dirty`）；纯数字 buildVersion/CFBundleVersion（如 `20260807114817393`）**不等于 Build ID**，仅是其数字分量，不得单独称为 Build ID。运行时 App_Info `buildId=20260807093507259-ff1a9a7-dirty`/`buildVersion=20260807093507259`/`version=0.1.0`/`isPackaged=true`/arch `arm64` 为先前 unpacked 产物上 E2E 取得（见下）。artifact 文件名（DMG/ZIP 含完整 Build ID）已在可分发目标上实测。**updater 元数据结论性验证**：post-fix 两次构建后均无 `app-update.yml` / `latest-mac.yml`，无 owner/repo/feed endpoint 字符串（LOCK-UPDATER-004；§7、§12）——pre-fix 推断的 `JorkeyLiu/cherry-studio` metadata 是已解决验证发现，pre-fix 产物为被取代的历史证据 |

> **P-B 历史产物证据**（flavor 时代，`--dir --mac --arm64`，macOS arm64）：`dist/mac-arm64/Cherry Chat.app`；Info.plist CFBundleIdentifier=`com.jorkeyliu.CherryChat`、CFBundleName/DisplayName=`Cherry Chat`；CFBundleURLSchemes 仅含 `cherrychat`（无 `cherrystudio`）；输出目录无 app-update.yml / latest-mac.yml（既有 dist 复核确认）；app.asar 内烘焙 cherry-chat 身份（`com.jorkeyliu.CherryChat`、`Cherry Chat`、`updaterEnabled: false`）。产物为 **ad-hoc 签名、未公证**（无公证凭据）。**注意**：该产物构建于退役前（app.asar 仍含 `resolveAppIdentity`/`FLAVOR_IDENTITIES`/`appFlavor`），是历史证据；退役后产物已另行构建验证（见下「退役后当前证据」）。**完整并行安装（默认构建 + Cherry Chat 并发启动）已随 IDENTITY-001 退役而取消**；打包环境 L2 导入仍为残余缺口（AC-6）。
> **P-C 历史证据（packaged E2E，flavor 时代，macOS arm64）**：`tests/e2e/specs/identity/packaged-isolation.spec.ts` 以真实打包产物对精确一次性 `--user-data-dir=<token>` 验证并**通过 1/1（约 22.6s）**：运行时 `isPackaged=true`、arch arm64；CLI userData 逐字节保留（renderer `getAppInfo()` 与主进程 probe 双通道一致，且不含 `Cherry Studio`/`CherryStudio`/`Cherry Chat` 任一路径段）；主窗口标题精确为 `Cherry Chat` 且 React 根挂载；关闭后 `chat.db`（自动创建时）topics/messages/message_blocks 全为 0（空首启）；同 profile 二次实例 exit 0 且首实例存活（单实例锁）；真实 `<appData>/CherryStudio`、ADR 形式 `Cherry Studio`、默认 `Cherry Chat` 三个 profile 的指纹（存在性 + 有界元数据）前后一致——零创建/零修改/零删除（LOCK-PROFILE-006）；owned 临时根精确清理、无进程残留。守卫现同时保护 `Cherry Studio` 与 `CherryStudio` 两个默认 profile 名。**该 harness 未执行 L2 ZIP 导入，也未并发启动两个打包应用（后者随 IDENTITY-001 退役取消）。该证据在 flavor 时代产物上取得，仅作历史参照；退役后重跑证据见下。**
> **退役后当前证据（打包构建 + packaged E2E，单一目标，macOS arm64，Node 24.12.0 / pnpm 10.27.0，post-fix 结论性）**：以**规范包装命令**重跑——`pnpm native:check:electron` 先行通过（Electron 41.2.1 / ABI 145 / darwin arm64），随后两条**独立调用**各捕获一次身份（VERSION-003）：
> - `pnpm build:unpack` **通过**：完整 Build ID `20260807114538113-ff1a9a7-dirty`、数字 buildVersion/CFBundleVersion `20260807114538113`，产出 `dist/mac-arm64/Cherry Chat.app`（unpacked 辅助产物）。
> - `pnpm build:mac:arm64` **通过**：完整 Build ID `20260807114817393-ff1a9a7-dirty`、数字 buildVersion/CFBundleVersion `20260807114817393`，产出完整可分发产物（**文件名已在可分发目标上直接实测**，VERSION-003 artifact 文件名残余关闭）：
>   - `dist/Cherry-Chat-0.1.0-20260807114817393-ff1a9a7-dirty-arm64.dmg`
>   - `dist/Cherry-Chat-0.1.0-20260807114817393-ff1a9a7-dirty-arm64.zip`
>   - `dist/Cherry-Chat-0.1.0-20260807114817393-ff1a9a7-dirty-arm64.zip.blockmap`
> - **Build ID 定义边界（conclusive）**：完整 Build ID 是「UTC 时间戳-短SHA[-dirty]」复合串（如 `20260807114817393-ff1a9a7-dirty`）；纯数字 buildVersion/CFBundleVersion（如 `20260807114817393`）**不等于 Build ID**，仅是其数字分量，不得单独称为 Build ID。artifact 文件名（DMG/ZIP 含完整 Build ID）与 Info.plist CFBundleVersion（纯数字）分别验证两种字段。
> - **Info.plist（产物身份，DMG 挂载复核一致）**：product version（CFBundleShortVersionString）`0.1.0`；CFBundleVersion（数字构建版本）`20260807114817393`；CFBundleName/DisplayName 等均为 `Cherry Chat` 名；CFBundleIdentifier=`com.jorkeyliu.CherryChat`；CFBundleURLSchemes 仅含 `cherrychat`（无 `cherrystudio`）；产物为 **ad-hoc 签名、未公证**（codesign `adhoc`、spctl rejected）——不构成发布就绪（LOCK-RELEASE-FREEZE）。
> - **updater 元数据结论性验证（LOCK-UPDATER-004 冻结面，post-fix）**：`updaterEnabled=false`（identity.ts），AppUpdater 与 assistant 门零 feed/网络调用。干净状态验证仅移除陈旧 `latest-mac.yml`/builder metadata 后，`publish: null`（显式抑制 git-remote 推断，§7）生效的两次构建均通过，且构建后 **`app-update.yml` 与 `latest-mac.yml` 均不存在**（`dist/` 与应用 Resources 内均无）；无 owner/repo/feed endpoint 字符串。**pre-fix 验证发现（resolved）**：`publish` 缺失/undefined 时期 electron-builder 26.8.1 从 git remote 推断 `JorkeyLiu/cherry-studio` 并自动生成 app-update.yml / latest-mac.yml——是已解决验证发现（resolved validation finding），不是当前行为；pre-fix 产物（Build ID `20260807104723578-ff1a9a7-dirty` / `20260807104836723-ff1a9a7-dirty`）为**被取代的历史证据（superseded evidence）**，不构成当前证据。
> - **packaged E2E**：`tests/e2e/specs/identity/packaged-isolation.spec.ts` 在先前退役后 unpacked 产物上**通过 1/1（23.0s）**：运行时 App_Info `buildId=20260807093507259-ff1a9a7-dirty`、`buildVersion=20260807093507259`、`version=0.1.0`、`isPackaged=true`、arch `arm64`；空 profile 首启、同 profile 单实例锁、真实 `CherryStudio`/`Cherry Studio`/默认 `Cherry Chat` profile 零改动、owned 资源精确清理全部通过（AC-3/AC-7/AC-8 打包面）。
> - **未覆盖（残余）**：打包环境 L2 ZIP 导入仍未实测（AC-6 / §12）；release 就绪（签名/公证）未声称（LOCK-RELEASE-FREEZE）。

---

## 10. 安装 / 迁移 / 回滚 Runbook

> **状态**：退役后单一目标打包产物已构建并通过 packaged 身份/隔离 E2E（§9，post-fix 结论性证据）；以下安装步骤中的「L2 导入」尚未以打包应用实测——仍为计划行为。并行安装（双目标并发）已随 IDENTITY-001 退役取消。仓库迁移（REPO-MIGRATION-001）不影响本 runbook——新 Cherry Chat 仓库中的构建仍使用同一身份与同一 `publish: null` 冻结。

**安装（macOS arm64）**
1. 构建单一 Cherry Chat 应用（普通 `build:mac:arm64`，base 配置即 Cherry Chat 身份）。
2. 安装于 macOS arm64 主机：独立 App 目录、独立 userData、`cherrychat://` 协议注册。
3. Cherry Chat 首启以**自身空 profile** 启动——无静默迁移、无磁盘扫描（LOCK-PROFILE-006）。若解析到 Cherry Studio 默认 profile，启动拒绝（LOCK-PROFILE-006 守卫）。

**迁移（用户主动，一次性）**
1. 用户在 Cherry Chat 中选定一个 Cherry Studio ZIP 备份 → 走 L2 兼容导入（sqlite-migration.md Phase 4 / 6 语义；replace-all；promotion 保留回滚快照）。
2. 迁移是显式用户操作，绝无启动时自动迁移。

**回滚**
1. 应用级：删除 Cherry Chat 应用及其独立 userData；Cherry Studio profile 不受影响（不被删除/修改，LOCK-PROFILE-006）。
2. 导入级：沿用 L2 promotion 回滚快照与恢复矩阵（sqlite-migration.md §10）。

---

## 11. 验收标准（Acceptance Criteria）

| # | 验收标准 | 状态 | 证据 |
|---|---|---|---|
| AC-1 | ~~默认 Cherry Studio 构建身份（productName / appId / 协议 / userData 派生 / 更新配置）不变~~ | **Retired**（随 IDENTITY-001 退役）——不存在默认 Studio 目标构建；base 构建即 Cherry Chat | 由 LOCK-RETIRE-002 取代 |
| AC-2 | **Cherry Chat 为唯一目标身份**：产品名 `Cherry Chat`、appId `com.jorkeyliu.CherryChat`、URL 协议 `cherrychat://`、独立 profile/home/temp、updater 禁用 | **已实现（config 层 + 打包产物）** | 身份输入集中定义并经测试锁定（`identity.test.ts` 逐字段断言、无退役 API 面、无 Cherry Studio 值）；base 打包配置经真实 electron-builder 加载器锁定（`electron-builder.test.ts`：appId/productName/protocol 精确、schema 校验通过）；协议单一 `cherrychat`（ProtocolClient.ts）；`notarize.test.ts`（bundle ID 动态解析）、`openapi-spec.test.ts`（恒为 Cherry Chat 元数据）、`title.test.ts`（主窗口标题 seam）。**退役后打包产物验证为当前证据（§9 P-B）** |
| AC-3 | Cherry Chat userData/profile 独立派生，绝不解析到 Cherry Studio profile | **已实现（config 层 + 当前 packaged 证据）** | `initAppDataDir()` 16 个直连测试：packaged/dev 均解析到 `Cherry Chat`（dev 后缀 `Dev`）；配置路径 profile 隔离；解析到 Cherry Studio 默认 profile 时抛 LOCK-PROFILE-006（`init.test.ts`、`userData.test.ts`）。packaged E2E 零改动证据为当前证据（§9 P-C，退役后产物重跑 1/1） |
| AC-4 | Cherry Chat 不消费 Cherry Studio updater/release feed；独立 endpoint 前 updater 禁用或显式不配置 | **已实现** | `updaterEnabled=false`（identity.ts）；AppUpdater 与 assistant MCP 门零 feed/网络/analytics 调用（`AppUpdater.identityGate.test.ts`、`assistant.identity.test.ts`）；base 配置**显式 `publish: null`**（抑制 git-remote 推断，无 release notes，`electron-builder.test.ts` 经真实加载器验证）；LOCK-RELEASE-FREEZE / REPO-MIGRATION-002 生效 |
| AC-5 | ~~macOS arm64 并行安装验证通过（两应用并存、profile 隔离、scheme 互不覆盖）~~ | **Retired**——所要求的第二个目标（默认 Cherry Studio 打包应用）已随 IDENTITY-001 退役，不再存在；无并发双目标场景 | 由 LOCK-RETIRE-002 取代；单目标 profile 隔离与 scheme 唯一性分别由 AC-3 / AC-2 覆盖 |
| AC-6 | 源兼容标识（Dexie `CherryStudio`、`persist:cherry-studio` 及其他）完整保留，L2 导入可读 | **部分完成** | 标识符未被身份实现改名，默认值断言保留（`identity.test.ts`）；「L2 导入可读」由既有 L2 管线（sqlite-migration.md）支撑。**打包环境下的 L2 导入端到端仍未实测**——遗留缺口（§9、§12） |
| AC-7 | 无自动磁盘扫描、无静默迁移、无共享 userData；Cherry Studio profile 不被删除/修改 | **已实现（config 层 + 当前 packaged 证据）** | 源层：拒绝守卫不共享 userData；`init.test.ts` 合成根守卫断言仅触碰 mock 路径、默认 profile 零 setPath。产品行为（packaged E2E 当前证据）：空 profile 首启零数据；真实 `CherryStudio`、ADR 形式 `Cherry Studio`、默认 `Cherry Chat` 三个 profile 指纹前后一致零改动；owned 资源精确清理（`packaged-isolation.spec.ts`，退役后单一目标产物重跑 1/1，23.0s） |
| AC-8 | **产品版本 0.1.0 且 `app.getVersion()` 稳定返回；每构建唯一 Build ID（UTC 时间戳 + 短 SHA + 可选 dirty，Git 不可用显式降级）；macOS CFBundleVersion 为数字构建版本；artifact 文件名含 Build ID；updater/feed/release 冻结不变** | **已实现（源码/config/编译层 + 打包/运行验证）** | 根 `package.json` `version=0.1.0`；`build-identity.test.ts`（确定性/UTC/dirty/降级/数字构建版本/产品版本断言）；`electron-builder.test.ts`（artifactName 含 `${env.CHERRY_CHAT_BUILD_ID}`、保留 `${version}`、`publish: null` 显式抑制）；`apply-build-version.test.ts`（beforePack → CFBundleVersion）；`assert-build-identity-env.test.ts`（部分环境打包守卫 fail-fast，re-audit Finding A）；App_Info 契约含 `buildId`/`buildVersion`/`notesPath`；`AppUpdater.identityGate.test.ts` 不变。**打包/运行验证（退役后重跑，post-fix 结论性，§9 P-B/P-E）**：两次独立调用完整 Build ID 互不相同（`build:unpack`=`20260807114538113-ff1a9a7-dirty`、`build:mac:arm64`=`20260807114817393-ff1a9a7-dirty`）；**artifact 文件名（DMG/ZIP 含完整 Build ID）已在可分发目标上直接实测**——`dist/Cherry-Chat-0.1.0-20260807114817393-ff1a9a7-dirty-arm64.dmg` / `.zip` / `.zip.blockmap`（VERSION-003）；Info.plist product version `0.1.0`、CFBundleVersion（数字构建版本）`20260807114817393`、CFBundleIdentifier=`com.jorkeyliu.CherryChat`、scheme `cherrychat`、无配置的发布 feed / releaseInfo（LOCK-UPDATER-004）；**updater 元数据结论性验证**：post-fix 两次构建后均无 `app-update.yml` / `latest-mac.yml`、无 owner/repo/feed endpoint 字符串——pre-fix 推断的 `JorkeyLiu/cherry-studio` metadata 是已解决验证发现，pre-fix 产物（`20260807104723578-ff1a9a7-dirty` / `20260807104836723-ff1a9a7-dirty`）为被取代的历史证据（见 §7、§9、§12）；运行时 App_Info `buildId=20260807093507259-ff1a9a7-dirty`、`buildVersion=20260807093507259`、`version=0.1.0`、`isPackaged=true`、`arm64`（`packaged-isolation.spec.ts` 1/1，23.0s，先前 unpacked 产物）。**DMG/ZIP artifact 文件名验证残余已关闭** |

---

## 12. 风险与开放后续（Risks / Open Follow-ups）

| 项 | 类型 | 说明 |
|---|---|---|
| 独立 release endpoint | Open | Cherry Chat updater 启用前置条件；落地并获批前 updater 保持禁用/不配置（LOCK-UPDATER-004）；正式发布冻结（LOCK-RELEASE-FREEZE）。激活需显式审批的 endpoint + `updaterEnabled` 变更 + release 工作流 + 签名/公证 + 渠道/回滚验证（REPO-MIGRATION-003） |
| **updater 元数据修正（LOCK-UPDATER-004）** | **已修正（resolved）** | pre-fix 产物（§9 P-B/P-E，`publish` 缺失/undefined）被 electron-builder 26.8.1 从 git remote 推断并携带 `JorkeyLiu/cherry-studio` 自动生成的 app-update.yml / latest-mac.yml metadata；Auditor 归类为 LOCK-UPDATER-004 阻断项。已通过**显式 `publish: null`** 修正（抑制 git-remote 推断），并以**干净状态结论性验证**（resolved）：验证仅移除标识的陈旧 updater manifest 输出后重建——post-fix `build:unpack` 与 `build:mac:arm64` 均通过，构建后 `app-update.yml` / `latest-mac.yml` 均不存在、无 owner/repo/feed endpoint 字符串。pre-fix 产物为被取代的历史证据（§7、§9） |
| **仓库迁移（REPO-MIGRATION-001/002/003）** | **治理中** | 当前仓库状态将迁移为新的 Cherry Chat 仓库（既有 Cherry Studio 仓库退役），仅变更载体；迁移本身不授权 updater/发布（REPO-MIGRATION-002）；未来激活须显式审批 endpoint 并协调运行时/发布/签名/渠道变更（REPO-MIGRATION-003） |
| 代码签名 / 公证 | Open | Cherry Chat bundle ID 的签名/公证链就绪前不正式发布（LOCK-RELEASE-FREEZE）；历史产物为 ad-hoc 签名、未公证，**不构成发布就绪**；`notarize.js` 仅在提供 Apple 凭据时执行 |
| Windows / Linux 身份落地 | Deferred | 明确推迟（LOCK-PLATFORM-005），不做平台承诺 |
| **退役后打包构建与 packaged 身份/隔离 E2E 重验证** | **已完成（post-fix 结论性）** | 退役后以规范包装命令重跑（Node 24.12.0 / pnpm 10.27.0）：`pnpm native:check:electron` 通过（Electron 41.2.1 / ABI 145 / darwin arm64）；`pnpm build:unpack` 通过（完整 Build ID `20260807114538113-ff1a9a7-dirty` / buildVersion `20260807114538113`）并产出 `dist/mac-arm64/Cherry Chat.app`；`pnpm build:mac:arm64` 通过（完整 Build ID `20260807114817393-ff1a9a7-dirty` / buildVersion `20260807114817393`）并产出完整 DMG/ZIP/blockmap；Info.plist 身份（product version `0.1.0`、CFBundleVersion `20260807114817393`、`com.jorkeyliu.CherryChat`、scheme `cherrychat`、无配置的发布 feed/releaseInfo）与 packaged E2E（`packaged-isolation.spec.ts` 1/1，23.0s：buildId/buildVersion、`isPackaged=true`、arm64、空 profile/单实例/零改动/清理全过）均验证通过；post-fix 两次构建后均无 app-update.yml / latest-mac.yml（LOCK-UPDATER-004 结论性验证）（§9、AC-2/3/7/8） |
| **DMG/ZIP artifact 文件名运行时验证** | **已完成（post-fix 结论性）** | 完整可分发产物（`build:mac:arm64`，完整 Build ID `20260807114817393-ff1a9a7-dirty`）已产出并**直接实测文件名**：`dist/Cherry-Chat-0.1.0-20260807114817393-ff1a9a7-dirty-arm64.dmg`、`…-arm64.zip`、`…-arm64.zip.blockmap`——artifact 文件名（含完整 Build ID）已在可分发目标上观测（VERSION-003）；原「静态/单元证明」残余关闭 |
| L2 打包环境导入实测 | Open | Phase C packaged harness 未执行 L2 ZIP 导入；打包产物 + 源兼容标识完整前提下 L2 导入端到端仍未在 packaged 环境实测（AC-6 残余） |
| 源兼容标识符清单 | Open | 实现期需精确枚举全部被 L2 消费的源格式标识符并追加记录（§6），不得静默改名（LOCK-COMPAT-003） |
| `cherrychat://` deep link 语义 | Open | 导航/处理契约（对应既有 `cherrystudio://navigate/…` 语义格式）需定义；本 ADR 只锁定 scheme 本身 |
| L3 归档 schema 字面量 | Locked | 既有 L3 备份/恢复归档 schema 字面量为兼容契约，除非另行版本化否则保持不变（LOCK-L3-COMPAT） |

---

## 13. 关联文档

- `docs/sqlite-migration.md` — L1/L2/L3 运行时与导入演进记录；本文档不修改其历史事实与 Phase 0–6 状态。其第 41 行对本文档的交叉引用（「决策锁 IDENTITY-001…006」及 flavor 措辞）为历史交叉引用，语义以本文档当前决策表为准。
- 本文档治理应用身份（单一目标 Cherry Chat + 退役记录 + 兼容边界）；`sqlite-migration.md` 治理 SQLite 运行时、L2 导入、L3 备份/恢复。身份问题以本文档为准。
