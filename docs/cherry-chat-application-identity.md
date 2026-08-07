# Cherry Chat 应用身份（Application Identity）ADR — 独立应用身份、隔离边界与分阶段落地

> **文档状态**：Approved（决策已批准；**Phase A 集中身份与运行时隔离、Phase B 打包与构建产物、Phase C 打包一次性 profile 隔离均已实现并验证**）。本 ADR 是身份治理的单一事实源；完整并行安装（AC-5）与打包环境 L2 导入（AC-6）仍未实测。
> **最后更新**：2026-08-07
> **Owner**：Personal fork（jorkeyliu）
> **分支**：`jorkey/integration`
> **关联**：`docs/sqlite-migration.md` 治理 L1（SQLite 运行时）/ L2（Cherry Studio ZIP 兼容导入）/ L3（Cherry Chat 备份/恢复）；**应用身份由本文档治理**，二者互补，不互改。

---

## 1. 背景与目标（Context）

个人 fork（jorkeyliu）是通往**未来独立 Cherry Chat 应用**的开发载体（与 `sqlite-migration.md` 顶层定位一致）。该迁移记录已覆盖运行时与数据层（L1/L2/L3）；**应用身份**是独立关注点：它决定 Cherry Chat「是什么应用、与现有 Cherry Studio 如何并排存在、用户数据落在哪、更新走哪」——这些约束必须在实现开始前锁定，避免身份与数据层互相污染。

本 ADR 记录已批准决策（IDENTITY-001…006），不改变既有 SQLite 迁移记录的任何历史事实与 Phase 0–6 状态。

**决策原则**：现有 Cherry Studio 默认构建及其身份保持不变；Cherry Chat 以显式 build flavor 加入，与默认构建并行；源数据格式标识符作为兼容契约保留，不承担目标应用身份。

---

## 2. 决策表（Decision Table）

| # | 决策 | 状态 |
|---|---|---|
| **IDENTITY-001** | 保留现有默认 Cherry Studio 构建与身份不变；以显式 Cherry Chat build flavor 新增，而非替换默认构建 | **Locked** |
| **IDENTITY-002** | Cherry Chat 身份：产品名 `Cherry Chat`、bundle/app ID `com.jorkeyliu.CherryChat`、URL 协议 `cherrychat://`、独立派生的 userData/profile 身份 | **Locked** |
| **IDENTITY-003** | 保留 L2 导入使用的 Cherry Studio 源兼容标识符，包括 Dexie 数据库 `CherryStudio`、local-storage key `persist:cherry-studio` 及其他源格式标识符——它们是兼容契约，不是目标应用身份 | **Locked** |
| **IDENTITY-004** | Cherry Chat 不得消费 Cherry Studio 的 updater/release feed；在独立 release endpoint 存在前，Cherry Chat updater 禁用或显式不配置 | **Locked** |
| **IDENTITY-005** | 首期交付目标为 macOS arm64 并行安装；Windows/Linux 身份落地推迟 | **Locked** |
| **IDENTITY-006** | 无自动磁盘扫描、无静默迁移、无共享 userData、不删除/修改既有 Cherry Studio profile | **Locked** |

---

## 3. 身份矩阵（Identity Matrix）

| 维度 | 默认构建（Cherry Studio，不变） | Cherry Chat flavor（Phase A/B 已实现） | 源兼容标识（兼容契约，不变） |
|---|---|---|---|
| 产品名 productName | `Cherry Studio`（electron-builder.yml:2） | `Cherry Chat`（packages/shared/config/identity.ts:98） | — |
| bundle / app ID | `com.kangfenmao.CherryStudio`（electron-builder.yml:1） | `com.jorkeyliu.CherryChat`（identity.ts:99；打包产物已验证，见 §10 AC-2） | — |
| URL 协议 | `cherrystudio://`（`cherrystudio` scheme；`APP_PROTOCOL`，src/main/services/ProtocolClient.ts:16） | `cherrychat://`（identity.ts:100；注册按 flavor scheme） | — |
| userData / profile | 默认 flavor 保持 Electron 按 app.name 派生（electron-default）；显式 setPath 仅于：配置/portable 解析（src/main/utils/init.ts:57/58）、dev `Dev` 后缀（src/main/config.ts:10）、运行时 IPC（src/main/ipc.ts:385） | 显式解析到 `<appData>/Cherry Chat`（dev 再叠加 `Dev` 后缀）；显式 `--user-data-dir=<path>` **优先级最高且逐字节保留**（packaged/dev 均生效，dev 不叠加 `Dev` 后缀；userData.ts:69/85、init.ts:50/64、config.ts:10）；IDENTITY-006 守卫在**最终** userData 上运行，同时保护 `Cherry Studio` 与 `CherryStudio` 两个默认 profile 名（userData.ts:138/148、init.ts:74） | — |
| Dexie 数据库名 | `CherryStudio`（src/renderer/src/databases/index.ts:32） | 保持 `CherryStudio`（兼容契约，非目标身份） | `CherryStudio` |
| localStorage persist key | `persist:cherry-studio`（redux-persist key `cherry-studio`，src/renderer/src/store/index.ts:84） | 保持 `persist:cherry-studio`（兼容契约，非目标身份） | `persist:cherry-studio` |
| 更新 / release feed | 既有 generic feed 配置不变 | 禁用或显式不配置，直至独立 endpoint（§7）；P-B 产物无 app-update.yml / latest-mac.yml | — |
| 首期目标平台 | 全平台（既有） | macOS arm64 并行安装 | — |

---

## 4. Flavor 契约（Flavor Contract）

- **默认构建零改动**：任何身份改动不得影响默认 Cherry Studio 构建的身份输入（productName / appId / 协议 / userData 派生 / 更新配置）。
- **显式新增而非替换**：Cherry Chat 是新增 build flavor；默认构建继续是默认产物。
- **身份输入集中定义**：flavor 所覆盖的身份输入（productName、appId、协议、userData 派生、更新配置）必须在构建配置层集中声明，不得散落为运行时分支判断。
- **覆盖范围受限**：Cherry Chat flavor 只覆盖其自有身份输入，不得改写默认构建的配置。
- **实现方式开放**：独立 electron-builder 配置、env 驱动、或构建脚本方式由实现期选择（见 §11 开放项），本 ADR 只锁定「显式 flavor + 默认不变」的契约。

> **Phase A 落地**：集中身份输入实现于 `packages/shared/config/identity.ts`（`appIdentity` / `appFlavor` / `resolveAppIdentity`），flavor 由构建期环境变量 `VITE_APP_FLAVOR` 选择——未设置或非法值回落默认构建（IDENTITY-001）；`appIdentity` 供主进程与 shared 层消费。默认构建身份逐项断言锁定（identity.test.ts）。

---

## 5. 运行时隔离面（Runtime Isolation Surfaces）

| 隔离面 | 不变量 |
|---|---|
| userData / profile 目录 | Cherry Chat 的 userData 由 Cherry Chat 身份独立派生（默认经 productName/app.name；若引入显式 `app.setPath('userData', …)`，必须由 Cherry Chat 身份计算且绝不解析到 Cherry Studio profile）；显式 `--user-data-dir=<path>` 优先级最高（Electron 在 JS 运行前应用，bootstrap 逐字节保留、不叠加 `Dev` 后缀）；最终 userData 经守卫拒绝 Cherry Studio 默认 profile（`Cherry Studio` 与 `CherryStudio` 双名保护，IDENTITY-006） |
| IndexedDB / localStorage | 位于各自 profile 内；数据库名 `CherryStudio` 与 key `persist:cherry-studio` 为源兼容契约（§6），隔离来自 profile/session 而非改名 |
| Session / partition | L2 导入沿用隔离 `session.fromPath()` 源 profile（sqlite-migration.md Phase 4 / A-8）；Cherry Chat 正常运行 profile 与导入源 profile 永不混用 |
| 协议注册 | `cherrychat://` 仅由 Cherry Chat 注册；`cherrystudio://` 保持默认构建注册；同一 macOS 主机可同时注册两个 scheme，互不覆盖 |
| 更新 feed | Cherry Chat 不消费 Cherry Studio feed（IDENTITY-004） |
| 应用产物 / 名称 | bundle ID、artifact 名、菜单/Dock 名均由 flavor 身份派生，默认构建不变 |

> **Phase A 落地**：userData 解析与拒绝守卫实现于 `packages/shared/config/userData.ts` + `src/main/utils/init.ts`（`initAppDataDir()`，由 bootstrap 在应用早期调用）；协议注册按 flavor scheme（ProtocolClient.ts:16）；updater 与 assistant release-feed 门（IDENTITY-004）。聚焦测试覆盖 19 个 `initAppDataDir()` 直连场景（init.test.ts）。
> **Phase C 落地**：显式 `--user-data-dir=<path>` 为最高优先级且逐字节保留（packaged/dev 均生效；dev 下不再叠加 `Dev` 后缀，config.ts:10）；IDENTITY-006 守卫在最终 userData 上运行，保护 `Cherry Studio` 与 `CherryStudio` 两个默认 profile 名（`CHERRY_STUDIO_PROTECTED_USER_DATA_NAMES`，userData.ts:138）；packaged E2E 在真实打包产物上验证隔离与真实 profile 零改动（§8 P-C 行）。

---

## 6. 源兼容例外（Source-Compatibility Exceptions，IDENTITY-003）

以下标识符是 **L2 兼容导入的源格式契约**，不是目标应用身份；不得因身份引入而改名或删除。

| 标识符 | 用途 | 证据 |
|---|---|---|
| Dexie 数据库名 `CherryStudio` | L2 导入源 IndexedDB 的识别与读取；现有 Dexie files catalog 运行时架构名（post-closure，LOCK-DOC-1） | src/renderer/src/databases/index.ts:32 |
| localStorage key `persist:cherry-studio` | redux-persist 持久化（key `cherry-studio`，version 215）；L2 源 Local Storage 导航投影读取 | src/renderer/src/store/index.ts:84；src/renderer/src/windows/chatImport/entryPoint.ts:58 |
| `cherrystudio://` deep link 格式 | 默认构建既有协议；源数据/现有功能引用，非 Cherry Chat 目标身份 | src/main/services/ProtocolClient.ts:16 |
| 其他 L2 导入管线消费的源格式标识符 | 兼容契约（如源 IndexedDB file-origin 映射、投影格式） | LOCK-D2：src/main/services/chatDbImport/importDataPlane.ts:10、tests/e2e/utils/disposable-dev-origin-seed-zip.ts:43；LOCK-E3：tests/e2e/utils/disposable-seed-zip.ts:339；LOCK-PROD-2：src/renderer/src/windows/chatImport/entryPoint.ts:54、src/main/services/chatDbImport/navigationProjection.ts:9 |

**边界**：若实现期发现清单外的新源格式标识符，须按兼容契约追加记录（§11 开放项），不得静默改名。

---

## 7. 更新与发布策略（Updater / Release Policy，IDENTITY-004）

- 默认 Cherry Studio 构建维持既有更新配置与 feed 不变。
- Cherry Chat 在**独立 release endpoint 存在前**：updater **禁用或显式不配置**——不得复用或指向 Cherry Studio 的 generic feed / release 渠道。
- 独立 release endpoint 的落地是开放后续（§11），不构成本 ADR 的决策变更。

> **Phase A 落地**：IDENTITY-004 已实现——`appIdentity.updaterEnabled`（identity.ts:107）在 `AppUpdater.checkForUpdates()`（src/main/services/AppUpdater.ts:296）与 assistant MCP `checkUpdate()`（src/main/mcpServers/assistant.ts:587）双重把关；cherry-chat 下零 feed/网络/analytics 调用（AppUpdater.identityGate.test.ts、assistant.identity.test.ts）。P-B 产物再证实：打包结果无 app-update.yml / latest-mac.yml，app.asar 烘焙 `updaterEnabled: false`。

---

## 8. macOS 优先实施阶段（Implementation Phases）

> Phase A（集中身份与运行时隔离）已完成并经独立复审核闭环 F1–F6（F7 外部服务标识符延迟处理）；Phase B（打包与构建产物）已完成并经实际打包产物证据验证（见 P-B 行）；Phase C（打包一次性 profile 隔离验证）已完成并经 packaged E2E 证据验证（见 P-C 行）；完整并行安装（AC-5）与打包环境 L2 导入（AC-6）未在本 harness 执行。

| 阶段 | 内容 | 退出准则 | 状态 |
|---|---|---|---|
| **P-A 集中身份与运行时隔离** | 集中 `appIdentity`（productName `Cherry Chat`、appId `com.jorkeyliu.CherryChat`、`cherrychat://`、home/temp/userData 派生、更新门）；显式早期 userData 解析（`Cherry Chat` / dev `Cherry ChatDev`）；Cherry Studio 默认 profile 拒绝守卫（IDENTITY-006）；updater 与 assistant release-feed 门（IDENTITY-004）；plain-Node 安全 flavor 读取；聚焦测试（19 个 `initAppDataDir()` 直连测试等） | 集中身份输入与运行时隔离由源码与聚焦测试证明；独立复审核闭环 F1–F6 | **已完成** |
| **P-B 打包与构建产物** | Cherry Chat flavor 的 packaged `.app` / bundle ID 落地（`electron-builder.cherry-chat.yml` overlay + `build:chat:mac:arm64`）；代码签名 / 公证链分离决策（§11） | 打包产物具备 Cherry Chat 身份，且不含 Cherry Studio feed / release notes（IDENTITY-004） | **已完成** |
| **P-C 并行安装与隔离验证** | packaged 一次性 profile 隔离：显式 `--user-data-dir` 优先级契约、空 profile 首启（无磁盘扫描 / 无静默迁移 / 不共享目录）、同 profile 二次实例单实例锁、真实 Cherry Studio（`CherryStudio` 实际派生名 + ADR 形式 `Cherry Studio`）/ 默认 `Cherry Chat` profile 零改动、owned 资源精确清理 | §10 中由一次性 profile harness 可验证者全部通过（AC-7）；完整并行安装（AC-5）与打包环境 L2 导入（AC-6）不在本范围 | **已完成（packaged 一次性 profile 隔离）** |
| **P-D 平台扩展（推迟）** | Windows / Linux 身份落地 | **非目标**：明确推迟（IDENTITY-005） | **推迟** |

> **Phase B 落地**：打包由 `electron-builder.cherry-chat.yml`（`extends: electron-builder.yml`，仅覆盖 flavor 自有身份键：appId/productName/protocols；`publish: null` 移除继承的 Cherry Studio generic feed，`releaseInfo.releaseNotes: null` 去除继承的发布说明）+ `build:chat:mac:arm64`（构建与打包两段均注入 `VITE_APP_FLAVOR=cherry-chat`）实现；`scripts/notarize.js` 的 `resolveAppBundleId()` 从 `context.packager.appInfo.id` 动态取 bundle ID（默认构建 `com.kangfenmao.CherryStudio` / Chat `com.jorkeyliu.CherryChat`）；`__APP_FLAVOR__` 编译期 define 经 electron.vite.config.ts（main/preload/renderer 三段）注入；有效配置语义由 scripts/__tests__/electron-builder-cherry-chat.test.ts 用**已安装 electron-builder 26.8.1 加载器**验证（extends 合并、publish 置空、releaseNotes 置空、protocol 替换、schema 校验）；OpenAPI 生成按 flavor 解析身份（scripts/generate-openapi-spec.ts `resolveSpecIdentity()`）。
> **P-B 产物证据**（`--dir --mac --arm64`，macOS arm64）：`dist/mac-arm64/Cherry Chat.app`；Info.plist CFBundleIdentifier=`com.jorkeyliu.CherryChat`、CFBundleName/DisplayName=`Cherry Chat`；CFBundleURLSchemes 仅含 `cherrychat`（无 `cherrystudio`）；输出目录无 app-update.yml / latest-mac.yml；app.asar 内烘焙 cherry-chat 身份（`com.jorkeyliu.CherryChat`、`Cherry Chat`、`updaterEnabled: false`）；产物为 **ad-hoc 签名、未公证**（TeamIdentifier=not set，无公证凭据）；打包后 Node ABI 已还原为 137（Node 24 下 better-sqlite3 内存库自检通过）。默认构建 bundle（dist 内 Cherry Studio 产物）保持 `cherry-studio` 身份。**完整并行安装（默认构建 + Cherry Chat 并发启动）与 L2 E2E 仍未验证（AC-5 / AC-6 残余）。**

> **P-C 落地（packaged E2E，macOS arm64）**：`tests/e2e/specs/identity/packaged-isolation.spec.ts` 以真实打包产物 `dist/mac-arm64/Cherry Chat.app` 对精确一次性 `--user-data-dir=<token>` 验证并**通过 1/1（约 22.6s）**：运行时 `isPackaged=true`、arch arm64；CLI userData 逐字节保留（renderer `getAppInfo()` 与主进程 probe 双通道一致，且不含 `Cherry Studio`/`CherryStudio`/`Cherry Chat` 任一路径段）；主窗口标题精确为 `Cherry Chat`（IDENTITY-002）且 React 根挂载；关闭后 `chat.db`（自动创建时）topics/messages/message_blocks 全为 0（空首启）；同 profile 二次实例 exit 0 且首实例存活（单实例锁）；真实 `<appData>/CherryStudio`（Electron 实际派生名）、ADR 形式 `Cherry Studio`、默认 `Cherry Chat` 三个 profile 的指纹（存在性 + 有界元数据）前后一致——零创建/零修改/零删除（IDENTITY-006）；owned 临时根精确清理、无进程残留。守卫现同时保护 `Cherry Studio` 与 `CherryStudio` 两个默认 profile 名（userData.ts:138）。正常应用启动可能把 `cherrychat://` 注册到 dist 应用，但 harness 未调用任何协议 URL。该测试后 Node ABI 还原为 137。**本 harness 未执行 L2 ZIP 导入，也未并发启动默认 Cherry Studio 与 Cherry Chat 两个打包应用（AC-6 / AC-5 残余）。**

---

## 9. 安装 / 迁移 / 回滚 Runbook

> **状态**：P-B 打包已完成（产物具备 Cherry Chat 身份，ad-hoc 签名、未公证，§8）；P-C 打包一次性 profile 隔离已验证（§8 P-C 行）。以下安装步骤中的「同机并行安装」与「L2 导入」尚未以两个打包应用并发启动实测——仍为计划行为。

**安装（macOS arm64 并行）**
1. 分别构建默认构建与 Cherry Chat flavor（不同 bundle ID / 产物名）。
2. 安装两者于同一 macOS arm64 主机：各自 App 目录、各自独立 userData、各自协议注册。
3. Cherry Chat 首启以**自身空 profile** 启动——无静默迁移、无磁盘扫描（IDENTITY-006）。

**迁移（用户主动，一次性）**
1. 用户在 Cherry Chat 中选定一个 Cherry Studio ZIP 备份 → 走 L2 兼容导入（sqlite-migration.md Phase 4 / 6 语义；replace-all；promotion 保留回滚快照）。
2. 迁移是显式用户操作，绝无启动时自动迁移。

**回滚**
1. 应用级：删除 Cherry Chat 应用及其独立 userData；Cherry Studio profile 不受影响（不被删除/修改，IDENTITY-006）。
2. 导入级：沿用 L2 promotion 回滚快照与恢复矩阵（sqlite-migration.md §10）。

---

## 10. 验收标准（Acceptance Criteria）

| # | 验收标准 | 状态 | 证据（Phase A/B/C） |
|---|---|---|---|
| AC-1 | 默认 Cherry Studio 构建身份（productName / appId / 协议 / userData 派生 / 更新配置）不变 | **已完成** | identity.test.ts 逐项断言默认 flavor 锁定值；init.test.ts 证明默认 userData 保持 Electron 派生（IDENTITY-001）；AppUpdater.identityGate.test.ts 证明默认 updater 走正常 feed 流程；electron-builder-cherry-chat.test.ts 证明默认配置逐字节未改且 feed 保留 |
| AC-2 | Cherry Chat flavor 以产品名 `Cherry Chat`、bundle/app ID `com.jorkeyliu.CherryChat`、URL 协议 `cherrychat://` 构建 | **已完成** | 身份输入集中定义并经测试锁定（identity.test.ts）；协议按 flavor 注册（ProtocolClient.ts:16）；`--dir --mac --arm64` 产物 `dist/mac-arm64/Cherry Chat.app`：CFBundleIdentifier=`com.jorkeyliu.CherryChat`、CFBundleName=`Cherry Chat`、scheme 仅 `cherrychat`（无 `cherrystudio`）；app.asar 烘焙 `Cherry Chat` / `com.jorkeyliu.CherryChat`（updaterEnabled=false） |
| AC-3 | Cherry Chat userData/profile 独立派生，绝不解析到 Cherry Studio profile | **已完成** | `initAppDataDir()` 19 个直连测试：packaged/dev 均解析到 `Cherry Chat`（dev 后缀 `Dev`）；配置路径 flavor 隔离；解析到 Cherry Studio 默认 profile 时抛 IDENTITY-006（init.test.ts、userData.test.ts） |
| AC-4 | Cherry Chat 不消费 Cherry Studio updater/release feed；独立 endpoint 前 updater 禁用或显式不配置 | **已完成** | `updaterEnabled=false`（identity.ts:107）；AppUpdater 与 assistant MCP 门在 cherry-chat 下零 feed/网络/analytics 调用（AppUpdater.identityGate.test.ts、assistant.identity.test.ts）；P-B 产物无 app-update.yml/latest-mac.yml，`publish` 解析为 null |
| AC-5 | macOS arm64 并行安装验证通过（两应用并存、profile 隔离、scheme 互不覆盖） | **部分完成** | packaged E2E 已实测真实打包 Cherry Chat 应用（isPackaged=true、arm64）以精确一次性 profile 启动、空首启、同 profile 单实例锁、真实 Cherry Studio/默认 Cherry Chat profile 零改动（packaged-isolation.spec.ts）；bundle scheme 非重叠（P-B 产物 Info.plist 仅含 `cherrychat`）与同 profile 锁为部分证据。**完整并行安装证明需实际 Cherry Studio 与 Cherry Chat 两个打包应用并发启动——本 harness 未执行** |
| AC-6 | 源兼容标识（Dexie `CherryStudio`、`persist:cherry-studio` 及其他）完整保留，L2 导入可读 | **部分完成** | 标识符未被身份实现改名，默认值断言保留（identity.test.ts）；「L2 导入可读」由既有 L2 管线（sqlite-migration.md）支撑。**Phase C packaged harness 未执行 L2 ZIP 导入**——打包环境下的 L2 导入端到端仍未实测 |
| AC-7 | 无自动磁盘扫描、无静默迁移、无共享 userData；Cherry Studio profile 不被删除/修改 | **已完成（packaged 一次性 profile 范围）** | 源层：拒绝守卫不共享 userData；init.test.ts 合成根守卫断言仅触碰 mock 路径、默认 profile 零 setPath。产品行为（P-C packaged E2E）：空 profile 首启零数据（topics/messages/message_blocks=0）；真实 `CherryStudio`（Electron 实际派生名）、ADR 形式 `Cherry Studio`、默认 `Cherry Chat` 三个 profile 指纹前后一致零改动；owned 资源精确清理（packaged-isolation.spec.ts） |

---

## 11. 风险与开放后续（Risks / Open Follow-ups）

| 项 | 类型 | 说明 |
|---|---|---|
| 独立 release endpoint | Open | Cherry Chat updater 启用前置条件；落地前 updater 保持禁用/不配置（IDENTITY-004） |
| Windows / Linux 身份落地 | Deferred | 明确推迟（IDENTITY-005），不做平台承诺 |
| flavor 具体实现方式 | 已落地 | 身份/flavor 选择为构建期 `VITE_APP_FLAVOR`（identity.ts:28/137）；打包以 `electron-builder.cherry-chat.yml` overlay 落地（§8），§4 契约不变 |
| 源兼容标识符清单 | Open | 实现期需精确枚举全部被 L2 消费的源格式标识符并追加记录（§6） |
| `cherrychat://` deep link 语义 | Open | 导航/处理契约（对应 `cherrystudio://navigate/…` 语义）需定义；本 ADR 只锁定 scheme 本身 |
| 代码签名 / 公证 | Open | Cherry Chat bundle ID 的签名/公证链与默认构建分离，落地前需显式决策；P-B 产物为 ad-hoc 签名、未公证，**不构成发布就绪** |
| macOS arm64 并行安装实测 | Open | packaged 一次性 profile 隔离已实测（§8 P-C）；但实际 Cherry Studio 与 Cherry Chat 两个打包应用并发启动仍未执行——bundle scheme 非重叠与同 profile 锁仅为部分证据（AC-5 残余） |
| L2 打包环境导入实测 | Open | Phase C packaged harness 未执行 L2 ZIP 导入；打包产物 + 源兼容标识完整前提下 L2 导入端到端仍未在 packaged 环境实测（AC-6 残余） |

---

## 12. 关联文档

- `docs/sqlite-migration.md` — L1/L2/L3 运行时与导入演进记录；本文档不修改其历史事实与 Phase 0–6 状态。
- 本文档治理应用身份；`sqlite-migration.md` 治理 SQLite 运行时、L2 导入、L3 备份/恢复。身份问题以本文档为准。
