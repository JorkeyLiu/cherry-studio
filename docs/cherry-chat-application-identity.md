# Cherry Chat 应用身份（Application Identity）ADR — 单一目标身份、兼容边界与退役记录

> **文档状态**：Approved。**Cherry Chat 是唯一目标应用**（LOCK-RETIRE-001）；**IDENTITY-001 已退役**（LOCK-RETIRE-002）：双 flavor 架构是已否决的临时工程决策，不再存在任何 Cherry Studio 目标 flavor 或内部 legacy 构建。Cherry Studio 仅作为**源格式 / profile 保护兼容域**保留（LOCK-COMPAT-003）。Phase A–C 的既有实现与验证为**历史证据**（flavor 架构下取得）；退役后单一目标构建的打包产物与 packaged E2E 尚未重跑，属待重验证。本 ADR 是身份治理的单一事实源。
> **最后更新**：2026-08-07
> **Owner**：Personal fork（jorkeyliu）
> **分支**：`jorkey/integration`
> **关联**：`docs/sqlite-migration.md` 治理 L1（SQLite 运行时）/ L2（Cherry Studio ZIP 兼容导入）/ L3（Cherry Chat 备份/恢复）；**应用身份由本文档治理**，二者互补，不互改。`sqlite-migration.md` 第 41 行对本文档的交叉引用仍写「决策锁 IDENTITY-001…006」及其 flavor 措辞——该行是历史交叉引用，语义以本文档当前决策表为准（见 §2）。

---

## 1. 背景与目标（Context）

个人 fork（jorkeyliu）是**未来独立 Cherry Chat 应用**的开发载体（与 `sqlite-migration.md` 顶层定位一致）。该迁移记录已覆盖运行时与数据层（L1/L2/L3）；**应用身份**是独立关注点：它决定 Cherry Chat「是什么应用、如何与既有 Cherry Studio 安装/数据安全并排存在、用户数据落在哪、更新走哪」——这些约束必须在实现开始前锁定，避免身份与数据层互相污染。

**已批准的完整退役（2026-08-07）**：核心实现移除了双 flavor 选择机制，将 Chat 身份并入默认/base 构建。因此：

- **Cherry Chat 是唯一目标应用**：产品名 `Cherry Chat`、appId `com.jorkeyliu.CherryChat`、协议 `cherrychat://`、独立 profile/home/temp、updater 禁用（LOCK-RETIRE-001）。
- **IDENTITY-001 是已退役的错误临时决策**（LOCK-RETIRE-002）：曾要求「保留默认 Cherry Studio 构建不变、以显式 Cherry Chat flavor 新增」，该路线已被否决并整体移除；不存在任何 Studio 目标 flavor，也不存在内部 legacy 构建。退役理由：双目标并行安装从未被完整验证（旧 AC-5），且同时维护两个目标身份使身份契约、打包路径与发布语义分裂；单一目标显著简化并消除该未验证分支。
- **Cherry Studio 名称仅保留于源格式 / profile 安全契约**（LOCK-COMPAT-003）：Dexie `CherryStudio`、redux/localStorage `cherry-studio`/`persist:cherry-studio`、ZIP/origin/schema/import 声明、受保护 profile 名——这些是兼容契约，不承担目标应用身份。

本 ADR 记录已批准决策与退役记录，不改变既有 SQLite 迁移记录的任何历史事实与 Phase 0–6 状态。

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
| 更新 / release feed | 禁用或不配置（`identity.ts` `appIdentity.updaterEnabled=false`；`electron-builder.yml` 无 `publish` 块、无 `releaseInfo`；LOCK-UPDATER-004 / LOCK-RELEASE-FREEZE） | — |
| analytics / UA / API 身份 | analytics channel `cherry-chat`、UA product `CherryChat`、API title `Cherry Chat API`（`identity.ts`；`generate-openapi-spec.ts` `resolveSpecIdentity()` 恒返回 `appIdentity`） | — |
| 首期目标平台 | macOS arm64（LOCK-PLATFORM-005）；Windows/Linux 推迟，不做平台承诺 | — |

> 无「默认构建」列：base 构建即 Cherry Chat（LOCK-RETIRE-001/002）。

---

## 4. 单一目标契约（Single-Target Contract，替代原 Flavor 契约）

- **单一身份，无选择分支**：身份输入（productName / appId / 协议 / home / temp / userData 派生 / 更新配置）集中定义于 `packages/shared/config/identity.ts` 的**单一不可变常量 `appIdentity`**，无 flavor 分支、无 fallback（`identity.test.ts` 断言模块不导出 `appFlavor`/`resolveAppIdentity`/`APP_FLAVOR_ENV_VAR` 等已退役 API 面）。
- **base 构建即目标**：`electron-builder.yml` 直接携带 Cherry Chat 身份（appId / productName / protocols `cherrychat`），无 overlay、无 `extends`、无 flavor 注入；构建/打包命令不选择 flavor（`electron-builder.test.ts` 用已安装 electron-builder 26.8.1 加载器验证 base 配置语义：appId/productName/protocols 精确锁定、无 publish feed、无 release notes、schema 校验通过；并断言不存在 `build:chat*` 专用命令）。
- **退役的 flavor 机制（历史）**：`VITE_APP_FLAVOR` / `__APP_FLAVOR__` 编译期 define（`electron.vite.config.ts`）、`packages/shared/config/buildFlavor.ts`、`electron-builder.cherry-chat.yml` overlay、`scripts/build-chat-mac-arm64.ts` 及配套测试均已删除（LOCK-RETIRE-002）。`env.d.ts` 亦注明不再存在构建期 flavor 选择器。
- **源码兼容标识不参与身份**：Dexie `CherryStudio`、`persist:cherry-studio` 等按 LOCK-COMPAT-003 保留（§6），`identity.ts` 不携带任何 Cherry Studio 身份值（`identity.test.ts` 断言 `appIdentity` 序列化不含 `Cherry Studio`/`cherrystudio`/`com.kangfenmao`）。
- **共享常量派生自单一身份**：`APP_NAME`/`HOME_CHERRY_DIR`/`CHERRYIN_CONFIG.REDIRECT_URI` 均从 `appIdentity` 派生（`constant.ts`；`identity.test.ts` 锁定）。

> **当前证据（config 层）**：`identity.test.ts`（单一不可变身份逐字段锁定 + 无退役 API 面 + 无 Cherry Studio 值）、`userData.test.ts`（`resolveUserDataBase`/`applyDevSuffix`/`isCherryStudioDefaultUserData`）、`init.test.ts`（16 个 `initAppDataDir()` 直连场景，LOCK-RETIRE-001/002 与 LOCK-PROFILE-006 全覆盖）、`electron-builder.test.ts`（base 配置经真实 electron-builder 加载器锁定）、`notarize.test.ts`（bundle ID 动态解析）、`openapi-spec.test.ts`（恒为 Cherry Chat 元数据）、`title.test.ts`（主窗口标题 seam）。打包层证据见 §8 历史证据行。

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
> **Phase C 落地（历史）**：显式 `--user-data-dir=<path>` 为最高优先级且逐字节保留（packaged/dev 均生效；dev 下不再叠加 `Dev` 后缀，config.ts）；LOCK-PROFILE-006 守卫在最终 userData 上运行，保护 `Cherry Studio` 与 `CherryStudio` 两个默认 profile 名（`CHERRY_STUDIO_PROTECTED_USER_DATA_NAMES`，userData.ts）；packaged E2E 在真实打包产物上验证隔离与真实 profile 零改动（§8 历史证据行）。

---

## 6. 源兼容例外（Source-Compatibility Exceptions，LOCK-COMPAT-003）

以下标识符是 **L2 兼容导入的源格式契约**，不是目标应用身份；不得因身份引入而改名或删除。

| 标识符 | 用途 | 证据 |
|---|---|---|
| Dexie 数据库名 `CherryStudio` | L2 导入源 IndexedDB 的识别与读取；现有 Dexie files catalog 运行时架构名（post-closure，LOCK-DOC-1） | `src/renderer/src/databases/index.ts`（`new Dexie('CherryStudio')`） |
| localStorage key `persist:cherry-studio` | redux-persist 持久化（key `cherry-studio`，version 215）；L2 源 Local Storage 导航投影读取 | `src/renderer/src/store/index.ts`（key）；`src/renderer/src/windows/chatImport/entryPoint.ts`（`PERSISTED_STATE_KEY`） |
| `cherrystudio://` deep link 格式 | 既有功能/源数据格式引用（navigate/providers/mcp-install），非 Cherry Chat 目标身份 | `src/main/services/urlschema/` 处理注释（LOCK-COMPAT-003） |
| 其他 L2 导入管线消费的源格式标识符 | 兼容契约（如源 IndexedDB file-origin 映射、投影格式） | LOCK-D2：`src/main/services/chatDbImport/importDataPlane.ts`、`tests/e2e/utils/disposable-dev-origin-seed-zip.ts`（`SEED_DB_NAME='CherryStudio'`、`SEED_PERSIST_KEY='persist:cherry-studio'`）；LOCK-E3：`tests/e2e/utils/disposable-seed-zip.ts`（同）；LOCK-PROD-2：`src/renderer/src/windows/chatImport/entryPoint.ts`、`src/main/services/chatDbImport/navigationProjection.ts` |
| 受保护 profile 名 `Cherry Studio` / `CherryStudio` | LOCK-PROFILE-006 拒绝守卫的兼容保护名（ADR 规范形式 + Electron/包实际派生形式） | `packages/shared/config/userData.ts`（`CHERRY_STUDIO_PROTECTED_USER_DATA_NAMES`） |

**边界**：若实现期发现清单外的新源格式标识符，须按兼容契约追加记录（§11 开放项），不得静默改名。

---

## 7. 更新与发布策略（Updater / Release Policy，LOCK-UPDATER-004 / LOCK-RELEASE-FREEZE）

- 无「默认 Cherry Studio 构建」维护既有 feed——该目标已退役（LOCK-RETIRE-002）。
- Cherry Chat 在**独立 release endpoint 存在并获批前**：updater **禁用或显式不配置**——不得复用或指向 Cherry Studio 的 generic feed / release 渠道（LOCK-UPDATER-004）。
- **正式发布冻结（LOCK-RELEASE-FREEZE）**：在独立 endpoint、代码签名与公证就绪前，不做任何正式发布。`electron-builder.yml` 无 `publish` 块、无 `releaseInfo`/release notes。
- 独立 release endpoint 的落地是开放后续（§11），不构成本 ADR 的决策变更。

> **Phase A 落地（历史）**：LOCK-UPDATER-004 已实现——`appIdentity.updaterEnabled`（identity.ts）在 `AppUpdater.checkForUpdates()`（`src/main/services/AppUpdater.ts`）与 assistant MCP `checkUpdate()`（`src/main/mcpServers/assistant.ts`）双重把关；cherry-chat 下零 feed/网络/analytics 调用（`AppUpdater.identityGate.test.ts`、`assistant.identity.test.ts`）。退役后该门语义不变，仍为单一 Cherry Chat 身份的同一常数。
> **当前证据（config 层）**：`electron-builder.test.ts` 经真实 electron-builder 加载器验证 base 配置**无 publish feed**（`config.publish` 为 undefined、不含 `releases.cherry-ai.com`）且**无 release notes**。

---

## 8. macOS 优先实施阶段（Implementation Phases）与验证状态

> **Phase A（集中身份与运行时隔离）**、**Phase B（打包与构建产物）**、**Phase C（打包一次性 profile 隔离验证）** 在 **flavor 架构下已完成并经实际证据验证**——这些是**历史证据**，反映的是「默认 Studio 不变 + Cherry Chat flavor」时期的实现与验证。**退役（LOCK-RETIRE-001/002）改变构建路径**：base 配置直接携带 Cherry Chat 身份、无 overlay/flavor 注入。因此 **退役后的单一目标打包构建与 packaged E2E 尚未重跑，属待重验证**；`dist/` 下既有 `Cherry Chat.app` 产物（构建于 2026-08-07 11:37）早于退役实现落地（identity.ts 等 12:50 修改），其 app.asar 仍烘焙退役前 flavor 机制——**不得作为退役后构建的完成证据**。

| 阶段 | 内容 | 退出准则 | 状态 |
|---|---|---|---|
| **P-A 集中身份与运行时隔离** | 集中 `appIdentity`（productName `Cherry Chat`、appId `com.jorkeyliu.CherryChat`、`cherrychat://`、home/temp/userData 派生、更新门）；显式早期 userData 解析（`Cherry Chat` / dev `Cherry ChatDev`）；Cherry Studio 默认 profile 拒绝守卫（LOCK-PROFILE-006）；updater 与 assistant release-feed 门（LOCK-UPDATER-004）；聚焦测试（16 个 `initAppDataDir()` 直连测试等） | 集中身份输入与运行时隔离由源码与聚焦测试证明（flavor 时代）；退役后由单一身份常量 + 同套聚焦测试继续覆盖 | **已完成（历史）**；退役后语义由当前源码/测试持续锁定（§4 当前证据） |
| **P-B 打包与构建产物** | 曾以 Cherry Chat flavor 的 packaged `.app` / bundle ID 落地（`electron-builder.cherry-chat.yml` overlay + `build:chat:mac:arm64`）；退役后 base 配置直接携带 Cherry Chat 身份（`electron-builder.yml`），打包命令为普通 `build:mac:arm64`，无 flavor 选择 | 打包产物具备 Cherry Chat 身份，且不含 Cherry Studio feed / release notes（LOCK-UPDATER-004） | **历史证据**：flavor 时代产物验证通过（见下）；**退役后需以普通 `build:mac:arm64` 重跑并重验证** |
| **P-C 打包一次性 profile 隔离验证** | packaged 一次性 profile 隔离：显式 `--user-data-dir` 优先级契约、空 profile 首启（无磁盘扫描 / 无静默迁移 / 不共享目录）、同 profile 二次实例单实例锁、真实 Cherry Studio（`CherryStudio` 实际派生名 + ADR 形式 `Cherry Studio`）/ 默认 `Cherry Chat` profile 零改动、owned 资源精确清理 | 一次性 profile harness 可验证者全部通过；完整并行安装（已随 IDENTITY-001 退役取消）与打包环境 L2 导入不在本范围 | **历史证据**：packaged E2E 在 flavor 时代打包产物上通过 1/1（见下）；**退役后需重跑** |
| **P-D 平台扩展（推迟）** | Windows / Linux 身份落地 | **非目标**：明确推迟（LOCK-PLATFORM-005），不做平台承诺 | **推迟** |

> **P-B 历史产物证据**（flavor 时代，`--dir --mac --arm64`，macOS arm64）：`dist/mac-arm64/Cherry Chat.app`；Info.plist CFBundleIdentifier=`com.jorkeyliu.CherryChat`、CFBundleName/DisplayName=`Cherry Chat`；CFBundleURLSchemes 仅含 `cherrychat`（无 `cherrystudio`）；输出目录无 app-update.yml / latest-mac.yml（既有 dist 复核确认）；app.asar 内烘焙 cherry-chat 身份（`com.jorkeyliu.CherryChat`、`Cherry Chat`、`updaterEnabled: false`）。产物为 **ad-hoc 签名、未公证**（无公证凭据）。**注意**：该产物构建于退役前（app.asar 仍含 `resolveAppIdentity`/`FLAVOR_IDENTITIES`/`appFlavor`），是历史证据；退役后普通 `build:mac:arm64` 的产物尚未构建验证。**完整并行安装（默认构建 + Cherry Chat 并发启动）已随 IDENTITY-001 退役而取消**；打包环境 L2 导入仍为残余缺口（AC-6）。
> **P-C 历史证据（packaged E2E，flavor 时代，macOS arm64）**：`tests/e2e/specs/identity/packaged-isolation.spec.ts` 以真实打包产物对精确一次性 `--user-data-dir=<token>` 验证并**通过 1/1（约 22.6s）**：运行时 `isPackaged=true`、arch arm64；CLI userData 逐字节保留（renderer `getAppInfo()` 与主进程 probe 双通道一致，且不含 `Cherry Studio`/`CherryStudio`/`Cherry Chat` 任一路径段）；主窗口标题精确为 `Cherry Chat` 且 React 根挂载；关闭后 `chat.db`（自动创建时）topics/messages/message_blocks 全为 0（空首启）；同 profile 二次实例 exit 0 且首实例存活（单实例锁）；真实 `<appData>/CherryStudio`、ADR 形式 `Cherry Studio`、默认 `Cherry Chat` 三个 profile 的指纹（存在性 + 有界元数据）前后一致——零创建/零修改/零删除（LOCK-PROFILE-006）；owned 临时根精确清理、无进程残留。守卫现同时保护 `Cherry Studio` 与 `CherryStudio` 两个默认 profile 名。**该 harness 未执行 L2 ZIP 导入，也未并发启动两个打包应用（后者随 IDENTITY-001 退役取消）。该证据在 flavor 时代产物上取得，退役后需重跑。**

---

## 9. 安装 / 迁移 / 回滚 Runbook

> **状态**：退役后单一目标打包产物尚未构建/验证（§8）；以下安装步骤中的「L2 导入」尚未以打包应用实测——仍为计划行为。并行安装（双目标并发）已随 IDENTITY-001 退役取消。

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

## 10. 验收标准（Acceptance Criteria）

| # | 验收标准 | 状态 | 证据 |
|---|---|---|---|
| AC-1 | ~~默认 Cherry Studio 构建身份（productName / appId / 协议 / userData 派生 / 更新配置）不变~~ | **Retired**（随 IDENTITY-001 退役）——不存在默认 Studio 目标构建；base 构建即 Cherry Chat | 由 LOCK-RETIRE-002 取代 |
| AC-2 | **Cherry Chat 为唯一目标身份**：产品名 `Cherry Chat`、appId `com.jorkeyliu.CherryChat`、URL 协议 `cherrychat://`、独立 profile/home/temp、updater 禁用 | **已实现（config 层）** | 身份输入集中定义并经测试锁定（`identity.test.ts` 逐字段断言、无退役 API 面、无 Cherry Studio 值）；base 打包配置经真实 electron-builder 加载器锁定（`electron-builder.test.ts`：appId/productName/protocol 精确、schema 校验通过）；协议单一 `cherrychat`（ProtocolClient.ts）；`notarize.test.ts`（bundle ID 动态解析）、`openapi-spec.test.ts`（恒为 Cherry Chat 元数据）、`title.test.ts`（主窗口标题 seam）。**打包产物验证为历史证据（§8 P-B），退役后需重跑** |
| AC-3 | Cherry Chat userData/profile 独立派生，绝不解析到 Cherry Studio profile | **已实现（config 层 + 历史 packaged 证据）** | `initAppDataDir()` 16 个直连测试：packaged/dev 均解析到 `Cherry Chat`（dev 后缀 `Dev`）；配置路径 profile 隔离；解析到 Cherry Studio 默认 profile 时抛 LOCK-PROFILE-006（`init.test.ts`、`userData.test.ts`）。packaged E2E 零改动证据为历史证据（§8 P-C），退役后需重跑 |
| AC-4 | Cherry Chat 不消费 Cherry Studio updater/release feed；独立 endpoint 前 updater 禁用或显式不配置 | **已实现** | `updaterEnabled=false`（identity.ts）；AppUpdater 与 assistant MCP 门零 feed/网络/analytics 调用（`AppUpdater.identityGate.test.ts`、`assistant.identity.test.ts`）；base 配置无 `publish` 块、无 release notes（`electron-builder.test.ts` 经真实加载器验证）；LOCK-RELEASE-FREEZE 生效 |
| AC-5 | ~~macOS arm64 并行安装验证通过（两应用并存、profile 隔离、scheme 互不覆盖）~~ | **Retired**——所要求的第二个目标（默认 Cherry Studio 打包应用）已随 IDENTITY-001 退役，不再存在；无并发双目标场景 | 由 LOCK-RETIRE-002 取代；单目标 profile 隔离与 scheme 唯一性分别由 AC-3 / AC-2 覆盖 |
| AC-6 | 源兼容标识（Dexie `CherryStudio`、`persist:cherry-studio` 及其他）完整保留，L2 导入可读 | **部分完成** | 标识符未被身份实现改名，默认值断言保留（`identity.test.ts`）；「L2 导入可读」由既有 L2 管线（sqlite-migration.md）支撑。**打包环境下的 L2 导入端到端仍未实测**——遗留缺口（§8、§11） |
| AC-7 | 无自动磁盘扫描、无静默迁移、无共享 userData；Cherry Studio profile 不被删除/修改 | **已实现（config 层 + 历史 packaged 证据）** | 源层：拒绝守卫不共享 userData；`init.test.ts` 合成根守卫断言仅触碰 mock 路径、默认 profile 零 setPath。产品行为（packaged E2E 历史证据）：空 profile 首启零数据；真实 `CherryStudio`、ADR 形式 `Cherry Studio`、默认 `Cherry Chat` 三个 profile 指纹前后一致零改动；owned 资源精确清理（`packaged-isolation.spec.ts`，flavor 时代产物，退役后需重跑） |

---

## 11. 风险与开放后续（Risks / Open Follow-ups）

| 项 | 类型 | 说明 |
|---|---|---|
| 独立 release endpoint | Open | Cherry Chat updater 启用前置条件；落地并获批前 updater 保持禁用/不配置（LOCK-UPDATER-004）；正式发布冻结（LOCK-RELEASE-FREEZE） |
| 代码签名 / 公证 | Open | Cherry Chat bundle ID 的签名/公证链就绪前不正式发布（LOCK-RELEASE-FREEZE）；历史产物为 ad-hoc 签名、未公证，**不构成发布就绪**；`notarize.js` 仅在提供 Apple 凭据时执行 |
| Windows / Linux 身份落地 | Deferred | 明确推迟（LOCK-PLATFORM-005），不做平台承诺 |
| **退役后打包构建与 packaged E2E 重验证** | **Open（必需）** | 退役（LOCK-RETIRE-001/002）改变构建路径（base 配置直接 Cherry Chat、无 overlay/flavor）；`dist/` 既有产物早于退役实现（app.asar 仍含退役前 flavor 机制），**需以普通 `build:mac:arm64` 重跑并重跑 `packaged-isolation.spec.ts`**；当前证据为 config 层测试 + 历史打包证据 |
| L2 打包环境导入实测 | Open | Phase C packaged harness 未执行 L2 ZIP 导入；打包产物 + 源兼容标识完整前提下 L2 导入端到端仍未在 packaged 环境实测（AC-6 残余） |
| 源兼容标识符清单 | Open | 实现期需精确枚举全部被 L2 消费的源格式标识符并追加记录（§6），不得静默改名（LOCK-COMPAT-003） |
| `cherrychat://` deep link 语义 | Open | 导航/处理契约（对应既有 `cherrystudio://navigate/…` 语义格式）需定义；本 ADR 只锁定 scheme 本身 |
| L3 归档 schema 字面量 | Locked | 既有 L3 备份/恢复归档 schema 字面量为兼容契约，除非另行版本化否则保持不变（LOCK-L3-COMPAT） |

---

## 12. 关联文档

- `docs/sqlite-migration.md` — L1/L2/L3 运行时与导入演进记录；本文档不修改其历史事实与 Phase 0–6 状态。其第 41 行对本文档的交叉引用（「决策锁 IDENTITY-001…006」及 flavor 措辞）为历史交叉引用，语义以本文档当前决策表为准。
- 本文档治理应用身份（单一目标 Cherry Chat + 退役记录 + 兼容边界）；`sqlite-migration.md` 治理 SQLite 运行时、L2 导入、L3 备份/恢复。身份问题以本文档为准。
