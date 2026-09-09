# SQLite 运行时迁移与 Cherry Studio 兼容导入 — 个人 fork 演进记录（面向未来独立 Cherry Chat）

> **文档状态**：Phase 0–5 Done（Phase 5 各子阶段已提交至分支）；Phase 6 Done（实现 + 验证完成）。Phase 0–3 完成；Phase 4.0 Done on macOS arm64；Phase 4.1 Done；Phase 4.2 Done；Phase 4.3 Done（已提交/已推送至迁移分支 `85603d0fd5`）；集成同步门 Baseline Sync Gate Done（integration `05a401b711` 已集成同步，已验证）；Phase 4.4.0 Done；Phase 4.4.1 Done；Phase 4.4.2 Done（已提交 `3a81557ac6`）；Phase 4.4.3 Done（commit `f6a6741b8e`；独立审计 pass + 全量验证通过）。Phase 5 Done（5.0–5.4 全部完成；5.1A 已提交 `6fa5ff5ef9`；5.1B 已提交 `e44e413f30`；5.2A 已提交 `e9de29ff97`；5.2B 实现 + 审计 + 验证完成；5.3 已提交 `b81a35c054`；5.4 feature commit `6c250f19a2` + docs commit `6b2f140955`；最终仓库验证 Node v24.12.0 ABI 137 / pnpm 10.27.0：311 文件 / 6976 通过 / 72 跳过 / 0 失败）。Phase 6 Done（6.0–6.4 全部完成：L2/L3 产品合同实现、安全/可靠性加固、隔离 import renderer 保留（LOCK-6023）、遗留清理与文档收尾；实现 + 验证通过）。**Post-closure L2 产品闭环最终实现完成（2026-08-04，非 Phase 7）**——确定性全出现消息身份（`(outerTopicId, legacyMessageId)` → `cherry-chat:l2-message-id` 帧 → `l2m1:`+64 lowercase SHA256，精确真实 artifact 129150/129150 零碰撞）、规范化残余六类 exact-once count-only、L2/fetch 大块边界、candidate-only FTS 原子重建（search_projection 第 14 verifier 维度）、导入回收站五天保留（2707/2704/3）、post-close helper/observer test-only 硬化；Node latest-source 335 files / 7901 tests passed / 75 skipped / 0 failed（final authoritative；user-source 7890/74 为历史证据）；Electron 精确真实 spec 1/1（6m48s）候选 2707/129150/158441/13/39/4158、全链 promoted、ZIP 指纹不变；实现与 E2E 已本地提交（`26c7190333` feat(import)：complete L2 Cherry Studio migration flow / `1c2c70a3dd` test(import)：add end-to-end migration coverage）；本节文档收尾提交后 HEAD = 本节文档收尾提交（哈希见当前 git history）/ 远程 tip `3a64da6020` 不变 / 本地 ahead 11（pre-existing 8 + 本次 closure 3）/ 工作树 clean / 无 push/PR。**Phase 6 交付收尾（closure，非 Phase 7）本地完成（2026-07-31）**：B-class `import-cherrystudio-genuine.spec.ts` 1/1 PASS（fresh ABI145 build 后精确标准 Playwright 命令；host ABI137 已恢复；LOCK-MD2/4）；A-class `import-cherrystudio.spec.ts` 保持历史证据、未重跑；六个交付阻塞项修复（LOCK-MD5）；本地 gates 全 PASS（Node v24.12.0 / pnpm 10.27.0；CI=true lint 0 errors / CI=true test 312 文件 / 7009 通过 / 72 跳过 / 0 失败；LOCK-MD6）；**push/remote CI 事实（LOCK-MD8，2026-07-31 post-push）**——origin 分支 `jorkey/refactor/sqlite-migration` 已推送（closure push 点 remote SHA `89803503fc...`），upstream tracking `origin/jorkey/refactor/sqlite-migration` 已建立（branch URL `https://github.com/JorkeyLiu/cherry-studio/tree/jorkey/refactor/sqlite-migration`）；其后 push-facts docs commit `3a64da6020`（父为 `89803503fc`）也已推送，**当前远程 tip = `3a64da6020`**；GitHub Actions runs for this branch = 0——**未运行/无 run**（非失败、非 green CI）；`.github/workflows/ci.yml` push trigger 仅 `main`/`v1`，未创建 PR、未手动 dispatch。E2E 仍为本地标准 Playwright 证据。**当前累积 diff 三分类（2026-08-04 三 commit 收尾后更新）**：① 远程已推送 tip `3a64da6020`（不变）；② 本地已提交、未推送共 11 个 commit——pre-existing 8 个（`1fc19f590c`/`6b48d33e72`/`6d2db496b1`/`b23c4ff4cb`/`81a438b208`/`cbc19db426`/`dbabae7eb8`/`4dc3912840`（docs(migration)：record native ABI and import validation））加上本次 closure 3 个（`26c7190333` feat(import)：complete L2 Cherry Studio migration flow / `1c2c70a3dd` test(import)：add end-to-end migration coverage / 本节文档收尾提交（哈希见当前 git history））；③ 本节文档收尾提交后工作树 clean。② 全部 11 个本地未推送 commit 均无远程 CI（LOCK-MD8：GitHub Actions runs for this branch = 0；ci.yml push trigger 仅 `main`/`v1`；无 PR、无手动 dispatch；详 §17 远程 CI 行）；无 push / 无 PR / 无远程 CI 变更（LOCK-GIT）。详见「Phase 6 交付收尾 / 最终交付证据」
>
> ✅ **Post-closure L2 attachment/file 兼容性修复完成（2026-08-05，非 Phase 7）**：L2 replace-all 现导入**物理 `Data/Files` payload + 源 Dexie `files` catalog**（candidate Files 目录 + `files-catalog.json` handoff + promotion 后单 Dexie 事务 apply）；文件异常按用户批准合同分级——**archive fatal（整批拒绝）/ reference degraded（单附件降级不阻断聊天导入、聚合计数）/ optional catalog/orphan（导入/跳过/显式 reference-backed canonicalization）**（LOCK-DOC-3）；degraded 引用块写入 import-only `l2AttachmentUnavailable` marker，UI 显示 unavailable 占位、不触发缺文件错误（LOCK-UI-1…6）。promotion 升级为 **v2 三 artifact durable journal**（candidates-ready → snapshots-ready → db-installed → files-installed → catalog-pending → catalog-applied → replacement-verified；v1 兼容；全 old / 全 new 收敛；promotion 开始后短时不可取消）。catalog apply 前不开放普通 UI（recovery-only 窗口 + 有界重试 + terminal repair surface，LOCK-PROMO-7 / LOCK-F2）。L3 备份现包含 live `Data/Files` + IndexedDB catalog、排除全部 promotion artifacts；`skipBackupFile=true` 排除 Files 但保留 catalog（不对称，LOCK-L3-4）。Data/Files 独立预算 + 流式 SHA-256/CRC-32 + 磁盘预检（1.30 GiB 级真实备份验证，不声明无限制支持，LOCK-DOC-5）。**验证证据（LOCK-DOC-7）**：合成附件标准 E2E（fresh build，final-source）**1/1（约 1m57s）**；真实 opt-in 大 ZIP（final-source）**1/1（4m36s，1.30 GiB 级；聚合 candidate topics **2707** / messages **129150** / blocks **158441** / file refs **4158**、active **2704** / deleted **0**；integrity/FK PASS；ZIP 不可变 boolean）**；recoveryV2 **236,196 惰性组合 47/47**、约 25s、主进程峰值约 341 MiB / 合计约 775 MiB（被强退的运行明确非证据）；**全量最终 gates 完成（final-source，Node24.12 ABI137 / pnpm 10.27.0）**：`pnpm format` exit 0（1882 files、1 fixed 后稳定）；`CI=true pnpm lint` exit 0（0 errors；85 ESLint + 4 oxlint known warnings；typecheck/i18n/format PASS）；`CI=true pnpm test` exit 0（357 files passed / 1 file skipped；8647 passed / 75 skipped / 0 failed / 127.09s）；Electron final（ABI145）：`native:rebuild:electron` PASS、`pnpm build` PASS（12.5s）；**无 commit / push / 远程 CI 声明（LOCK-DOC-8）**。Phase 0–6 Done 状态不变。详见「Phase 6 交付收尾后发现：L2 attachment/file 兼容修复」。
>
> ✅ **集成同步门（Baseline Sync Gate，Done/已合并/已验证）**：integration 分支（`05a401b711`）已集成同步进 migration 分支（pre-merge HEAD `5d50499e80`）；合并自动解决、无兼容性编辑；审计无阻塞/无代码发现，验证全部通过（format 无改动；lint exit 0 / 112 known warnings；typecheck 通过；`pnpm test` 265 文件 / 5664 通过 / 72 跳过 / 0 失败；聚焦测试 201 renderer + 822 chatDb/import）。Phase 4.4 既有架构未改变；合并后统一的 Renderer/context/type/Redux 结构已作为 Phase 5 实施基线。详见 Section 9「集成同步门（Baseline Sync Gate）」与决策日志。
> **分支**：`jorkey/refactor/sqlite-migration`
> **最后更新**：2026-08-16
> **Owner**：Personal fork（jorkeyliu）
>
> ⚠️ **ADR-8 策略更正（2026-07-20）**：Phase 4+ 的产品策略已更正为**外部应用兼容性导入**模型。原 in-place Dexie→SQLite shadow/cutover 模型已正式废弃。详见 Section 6 A-8。
>
> ✅ **Post-closure L2 dev-origin 兼容性实现完成（2026-08-02）**：精确 `http://localhost:5173` dev-origin 已在 L2 导入管线中实现（LOCK-DEV-1…8）。Chromium 41.2.1 自然将精确 `http://localhost:5173` 映射为 `IndexedDB/http_localhost_5173.indexeddb.leveldb`，与 `file://` origin 隔离。Main intake 分类精确 file__0/dev 映射并在 IPC/窗口/candidate 之前拒绝不支持/歧义/多个 origin。Renderer 验证精确 dev origin/path/no-search/no-hash；最终验证重构 application-owned exact URL fields 而非接受任意 URL 输入。Dev E2E PASS 1/1 51.2s；genuine file-origin PASS 1/1 53.4s。Phase 0–6 Done 状态不变；此为 closure 后兼容性实现，非 Phase 7。详见「Phase 6 交付收尾后发现：L2 dev-origin 兼容性缺口（已实现）」。
>
> ✅ **Post-closure L2 explicit-undefined JSON wire 兼容性修复完成（2026-08-02）**：L2 导入管线 renderer-boundary JSON wire 兼容边界已修复（LOCK-N2/N3/N5/N6/N8/N11 + LOCK-C2/C3/C4 + LOCK-F2/F3）。IndexedDB structured clone 保留显式 undefined own-properties；JSON wire 不允许 undefined；依赖中立工具 `src/renderer/src/utils/jsonWire.ts`（cloneForWire）递归省略 undefined 对象属性使可选 absent/undefined 等价，`SqliteMessageDataSource` 复用，import 页行在 `entryPoint.ts` Dexie toArray 后、IPC 前统一归一化；数组 undefined 与一切 exotic/non-JSON 值仍被拒绝；Main/shared validators 未放宽。Dev-origin E2E PASS 1/1 55.6s；genuine file-origin E2E PASS 1/1 51.8s；13/13 explicit undefined own-properties 经 Chromium IndexedDB readback 存活（hasOwnProperty/valueIsUndefined 均 true）。**原始真实用户 dev ZIP（native110/logical11、25 topics、candidate init 后 topics[0].messages[0].mentions undefined 失败）为历史失败点（失败链第 ① 步）；该原始 ZIP 已由导入 harness 重跑 PASS（1/1，38.9s，fresh ABI145 build），历史失败链 explicit undefined → false shared-ref cycle → topicId mismatch → orphan block strict rejection → approved canonicalizations → PASS 以 PASS 终结（LOCK-OWN-3 / LOCK-BLOCK-3 已履行）**；全量最终验证完成（Node v24.12.0 ABI137 / pnpm 10.27.0）：`pnpm format` exit 0（1803 files，4 个预期文件首次 pass 被格式化、二次 pass clean）；`CI=true pnpm lint` exit 0 / 0 errors / 76 oxlint + 4 ESLint pre-existing warnings / node/web/aicore typecheck + i18n 通过；最终有效 `CI=true pnpm test` exit 0 / 318 files / 7148 passed / 72 skipped / 0 failed / 309.41s（初始全量 run 的单一 parseDataUrl <10ms timing failure 经 focused rerun 确认 flaky、由最终 clean 全量 run 取代）。Phase 0–6 Done 状态不变；此为 closure 后兼容性修复，非 Phase 7。详见「Phase 6 交付收尾后发现：L2 explicit-undefined JSON wire 兼容边界」。
>
> ✅ **Post-closure L2 遗留 Dexie 嵌入消息 topicId 归属规范化完成（2026-08-02，LOCK-OWN-1/2）**：L2 导入管线 `projectTopicsPage` 中，**外层 Topic 包含关系对遗留 Dexie 数据具备权威性**——嵌入消息 `message.topicId` 存在且为有效非空字符串但与外层 `topic.id` 不一致时，仅将该冗余投影字段规范化（canonicalize）为外层 Topic ID（投影后 `wireToMessage` 覆写，原始 JsonObject 不突变，消息**不**移动到其声称的 topic）；缺失/空/类型非法的 topicId 以及全部其他 ownership/identity 校验（重复 ID、block owner、segment/file-reference ownership）保持严格拒绝。规范化仅按提交页原子计数（`DataPlaneNormalizationStats.topicIdNormalizationCount`，Main-only、快照访问器、回滚/拒绝页不泄漏），编排器在 finalize 后**恰好一次**发出 count-only `logger.warn`（无 ID/内容/路径/源值）。Source manifest 证据与 candidate 写入以及验证器 hash 均消费同一规范化后的投影值。只读诊断：真实 ZIP 25 topics / 107 messages，**恰好 2 条有效字符串不一致**，0 条缺失/空/类型非法，无 topic 内/cross-topic 重复 message ID，两条 stale 引用均指向已存在 sibling topic；证据仅记录计数与无重复事实，不含完整 ID。**LOCK-OWN-3 已履行（2026-08-02）**：此前的原始真实 ZIP ownership 失败为历史事实（chronology 保留）；修复链完成后原始 ZIP 由导入 harness 重跑 **PASS 1/1（38.9s，fresh ABI145 build）**——topicId 规范化恰好 2 条，candidate/live 计数 topics 25 / messages 107 / blocks 120 / segments 6 / memberships 16 / fileRefs 4，恰好一条合并 count-only warning。详见「Phase 6 交付收尾后发现：L2 遗留 Dexie 嵌入消息 topicId 归属规范化」。
>
> ✅ **Post-closure L2 不可达孤儿 block 规范化完成（2026-08-02，LOCK-BLOCK-1/2/3）**：L2 导入管线 `projectBlocksPage` 在**源投影边界**跳过不可达孤儿 `message_blocks` 行——当且仅当 (a) 该 block id 不出现在任何已导入 message.blocks[] 注册表（`blockOwnerById` 无 owner）**且** (b) 该行声称的 `messageId` 不在任何已导入 message 中（`messageTopicById` 无该 message）。跳过发生在源页投影时（**绝不写入后再 SQL 删除**）；被跳过的行不产生任何 MessageBlockData / file reference / manifest 行 / writer 插入 / seen 标记。声称已存在 message 的未引用行仍为严格 `OWNERSHIP_MISMATCH`；引用的 owner 不匹配、重复 block ID（含被跳过孤儿，页内/跨页，经事务性 source-seen registry）、cross-message 引用、finalize 时缺失引用 block 全部保持严格。跳过计数 Main-only（`DataPlaneNormalizationStats.unreachableBlockSkipCount`，按页 delta、仅在成功提交后合并），编排器在 finalize 后**恰好一次**发出 count-only 聚合 warning（每非零类别一条，或两类别均 >0 时一条合并 warning；无 ID/内容/路径/源值）。SourceReadStats.blockRecordCount 保持 125（源行分页），CandidateImportStats.blockCount / import manifest / block hashes 保持 120——manifest 与 verifier 自动 reachable-only（被跳过的行从不 staging）。只读诊断精确聚合：25 topics / 107 messages；嵌入引用 120 个不同 id；源行 125；120 个引用各恰好一次且 messageId 匹配；**5 个未引用孤儿全部声称不存在的 messageId**；0 个无效 id / 重复行/引用 / wrong-owner / multi-message 引用 / 缺失引用 block。无 archive/schema 变更。**LOCK-BLOCK-3 已履行（2026-08-02）**：此前 block-orphan ownership 拒绝为历史事实（chronology 保留）；修复链完成后原始 ZIP 由导入 harness 重跑 **PASS 1/1（38.9s，fresh ABI145 build）**——source blocks 125 / skipped 5 / candidate blocks 120，无孤儿/重复/cross-topic 链接，ZIP 不可变（size 1056109、mtime/inode/mode 不变）。详见「Phase 6 交付收尾后发现：L2 不可达孤儿 block 规范化」。
>
> ✅ **Post-closure 原始真实 ZIP 重跑 PASS（2026-08-02，LOCK-OWN-3 / LOCK-BLOCK-3 履行）**：原始真实用户 ZIP 经导入 harness 在 fresh Electron ABI145 build 后重跑 **PASS 1/1（38.9s）**。status chain discovering→candidate-ready→verified-candidate→promoting→finalizing；candidate/live 计数 topics 25 / messages 107 / blocks 120 / segments 6 / memberships 16 / fileRefs 4；source blocks 125 / skipped 5（不可达孤儿）；topicId normalized 2；**恰好一条合并 count-only warning**；original PID exit / relaunch exact-token 清理；`integrity_check` ok / `foreign_key_check` 空；无 orphan parent / 重复 / cross-topic 链接；snapshot（topics 2 / messages 1 / blocks 1）保留 baseline 且排除导入源；journals/staging 无残留；candidate shells 空；ZIP / binding（ABI 145，hash `48191d9b…`）/ git 全部未变。ZIP 以隐私安全角色描述（不记录绝对用户路径）；不可变证据：size 1056109、mtime/inode/mode 不变（MD5 一致，按既有证据风格）。历史失败链以 PASS 终结：explicit undefined → false shared-ref cycle → topicId mismatch → orphan block strict rejection → approved canonicalizations → **PASS**。LOCK-OWN-3 / LOCK-BLOCK-3 仅对本 artifact 履行；strict residuals 保持严格；canonicalization 仅限 L2 导入管线。**无远程 CI 声明；未 commit / 未 push（2026-08-02 当日快照；其后部分证据已本地提交 `1fc19f590c`/`6b48d33e72`/`6d2db496b1`，其余仍为未提交工作树，均未推送；三分类见 §17 远程 CI 行）**。详见「Phase 6 交付收尾后发现：L2 explicit-undefined JSON wire 兼容边界 / topicId 归属规范化 / 不可达孤儿 block 规范化」各小节最终验证证据。
>
> ✅ **最终交付验证完成（2026-08-03，latest-source authoritative closure）**：在最新源上完成最终交付验证——`native:rebuild:node` exit 0（独立 Node ABI137 SQL PASS）；`pnpm format` exit 0 无改动；`CI=true pnpm lint` exit 0 / 0 errors / 76 oxlint + 4 ESLint pre-existing warnings / node/web/aicore typecheck + i18n 通过；`CI=true pnpm test` exit 0 / **319 files / 7274 passed** / 72 skipped / 0 failed / 449.99s（active final closure；2026-08-02 explicit-undefined 318/7148 与 staged-validation 319/7230 保持为历史计数，时间顺序保留）；`native:rebuild:electron` exit 0（独立 Electron 41.2.1 ABI145 SQL PASS）；`pnpm build` exit 0 / built 9.02s；标准 E2E ordinary-chat 1/1 37.5s / genuine 1/1 67.5s / dev-origin 1/1 59.7s；原始真实 ZIP harness latest build PASS 1/1 **41.9s**（candidate/live 25/107/120/6/16/4；topicId normalized 2 / orphan skipped 5 / 恰好一条合并 count-only warning；integrity/FK/snapshot/relaunch/cleanup PASS；ZIP 未变：size 1056109 / mtime / inode / mode 不变；final ABI145 hash `48191d9b…`）；**最终 node_modules 状态 Electron ABI145**；远程 CI 三分类与既有精确 provenance 完全一致（无新 commit/push/PR 声明）。详见「§17 最终交付验证（2026-08-03）」。
>
> ✅ **Post-closure L2 产品闭环最终实现完成（2026-08-04，非 Phase 7）**：确定性全出现消息身份——源 tuple `(outerTopicId, legacyMessageId)`，精确二进制帧 magic `cherry-chat:l2-message-id` + version `0x01` + `uint32be` UTF8 长度+字节，目标 `l2m1:` + 64 位小写 SHA256；精确真实 artifact **129150/129150 条消息全出现、零 tuple/派生/legacy 碰撞、顺序无关**；同 topic askId 确定性重映射；16 条 dangling askId 保留原值、不解析、碰撞防护；manifest/hash/writer/verifier canonical。规范化残余：absent-topic/all-members-absent segments 跳过（2 rows/4 memberships）、unembedded existing-owner block 跳过防内容复活（1）、absent-owner 孤儿保持既有行为、strict 冲突保持严格；规范化统计扩展为**六类 exact-once count-only 类别**（Main-only、finalize 后恰好一次 count-only warning；已知计数以 closure/聚焦测试证据标注，**不声称 final run 未发出的逐类别计数**，LOCK-DOC-3）。L2/fetch 大块边界：8MiB/string、16MiB/row、64MiB/page/result、depth20/array100k；generic 1MiB 不变；精确 artifact 3 行 >1MiB（1 orphan、2 reachable）、max 字符串约 2.67MB、reachable 导入 orphan 跳过。FTS：migration 003 派生触发器/表 **candidate-only 延迟** + seal 前**一次原子重建**（rebuild ~85ms @10k vs 此前每页超线性 16–41s/page）；**search_projection 为第 14 verifier 维度** + 只读 gates、精确有序 multiset parity、结构性基准 ~103ms/page；candidate 路径隔离/生命周期硬化。导入回收站：源 deletedAt 保留；Main-only `l2TrashRetentionStartedAt` overflow marker 每导入一次、置于 manifest/writer 前；purge 生效 max(deletedAt, 有效 marker)、**自导入起五天**；restore 清 marker；invalid 回退 count-warning；wire 剥离 marker；最终精确 artifact SQLite **2707** / active nav **2704** / deletedTopics **3**。post-close helper/observer（test-only）硬化：payload-aware 保留状态历史、typed 批量只读验证 ≤60s 动态 deadline、精确 integrity/FK/six counts/deletedTopics、snapshot strict、隐私。导航/投影/重启/选择性 ZIP handoff 合同保持，最终合成 E2E 通过。**最终验证**：Node **latest-source**（Node24.12 ABI137，2026-08-04 最终序列）——`native:rebuild:node` exit 0（ABI137 SQL PASS）；`pnpm format` exit 0（1 个文件首次 pass 被修复、二次 pass clean，身份未指明）；`CI=true pnpm lint` exit 0 / 0 errors / **81 oxlint + 4 ESLint pre-existing warnings** / node/web/aicore typecheck + i18n PASS；`CI=true pnpm test` exit 0 / **335 files（1 skipped）/ 7901 tests passed / 75 skipped / 0 failed**（user-source 7890/74 为 helper/privacy docs 前历史证据，时间顺序保留）；Electron `native:rebuild:electron` / `native:check:electron`（ABI145 SQL）/ `pnpm build`（4.18s / 14.42 wall）PASS、ordinary/genuine/dev/large **1/1**、精确真实 spec **1/1（6m48s）**（candidate topics **2707** / messages **129150** / blocks **158441** / segments **13** / memberships **39** / fileRefs **4158** / pages **365** / elapsed **136307**）、全链 promoted、integrity/FK/six counts/snapshot/**14 维**/projection/UI/reload PASS、ZIP 指纹不变（size **1393936335**、full SHA locked、inode/mode/mtime 不变）、final **ABI145**。provenance（LOCK-GIT）：实现与 E2E 已本地提交（`26c7190333` feat(import)：complete L2 Cherry Studio migration flow / `1c2c70a3dd` test(import)：add end-to-end migration coverage）；本节文档收尾提交后 HEAD = 本节文档收尾提交（哈希见当前 git history）/ 远程 tip `3a64da6020` 不变 / 本地 ahead 11（pre-existing 8 + 本次 closure 3）/ 工作树 clean；无 push/PR、远程 CI 无新 run。Phase 0–6 Done 状态不变；非 Phase 7。详见「Phase 6 交付收尾后发现：L2 产品闭环最终实现」与「§17 最终交付验证（2026-08-04）」。

---

> ## 顶层定位（阅读前必读）
>
> 本文档是个人 fork（jorkeyliu）的**演进记录**，该 fork 是通往**未来独立 Cherry Chat 应用 / 新仓库**的**开发载体**。当前每个阶段（自 Phase 0 起）都服务于这个独立目标，而**不是**把现有 Cherry Studio 本体就地升级为 SQLite 版本后发布。
>
> 全文中存在三条必须区分的**生命周期 / 范围**（详细边界见 Section 2「三条生命周期」）：
> - **L1 内部 SQLite 运行时演进**：个人 fork 内演进的 SQLite-authoritative 运行时（连接管理、schema migration、integrity 校验、备份协调，最终 SQLite-only runtime）。
> - **L2 Cherry Studio ZIP 兼容导入**：一次性、用户主动选择的兼容导入——用户在 Cherry Chat 中选定一个 Cherry Studio ZIP 备份导入其数据。
> - **L3 Cherry Chat 备份/恢复**：沿用现有 Cherry Studio 已有的用户侧本地/WebDAV/S3 备份与恢复产品行为，并适配 SQLite-authoritative 的 chat.db；与 L2 是不同产品语义（L2 为跨应用 ZIP 兼容导入，L3 为同应用备份/恢复），二者 UX 可复用既有组件/基础设施但不改变其独立性。底层一致性快照由 Phase 1 已集成的 better-sqlite3 online backup 机制提供，属存储层能力而非新的产品操作。
>
> **关键边界**：最终 Cherry Chat 以自身空数据启动，显式导入用户选定的 Cherry Studio ZIP；不扫描磁盘、不共享目录、不在启动时静默迁移、无就地升级语义。L2 与 L3 虽未来 UI 组件可能复用，但产品语义相互独立。
>
> **应用身份**：应用身份（默认 Cherry Studio 构建不变 / Cherry Chat flavor 的产品名、bundle/app ID、URL 协议、独立 userData/profile、源兼容标识、更新策略、macOS-first 并行安装）由独立 ADR 文档治理：[`docs/cherry-chat-application-identity.md`](./cherry-chat-application-identity.md)（决策锁 IDENTITY-001…006）。本文档的 L1/L2/L3 生命周期、Phase 0–6 状态与历史证据不受影响。

## 1. 背景与目标

Cherry Studio 当前核心聊天数据存储在 Renderer 进程的 Dexie（IndexedDB `CherryStudio`）中。

Dexie/IndexedDB **支持事务且启用 strict durability**，具备 ACID 基础能力。当前方案的结构性缺口为：

- 无 SQLite 式 integrity check（PRAGMA integrity_check）
- 无 WAL checkpoint 机制（IndexedDB 自管理，不可控）
- 无关系外键约束（仅逻辑引用，无数据库层约束）
- Main 进程无法直接读写聊天数据，IPC 成为唯一通道，无法利用 SQLite 工具链

历史曾存在 agents SQLite 子系统但已删除，留下残留配置和依赖。备份/恢复直接复制 `Data/` 目录，无数据库一致性保障。

**最终产品行为**：未来的 SQLite-authoritative Cherry Chat 是一个**独立于当前 Cherry Studio 的应用**。用户在 Cherry Chat 中通过交互（等同于当前备份恢复流程）选择一个 Cherry Studio ZIP 备份文件来导入数据。不扫描磁盘查找其他应用配置、不在启动时静默迁移、不要求两个应用共享目录。

**当前阶段目标（Phase 0–3）**：建立 Main 进程 SQLite 基础设施（连接管理、schema migration、integrity 校验、备份协调）和 command-oriented typed IPC，为最终的外部导入流程提供目标数据库和写入通道。Phase 0–3 的产出是运行时 plumbing，不是最终导入实现。

---

## 2. 范围与非目标

### 三条生命周期（范围边界）

| 生命周期 | 含义 | 对应阶段 | 产品语义 |
|---|---|---|---|
| **L1 · 内部 SQLite 运行时演进** | 个人 fork 内演进的 SQLite-authoritative 运行时：连接管理、schema migration、integrity 校验、备份协调，最终 SQLite-only runtime（Dexie 路由移除） | Phase 0–3、Phase 5 | fork 内部能力演进，为独立 Cherry Chat 提供目标数据库与写入通道 |
| **L2 · Cherry Studio ZIP 兼容导入** | 一次性、用户主动选择的兼容导入操作：用户在 Cherry Chat 中选定 Cherry Studio ZIP 备份，导入其数据 | Phase 4（4.0–4.4） | 跨应用兼容导入；replace-all 语义；非 in-place 升级 |
| **L3 · Cherry Chat 备份/恢复** | 沿用现有 Cherry Studio 本地/WebDAV/S3 备份与恢复产品流程，并适配 SQLite-authoritative 的 chat.db | Phase 6 | 同应用备份/恢复，产品语义独立于 L2（跨应用 ZIP 导入）；底层快照为 Phase 1 的 better-sqlite3 online backup 存储层机制 |

**边界约束**：最终 Cherry Chat 以自身空数据启动，显式导入用户选定的 Cherry Studio ZIP；不扫描磁盘查找其他应用、不要求共享目录、不在启动时静默迁移、无就地升级语义。L2（Cherry Studio 跨应用 ZIP 兼容导入）与 L3（Cherry Chat 备份/恢复，沿用现有产品流程并适配 chat.db）是不同产品语义，未来 UI 组件/基础设施可复用但不改变其独立性。

### 当前范围（Phase 0–3：基础设施）

- `topics`、`messages`、`message_blocks`、`topic_segments` 及必要的 file references
- 新建独立 `Data/chat.db`（A-1 Accepted），Main 进程单写
- 连接生命周期、migration 框架、integrity 校验、backup coordination
- Renderer→Main 的 command-oriented typed IPC 收口

### 最终范围（Phase 4–6：L2 Cherry Studio ZIP 兼容导入 + L1 Cherry Chat SQLite-only 运行时）

- 安全解压 Cherry Studio ZIP 到隔离临时工作区
- 通过隔离 Electron Session/Profile + 隐藏 sandboxed import renderer 读取源 IndexedDB
- 分页逻辑数据通过窄 IPC 通道传输
- 构建候选 SQLite 数据库、验证、原子替换
- Cherry Chat SQLite-only 运行时完成，Dexie 路由移除
- 沿用现有 Cherry Studio 备份/恢复产品流程（适配 chat.db）的 Cherry Chat 同应用备份/恢复，与 Cherry Studio ZIP 导入的 UX 分离

### 非目标（明确排除）

- Agent session 数据导入（out of scope）
- ~~文件内容 blob 迁移（file references 是快照，不建 canonical files 表）~~ → **已 Superseded（2026-08-05，post-closure L2 attachment/file 兼容修复，LOCK-DOC-1）**：物理 `Data/Files` payload 与 Dexie `files` catalog 现已随 L2 replace-all 一并导入（candidate Files 目录 + `files-catalog.json` handoff + promotion 后单事务 apply）；仍**不建 SQL canonical files 表**（Dexie catalog 保持权威，LOCK-FIX-1）。文件异常按 **archive fatal / reference degraded / optional catalog** 三级分类（LOCK-DOC-3），单附件降级不阻断聊天导入。详见「Phase 6 交付收尾后发现：L2 attachment/file 兼容修复」
- FTS/全文搜索
- 推断缺失的 ID、ownership、timestamp、role、status、model 等字段
- 历史逻辑格式 `data.json` / `.bak` 兼容（明确放弃）
- 静默数据修复
- Redux 配置数据迁移（settings、shortcuts、llm 等）
- Memory `memories.db` 迁移
- Knowledge `KnowledgeBase/*` 迁移
- 启动时自动扫描磁盘查找其他应用配置
- 两个应用共享目录

---

## 3. 当前数据版图

| 存储层 | 技术 | 数据 | 进程 | 状态 |
|---|---|---|---|---|
| `CherryStudio` (IndexedDB) | Dexie（支持事务，strict durability） | topics, messages, message_blocks, topic_segments, files, settings, knowledge_notes, translate_history, quick_phrases, translate_languages | Renderer | **活跃，核心聊天唯一来源** |
| `Data/Memory/memories.db` | @libsql/client | 记忆条目、向量嵌入 | Main | 可用，生命周期不完整 |
| `Data/KnowledgeBase/*/` | embedjs-libsql (LibSqlDb) | 知识库笔记、嵌入 | Main | 可用，closeAll 访问私有 client |
| `Data/agents.db` | Drizzle ORM + LibSQL | （已删除子系统遗留） | — | **无代码 owner，不可用** |
| Redux store (redux-persist) | JSON in localStorage | 全局设置、助手配置、LLM 配置等 | Renderer | 活跃，不在迁移范围 |

---

## 4. SQLite 资产盘点

| 资产 | 路径 | 状态 | 复用评估 | 问题 | 处置 |
|---|---|---|---|---|---|
| Memory memories.db | `Data/Memory/memories.db` | 可用 | 否（独立领域） | close 未接入 will-quit；初始化并发与失败清理不足 | 修复生命周期，不复用 |
| Knowledge Base | `Data/KnowledgeBase/*/` | 可用 | 否（独立领域） | closeAll 访问 `(db as any).client` 私有属性；未接入 will-quit | 修复生命周期，不复用 |
| agents.db | `Data/agents.db`（用户文件） | 不可用 | 否 | 无代码 owner；package.json scripts 指向不存在的 config | 不创建新文件；**遗留文件默认保留，由用户确认后归档或删除** |
| drizzle-kit | devDependencies | 可用 | **保留，配置指向 chat.db schema**（A-7 Accepted） | config 指向不存在的 agents 路径 | 保留并更新 config 指向 chat.db |
| drizzle-orm | dependencies | 可用 | **保留，配置指向 chat.db schema**（A-7 Accepted） | 当前无活跃 schema | 保留并用于 chat.db schema |

---

## 5. 清理清单

### 说明

本阶段为**文档阶段**，仅记录清理计划，**不执行任何实际代码删除**。所有清理项状态为 Not started。

### Group A：可立即清理（仅无运行时影响的失效 scripts / 过时文档）

| # | 项目 | 说明 |
|---|---|---|
| C-1 | `package.json` 中 `agents:generate/push/studio/drop` scripts | 指向 `src/main/services/agents/drizzle.config.ts`，该文件已不存在 |
| C-6 | `src/renderer/src/services/db/README.md` | 描述不存在的 Agent IPC 实现，需更新或删除 |
| C-8 | 过时 CLAUDE.md / README 中 agents 描述 | 仍引用已删除的 agents SQLite 框架 |

> **清理前提**：确认无其他代码或 CI 依赖这些 scripts/文档。预计零运行时影响。

### Group B：需调用链迁移后清理（涉及代码路径变更）

| # | 项目 | 前置条件 |
|---|---|---|
| C-4 | `AgentMessageDataSource` stub | 先迁调用点（DbService 路由）→ 编译验证 → 功能验证 |
| C-5 | `DbService` 中 agent-session 路由逻辑 | 同上，`isAgentSessionTopicId` 路由到 no-op stub |
| C-7 | 重复 topic ID utility（`types.ts` 中 `isAgentSessionTopicId`/`buildAgentSessionTopicId`/`extractSessionId`） | 同上，仅服务于已删除的 agent 子系统 |

> **操作顺序**：① 迁移调用链到新数据源 → ② 编译通过 + 功能回归通过 → ③ 删除 stub 和路由。
>
> **closure 状态（2026-07-31，LOCK-MD7）**：C-4 / C-5 / C-7 **仍未实现**（Not implemented），已暂缓（parked）供未来独立评估——agent runtime wiring 属 out of scope；`agents.db` 永久保留（LOCK-6024）不变；全部生命周期边界与 accepted same-user TOCTOU residual（LOCK-6031 / LOCK-6036）不变。交付收尾不重开 Phase 0–6。

### Group C：技术栈决策后处理（依赖 ADR 完成）

| # | 项目 | 决策依赖 |
|---|---|---|
| C-2 | `package.json` 中 `drizzle-kit` devDependency | A-7 已 Accepted：**保留，配置指向 chat.db schema** |
| C-3 | `package.json` 中 `drizzle-orm` dependency | A-7 已 Accepted：**保留，配置指向 chat.db schema** |

### Group D：Cherry Chat SQLite-only 运行时完成后处理（依赖 Phase 5 SQLite-only runtime 完成）

| # | 项目 | 条件 | 状态 |
|---|---|---|---|
| C-9 | Dexie `topics`/`message_blocks`/`topic_segments` 表 | Phase 5 SQLite-only runtime 完成后，Dexie 仅保留于隔离 import renderer；普通聊天路径不再访问 Dexie | **有效保留**（LOCK-6023 隔离 import renderer 保留，L2 可达要求） |
| C-10 | Renderer 直接 Dexie 访问（数十处） | Phase 5 逐步收口至 DbService→IPC，非一次性清理 | **Done（Phase 5.3）** |
| C-11 | `DexieMessageDataSource` 实现 | Phase 5 完成后从普通聊天路径移除；仅保留于隔离 import renderer 的内部实现中 | **Done（Phase 5.3 从普通路径移除；保留于 import renderer）** |
| C-13 | Phase 3.4 路由策略代码（`routingPolicy.ts`、注入策略） | Phase 5 临时验证 scaffolding，必须移除 | **Done（Phase 5.3 已移除）** |

### Group E：用户数据处理（须用户确认）

| # | 项目 | 条件 | 状态 |
|---|---|---|---|
| C-12 | 遗留 `agents.db` 用户文件 | **默认保留或提示归档；只有用户明确确认后才可删除，禁止静默自动删除** | **永久保留（LOCK-6024）**：Phase 6 不自动删除且不提示删除。Agent runtime wiring 属 out of scope |

---

## 6. 关键架构决策（ADR 短表）

| # | 决策 | 状态 | 说明 |
|---|---|---|---|
| A-1 | 新建独立 `Data/chat.db`，不复用 `agents.db` | **Accepted** | agents.db 无代码 owner，schema 不兼容，用户文件需保留 |
| A-2 | Main 进程单写，Renderer 通过 IPC 读写 | **Accepted** | 避免多进程并发写；Renderer 不直接持有 SQLite 连接；Phase 3 实现确认（ChatDbAggregateService Main 侧单写 + Preload bridge IPC） |
| A-3 | 关系化 schema（非 JSON blob 堆砌） | **Accepted** | topics/messages/blocks 显式关系；JSON 仅用于低查询扩展字段；Phase 1–2 实现确认（migration 001+002 + 5 个 Repository） |
| A-4 | Command-oriented typed IPC | **Accepted** | Renderer 不暴露 SQL 能力；Main 暴露 typed command handlers；Phase 3.1–3.3 实现确认（14 ChatDb channels + shared contracts + typed Preload bridge） |
| A-5 | ~~迁移期一次性切换 + Dexie 快照回滚~~ | **Superseded by A-8** | 原决策基于 in-place 本地 Dexie→SQLite 导入+切换模型。A-8 更正为外部应用兼容性导入模型：源数据来自用户选择的 Cherry Studio ZIP，不是当前运行时 Dexie；导入是 replace-all 而非 merge/shadow；不涉及"切换后新增数据回滚"场景 |
| A-6 | 备份策略：online backup adapter + full-operation coordination | **Accepted** | better-sqlite3 `backup()` API 封装为可替换 adapter（抽象层），`BackupManager` 协调全操作（互斥锁、staging、生产路径过滤、恢复后 integrity check）；未来可替换为 PowerSync 方案；不使用 live WAL raw copy |
| A-7 | 技术栈：better-sqlite3 + Drizzle ORM + drizzle-kit | **Accepted** | better-sqlite3 是 Node.js 生态最成熟 SQLite 驱动，同步 API，Drizzle 官方主推组合；与未来 PowerSync 集成兼容（PowerSync 首选 better-sqlite3）。@libsql/client 保留给 Memory/Knowledge 继续使用，不在本阶段统一 |
| **A-8** | **外部应用兼容性导入：隔离 Session + 候选 SQLite 构建 + 原子替换** | **Accepted (2026-07-20)** | **最终产品行为**：SQLite-authoritative Cherry Chat 是独立于当前 Cherry Studio 的应用。用户在 Cherry Chat 中选择 Cherry Studio ZIP 备份来导入。**技术路线**：安全解压 ZIP 到唯一临时工作区 → 通过 `session.fromPath(absolutePath, { cache: false })`（Electron 静态 API，非 `session.defaultSession.fromPath()`）+ 正确 origin 创建隔离 Electron Session → 隐藏 sandboxed import renderer 加载当前 Dexie schema/upgrades → 窄 import-only IPC 分页读取逻辑数据 → Main 构建候选 SQLite DB → 验证（源 vs 目标 ID/计数/字段/顺序/关系/哈希/完整性/外键/应用层抽样）→ 原子替换 live `chat.db`（失败时回滚）。**约束**：① 不扫描磁盘查找其他应用；② 不在启动时静默迁移；③ 不要求共享目录；④ 不解析 LevelDB（Main 不直接解析）；⑤ 不恢复源到目标 app 的正常 Dexie profile；⑥ 旧 IndexedDB 仅在当前 Dexie declaration/upgrades 可防御性识别并升级为结构有效的当前逻辑形态时才接受；⑦ 缺失值继承当前 Cherry Studio/Dexie 升级和读取语义，不创建 importer-specific 历史修复；⑧ 结构不可用数据被拒绝；⑨ 导入语义是 replace-all，非 merge；⑩ 在导入过程中现有 SQLite 保持 authoritative；⑪ 取消支持至最终 promotion 之前；⑫ promotion 短时不可取消，保留一个回滚快照，重开/检查 DB，成功后 relaunch。**Phase 4.0 spike 结果**（macOS arm64）：`session.fromPath()` 可行；file:// origin 为正确 origin；`IndexedDB/file__0.indexeddb.leveldb` 为观测到的 profile 映射；Dexie logical 4→native 40, 11→native 110, 12→native 120；v12 被当前 Dexie upgrades 正确拒绝；default session 隔离确认；Local Storage 非 discovery/read 必需；10/10 fresh-root 迭代通过；helper 进程回退仍为 contingency，未选用。**未验证**：Windows/Linux、真实 ZIP snapshot 一致性。**post-closure 扩展（2026-08-05，LOCK-DOC-1）**：L2 attachment/file 兼容修复将候选扩展为三 artifact（candidate chat.db + candidate Files 目录 + candidate `files-catalog.json` handoff），promotion 经 v2 三 artifact journal 协调安装、收敛全 new/全 old；单附件降级不阻断聊天导入（archive fatal / reference degraded / optional catalog 分级，LOCK-DOC-3）。详见「Phase 6 交付收尾后发现：L2 attachment/file 兼容修复」 |

> **Phase 1 前置**：A-7（技术栈）和 A-5（~~authoritative 切换方式~~，已由 A-8 替代）两个 ADR 已关闭（Accepted），Phase 1 可启动。A-5 在 Phase 1 启动时已 Accepted，后因产品策略更正被 A-8 Superseded。

| **A-9** | **Phase 4.1 平台策略：macOS-first + 运行时平台拒绝** | **Accepted (2026-07-21)** | Phase 4.0 spike 只在 macOS arm64 验证 `session.fromPath()` + 退出清理。Windows/Linux 未验证（NTFS 文件锁不能删打开的文件；`session.fromPath` 跨平台锁/缓存语义未知）。**决策**：Phase 4.1 生产代码入口处 `process.platform !== 'darwin'` → 同步抛错并明确提示，非 macOS 不开放导入功能。生产模块的清理分支**预先写好 bounded retry + EBUSY 退避 + crash-recovery scan**——macOS 也用得上（spike 已证明偶尔需要重试），未来开放 Windows 只需删一行平台拒绝 + 跑一轮 Windows spike + 可能调一两个清理退避参数。**为何现在不验 Windows**：① 功能无用户（4.2/4.3/4.4 未完成，整条管线未上线）；② 配 Windows 开发环境成本远超此轮验证价值（Node22 + pnpm + better-sqlite3 原生构建 + Electron 调试链）；③ Phase 4.4 原子替换在 Windows 文件锁下更敏感，未来 4.4 验证会稀释本轮 4.1 验证价值。**Windows Linux 化工作量**≈ 删一行拒绝 + 重跑 Phase 4.0 spike harness + 调清理参数，是确定的增量工作非返工 |
| **A-10** | **Phase 4.0 spike harness：保留至 Phase 5 后删除** | **Fulfilled/Deleted (2026-07-30)** | Phase 4.0 的 spike-only 文件（22 个：`packages/shared/phase4*.ts`、`scripts/phase4-*.sh`、`src/main/phase4-*.ts`、`src/preload/phase4-spike-preload.ts`、`src/renderer/phase4Spike.html`、`src/renderer/src/windows/phase4Spike/`、`electron.vite.config.ts` 的 `PHASE4_SPIKE=1` build gate）**在 Phase 5.4 spike gate 通过后已移除**。spike gate 结果：A pass、C1 4/4、C2a 8/8、C2b 10/10。Production imports（`src/main/services/chatDbImport/`、`src/preload/chatImport/`、`src/renderer/src/windows/chatImport/`）保留，不受影响。历史 spike 结果（session 隔离、file:// origin、版本映射等硬事实）已由生产模块重新干净实现，harness 作为回归对照基线的历史使命完成。**Phase 4.1 生产模块独立新增**（`src/main/services/chatDbImport/`、`src/preload/chatImport/`、`src/renderer/src/windows/chatImport/`），**不复用 spike 代码** |

---

## 7. 目标架构简图

### 运行时架构（Phase 5 最终态：SQLite-only Cherry Chat）

```
┌─────────────────────────────────────────────────────┐
│                   Renderer Process                   │
│                                                     │
│  ┌──────────┐  ┌───────────────────┐                │
│  │  Redux    │  │  Hooks/Components │                │
│  │  Store    │  │  (读写聊天数据)    │                │
│  └────┬─────┘  └───────┬───────────┘                │
│       │                │                             │
│       │         ┌──────▼───────┐                     │
│       │         │  DbService   │◄── (Phase 5: 直连  │
│       │         │  (IPC only)  │     SQLite, 无      │
│       │         └──────┬───────┘     Dexie 路由)     │
│                        │                             │
│  ┌─────────────────────▼──────────────────────────┐  │
│  │ Dexie 仅保留于隔离 import renderer（Phase 4）  │  │
│  └────────────────────────────────────────────────┘  │
└────────────────────────┼────────────────────────────┘
                         │ typed IPC (command)
┌────────────────────────┼────────────────────────────┐
│                   Main Process                       │
│         ┌──────────────▼───────────────┐             │
│         │  ChatDbAggregateService      │             │
│         │  (14 commands)               │             │
│         └──────────────┬───────────────┘             │
│         ┌──────────────▼───────┐  ┌──────────────┐  │
│         │ chat.db (SQLite)     │  │ Migration    │  │
│         │ authoritative        │  │ Framework    │  │
│         └──────────────┬───────┘  └──────────────┘  │
│         ┌──────────────▼───────────────┐             │
│         │ Backup Coord. (online backup)│             │
│         └──────────────────────────────┘             │
│                                                      │
│  ┌───────────────────────────────────────────────┐   │
│  │ Import Pipeline (Phase 4)                     │   │
│  │ ┌─────────────┐ ┌──────────────┐ ┌─────────┐ │   │
│  │ │ ZIP Intake  │→│ Isolated     │→│ Bulk    │ │   │
│  │ │ + Extract   │ │ Session +    │ │ Import  │ │   │
│  │ │             │ │ Import Rdr   │ │ + Verify│ │   │
│  │ └─────────────┘ └──────────────┘ └────┬────┘ │   │
│  │                                       │       │   │
│  │ ┌─────────────────────────────────────▼─────┐ │   │
│  │ │ Candidate SQLite → Verify → Atomic Swap   │ │   │
│  │ └───────────────────────────────────────────┘ │   │
│  └───────────────────────────────────────────────┘   │
│                                                      │
│  ┌─────────────────┐  ┌────────────────┐             │
│  │ MemoryService   │  │ KnowledgeSvc   │  (独立)    │
│  │ memories.db     │  │ KnowledgeBase/ │             │
│  └─────────────────┘  └────────────────┘             │
└──────────────────────────────────────────────────────┘
```

> ⚠️ **post-closure 更正（2026-08-05，LOCK-DOC-1/6）**：图中「Dexie 仅保留于隔离 import renderer」指**聊天表**（topics/messages/message_blocks/topic_segments 等）为 SQLite-only；post-closure L2 attachment/file 兼容修复后，运行时 **Dexie `files` catalog 恢复为 live 消费者**（文件浏览器 FilesPage、FileManager、OrphanCleanupService、DbService.updateFileCount 均读/写 `db.files`）——L2 导入在 promotion 的 catalog-applied 阶段以单 Dexie 事务 replace-all 填充该 catalog；聊天数据仍全部经 IPC → SQLite。详见「Phase 6 交付收尾后发现：L2 attachment/file 兼容修复」。

### 导入数据流（Phase 4）

```
用户选择 Cherry Studio ZIP
         │
         ▼
┌─────────────────────┐
│ 4.1 Secure ZIP      │  解压到唯一临时工作区
│ Intake + Extract    │  验证 ZIP 内含 Chromium IndexedDB
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│ Isolated Profile    │  session.fromPath() / isolated profile
│ + Import Renderer   │  正确 origin + 当前 Dexie schema/upgrades
│ (hidden, sandboxed) │  不恢复到正常 Dexie profile
└────────┬────────────┘
         │ narrow import-only IPC (分页)
         ▼
┌─────────────────────┐
│ 4.2 Candidate       │  Main 不解析 LevelDB
│ SQLite Bulk Import  │  构建完整候选 chat.db
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│ 4.3 Deterministic   │  ID/计数/字段/顺序/关系/哈希
│ Verification        │  integrity_check / foreign_key_check
│                     │  应用层抽样读取
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│ 4.4 Atomic          │  替换 live chat.db
│ Replace-All Promote │  失败→回滚，保留一个快照
│ (short, non-cancel) │  成功→reopen + relaunch
└─────────────────────┘
```

---

## 8. 初步目标 Schema（Draft v0 → Applied 001+002）

> 以下为表关系和关键字段规划，表达关系和约束意图，**不锁定 DDL**。待技术栈 ADR 决定后生成最终 DDL。
>
> **状态更新（2026-07-20）**：Draft v0 规划已通过 append-only migrations `001`（initial，Phase 1）和 `002`（Phase 2 schema extension）落地为 applied schema。当前 `chat.db` 运行的就是 001+002。`file_references` 表在 002 中以 block-linked 方式实现（见 Q-3 决议）；FTS 未包含（见 Q-5 决议）。

| 表 | 关键字段 | 关系 |
|---|---|---|
| `migration_state` | `key TEXT PK`, `value TEXT`, `updated_at TEXT` | — |
| `topics` | `id TEXT PK`, `assistant_id TEXT`, `name TEXT`, `created_at`, `updated_at`, `deleted_at`, `extra TEXT` (JSON) | — |
| `messages` | `id TEXT PK`, `topic_id TEXT NOT NULL`, `role TEXT`, `content TEXT`, `status TEXT`, `ask_id TEXT`, `model TEXT`, `created_at`, `sort_order INTEGER`, `extra TEXT` (JSON) | → topics(id) |
| `message_blocks` | `id TEXT PK`, `message_id TEXT NOT NULL`, `type TEXT`, `content TEXT`, `sort_order INTEGER`, `extra TEXT` (JSON) | → messages(id) |
| `topic_segments` | `id TEXT PK`, `topic_id TEXT NOT NULL`, `sort_order INTEGER`, `extra TEXT` (JSON) | → topics(id) |
| `topic_segment_messages` | `segment_id TEXT NOT NULL`, `message_id TEXT NOT NULL`, `sort_order INTEGER` | → topic_segments(id), → messages(id)，多对多 |
| `file_references` | `id TEXT PK`, `message_id TEXT`, `file_id TEXT NOT NULL`, `file_name TEXT`, `file_path TEXT`, `file_type TEXT`, `count INTEGER`, `extra TEXT` (JSON) | → messages(id) |

**设计原则**：
- 消息顺序通过 `sort_order` 显式管理，不依赖自增 ID 或插入时间
- JSON `extra` 字段用于扩展属性，避免 schema 频繁变更
- ~~文件引用首期仅迁移元数据，不迁移文件内容~~ → **已 superseded（2026-08-05，post-closure L2 attachment/file 兼容修复，LOCK-DOC-1）**：L2 导入现同时迁移物理 payload（canonical `Files/<id><ext>`）+ Dexie `files` catalog（`files-catalog.json` handoff）；SQLite `file_references` 仍为 block-linked 快照行（关系 + 查询索引），不建 canonical files 表
- 预留索引：`messages(topic_id, sort_order)`，`message_blocks(message_id, sort_order)`，`topic_segments(topic_id, sort_order)`，`file_references(message_id)`，`file_references(file_id)`

### 当前 Schema 评估与 PowerSync No-Go 边界（2026-08-16 追加）

**当前评估**：现有关系化 spine（`topics`/`messages`/`message_blocks`/`topic_segments`/`file_references` + 外键关系）对**设备本地聊天权威**而言**本质上健全**。消息顺序由应用层 `sort_order` 显式管理（app-enforced ordering），扩展/兼容性字段经 JSON `extra` 承载（兼容性 overflow），搜索由 migration 003 派生 FTS（`message_blocks_normalized`/`message_blocks_fts` + 触发器，candidate-only）作为候选加速器——FTS 为派生结构，非权威语义源。残余**兼容性债务与性能风险**仍然存在，但此处仅记录事实，不做全面风险清单；详细性能发现见 [`docs/performance-workstreams.md`](./performance-workstreams.md)，不在本文档展开。

**PowerSync No-Go 边界**：PowerSync spike No-Go 仅限定于**零生产变更的集成目标**——其 managed views / 连接所有权与现有 FTS / 触发器 / 直接 repository 访问冲突。**该结论不否定现有 SQLite 关系化设计本身**：关系化 spine 的健全性与 PowerSync 集成可行性是两件独立的事，不应将集成不兼容误读为当前关系模型的缺陷。此记录不做任何 vendor 决策。

---

## 9. 分阶段路线与状态追踪

### 状态约定

- **Phase/task**：Done / In progress / Not started / Blocked
- **ADR**：Accepted / Proposed
- **Open Questions**：Open / Resolved

### Phase 0：资产清理与基线

| 属性 | 值 |
|---|---|
| **状态** | **Done** |
| **目标** | 清理失效残留，建立可测量基线 |
| **主要任务** | Group A 清理项；确认 Dexie 数据量/分布基线；确认无其他代码引用 agents 路径 |
| **退出条件** | Group A 清理项完成；基线数据记录在案；package.json 无失效 scripts |

### Phase 1：基础设施

| 属性 | 值 |
|---|---|
| **状态** | **Done** |
| **前置** | ~~A-7（技术栈）和 A-5（authoritative 切换方式）ADR 必须先关闭~~ **Done**（A-7 Accepted, A-5 Accepted 后由 A-8 Superseded） |
| **目标** | 建立 SQLite 连接管理、migration 框架、integrity 校验 |
| **主要任务** | 实现 `ChatDbService`（连接生命周期/will-quit 关闭）；WAL/fk/synchronous/busy_timeout pragmas；inline build-safe initial migration；integrity check；restored-first-open repair gating；startup/will-quit wiring；replaceable online backup adapter（better-sqlite3 `backup()`）；BackupManager full-operation coordination（staging、filtering、production-path tests） |
| **退出条件** | ✅ `chat.db` 可创建/打开/关闭；migration 可执行；integrity 校验通过；WAL + foreign_keys + synchronous pragmas 正确设置；will-quit 正确关闭；恢复备份后首次打开自动执行 `PRAGMA integrity_check`；repair-required 时 app 继续运行但 chat DB 不可用；BackupManager 协调含互斥锁、staging、生产路径过滤；online backup adapter 可替换 |

### Phase 2：Schema 与 Repository

| 属性 | 值 |
|---|---|
| **状态** | **Done** |
| **目标** | 实现类型安全的 Repository 层 |
| **实际交付范围** | Append-only migration `002`（Phase 2 schema extension）；Main-local DTO/codec/mappers/typed cursors；`TopicsRepository`、`MessagesRepository`、`BlocksRepository`、`TopicSegmentsRepository`、`FileReferencesRepository`；block-linked file references（完整元数据快照，无 canonical files 表）；无 FTS |
| **主要任务** | TopicsRepository、MessagesRepository、BlocksRepository、TopicSegmentsRepository（含）、FileReferencesRepository；批量操作优化；分页查询（keyset pagination + dense ordering）；ownership/cascades/rollback 测试 |
| **退出条件** | ✅ 所有 Repository 单元测试通过（real better-sqlite3）；CRUD + 批量操作 + keyset pagination + dense ordering 覆盖；ownership/cascades/rollback 事务回滚测试通过；TopicSegmentsRepository 含完整 CRUD 和排序 |

### Phase 3：IPC 与 Renderer 收口

| 属性 | 值 |
|---|---|
| **状态** | **Done**（Phase 3.1 Done, Phase 3.2 Done (audit-fixed), Phase 3.3 Done, Phase 3.4 Done） |
| **目标** | 建立 Renderer→Main 的 command-oriented typed IPC |
| **主要任务** | 定义 IPC channel + command types（`packages/shared/IpcChannel.ts`）；Main 侧 handler；Renderer 侧 `SqliteMessageDataSource`；收口 DbService 路由 |
| **退出条件** | ✅ IPC 调用链路端到端可用；✅ DbService 路由可通过注入策略切换到 SQLite 数据源 |

#### Phase 3.1：Shared wire types & contracts

| 属性 | 值 |
|---|---|
| **状态** | **Done** |
| **目标** | 定义 ChatDb IPC channels、JSON wire DTO types、result envelope、runtime validation、command contracts；shared Vitest 测试覆盖 |
| **交付物** | `packages/shared/IpcChannel.ts` 新增 14 个 ChatDb channels；`packages/shared/chatDb/` 新增 types.ts、result.ts、validation.ts、contracts.ts、index.ts；`packages/shared/chatDb/__tests__/validation.test.ts`（99 tests）、`contracts.test.ts`（100 tests） |
| **约束** | 当前 Cherry Studio 运行时 Dexie 保持 authoritative（Phase 4 为外部导入，不影响当前运行时）；不基于 chat.db existence / DB initialized / migration 002 做切换；不实现 per-call SQLite→Dexie fallback；`updateFileCount(s)` 保留在 Dexie/FileManager，不纳入 IPC |
| **排除项** | 不修改 `src/preload/index.ts`；不添加 Main handler / SqliteMessageDataSource；不修改 DbService 路由；不实现 importer / shadow verification / cutover / FTS / canonical files / fallback |
| **退出条件** | ✅ 14 个 ChatDb channel 定义完整；✅ JSON wire 类型覆盖所有 MessageDataSource 命令（除 updateFileCount(s)）；✅ runtime validation 拒绝非法 JSON 值（undefined, bigint, symbol, function, NaN/Infinity, Date, Map/Set, Buffer/TypedArray, class instances, sparse arrays, cyclic, depth>20）；✅ 199 个 shared tests 通过（validation 99 + contracts 100）；✅ typecheck / format 通过 |

#### Phase 3.2：Main aggregate service & IPC handlers

| 属性 | 值 |
|---|---|
| **状态** | **Done**（含审计修复） |
| **目标** | Main ChatDb aggregate service combining five Phase 2 repositories; transaction-bound repository factory; wire adapters; 14 fixed IPC handlers with validation and error mapping |
| **交付物** | `src/main/services/chatDb/ChatDbAggregateService.ts`（14 命令实现）；`src/main/services/chatDb/repository/factory.ts`（仓库工厂）；`src/main/services/chatDb/wireAdapters.ts`（JSON ↔ Domain 适配器）；`src/main/services/chatDb/errors.ts`（错误映射 + typed aggregate errors + SQLite code inspection）；`src/main/services/chatDb/ipc.ts`（14 个 IPC handler 注册 + validateChatDbResult + malformed result containment + re-registration safety + stale-disposer ownership）；`src/main/ipc.ts` 调用 `registerChatDbIpc()`；`__tests__/aggregate.test.ts`（60 tests）、`wireAdapters.test.ts`（29 tests）、`ipc.test.ts`（27 tests）、`errors.test.ts`（39 tests） |
| **审计修复** | ① `fetchMessages` topic priming：absent topic 在同一事务内 ensure/create 并返回空数组；② `updateBlocks`/`updateSingleBlock`/`deleteBlocks`/`clearMessages` 全部使用 root-bound tx + tx-bound repos 实现原子性；③ `clearMessages` 移除语义错误的 `fileRefs.deleteByMessage()` 调用，依赖 FK cascade；④ 引入 typed aggregate errors（ChatDbValidationError 等 6 种）+ SQLite structured code inspection（SQLITE_CONSTRAINT_UNIQUE/FOREIGNKEY/BUSY/LOCKED）+ 优先级排序（typed > SQLite code > message-substring）；⑤ IPC handler 使用 `validateChatDbResult` 验证结果，malformed result 返回 valid ERR_STORAGE fallback；⑥ `handleCommand` channel 类型为 `ChatDbChannel`（通过 cast）；⑦ 错误消息 sanitize（不泄露 SQL/path/stack）；⑧ generic storage error 改为 non-retryable；⑨ 53 个新 tests（跨仓库回滚、cascade、typed error mapping、malformed result containment、topic priming） |
| **Contract 修正** | ① blocks 数组前置验证（validateJsonObjectArray）防止 TypeError；② 消息/块 patch 拒绝 identity/reparenting/sortOrder 字段（id/topicId/messageId/sortOrder）；③ 所有权一致性校验（block.messageId 匹配 message.id）；④ ERR_CONFLICT/ERR_UNAVAILABLE/ERR_BUSY 错误码；⑤ conflict 优先于 FK 检测（"UNIQUE constraint failed" 不误判为 FK）；⑥ "abort due to constraint" 不再匹配 conflict（避免 FK 误分类） |
| **约束** | 当前 Cherry Studio 运行时 Dexie 保持 authoritative（Phase 4 为外部导入，不影响当前运行时）；不基于 chat.db existence / DB initialized / migration 002 做切换；不实现 per-call SQLite→Dexie fallback；`updateFileCount(s)` 保留在 Dexie/FileManager |
| **排除项** | 不修改 `src/preload/index.ts`；不添加 SqliteMessageDataSource；不修改 DbService 路由；不实现 importer / shadow verification / cutover / FTS / canonical files / fallback |
| **退出条件** | ✅ ChatDbAggregateService 实现 14 命令；✅ wire adapters 保留结构化 renderer Message.model/tool-object block content/unknown JSON/nullable 语义；✅ repository factory 支持 root DB 和 transaction executor 绑定；✅ 14 个 IPC handler 含 request/result 运行时验证和结构化错误映射；✅ 155 个 Phase 3.2 tests 通过（aggregate 60 + wireAdapters 29 + ipc 27 + errors 39）；✅ 870+ 个 tests 全部通过（含 Phase 2 161 + shared 199 + 2 persistent renderer timeout failures 被分类为 pre-existing known failures）；✅ typecheck / format 通过 |
| **事务保证** | ① appendMessage: ensure-topic + message insert + block upsert + file-ref sync in one tx；② updateMessageAndBlocks: message patch + block upsert + file-ref sync in one tx；③ updateBlocks: block upsert + file-ref sync in one tx；④ updateSingleBlock: load/merge/update + file-ref delete/create in one tx；⑤ deleteBlocks: one tx, FK cascade for refs；⑥ clearMessages: one tx, FK cascade for refs + segments；⑦ bulkAddBlocks: duplicate check + insert + file-ref sync in one tx |
| **非目标** | 无 Renderer/DbService 路由变更；无 preload 变更；无 per-call fallback；无双写；无 file count 迁移 |

#### Phase 3.3：Preload bridge + Renderer SqliteMessageDataSource + structured model fix

| 属性 | 值 |
|---|---|
| **状态** | **Done** |
| **目标** | Preload fixed named bridge（14 方法）；Renderer SqliteMessageDataSource（exported/unrouted）；Main structured Message.model round-trip 缺陷修复 |
| **交付物** | `src/preload/index.ts` 新增 `window.api.chatDb`（14 个命名方法直接 ipcRenderer.invoke）；`src/renderer/src/services/db/SqliteMessageDataSource.ts`（ChatDbApi 接口 + ChatDbResultError + cloneForWire + MessageDataSource 实现 14 方法）；`src/renderer/src/services/db/index.ts` 导出；`src/main/services/chatDb/wireAdapters.ts` 修复结构化 model round-trip（wireToMessage: 对象→overflow + column null + modelId 提取；messageToWire: 从 overflow 恢复结构化对象；wireToMessagePatch: 对象 model→overflow + null model 清除 overflow）；`__tests__/SqliteMessageDataSource.test.ts`（66 tests）、wireAdapters.test.ts 新增 9 个结构化 model 测试、aggregate.test.ts 新增 5 个结构化 model round-trip 测试 |
| **结构化 model 修复** | ① wire `model` 为结构化 JSON 对象时，完整对象存入 overflow，promoted SQL `model` 列设为 null；② `modelId` 优先使用显式 wire 字段，否则从结构化对象的 `id` 字段提取；③ 读取时 messageToWire 从 overflow 恢复原始结构化对象，不被 column null 覆盖；④ scalar/null 旧行为保留；⑤ patch 传入 null model 时同时清除 overflow（防止历史结构化 model 残留）；⑥ 绝不绑定对象到 SQLite TEXT 列 |
| **Preload bridge** | `window.api.chatDb` 含 14 个命名方法：fetchMessages、getRawTopic、topicExists、ensureTopic、appendMessage、updateMessage、updateMessageAndBlocks、deleteMessage、deleteMessages、updateBlocks、updateSingleBlock、bulkAddBlocks、deleteBlocks、clearMessages；直接 ipcRenderer.invoke，无 tracedInvoke；无通用 command/channel dispatcher；无 SQL/repository API；无 file-count 方法 |
| **Renderer datasource** | 构造函数注入 ChatDbApi（默认 window.api.chatDb）；每个方法调用对应 bridge 方法 + unwrap ChatDbResult；ChatDbResultError 携带 code/message/retryable/details；transport rejection 原样传播；fetchMessages 接受但不发送 forceReload；getRawTopic wire null→renderer undefined；appendMessage -1 sentinel 省略；updateMessageAndBlocks 省略冗余 topicId/sortOrder；updateTopicUpdatedAt 在成功的消息/主题变更后 dispatch；无 file-count 方法；cloneForWire 递归克隆 + 安全验证 |
| **约束** | 当前 Cherry Studio 运行时 Dexie 保持 authoritative（Phase 4 为外部导入，不影响当前运行时）；不修改 DbService 路由；不实现 per-call fallback；不自动切换；`updateFileCount(s)` 保留在 Dexie/FileManager |
| **排除项** | 不修改 DbService 路由或 DexieMessageDataSource；不实现 importer / shadow verification / cutover / FTS / canonical files / fallback；不 commit/push |
| **退出条件** | ✅ 803 个相关 tests 全部通过（shared 199 + Main 538 + renderer 66）；✅ structured model round-trip 通过 aggregate 实测（append+fetch、update+fetch、null-after-structured、coexistence-with-overflow）；✅ preload 14 个方法映射正确；✅ typecheck 通过；✅ 无 DbService/DexieMessageDataSource 变更 |
| **Main 验证边界** | Main 侧 runtime validation 通过 shared contracts 验证 request/result；Renderer 不重复验证 |

#### Phase 3.4：Immutable injected routing policy

> ⚠️ **临时验证 scaffolding**：Phase 3.4 的路由策略注入是用于验证 SQLite 数据源端到端可行性的临时机制。在 Phase 5 SQLite-only runtime 完成时必须移除（C-13）。不是长期运行时开关。

| 属性 | 值 |
|---|---|
| **状态** | **Done** |
| **目标** | DbService 路由策略通过构造注入实现不可变切换；生产环境永久默认 Dexie；SQLite 验证仅限显式构造实例 |
| **交付物** | `src/renderer/src/services/db/routingPolicy.ts`（DbRoutingPolicy 类型 + OrdinaryMessageSource / DexieMessageSource / AgentMessageSource 依赖接口 + DbServiceDeps 构造选项）；`src/renderer/src/services/db/DbService.ts`（公共构造函数 + 不可变注入策略 + 懒加载 SQLite 源 + 永久 Dexie 单例）；`src/renderer/src/services/db/index.ts`（导出路由类型）；`src/renderer/src/services/db/__tests__/DbService.test.ts`（102 tests） |
| **策略语义** | `'dexie'` — 所有普通操作路由到 Dexie；生产默认。`'sqlite-validation'` — 普通操作路由到 SQLite（懒加载，首次普通操作创建一次）；仅限显式构造。`'sqlite-authoritative'` — 保留命名但始终拒绝：构造时同步抛出明确错误；不在运行时使用；Phase 5 移除整个 routingPolicy（C-13） |
| **Agent 路由** | Agent session 操作始终最高优先级、策略无关；不创建 SQLite 源 |
| **文件操作** | `updateFileCount` / `updateFileCounts` 始终使用注入的 Dexie 源，与策略无关；不实例化/调用 SQLite / Agent |
| **混合操作** | `updateBlocks` 按 topicId 分区 agent/ordinary；`updateSingleBlock` 分类 agent/ordinary/unresolved；`bulkAddBlocks` / `deleteBlocks` 路由到配置的普通源 |
| **getSourceType** | Agent 优先返回 `'agent'`；否则返回策略对应的普通源类型（`'dexie'` / `'sqlite'`） |
| **禁止项** | 无环境变量 / Redux / localStorage / 可变 setter / 全局 configure/reset API；无 chat.db 存在检测 / ChatDb 初始化 / migration 002 / 就绪探针；无 per-call fallback / retry-to-Dexie / shadow reads / dual writes |
| **约束** | 当前 Cherry Studio 运行时 Dexie 保持 authoritative（Phase 4 为外部导入，不影响当前运行时）；sqlite-authoritative 构造同步拒绝 |
| **排除项** | 不修改 Main / preload / shared IPC / SqliteMessageDataSource / DexieMessageDataSource / AgentMessageDataSource；不实现 importer / shadow verification / cutover / FTS / canonical files / file-count migration |
| **退出条件** | ✅ 168 个 renderer db tests 通过（DbService 102 + SqliteMessageDataSource 66）；✅ typecheck 通过；✅ format 通过 |

### Phase 4：外部应用兼容性导入管线（A-8 Accepted）

> **产品模型**：用户在 SQLite-authoritative Cherry Chat 中选择一个 Cherry Studio ZIP 备份来导入数据。ZIP 是唯一受支持的源格式，包含原始 Chromium IndexedDB。旧逻辑格式 `data.json` / `.bak` 明确放弃兼容。
>
> **权威语义**：导入过程中现有 SQLite 保持 authoritative。取消支持至最终 promotion 之前。promotion 短时不可取消、保留一个回滚快照、重开/检查 DB、成功后 relaunch。

#### Phase 4.0：Isolated-profile feasibility spike

| 属性 | 值 |
|---|---|
| **状态** | **Done — Go on macOS arm64 (2026-07-21)** |
| **目标** | 验证 `session.fromPath()` / isolated profile + 正确 origin 创建隔离 Electron Session 的跨平台可行性 |
| **方法** | 最小 spike：在 macOS 上从临时路径 `session.fromPath(absolutePath, { cache: false })` 创建 session profile；验证可正确加载 IndexedDB 并通过当前 Dexie declaration + upgrade functions 识别和升级数据 |
| **API 修正** | Electron 41.2.1 API 为静态 `session.fromPath(absolutePath, { cache: false })`；`session.defaultSession.fromPath()` 不存在。代码中已使用正确 API |
| **Origin 观测** | 正确 origin 为 `file://`（通过 `pathToFileURL` 加载 renderer HTML）；一个不同的 loopback HTTP origin（`http://127.0.0.1:<port>`）不暴露 CherryStudio，不创建空 DB（仅使用 `indexedDB.databases()` 时） |
| **Profile 映射观测** | 在测试的 file:// origin 下，IndexedDB 数据位于 `IndexedDB/file__0.indexeddb.leveldb/`。此为观测结果，非通用硬编码规则——不同 origin 类型可能产生不同映射 |
| **Dexie 版本映射** | logical 4 → native 40；logical 11 → native 110；logical 12 → native 120。乘数为 ×10（与 Dexie 1-3 相同）。当前 CherryStudio: logical v11 / native 110 |
| **升级路径验证** | v4 fixture（native 40）通过 production Dexie upgrades (v5→v7→v8→v11) 成功升级到 logical 11/native 110；验证了 v5 date conversion、v5 tavily→webSearch、v7 referential consistency、v8 language settings；topic_segments 表在升级后存在 |
| **未来版本拒绝** | v12 fixture（native 120）在 production opener 启动前被正确拒绝（futureVersionRejected=true，productionOpenerStarted=false） |
| **隔离验证** | default session 在 fresh spike-owned userData 中不含 CherryStudio；A/B markers 不跨 session；sentinel marker 不泄漏到 candidate session；wrong-origin probe 确认 CherryStudio absent at HTTP origin 且不创建空 DB |
| **Local Storage** | IDB-only profile（无 Local Storage 目录）与 full-profile（IndexedDB + Local Storage）产生完全相同的 CherryStudio discovery 和 read 结果。仅 full-profile 暴露 LS control marker。LS 非 discovery/read 必需 |
| **清理验证** | 10/10 fresh-root macOS arm64 迭代全部通过；child 正常退出（exit 0）；owned roots 在 exit 后删除，全部首次成功（cleanupAttempts=1）；无 owned leftovers |
| **No-go 回退** | 专用隔离 Electron helper 进程（非破坏性恢复、非直接 LevelDB 解析）。**状态：contingency only，未选用** — same-process approach 在测试平台上满足 Phase 4.0 Go |
| **未验证** | Windows/Linux；跨平台 fixture 可移植性；真实 ZIP snapshot 一致性/损坏处理（→ Phase 4.1） |
| **Origin 支持边界（post-closure 实现，2026-08-02，LOCK-DEV-1…8）** | Phase 4.0 spike 观测到的 `file://` origin + `file__0.indexeddb.leveldb` 映射为 **packaged/file-origin 生产构建的正确行为**。精确 `http://localhost:5173` dev-origin 已实现（LOCK-DEV-1…8）：Chromium 41.2.1 自然将精确 `http://localhost:5173` 映射为 `IndexedDB/http_localhost_5173.indexeddb.leveldb`，与 `file://` origin 隔离。Main intake 分类精确 file__0/dev 映射并在 IPC/窗口/candidate 之前拒绝不支持/歧义/多个 origin；Renderer 验证精确 dev origin/path/no-search/no-hash（LOCK-DEV-2…4）；最终验证重构 application-owned exact URL fields 而非接受任意 URL 输入（LOCK-DEV-5）。当前支持矩阵：**packaged/file-origin `file__0`（生产构建 + 标准用户备份）= 支持；精确 `http://localhost:5173` dev-origin（electron-vite dev 模式 ZIP）= 支持；其他 origin/端口 = 拒绝**。packaged 构建不引入 HTTP origin 支持。不改变 A-8 产品语义 |
| **退出条件** | ✅ macOS arm64 上 fromPath + origin + Dexie schema 读取验证通过；✅ v4→v11 升级验证通过；✅ v12 拒绝验证通过；✅ session 隔离验证通过；✅ LS 非必需验证通过；✅ 清理稳定性验证通过 |

#### Phase 4.1：Secure ZIP intake + isolated IndexedDB source reader

| 属性 | 值 |
|---|---|
| **状态** | **Done** |
| **前置** | Phase 4.0 spike 通过（或回退 helper 进程设计完成） **Done** |
| **目标** | 安全解压 Cherry Studio ZIP 到唯一临时工作区；通过隔离 Session + 隐藏 sandboxed import renderer 读取源 IndexedDB |
| **主要任务** | ZIP 解压 + 路径校验（必须含 Chromium IndexedDB 结构）；唯一临时工作区创建/清理；隔离 Session profile + 正确 origin 创建；隐藏 sandboxed BrowserWindow 加载 import renderer；import renderer 初始化当前 Dexie schema/upgrades against isolated profile；窄 import-only IPC（分页）将逻辑数据传输到 Main |
| **源数据约束** | 受支持源：Cherry Studio ZIP 备份含原始 Chromium IndexedDB。当前 IndexedDB schema 为主源。旧 IndexedDB 仅在当前 Dexie declaration/upgrades 可防御性识别并升级为当前逻辑形态时才接受 |
| **缺失值规则** | 缺失值继承当前 Cherry Studio/Dexie upgrade 和 reader 语义。不创建 importer-specific 历史修复。不推断缺失 ID、ownership、timestamp、role、status、model 等字段。结构不可用数据被拒绝 |
| **排除项** | 不解析 LevelDB（Main 不直接解析）；不恢复源到目标 app 的正常 Dexie profile；不扫描磁盘查找其他应用；不要求共享目录 |
| **Origin 支持边界（post-closure 实现，2026-08-02，LOCK-DEV-1…8）** | Phase 4.1 验证通过的 origin 包括：① `file://`（通过 `pathToFileURL` 加载 `chatImport.html`），对应 packaged/file-origin `file__0` 映射；② 精确 `http://localhost:5173` dev-origin（LOCK-DEV-1…8）。Chromium 41.2.1 自然将精确 `http://localhost:5173` 映射为 `IndexedDB/http_localhost_5173.indexeddb.leveldb`，与 `file://` origin 隔离。Main intake 分类精确 file__0/dev 映射并在 IPC/窗口/candidate 之前拒绝不支持/歧义/多个 origin（LOCK-DEV-3）；Renderer 验证精确 dev origin/path/no-search/no-hash（LOCK-DEV-4）；最终验证重构 application-owned exact URL fields 而非接受任意 URL 输入（LOCK-DEV-5）。Real Chromium E2E fixture 自然生成无需 rename。failure 发生在 candidate DB 初始化/promotion 之前时 live chat.db 不受影响。当前支持矩阵：**packaged/file-origin `file__0`（生产构建 + 标准用户备份）= 支持；精确 `http://localhost:5173` dev-origin（electron-vite dev 模式 ZIP）= 支持；其他 origin/端口 = 拒绝**。packaged 构建不引入 HTTP origin 支持 |
| **退出条件** | ✅ 安全 ZIP 解压 + IndexedDB 结构校验通过（5 层校验 + 通用 IndexedDB 探测）；✅ 隔离 Session 成功加载源数据（`session.fromPath(destDir, {cache:false})` + file:// origin）；✅ import renderer 通过 current Dexie schema 读取数据（`indexedDB.databases()` discovery + production Dexie upgrades v4→v11 + future-version gate ≥120）；✅ 分页 IPC 将逻辑数据传输到 Main（Main 驱动 Discover→ReadPage cursor progression；源 reader 分页读完后 self-complete 并精确一次（exact-once）发送 `candidate-ready` 信号；Phase 4.2 接收该信号后启动候选 DB 批量写入，非由 Phase 4.1 内 onReadyForBulk 启动 bulk）；✅ 取消支持：用户可在 promotion 前中断，源数据和现有 SQLite 不受影响；✅ 平台拒绝（A-9 macOS-first）；✅ spike harness 保留（A-10）；✅ 主进程 977/977 测试通过；✅ 2 轮独立审计阻塞修复后最终 Clean |

#### Phase 4.2：Candidate SQLite bulk importer

| 属性 | 值 |
|---|---|
| **状态** | **Done** (2026-07-27) |
| **前置** | Phase 4.1 完成（Done） |
| **目标** | 从分页逻辑数据构建完整候选 SQLite 数据库 |
| **实际交付范围** | `CandidateDbResource`（per-session 自有候选目录，内含独立 `chat.db`）；`ChatImportDataPlane`（Main 侧分页数据面，承载 `SourceReadStats`）；`ChatImportWriter`（import-only 保序 writer，order-preserving，`candidate-ready` exact-once）；`startupRecovery`（启动清理：取消/错误/孤儿候选目录清理） |
| **候选布局** | 每个导入会话拥有独立临时目录，目录内持有候选 `chat.db`；会话结束（promotion 成功或取消/失败）后目录被清理，不污染 live `Data/chat.db` |
| **主要任务** | 分页接收 import-only IPC 数据（Main page 背压：Main 驱动 Discover→ReadPage，源 reader 按页就绪后精确一次发送 `candidate-ready`）；通过 Phase 2 repository 层（TopicsRepository 等）批量写入候选 DB；每页一个事务（one transaction/page）；import-only 保序写入（order-preserving，不重排源顺序）；topic/message 扁平化后写入；block/segment/file-reference 精确映射；replace-all 语义（非 merge） |
| **统计语义** | `SourceReadStats`（源读取侧：从源 IndexedDB 读取的待导入逻辑计数）与 `CandidateImportStats`（候选 DB 写入侧：实际写入候选 DB 的计数）分离，验证阶段对照，不混用 |
| **数据流** | import renderer（源 IndexedDB → 逻辑 DTO）→ IPC 分页（Main page 背压）→ Main `ChatImportDataPlane`/`ChatImportWriter`（候选 chat.db 批量写入，每页一事务，保序）→ `candidate-ready`（exact-once）→ Phase 4.3 验证 |
| **失败/清理** | 取消/错误/孤儿候选目录由 `startupRecovery` 在下次启动确定性清理；现有 live SQLite 不受影响；候选 DB 可安全丢弃 |
| **退出条件** | ✅ 10k 消息完整导入到候选 DB；✅ 导入中断后候选 DB 可安全丢弃，现有 SQLite 不受影响；✅ 导入耗时记录（10k 基准见下）；✅ 单元审计 + 最终审计 0 阻塞（final audit 0 blockers）；✅ 聚焦测试证据通过（focused test evidence）；✅ 全量本地验证通过（2026-07-27）：`pnpm format` exit 0 无改动；`pnpm lint` exit 0（node/web/aicore typecheck 全过、i18n 校验通过、0 errors，仅 pre-existing warnings）；`pnpm test` exit 0，252 文件 / 5325 通过 / 72 跳过；无遗留产物（本地全量验证未涉及 CI） |

**10k 基准证据（真实运行）**：
- 数据集：25 个 topics、10,000 条 messages、11,000 个 blocks、26 个 segments、250 条 topic_segment_memberships、667 条 file references、19 页分页
- 两次独立运行耗时：约 1016.2ms 与 978.5ms
- 完整性：`PRAGMA integrity_check` 通过（ok）；`PRAGMA foreign_key_check` 结果为空（无外键违例）
- 不变量：现有 live `chat.db` 未被改动（import 仅写候选 DB）

#### Phase 4.3：Deterministic verification

| 属性 | 值 |
|---|---|
| **状态** | **Done（本地完成，已提交/已推送，2026-07-27）** |
| **前置** | Phase 4.2 完成（Done） |
| **目标** | 对候选 SQLite DB 执行确定性的全维度验证，确保数据完整且结构正确；验证失败有明确报告与诊断；取消/退出安全 |
| **实际交付范围** | `CandidateVerifier`（只读验证器，返回稳定 13 维度结果 + 有界安全诊断）；`SourceVerificationManifest`（按页证据清单，仅在 DB 事务提交后落盘，stable canonical SHA-256 framing）；`VerificationReport`（紧凑诊断输出 ~1.4KiB）；候选 DB 会话状态机 `candidate-ready → verifying → verified-candidate \| verification-failed`；取消/退出 `close-before-discard` 语义 |
| **Canonicalization 语义** | 验证使用稳定的 canonical SHA-256 framing：同一候选 DB 在同一证据集下产生稳定、可复现的 manifest 哈希（manifest ~5,019KiB），不随运行次序/线程调度抖动；manifest 仅在每页 DB 事务提交后写入，保证证据与已落盘数据强一致 |
| **验证器生命周期 / 状态** | 候选 DB 写入完成发送 `candidate-ready`（exact-once）→ 进入 `verifying`；验证全维度通过 → `verified-candidate`（保留候选 DB 供 Phase 4.4 promotion）；任一维度失败 → `verification-failed`（生成诊断报告后清理候选 DB）；用户在 promotion 前取消或 app 退出 → `close-before-discard`（先关闭候选 DB 句柄，再安全丢弃目录） |
| **13 验证维度** | ① 源 vs 目标 ID 集合匹配；② 每表记录数一致；③ 关键字段内容哈希比对；④ 消息 sort_order 与源顺序一致；⑤ 外键引用完整性；⑥ 关系正确性（topic→message→block、segment→message）；⑦ file-reference 快照完整性；⑧ segment 完整性；⑨ 结构化 model/tool object 完整性；⑩ overflow 数据；⑪ `PRAGMA integrity_check`；⑫ `PRAGMA foreign_key_check`；⑬ 应用层抽样读取（通过 repository 查询典型数据路径） |
| **诊断 / 隐私** | 验证器严格只读（readonly），不修改候选 DB；诊断信息有界（bounded safe diagnostics），仅暴露维度名、计数/哈希差异摘要、失败维度索引；不泄露 SQL、文件路径、堆栈、源内容明细 |
| **失败 / 通过行为** | 通过：保留候选 DB 于自有临时目录，等待 Phase 4.4 原子替换；现有 live `chat.db` 不受影响。失败：生成 `VerificationReport`（~1.4KiB，含失败维度与有界诊断）后清理候选 DB 与临时目录。取消/退出：`close-before-discard`，live SQLite 不受影响。corruption matrix 覆盖全部 13 维度（每个维度可独立检测失效） |
| **测试与基准** | 聚焦验证测试 271 个通过；`pnpm format` exit 0 无改动；`pnpm lint` exit 0（0 errors，109 warnings）；`typecheck:node` 通过；首次全量 `pnpm test` 5420 通过 / 2 失败 / 72 跳过（BackupManager 共享临时目录两例非确定性环境 flakes，与 Phase 4.3 无关）；复跑全量 `pnpm test` 258 文件 / 5422 通过 / 72 跳过 / 0 失败；Main 与全量多次复跑均干净；最终审计 0 findings（本地全量验证，未涉及 CI）；10k 数据集验证耗时 ~250–290ms |
| **退出条件** | ✅ 所有 13 维度验证通过；✅ 验证失败有明确错误报告与有界诊断；✅ 取消/退出安全（close-before-discard）；✅ 通过时候选 DB 安全保留供 4.4；✅ manifest 稳定可复现 |

**10k 验证证据（真实运行）**：
- 数据集：25 个 topics、10,000 条 messages、11,000 个 blocks、26 个 segments、250 条 topic_segment_memberships、667 条 file references、19 页分页
- 13 维度全部通过；corruption matrix 覆盖全部维度（构造性注入验证每个维度可独立检测失效）
- 验证耗时：约 250–290ms（两次独立运行）
- `SourceVerificationManifest`：~5,019KiB；`VerificationReport`：~1.4KiB
- 不变量：现有 live `chat.db` 未被改动（验证仅读候选 DB）

#### 集成同步门（Baseline Sync Gate，Phase 4.4 前置，Done/已合并/已验证）

> ✅ **已合并并验证完成（2026-07-27）**：integration 分支（`05a401b711`）已集成同步进 migration 分支（pre-merge HEAD `5d50499e80`）。合并自动解决（auto-resolved），无兼容性编辑。审计无阻塞/无代码发现；验证全部通过（见下方验证事实）。

| 属性 | 值 |
|---|---|
| **状态** | **Done（已合并 / 已验证）** |
| **基线事实（历史锚点）** | integration `05a401b711`、migration 历史推送 tip `85603d0fd5` 均已稳定；两分支距 merge base `44e6b1b82b` 分别为 15/21 commits（合并前基线事实）。本次合并：migration pre-merge HEAD `5d50499e80` ↔ integration `05a401b711` |
| **目标** | 将 integration 分支集成同步进 migration 分支，使后续 Phase 4.4 与 Phase 5 基于统一的 Renderer/context/type/Redux 结构 |
| **前置依赖** | 已完成 |
| **约束** | 合并**未改变** Phase 4.4 既有架构；Phase 5 须以合并后的结构为实施基线；本门作为 Phase 4.4 实现前置已完成 |
| **验证事实** | format 无改动（exit 0）；lint exit 0（112 known warnings，无错误）；typecheck 通过；`pnpm test` exit 0，265 文件 / 5664 通过 / 72 跳过 / 0 失败；聚焦测试 201 renderer + 822 chatDb/import 通过；审计 0 blocker / 0 code finding |
| **退出条件** | ✅ integration 已合并入 migration 分支；✅ 合并后 Renderer/context/type/Redux 结构统一且可编译；✅ 未引入 Phase 4.4 架构变更 |

**后续影响**：
- Phase 4.4（原子替换 promotion）架构不变，仅需在合并后的统一结构上实现
- Phase 5（SQLite-only runtime）须以合并后的 Renderer/context/type/Redux 结构为实施基线

#### Phase 4.4：Atomic replace-all promotion

| 属性 | 值 |
|---|---|
| **状态** | **Done**（Phase 4.4.0 Done；Phase 4.4.1 Done；Phase 4.4.2 Done（已提交 `3a81557ac6`）；Phase 4.4.3 Done（commit `f6a6741b8e`；实现 + 独立审计 pass + 全量验证通过）） |
| **前置** | Phase 4.3 验证通过；**集成同步门已完成（详见 Section 9「集成同步门（Baseline Sync Gate）」；migration pre-merge HEAD `5d50499e80` ↔ integration `05a401b711` 已合并/已验证，架构未变更）** |
| **目标** | 将验证通过的候选 SQLite DB 原子替换为 live `chat.db` |
| **主要任务** | 关闭现有 chat.db 连接；保留一个 rollback 快照（当前 live chat.db）；原子 rename 候选 DB → `Data/chat.db`；重新打开并验证新 DB（`PRAGMA integrity_check` + `PRAGMA foreign_key_check`）；成功 → relaunch app；失败 → 回滚到快照 DB 并报告错误 |
| **崩溃恢复** | 如果在快照创建和候选 rename 之间发生崩溃：原始 `chat.db` 保持完整（快照是副本，rename 未执行）。启动时检测孤立的快照/临时工作区文件（例如 `chat.db.pre-import-backup`、候选 DB 临时路径），通过确定性启动清理安全删除或保留（保留用于诊断，下次启动清理）。不影响正常启动路径 |
| **约束** | promotion 短时不可取消；保留一个回滚快照；重开/检查 DB；成功后 relaunch |
| **退出条件** | ✅ 原子替换成功 → reopen → relaunch 流程完成；✅ 失败回滚到快照 DB 流程验证；✅ 一个回滚快照保留 |

##### Phase 4.4.0：Promotion 协议基础（纯协议/state/journal/recovery matrix/coordination contract）

| 属性 | 值 |
|---|---|
| **状态** | **Done（实现 + 聚焦验证）** |
| **范围** | 仅纯协议层（LOCK-4405）：无 live/candidate/snapshot 文件操作、无 ChatDbService close/init、无 rename/replace/restore、无 relaunch、无 promotion IPC；不修改 shared/preload/renderer |
| **状态机（LOCK-4401）** | `ImportState` 扩展 `promoting`、`promoted`、`promotion-failed`；`verified-candidate → promoting` 为唯一 promotion 入口（`claimPromotion()`，bounded to `getVerifiedCandidate()`，同步原子转换 + 不可复用 token，exact-once）；`completePromotion(token, outcome)` exact-once 结算终态；`promoting` 后 cancel 拒绝（无状态变化、无清理）；两个结果态为终态 |
| **所有权边界（LOCK-4401）** | promotion-owned 状态（promoting/promoted/promotion-failed）下：异步 `dispose()`、同步 will-quit `disposeActiveImport()` 均保留候选与持久化恢复资产，仅关闭 reader/verifier/IPC 等非 promotion 资源；`promoting` 中失败结算为 `promotion-failed`（绝不 `error`） |
| **Journal v1（LOCK-4404）** | `promotion/journal.ts`：恰好 `version/sessionId/candidateId/phase`（`snapshot-ready\|candidate-installed\|replacement-verified`）；exact-key 严格 codec（多键/缺键/版本/ID/枚举全部运行时拒绝）；ID 复用候选目录严格 allowlist `^[A-Za-z0-9_-]{1,128}$`（不可携带路径）；固定自有文件名 `chat-import-promotion.journal.json`；纯函数 codec，crash-safe 落盘 writer 由 Phase 4.4.1 新增（已落地，见 Phase 4.4.1 / LOCK-4413） |
| **Rollback snapshot 命名（LOCK-4403，仅契约）** | 固定名 `chat.db.pre-import-backup` + staging `chat.db.pre-import-backup.staging`；单份保留顺序：live 打开时 online backup → staging → 验证 → 原子 rename 覆盖旧快照；不复制 WAL/SHM；replacement 验证后快照仍保留；本阶段无任何快照操作 |
| **操作顺序契约** | `promotion/protocol.ts` 定义 12 步 canonical 顺序（snapshot 创建/验证/发布 → journal snapshot-ready → close live → install → journal candidate-installed → reopen → verify → journal replacement-verified → cleanup journal → relaunch）；journal 锚点均在对应操作完成之后 |
| **恢复矩阵（LOCK-4406）** | `promotion/recovery.ts` 纯 `decidePromotionRecovery(input)`：输入 = journal 观察（absent/invalid/valid×3 phase）× live（missing/present-unverified/present-verified）× snapshot（同三态）× candidate（missing/present），共 90 组合全枚举，每组唯一动作 + reason code；动作严格为 `keep-old-live\|accept-verified-replacement\|restore-rollback-snapshot\|repair-required`；无 journal→keep-old-live；journal 无效→repair-required；`candidate-installed` 永不自证——仅 verified snapshot 可 restore，否则 repair-required；`replacement-verified` 仅在 live present-verified 时 accept；不按文件年龄猜测、无空 DB 创建动作；12 个文档化崩溃点由 `PROMOTION_CRASH_POINT_MATRIX` 全覆盖（will-quit 覆盖全部持久化 phase 子窗口） |
| **Maintenance coordination（LOCK-4402）** | `src/main/services/chatDb/maintenanceCoordination.ts`：统一契约覆盖 `backup\|restore\|promotion\|init\|close` 五操作；冲突矩阵全对（含同类互斥）；单持有者 lease（非阻塞 acquire / owner-checked 幂等 release / 唯一 leaseId）；**本阶段（4.4.0）仅定义契约，未接线任何现有 mutex/操作，无第三个独立运行时锁**；实际接线（promotion 接入既有 backup/restore/init/close 互斥协调）在 Phase 4.4.1 完成（LOCK-4411） |
| **Startup recovery seam** | `startupRecovery.ts` 仅 re-export 纯恢复决策契约；不读 journal、不探测文件、不执行恢复；既有孤儿清理行为不变；已注明未来接线时 journal-referenced candidate 必须排除出按年龄清理。**注意**：该「不读 journal / 不探测文件」状态为 Phase 4.4.0 协议层事实；Phase 4.4.1 已将其扩展为读取 promotion journal、探测并保护 journal-referenced 候选目录（LOCK-4414），见 Phase 4.4.1 |
| **实际资产** | `src/main/services/chatDbImport/promotion/{protocol,journal,recovery}.ts` + `promotion/__tests__/{protocol,journal,recovery}.test.ts`；`src/main/services/chatDb/maintenanceCoordination.ts` + `__tests__/maintenanceCoordination.test.ts`；`chatDbImport/index.ts`（状态扩展 + claim/complete + 边界守卫）；`chatDbImport/startupRecovery.ts`（契约 re-export）；`chatDbImport/__tests__/{index,startupRecovery}.test.ts` 扩展 |
| **验证事实** | 聚焦测试 `chatDb` + `chatDbImport`：29 文件 / 895 通过 / 0 失败（基线 822 + 新增 73）；`typecheck:node` 通过；Phase 4.1–4.3 既有测试与 API 无回归 |
| **退出条件** | ✅ 唯一 promotion 入口 + exact-once 经测试证明；✅ cancel/dispose/will-quit 边界经测试证明；✅ journal codec 严格有界、无路径；✅ 恢复矩阵 90 组合穷举 + 12 崩溃点覆盖；✅ 五操作互斥契约成立；✅ 4.4.0 模块零副作用 API |

##### Phase 4.4.1：Durable Preparation Gate（快照就绪准备门，无 live close/install/rollback/relaunch）

| 属性 | 值 |
|---|---|
| **状态** | **Done（实现 + 聚焦验证；已本地提交 `006615aff6`（连同 Phase 4.4.0 `7768b7e30c`），未推送）** |
| **范围** | Durable Preparation Gate：在 Phase 4.4.0 协议层之上，落地统一维护接线、rollback 快照创建（snapshot-ready）、严格持久化 journal store（crash-safe 落盘）、启动候选保护、exact-once prepared handle，以及非破坏性边界。**最大边界止于 snapshot-ready**：不含 live close / install / rename / replace / restore / relaunch（属 Phase 4.4.2+） |
| **统一维护接线（LOCK-4411）** | `maintenanceCoordination.ts`（4.4.0 定义契约、未接线）在 4.4.1 将 promotion 操作实际接入既有的 `backup\|restore\|init\|close` 互斥协调，成为唯一持有者 lease 的真实使用者；冲突矩阵全对（含同类互斥）；无新增第三个独立运行时锁；既有备份/恢复/初始化/关闭路径行为不变 |
| **Rollback 快照（LOCK-4412 / LOCK-4403）** | 在 live `chat.db` 打开时通过 Phase 1 online backup 机制创建单个 rollback 快照 `chat.db.pre-import-backup`：live → staging（`chat.db.pre-import-backup.staging`）→ 验证 → 原子 rename 覆盖旧快照；不复制 WAL/SHM；快照在 replacement 验证后仍然保留。本阶段仅创建并发布快照（journal 落 `snapshot-ready`），不消费快照做 restore |
| **严格持久化 journal store（LOCK-4413）** | 4.4.1 新增独立 `promotion/journalStore.ts` crash-safe 落盘 writer（`promotion/journal.ts` 保持 4.4.0 纯函数 codec）：确保 `chat-import-promotion.journal.json` 以原子 rename 写入；内容恰好 `version/sessionId/candidateId/phase`（`snapshot-ready\|candidate-installed\|replacement-verified`）；exact-key 严格 codec 保持不变（多键/缺键/版本/ID/枚举全部运行时拒绝）；ID allowlist `^[A-Za-z0-9_-]{1,128}$` 不变 |
| **启动候选保护（LOCK-4414）** | `startupRecovery.ts`（4.4.0 仅 re-export 纯决策契约，不读 journal / 不探测文件）在 4.4.1 扩展：启动时读取 promotion journal、探测并保护 journal-referenced 候选目录（排除出按年龄孤儿清理）、依据 Phase 4.4.0 恢复矩阵 `decidePromotionRecovery` 在启动早期对中断的 promotion 资产做安全分类（keep-old-live / repair-required 路径），不影响正常启动路径 |
| **Exact-once prepared handle（LOCK-4415）** | `claimPromotion()`（4.4.0，bound 到 `getVerifiedCandidate()` + 不可复用 token）在 4.4.1 形成 prepared handle；确保该 handle 在进入 live 替换前的准备窗口内可被唯一一次消费，prepared 状态持久化于 journal（snapshot-ready 已落盘）；promotion-owned 状态（promoting/promoted/promotion-failed）下 async `dispose()` / 同步 will-quit `disposeActiveImport()` 仍仅关闭非 promotion 资源、保留候选与持久化恢复资产 |
| **非破坏性边界（LOCK-4416）** | 整个 4.4.1 不对 live `chat.db` 做任何关闭/替换/重命名；现有 SQLite 保持 authoritative；候选 DB 始终处于自有临时目录；任何准备步骤失败均回退到 keep-old-live 或 repair-required（不创建空 DB、不按文件年龄猜测）；所有文件写均为 staging + 原子 rename；journal 无效 → repair-required |
| **审计 / 验证最终门（LOCK-4417）** | 独立审计首轮发现 candidateId 与 session 集成两处阻塞；均已修复；复审 0 findings。全量本地验证通过（未涉及 CI / 未提交 / 未推送） |
| **验证事实** | `pnpm format` 通过（无改动）；`pnpm lint` exit 0（82 oxlint + 33 eslint known warnings，115 emitted warning instances，0 errors）；`pnpm typecheck:node` 通过；`pnpm test` exit 0，272 文件 / 5860 通过 / 72 跳过 / 0 失败；Phase 4.4.0 / 4.1–4.3 既有测试与 API 无回归（本地全量验证，未涉及 CI / 未提交 / 未推送） |
| **退出条件** | ✅ 统一维护接线接入且冲突矩阵全对；✅ rollback 快照创建/发布流程经测试证明且不复制 WAL/SHM；✅ journal 严格持久化（crash-safe 原子写入）经测试证明；✅ 启动候选保护经测试证明（journal-referenced candidate 排除年龄清理、恢复矩阵分类安全）；✅ exact-once prepared handle 可唯一消费、promotion-owned 边界保持；✅ 非破坏性边界证明（live 未被关闭/替换、失败回退 keep-old-live/repair-required）；✅ 复审 0 findings |

**非目标（已由 Phase 4.4.2+4.4.3 落地）**：
- ~~不关闭现有 live `chat.db` 连接~~ → Phase 4.4.2 `closeForPromotion` 落地
- ~~不执行候选 DB → live `chat.db` 的原子 rename/replace~~ → Phase 4.4.2 `install.ts` 落地
- ~~不消费 rollback 快照做 restore~~ → Phase 4.4.3 `rollback.ts` 落地
- ~~不执行 relaunch~~ → Phase 4.4.3 `relaunch.ts` 落地
- 不新增 promotion IPC / Renderer 触发路径（仍排除）

##### Phase 4.4.2：Destructive Promotion Executor（破坏性替换执行，止于 durable replacement-verified）

| 属性 | 值 |
|---|---|
| **状态** | **Done（实现 + 聚焦验证 + 独立审计完成：pass-with-findings，两项已接受的 ownership/isolation 硬化修正已落地并复验；最终全量验证通过；工作区未提交/未推送）** |
| **范围** | 在 Phase 4.4.1 准备门（snapshot-ready）之上，落地唯一 Main-local 破坏性替换执行序列：exact-once prepared→executing capability 转移、授权 live close、closed-live proof、sidecar 处理 + 原子 rename-only install、严格 journal 递进（candidate-installed → replacement-verified）、授权 reopen、identity-bound replacement 验证。**执行终点为 durable `replacement-verified` handoff（LOCK-4428）**：不做 journal/snapshot 清理、不 restore 回滚快照、不 relaunch、不执行启动恢复动作（均属 Phase 4.4.3）；不新增 promotion IPC / preload / Renderer 触发路径 |
| **Exact-once capability（LOCK-4421）** | `preparation.ts`：`PreparedPromotionHandle.consume()` 恰好一次产出 `ExecutingPromotionCapability`（携带 token/sessionId/candidateId/retainedSnapshotPath/candidateDbPath/authorization）；重复 consume / dispose 后 consume 均有界拒绝（`already-consumed` / `disposed`）；consume 成功后 prepared handle 变 stale，其 `dispose()` 成为 lease-preserving no-op（不会从 executing capability 手中抽走 lease）；capability 的 `release()` 是唯一 lease 释放职责。会话集成：`transferPromotionExecution()` 仅允许当前活跃会话、`promoting` 状态、live token 对齐的未消费 handle 转移，同一同步帧内完成；会话仅为**过渡持有者**（interim owner）——执行终局结算时 ownership 显式转移（transfer，非 alias）：成功/post-install recovery-required → 终局 handoff 持有者（`TerminalPromotionOwnership` Main-local 记录），pre-install 失败 → 释放；capability 对象任一时刻恰有一个逻辑 owner（session → executor 窗口 → terminal handoff \| released） |
| **Owner-aware live 生命周期（LOCK-4422）** | `chatDb/index.ts`：新增 Main-internal `closeForPromotion(authorization)` / `reopenForPromotion(authorization)`——在任何生命周期变更前经 `validatePromotionAuthorization` 验证「当前持有的 promotion lease」，拒绝伪造/外来 handle、已释放、foreign-coordinator、非当前持有者；核心复用 `closeCore()`/`runInitCore()`（不嵌套获取 init/close lease——同一持续持有的 promotion lease 即整个 close→install→reopen→verify→journal 窗口的唯一维护授权，无 release/reacquire、无第二把互斥锁）；公共 `init()`/`close()` 语义不变（promotion lease 持有期间仍 busy 拒绝）；reopen 保持 repair-required 门与幂等快路径；candidate 实例（无 coordinator）永不可 promotion-owned。`maintenanceCoordination.ts`：新增 `validatePromotionAuthorization` 验证缝——模块私有 WeakMap grant 注册表 + coordinator holder peek（lease ID 内部比对、绝不外泄），仅验证 promotion 类授权、只给 verdict 不授予/不释放，ownerId 字符串单独永不被接受 |
| **原子安装（LOCK-4423 / LOCK-4426 / LOCK-4427）** | `promotion/install.ts`（有界原语，非 executor）：校验候选归属/存在/sealed（候选 WAL/SHM sidecar 存在即拒绝）→ 验证并消费 closed-live proof → 删除 live WAL/SHM sidecars → 捕获源 bigint stat identity（dev/ino/size）→ fsync 源文件 → 原子 `renameSync` 源→live（仅同文件系统；**EXDEV → 有界 `RENAME_CROSS_DEVICE` 失败，绝无 copy fallback，LOCK-4426**）→ fsync live 父目录 → 目标 stat identity 确认 → 产出模块 brand 的 `InstallReceipt`（绑定 candidateId/livePath/identity）。**成功仅在 rename + 父目录 fsync + 目标 identity 确认全部完成后返回（LOCK-4423）**。closed-live proof（LOCK-4427）：单次使用、模块 brand（WeakMap）、仅 `mintClosedLiveProof` 可铸造——要求当前持有的 promotion lease + live-closed witness；executor 在授权 close 成功后**立即**铸造；install 侧在破坏性窗口开启前重验证（含 owner 与 candidateId 绑定、TOCTOU witness 复查）并消费；路径安全：live 路径由 Data root 派生、源路径由严格 owned candidate ID 派生并做 containment 复查 |
| **严格 journal 递进（LOCK-4423 / LOCK-4424 / LOCK-4425）** | `promotion/journalStore.ts`：通用 durable writer 转为模块私有；新增两个显式 transition API——`advancePromotionJournalToCandidateInstalled`（要求当前 durable journal 有效且恰为 `snapshot-ready`、version/sessionId/candidateId 完全一致）与 `advancePromotionJournalToReplacementVerified`（要求恰为 `candidate-installed`、identity 一致）；任何 absent/invalid/phase 跳跃回退重复/identity 不一致均在**任何 staging/publish 变更之前**拒绝（`TRANSITION_JOURNAL_ABSENT/INVALID/PHASE_MISMATCH/IDENTITY_MISMATCH`）；失败绝不删除/清空现有 durable journal（LOCK-4425）；`snapshot-ready` 仍是唯一无前置 journal 可写的初始 phase（LOCK-4417 保持） |
| **Identity-bound replacement 验证（LOCK-4424）** | `promotion/replacementVerifier.ts`：receipt brand + live-path 绑定校验 → live bigint stat identity（dev/ino）对照 receipt → 完整只读 DB 门（`promotion/readonlyDbValidation.ts` 共享门，与 4.4.1 rollback 快照验证器完全同序：readonly+fileMustExist open → `PRAGMA integrity_check` → `PRAGMA foreign_key_check` → 精确 migration-state 兼容 → 经生产 repository/aggregate 读路径的应用层抽样读）→ 验证后 identity 复查（关闭 TOCTOU 窗口）。**size 有意不做门**（授权 reopen 后 WAL checkpoint 可合法改变主文件大小；receipt 仍携带 install 时 size 作有界证据）；严格只读、零变更、不写 journal（journal `replacement-verified` 仅在验证成功后由 executor 推进） |
| **执行编排（LOCK-4425 / LOCK-4428）** | `promotion/execution.ts`：`createPromotionExecutor` 驱动不可重排序列 `closing-live → minting-proof → installing → journal-candidate-installed → reopening-live → verifying-replacement → journal-replacement-verified → settled`；每个不可逆边界前重验证 capability 授权（stale capability 永不可行动）；`run()` exact-once 且永不 reject。失败分类（LOCK-4425）：`pre-install`（live 字节未被替换；曾关闭则以同一授权 reopen 恢复可用性——**非回滚**；recoveryRequired=false）/ `post-install`（rename 已发生；停止一切前进、保留全部产物——installed live 字节/journal/retained snapshot/candidate 残留，安全时确保 live 关闭，recoveryRequired=true；**绝不回滚/restore 快照/清 journal/relaunch**——确定性启动恢复（Phase 4.4.3）拥有这些决定）。Abort 契约：`requestAbort()` 为协作式请求，在每个 subphase 边界的下一个不可逆动作前检查；install 前 abort 按 pre-install 收尾、install 后按 post-install 收尾；lease 绝不提前释放。成功端点：durable `replacement-verified` 后返回 `PromotionExecutionHandoff`（**仍持有 capability/同一 lease**——在 Phase 4.4.3 前不开启竞争窗口）。会话集成（`chatDbImport/index.ts`）：`startPromotionExecution()` 唯一 Main-local 执行入口（`transferPromotionExecution` 同步帧 consume + 永不重置的 per-session start guard，重复/并发启动有界拒绝）；`promoted` 仅在 durable replacement-verified 后经 `completePromotion(token,'promoted')` 结算；executor 失败结算 `promotion-failed`；raced settle → `stale-settle`（durable 产物留给启动恢复，quiesce 后释放）；终局 ownership 结算（审计硬化后）**唯一归属 `startPromotionExecution` continuation**：成功 → capability 从 session 转移至 `PromotionExecutionHandoff`（`promoted` 记录）；post-install recovery-required → 转移至 `PromotionRecoveryRequiredHandoff`（`recovery-required` 记录，**保留同一 lease 至 Phase 4.4.3 或进程退出**——阻断公共 init/close/backup/restore 打开/变更未验证的 installed 替换件）；仅 pre-install 失败在 quiesce 后释放。两类终局记录存于 Main-local `TerminalPromotionOwnership`（`getTerminalPromotionOwnership()` 可查；即使调用方丢弃返回 handoff 也不泄露 owner）；stale session fail/dispose/will-quit 不能释放已转移的终局 capability；async `dispose()`/同步 will-quit `disposeActiveImport()` 经 `releasePromotionOwnership()`（stale-safe prepared dispose 去重 helper；executor 引用存在期间一律延迟给 continuation，未 settle 时另请求协作式 abort）。live-DB surface 由调用方注入（本模块不自行构造/查找 live chatDbService） |
| **实际资产** | 新增：`src/main/services/chatDbImport/promotion/{execution,install,replacementVerifier,readonlyDbValidation}.ts` + `promotion/__tests__/{execution,install,replacementVerifier}.test.ts`。修改：`src/main/services/chatDb/index.ts`（closeForPromotion/reopenForPromotion + closeCore/runInitCore 提取）、`src/main/services/chatDb/maintenanceCoordination.ts`（validatePromotionAuthorization + grant 注册表/holder peek）、`chatDbImport/promotion/journalStore.ts`（受门控 transition API）、`chatDbImport/promotion/preparation.ts`（consume/ExecutingPromotionCapability）、`chatDbImport/promotion/snapshot.ts`（只读门/durability helpers 去重至 readonlyDbValidation 共享模块）、`chatDbImport/index.ts`（transferPromotionExecution/startPromotionExecution/releasePromotionOwnership/abort 集成 + 审计硬化：`takeExecutingCapability`/`PromotionRecoveryRequiredHandoff`/`TerminalPromotionOwnership`/`getTerminalPromotionOwnership`）+ 对应测试扩展（`chatDb.test.ts`、`maintenanceCoordination.test.ts`、`journalStore.test.ts`、`preparation.test.ts`、`chatDbImport/__tests__/index.test.ts`） |
| **独立审计 / 已接受修正** | 审计结论 **pass-with-findings（无阻塞）**，两项 findings 均被接受为 correctness hardening 并已落地：① 成功 promoted 后 `session.executingCapability` 曾保留别名——stale session fail/dispose 可能释放 handoff 的授权 → 修正为显式 ownership 转移（transfer，非 alias）至成功 handoff（`takeExecutingCapability()` + 终局记录），stale 清理路径不再可释放；② post-install 失败在 quiesce 后曾释放 capability——允许进程内公共 init 打开未验证的 installed DB → 修正为 recovery-required handoff 保留 capability/同一 lease 至 Phase 4.4.3 或进程退出（LOCK-4425 强化不变量），维护隔离持续生效。附带清理：prepared-handle disposal 去重 helper、`transferPromotionExecution` 契约 JSDoc 澄清（interim owner → 终局转移）。修正后复验：受影响聚焦套件 35 文件 / 1141 测试通过 / 0 失败（含新增 C24–C26：post-install 后公共 init/close/backup/restore 在真实 coordinator 上持续被拒、stale fail/dispose 不可释放 promoted/recovery-required handoff、pre-install 仍正常释放、handoff owner 保留 exact-once release） |
| **验证事实（最终全量验证完成）** | 聚焦受影响区域测试（chatDb + chatDbImport）：35 文件 / 1141 测试通过 / 0 失败（审计修正后基线；修正前 1138，保留为聚焦验证证据）；`typecheck:node` 通过；changed-files biome/eslint 干净。**最终全量验证通过（未涉及 CI / 未提交 / 未推送）**：`pnpm format` 通过（无文件改动）；`pnpm lint` 通过（0 errors / 87 warnings）；`pnpm test` 通过，275 文件 / 5983 通过 / 72 跳过；`pnpm typecheck:node` 通过；独立审计与复验均 pass（pass-with-findings，两项硬化修正已落地复验）；工作区未提交/未推送 |
| **退出条件** | ✅ exact-once prepared→executing 转移经测试证明（重复/stale/dispose 边界）；✅ 同一持续持有 lease 授权全窗口、伪造/stale 授权在每个不可逆边界被拒；✅ rename-only install + EXDEV 有界失败 + fsync/identity receipt 经测试证明；✅ journal 严格递进（无跳跃/回退/repeat/跨 identity）经测试证明；✅ identity-bound 验证（前后 identity + 完整只读门）经测试证明；✅ pre-install/post-install 失败收尾与产物保留经测试证明；✅ 执行止于 durable replacement-verified（无清理/restore/relaunch） |

**非目标（已由 Phase 4.4.3 落地）**：
- ~~不消费 rollback 快照执行 restore~~ → Phase 4.4.3 `rollback.ts` 落地
- ~~不执行 relaunch~~ → Phase 4.4.3 `relaunch.ts` + `gate.ts` 落地
- ~~不清理 promotion journal / snapshot / candidate 残留~~ → Phase 4.4.3 `journalStore.ts` cleanup APIs 落地
- ~~不实现启动恢复**动作执行器**~~ → Phase 4.4.3 `recoveryExecutor.ts` + `gate.ts` 落地
- 不新增 promotion IPC / preload / Renderer 触发路径（仍排除）

##### Phase 4.4.3：Recovery / Finalization（恢复/终结：artifact probes、rollback、journal cleanup、terminal take、repair marker、recovery executor/gate、startup reorder）

| 属性 | 值 |
|---|---|
| **状态** | **Done（commit `f6a6741b8e`；实现 + 独立审计 pass（两项 accepted fixes：real durable repair marker、startup gate fail-closed）+ 全量验证通过）** |
| **范围** | 在 Phase 4.4.2 终点（durable `replacement-verified` handoff）之上，落地恢复/终结管线的全部执行侧：磁盘 truth 等价探测、rollback 快照 staging clone + 原子 rename restore、durable journal 清理、exact-once terminal ownership take、repair-required 硬阻断标记、recovery executor 编排、startup recovery gate 集成、app-ready 启动重排序。**最大边界**：完整的四动作恢复管线（keep-old-live / accept-verified-replacement / restore-rollback-snapshot / repair-required）+ 启动集成。不新增 promotion IPC / preload / Renderer 触发路径 |
| **四动作语义（LOCK-4431..LOCK-4439）** | **keep-old-live**：live DB 为权威状态；若有效 snapshot-ready journal 存在则清理（install 未启动）；无 relaunch，进程正常继续。**accept-verified-replacement**：replacement 已安装并验证（live present-verified）；清理 replacement-verified journal；relaunch。**restore-rollback-snapshot**：authorization 下关闭 live DB、铸造 closed-live proof、staging clone + 原子 rename restore retained snapshot → live、验证 restored live、清理实际 valid journal phase（含 candidate-installed）；relaunch。**repair-required**：标记 durable repair（hard-block init），保留全部 artifacts，无 cleanup/relaunch |
| **Disk truth 等价探测（LOCK-4431/LOCK-4432）** | `promotion/artifactProbe.ts`：只读 promotion artifact 探测，在 `chatDbService.init()` 之前运行。探测 live/retained snapshot/candidate 三个 artifact 的磁盘状态（missing / present-unverified / present-verified）；路径由 Data root 严格派生（LOCK-4434）；candidateId 经 strict allowlist `^[A-Za-z0-9_-]{1,128}$` 校验后才解析路径。**Sidecar-free invariant**（controlled no-residue strategy）：better-sqlite3 readonly 打开仍可能创建 WAL/SHM sidecar；probe 在验证句柄关闭后检测并清理 probe 创建的 sidecar；composite probe 捕获 before/after directory snapshots 证明零净文件系统变更。`probePromotionArtifacts()` 产出完整 `PromotionArtifactProbesResult`（含 mutation evidence / sidecar-free assertion / cleaned sidecars）；`probeResultToRecoveryInput()` 映射为 `decidePromotionRecovery()` 输入 |
| **Rollback staging clone + 原子 rename（LOCK-4434/4435/4437/4439）** | `promotion/rollback.ts`：bounded primitive（非 executor）。**LOCK-4434**：retained snapshot **从不被消费或删除**。rollback 创建 fixed same-directory staging clone（`chat.db.pre-import-backup.staging`）→ 验证 staging → consume closed-live proof → 删除 live sidecars → 原子 rename staging → live（同文件系统 ONLY；EXDEV = structured failure，**无 copy fallback**，LOCK-4426）→ fsync live parent dir → 确认 destination identity → full readonly validation of restored live DB。**pre-rename atomic block**（LOCK-4435）：verify retained → create staging（`fs.copyFileSync`，closed self-contained source；copy + fsync + full validation gate contain partial-copy risk）→ fsync staging → validate staging → consume proof → delete live sidecars → capture staging identity → atomic rename。Clone decision（Phase 4.4.3 decision rights）：retained source 是 closed、self-contained SQLite（online backup API 产出，WAL 已 checkpoint，经 full readonly gate 验证，通过 atomic rename 发布），无 WAL/SHM sidecar；`fs.copyFileSync` 为 faithful duplicate；partial copy 由 integrity check + migration compatibility gates 确定性捕获；SQLite backup API 被拒绝（source closed，需重新打开仅为用其 backup facility，无安全增益）。**LOCK-4437**：任何 failure 保留 journal、retained snapshot 及全部 facts；pre-rename failures 留 live DB untouched（sidecars 可能已删除）；post-rename failures 保留 resulting state |
| **Durable journal cleanup（LOCK-4435..LOCK-4438）** | `promotion/journalStore.ts` Phase 4.4.3 扩展：新增 idempotent fixed-path cleanup primitive（`cleanupPromotionJournalBody`），由三个 phase-gated API 暴露——`cleanupPromotionJournalAfterReplacementVerified`（replacement-verified）、`cleanupPromotionJournalAfterSnapshotReady`（snapshot-ready）、`cleanupPromotionJournalAfterCandidateInstalled`（candidate-installed）。Guard-read validates current journal → absent = idempotent success；invalid → `CLEANUP_JOURNAL_INVALID`（no unlink）；phase/identity mismatch → `CLEANUP_PHASE_MISMATCH` / `CLEANUP_IDENTITY_MISMATCH`（no unlink）；valid + match → unlink fixed journal（ENOENT race after confirmed presence = idempotent）→ best-effort unlink stale staging（never failure）→ fsync parent directory for durability（LOCK-4438，`syncParentDirectoryForCleanup`；win32 skip；POSIX EINVAL/ENOTSUP/EPERM → `CLEANUP_PARENT_DIR_SYNC_UNSUPPORTED`）。**LOCK-4436**：仅 fixed journal 和 stale staging 为 deletion candidates；rollback snapshot / candidate files / live chat.db **永不被触碰**。Unlink failure → `CLEANUP_UNLINK_FAILED`（journal preserved）；dir sync failure → `CLEANUP_PARENT_DIR_SYNC_FAILED`（journal already unlinked，unlink not rolled back）。Staging unlink failure does not mask primary cleanup |
| **Snapshot retention** | Retained snapshot (`chat.db.pre-import-backup`) 在 replacement-verified 后仍然保留。rollback 使用 staging clone 而非直接消费 retained source。cleanup 永不触碰 retained snapshot。Snapshot 由用户显式管理（保留用于诊断/手动恢复） |
| **Exact-once terminal ownership take（LOCK-4433）** | `chatDbImport/index.ts`：`takeTerminalPromotionOwnership()` atomically take-and-clear `TerminalPromotionOwnership` 记录。First caller after settlement → `taken`（caller 成为 sole owner）；subsequent → `not-available`。`setTerminalPromotionOwnership()` production-safety guard：refuse overwrite unconsumed record（LOCK-4433）。Recovery executor 通过此 API 获取 retained capability/lease 以执行 rollback |
| **Repair hard block（LOCK-4437）** | `chatDb/index.ts`：`markRepairRequiredBeforeInit()` Main-internal durable repair-required marker write。Writes marker file with durable sync（file sync + parent dir sync）survives crashes。Idempotent（marker already exists = no-op）。**Refuses to write if service is already initialized**（unsafe state——live DB handle open must be closed first）。Subsequent `init()` calls refuse with descriptive error until marker explicitly cleared。Main-internal only，never exposed over IPC/preload/renderer |
| **Recovery executor 编排（LOCK-4431..LOCK-4439）** | `promotion/recoveryExecutor.ts`：`createRecoveryExecutor()` 产出 `RecoveryExecutor`（`run()` exact-once never rejects + cooperative `requestAbort()` + `whenSettled()`）。7 subphases canonical order：`probing → deciding → authorizing → executing-action → cleanup-journal → relaunching → settled`。Authorization resolution：destructive actions（restore-rollback-snapshot）require capability；尝试 take terminal ownership first（in-process continuation, LOCK-4433），fallback acquire fresh promotion lease（restart after crash, LOCK-4439）；non-destructive actions use `source: 'none'`。Action execution by decision：keep-old-live（verify live fact, cleanup valid snapshot-ready journal if present）、accept-verified-replacement（require live present-verified, cleanup replacement-verified journal）、restore-rollback-snapshot（close live under authorization, mint proof, run rollbackInstall, verify restored live, cleanup actual valid journal phase）、repair-required（mark durable repair, retain all artifacts）。Journal cleanup：phase-matched cleanup API per decision×phase combination。Relaunch：`mintRelaunchReceipt()` → `relaunchApp(receipt)` exact-once（`app.relaunch() + app.exit(0)`）。 Injectable primitives for test isolation；abort checks at every subphase boundary；authorization released on settle/failure |
| **Relaunch（LOCK-4438）** | `promotion/relaunch.ts`：exact-once receipt-gated relaunch。`mintRelaunchReceipt()` mints branded non-forgeable receipt（WeakSet）。`relaunchApp(receipt, app?)` validates receipt brand + exact-once guard → `app.relaunch() + app.exit(0)`。Receipt consumed on first call；second call = no-op `already-relaunched`。LOCK-4438 precondition（verified authoritative live state + durable cleanup）owned by executor，relaunch module does NOT re-verify |
| **Startup recovery gate（LOCK-4431）** | `promotion/gate.ts`：`runStartupRecoveryGate()` called once from `src/main/index.ts` AFTER `BackupManager.handleStartupRestore()` and BEFORE `chatDbService.init()`。**Absent-journal fast path**（common case）：no journal → no destructive promotion ever began → return `keep-old-live` immediately，no snapshot validation，no relaunch。Valid journal → `probePromotionArtifacts()` → `decidePromotionRecovery()` → execute via `createRecoveryExecutor()`。Result carries `decision` + `executorResult` + `repairRequired` flag + `relaunchPending` flag |
| **Startup ordering（LOCK-4431）** | `src/main/index.ts`：startup order contract：① `BackupManager.handleStartupRestore()` completes → ② **this gate runs**（promotion recovery）→ ③ `chatDbService.init()` → ④ ordinary orphan cleanup / window startup。Gate failure is non-fatal for startup（LOCK-L3）。`repairRequired` → skip `chatDbService.init()`（chat DB unavailable this session）。`relaunchPending` → return early（process exiting） |
| **实际资产** | **新增**：`src/main/services/chatDbImport/promotion/{artifactProbe,gate,recoveryExecutor,rollback,relaunch}.ts`。**修改**：`src/main/services/chatDb/index.ts`（`markRepairRequiredBeforeInit()` + durable marker write）、`src/main/services/chatDbImport/promotion/install.ts`（`validateClosedLiveProof()` narrowly reusable proof validation extracted from `installCandidate`；`installCandidate` refactored to use it）、`src/main/services/chatDbImport/promotion/journalStore.ts`（cleanup APIs + error codes + `syncParentDirectoryForCleanup`）、`src/main/services/chatDbImport/startupRecovery.ts`（re-export gate API）、`src/main/services/chatDbImport/index.ts`（`takeTerminalPromotionOwnership()` + `setTerminalPromotionOwnership()` + exports for relaunch/recoveryExecutor/gate）、`src/main/index.ts`（startup reorder：gate + repairRequired/relaunchPending handling）。**测试**：`chatDbImport/promotion/__tests__/install.test.ts`（`validateClosedLiveProof` 7 tests）、`chatDbImport/promotion/__tests__/journalStore.test.ts`（cleanup 606 lines，LOCK-4435..4438 全覆盖：success paths / staging cleanup / guard rejections / exact path confinement / unlink failure / dir sync failure / crash state / rollback-authorized contract / data root rejection / durable ordering / snapshot byte retention）、`chatDb/__tests__/chatDb.test.ts`（`markRepairRequiredBeforeInit` 6 tests：write+block / idempotent / refuse-when-initialized / refuse-when-repair-already-set + durable sync mock）、`chatDbImport/__tests__/index.test.ts`（`takeTerminalPromotionOwnership` 190 lines：take / double-take / not-consumable guard / set-refuse-unconsumed / integration with settlement） |
| **验证事实（独立审计 + 全量验证完成）** | 聚焦测试 `chatDb` + `chatDbImport`：**71 文件 / 1709 通过 / 72 跳过 / 0 失败**（`pnpm test:main`）。独立审计 **pass**（两项 accepted fixes：① real durable repair marker——`markRepairRequiredBeforeInit()` 耐久写入确认；② startup gate fail-closed——`runStartupRecoveryGate()` absent-journal fast path 确认）；复审 0 findings。**全量验证通过**：`pnpm format` exit 0 无改动；`pnpm lint` exit 0（0 errors / 97 warnings）；`pnpm test` exit 0，281 文件 / 6205 通过 / 72 跳过；`pnpm typecheck:node` 通过。Prior two ENOENT failures non-reproducible after combined/independent/full reruns |
| **退出条件** | ✅ 四动作语义经测试证明（keep-old-live / accept-verified-replacement / restore-rollback-snapshot / repair-required）；✅ artifact probes 只读 + sidecar-free invariant 经测试证明；✅ rollback staging clone + atomic rename + retained snapshot never consumed 经测试证明；✅ durable journal cleanup（phase-gated + identity-bound + idempotent + unlink/dir-sync failure handling）经测试证明；✅ exact-once terminal ownership take 经测试证明；✅ repair marker durable write + init hard-block 经测试证明；✅ recovery executor 7-subphase orchestration + abort + authorization resolution 经测试证明；✅ startup recovery gate（absent-journal fast path + valid journal → execute）经测试证明；✅ startup ordering（gate before init）经集成测试证明；✅ relaunch exact-once receipt-gated 经测试证明；✅ 独立审计 pass（两项 accepted fixes）；✅ 全量 format/lint/test 通过 |

### Phase 5：Cherry Chat SQLite-only 运行时完成

| 属性 | 值 |
|---|---|
| **状态** | **Done**（Phase 5.0–5.4 全部完成；5.1A 已提交 `6fa5ff5ef9`；5.1B 已提交 `e44e413f30`；5.2A 已提交 `e9de29ff97`；5.2B 实现 + 独立审计 + 全量验证完成；5.3 已提交 `b81a35c054`；5.4 feature commit `6c250f19a2` + docs commit `6b2f140955`；最终仓库验证 Node v24.12.0 ABI 137 / pnpm 10.27.0：311 文件 / 6976 通过 / 72 跳过 / 0 失败；lint 0 errors / 17 pre-existing warnings；format/typecheck/git-diff-check 全 PASS；Electron ABI 145 E2E 证据已在 earlier targeted rebuild 中记录；agent runtime UI 因无 Main handler/IPC/UI entry 不可用，非 ABI 问题） |
| **前置** | Phase 4 完成（至少一次成功端到端导入）；**以合并后的 Renderer/context/type/Redux 结构为实施基线（集成同步门见 Section 9「集成同步门（Baseline Sync Gate）」）** |
| **目标** | Cherry Chat 普通聊天路径完全使用 SQLite，移除 Dexie 路由和临时验证 scaffolding |
| **主要任务** | DbService 默认路由直连 SQLite（无 Dexie 路由、无 routingPolicy 注入策略）；移除 Phase 3.4 路由策略代码（C-13）；Dexie 仅保留在隔离 import renderer 内部；从普通聊天路径移除 DexieMessageDataSource（C-11）；清理 Renderer 直接 Dexie 访问（C-10）；性能基准验证（不低于 Dexie 基线） |
| **退出条件** | ✅ 普通聊天路径无 Dexie 依赖；✅ Phase 3.4 routing scaffolding 完全移除；✅ 性能不低于 Dexie 基线；✅ 所有现有测试通过；✅ CI 绿色（本地 gates Done（LOCK-MD6）；push/remote CI **未运行/无 run**（LOCK-MD8：分支已推送 remote SHA `89803503fc...`，GitHub Actions runs for this branch = 0；ci.yml push trigger 仅 `main`/`v1`、无 PR、无手动 dispatch；非失败、非 green CI）） |

> **Phase 5 子阶段边界（本 session 确立）**：Phase 5 拆为 5.0（基线就绪与子阶段划分，Done）、5.1A（SQLite 命令面补全：segments / file-ref / reorder，已提交 `6fa5ff5ef9`）、5.1B（主题生命周期 + 复合命令 + 搜索，已提交 `e44e413f30`，未推送）、5.2A（SearchResults 调用方迁移：Dexie → SQLite 搜索，已提交 `e9de29ff97`，未推送）、5.2B（主题生命周期调用方集成 + 复合操作增强，实现 + 独立审计 + 全量验证完成，未提交/未推送）、5.3（权威切换与 scaffolding 移除，已提交 `b81a35c054`，未推送）、5.4（E2E/性能/A-10 spike harness 清理/文档收尾，Done，未提交/未推送）。Phase 4 全部 LOCK-44xx 与历史决策继续有效，不重复声明。Phase 5 全部 LOCK-51xx 见本节末尾「Phase 5 Decision Locks」。

#### Phase 5.0：基线就绪与子阶段划分

| 属性 | 值 |
|---|---|
| **状态** | **Done** |
| **目标** | 在合并后 Renderer/context/type/Redux 基线上确立 Phase 5 子阶段边界、命令面清单与 Decision Lock 框架 |
| **范围** | 不新增代码；确立 5.0–5.4 拆分、Phase 5 命令面总计（Phase 3.2 的 14 + 5.1A 的 9 + 5.1B 的 12 = 35 个 ChatDb_* 命令）、以及 LOCK-5101…5113 / LOCK-5121…5129 的持久化形式 |
| **退出条件** | ✅ Phase 5 子阶段边界文档化；✅ 命令面清单与 Decision Lock 框架确立；✅ 与 Phase 4 基线一致 |

#### Phase 5.1A：SQLite 命令面补全（segments / file-ref / reorder）

| 属性 | 值 |
|---|---|
| **状态** | **Done（已提交 `6fa5ff5ef9`）** |
| **目标** | 在 Phase 3.2 的 14 命令之上补全 segment 生命周期、file-reference 反向查询、消息重排 |
| **9 个命令（ChatDb_*）** | `ListSegments`、`UpsertSegment`、`UpdateSegmentMetadata`、`DeleteSegment`、`ReplaceSegmentMembership`、`ReorderMessages`、`ListFileRefsByFile`、`CountFileRefsByFile`、`ListBlocksByFile` |
| **约束** | 经 `ChatDbAggregateService` + 新增 typed IPC + `window.api.chatDb` 命名方法 + `SqliteMessageDataSource` 实现（与 Phase 3 模式一致）；segment 操作为全量替换语义（`ReplaceSegmentMembership` 非 merge）；file-ref 查询为只读投影；`ReorderMessages` 仅在 topic 内重写 `sort_order`、不跨 topic 移动 |
| **退出条件** | ✅ 9 命令经 shared contract + aggregate + IPC + preload + renderer datasource 全链路落地；✅ 类型检查 / 聚焦测试通过；✅ 已提交 `6fa5ff5ef9`（未推送） |

#### Phase 5.1B：主题生命周期 + 复合命令 + 搜索

| 属性 | 值 |
|---|---|
| **状态** | **Done（已提交 `e44e413f30`，未推送）** |
| **目标** | 补全主题生命周期（metadata / 软删除 / 恢复 / 回收站 / 硬删除 / 过期清理）、复合消息命令（clone / paste / reset / 带 segment 删除 / 带 segment 清空）、以及 FTS5 归一化搜索 |
| **12 个命令 / 表面（ChatDb_*）** | 主题生命周期 6：`UpdateTopicMetadata`、`SoftDeleteTopic`、`RestoreTopic`、`ListTrashTopics`、`HardDeleteTopic`、`PurgeExpiredTopics`；复合命令 5：`CloneMessagesToTopic`、`ResetMessagesForResend`、`DeleteMessagesWithSegments`、`PasteMessagesToTopic`、`ClearTopicWithSegments`；搜索 1：`SearchMessages` |
| **FileCleanupResult 语义（LOCK-5108 / LOCK-5109）** | 复合 / 生命周期命令在 root 事务内执行 FK cascade（topic → messages → blocks → file_references → topic_segment_memberships）后，返回 `{ affectedFileIds, remainingReferenceCounts }`：**仅为数据报告，DB 事务内无任何文件系统副作用**；是否物理删除文件由调用方依据 `remainingReferenceCounts===0` 决定。事务内绝不改动 Dexie 文件计数 |
| **主题 metadata / trash / purge 语义（LOCK-5103 / 5104 / 5105 / 5113）** | `UpdateTopicMetadata`：name 为 null 清除、absent 不变，pinned 等扩展存于 `extra` JSON，单 root 事务。`SoftDeleteTopic` 置 `deleted_at`，仍可被 `ListTrashTopics` 查询。`RestoreTopic` 清除 `deleted_at`，不复活数据。`HardDeleteTopic` 经 FK cascade 彻底删除。`PurgeExpiredTopics(cutoffTimestamp)` 在单事务内原子清除所有 `deleted_at < cutoff` 的主题；**cutoff 由调用方提供，Main 聚合层不启动计时器、不自算 cutoff（LOCK-5113）** |
| **复合事务 / 所有权规则（LOCK-5106 / 5107）** | 每个多表变更在**一个 root SQLite 事务**内完成（clone / paste / reset / delete-with-segments / clear-with-segments / 生命周期 cascade 均如此）。所有权强制：block/message ID 经「block → message → topic」解析，跨 topic 所有权被拒（例如 paste/reset 拒绝不属于目标 topic 的消息） |
| **migration 003（FTS5 归一化投影，LOCK-5121 / 5126 / 5127）** | append-only `003_fts5_normalized_search`：① `message_blocks_normalized`（block_id PK、message_id、normalized_content，仅 MAIN_TEXT 块）；② `message_blocks_fts`（FTS5 trigram 虚表）；③ 回填现有 MAIN_TEXT 块；④ 三个触发器 `message_blocks_normalized_insert/update/delete`，在 `message_blocks` 写时同步投影（非 MAIN_TEXT 或内容变更时清除投影行）。`chatdb_normalize()` 标量函数在任何触发器触发前注册于原始 better-sqlite3 连接，其实现 = `normalizeSearchText`（stripMarkdown → CRLF→LF → lowercase），为单一事实源（LOCK-5126） |
| **搜索路由与精确匹配（LOCK-5122 / 5123 / 5124 / 5125 / 5128）** | `SearchRepository` 复用 `searchTextNormalization`（共享、与仍 Dexie 的 SearchResults 同一归一化顺序，LOCK-5122）。候选生成：**term ≥ 3 Unicode 码点 → FTS5 trigram；< 3 → 归一化 SQL LIKE**；多 term 取各 term 候选集交集（AND，绝不为可表示 term union LIKE，LOCK-5124）。**FTS 仅为候选加速器，非语义权威（LOCK-5125）**：每个候选必须过共享精确 regex 匹配（whole-word 用 Unicode 边界、CJK 走子串、substring 不包围）；FTS 运行时错误经 `wrapResult → mapErrorToResult` 传播为结构化 `ChatDbFailure`，**绝不 catch 成空结果（LOCK-5101）**。结果仅含最小化 JSON 安全字段（blockId/messageId/topicId/topicName/rawContent/messageCreatedAt，LOCK-5128）。块级游标：`(created_at, message_id, block_id)` 三级排序游标，保证同消息内块级完整分页；**不额外引入 deleted-topic 过滤（与既有 SearchResults 语义一致，LOCK-5123）** |
| **调用方迁移显式延后（Phase 5.2A 边界）** | `SearchMessages` 命令面已实现并通过搜索套件，但 `src/renderer/src/pages/history/components/SearchResults.tsx` 调用方**仍为 Dexie**，仅将 `stripMarkdownFormatting`/`normalizeText` 改为从 `@shared/searchTextNormalization` 复用。**调用方切换到 `chatDb.searchMessages` 属 Phase 5.2A，本阶段不声称已迁移** |
| **10k 基准证据（LOCK-5129，真实运行）** | 载体：`search.bench.ts`（仓库 `*.bench.ts` 约定，仅由 `npx vitest bench --run --project main src/main/services/chatDb/__tests__/search.bench.ts` 收集，普通 `pnpm test` 不执行计时循环）。方法学：确定性 10,000 条 MAIN_TEXT 块（ASCII/CJK/markdown/mixed），10 个代表性 query fixtures；**计时前强制跨全部游标页 / 10 个 query 的直接有序 block-ID 完全 parity 断言**；**3 轮 warmup + 10 轮 measured × 10 query**（每方法 100 样本）；报告 LIKE 基线（全表扫描 + 相同 regex 过滤、按 `(messageCreatedAt, messageId, blockId)` 排序）与 FTS（hybrid，FTS+LIKE）的 p50/p95/mean；无不稳定绝对阈值。产品语义 parity 另由普通套件 `search.test.ts` 的小型确定性语料（300 块、pageSize 20 全游标页）持续守护，不依赖 bench 执行。最新数值（独立 bench 运行）：确定性 10k 直接有序 block-ID parity 10/10；LIKE p50 `6.96ms` / p95 `9.35ms` / mean `6.97ms`；FTS（hybrid）p50 `2.36ms` / p95 `5.20ms` / mean `2.77ms`；加速 p50 `2.95x` / p95 `1.80x` |
| **最终全量验证（独立审计 + 全量门完成）** | 独立审计 pass（含修复后复验）。全量门：`pnpm format` exit 0 无改动；`pnpm lint` exit 0（oxlint 95 warnings / 0 errors；ESLint 33 warnings / 0 errors；current-diff warnings 0；i18n 通过）；`pnpm test` exit 0，283 文件 / 6514 通过 / 72 跳过 / 0 失败 / 181.42s（`search.bench.ts` 排除于普通测试门、单独 bench 运行）；`pnpm typecheck` exit 0 全目标；`git diff --check` exit 0。Phase 5.1B 聚焦套件（`search.test.ts`、`search.bench.ts`、`migration003.test.ts`、aggregate/ipc 扩展）与 `typecheck:node` 通过。已提交 `e44e413f30`（未推送） |
| **退出条件（实现侧）** | ✅ 12 命令经 aggregate + IPC + preload + renderer datasource 落地；✅ migration 003 可幂等应用、触发器维持投影 parity；✅ 搜索正确性 parity 与基准证据成立；✅ 聚焦测试与 typecheck 通过；✅ 最终全量 `pnpm format` / `pnpm lint` / `pnpm test` / `pnpm typecheck` / `git diff --check` 通过。已提交 `e44e413f30`（未推送） |

#### Phase 5.2A：SearchResults 调用方迁移（Dexie → SQLite 搜索）

| 属性 | 值 |
|---|---|
| **状态** | **Done（已提交 `e9de29ff97`，未推送）** |
| **目标** | 将 `SearchResults.tsx` 从 Dexie 搜索切换到 `chatDb.searchMessages`，实现历史搜索路径的 SQLite-only 运行 |
| **前置** | Phase 5.1B 搜索命令面 + 基准完成 |
| **主要任务** | `SearchResults.tsx` 调用方切换到 `chatDb.searchMessages`（复用已迁移的归一化函数）；核对结果映射与现有 UI 行为一致；新增 SearchResults 测试套件（620 行）；i18n 字段更新；`SqliteMessageDataSource` 适配 |
| **退出条件** | ✅ SearchResults 走 SQLite 搜索且行为 parity；✅ 测试覆盖完整；✅ 已提交 `e9de29ff97`（未推送） |

#### Phase 5.2B：主题生命周期调用方集成 + 复合操作增强

| 属性 | 值 |
|---|---|
| **状态** | **实现 + 独立审计 + 全量验证完成（未提交 / 未推送）** |
| **目标** | 在 Phase 5.1B 命令面之上，落地主题生命周期调用方集成（metadata 持久化、trash 恢复流、hard delete 流）、助手空 trash 原子操作、restore wire null 修正、普通 topic 所有权在暴露前的保障、agent Dexie 边界、FileCleanupResult 消费、确定性分页 |
| **实际交付范围** | **新增模块**：`topicMetadataPersist.ts`（topic metadata 持久化层）、`topicTrashLifecycle.ts`（topic trash 生命周期流：soft delete / restore / hard delete / purge 编排）、`topicDeletionFlow.ts`（topic 删除 UI 流）；**修改模块**：`useAssistant.ts`（assistant 空 trash 原子操作 + topic metadata 暴露时序）、`useTopic.ts`（trash 生命周期集成）、`Topics.tsx`（确定性分页 + topic 操作增强）、`TopicTrashPanel.tsx`（trash 面板增强）、`TopicManageMode.tsx`（管理模式集成）、`AssistantItem.tsx`（assistant item trash 集成）、`AssistantService.ts`（assistant trash 方法）、`Chat.tsx`（聊天页集成）、`Inputbar.tsx`（输入栏集成）、`Messages.tsx`（消息列表集成）、`Tabs/index.tsx`（tabs 集成）；**aggregate/IPC**：`ChatDbAggregateService.ts` 新增命令、`ipc.ts` 新增 handler、`preload/index.ts` 新增 bridge 方法、`SqliteMessageDataSource.ts` 新增 renderer datasource 方法、`IpcChannel.ts` 新增 channel、`contracts.ts`/`types.ts` 扩展 |
| **FileCleanupResult 消费（LOCK-5108 / LOCK-5109）** | 复合/生命周期命令返回的 `{ affectedFileIds, remainingReferenceCounts }` 在调用方侧被消费——依据 `remainingReferenceCounts===0` 决定是否物理删除文件；DB 事务内无文件系统副作用 |
| **普通 topic 所有权保障** | topic 在暴露于 UI 操作前完成 ownership 解析与验证；跨 topic 所有权被拒（LOCK-5107） |
| **Agent Dexie 边界** | agent session 操作保持 Dexie 路由隔离；普通 topic 操作不穿越 agent 边界 |
| **确定性分页** | Topics 列表使用确定性分页逻辑，保证翻页稳定性 |
| **已知延后范围（LOCK-DOC4）** | MoveTopic ownership transfer 延后；legacy ImportService ownership 延后；assistant-removal compound flows 属后续工作 |
| **已知限制（LOCK-DOC5）** | Agent session focused assertions 通过，但 runtime agent UI 不可用（无 Main handler/IPC/UI entry），非 ABI 问题；Phase 5.4 E2E 验证 ordinary-chat + topic trash + multi-model + topic move 路径通过 |
| **验证事实** | 标准本地全量验证通过（2026-07-28）：`pnpm format` exit 0 无改动；`pnpm lint` exit 0（33 warnings / 0 errors，标准本地 `CI` 未设置）；`pnpm test` exit 0，289 文件 / 6629 通过 / 72 跳过；`pnpm typecheck` pass；`git diff --check` pass。focused/shared/Main/renderer checks 通过。**CI 环境说明**：`CI=true` 下 `pnpm lint` 会触发 30 个 pre-existing Phase 4 no-console errors（baseline `e9de29ff` 同样复现），属环境/baseline 行为，非 Phase 5.2B 回归（不阻塞本地验证结论）。**closure 注（LOCK-MD9）**：该 no-console baseline 已由 2026-07-31 交付收尾的窄化 Main log bridge/no-console 修复解决（closure 后 CI=true lint 0 errors）。工作区未提交/未推送 |
| **退出条件** | ✅ 主题生命周期调用方集成完成（metadata / trash / hard delete）；✅ 助手空 trash 原子操作完成；✅ FileCleanupResult 消费正确；✅ 确定性分页验证通过；✅ 独立审计 pass；✅ 全量验证通过（289 文件 / 6629 通过 / 72 跳过）。**提交/推送属待办，不声称已完成** |

#### Phase 5.3：权威切换与 scaffolding 移除

| 属性 | 值 |
|---|---|
| **状态** | **Done（实现 + 独立审计 + 全量验证完成；未提交/未推送；Electron ABI 145 已重建，Phase 5.4 E2E 运行时通过）** |
| **目标** | DbService 默认路由直连 SQLite；移除 Phase 3.4 `routingPolicy.ts`（C-13）；从普通路径移除 `DexieMessageDataSource`（C-11）；清理 Renderer 直接 Dexie 访问（C-10）；Dexie 仅保留于隔离 import renderer |
| **前置** | Phase 5.2A + 5.2B 调用方迁移完成 |
| **主要任务** | 翻转默认数据源为 SQLite；删除路由策略注入与 sqlite-authoritative 拒绝路径；Dexie 路由仅留 import renderer 内部 |
| **实际交付范围** | **普通聊天路径直连 SQLite**：`DbService` 默认数据源从 Dexie 切换为 SQLite，所有普通聊天操作经 `SqliteMessageDataSource` → IPC → `ChatDbAggregateService` → `chat.db`。**routingPolicy scaffolding 移除（C-13）**：删除 `src/renderer/src/services/db/routingPolicy.ts`（`DbRoutingPolicy` 类型、`OrdinaryMessageSource`/`DexieMessageSource`/`AgentMessageSource` 依赖接口、`DbServiceDeps` 构造选项、`'dexie'`/`'sqlite-validation'`/`'sqlite-authoritative'` 策略路由）；`DbService` 重构为无注入直连 SQLite（移除构造注入策略、懒加载切换、永久 Dexie 单例）。**DexieMessageDataSource 从普通路径移除（C-11）**：`src/renderer/src/services/db/DexieMessageDataSource.ts` 从普通聊天路径删除（C-10），仅保留于隔离 import renderer 内部。**Agent 边界保留**：agent session 操作仍经 `AgentMessageDataSource` stub（no-op），与 Phase 5.2B agent Dexie 边界一致。**FileCleanupResult / topic 所有权 / composite 事务语义**：Phase 5.1B/5.2B 已实现的 LOCK-5106…5113 不变量在直连 SQLite 路径上继续有效 |
| **Atomic ownership / reset / resend / destructive cleanup** | 原子 ownership 解析（block → message → topic 路径，LOCK-5107）在直连 SQLite 路径上完整保留；reset / resend 操作（`ResetMessagesForResend` / `DeleteMessagesWithSegments` / `ClearTopicWithSegments`）在单 root 事务内执行 FK cascade（LOCK-5106），`FileCleanupResult` 消费语义不变（LOCK-5108/5109） |
| **Agent / import exceptions** | Agent session 操作保持 `AgentMessageDataSource` stub 路由（策略无关最高优先级）；import renderer 内部仍使用 Dexie（Phase 4 隔离 import 架构不变） |
| **已知限制（LOCK-DOC5）** | Agent session focused assertions 通过，但 runtime agent UI 不可用（无 Main handler/IPC/UI entry），非 ABI 问题；Phase 5.4 E2E 验证 ordinary-chat + topic trash + multi-model + topic move 路径通过 |
| **验证事实** | 标准本地全量验证通过（2026-07-29）：`pnpm format` exit 0 无改动；`pnpm lint` exit 0（97 oxlint warnings + 34 ESLint warnings / 0 errors）；`pnpm test` exit 0，295 文件 / 6577 通过 / 72 跳过 / 0 失败；`pnpm typecheck` pass；`git diff --check` pass。独立审计 pass（0 blockers）。工作区已提交 `b81a35c054`，未推送 |
| **退出条件** | ✅ 普通聊天路径无 Dexie 依赖；✅ Phase 3.4 scaffolding 完全移除（routingPolicy.ts 删除）；✅ DexieMessageDataSource 从普通路径移除（C-11）；✅ 直连 SQLite 路径原子 ownership / reset / resend / destructive cleanup 语义完整；✅ agent / import 边界保留；✅ 全部现有测试通过（295 文件 / 6577 通过 / 72 跳过 / 0 失败）；✅ 独立审计 pass；✅ `pnpm format` / `pnpm lint` / `pnpm typecheck` / `git diff --check` 全通过 |

#### Phase 5.4：E2E / 性能 / 清理门

| 属性 | 值 |
|---|---|
| **状态** | **Done（feature commit `6c250f19a2` + docs commit `6b2f140955`）** |
| **前置** | Phase 5.3 完成 |
| **目标** | 端到端验证、性能不低于 Dexie 基线、A-10 spike harness 清理、Group D/E 清理与文档收尾 |
| **实际交付范围** | **Electron ABI 145 重建**：better-sqlite3 为 Electron 重建（ABI 145；Phase 5.4 当时的 Electron 版本，现仓库锁定 Electron 41.2.1），E2E 运行时验证通过。**E2E 验证矩阵**（4 个 spec 文件通过）：① ordinary-chat：真实 send / edit / resend / regenerate / copy + exact request/SQL 验证；② topic-trash：soft-delete / restore / hard-delete / empty-trash + name/title + cross-assistant isolation；③ multi-model：append + real dnd reorder persisted；④ topic-move：real delete + undo/redo persisted。**Agent session**：focused assertions 通过（185 tests），但 runtime agent UI 不可用——因无 Main handler / IPC / UI entry，非 ABI 问题。**性能基准**（方法学说明见下）：消息加载 p50 7.42ms / p95 8.23ms；repository two-transaction write microbenchmark 38.5 batch ops/s / 385.2 msgs/s（诚实标注为 microbenchmark，非聚合生产吞吐）；cold open p95 6.91ms < 500ms。**历史 Dexie comparator 不可用**，仅报告绝对 SQLite 结果，不做相对非回归声明。**Phase 4 spike gate 已通过后删除**：A pass、C1 4/4、C2a 8/8、C2b 10/10 在 Phase 4 spike gate 通过后，22 个 spike-only 文件 + build gate 已移除（A-10 fulfilled/deleted）；production imports 保留/审计。**零 ordinary runtime Dexie chat-table references** 确认；有效例外：agent / import（LOCK-6023 隔离 import renderer 保留）。**Topic name persistence 和 durable file lifecycle correctness fixes** 在 E2E 过程中发现并实现/审计。**文档收尾**：更新本迁移文档反映 Phase 5.4 最终态 |
| **A-10 spike harness 清理** | Phase 4.0 的 22 个 spike-only 文件（含 `packages/shared/phase4*.ts`、`scripts/phase4-*.sh`、`src/main/phase4-*.ts`、`src/preload/phase4-spike-preload.ts`、`src/renderer/phase4Spike.html`、`src/renderer/src/windows/phase4Spike/`、`electron.vite.config.ts` 的 `PHASE4_SPIKE=1` build gate）已移除。A-10 原始保留决策在 Phase 4 spike gate（A pass、C1 4/4、C2a 8/8、C2b 10/10）通过后 fulfilled/deleted。production imports（`src/main/services/chatDbImport/`、`src/preload/chatImport/`、`src/renderer/src/windows/chatImport/`）保留，不受影响 |
| **E2E 方法学** | Playwright E2E 覆盖普通聊天路径（ordinary-chat / topic-trash / multi-model / topic-move）；每个 spec 使用真实 IPC/SQLite 路径（非 mock）；agent session focused assertions 通过但无 runtime UI 覆盖（无 Main handler/IPC/UI entry） |
| **性能方法学** | 消息加载：真实消息加载延迟测量，p50/p95 统计。Repository two-transaction write microbenchmark：两事务写入微基准，标注为微基准非聚合生产吞吐（LOCK-DOC6）。Cold open：冷启动 DB 打开时间 < 500ms。**历史 Dexie comparator 不可用**：不声明相对非回归，仅报告绝对 SQLite 结果（LOCK-DOC7） |
| **最终仓库验证（Node v24.12.0 ABI 137 / pnpm 10.27.0）** | `pnpm format` PASS（无改动）；`env -u CI pnpm lint` PASS（0 errors / 17 pre-existing warnings）；`pnpm typecheck` + i18n + format recheck PASS；`pnpm test` PASS（**311 文件 / 6976 通过 / 72 跳过 / 0 失败**）；`pnpm typecheck` PASS（node/web/aicore 全过）；`git diff --check` PASS；无 generated JS / temp / process artifacts。**better-sqlite3 final local binary 为 ABI 137（host Node v24.12.0）**。**Electron ABI 145 E2E 证据已在 earlier targeted rebuild 中记录**（E2E 运行时通过），不隐含同一 binary 同时适用于两个 ABI。历史 Dexie comparator 不可用，不做相对非回归声明（LOCK-DOC7）。feature commit `6c250f19a2` + docs commit `6b2f140955` |
| **退出条件** | ✅ E2E 通过（4 个 spec：ordinary-chat / topic-trash / multi-model / topic-move）；✅ 性能基准完成（消息加载 p50/p95、write microbenchmark、cold open < 500ms）；✅ A-10 spike harness 已清理（22 文件 + build gate 移除）；✅ 零 ordinary runtime Dexie chat-table references（有效例外 agent/import（LOCK-6023 隔离 import renderer 保留））；✅ Group D/E 清理完成（部分：A-10 已清理；剩余 Group D/E 属 Phase 6）；✅ 文档更新反映最终态；✅ **最终仓库验证通过（311 文件 / 6976 通过 / 72 跳过 / 0 失败；lint 0 errors / 17 pre-existing warnings；format/typecheck/git-diff-check 全 PASS；无 artifacts）** |

#### Phase 5 Decision Locks（LOCK-5101…5113, LOCK-5121…5129）

> 全部 LOCK-51xx 在本 session 确立且**保持 active**；Phase 4 全部 LOCK-44xx 与历史 ADR/决策继续有效。下表为合并相关锁的持久化形式，保留 lock ID 与后续阶段必需的精确不变量；不重复本 session 的冗长 prompt。

| Lock | 精确不变量（后续阶段必需） |
|---|---|
| **LOCK-5101** | 搜索 / 聚合运行时错误经 `wrapResult → mapErrorToResult` 传播为结构化 `ChatDbFailure`；**绝不 catch-to-empty（失败返回零结果）** |
| **LOCK-5102** | Phase 5 SQLite 命令面完整性：所有普通聊天路径命令经 `ChatDbAggregateService` + typed IPC 实现（14 + 9 + 12 = 35 个 `ChatDb_*`）；Dexie 路由移除属 5.3 独立关切 |
| **LOCK-5103** | `UpdateTopicMetadata`：name 为 null 清除、absent 不变；pinned 等扩展存 `extra` JSON；单 root 事务 |
| **LOCK-5104** | `SoftDeleteTopic` 置 `deleted_at`，仍可被 `ListTrashTopics` 查询；普通列表排除 trash |
| **LOCK-5105** | `RestoreTopic` 清除 `deleted_at`，仅恢复可见性、不复活数据 |
| **LOCK-5106** | 复合 / 生命周期命令原子性：每个多表变更在**一个 root SQLite 事务**内完成；FK cascade 处理 blocks→file_references→segments |
| **LOCK-5107** | 所有权强制：block/message ID 经「block → message → topic」解析；跨 topic 所有权被拒 |
| **LOCK-5108** | `FileCleanupResult`：命令仅返回 `{ affectedFileIds, remainingReferenceCounts }`；**DB 事务内无文件系统副作用**；物理删除由调用方据 `remainingReferenceCounts===0` 决定 |
| **LOCK-5109** | `HardDeleteTopic` / `PurgeExpiredTopics`：topic→messages→blocks→file_references 经 FK cascade 在单事务删除；`buildFileCleanupResult` 聚合受影响 file ID；事务内不改 Dexie 文件计数 |
| **LOCK-5110** | `ReorderMessages` 仅在 topic 内重写 `sort_order`，不跨 topic 移动 |
| **LOCK-5111** | Segment 生命周期（5.1A）：upsert/update-metadata/delete/replace-membership/list；`ReplaceSegmentMembership` 为全量替换（非 merge） |
| **LOCK-5112** | file-ref 反向查询（5.1A）：`ListFileRefsByFile` / `CountFileRefsByFile` / `ListBlocksByFile` 为只读投影，无变更 |
| **LOCK-5113** | `PurgeExpiredTopics(cutoffTimestamp)` 的 cutoff **由调用方提供**；Main 聚合层不启动计时器、不自算 cutoff |
| **LOCK-5121** | migration 003 append-only 且幂等；在任何触发器触发前于原始 better-sqlite3 连接注册 `chatdb_normalize()`；可安全应用于既有 DB |
| **LOCK-5122** | 搜索文本归一化单一顺序：`normalizeSearchText = normalizeText(stripMarkdownFormatting(content)).toLowerCase()`（先 stripMarkdown，后 CRLF→LF，后 lowercase）；`searchTextNormalization` 为共享单一事实源，Main / renderer / 仍 Dexie 的 SearchResults 共用 |
| **LOCK-5123** | 搜索必须保留既有 SearchResults 语义（归一化、term 解析、whole-word/substring、CJK 子串、`(created_at, message_id, block_id)` 排序）；SQLite 实现**不额外引入 deleted-topic 过滤**以匹配原调用方数据范围 |
| **LOCK-5124** | FTS 候选路由：term ≥ 3 Unicode 码点 → FTS5 trigram 候选；< 3 → 归一化 SQL LIKE；多 term 取各 term 候选集**交集（AND，绝不为可表示 term union LIKE）** |
| **LOCK-5125** | **FTS 仅为候选加速器，非语义权威**：每个候选必须过共享精确 regex 匹配；FTS 运行时错误传播（绝不 catch-to-empty） |
| **LOCK-5126** | `chatdb_normalize()` 与 `searchTextNormalization` 为归一化单一事实源；触发器与 FTS 填充均调用 `chatdb_normalize()`，无分歧归一器 |
| **LOCK-5127** | migration 003 触发器维持投影 parity：对 MAIN_TEXT 块的 INSERT/UPDATE/DELETE 反映进 `message_blocks_normalized` + `message_blocks_fts`；投影为派生，永不作为权威 |
| **LOCK-5128** | 搜索结果契约仅含最小化 JSON 安全字段（blockId/messageId/topicId/topicName/rawContent/messageCreatedAt），不返回结构化/overflow model 对象 |
| **LOCK-5129** | 基准方法学：确定性 10,000 MAIN_TEXT 块；3 warmup + 10 measured × 10 query；报告 LIKE 与 hybrid 的 p50/p95/mean；**强制跨全部游标页 / 10 query 的有序 block-ID parity**；无不稳定绝对阈值 |
| **LOCK-DOC6** | Phase 5.4 性能基准方法学：repository two-transaction write microbenchmark 标注为微基准，非聚合生产吞吐；消息加载 p50/p95 统计；cold open < 500ms。不做相对 Dexie 非回归声明（因历史 Dexie comparator 不可用） |
| **LOCK-DOC7** | 历史 Dexie 性能 comparator 不可用：Phase 5.4 仅报告绝对 SQLite 结果（消息加载 p50 7.42ms / p95 8.23ms；write microbenchmark 38.5 batch ops/s / 385.2 msgs/s；cold open p95 6.91ms），不声明相对 Dexie 性能非回归 |
| **LOCK-DOC8** | Standard E2E（Playwright `import-cherrystudio.spec.ts`）仅覆盖 selecting-phase UI reachability：fresh build、settings entry、import modal、replace-all warning、Select File enabled、safe close。**未覆盖**：选择 ZIP、触发 import、promote、replace DB、relaunch 验证。L2 replace-all backend correctness 由 focused unit/integration tests（Phase 4/6）覆盖 |
| **LOCK-DOC9** | 历史 commit 修正：Phase 4.4.3 commit 为 `f6a6741b8e`；Phase 5.4 feature commit 为 `6c250f19a2`，docs commit 为 `6b2f140955` |
| **LOCK-DOC10** | 最终全量验证（Phase 5.4 + Phase 6.4）：Node v24.12.0 ABI 137；format PASS；lint PASS 0 errors（warnings as reported）；tests 311 files / 6976 pass / 72 skip / 0 fail；typecheck node/web/aicore PASS；i18n PASS；diff check PASS。Standard Playwright spec 1/1 PASS after fresh build，Electron ABI 145，host ABI 137 restored。**closure 注（LOCK-MD2）**：此 E2E 证据为 **A-class selecting-phase**（`import-cherrystudio.spec.ts`，LOCK-DOC8），保持历史证据、closure 未重跑；B-class `import-cherrystudio-genuine.spec.ts` 为独立 closure 证据（见「Phase 6 交付收尾 / 最终交付证据」） |
| **LOCK-DOC11** | Phase 6 安全/可靠性加固新增决策锁（LOCK-6025–6036）：L2/L3 ZIP 策略分离；duplicate-aware raw CEN counts/safe sizes；local staged hard-link no-clobber publication；destination/workspace identity checks；exact macOS aliases；operation cleanup；accepted syscall-sized same-user TOCTOU（Node lacks descriptor-relative openat/linkat）；same-filesystem staged archive atomic hard-link publication；workspace dev/ino capture with identity-match-gated cleanup；destination component identity revalidation before mkdtemp/staged-open/publish；single-syscall TOCTOU not claimed eliminated |
| **LOCK-DOC12** | L3 restore 接口为 `Promise<void>` direct archive path；legacy logical restore（metadata-less `data.json`/`.bak`）已移除；所有 provider failures 向上层传播，不静默吞没 |

### Phase 6：Cherry Chat 备份/恢复适配、L2/L3 UX 语义分离、清理

| 属性 | 值 |
|---|---|
| **状态** | **Done（实现 + 验证完成；Phase 6 交付收尾 / 最终交付证据（closure，非 Phase 7）见下方独立小节）** |
| **前置** | Phase 5 完成 |
| **目标** | 在 SQLite-authoritative 的 Cherry Chat 上，沿用并适配现有 Cherry Studio 本地/WebDAV/S3 备份与恢复产品流程以对接 chat.db；并将该同应用备份/恢复（L3）与 Cherry Studio ZIP 跨应用兼容导入（L2）的 UX 语义清晰分离；清理所有遗留 |
| **主要任务** | 沿用现有 Cherry Studio 备份/恢复产品行为并适配 chat.db（底层一致性快照由 Phase 1 集成的 better-sqlite3 online backup 机制提供，存储层已就绪，Phase 6 完成产品侧对接与硬化），与 Cherry Studio ZIP 导入 UX 在语义上分离；清理 Group D + Group E 遗留项；更新文档；确认备份协调完整 |
| **退出条件** | ✅ Cherry Chat 备份/恢复（沿用现有产品流程、适配 chat.db）独立运作；✅ Cherry Studio ZIP 导入作为一次性操作独立运作；✅ L2/L3 产品语义清晰分离；✅ Group D/E 清理完成；✅ 文档更新；✅ CI 绿色（本地 gates Done（LOCK-MD6）；push/remote CI **未运行/无 run**（LOCK-MD8：分支已推送 remote SHA `89803503fc...`，GitHub Actions runs for this branch = 0；ci.yml push trigger 仅 `main`/`v1`、无 PR、无手动 dispatch；非失败、非 green CI）） |

> **Phase 6 子阶段边界**：Phase 6 拆为 6.0（L2/L3 架构决策与合同确立）、6.1（L2 Cherry Studio ZIP 兼容导入产品合同实现）、6.2（L3 Cherry Chat 备份/恢复适配与 v7 metadata 实现）、6.3（安全/可靠性加固：ZIP containment、ChatDbBackup workspace 隔离、stream settlement）、6.4（验证门、清理收尾、文档更新）。Phase 4 全部 LOCK-44xx 与 Phase 5 全部 LOCK-51xx 继续有效。Phase 6 LOCK-60xx 见本节末尾「Phase 6 Decision Locks」。

#### Phase 6.0：L2/L3 架构决策与合同确立

| 属性 | 值 |
|---|---|
| **状态** | **Done** |
| **目标** | 确立 L2（Cherry Studio ZIP 跨应用兼容导入）与 L3（Cherry Chat 同应用备份/恢复）的产品语义边界；锁定隔离 import renderer 保留决策；锁定 agents.db 永久保留决策 |
| **决策锁** | LOCK-6001（L2/L3 为不同产品语义）、LOCK-6002（L2 replace-all + macOS-first + 独立 UI）、LOCK-6023（隔离 import renderer 保留，L2 可达要求）、LOCK-6024（agents.db 永久保留，Phase 6 不自动删除/不提示删除） |
| **退出条件** | ✅ L2/L3 产品语义边界文档化；✅ 隔离 import renderer 保留决策锁定；✅ agents.db 永久保留决策锁定 |

#### Phase 6.1：L2 Cherry Studio ZIP 兼容导入产品合同实现

| 属性 | 值 |
|---|---|
| **状态** | **Done** |
| **目标** | 实现 L2 Cherry Studio ZIP 兼容导入的完整产品合同：replace-all 语义、真实 Phase 4 preparation/execution/recovery 管线、macOS-first、独立 UI |
| **产品合同** | L2 为一次性、用户主动选择的跨应用兼容导入。replace-all 语义（非 merge）。使用真实 Phase 4 preparation/execution/recovery 管线（非临时 scaffolding）。macOS-first（A-9 平台拒绝保持）。独立 UI 入口（`src/renderer/src/windows/chatImport/`） |
| **L2 controller 生命周期** | Generation/session-scoped L2 controller（LOCK-6015/6016/6017/6018）：controller 为 generation/session 作用域；finalizing 在 promoted 前完成；exact token-bound terminal handoff settlement |
| **退出条件** | ✅ L2 replace-all 语义经 E2E 验证；✅ L2 controller 生命周期（generation/session-scoped + finalizing before promoted + terminal handoff settlement）经测试证明；✅ macOS-first 平台拒绝生效；✅ 独立 UI 入口可达 |

#### Phase 6.2：L3 Cherry Chat 备份/恢复适配与 v7 metadata 实现

| 属性 | 值 |
|---|---|
| **状态** | **Done** |
| **目标** | 沿用现有 Cherry Studio 本地/WebDAV/S3 备份与恢复产品流程，适配 SQLite-authoritative 的 chat.db；实现 v7 备份格式 metadata |
| **v7 metadata** | 新 v7 备份格式 metadata product/purpose（LOCK-6004/6005）：精确 v6 直接兼容性（LOCK-6008/6009）；完整 metadata + authoritative validated Data/chat.db 在 staging 前必需（LOCK-6004/6005）；metadata-less/data.json/.bak ordinary restore 已移除（LOCK-6008/6009） |
| **备份协调** | 底层一致性快照由 Phase 1 集成的 better-sqlite3 online backup 机制提供（A-6 Accepted）；`BackupManager` 全操作协调（互斥锁、staging、生产路径过滤、恢复后 integrity check）保持不变 |
| **L3 与 L2 语义分离** | L3 为同应用备份/恢复，产品语义独立于 L2（跨应用 ZIP 导入）。底层快照为 Phase 1 的 better-sqlite3 online backup 存储层机制，属存储层能力而非新的产品操作。未来 UI 组件/基础设施可复用但不改变其独立性 |
| **退出条件** | ✅ Cherry Chat 备份/恢复沿用现有产品流程并适配 chat.db 独立运作；✅ v7 metadata 经验证；✅ metadata-less/data.json/.bak ordinary restore 已移除；✅ L3 与 L2 产品语义清晰分离 |

#### Phase 6.3：安全/可靠性加固

| 属性 | 值 |
|---|---|
| **状态** | **Done** |
| **目标** | ZIP containment、ChatDbBackup workspace 隔离、stream settlement/cleanup-before-exit 加固 |
| **ZIP containment（LOCK-6012/6013/6014/6019）** | 安全 ZIP containment：exclusive operation roots/files（操作根目录/文件独占）；stream settlement and cleanup-before-exit across local/WebDAV/S3/Nutstore（本地/WebDAV/S3/Nutstore 全路径 stream settlement 和退出前清理） |
| **ChatDbBackup workspace 隔离（LOCK-6020/6021/6022/6033/6034/6035）** | per-operation destination-local workspace（每次操作独立目标本地工作区）；no shared temp race（无共享临时文件竞争）；validated atomic publish（经验证的原子发布）；same-filesystem staged archive 通过 atomic no-clobber hard link 发布，最终路径从不持有部分数据（LOCK-6033）；workspace dev/ino 捕获，cleanup 仅在 identity 匹配后执行递归清理、不匹配跳过（LOCK-6034）；mkdtemp/staged open/publish 前完整组件 identity 再验证（LOCK-6035） |
| **isolated import renderer 保留（LOCK-6023）** | 隔离 import renderer 保留不变——L2 现已可达且需要隔离 import renderer；不移除、不条件化 |
| **agents.db 永久保留（LOCK-6024）** | 遗留 `agents.db` 永久保留；Phase 6 不自动删除且不提示删除。Agent runtime wiring 属 out of scope |
| **退出条件** | ✅ ZIP containment 加固经测试证明；✅ ChatDbBackup per-operation workspace 隔离经测试证明（无 shared temp race）；✅ validated atomic publish 经测试证明；✅ stream settlement and cleanup-before-exit across all provider paths；✅ 隔离 import renderer 保留（LOCK-6023）；✅ agents.db 永久保留（LOCK-6024） |

#### Phase 6.4：验证门、清理收尾、文档更新

| 属性 | 值 |
|---|---|
| **状态** | **Done** |
| **目标** | 全量验证、Group D/E 清理、文档收尾 |
| **focused validation** | 聚焦安全/ownership/UI 套件通过 |
| **full validation** | `pnpm format` PASS 无改动；`pnpm lint` PASS（0 errors，76 pre-existing warnings）；`pnpm test` PASS（三次连续运行最终通过 311/311 文件，6976 passed，72 skipped，0 failed——含 timing flakes 分类为 pre-existing）；`pnpm typecheck` PASS（node/web/aicore）；`git diff --check` PASS |
| **E2E validation（A-class，历史证据）** | Playwright E2E `tests/e2e/specs/settings/import-cherrystudio.spec.ts` 1/1 PASS（41.9s，Phase 6.4 当时）；Electron ABI 145；disposable profile；host ABI 137 已恢复；SELECT verified。**标准 E2E 覆盖范围（LOCK-DOC8）**：仅 selecting-phase UI reachability——fresh build、settings entry、import modal、replace-all warning、Select File enabled、safe close。**未覆盖**：选择 ZIP、触发 import、promote、replace DB、relaunch 验证。L2 replace-all backend correctness 由 focused unit/integration tests（Phase 4/6）覆盖。**closure（2026-07-31，LOCK-MD2）**：本 A-class spec 保持**历史证据**，closure 中**未重跑** |
| **E2E validation（B-class，closure 证据）** | 独立 spec `tests/e2e/specs/settings/import-cherrystudio-genuine.spec.ts` **1/1 PASS（closure，2026-07-31）**：fresh Electron ABI 145 build 后以精确标准 Playwright 命令运行；结束后 host ABI 137 已恢复。源 fixture 为 **disposable production-format Chromium IndexedDB ZIP fixture**（Level 1 automated compatibility evidence，**非历史用户备份**；历史 release-generated backup 仍为 Level 2，未测试，LOCK-MD3）。硬证据见「Phase 6 交付收尾 / 最终交付证据（closure）」及 LOCK-MD4 |
| **Group D 清理** | C-9（Dexie topics/message_blocks/topic_segments 表）：Phase 5 SQLite-only 完成后，Dexie 仅保留于隔离 import renderer；有效保留（LOCK-6023）。C-10（Renderer 直接 Dexie 访问）：Phase 5 逐步收口至 DbService→IPC 完成。C-11（DexieMessageDataSource）：Phase 5.3 从普通聊天路径移除，仅保留于隔离 import renderer。C-13（Phase 3.4 routingPolicy）：Phase 5.3 已移除 |
| **Group E 清理** | C-12（遗留 agents.db）：永久保留（LOCK-6024），Phase 6 不自动删除且不提示删除 |
| **stale contradictions removed** | 移除旧文档中的「Phase 6 backup Dexie exception」引用（Phase 5.4 有效例外已更正为 agent/import（LOCK-6023））；移除条件化 import renderer 移除语句（LOCK-6023 隔离 import renderer 保留） |
| **退出条件** | ✅ focused validation 通过；✅ full validation 通过（format/lint/test/typecheck/git-diff-check）；✅ E2E 通过（A-class `import-cherrystudio.spec.ts` 1/1 历史证据；B-class `import-cherrystudio-genuine.spec.ts` 1/1 closure 证据，LOCK-MD2）；✅ Group D/E 清理完成；✅ stale contradictions 已移除；✅ 文档更新完成 |

#### Phase 6 交付收尾 / 最终交付证据（closure，非 Phase 7）

> **closure 定位（LOCK-MD1）**：本节为 **Phase 6 交付收尾 / 最终交付证据（closure）**，记录本地交付关闭证据。**不是 Phase 7**：不定义 Phase 7、不重开 Phase 0–6。内容含 A-class/B-class 分开的 E2E 证据、六个交付阻塞项修复、本地 gates/ABI/清理，以及 push/remote CI 的最终事实（post-push：已推送、无 run——非失败、非 green）。

| 属性 | 值 |
|---|---|
| **状态** | **本地 closure 完成（2026-07-31）**；**push/remote CI 事实（LOCK-MD8，post-push）**——origin 分支 `jorkey/refactor/sqlite-migration` 已推送，remote SHA `89803503fce89883bbc93b73f4910b05d90111ea`，upstream tracking `origin/jorkey/refactor/sqlite-migration` 已建立（branch URL `https://github.com/JorkeyLiu/cherry-studio/tree/jorkey/refactor/sqlite-migration`）；GitHub Actions runs for this branch = 0——**未运行/无 run**（非失败、非 green CI）；`.github/workflows/ci.yml` push trigger 仅匹配 `main`/`v1`，未创建 PR、未手动 dispatch；E2E 仍为非远程 CI 证据（B-class 本地标准 Playwright） |
| **环境与 ABI** | Node v24.12.0 / pnpm 10.27.0；B-class 于 fresh Electron ABI 145 build 后运行；结束后 host ABI 137 已恢复（LOCK-MD4/LOCK-MD6） |
| **本地 gates（LOCK-MD6）** | `pnpm format` PASS（无改动）；**`CI=true pnpm lint` PASS，0 errors（76 oxlint warnings + 4 ESLint warnings）**；**`CI=true pnpm test` PASS，312 文件 / 7009 通过 / 72 跳过 / 0 失败**；`pnpm typecheck` PASS（node/web/aiCore）；i18n PASS；`git diff --check` PASS |
| **E2E 证据（LOCK-MD2）** | **A-class** `tests/e2e/specs/settings/import-cherrystudio.spec.ts`（selecting-phase）：保持**历史证据**，**closure 未重跑**。**B-class** `tests/e2e/specs/settings/import-cherrystudio-genuine.spec.ts`：**独立 spec，fresh build 后以精确标准 Playwright 命令 1/1 PASS** |
| **B-class 源（LOCK-MD3）** | **disposable production-format Chromium IndexedDB ZIP fixture**（Level 1 automated compatibility evidence），**非历史用户备份**。历史 release-generated backup 仍为 **Level 2，未测试** |
| **B-class 硬证据（LOCK-MD4）** | public `cherryImport.start` production 路径（非 harness）；必需链经 finalizing（LOCK-6016 保持）；原目标进程退出；安装后目标 `Data/chat.db` 的 fixed topic/message/block/segment IDs + `topic_segment_messages`；baseline replace-all；retained snapshot 保留且 journal/staging 无残留；exact-token relaunch 清理；host ABI137 恢复 |
| **交付阻塞项（LOCK-MD5，六项全部修复）** | ① 窄化 Main log bridge / no-console；② 嵌套 HTML path；③ 自包含 sandbox preload；④ listener-before-ready handshake；⑤ ensure-open-per-read with per-page close；⑥ post-verification checkpoint reseal（严格 install sidecar guard 不变） |
| **清理 / 范围边界（LOCK-MD7）** | C-4 / C-5 / C-7 未实现、parked 供独立未来评估；`agents.db` 保留；agent runtime out of scope；全部生命周期边界与 accepted TOCTOU residual（LOCK-6031 / LOCK-6036）不变 |
| **no-console baseline（LOCK-MD9）** | 历史「CI=true 下 pre-existing no-console errors」baseline 保持历史事实，并已注释为**本 closure 中 resolved**（阻塞项①窄化 Main log bridge/no-console 落地后 CI=true lint 0 errors） |
| **独立审计** | 独立 artifact audit：**pass-with-nonblocking findings**（无阻塞发现） |
| **退出条件** | ✅ 本地 closure 准确记录；✅ push/remote CI 最终事实（post-push：已推送、GitHub Actions runs = 0、未运行/无 run）显式记录、不虚构 CI 状态；✅ 未定义 Phase 7、未重开 Phase 0–6 |

**closure 决策锁（LOCK-MD1…MD9，直接溯源至 closure spec）**：

| Lock | 精确不变量 |
|---|---|
| **LOCK-MD1** | 本节为 Phase 6 交付收尾 / 最终交付证据（closure，非 Phase 7）；不定义 Phase 7、不重开 Phase 0–6 |
| **LOCK-MD2** | A-class `import-cherrystudio.spec.ts` 为历史证据、closure 不重跑；B-class `import-cherrystudio-genuine.spec.ts` 独立、fresh build 后精确标准 Playwright 命令 1/1 PASS |
| **LOCK-MD3** | B-class 源描述为 **disposable production-format Chromium IndexedDB ZIP fixture**（Level 1 automated compatibility evidence），非历史用户备份；历史 release-generated backup 为 Level 2、未测试 |
| **LOCK-MD4** | B-class 硬证据：public `cherryImport.start` production path；经 finalizing 的必需链；原目标进程退出；安装后目标 `Data/chat.db` fixed topic/message/block/segment IDs + `topic_segment_messages`；baseline replace-all；retained snapshot + journal/staging 无残留；exact-token relaunch 清理；host ABI137 恢复 |
| **LOCK-MD5** | 六个交付阻塞项全部修复：窄化 Main log bridge/no-console；嵌套 HTML path；自包含 sandbox preload；listener-before-ready handshake；ensure-open-per-read with per-page close；post-verification checkpoint reseal（严格 install sidecar guard 不变） |
| **LOCK-MD6** | 最终本地 gates：Node v24.12.0 / pnpm 10.27.0；format PASS；CI=true lint PASS 0 errors（76 oxlint + 4 ESLint warnings）；CI=true test PASS 312 文件 / 7009 / 72 skip / 0 fail；typecheck node/web/aiCore PASS；i18n PASS；git diff --check PASS；B-class 1/1 PASS；A-class 未重跑 |
| **LOCK-MD7** | C-4/C-5/C-7 未实现、parked 供独立未来评估；agents.db 保留；agent runtime out of scope；全部生命周期边界与 accepted TOCTOU residual 不变 |
| **LOCK-MD8** | push/remote CI 最终事实（2026-07-31 post-push）：origin 分支 `jorkey/refactor/sqlite-migration` 已推送，remote SHA `89803503fce89883bbc93b73f4910b05d90111ea`，upstream `origin/jorkey/refactor/sqlite-migration` 已建立（branch URL `https://github.com/JorkeyLiu/cherry-studio/tree/jorkey/refactor/sqlite-migration`）；GitHub Actions runs for this branch = 0——**未运行/无 run**（非失败、非 green CI），不虚构 workflow IDs/statuses；`.github/workflows/ci.yml` push trigger 仅 `main`/`v1`，未创建 PR、未手动 dispatch；E2E 非远程 CI 证据（B-class 本地标准 Playwright） |
| **LOCK-MD9** | 保留历史事实；被取代的 no-console baseline 注释为 closure 中 resolved |

#### Phase 6 交付收尾后发现：L2 dev-origin 兼容性缺口（2026-08-01）— 已实现（2026-08-02）

> **定位**：本节为 Phase 6 closure（2026-07-31）后发现的 **L2 导入管线兼容性缺口**，记录发现历史、实现记录、决策锁、最终证据与残余边界。**不是 Phase 7**，不重开 Phase 0–6。Phase 0–6 Done 状态不变。

##### 发现历史（2026-08-01，原始记录）

| 属性 | 值 |
|---|---|
| **发现日期** | 2026-08-01 |
| **发现方式** | 用户从 `electron-vite` dev 模式生成 Cherry Studio ZIP，ZIP intake 接受后隔离 import renderer discovery 失败 |
| **静态证据来源** | `zipIntake.ts` R-12（接受任意 `.ldb` 子目录）；`isolatedSession.ts` line 144–148（固定 `file://` 加载）；`entryPoint.ts` line 404–409（`indexedDB.databases()` discovery）；Chromium origin-to-directory 映射规则 |
| **运行时证据（手动运行时观察 + 静态代码关联，非已提交自动化/E2E 证据）** | ZIP intake 成功（R-12 接受 `IndexedDB/http_localhost_5173.indexeddb.leveldb`）→ 隔离 session 创建成功（`session.fromPath`）→ import renderer 通过 `file://` 加载 → `indexedDB.databases()` 返回空或不含 `CherryStudio` → `[DISCOVERY_FAILED] CherryStudio database not found in isolated IndexedDB` |
| **根因** | **Chromium origin 隔离**：Chromium 根据页面 URL 的 origin 决定 IndexedDB 存储目录。`file://` origin 映射为 `file__0.indexeddb.leveldb`，`http://localhost:5173` origin 映射为 `http_localhost_5173.indexeddb.leveldb`。当时实现固定通过 `pathToFileURL` 加载 `chatImport.html`（`file://` 协议），因此 Chromium 只查找 `file__0` 目录下的 IndexedDB 数据。dev-origin ZIP 的数据在 `http_localhost_5173` 目录下，对 `file://` origin 的 renderer 不可见 |
| **failure 位置** | Phase 4.1 discovery 层（`entryPoint.ts` `runDiscovery()`），在 candidate DB 初始化/promotion **之前** |
| **数据影响** | 无。failure 在 discovery 阶段即停止，未触及候选 DB、未触及 live `chat.db`、未触及源 ZIP 数据 |
| **Phase 0–6 Done 状态影响** | **不变**。Phase 4.1 Done 状态反映 packaged/file-origin scope 内的验证通过。dev-origin 为新的兼容性需求，不构成对 Phase 4.1 完成性的否定 |

##### 实现记录（2026-08-02，closure 后兼容性实现）

| 属性 | 值 |
|---|---|
| **实现日期** | 2026-08-02 |
| **定位** | Phase 6 closure 后兼容性实现，非 Phase 7；不重开 Phase 0–6 |
| **Chromium 自然映射** | Electron 41.2.1 Chromium 自然将精确 `http://localhost:5173` 映射为 `IndexedDB/http_localhost_5173.indexeddb.leveldb`，与 `file://` origin 隔离。无需 rename/复制 origin 目录 |
| **Trusted URL 构造（LOCK-DEV-1）** | 精确 dev renderer URL：`http://localhost:5173/src/windows/chatImport/chatImport.html`。App-owned constant，仅 `app.isPackaged=false` 且精确 dev source mapping 时使用 |
| **Packaged/dev 分支规则（LOCK-DEV-2）** | Packaged 构建：始终 `file://` 协议 + `file__0` origin（不变）。Dev 构建：检测 ZIP 含精确 `http_localhost_5173` 目录时，使用 `http://localhost:5173` 协议加载 import renderer |
| **Accepted mappings** | ① `file__0`（packaged 构建，`IndexedDB/file__0.indexeddb.leveldb`）；② 精确 `http_localhost_5173`（dev 构建，`IndexedDB/http_localhost_5173.indexeddb.leveldb`） |
| **Main intake 分类（LOCK-DEV-3）** | Main intake 分类精确 file__0/dev 映射并在 IPC/窗口/candidate 之前拒绝不支持/歧义/多个 origin 目录 |
| **Renderer 验证（LOCK-DEV-4）** | Renderer 验证精确 dev origin/path/no-search/no-hash；有界操作防止 silent discovering hang。最终验证重构 application-owned exact URL fields 而非接受任意 URL 输入（LOCK-DEV-5） |
| **Unchanged semantics** | Pipeline/state/cancel/promotion 语义不变。State chain：discovering → candidate-ready → verified-candidate → promoting → finalizing |
| **Real Chromium E2E fixture（LOCK-DEV-6）** | Real Chromium E2E fixture 自然生成，无需 rename。4 records |
| **ABI chain（LOCK-DEV-7）** | Fresh build pass；Electron ABI145 proven；host restored Node v24.12.0 ABI137 |
| **File-origin regression（LOCK-DEV-8）** | Genuine file-origin PASS 1/1 53.4s；packaged/file-origin 行为不变 |

##### 最终验证证据

| 测试 | 结果 |
|---|---|
| Dev-origin E2E（`import-cherrystudio-dev-origin.spec.ts`，精确 `http://localhost:5173` fixture） | **PASS 1/1 51.2s** |
| Genuine file-origin E2E（`import-cherrystudio-genuine.spec.ts`，packaged/file-origin fixture） | **PASS 1/1 53.4s** |
| State chain | discovering → candidate-ready → verified-candidate → promoting → finalizing |
| DB records | 4 records |
| Original exit/relaunch exact cleanup | Verified |
| Fresh build pass | Electron ABI145 proven |
| Host ABI | Restored Node v24.12.0 ABI137 |
| Focused main tests | 82 files / 2309 pass / 72 skip |

##### 残余边界与风险

| 边界 | 说明 |
|---|---|
| **Exact localhost:5173 only** | 不接受 `127.0.0.1`、`::1`、其他主机、其他端口、格式错误映射、多个/歧义 origin 目录；未经单独批准均 fail closed |
| **Packaged file-only** | 生产构建不引入 HTTP origin 支持 |
| **No arbitrary URL inference** | 不推断任意 origin；App-owned exact URL fields 为唯一受信来源 |
| **No LevelDB move/parse** | Main 不直接解析 LevelDB（不变） |
| **No product boundary change** | L2/L3 产品语义不变（LOCK-6001）；replace-all 语义不变（LOCK-6002）；隔离 import renderer 保留不变（LOCK-6023） |
| **Cleanup residual** | Unique owned root ordinary cleanup；hard runner/machine failure 可能 leave disposable temp root，no broad automatic cleanup |
| **Platform scope** | macOS-only（A-9）；Windows/Linux 未验证 |
| **Test counts** | 早期全量 Node gate 在最终 doc 之前：7113+ passes；最终有效 repository gates 已记录于下方 explicit-undefined 小节：Node v24.12.0 ABI137，`CI=true pnpm test` exit 0，318 files / 7148 passed / 72 skipped / 0 failed（format/lint 细节不在此重复） |

#### Phase 6 交付收尾后发现：L2 explicit-undefined JSON wire 兼容边界（2026-08-02）— 已修复并验证

> **定位**：本节为 Phase 6 closure（2026-07-31）与 L2 dev-origin 兼容性实现（2026-08-02）之后发现的 **L2 导入管线 JSON wire 兼容边界**修复记录：IndexedDB structured clone 保留显式 `undefined` own-properties，而 JSON wire 不允许 `undefined`，导致真实 dev-origin ZIP 在 candidate 阶段失败。记录原始真实 ZIP 失败/清理事实、实现位置、自动化验证证据、清理/ABI 纪律与残余风险。**不是 Phase 7**，不重开 Phase 0–6。Phase 0–6 Done 状态不变。

##### 原始真实 ZIP 失败事实（2026-08-02，原始记录）

| 属性 | 值 |
|---|---|
| **发现方式** | 用户原始真实 dev-origin ZIP 首次导入（非自动化 fixture） |
| **进展到** | native110/logical11、25 topics、candidate init 开始 |
| **失败点** | `topics[0].messages[0].mentions` 为显式 `undefined`（upgradeToV7 Dexie structured-clone 行形态） |
| **失败机制** | Chromium IndexedDB **structured clone 保留显式 undefined own-properties**（hasOwnProperty=true / value===undefined）；这些行经 import renderer 分页 IPC 传输时，renderer-boundary 未在 IPC 前递归省略 → JSON wire（`undefined` 非法）拒绝，candidate 阶段失败 |
| **清理事实** | candidate / live DB / session / workspace 清理正确；live `chat.db` 与源 ZIP 不受影响 |
| **修复后状态** | 该原始真实 ZIP 为**历史失败点**（`mentions` explicit undefined 为失败链第 ① 步）。修复链（explicit undefined → false shared-ref cycle → topicId mismatch → 孤儿 block 严格拒绝 → approved canonicalizations）完成后，原始 ZIP 由导入 harness **重跑 PASS 1/1（38.9s，fresh ABI145 build）**，失败链以 PASS 终结；此前的「不得声称成功」残余已由 LOCK-OWN-3 / LOCK-BLOCK-3 履行（详见对应小节最终验证证据） |

##### 实现记录（2026-08-02，closure 后兼容性修复）

| 属性 | 值 |
|---|---|
| **实现日期** | 2026-08-02 |
| **定位** | Phase 6 closure 后兼容性修复，非 Phase 7；不重开 Phase 0–6 |
| **Wire 兼容边界** | **IndexedDB structured clone 保留显式 undefined own-properties**；**JSON wire 不允许 undefined**；**renderer-boundary 递归省略（recursive omission）使可选字段 absent/undefined 等价**；**数组中的 undefined 与一切 exotic/non-JSON 值仍被拒绝**；**无 Main validator 放宽/默认/推断** |
| **实现位置** | 依赖中立 renderer 工具 **`src/renderer/src/utils/jsonWire.ts`**（`cloneForWire`，dependency-neutral，无 services/databases/preload imports）；**`SqliteMessageDataSource` 复用**（renderer→Main IPC）；**所有 import 页行在 `entryPoint.ts` 的 `handleReadPage` 中经 Dexie `toArray` 之后、IPC 之前归一化**；**Main/shared validators 未改** |
| **LOCK-N2** | `cloneForWire` 递归省略对象显式 `undefined` 属性（可选 absent/undefined 等价）；数组显式 undefined 元素与 sparse arrays 拒绝 |
| **LOCK-N3** | 非 JSON 值全部拒绝（bigint/symbol/function/Date/Map/Set/TypedArray/NaN/Infinity/class instances/cyclic/depth>20） |
| **LOCK-N5** | 共享依赖中立 renderer 工具：`jsonWire.ts` 同时被 `SqliteMessageDataSource`（renderer→Main IPC）与 chatImport entry point（Dexie→Main IPC）复用 |
| **LOCK-N6** | import 页行归一化位置：`entryPoint.ts` `handleReadPage` 在 `toArray()` 后、`readPageResult` IPC 前对每行 `cloneForWire` |
| **LOCK-N8** | 显式 undefined own-properties 为 upgradeToV7 structured-clone 行形态；fixture 在真实 Chromium IndexedDB 中写入并验证 readback 存活 |
| **LOCK-N11** | E2E fixture 在 Chromium 内对每个 undefined 字段验证 hasOwnProperty 与 valueIsUndefined（false 时精确 throw） |
| **LOCK-C2** | 跨进程证据仅携带 durable booleans（hasOwnProperty/valueIsUndefined），安全跨越序列化边界 |
| **LOCK-C3** | `multiModelMessageStyle` 为 canonical application 字段名（消息 undefined 字段集精确匹配生产 Message 类型） |
| **LOCK-C4** | `importDataPlane` 接受 cloneForWire-normalized 现实 topic/message/block 形态并以 manifest 终结（LOCK-N5/N6/C4） |
| **LOCK-F2** | fixture 在 Chromium 内对 readback 违反精确 throw（false 的 readback 永远无法通过 fixture） |
| **LOCK-F3** | E2E 对每条证据断言 `hasOwnProperty` 与 `valueIsUndefined` 均 `.toBe(true)` |
| **Unchanged semantics** | Pipeline/state/cancel/promotion 语义不变；state chain：candidate-ready → verified-candidate → promoting → finalizing |
| **ABI chain（LOCK-DEV-7 保持）** | Fresh Electron ABI145 build；host restored Node v24.12.0 ABI137 |

##### 最终验证证据

| 测试 | 结果 |
|---|---|
| Dev-origin E2E（`import-cherrystudio-dev-origin.spec.ts`，精确 `http://localhost:5173` fixture，fresh ABI145 build） | **PASS 1/1 55.6s** |
| Genuine file-origin E2E（`import-cherrystudio-genuine.spec.ts`，packaged/file-origin fixture，origin 非回归） | **PASS 1/1 51.8s** |
| Explicit undefined readback（真实 Chromium IndexedDB，LOCK-N8/N11/F2/F3） | **13/13 存活**：hasOwnProperty/valueIsUndefined 均 true（assistantId、modelId、model、type、useful、askId、mentions、enabledMCPs、usage、metrics、multiModelMessageStyle、foldSelected、message_blocks error） |
| State chain（两 flow） | candidate-ready → verified-candidate → promoting → finalizing |
| Original exit | Verified（original target process exited） |
| Live DB 内容 | 含 source 非 baseline |
| Rollback snapshot 内容 | 含 baseline 非 source |
| Promotion artifacts/processes/ports/workspaces | 已清理 |
| Host ABI | Restored Node v24.12.0 ABI137 |
| 独立审计 | 生产修复 + 测试已实现，独立审计 pass |
| 原始真实 ZIP 导入 harness 重跑（definitive，fresh ABI145 build） | **PASS 1/1 38.9s**：历史失败链 explicit undefined → false shared-ref cycle → topicId mismatch → orphan block strict rejection → approved canonicalizations → **PASS**；status chain discovering→candidate-ready→verified-candidate→promoting→finalizing；candidate/live 25/107/120/6/16/4（topics/messages/blocks/segments/memberships/fileRefs）；topicId normalized 2；恰一条合并 count-only warning；integrity ok / FK 空；ZIP 不可变（size 1056109、mtime/inode/mode 不变，MD5 一致） |
| **全量最终验证（Node v24.12.0 ABI137 / pnpm 10.27.0）** | 上述即实现/audit/runtime 证据；最终有效 gates：`pnpm format` exit 0（1803 files，4 个预期文件首次 pass 被格式化、二次 pass clean）；`CI=true pnpm lint` exit 0 / 0 errors / 76 oxlint + 4 ESLint pre-existing warnings / node/web/aicore typecheck + i18n 通过；`CI=true pnpm test` exit 0 / 318 files / 7148 passed / 72 skipped / 0 failed / 309.41s。初始全量 test run 的单一 parseDataUrl <10ms timing failure 经 focused rerun 确认为 flaky，由最终 clean 全量 run 取代 |

##### 残余边界与风险

| 边界 | 说明 |
|---|---|
| **原始真实 ZIP 重跑 PASS（LOCK-OWN-3 / LOCK-BLOCK-3 履行）** | 原始用户真实 dev-origin ZIP（native110/logical11、25 topics、candidate init 后 `topics[0].messages[0].mentions` undefined 失败）为**历史失败点**；修复链完成后由导入 harness **重跑 PASS 1/1（38.9s，fresh ABI145 build）**——status chain discovering→candidate-ready→verified-candidate→promoting→finalizing；candidate/live 计数 25 / 107 / 120 / 6 / 16 / 4（topics/messages/blocks/segments/memberships/fileRefs）；source blocks 125 / skipped 5；topicId normalized 2；恰好一条合并 count-only warning；integrity ok / FK 空。ZIP 不可变（size 1056109、mtime/inode/mode 不变，MD5 一致）；路径保持隐私安全角色描述，不记录绝对用户路径 |
| **Explicit undefined 边界** | 对象 own-property 显式 undefined 被 renderer-boundary 递归省略（absent/undefined 等价）；**数组内 undefined 与一切 exotic/non-JSON 值仍被拒绝**；Main/shared validators 未放宽/默认/推断 |
| **Exact localhost:5173 only** | dev-origin 支持矩阵不变：精确 `http://localhost:5173` 支持；`127.0.0.1`/`::1`/其他主机/端口/歧义 origin fail closed（LOCK-DEV-1…8 保持） |
| **Packaged file-only** | 生产构建不引入 HTTP origin 支持（不变） |
| **No product boundary change** | L2/L3 产品语义（LOCK-6001）、replace-all（LOCK-6002）、隔离 import renderer 保留（LOCK-6023）不变 |
| **Cleanup residual** | Unique owned root ordinary cleanup；hard runner/machine failure 可能 leave disposable temp root，no broad automatic cleanup（不变） |
| **Platform scope** | macOS-only（A-9）；Windows/Linux 未验证（不变） |
| **Full gates（最终验证完成）** | 全量 format/lint/test 最终计数已记录于「最终验证证据」（Node v24.12.0 ABI137 / pnpm 10.27.0：format exit 0；CI=true lint exit 0 / 0 errors；CI=true test exit 0 / 318 files / 7148 passed / 72 skipped / 0 failed / 309.41s）；无剩余 pending 最终计数 |

#### Phase 6 交付收尾后发现：L2 遗留 Dexie 嵌入消息 topicId 归属规范化（2026-08-02）— 已实现（LOCK-OWN-1/2）

> **定位**：本节为 Phase 6 closure（2026-07-31）与 dev-origin / explicit-undefined 兼容性修复（2026-08-02）之后实现的 **L2 导入管线嵌入消息 `topicId` 归属规范化**记录（LOCK-OWN-1/2）。**不是 Phase 7**，不重开 Phase 0–6。Phase 0–6 Done 状态不变。

##### 发现与历史事实

| 属性 | 值 |
|---|---|
| **发现方式** | 只读诊断原始真实 ZIP（不 inspect 内容细节、不修改任何源）：25 topics / 107 messages，**恰好 2 条 `message.topicId` 为有效非空字符串但与外层 `topic.id` 不一致（valid-string mismatch）**；缺失/空/类型非法 0 条；无 topic 内/cross-topic 重复 message ID；两条 stale 引用均指向已存在的 sibling topic |
| **根因** | 遗留 Dexie 行中嵌入消息的冗余 `topicId` 字段可携带过期（stale）但结构有效的外层引用；旧实现在 L2 投影时将其视为严格 ownership 不匹配而拒绝整页 |
| **历史原语（LOCK-OWN-3）** | **此前的原始真实 ZIP ownership 失败（message.topicId mismatch 拒绝）为历史事实**（chronology 保留，失败链第 ③ 步）。**LOCK-OWN-3 已履行（2026-08-02）**：approved canonicalizations 完成后原始 ZIP 由导入 harness 重跑 **PASS 1/1（38.9s，fresh ABI145 build）**——topicId 规范化恰好 2 条（0 缺失/空/非法，无重复 message ID），candidate/live 计数 topics 25 / messages 107 / blocks 120 / segments 6 / memberships 16 / fileRefs 4；恰好一条合并 count-only warning（topicId 2 + 孤儿跳过 5） |
| **数据影响** | 无。仅投影语义变更；原始 ZIP / profiles 未被触碰 |

##### 实现记录（LOCK-OWN-1/2，2026-08-02）

| 属性 | 值 |
|---|---|
| **定位** | closure 后兼容性实现，非 Phase 7；不重开 Phase 0–6 |
| **LOCK-OWN-1（外层 Topic 归属权威）** | `importDataPlane.ts::projectTopicsPage` 中**保留 `requireNonEmptyString` 前置校验**（缺失/空/number/null/object topicId 一律 INVALID_ROW 严格拒绝）；仅对「存在且为有效非空字符串但与外层 `topic.id` 不一致」做规范化：计数递增（非逐条拒绝），并在 `wireToMessage` 之后**始终**将投影 `MessageData.topicId` 覆写为外层 topicId（一致时为空操作）。原始 JsonObject 不突变；消息**不**移动到其声称的 topic |
| **保持严格** | 重复 message ID（页内/跨页/cross-topic）、block 归属、segment membership、file-reference 派生 ownership 全部保持严格拒绝；规范化绝不 bypass 这些 gate |
| **LOCK-OWN-2（隐私 + 事务性计数 + 完成时序）** | Main-only `DataPlaneNormalizationStats.topicIdNormalizationCount`（`getNormalizationStats()` 快照访问器，无别名）。计数 delta 放在 `StagedPage` 上、在 `commitStaged` 于 writer 提交后合并（与 index deltas 同构，LOCK-D9）——初始 0，回滚/拒绝页绝不泄漏；finalize 后保持稳定。编排器（`chatDbImport/index.ts` completeCandidate）在**全部 candidate-completion 成功 gate 之后**（source stats 比对、candidate seal、candidate-ready transition、ready callback 全部通过——即 finalize 之后的最新自然成功点）读取聚合值并**恰好一次**发出 `logger.warn`（仅 >0 时）：source-stats 不匹配 / seal 失败 / ready callback 失败 / 重试的候选完成**绝不**发 warning；verification/promotion 为独立阶段，本 warning 仅作为 candidate-projection canonicalization 证据而非全量导入成功。内容仅含 session/run 上下文 + 聚合计数 + 非内容陈述：**无 topic ID、message ID、名称、内容、路径、源值** |
| **Hash / verifier 一致** | source manifest（evidence `topicId` + digest）与 candidate 写入、candidate verifier 全部消费同一规范化后的投影 `MessageData` 与同一 `entityFraming`——**不重复 canonicalization**；自动化集成测试证明 plane → manifest → sealed candidate → verifier 13 维度全过（见「最终验证证据」） |
| **实现位置** | `src/main/services/chatDbImport/importDataPlane.ts`（投影 + `DataPlaneNormalizationStats` + 访问器 + 事务性计数）、`src/main/services/chatDbImport/index.ts`（`ImportDataPlaneLike.getNormalizationStats()` + 恰好一次 count-only warning）、测试：`__tests__/importDataPlane.test.ts`、`__tests__/index.test.ts`（loggerService mock）、`verification/__tests__/candidateVerifier.test.ts`（全链集成）。**shared DTO 未扩展**（`CandidateImportStats` 不变）；Main/shared 全局校验未放宽 |
| **不变量保持** | LOCK-ABI-1…10 / LOCK-D1…D11 / LOCK-4301…4305 全部继续有效；原始 ZIP / profiles 未触碰；当前 binding 为 Electron ABI 145（native:check:electron PASS，binding hash 不变，未 rebuild） |

##### 最终验证证据

| 测试 | 结果 |
|---|---|
| `importDataPlane.test.ts`（聚焦，real better-sqlite3） | PASS：canonical mismatch 导入外层 owner + 计数 1；匹配值计数 0 / 初始 0；拒绝/回滚页不泄漏计数；缺失/空/number/null/object topicId 严格拒绝；canonicalization 不 bypass 重复/cross-owner gate；manifest evidence.topicId + digest 反映外层（canonical 投影） |
| `candidateVerifier.test.ts`（LOCK-OWN-1 全链集成） | PASS：plane → finalize → manifest → seal → verifier 13 维度全过；manifest evidence.topicId = 外层；digest 为 canonical 投影；candidate 行 `topic_id` 存储外层 |
| `index.test.ts`（LOCK-OWN-2 日志） | PASS：count>0 → **恰好 1 条** warn（聚合计数）；count=0 → 无 warn；finalize 失败 → 无 warn（无双日志）；warn 不含 ID/内容/路径/源值（单字符串参数） |
| `verificationBenchmark.integration.test.ts`（10k 回归） | PASS：既有 10k 全链证据保持（matching topicId 无计数）；无回归 |
| Main typecheck / 聚焦 lint / format / `git diff --check` | PASS（见会话验证结果） |
| binding / ABI | `native:check:electron` PASS（Electron 41.2.1 ABI 145）；binding hash 未变；未 rebuild |
| **原始真实 ZIP 导入 harness 重跑（definitive，fresh ABI145 build）** | **PASS 1/1 38.9s**：status chain discovering→candidate-ready→verified-candidate→promoting→finalizing；topicId normalized 2（恰好一条合并 count-only warning）；candidate/live topics 25 / messages 107 / blocks 120 / segments 6 / memberships 16 / fileRefs 4；integrity ok / FK 空；无 orphan parent / 重复 / cross-topic 链接；snapshot（topics 2 / messages 1 / blocks 1）保留 baseline 且排除导入源；journals/staging 无残留；candidate shells 空；original PID exit / relaunch exact-token 清理；ZIP 不可变（size 1056109、mtime/inode/mode 不变）；binding（ABI 145，hash `48191d9b…`）/ git 未变 |

##### 残余边界与风险

| 边界 | 说明 |
|---|---|
| **LOCK-OWN-3：原始真实 ZIP 重跑 PASS（已履行）** | ownership 失败为历史事实（chronology 保留）；修复链完成后原始 ZIP 由导入 harness **重跑 PASS 1/1（38.9s，fresh ABI145 build）**——topicId 规范化恰好 2 条、无重复/cross-topic 链接、恰好一条合并 count-only warning。**仅对本 artifact（该原始 ZIP）履行**；canonicalization 仅限 L2 导入管线（L1/L3 语义不变，LOCK-6001/6002/6023 不变）；strict residuals（缺失/空/类型非法 topicId、重复 message ID、block/segment/file-reference ownership）保持严格拒绝不变 |
| **仅冗余投影规范化** | 只规范化「有效非空字符串不一致」这一种情况；缺失/空/类型非法与其他全部 ownership 校验保持严格；消息从不移动到其声称的 topic |
| **计数事务性** | 计数仅在整页验证 + 提交成功后合并；拒绝/回滚页不泄漏 |
| **No product boundary change** | L2/L3 产品语义（LOCK-6001）、replace-all（LOCK-6002）、隔离 import renderer 保留（LOCK-6023）不变 |
| **Platform scope** | macOS-only（A-9）；Windows/Linux 未验证（不变） |
| **Full gates** | 本实现会话执行聚焦验证（未运行 rebuild / 全量测试 / E2E / commit / push） |

#### Phase 6 交付收尾后发现：L2 不可达孤儿 block 规范化（2026-08-02）— 已实现（LOCK-BLOCK-1/2/3）

> **定位**：本节为 Phase 6 closure（2026-07-31）与 dev-origin / explicit-undefined 兼容性修复（2026-08-02）以及 LOCK-OWN-1/2 topicId 规范化（2026-08-02）之后实现的 **L2 导入管线不可达孤儿 `message_blocks` 规范化**记录（LOCK-BLOCK-1/2/3）。**不是 Phase 7**，不重开 Phase 0–6。Phase 0–6 Done 状态不变。

##### 发现与历史事实

| 属性 | 值 |
|---|---|
| **发现方式** | 只读诊断精确聚合（不 inspect 内容细节、不修改任何源）：25 topics / 107 messages；嵌入引用 120 个不同 id；源 `message_blocks` 行 125；120 个引用 block 各恰好出现一次且 `messageId` 匹配；**5 个未引用孤儿行全部声称不存在的 messageId**；0 个无效 id、0 重复行/重复引用、0 wrong-owner、0 multi-message 引用、0 finalize 缺失引用 block |
| **根因** | 遗留 Dexie 可残留「死」`message_blocks` 行：block id 未被任何消息 `blocks[]` 引用、且声称的 `messageId` 也不存在于任何消息（被删除消息的残留）。旧实现在 L2 投影时对任何「无 owner」block 行一律 `OWNERSHIP_MISMATCH` 拒绝整页 |
| **历史原语（LOCK-BLOCK-3）** | **此前原始真实 ZIP 的失败链为历史事实（chronology 保留）：① `mentions` explicit undefined（已修复，LOCK-N2/N3）；② false shared-ref cycle；③ `message.topicId` mismatch（已修复，LOCK-OWN-1/2）；④ 不可达孤儿 block ownership 严格拒绝（本修复，LOCK-BLOCK-1/2）；⑤ approved canonicalizations（LOCK-OWN-1/2 + LOCK-BLOCK-1/2）**。**LOCK-BLOCK-3 已履行（2026-08-02）**：修复链完成后原始 ZIP 由导入 harness **重跑 PASS 1/1（38.9s，fresh ABI145 build）**，失败链以 PASS 终结 |
| **数据影响** | 无。仅源投影语义变更（跳过，非删除后写入）；原始 ZIP / profiles 未被触碰；无 archive/schema 变更 |

##### 实现记录（LOCK-BLOCK-1/2，2026-08-02）

| 属性 | 值 |
|---|---|
| **定位** | closure 后兼容性实现，非 Phase 7；不重开 Phase 0–6 |
| **LOCK-BLOCK-1（精确跳过谓词）** | `importDataPlane.ts::projectBlocksPage`：**保留严格行形状与非空 id/messageId/type/status/createdAt 前置校验**（INVALID_ROW 先于分类）；跳过源 `message_blocks` 行当且仅当 (a) `blockOwnerById` 中无该 block id（未被任何导入消息 `blocks[]` 引用）**且** (b) `messageTopicById` 中无该行声称的 `messageId`（不在任何导入消息）。**跳过发生在源页投影时**——从不写入后再 SQL-delete；被跳过行不产生 MessageBlockData / file references / manifest 行 / writer 插入 / seen 标记 |
| **保持严格** | 声称已存在 message 的未引用 block 行仍为 `OWNERSHIP_MISMATCH`；引用 owner 不匹配（含 block.messageId 与索引 owner 不一致）仍为 `OWNERSHIP_MISMATCH`；**重复 source block id 在所有行/页（含被跳过的孤儿行，页内/跨页）仍拒绝**——经独立于 `seenBlockIds`（仅提交写入行）的**事务性 source-seen registry**（`sourceSeenBlockIds`，仅提交成功后合并；失败页不污染、重试有效）；cross-message 重复引用、segment/file-reference ownership、finalize 时 `MISSING_BLOCKS`（reachable 期望 id 对导入 seen id）全部不变 |
| **LOCK-BLOCK-2（隐私 + 事务性计数 + reachable-only 证据 + 完成时序）** | Main-only `DataPlaneNormalizationStats.unreachableBlockSkipCount`（`getNormalizationStats()` 快照访问器，无别名）。计数 delta 放在 `StagedPage` 上、在 `commitStaged` 于 writer 提交后合并（与 index deltas 同构，LOCK-D9）——初始 0，回滚/拒绝页绝不泄漏；finalize 后稳定。编排器（`chatDbImport/index.ts` completeCandidate）在**全部 candidate-completion 成功 gate 之后**（source stats 比对、candidate seal、candidate-ready transition、ready callback 全部通过——即 finalize 之后的最新自然成功点）读取聚合值并**恰好一次**发出 `logger.warn`：每非零类别一条，或两类别（topicId 规范化 + 孤儿跳过）均 >0 时一条**合并** warning；source-stats 不匹配 / seal 失败 / ready callback 失败 / 重试的候选完成**绝不**发 warning；verification/promotion 为独立阶段，本 warning 仅作为 candidate-projection canonicalization 证据而非全量导入成功。内容仅含 session/run 上下文 + 聚合计数 + 非内容陈述：**无 topic/message/block ID、名称、内容、路径、源值** |
| **Source vs candidate 计数语义** | `SourceReadStats.blockRecordCount` **保持 125**（源行分页，含跳过行）；`CandidateImportStats.blockCount` / import manifest（`manifest.blocks.count` + 逐 id digest）/ block hashes **保持 120**（reachable-only）——manifest 与 verifier 自动 reachable-only 因为被跳过行从不 staging；`DataPlaneNormalizationStats.unreachableBlockSkipCount` = 5 |
| **Hash / verifier 一致** | source manifest、candidate 写入、candidate verifier 全部消费同一 reachable-only 投影；集成测试证明 plane → finalize → manifest → sealed candidate → verifier 13 维度全过（见「最终验证证据」） |
| **实现位置** | `src/main/services/chatDbImport/importDataPlane.ts`（`projectBlocksPage` 分类跳过 + source-seen registry + `DataPlaneNormalizationStats` + 访问器 + 事务性计数）、`src/main/services/chatDbImport/index.ts`（合并 warning）、测试：`__tests__/importDataPlane.test.ts`、`__tests__/index.test.ts`（loggerService mock）、`verification/__tests__/candidateVerifier.test.ts`（全链集成）。**shared DTO 未扩展**（`SourceReadStats`/`CandidateImportStats` 不变）；Main/shared 全局校验未放宽 |
| **不变量保持** | LOCK-ABI-1…10 / LOCK-D1…D11 / LOCK-4301…4305 / LOCK-OWN-1/2 全部继续有效；**LOCK-OWN-3 已履行（见残余边界）**；原始 ZIP / profiles 未触碰（重跑仅读取，ZIP 不可变：size 1056109、mtime/inode/mode 不变）；当前 binding 为 Electron ABI 145（native:check:electron PASS，binding hash 不变，未 rebuild） |

##### 最终验证证据

| 测试 | 结果 |
|---|---|
| `importDataPlane.test.ts`（聚焦，real better-sqlite3） | PASS：125/120/5 fixture（20 messages × 6 blocks = 120 引用 + 5 孤儿）——source 125 / candidate 120 / skip 5 / manifest blocks 120 无孤儿 id / candidate DB 恰 120 行 / 孤儿 file payload 不产生引用；未引用 + 已存在 claimed message → `OWNERSHIP_MISMATCH`；重复孤儿行页内/跨页 → `DUPLICATE_RELATION`；无效 id/messageId → INVALID_ROW 先于跳过；DB 约束回滚页不计数、不污染 source-seen registry（孤儿可重试）；原始行不突变 |
| `candidateVerifier.test.ts`（LOCK-BLOCK-1 全链集成） | PASS：plane → finalize → manifest → seal → verifier 13 维度全过；manifest blocks 120 / file refs 0（孤儿 file payload 忽略）；candidate DB 恰 120 行无孤儿 id |
| `index.test.ts`（LOCK-BLOCK-2 日志） | PASS：仅孤儿跳过 >0 → **恰好 1 条** warn（聚合计数 5）；两类别均 >0 → **恰好 1 条合并** warn（计数 2 与 5，即原始 ZIP 预期聚合证据）；count=0 → 无 warn；finalize 失败 → 无 warn；warn 单字符串参数、精确模板、无 ID/内容/路径/源值 |
| `verificationBenchmark.integration.test.ts`（10k 回归） | PASS：既有 10k 全链证据保持；无回归 |
| `importBenchmark.integration.test.ts`（10k candidate） | PASS：既有 10k candidate 证据保持；无回归 |
| Main typecheck / 聚焦 lint / format / `git diff --check` | PASS（见会话验证结果） |
| binding / ABI | `native:check:electron` PASS（Electron 41.2.1 ABI 145）；binding hash 未变；未 rebuild |
| **原始真实 ZIP 导入 harness 重跑（definitive，fresh ABI145 build）** | **PASS 1/1 38.9s**：source `message_blocks` 125（源行分页）→ skipped 5（不可达孤儿）→ candidate blocks 120；candidate/live topics 25 / messages 107 / blocks 120 / segments 6 / memberships 16 / fileRefs 4；topicId normalized 2；**恰好一条合并 count-only warning（topicId 2 + 孤儿跳过 5）**；`integrity_check` ok / `foreign_key_check` 空；无 orphan parent / 重复 / cross-topic 链接；snapshot（topics 2 / messages 1 / blocks 1）保留 baseline 且排除导入源；journals/staging 无残留；candidate shells 空；original PID exit / relaunch exact-token 清理；ZIP 不可变（size 1056109、mtime/inode/mode 不变）；binding（ABI 145，hash `48191d9b…`）/ git 未变 |

##### 残余边界与风险

| 边界 | 说明 |
|---|---|
| **LOCK-BLOCK-3：原始真实 ZIP 重跑 PASS（已履行）** | 失败链为历史事实（chronology 保留，见「发现与历史事实」）；本修复后原始 ZIP 由导入 harness **重跑 PASS 1/1（38.9s，fresh ABI145 build）**——source 125 / skipped 5 / candidate 120、integrity ok / FK 空、无孤儿/重复/cross-topic 链接。**仅对本 artifact 履行**；strict residuals（声称已存在 message 的未引用行 `OWNERSHIP_MISMATCH`、owner 不匹配、重复 id 含孤儿、finalize 缺失引用 block）保持严格不变 |
| **精确跳过谓词** | 仅跳过「block id 未被引用 且 claimed messageId 不存在」的源行；声称已存在 message 的未引用行、引用 owner 不匹配、重复 id（含孤儿）、finalize 缺失引用 block 全部保持严格 |
| **跳过时机** | 源投影时跳过，从不写后删除；无 archive/schema 变更；不推断 attachment/sort order；原始源行不突变 |
| **计数事务性** | 计数与 source-seen registry 仅在整页验证 + 提交成功后合并；拒绝/回滚页不泄漏、不污染 |
| **No product boundary change** | L2/L3 产品语义（LOCK-6001）、replace-all（LOCK-6002）、隔离 import renderer 保留（LOCK-6023）不变 |
| **Platform scope** | macOS-only（A-9）；Windows/Linux 未验证（不变） |
| **Full gates** | 本实现会话执行聚焦验证（未运行 rebuild / 全量测试 / E2E / commit / push） |

#### Phase 6 交付收尾后发现：L2 产品闭环最终实现（2026-08-04）— 确定性身份 / 规范化残余 / 大块 / FTS / 导入回收站 / post-close helper

> **定位**：本节为 Phase 6 closure（2026-07-31）与 dev-origin / explicit-undefined / topicId / orphan-block 兼容性实现之后完成的 **L2 导入管线产品闭环最终实现**（2026-08-04）——从「小规模 fixture 兼容」收口到「精确真实 artifact 全量导入」：确定性消息身份、规范化残余六类、L2/fetch 大块边界、candidate-only FTS、导入回收站五天保留、post-close helper/observer。**不是 Phase 7**，不重开 Phase 0–6。Phase 0–6 Done 状态不变。历史失败链（explicit undefined → false shared-ref cycle → topicId mismatch → orphan block strict rejection）保持历史事实（chronology 保留）；本节最终证据（精确真实 artifact spec 1/1 PASS、Node/Electron gates）为 **final authoritative**。全程隐私安全（LOCK-DOC-2）：不记录 artifact 绝对路径 / ID / 名称 / 内容 / 原始日志 / 临时路径。

##### 确定性全出现消息身份（LOCK-L2ID-1）

| 项 | 最终事实 |
|---|---|
| 源 tuple | `(outerTopicId, legacyMessageId)`——外层 topic 包含关系权威 + 遗留消息 ID 的组合为唯一身份源 |
| 二进制帧 | 精确 magic `cherry-chat:l2-message-id` + version `0x01` + 每段 `uint32be` UTF8 长度 + 字节；顺序无关（order-independent） |
| 目标 ID | `l2m1:` + 64 位小写 SHA256（确定性派生，非随机） |
| 全出现证据 | 精确真实 artifact **129150 条消息全部**经该身份派生；**零 tuple / 派生 / legacy 碰撞**；顺序无关 |
| askId 语义 | 同 topic 内 askId 确定性重映射；**16 条 dangling askId 保留原值、不解析、碰撞防护**（collision-guarded） |
| canonical 一致性 | source manifest / hash / writer / verifier 消费同一 canonical 身份（不重复 canonicalization） |
| 历史对照 | 此前小 fixture（25/107 等）沿用同一确定性路径；非历史失败修复，为全量收口 |

##### 规范化残余与六类 exact-once count-only 类别（LOCK-RES-1）

| 项 | 最终事实 |
|---|---|
| segments 跳过 | absent-topic / all-members-absent 的 `topic_segments` 行跳过（closure/测试证据：**2 rows / 4 memberships**，非 final run 计数） |
| unembedded block 跳过 | 未嵌入（unembedded）且 owner 已存在（existing-owner）的 block 行跳过——**防止内容复活（content resurrection）**（closure/测试证据：**1**） |
| absent-owner 孤儿 | 保持既有行为（不可达孤儿按 LOCK-BLOCK-1 跳过，见 LOCK-BLOCK-1/2/3） |
| strict 剩余冲突 | 其余全部 ownership/identity/relation 冲突保持严格拒绝不变 |
| 六类类别 | 规范化统计现覆盖**六个 exact-once count-only 类别**（扩展自 topicId + orphan 两类别合并 warning；LOCK-OWN-2 / LOCK-BLOCK-2 保持）；Main-only、快照访问器、finalize 后恰好一次 count-only warning、无 ID/内容/路径/源值 |
| 计数 provenance | **不声称 final real spec 未发出的逐类别计数**（LOCK-DOC-3）：已知计数（topicId 2 / orphan 5 / segments 2 rows / unembedded 1）均以 logical closure / 聚焦测试证据标注，与 final run 计数分开记录 |

##### L2/fetch 大块边界（LOCK-LGBLK-1）

| 项 | 最终事实 |
|---|---|
| L2/fetch profile | 字符串 8 MiB / 行 16 MiB / 页与结果 64 MiB；depth 20 / array 100k |
| generic profile | 通用 1 MiB 不变 |
| 精确真实 artifact | **3 行 >1 MiB**（1 orphan、2 reachable），最大字符串约 **2.67 MB** |
| 处理 | reachable 行正常导入；orphan 行按 LOCK-BLOCK-1 跳过 |
| 验证 | L2/fetch 边界在 exact-once 页/结果路径生效，未破坏既有 wire 校验 |

##### candidate-only FTS（LOCK-FTS-1）

| 项 | 最终事实 |
|---|---|
| 延迟策略 | migration 003 派生触发器/表（`message_blocks_normalized` / `message_blocks_fts`）改为 **candidate-only 延迟**（candidate DB 构建时生成；live 运行时不再维护派生 FTS 结构） |
| 原子重建 | **一次原子重建**在 candidate seal 前完成（rebuild ~85ms @10k，对比此前每页超线性 16–41s/page） |
| 14 维 verifier | 新增**精确 search_projection 为第 14 验证维度** + 只读 gates；**精确有序 multiset parity**（ordered multiset）验证 |
| 性能 | 结构性基准 ~103ms/page（10k 语料）；candidate 路径隔离/生命周期硬化（重启/清理边界） |
| 历史对照 | 此前 FTS 触发器随 live 写入逐条维护（Phase 5.1B LOCK-5121…5129）；candidate-only 为 L2 导入收口后的结构决策，Phase 5 搜索命令面语义不变 |

##### 导入回收站语义（imported trash，LOCK-TRASH-1）

| 项 | 最终事实 |
|---|---|
| deletedAt | 源 `deletedAt` 原样保留 |
| overflow marker | Main-only `l2TrashRetentionStartedAt` overflow 标记，**每次导入生成一次**；置于 manifest/writer 之前（含于证据与写入） |
| purge 语义 | 生效时间为 max(deletedAt, 有效 marker)；**从导入起五天** |
| restore | 恢复清除 marker |
| invalid 回退 | marker 无效时回退 count-warning（不误删） |
| wire | 输出 wire 剥离 marker（renderer 不可见） |
| 最终精确 artifact | SQLite **2707** 条 / active nav **2704** / deletedTopics **3**（导入回收站三条保留、可恢复） |

##### 导航 / 投影 / 重启 / 选择性 ZIP 合同

> handoff 既有合同保持有效（navigation / projection / restart / selective ZIP）；最终合成 E2E 全部通过。

##### post-close helper / observer（test-only 硬化，LOCK-HELPER-1）

| 项 | 最终事实 |
|---|---|
| retained status history | payload-aware 保留状态历史 |
| batched readonly verify | typed 批量只读验证；**≤60s 动态 attempt deadline**；精确 integrity / FK / six counts / deletedTopics |
| snapshot | strict（严格只读、零变更） |
| privacy | 输出无 artifact 路径 / ID / 名称 / 内容 / 原始日志 / 临时路径 |
| 定位 | **test-only** 辅助/观察器；不影响生产路径 |

##### 最终验证证据（final authoritative）

| 测试 | 结果 |
|---|---|
| **Node gates（latest-source，Node v24.12.0 ABI137，2026-08-04 最终序列）** | `native:rebuild:node` exit 0（ABI137 SQL PASS）；`pnpm format` exit 0（1 个文件首次 pass 被修复、二次 pass clean，身份未指明）；`CI=true pnpm lint` exit 0 / 0 errors / **81 oxlint + 4 ESLint pre-existing warnings**；typecheck（node/web/aicore）+ i18n PASS；`CI=true pnpm test` exit 0 / **335 files（1 skipped）/ 7901 tests passed / 75 skipped / 0 failed**。**时间顺序（LOCK-DOC-3）**：user-source 7890/74（helper/privacy docs 前）为历史证据；latest-source 重跑已完成、无 pending |
| **Electron gates（final）** | native rebuild / check / build PASS；标准 E2E ordinary / genuine / dev / **large** 均 **1/1**；**精确真实 spec 1/1（6m48s）**：candidate topics **2707** / messages **129150** / blocks **158441** / segments **13** / memberships **39** / fileRefs **4158** / pages **365** / elapsed **136307**；全链 promoted |
| **精确真实 spec 验证** | integrity / FK、six counts、snapshot、**14 维**、projection / UI / reload 全 PASS |
| **ZIP 指纹** | **不变**：size **1393936335**、full SHA **locked**、inode / mode / mtime 不变 |
| **ABI** | final **ABI145**（Electron 41.2.1） |

##### 残余边界与风险

| 边界 | 说明 |
|---|---|
| Node latest-source 重跑 | **已完成（2026-08-04 最终序列，见上表）**：335 files（1 skipped）/ 7901 tests passed / 75 skipped / 0 failed；user-source 7890/74 为 helper/privacy docs 前历史证据，无 pending 重跑（本 docs 修改不包含任何代码） |
| 计数 provenance | final run 未发出的逐类别规范化计数不声明；已知计数以 closure/test 证据标注（LOCK-DOC-3） |
| strict residuals | 全部严格拒绝路径保持不变（LOCK-OWN / LOCK-BLOCK / LOCK-RES-1） |
| 隐私 | 本文档不记录 artifact 绝对路径 / ID / 名称 / 内容 / 原始日志 / 临时路径（LOCK-DOC-2）；ZIP size / full SHA / inode / mode / mtime 为既有风格指纹证据 |
| 远程 CI | 无新 commit / push / PR / run（LOCK-GIT-1；见 §17 远程 CI 行） |
| Platform scope | macOS-only（A-9）不变 |

#### Phase 6 交付收尾后发现：L2 attachment/file 兼容修复（2026-08-05）— 已实现

> **定位**：本节为 Phase 6 closure（2026-07-31）与 L2 产品闭环最终实现（2026-08-04）之后完成的 **L2 attachment/file 兼容性修复**（用户批准合同 2026-08-04；实现分三个依赖阶段：候选文件 artifact → 三 artifact promotion/recovery → catalog handoff + unavailable UI + L3/E2E + 文档，每阶段独立审计）。**不是 Phase 7**，不重开 Phase 0–6。Phase 0–6 Done 状态不变。历史契约（Phase 2「file references 为元数据快照」、Q-3「不建 canonical files 表」、非目标「文件内容 blob 迁移」）保持历史事实（chronology 保留，LOCK-DOC-1），在对应位置以 dated superseded 标注；本节为 current 边界。全程隐私安全（LOCK-DOC-2）：不记录 artifact 绝对路径 / 文件 ID / 名称 / 内容 / 精确哈希。

##### 用户批准合同（分类，LOCK-DOC-3）

| 类别 | 精确内容（用户批准，2026-08-04） |
|---|---|
| **A. Archive/session fatal（整批拒绝）** | ZIP 路径穿越；symlink/hardlink 或不支持 entry type；加密 entry；重复 archive path；Unicode/case-fold 后的目标路径冲突；central directory 损坏到无法安全继续；zip-bomb / entry count / 压缩比 / 资源配额超限；磁盘空间预检失败；candidate/journal/snapshot/promotion 无法保证恢复；同一 file ID 对应多个无法区分的 payload |
| **B. Reference degraded（不得阻止聊天导入）** | 被引用但 payload 缺失；被引用但 Dexie catalog row 缺失；catalog metadata 与 block/file-reference snapshot 不一致；单个 payload CRC / 大小 / 读取校验失败但解析器仍可安全继续；文件内容丢失但消息及 file metadata 完整。**处理规则**：保留 message block 与 SQLite file_reference metadata；不创建声称文件存在的 catalog row；不创建空文件或伪造 payload；附件视为 **unavailable**；UI 保留文件名/类型、预览明确提示不可用；只记录聚合计数（日志不含文件名/路径/用户内容）；**单个附件降级不得导致整个聊天导入失败** |
| **C. Optional catalog/orphan** | catalog row 有合法 payload、即使当前无消息引用也导入 catalog + payload（文件浏览器与源备份一致）；catalog row 缺 payload → 跳过该 row 并计数；payload 存在但无 catalog row 且无消息引用 → 跳过；缺 catalog row 但 file-reference snapshot 完整一致且 payload 唯一可定位 → 作为**单独、显式记录**的 reference-backed catalog canonicalization；metadata 不完整或多个 reference snapshot 互相冲突 → **不猜测，按 unavailable 降级** |

##### 实现记录（2026-08-05）

| 属性 | 值 |
|---|---|
| **定位** | closure 后兼容性修复，非 Phase 7；不重开 Phase 0–6 |
| **候选文件 artifact（attachmentPlane，LOCK-FIX-1…9 + LOCK-CORR-1…4）** | 源 `Data/Files` payload + 源 Dexie `files` catalog 行 + committed candidate file references → sealed candidate artifacts：① **candidate Files 目录**——canonical `Files/<id><ext>`（LOCK-FIX-2/6），流式提取 + 流式 SHA-256（LOCK-FIX-7，never whole-file buffered）；② **durable catalog handoff**——`files-catalog.json`（LOCK-FIX-2），normalized rows，供 promotion 阶段填 live Dexie `files` 表（LOCK-FIX-1：Dexie catalog 保持权威，**无 SQL files 表**）；③ **degraded manifest/statistics**——aggregate count-only（LOCK-FIX-4/5），never per-file。分类：HEALTHY / DEGRADED（missingPayload、missingCatalogRow、metadataMismatch、payloadReadFailure、lostContent、invalidTargetName、duplicateCatalogRow）/ SKIPPED（payloadWithoutCatalog）/ FATAL |
| **不变量（LOCK-FIX-6/8/9）** | 源 ZIP 永不被修改；源绝对路径永不进入 handoff（`path` 为 candidate-relative `Files/<id><ext>`）；物理 size + 流式 SHA-256 为物理权威（size 差异=degrade，缺失=无 claim）；handoff 原子写（temp+rename）+ read-back 校验 + healthy payload 写后重述（fail closed → `CANDIDATE_STATE_UNRECOVERABLE`）；**健康未引用 target count ≥ 1**——重建引用计数使启动孤儿清理（count ≤ 0）永不误删已导入未引用文件；candidate discard 精确移除全部 artifacts（LOCK-FIX-9） |
| **LOCK-CORR-1…4（审计修正）** | ① cancel/dispose 在 durable publication 与 finalize 后 seal 前复检，取消会话永不 candidate-ready；② 增量**流式 CRC-32**（zlib.crc32）对**每个** payload（含 bit-3 data-descriptor 条目，node-stream-zip 跳过自验）与 central-directory CRC 比对，mismatch → payloadReadFailure degrade；③ ZIP 每 finalize 仅 reopen + central directory 解析一次，共享 handle + entry map，finally 精确一次关闭；④ entry-not-found 为 payload 级 degrade；archive open / CEN / global parser 失败保持 fatal |
| **Data/Files 预算 + 磁盘预检（LOCK-DOC-5，LOCK-PROD-9）** | **独立预算模型**：IndexedDB / Local Storage / Data/Files 各自独立资源上限（不再用 500 MiB 容器限制直接拒绝真实长期备份）；Data/Files：前缀 `Data/Files/`、单 entry ≤ 2 GiB、累计解压 ≤ 8 GiB、压缩比等硬上限保留；流式 SHA-256 + 增量 CRC-32；提取前磁盘预检（需求 + 256 MiB 安全余量，statfs fail-closed → `DISK_PREFLIGHT_FAILED`）；**1.30 GiB 级理性**——阈值依据真实 1.39 GiB 备份 inventory（1393936335 bytes ≈ 1.30 GiB）与资源模型确定，**不声明无限制支持** |
| **Promotion journal v2（LOCK-PROMO-2/10/12）** | **v1**（LOCK-4404）chat.db-only：`version/sessionId/candidateId/phase` ∈ `snapshot-ready \| candidate-installed \| replacement-verified`。**v2（LOCK-PROMO-2）三 artifact**：`version/sessionId/candidateId/phase/receipts`，phase ∈ `candidates-ready → snapshots-ready → db-installed → files-installed → catalog-pending → catalog-applied → replacement-verified`（7 相）；receipts = candidate + old 两代 aggregate 完整性（counts + canonical SHA-256 over candidate/old artifacts），**无文件名/路径/内容/raw IDs（LOCK-PROMO-12）**。**v1 兼容（LOCK-PROMO-10）**：v1 journal 仍可解码并按原 chat.db-only 协议恢复，绝不重释为部分安装的 Files 代。**短时不可取消边界**：promotion（破坏性窗口）开始后短时不可取消；此前允许取消并精确清理 candidate（LOCK-CLEAN-1…5：journal 存在期间绝不删除 candidate 证据；journal cleanup 后才移除 owned candidate 目录） |
| **Recovery v2（LOCK-PROMO-6/7，LOCK-JRNL-1/3/4，LOCK-AMB-3/4）** | 五动作：keep-old-live / complete-catalog-apply / accept-verified-replacement / restore-rollback-snapshot（**三 artifact 全恢复**，逐代验证）/ repair-required；**每个 journal phase 崩溃恢复收敛到全新或全旧**——rollback-midway（restored OLD db 后 Files/catalog 未恢复）绝不 forward/accept（经 live DB 精确 identity：size + SHA-256 vs journal candidate db receipt 识别混代）。**236,196 组合全枚举**（9 journals × 3 live × 3 dbSnapshot × 2 candidate × 3 files × 3 filesSnapshot × 2 filesStaging × 3 catalogSnapshot × 3 catalogApplied × 3 candidateCatalog × 3 liveDbReceiptMatchesCandidate），**惰性 generator 枚举、绝不物化数组**（LOCK-MEM-1/2/3）；deferredToWindow（catalog boundary 不可用 → recovery-only window 模式）与 deferredToStartup（terminal-handoff lease-busy → 新进程启动恢复确定性重验/接受/清理） |
| **Catalog UI gate / retry / repair（LOCK-PROMO-7，LOCK-F2，LOCK-CAT-1/4/5/8，LOCK-BRIDGE-1）** | `catalogRecoveryRequired` 时 app **不启动普通 UI**；创建 minimal recovery-only BrowserWindow（`?cherryImportRecovery=1`，仅渲染静态 recovery surface，普通数据流阻断）；注册 catalog boundary（apply-candidate / restore-snapshot / query-facts），等待 renderer authenticated ready（有界，不竞态 handler mount）；单次 transient failure 以 fresh recovery window **重试一次**（预算 ≤ 2 windows，journal/protocol 语义不变），预算耗尽或非 transient → 保持 recovery window 存活并导航至**有界 terminal repair surface**（i18n text + machine code only，无路径/名字/内容/ID）；catalog apply/restore 均为**单 Dexie 事务 replace-all**；catalog-pending 期间普通 UI 阻断 |
| **Unavailable marker（LOCK-UI-1…6）** | import-only per-block **`l2AttachmentUnavailable=true`** overflow marker：candidate seal 前按 reference-degraded file id 批量写入引用块（单 SQLite transaction；仅引用 degraded 文件的块被标记，healthy / degraded-but-unreferenced / 孤儿不标记，LOCK-UI-2）；Renderer 只读标记显示 unavailable 占位并禁用预览（不逐渲染 IPC、不触发 Sharp/文件 IPC 缺文件错误）；token estimation `imageSize` 与图片复用 `base64Image` 均加 marker guard；**隐私（LOCK-UI-5）**：degraded 分类与 marker 结果 aggregate count-only，Main-only 隐私内部 degraded file id set（快照访问器、无别名）；**确定性（LOCK-UI-6）**：marker 从 record/overflow digest 确定性剥离，candidate 仍过全部 14 维，wire adapter 往返保留 |
| **L3（LOCK-L3-1/2/3/4）** | 备份现包含 **live `Data/Files` 递归 byte-identical** + **IndexedDB Dexie catalog 存储**（LOCK-L3-1）；**promotion artifact 排除（LOCK-L3-2）**——candidate 根目录、promotion journal/staging、rollback 快照（chat.db + Files 快照/old/staging 目录）、Files promote staging、catalog snapshot/staging 等全部从备份排除；restore round-trip 保留物理 Files 字节与 catalog 存储、不激活 promotion artifact（LOCK-L3-3）；**skipBackupFile 不对称（LOCK-L3-4）**——`skipBackupFile=true` 时排除 `Data/Files` 但**保留 IndexedDB catalog**（chat.db 快照仍强制包含，LOCK-6008） |

##### 最终验证证据（LOCK-DOC-7）

| 测试 | 结果 |
|---|---|
| **合成附件标准 E2E（`import-cherrystudio-attachments.spec.ts`，fresh production build）** | **PASS 1/1（约 1m57s）**：4 catalog rows / 3 payload / 1 degraded missing（unavailable）/ 3 file references；图片渲染、附件 UI unavailable 占位、文件浏览器（Files 页列出 png/txt/orphan、排除 missing、无 Invalid Date）、ZIP 指纹不变、**同 profile 重启后全部存活** |
| **真实 opt-in 大 ZIP（`import-cherrystudio-real-backup.spec.ts`，`CHERRY_E2E_REAL_ZIP` opt-in，隐私关闭 trace/screenshot/video）** | **PASS 1/1（final-source 权威）**：完整链路 **4 分 36 秒**、**1.30 GiB 级**（此前 run 完整链路 4 分 54 秒 / post-finalizing 2 分 53 秒为历史证据，时间顺序保留——旧 180s marker timeout 实测过短：finalizing 后全 DB 校验 + 4158 文件全量哈希 + catalog facts + 大 Renderer reload；real-only marker budget 调至 6 分钟、生产校验强度不变、重跑通过，**该超时非产品缺陷证据**）；聚合 candidate topics **2707** / messages **129150** / blocks **158441** / file refs **4158**、active **2704** / deleted **0**；**ZIP 不可变（boolean）**；integrity/FK 通过；无残留进程/profile |
| **RecoveryV2 穷举（`recoveryV2.test.ts`）** | **236,196 惰性组合全覆盖；47/47 PASS、约 25s、主进程峰值约 341 MiB / 全部 Vitest 进程合计峰值约 775 MiB**（plain Node24 单 fork、自然 exit 0、无残留进程）；**被强退的运行明确非证据**（仅证明旧物化方式资源耗尽） |
| **全量最终 gates（final-source 权威）** | **全部通过（LOCK-DOC-7）**：实现 + 聚焦测试（attachmentPlane / attachmentMarkers / journalStoreV2 / recoveryV2 / recoveryExecutorV2 / catalogApplyIpc / catalogStartupRecovery / rollbackV2 / execution / backupManager.production 等）+ 合成/真实 E2E 完成。Node24.12 ABI137 / pnpm 10.27.0：`pnpm format` exit 0（**1882 files**，1 个文件首次 pass 被修复、二次 pass clean/稳定）；`CI=true pnpm lint` exit 0（0 errors；**85 ESLint + 4 oxlint known warnings**；node/web/aicore typecheck + i18n + format PASS）；`CI=true pnpm test` exit 0（**357 files passed / 1 file skipped**；**8647 passed / 75 skipped / 0 failed / 127.09s**）。Electron final（ABI145）：`native:rebuild:electron` PASS、`pnpm build` PASS（**12.5s**） |

##### 残余边界与风险

| 边界 | 说明 |
|---|---|
| **预算不声明无限制** | Data/Files 独立预算 + 硬上限保留，阈值按真实 1.39 GiB 级 inventory 与资源模型确定（LOCK-DOC-5） |
| **计数 provenance** | final run 未发出的逐类别 degraded 计数不声明；分类以用户批准合同（LOCK-DOC-3）为准 |
| **隐私** | 本文档不记录 artifact 绝对路径 / 文件 ID / 名称 / 内容 / 精确哈希（LOCK-DOC-2）；ZIP 不可变以 boolean 记录 |
| **无 commit / push / PR / 远程 CI 声明（LOCK-DOC-8）** | 实现与测试全部位于本地工作树（未提交、未推送）；不虚构任何远程状态 |
| **strict residuals** | archive fatal 整批拒绝、reference degraded 聚合计数、optional 跳过语义按合同保持；文件引用 ownership 等既有严格拒绝不变 |
| **Platform scope** | macOS-only（A-9）不变 |

#### Phase 6 Decision Locks（LOCK-6001…6036）

> 全部 LOCK-60xx 在 Phase 6 确立且保持 active；Phase 4 全部 LOCK-44xx 与 Phase 5 全部 LOCK-51xx 继续有效。

| Lock | 精确不变量（后续阶段必需） |
|---|---|
| **LOCK-6001** | L2（Cherry Studio ZIP 跨应用兼容导入）与 L3（Cherry Chat 同应用备份/恢复）为不同产品语义；UX 可复用组件/基础设施但不改变其独立性 |
| **LOCK-6002** | L2 为 replace-all（非 merge）；使用真实 Phase 4 preparation/execution/recovery 管线；macOS-first（A-9 平台拒绝保持）；独立 UI 入口 |
| **LOCK-6004** | L3 新 v7 备份格式 metadata product/purpose；完整 metadata + authoritative validated Data/chat.db 在 staging 前必需 |
| **LOCK-6005** | v7 metadata 与 v6 精确直接兼容性；metadata-less/data.json/.bak ordinary restore 已移除 |
| **LOCK-6008** | v6 直接兼容性：v7 格式可直接兼容恢复 v6 备份 |
| **LOCK-6009** | metadata-less/data.json/.bak ordinary restore 移除：不再支持无 metadata 的旧格式恢复 |
| **LOCK-6012** | 安全 ZIP containment：exclusive operation roots/files（操作根目录/文件独占） |
| **LOCK-6013** | 安全 ZIP containment：exclusive files（文件独占访问） |
| **LOCK-6014** | 安全 ZIP containment：exclusive operation roots（操作根目录独占） |
| **LOCK-6015** | L2 controller 为 generation/session-scoped（代/会话作用域） |
| **LOCK-6016** | L2 controller finalizing 在 promoted 前完成 |
| **LOCK-6017** | L2 controller exact token-bound terminal handoff settlement |
| **LOCK-6018** | L2 controller session-scoped 生命周期 |
| **LOCK-6019** | stream settlement and cleanup-before-exit across local/WebDAV/S3/Nutstore（全路径 stream settlement 和退出前清理） |
| **LOCK-6020** | ChatDbBackup per-operation destination-local workspace（每次操作独立目标本地工作区） |
| **LOCK-6021** | ChatDbBackup no shared temp race（无共享临时文件竞争） |
| **LOCK-6022** | ChatDbBackup validated atomic publish（经验证的原子发布） |
| **LOCK-6023** | 隔离 import renderer 保留不变——L2 现已可达且需要隔离 import renderer；不移除、不条件化 |
| **LOCK-6024** | 遗留 `agents.db` 永久保留；Phase 6 不自动删除且不提示删除。Agent runtime wiring 属 out of scope |
| **LOCK-6025** | L2 ZIP intake 策略与 L3 backup ZIP 策略分离：L2 仅接受含 Chromium IndexedDB 结构的 Cherry Studio ZIP 备份；L3 backup/restore 使用现有产品流程（v7 metadata 格式）；两路径独立校验、不共享 ZIP 解析逻辑 |
| **LOCK-6026** | ZIP CEN（Central Directory）记录使用 duplicate-aware raw counts 进行安全大小校验；重复条目不膨胀计数；safe size bounds 基于 CEN 分析而非未验证的本地文件系统 stat |
| **LOCK-6027** | 本地 staged hard-link no-clobber publication：staging 文件通过 hard-link 发布到目标路径；目标路径已存在时拒绝（no-clobber），不静默覆盖；失败路径保留 staging 原始文件 |
| **LOCK-6028** | 目标路径与工作区 identity 校验：publication 前验证目标文件路径属于预期工作区（containment check）；workspace identity 通过 dev/ino 或路径前缀确认，防止跨操作污染 |
| **LOCK-6029** | macOS exact alias 解析：文件路径在操作前通过 `fs.realpath` 或等效机制解析 macOS alias/symlink，确保所有后续操作使用 canonical 路径；不信任未解析的路径字符串 |
| **LOCK-6030** | 操作清理保证：每个导入/备份操作在完成（成功或失败）后清理其专属临时资源（staging 文件、候选目录、isolated session profile）；清理失败不阻塞主操作结果，但记录错误 |
| **LOCK-6031** | accepted residual：same-user TOCTOU 窗口。Node.js 缺乏 descriptor-relative `openat`/`linkat` 系统调用，staging→publication 路径之间存在极小的 same-user TOCTOU 窗口。该窗口仅在同用户进程内可利用，且目标为应用自身数据文件，风险被接受为 Node.js 运行时限制。缓解措施：no-clobber 策略 + identity 校验 + atomic rename |
| **LOCK-6032** | L3 restore 接口为 `Promise<void>`，接受直接 archive 路径参数；legacy logical restore（基于 metadata-less `data.json`/`.bak`）已移除；所有 provider（local/WebDAV/S3/Nutstore）失败均向上层传播，不静默吞没 |
| **LOCK-6033** | 同文件系统 staged archive 通过 atomic no-clobber hard link 发布：staged archive 经 hard link（同文件系统单系统调用）发布到最终路径；目标路径已存在时拒绝（no-clobber）；最终路径在 hard link 完成前从不持有部分数据（原子性保证） |
| **LOCK-6034** | 工作区 dev/ino 捕获与 identity 匹配门控清理：cleanup 仅在完整 destination/workspace identity 匹配后执行递归清理；identity 不匹配时跳过递归清理（mismatch skips recursive cleanup），防止跨操作污染 |
| **LOCK-6035** | 目标组件 identity 完整再验证：在 mkdtemp、staged open 和 publish 三个关键操作前，对目标路径的完整组件 identity 进行再验证（含 dev/ino 和路径 containment），确保操作窗口内无外部替换 |
| **LOCK-6036** | 单系统调用 same-user TOCTOU 保持 accepted：标准 Node.js 缺乏 descriptor-relative `openat`/`linkat`，同文件系统 hard link 为单系统调用但路径级 TOCTOU 窗口仍存在；**不声称消除**（do not claim elimination）；缓解措施为 no-clobber 策略 + identity 校验 + atomic rename（与 LOCK-6031 一致） |
| **LOCK-DEV-1** | Trusted dev-origin URL 为 app-owned exact constant：`http://localhost:5173/src/windows/chatImport/chatImport.html`；仅 `app.isPackaged=false` 且精确 dev source mapping 时使用；不推断任意 origin、端口、路径 |
| **LOCK-DEV-2** | Packaged/dev 分支规则：Packaged 构建始终 `file://` 协议 + `file__0` origin（不变）；Dev 构建检测 ZIP 含精确 `http_localhost_5173` 目录时使用 `http://localhost:5173` 协议加载 import renderer |
| **LOCK-DEV-3** | Main intake 分类精确 file__0/dev 映射并在 IPC/窗口/candidate 之前拒绝不支持/歧义/多个 origin 目录；非精确映射 fail closed |
| **LOCK-DEV-4** | Renderer 验证精确 dev origin/path/no-search/no-hash；有界操作防止 silent discovering hang |
| **LOCK-DEV-5** | Plain Electron Location credential fields 不可靠；最终验证重构 application-owned exact URL fields 而非接受任意 URL 输入 |
| **LOCK-DEV-6** | Real Chromium E2E fixture 自然生成 IndexedDB 目录，无需 rename/复制 origin 目录 |
| **LOCK-DEV-7** | ABI chain：Fresh build pass；Electron ABI145 proven；host restored Node v24.12.0 ABI137 |
| **LOCK-DEV-8** | File-origin regression 不变：genuine file-origin E2E PASS，packaged/file-origin 行为与 Phase 4.1 一致 |
| **LOCK-N2** | `cloneForWire`（`src/renderer/src/utils/jsonWire.ts`）递归省略对象显式 `undefined` 属性（可选 absent/undefined 等价）；数组显式 undefined 元素与 sparse arrays 拒绝 |
| **LOCK-N3** | 非 JSON 值全部拒绝（bigint/symbol/function/Date/Map/Set/TypedArray/NaN/Infinity/class instances/cyclic/depth>20） |
| **LOCK-N5** | 共享依赖中立 renderer 工具：`jsonWire.ts` 同时被 `SqliteMessageDataSource`（renderer→Main IPC）与 chatImport entry point（Dexie→Main IPC）复用 |
| **LOCK-N6** | import 页行归一化位置：`entryPoint.ts` `handleReadPage` 在 `toArray()` 后、`readPageResult` IPC 前对每行 `cloneForWire` |
| **LOCK-N8** | 显式 undefined own-properties 为 upgradeToV7 structured-clone 行形态；fixture 在真实 Chromium IndexedDB 中写入并验证 readback 存活 |
| **LOCK-N11** | E2E fixture 在 Chromium 内对每个 undefined 字段验证 hasOwnProperty 与 valueIsUndefined（false 时精确 throw） |
| **LOCK-C2** | 跨进程证据仅携带 durable booleans（hasOwnProperty/valueIsUndefined），安全跨越序列化边界 |
| **LOCK-C3** | `multiModelMessageStyle` 为 canonical application 字段名（消息 undefined 字段集精确匹配生产 Message 类型） |
| **LOCK-C4** | `importDataPlane` 接受 cloneForWire-normalized 现实 topic/message/block 形态并以 manifest 终结（LOCK-N5/N6/C4） |
| **LOCK-F2** | fixture 在 Chromium 内对 readback 违反精确 throw（false 的 readback 永远无法通过 fixture） |
| **LOCK-F3** | E2E 对每条证据断言 `hasOwnProperty` 与 `valueIsUndefined` 均 `.toBe(true)` |

---

## 10. 导入数据流、权威语义、取消/回滚、验证规则

### 导入数据流（端到端）

```
用户选择 Cherry Studio ZIP
         │
         ▼
┌─── 4.1 Secure ZIP Intake ───┐
│ · 解压到唯一临时工作区       │
│ · 验证 ZIP 内含 Chromium IDB │
│ · 校验 IndexedDB 结构完整性  │
└──────────┬──────────────────┘
           │
           ▼
┌─── Isolated Session + Import Renderer ───┐
│ · session.fromPath() / isolated profile  │
│ · 正确 origin + 当前 Dexie schema        │
│ · 隐藏 sandboxed BrowserWindow           │
│ · 不恢复到正常 Dexie profile              │
│ · 旧 IDB 仅在 Dexie upgrades 可识别时接受 │
└──────────┬───────────────────────────────┘
           │ narrow import-only IPC (分页逻辑 DTO)
           ▼
┌─── 4.2 Candidate SQLite Bulk Import ───┐
│ · Main 不解析 LevelDB                   │
│ · 使用 Phase 2 repository 层批量写入    │
│ · 独立候选 DB 文件                       │
│ · replace-all 语义，非 merge             │
└──────────┬──────────────────────────────┘
           │
           ▼
┌─── 4.3 Deterministic Verification ─────┐
│ · 源 vs 目标 ID/计数/字段/顺序/关系/哈希│
│ · file-reference 快照、segments          │
│ · 结构化 model/tool object、overflow     │
│ · PRAGMA integrity_check                 │
│ · PRAGMA foreign_key_check               │
│ · 应用层抽样读取                          │
│ · 状态机：candidate-ready→verifying→     │
│   verified-candidate | verification-failed│
│ · 取消/退出：close-before-discard         │
└──────────┬──────────────────────────────┘
           │
           ▼
┌─── 4.4 Atomic Replace-All Promotion ───┐
│ · 关闭现有 chat.db 连接                 │
│ · 保留一个 rollback 快照                 │
│ · 原子 rename 候选 → live chat.db       │
│ · reopen + integrity_check               │
│ · 成功 → relaunch                        │
│ · 失败 → 回滚到快照 + 报告               │
│ · promotion 短时不可取消                 │
└─────────────────────────────────────────┘
```

> ⚠️ **post-closure 扩展（2026-08-05，LOCK-DOC-4）**：上述为 Phase 4 原始数据流（chat.db 单 artifact）。L2 attachment/file 兼容修复后，candidate 为**三 artifact**（candidate chat.db + candidate Files 目录 + candidate `files-catalog.json` handoff）；4.2 增加 attachment plane（流式提取 + 流式 SHA-256/CRC-32 + fatal/degraded/optional 分类）；4.3 增加候选 Files/catalog 重述与 aggregate receipt 校验；4.4 promotion 经 **v2 三 artifact journal**（candidates-ready → snapshots-ready → db-installed → files-installed → catalog-pending → catalog-applied → replacement-verified）协调安装，catalog 单 Dexie 事务 replace-all 后开放普通 UI。详见「Phase 6 交付收尾后发现：L2 attachment/file 兼容修复」。

### 权威语义

| 阶段 | authoritative store | 说明 |
|---|---|---|
| Phase 0–3（运行时） | Dexie (IndexedDB) | 当前 Cherry Studio 唯一真实来源 |
| Phase 4（导入过程中） | 现有 live SQLite（如果有） | 导入读取源 ZIP，不影响现有 DB |
| Phase 4.4 promotion | 候选 SQLite → 原子替换 → 新 live SQLite | promotion 短时窗口内无 authoritative（连接已关闭） |
| Phase 5+（最终态） | SQLite (chat.db) | Cherry Chat 唯一真实来源；Dexie 仅存在于隔离 import renderer |

### 取消支持

- **Phase 4.1–4.3**：用户可在任何时刻取消。源 ZIP 解压数据可安全丢弃。候选 DB 可安全丢弃。现有 SQLite 不受影响。
- **Phase 4.4 promotion**：不可取消。promotion 是短时原子操作（关闭连接 → rename → reopen → relaunch）。

### 回滚策略

1. **promotion 失败**：自动回滚到 promotion 前保留的快照 DB
2. **post-promotion 发现问题**：手动恢复快照 DB（保留一个快照）
3. **导入中途取消**：丢弃临时工作区和候选 DB，现有 SQLite 不受影响
4. **ZIP 格式不可识别**：拒绝导入，报告错误，不影响现有 DB

### 安全归档约束

- ZIP 是唯一受支持的源格式（Cherry Studio ZIP 备份含原始 Chromium IndexedDB）
- 不解析 `data.json` / `.bak`（明确放弃）
- 旧 IndexedDB 仅在当前 Dexie declaration/upgrades 可防御性识别时才接受
- 结构不可用数据被拒绝（不修复、不推断）

### 验证/默认规则

- 缺失值继承当前 Cherry Studio/Dexie upgrade 和 reader 语义
- 不创建 importer-specific 历史修复
- 不推断缺失 ID、ownership、timestamp、role、status、model 等字段
- replace-all 语义：导入覆盖整个目标 DB，不与现有数据 merge

---

## 11. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| **Phase 4.0 fromPath 跨平台不可行** | 导入管线无法使用隔离 Session 读取源 IndexedDB | **macOS arm64: Resolved**（`session.fromPath()` 可行）。**Windows/Linux: Open**（未测试）。no-go 回退为专用隔离 Electron helper 进程（非破坏性恢复、非直接 LevelDB 解析）——contingency only，未选用 |
| **源 ZIP 结构不可识别** | 导入被拒绝 | 严格的 ZIP 内 IndexedDB 结构校验；明确的错误报告；不影响现有 DB |
| **旧 IndexedDB schema 不可升级** | 旧版本备份导入被拒 | 仅接受当前 Dexie declaration/upgrades 可防御性识别的版本；版本校验前置 |
| **导入性能（大型 ZIP）** | 大数据量导入耗时过长 | 分页传输；批量写入；性能基准记录（Phase 4.2） |
| **promotion 失败导致数据丢失** | 无法恢复到导入前状态 | promotion 前保留一个 rollback 快照；失败自动回滚；reopen + integrity_check |
| 流式 IPC 性能 | 大消息量下 IPC 序列化/反序列化开销 | 批次阈值需基准测试确定 |
| 备份一致性 | 备份期间数据写入导致不一致 | **Resolved**（A-6 Accepted）：online backup adapter（better-sqlite3 `backup()`）；BackupManager 全操作协调 |
| 备份并发 | 多来源同时触发备份导致冲突 | 备份操作全局互斥 |
| 文件系统非事务 | SQLite 文件操作非原子 | WAL 模式；备份使用临时文件+rename |
| 多窗口并发 | 多个 Renderer 窗口同时写入 | Main 单写；Renderer 通过 IPC 串行化 |
| 旧备份兼容 | 迁移后备份格式变化 | Cherry Chat 备份/恢复沿用现有 Cherry Studio 产品流程并适配 chat.db（L3），与 Cherry Studio ZIP 导入（L2）语义分离 |
| 性能未知 | SQLite 在 Electron 中的实际表现未测试 | Phase 5 切换前必须完成基准测试 |
| 技术栈选型 | ~~libSQL+Drizzle 可能不是最优选择~~ | **Resolved**（A-7 Accepted：better-sqlite3 + Drizzle） |
| **集成同步门已完成（migration pre-merge HEAD `5d50499e80` ↔ integration `05a401b711` 已合并/已验证）** | 原风险（合并前基于过期结构实现导致返工）已消除；合并自动解决、无兼容性编辑、验证全过 | **Resolved（已合并/已验证）**：migration 与 integration 已合并，统一 Renderer/context/type/Redux 结构已建立；Phase 4.4 架构未变，可在合并后结构上实现 |

---

## 12. 验收指标 / Go-No-Go

### Phase 4 exit criteria（导入管线）

| 指标 | 目标 | 状态 |
|---|---|---|
| Phase 4.0 spike | fromPath + origin + Dexie schema 跨平台验证通过（或 helper 进程回退设计完成） | **Done — Go on macOS arm64** (Windows/Linux open; helper contingency recorded) |
| ZIP 安全解压 | 唯一临时工作区 + IndexedDB 结构校验 | **Done** |
| 隔离 Session 读取 | import renderer 通过当前 Dexie schema 成功读取源数据 | **Done** |
| 候选 DB 构建 | 10k 消息完整导入；导入中断不损坏现有 DB | **Done** |
| 验证全通过 | ID/计数/字段/顺序/关系/哈希/integrity_check/foreign_key_check/应用层抽样 | **Done**（Phase 4.3，已提交/已推送） |
| 原子 promotion | 成功 → reopen + relaunch；失败 → 回滚到快照 | **Done（全量验证通过，独立审计 pass）**（Phase 4.4.0 协议层；Phase 4.4.1 准备门 + rollback 快照 + journal `snapshot-ready`；Phase 4.4.2 破坏性执行止于 durable `replacement-verified`；Phase 4.4.3 落地 recovery executor/gate + artifact probes + rollback staging clone/atomic rename + durable journal cleanup + terminal take + repair marker + startup reorder + relaunch exact-once。commit `f6a6741b8e`。独立审计 pass（两项 accepted fixes：real durable repair marker、startup gate fail-closed）；聚焦测试 71 文件/1709 通过/72 跳过；全量验证通过：format 无改动；lint 0 errors/97 warnings；test 281/6205/72 skipped；typecheck:node pass） |
| 取消支持 | promotion 前任意步骤取消不损坏现有 DB（含 4.3 close-before-discard） | **Done** |

### Phase 5 exit criteria（Cherry Chat SQLite-only runtime）

> 顶层退出指标保留；子阶段进度见 Section 9 Phase 5 及「Phase 5 Decision Locks」。Phase 5.1A 已提交 `6fa5ff5ef9`；5.1B 已提交 `e44e413f30`；5.2A 已提交 `e9de29ff97`；5.2B 实现 + 独立审计 + 全量验证完成；5.3 已提交 `b81a35c054`；5.4 feature commit `6c250f19a2` + docs commit `6b2f140955`。最终仓库验证 Node v24.12.0 ABI 137 / pnpm 10.27.0：311 文件 / 6976 通过 / 72 跳过 / 0 失败；lint 0 errors / 17 pre-existing warnings；format/typecheck/git-diff-check 全 PASS；Electron ABI 145 E2E 证据已在 earlier targeted rebuild 中记录；agent runtime UI 因无 Main handler/IPC/UI entry 不可用，非 ABI 问题。

| 指标 | 目标 | 状态 |
|---|---|---|
| 消息加载延迟（p50/p95） | 不退化 | **Done（5.4）**：p50 7.42ms / p95 8.23ms；历史 Dexie comparator 不可用，仅报告绝对 SQLite 结果（LOCK-DOC7） |
| 消息写入吞吐 | 不退化 | **Done（5.4）**：repository two-transaction write microbenchmark 38.5 batch ops/s / 385.2 msgs/s（标注为 microbenchmark 非聚合生产吞吐，LOCK-DOC6） |
| 数据完整性 | 100% | **Done（5.1A/5.1B/5.2A/5.2B/5.3/5.4）**：E2E 验证 4 spec 通过（ordinary-chat/topic-trash/multi-model/topic-move）；零 ordinary runtime Dexie chat-table references（有效例外 agent/import（LOCK-6023 隔离 import renderer 保留））；topic name persistence + durable file lifecycle correctness fixes 审计通过 |
| 冷启动 DB 打开时间 | < 500ms | **Done（5.4）**：cold open p95 6.91ms < 500ms |
| 普通聊天路径无 Dexie 依赖 | 0 Dexie 引用 | **Done（5.3）**（5.2A 已迁移 SearchResults 至 SQLite；5.2B 集成主题生命周期调用方；5.3 完成权威切换 + scaffolding 移除，普通聊天路径直连 SQLite） |
| Phase 3.4 routing scaffolding | 完全移除 | **Done（5.3）** |
| A-10 spike harness 清理 | 完全移除 | **Done（5.4）**：22 个 spike-only 文件 + build gate 移除；A-10 fulfilled/deleted；production imports 保留 |
| 所有测试通过 + CI 绿色 | 100% | **Done（Phase 5.4 最终仓库验证，Node v24.12.0 ABI 137 / pnpm 10.27.0）**：`pnpm test` PASS（**311 文件 / 6976 通过 / 72 跳过 / 0 失败**）；`pnpm format` PASS（无改动）；`env -u CI pnpm lint` PASS（0 errors / 17 pre-existing warnings）；`pnpm typecheck` PASS（node/web/aicore）；`git diff --check` PASS；无 generated JS / temp / process artifacts。better-sqlite3 final local binary 为 ABI 137（host Node）。Electron ABI 145 E2E 证据已在 earlier targeted rebuild 中记录（E2E 运行时通过）。历史 Dexie comparator 不可用（LOCK-DOC7）。feature commit `6c250f19a2` + docs commit `6b2f140955`。**push/remote CI：未运行/无 run（LOCK-MD8）**——分支已推送（remote SHA `89803503fc...`，upstream `origin/jorkey/refactor/sqlite-migration` 已建立），GitHub Actions runs for this branch = 0；ci.yml push trigger 仅 `main`/`v1`、未创建 PR、未手动 dispatch；非失败、非 green CI；E2E 仍为非远程 CI 证据。**closure 注（LOCK-MD9）**：「`CI=true` 下 pre-existing no-console errors 为 baseline 环境行为」已由 2026-07-31 交付收尾的窄化 Main log bridge/no-console 修复解决（closure 后 CI=true lint 0 errors，见「Phase 6 交付收尾 / 最终交付证据」） |

### Phase 6 exit criteria（备份/恢复适配 + L2/L3 语义分离 + 清理）

| 指标 | 目标 | 状态 |
|---|---|---|
| Cherry Chat 备份/恢复 | 沿用现有产品流程并适配 chat.db，独立运作（底层 better-sqlite3 online backup 为 Phase 1 存储层机制） | **Done（6.2）**：v7 metadata 实现；metadata-less/data.json/.bak ordinary restore 已移除；L3 与 L2 语义分离 |
| Cherry Studio ZIP 导入 | 作为一次性操作独立运作 | **Done（6.1）**：L2 replace-all 语义 + 真实 Phase 4 管线 + macOS-first + 独立 UI；controller 生命周期经验证 |
| Group D/E 清理 | 全部完成 | **Done（6.4）**：C-9 有效保留（LOCK-6023）；C-10 Phase 5 收口完成；C-11 Phase 5.3 移除；C-12 永久保留（LOCK-6024）；C-13 Phase 5.3 移除 |
| 文档更新 | 反映最终状态 | **Done（6.4）**：本节更新 |
| CI 绿色 | 100% | **本地 gates Done（6.4 + closure）**：`pnpm format` PASS；`pnpm lint` PASS（0 errors / 76 pre-existing warnings）；`pnpm test` PASS（311/311 文件，6976 passed，72 skipped，0 failed，三次连续运行）；`pnpm typecheck` PASS（node/web/aicore）；`git diff --check` PASS。closure 后本地 gates（LOCK-MD6）：`CI=true pnpm lint` PASS 0 errors（76 oxlint + 4 ESLint warnings）；`CI=true pnpm test` PASS 312 文件 / 7009 通过 / 72 跳过 / 0 失败。**push/remote CI：未运行/无 run（LOCK-MD8）**——分支已推送（remote SHA `89803503fc...`，upstream `origin/jorkey/refactor/sqlite-migration` 已建立），GitHub Actions runs for this branch = 0；ci.yml push trigger 仅 `main`/`v1`、未创建 PR、未手动 dispatch；非失败、非 green CI；E2E 仍为非远程 CI 证据。E2E：A-class `import-cherrystudio.spec.ts` 1/1 PASS（Phase 6.4 当时，selecting-phase UI reachability，LOCK-DOC8，历史证据未重跑）；B-class `import-cherrystudio-genuine.spec.ts` 1/1 PASS（closure，LOCK-MD2/4，见「Phase 6 交付收尾 / 最终交付证据」） |
| 安全/可靠性加固 | ZIP containment + ChatDbBackup workspace 隔离 + stream settlement | **Done（6.3）**：LOCK-6012–6014/6019/6020–6022/6025–6036 全落地 |
| 隔离 import renderer 保留 | L2 可达要求保留 | **Done（6.3）**：LOCK-6023 确认保留 |
| agents.db 永久保留 | Phase 6 不自动删除/不提示删除 | **Done（6.3）**：LOCK-6024 确认 |

**Go 条件（Phase 4→5）**：
- Phase 4 所有 exit criteria 通过
- 至少一次成功端到端导入（真实 Cherry Studio ZIP → Cherry Chat SQLite-only runtime）

**No-Go 条件**：
- Phase 4.0 spike 失败且 helper 进程回退不可行
- 验证维度任一关键项失败
- promotion 回滚机制不工作

---

## 13. Open Questions

| # | 问题 | 影响范围 | 状态 |
|---|---|---|---|
| Q-1 | libSQL + Drizzle vs better-sqlite3 / 其他方案？ | A-7 技术栈决策 | **Resolved**：选择 better-sqlite3 + Drizzle ORM（A-7 Accepted） |
| Q-2 | chat.db 是否未来统一为 app.db（合并 Memory/Knowledge）？ | 架构长期演进 | Open |
| Q-3 | 文件元数据首期迁移深度：仅 references 还是包含 files 表全量？ | Phase 2 范围 | **Resolved**：Phase 2 使用 block-linked file references，每条引用携带完整元数据快照（file_name, file_path, file_type 等）；不建 canonical files 表。canonical files 表推迟到 FileManager 全局迁移前做显式决策。**superseded 注（2026-08-05，LOCK-DOC-1）**：上述为 Phase 2 范围的历史决议；post-closure L2 attachment/file 兼容修复扩展为导入物理 `Data/Files` payload + 源 Dexie `files` catalog（`files-catalog.json` handoff）；仍不建 SQL canonical files 表（Dexie catalog 权威，LOCK-FIX-1）。详见 post-closure attachment 小节 |
| Q-4 | 流式批次阈值：多大消息量触发分批 IPC？ | Phase 4.1 import IPC 分页 | Open |
| Q-5 | 搜索/FTS 首期是否实现？schema 预留还是 Phase 6 再加？ | Phase 2 schema | **Resolved**：Phase 2 不含 FTS；后续通过 append-only migration 添加，时机为搜索 projection 设计完成时 |
| Q-6 | 遗留 agents.db 用户文件处理：归档提示还是自动清理？ | Group E 清理 | **Resolved（LOCK-6024）**：agents.db 永久保留；Phase 6 不自动删除且不提示删除。Agent runtime wiring 属 out of scope |
| Q-7 | 备份协调的具体实现：WAL checkpoint 还是 backup API？ | A-6 备份策略 | **Closed/Accepted**：online backup API（better-sqlite3 `backup()`）封装为可替换 adapter，`BackupManager` 全操作协调；不使用 live WAL raw copy（A-6 Accepted） |
| **Q-8** | **Phase 4.0 fromPath 跨平台可行性？** | **Phase 4.0 spike** | **Resolved (macOS arm64) / Open (Windows/Linux)**：macOS arm64 上 `session.fromPath()` + file:// origin + isolated profile 成功加载 IndexedDB；v4→v11 升级通过；v12 拒绝通过；session 隔离通过；LS 非必需；10/10 清理稳定。Windows/Linux 未测试。helper 进程回退仍为 contingency |
| **Q-9** | **Windows/Linux `session.fromPath` + 文件锁 + 清理行为** | **Phase 4.1 production 化（A-9）** | **Deferred 至 macOS-first 完成后**。Phase 4.1 实施期间不验证（A-9 Accepted）。未来开放路径：删 `process.platform !== 'darwin'` 拒绝 + 重跑 Phase 4.0 spike 验证（spike harness 已在 Phase 5.4 删除，需重建最小验证脚手架）+ 调 `tempWorkspace.ts`/`isolatedSession.ts` 清理退避参数。重点未验证项：NTFS 不能删打开文件（EBUSY 重试策略）、Windows `session.fromPath` 锁文件/缓存语义、Linux 不同 filesystem 行为 |
| **Q-10** | **真实 ZIP snapshot 损坏/不完整检测策略划分** | **Phase 4.1 vs 4.3** | **4.1 最小，4.3 全面**。Phase 4.1 仅做：① ZIP 结构 5 层校验（大小/条目数/单条/总量/加密；zip-slip 用 `path.resolve` 跨平台防护）；② IndexedDB 目录存在性 + 含 `.ldb` 子目录的通用探测（不硬编码 `file__0.indexeddb.leveldb`，spike 观测仅为 file:// origin 下情况）；③ `indexedDB.databases()` discovery 成功。**完整损坏/不完整检测延后至 Phase 4.3** Verification（源 vs 目标 ID/计数/字段/顺序/关系/哈希/integrity_check/foreign_key_check/应用层抽样）。Phase 4.1 不引入 importer-specific 历史修复（继承 A-8 约束） |
| **Q-11** | **Phase 4.0 17 个 harness 文件去留** | **Phase 4.1 production 化（A-10）** | **Resolved（Fulfilled/Deleted, 2026-07-30）**：Phase 5.4 spike gate 通过后已删除（A-10 fulfilled）。spike gate 结果：A pass、C1 4/4、C2a 8/8、C2b 10/10。22 个 spike-only 文件 + `PHASE4_SPIKE=1` build gate 移除。Production imports 保留 |
| **Q-12** | **Import renderer 用专用独立 HTML 入口还是复用 spike 窗口模式** | **Phase 4.1 构建** | **Resolved**：新增专用 `src/renderer/src/windows/chatImport/chatImport.html` 为永久产物入口。不复用 spike `phase4Spike.html`（污染隔离语义）。需 `electron.vite.config.ts` 加入新 HTML 入口 + 新 preload entry（`src/preload/chatImport/index.ts` → `chat-import-preload.js`）。spike HTML 连同 harness 一并 Phase 5 删除 |

---

## 14. 决策日志

| 日期 | 决策 / 事件 | 说明 |
|---|---|---|
| 2026-07-19 | 完成资产调查 | 确认当前无 chat.db、无通用 Main SQLite migration 框架、核心聊天仍在 Renderer Dexie |
| 2026-07-19 | 决定独立 chat.db（A-1 Accepted） | 不复用 agents.db（无代码 owner，schema 不兼容） |
| 2026-07-19 | 确认 agents SQLite 不存在且残留待清理 | agents:* scripts 指向不存在 config；drizzle-kit/drizzle-orm 残留 |
| 2026-07-19 | 创建本迁移文档 | 作为长期决策和阶段状态追踪单一事实源 |
| 2026-07-19 | A-7 Accepted：better-sqlite3 + Drizzle ORM + drizzle-kit | Node.js 生态最成熟 SQLite 驱动，同步 API，Drizzle 官方主推组合；与未来 PowerSync 集成兼容（PowerSync 首选 better-sqlite3） |
| 2026-07-19 | A-5 Accepted：一次性切换 + Dexie 快照回滚 | 个人 repo，无 SLA 约束；导出 Dexie→SQLite 后切换路由，旧 Dexie 文件作为回滚快照；切换后观察数天确认稳定；不采用双写 |
| 2026-07-20 | A-6 Accepted：online backup adapter + full-operation coordination | better-sqlite3 `backup()` API 封装为可替换 adapter；BackupManager 协调互斥锁、staging、生产路径过滤、恢复后 integrity check；未来可替换为 PowerSync；不使用 live WAL raw copy |
| 2026-07-20 | Q-7 Closed/Accepted | 备份协调采用 online backup API（better-sqlite3 `backup()`）作为 adapter，BackupManager 全操作协调 |
| 2026-07-20 | Phase 1 完成 | ChatDbService 生命周期硬化；WAL/fk/synchronous/busy_timeout pragmas；inline build-safe initial migration；integrity check；restored-first-open repair gating；startup/will-quit wiring；replaceable online backup adapter；BackupManager full-operation coordination；production-path tests |
| 2026-07-20 | Phase 2 完成 | Append-only migration 002；Main-local DTO/codec/mappers/typed cursors；TopicsRepository、MessagesRepository、BlocksRepository、TopicSegmentsRepository、FileReferencesRepository；CRUD/batches/keyset pagination/dense ordering/ownership/cascades/rollback 测试（real better-sqlite3） |
| 2026-07-20 | Q-3 Resolved | block-linked file references 携带完整元数据快照；canonical files table 推迟到 FileManager 全局迁移前显式决策 |
| 2026-07-20 | Q-5 Resolved | Phase 2 不含 FTS；后续 append-only migration 添加，时机为搜索 projection 设计完成时 |
| 2026-07-20 | TopicSegmentsRepository 澄清 | 原 Phase 2 规划遗漏 TopicSegmentsRepository；Phase 2 实际交付包含该 Repository |
| 2026-07-20 | Phase 3.1 完成 | 14 个 ChatDb IPC channels 定义；packages/shared/chatDb/ 新增 types/result/validation/contracts/index；JSON wire validation（深度限制 20、拒绝 undefined/bigint/symbol/NaN/Date/Map/Set/Buffer/class instances/sparse arrays）；result envelope（ok/fail/isSuccess/isFailure）；command contracts（allowedKeys + validate）；199 个 shared tests 通过（初始完成时为 107，后续扩展至当前 199）；Dexie-authoritative / no-auto-switch / no-per-call-fallback 约束文档化 |
| 2026-07-20 | Phase 3.2 完成 | ChatDbAggregateService（14 命令实现）；repository factory（root DB / transaction 绑定）；wire adapters（JSON ↔ Domain，保留结构化 renderer model/tool-object/unknown JSON/nullable 语义）；errors.ts（错误映射 9 类）；ipc.ts（14 个 IPC handler 注册 + request/result 运行时验证 + 结构化错误映射 + disposer）；shared contract 修正（blocks 数组前置验证、identity/reparenting 拒绝、所有权一致性、新错误码）；78 个新 tests 通过（aggregate 39 + wireAdapters 20 + ipc 19）；438 个 tests 全部通过（Phase 3.2 初始完成时的快照基线） |
| 2026-07-20 | Phase 3.2 审计修复 | 修复 9 项审计发现：① fetchMessages topic priming（同一事务 ensure + return empty）；② updateBlocks/updateSingleBlock/deleteBlocks/clearMessages 全部使用 root-bound tx + tx-bound repos；③ clearMessages 移除 fileRefs.deleteByMessage()（依赖 FK cascade）；④ 引入 typed aggregate errors（6 种）+ SQLite structured code inspection + 优先级排序；⑤ IPC handler 使用 validateChatDbResult + malformed result ERR_STORAGE fallback；⑥ channel 类型为 ChatDbChannel；⑦ 错误消息 sanitize（不泄露 SQL/path/stack）；⑧ generic storage error non-retryable；⑨ 53 个新 tests（跨仓库回滚、cascade、error mapping、malformed result、topic priming）；131 个 Phase 3.2 tests 通过，932 个 total tests 通过（审计修复后的快照基线） |
| **2026-07-20** | **A-8 Accepted：外部应用兼容性导入（策略更正）** | **产品策略更正**：SQLite-authoritative Cherry Chat 是独立于当前 Cherry Studio 的应用。导入源是用户选择的 Cherry Studio ZIP 备份（含原始 Chromium IndexedDB），不是当前运行时 Dexie。技术路线：安全解压→隔离 Session + import renderer→分页 IPC→候选 SQLite→验证→原子替换。A-5（in-place Dexie→SQLite shadow/cutover）被 A-8 正式替代。旧模型的矛盾：启动时自动迁移、基于本地 Dexie 的 durable cutover、shadow-mode readiness gates、archive source ambiguity、legacy JSON 兼容——全部废弃 |
| **2026-07-21** | **A-9 Accepted：Phase 4.1 macOS-first + 平台拒绝** | Phase 4.0 spike 仅在 macOS arm64 验证。Windows/Linux `session.fromPath` + 文件锁 + 清理未验证，配开发环境成本远超此轮验证价值，且 Phase 4.4 原子替换在 Windows 文件锁下更敏感会稀释本轮价值。生产代码入口 `process.platform !== 'darwin'` → 拒绝。清理分支预先写好 bounded retry + EBUSY 退避 + crash-recovery scan，未来开放 Windows ≈ 删一行拒绝 + 重跑 spike + 调清理参数 |
| **2026-07-21** | **A-10 Accepted：Phase 4.0 harness 保留至 Phase 5** | 17 个 harness 文件保留至 Phase 5（与 Group D 一并）。`PHASE4_SPIKE=1` 门控不进生产构建。Phase 4.1 生产模块独立新增 `src/main/services/chatDbImport/` + `src/preload/chatImport/` + `src/renderer/src/windows/chatImport/`，不复用 spike 代码。spike 专属（argv/exit/fixture/IPc multiplexer/A-B markers）丢弃，可复用硬事实（fromPath + file:// origin + indexedDB.databases + production Dexie upgrades + sender.id 校验 + will-navigate/setWindowOpenHandler deny）由生产模块重新干净实现。**Phase 5.4 已 fulfilled/deleted**：spike gate（A pass、C1 4/4、C2a 8/8、C2b 10/10）通过后 22 个 spike-only 文件 + build gate 已移除 |
| **2026-07-21** | **Phase 4.1 只读诊断完成** | Fresh Analyzer 产出 Phase 4.1 source-reader 侧生产化方案：① 模块划分（chatDbImport/ 下 zipIntake/isolatedSession/tempWorkspace/importIpc/index + 专用 preload/import renderer HTML）；② ZIP 库复用 node-stream-zip（BackupManager/DxtService 已用，零新依赖），5 层校验（500MB/10k条目/200MB单条/2GB总量/拒加密 + zip-slip path.resolve 跨平台 + IndexedDB 目录通用探测）；③ Import-only IPC 6 channel（ChatImport_Ready/Discover/ReadPage/Cancel/Complete/Error）独立于 14 个 ChatDb_*；envelope `sessionId+phase+version:1`；DTO 复用 Dexie 逻辑形状不引 import-specific；④ 12 条 correctness risks 全部本轮内处理；⑤ 决策待用户拍板项：跨平台策略、spike 去留、import renderer HTML 入口——均已闭环（A-9/A-10/Q-12） |
| **2026-07-21** | **Phase 4.1 source-reader 生产化完成** | 17 个新文件 + 4 个修改文件：`src/main/services/chatDbImport/`（errors/tempWorkspace/zipIntake/isolatedSession/importIpc/index + 5 tests），`src/preload/chatImport/index.ts`，`src/renderer/src/windows/chatImport/`（chatImport.html + entryPoint.ts），`packages/shared/chatImport/`（types/index/validation.test.ts），`packages/shared/IpcChannel.ts` 6 ChatImport_* entries，`electron.vite.config.ts` chatImport HTML + preload entry，`src/main/ipc.ts` + `src/main/index.ts` 注册/will-quit/app-ready wiring。安全：5 层 ZIP 校验 + `session.fromPath(destDir)` + `location.protocol` origin 校验 + `event.senderFrame` sender 校验 + singleton + R-1..R-12 全部 mitigated。主进程 977/977 测试通过。最终 Auditor Clean。合入 commit `6a1e98e7ef` |
| **2026-07-27** | **Phase 4.2 Done** | Candidate SQLite bulk importer 完成。实际模块：`CandidateDbResource`（per-session 自有候选目录 + 候选 chat.db）、`ChatImportDataPlane`（分页数据面 + `SourceReadStats`）、`ChatImportWriter`（import-only 保序 writer，order-preserving，`candidate-ready` exact-once，`CandidateImportStats`）、`startupRecovery`（取消/错误/孤儿清理）。每页一事务、topic/message 扁平化、block/segment/file-reference 精确映射、replace-all 语义；`SourceReadStats` vs `CandidateImportStats` 分离。10k 基准：25 topics / 10,000 messages / 11,000 blocks / 26 segments / 250 memberships / 667 file refs / 19 pages；两次运行 1016.2ms、978.5ms；`integrity_check` ok、`foreign_key_check` 空、live DB 未改。单元审计 + 最终审计 0 阻塞；聚焦测试通过；全量本地验证通过（2026-07-27）：`pnpm format` exit 0 无改动；`pnpm lint` exit 0（node/web/aicore typecheck 全过、i18n 校验通过、0 errors，仅 pre-existing warnings）；`pnpm test` exit 0，252 文件 / 5325 通过 / 72 跳过；无遗留产物（本地全量验证未涉及 CI） |
| **2026-07-27** | **Phase 4.3 Done** | Deterministic verification 完成（已提交/已推送；本地全量验证未涉及 CI）。实际模块：`CandidateVerifier`（只读验证器，返回稳定 13 维度结果 + 有界安全诊断，不泄露 SQL/path/stack）、`SourceVerificationManifest`（按页证据清单，仅在 DB 事务提交后落盘，stable canonical SHA-256 framing，manifest ~5,019KiB）、`VerificationReport`（~1.4KiB）；候选 DB 会话状态机 `candidate-ready → verifying → verified-candidate | verification-failed`；取消/退出 `close-before-discard`；通过保留候选 DB 供 4.4、失败报告后清理；corruption matrix 覆盖全部 13 维度。10k 验证证据：25 topics / 10,000 messages / 11,000 blocks / 26 segments / 250 memberships / 667 file refs / 19 pages；13 维度全过；验证耗时 ~250–290ms；现有 live `chat.db` 未改。聚焦测试 271 通过；`pnpm format` exit 0 无改动；`pnpm lint` exit 0（0 errors，109 warnings）；`typecheck:node` 通过；首次 `pnpm test` 5420 通过 / 2 失败（BackupManager 共享临时目录非确定性 flakes，排查否定 Phase 4.3 干扰）/ 72 跳过；复跑 `pnpm test` 258 文件 / 5422 通过 / 72 跳过 / 0 失败；Main 与全量多次复跑干净；最终审计 0 findings（本地全量验证，未涉及 CI） |
| **2026-07-27** | **集成同步门（Baseline Sync Gate，Done/已合并/已验证）** | **已完成**：integration（`05a401b711`）已集成同步进 migration（pre-merge HEAD `5d50499e80`）；合并自动解决、无兼容性编辑；审计 0 blocker / 0 code finding；验证全过：format 无改动；lint exit 0（112 known warnings）；typecheck 通过；`pnpm test` 265 文件 / 5664 通过 / 72 跳过 / 0 失败；聚焦测试 201 renderer + 822 chatDb/import。合并未改变 Phase 4.4 既有架构；Phase 5 须以合并后的 Renderer/context/type/Redux 结构为实施基线。历史锚点：migration 推送 tip `85603d0fd5`、两分支距 merge base `44e6b1b82b` 分别 15/21 commits（合并前基线事实）。 |
| **2026-07-27** | **Phase 4.4.0 Done（Promotion 协议基础，纯协议层）** | LOCK-4401…4406 全落地且无副作用（LOCK-4405）。实际模块：`chatDbImport/promotion/{protocol,journal,recovery}.ts`（状态/exact-once/边界纯决策 + journal v1 严格 codec + 90 组合穷举恢复矩阵 + 12 崩溃点映射）、`chatDb/maintenanceCoordination.ts`（backup/restore/promotion/init/close 五操作统一互斥 lease 契约，未接线）、`chatDbImport/index.ts`（`ImportState` + `promoting/promoted/promotion-failed`；`claimPromotion()` 唯一入口 bounded to `getVerifiedCandidate()` + 不可复用 token；`completePromotion()` exact-once 终态结算；cancel 在 promoting 拒绝；async dispose/sync will-quit 保留 promotion-owned 候选）、`startupRecovery.ts`（纯契约 re-export，孤儿清理行为不变）。固定命名：journal `chat-import-promotion.journal.json`、snapshot `chat.db.pre-import-backup`（+`.staging` 单份保留顺序，LOCK-4403）。验证：聚焦 chatDb+chatDbImport 29 文件 / 895 通过 / 0 失败（基线 822 + 新增 73）；`typecheck:node` 通过。资产表旧路径 `chatDb/import/promotion.ts` 已修正为 `chatDbImport/promotion/`。真实文件操作/接线/IPC/relaunch 属 Phase 4.4.1+ |
| **2026-07-27** | **Phase 4.4.1 Done（Durable Preparation Gate，快照就绪准备门）** | LOCK-4411…4417 全落地（当前实现未提交/未推送）。在 Phase 4.4.0 协议层之上落地：① 统一维护接线（LOCK-4411）——`maintenanceCoordination.ts` 将 promotion 实际接入既有 backup/restore/init/close 互斥协调、成为唯一 lease 持有者、无第三个独立运行时锁；② rollback 快照（LOCK-4412 / LOCK-4403）——live 打开时 online backup 创建 `chat.db.pre-import-backup`：live→staging→验证→原子 rename 覆盖（不复制 WAL/SHM），仅创建发布不 restore；③ 严格持久化 journal store（LOCK-4413）——`promotion/journal.ts` 新增 crash-safe 落盘 writer、原子 rename 写入 `chat-import-promotion.journal.json`，内容恰好 version/sessionId/candidateId/phase（snapshot-ready 已落盘），exact-key codec 不变；④ 启动候选保护（LOCK-4414）——`startupRecovery.ts` 扩展为读取 journal、保护 journal-referenced 候选（排除年龄清理）、按 4.4.0 恢复矩阵 `decidePromotionRecovery` 安全分类中断资产，不影响正常启动；⑤ exact-once prepared handle（LOCK-4415）——`claimPromotion()` 不可复用 token 形成 prepared handle、准备窗口唯一可消费、promotion-owned 下 dispose/will-quit 仍保留候选；⑥ 非破坏性边界（LOCK-4416）——整个 4.4.1 不关闭/替换/重命名 live `chat.db`、失败回退 keep-old-live/repair-required、所有写为 staging+原子 rename；⑦ 审计/验证最终门（LOCK-4417）——独立审计首轮发现 candidateId 与 session 集成两阻塞均已修复、复审 0 findings。验证：`pnpm format` 通过（无改动）；`pnpm lint` exit 0（82 oxlint + 33 eslint known warnings，115 emitted warning instances，0 errors）；`pnpm typecheck:node` 通过；`pnpm test` exit 0，272 文件 / 5860 通过 / 72 跳过 / 0 失败；本地全量验证，未涉及 CI / 未提交 / 未推送。最大边界止于 snapshot-ready；live close/install/replace/restore/relaunch 属 Phase 4.4.2+ |
| **2026-07-27** | **Phase 4.4.2 Done（Destructive Promotion Executor，破坏性替换执行）** | LOCK-4421…4428 全落地（当前实现未提交/未推送；独立审计已完成：pass-with-findings，两项接受的 ownership/isolation 硬化修正已落地并复验——见下一条；Phase 4.4.0/4.4.1 已本地提交 `7768b7e30c`/`006615aff6`，未推送）。实际模块：① exact-once prepared→executing capability（LOCK-4421）——`preparation.ts` `consume()` 恰好一次产出 `ExecutingPromotionCapability`，重复/stale 有界拒绝，consume 后 prepared dispose 为 lease-preserving no-op；② owner-aware live 生命周期（LOCK-4422）——`chatDb/index.ts` 新增 `closeForPromotion`/`reopenForPromotion`（变更前验证当前持有 promotion lease，不嵌套 init/close lease；公共 init/close 语义不变），`maintenanceCoordination.ts` 新增 `validatePromotionAuthorization`（WeakMap grant 注册表 + holder peek，仅 verdict）；③ 原子安装（LOCK-4423/4426/4427）——`install.ts`：closed-live proof（单次使用、模块 brand、close 成功后立即铸造、install 前重验证+消费）→ 删除 live sidecars → 源 bigint identity → fsync 源 → 原子 rename-only（EXDEV 有界失败、无 copy fallback）→ fsync 父目录 → 目标 identity 确认 → brand `InstallReceipt`；④ 严格 journal 递进（LOCK-4423/4424/4425）——`journalStore.ts` 两个显式 transition API（snapshot-ready→candidate-installed→replacement-verified，phase/identity 严格前置校验，拒绝均在变更前，失败不清 journal）；⑤ identity-bound 验证（LOCK-4424）——`replacementVerifier.ts`：receipt brand + dev/ino identity 前后校验（size 有意不门）+ `readonlyDbValidation.ts` 共享只读门（integrity/FK/migration/抽样读，与 4.4.1 快照验证器同序）；⑥ 执行编排（LOCK-4425/4428）——`execution.ts` 8 subphase 不可重排序列、每个不可逆边界重验证授权、pre-install（reopen 恢复可用性，非回滚）/post-install（保留全部产物、recovery-required、绝不回滚/清理/relaunch）失败分类、协作式 abort；`chatDbImport/index.ts` `startPromotionExecution()` 唯一入口（同步帧 consume + 永不重置 start guard），`promoted` 仅在 durable replacement-verified 后结算，ownership 释放一律在 executor quiesce 后；执行终点 durable `replacement-verified` handoff（仍持有同一 lease）。验证：聚焦受影响区域 35 文件 / 1141 测试通过 / 0 失败（审计修正前基线 1138，保留为聚焦验证证据）；`typecheck:node` 通过；**最终全量验证通过（未涉及 CI / 未提交 / 未推送）**：`pnpm format` 通过（无文件改动）；`pnpm lint` 通过（0 errors / 87 warnings）；`pnpm test` 通过，275 文件 / 5983 通过 / 72 跳过；`pnpm typecheck:node` 通过；独立审计与复验均 pass。restore/relaunch/启动恢复动作执行属 Phase 4.4.3（Not started） |
| **2026-07-27** | **Phase 4.4.2 独立审计修正落地（终局 ownership 硬化）** | 独立审计结论 pass-with-findings（无阻塞）；两项 findings 接受为 correctness hardening 并已落地：① 成功 promoted 后 `session.executingCapability` 保留别名 → stale session fail/dispose 可释放成功 handoff 的授权；修正为显式 transfer（非 alias）：`takeExecutingCapability()` 将 capability 移出 session，终局记录 `TerminalPromotionOwnership { kind:'promoted' }` 成为唯一逻辑 owner。② post-install 失败在 executor quiesce 后释放 capability → 允许进程内公共 init 打开未验证的 installed DB；修正为 `PromotionRecoveryRequiredHandoff` 保留 capability/同一 lease（LOCK-4425 强化不变量：recovery-required handoff 保留 lease 阻断一切 ordinary maintenance 直至 Phase 4.4.3 或进程退出；pre-install 失败仍在 quiesce 后正常释放）。终局 ownership 结算唯一归属 `startPromotionExecution` continuation（executor 引用存在期间 fail/dispose/will-quit 一律延迟）；附带：prepared-handle disposal 去重 helper、`transferPromotionExecution` interim-owner 契约 JSDoc、`getTerminalPromotionOwnership()` Main-local peek。改动仅 `chatDbImport/index.ts` + `promotion/execution.ts`（doc-only）+ `chatDbImport/__tests__/index.test.ts`（C18 更新、C24–C26 新增）。复验：聚焦 35 文件 / 1141 通过 / 0 失败；`typecheck:node` 通过；changed-files biome/eslint 干净；未提交/未推送 |
| **2026-07-27** | **Phase 4.4.2 已提交 `3a81557ac6`** | Phase 4.4.0（`7768b7e30c`）+ Phase 4.4.1（`006615aff6`）+ Phase 4.4.2 一并提交至 `3a81557ac6`（`feat(chat-db): execute durable candidate promotion`），未推送 |
| **2026-07-28** | **Phase 4.4.3 Done（Recovery/Finalization）** | LOCK-4431…4439 全落地（commit `f6a6741b8e`；实现 + 独立审计 pass（两项 accepted fixes：real durable repair marker、startup gate fail-closed）+ 全量验证通过）。在 Phase 4.4.2 终点（durable `replacement-verified` handoff）之上落地恢复/终结管线全部执行侧：① **artifact probes**（`artifactProbe.ts`）——只读磁盘 truth 等价探测（live/retained snapshot/candidate 三 artifact 状态：missing/present-unverified/present-verified），路径由 Data root 严格派生（LOCK-4434），candidateId strict allowlist 校验，sidecar-free invariant（controlled no-residue strategy），before/after directory snapshots 证明零净文件系统变更；② **rollback**（`rollback.ts`）——bounded primitive：staging clone（`fs.copyFileSync` from retained snapshot，closed self-contained source）→ fsync → full readonly validation gate → consume closed-live proof → delete live sidecars → capture staging identity → atomic rename staging→live（同文件系统 ONLY，EXDEV=structured failure 无 copy fallback，LOCK-4426）→ fsync live parent dir → confirm destination identity → full readonly validation of restored live。LOCK-4434：retained snapshot **从不被消费或删除**；LOCK-4437：任何 failure 保留全部 artifacts；Clone decision：`fs.copyFileSync` chosen over SQLite backup API（source closed，re-opening 仅为 backup facility 无安全增益）；③ **journal cleanup**（`journalStore.ts` 扩展）——idempotent fixed-path cleanup primitive（`cleanupPromotionJournalBody`），三个 phase-gated API（`cleanupPromotionJournalAfterReplacementVerified` / `AfterSnapshotReady` / `AfterCandidateInstalled`）；guard-read validates journal → absent = idempotent success；invalid/phase mismatch/identity mismatch = reject pre-mutation；unlink → best-effort staging unlink → fsync parent dir（LOCK-4438）；仅 fixed journal + stale staging 为 deletion candidates（LOCK-4436），rollback snapshot / candidate / live 永不触碰；unlink failure → `CLEANUP_UNLINK_FAILED`（journal preserved）；dir sync failure → `CLEANUP_PARENT_DIR_SYNC_FAILED`（journal already unlinked）；④ **terminal ownership take**（`chatDbImport/index.ts`）——`takeTerminalPromotionOwnership()` atomically take-and-clear `TerminalPromotionOwnership`（LOCK-4433）；`setTerminalPromotionOwnership()` refuse overwrite unconsumed record；⑤ **repair marker**（`chatDb/index.ts`）——`markRepairRequiredBeforeInit()` durable repair-required marker write（file sync + parent dir sync），idempotent，refuses if service already initialized；⑥ **recovery executor**（`recoveryExecutor.ts`）——`createRecoveryExecutor()` 7 subphases（probing→deciding→authorizing→executing-action→cleanup-journal→relaunching→settled）；four actions（keep-old-live / accept-verified-replacement / restore-rollback-snapshot / repair-required）；authorization resolution（terminal ownership first，fresh lease fallback）；cooperative abort；injectable primitives；⑦ **relaunch**（`relaunch.ts`）——exact-once receipt-gated（WeakSet brand）`app.relaunch() + app.exit(0)`；⑧ **startup gate**（`gate.ts`）——`runStartupRecoveryGate()` absent-journal fast path（common case）+ valid journal → probe → decide → execute；⑨ **startup reorder**（`src/main/index.ts`）——startup order：BackupManager restore → **gate** → chatDbService.init() → orphan cleanup/window startup；repairRequired → skip init；relaunchPending → return early。Phase 4.4.2 非目标已全部落地。独立审计 pass（两项 accepted fixes：real durable repair marker、startup gate fail-closed）；聚焦测试 71 文件 / 1709 通过 / 72 跳过 / 0 失败；全量验证通过：`pnpm format` exit 0 无改动；`pnpm lint` exit 0（0 errors / 97 warnings）；`pnpm test` exit 0，281 文件 / 6205 通过 / 72 跳过；`pnpm typecheck:node` 通过；prior two ENOENT failures non-reproducible；未提交/未推送 |
| **2026-07-28** | **Phase 5.1B Done（已提交 `e44e413f30`，未推送）** | Phase 5.1B（主题生命周期 + 复合命令 + 搜索）已提交。commit `e44e413f30`（`feat(chat-db): complete phase 5.1b sqlite surfaces`），未推送 |
| **2026-07-28** | **Phase 5.2A Done（已提交 `e9de29ff97`，未推送）** | SearchResults 调用方迁移：`SearchResults.tsx` 从 Dexie 搜索切换到 `chatDb.searchMessages`（复用共享归一化函数）；新增 SearchResults 测试套件（620 行）；i18n 字段更新；`SqliteMessageDataSource` 适配。commit `e9de29ff97`（`feat(chat-db): migrate history search to sqlite`），未推送 |
| **2026-07-28** | **Phase 5.2B 实现 + 独立审计 + 全量验证完成（未提交/未推送）** | 在 Phase 5.1B 命令面之上落地主题生命周期调用方集成：① **新增模块**：`topicMetadataPersist.ts`（metadata 持久化层）、`topicTrashLifecycle.ts`（trash 生命周期流：soft/restore/hard/purge 编排）、`topicDeletionFlow.ts`（删除 UI 流）；② **调用方修改**：`useAssistant.ts`（assistant 空 trash 原子操作 + metadata 暴露时序）、`useTopic.ts`（trash 集成）、`Topics.tsx`（确定性分页 + 操作增强）、`TopicTrashPanel.tsx`（trash 面板增强）、`TopicManageMode.tsx`、`AssistantItem.tsx`、`AssistantService.ts`、`Chat.tsx`、`Inputbar.tsx`、`Messages.tsx`、`Tabs/index.tsx`；③ **aggregate/IPC 扩展**：`ChatDbAggregateService.ts`、`ipc.ts`、`preload/index.ts`、`SqliteMessageDataSource.ts`、`IpcChannel.ts`、`contracts.ts`/`types.ts`；④ **FileCleanupResult 消费**：调用方依据 `remainingReferenceCounts===0` 决定物理删除（LOCK-5108/5109）；⑤ **普通 topic 所有权保障**：暴露前完成 ownership 解析（LOCK-5107）；⑥ **Agent Dexie 边界**：agent session 操作保持 Dexie 路由隔离；⑦ **确定性分页**：Topics 列表分页稳定性。**已知延后范围（LOCK-DOC4）**：MoveTopic ownership transfer 延后；legacy ImportService ownership 延后；assistant-removal compound flows 属后续工作。**已知限制（LOCK-DOC5）**：agent session focused assertions 通过，runtime agent UI 不可用（无 Main handler/IPC/UI entry，非 ABI 问题）。**全量验证**：`pnpm test` 289 文件 / 6629 通过 / 72 跳过；focused/shared/Main/renderer checks 通过；`pnpm format` 无改动；`pnpm lint` exit 0 / 33 warnings / 0 errors；`pnpm typecheck` pass；`git diff --check` pass。CI 环境 `CI=true` 下 30 个 pre-existing no-console errors 为 baseline 行为（非 Phase 5.2B 回归）。**closure 注（LOCK-MD9）**：该 no-console baseline 已由 2026-07-31 交付收尾的窄化 Main log bridge/no-console 修复解决（closure 后 CI=true lint 0 errors）。未提交/未推送 |
| **2026-07-28** | **Phase 5.0 Done + 5.1A 已提交 + 5.1B 已提交 + 5.2A 已提交 + 5.2B 实现完成** | Phase 5 拆为 5.0（基线就绪与子阶段划分）、5.1A（SQLite 命令面补全，已提交 `6fa5ff5ef9`）、5.1B（主题生命周期 + 复合命令 + 搜索，已提交 `e44e413f30`）、5.2A（SearchResults 调用方迁移，已提交 `e9de29ff97`）、5.2B（主题生命周期调用方集成 + 复合操作增强，实现 + 独立审计 + 全量验证完成，未提交/未推送）、5.3（权威切换与 scaffolding 移除）、5.4（E2E/性能/清理门）。Phase 5 命令面总计 35 个 `ChatDb_*`（Phase 3.2 的 14 + 5.1A 的 9 + 5.1B 的 12）。本 session 确立并激活 LOCK-5101…5113（命令面 / 主题生命周期 / 复合事务所有权 / FileCleanupResult / purge cutoff 所有权）与 LOCK-5121…5129（migration 003 FTS 归一化投影 / 共享归一化单一事实源 / FTS 候选加速器非权威 / 块级游标 / 基准方法学）。Phase 4 全部 LOCK-44xx 与历史 ADR 继续有效 |
| **2026-07-28** | **Phase 5.1A Done（已提交 `6fa5ff5ef9`）** | 9 个命令经 `ChatDbAggregateService` + typed IPC + `window.api.chatDb` + `SqliteMessageDataSource` 全链路落地：`ListSegments` / `UpsertSegment` / `UpdateSegmentMetadata` / `DeleteSegment` / `ReplaceSegmentMembership` / `ReorderMessages` / `ListFileRefsByFile` / `CountFileRefsByFile` / `ListBlocksByFile`。segment 全量替换语义；file-ref 查询只读；reorder 仅 topic 内。已提交 `6fa5ff5ef9`（未推送） |
| **2026-07-28** | **Phase 5.1B Done（已提交 `e44e413f30`，未推送）** | 12 命令/表面：主题生命周期 6（`UpdateTopicMetadata` / `SoftDeleteTopic` / `RestoreTopic` / `ListTrashTopics` / `HardDeleteTopic` / `PurgeExpiredTopics`）+ 复合 5（`CloneMessagesToTopic` / `ResetMessagesForResend` / `DeleteMessagesWithSegments` / `PasteMessagesToTopic` / `ClearTopicWithSegments`）+ 搜索 1（`SearchMessages`）。`FileCleanupResult` 仅返回 `{affectedFileIds, remainingReferenceCounts}`，DB 事务内无文件系统副作用（LOCK-5108/5109）；复合命令单 root 事务 + 所有权强制（LOCK-5106/5107）；purge cutoff 由调用方提供（LOCK-5113）。migration 003（`003_fts5_normalized_search`）append-only 幂等：`message_blocks_normalized` + `message_blocks_fts`（trigram）+ 三触发器，`chatdb_normalize()` 在触发前注册（LOCK-5121/5126/5127）。`SearchRepository`：term≥3 码点走 FTS5、<3 走 LIKE、多 term 交集（LOCK-5124）；FTS 仅候选加速器、过共享精确 regex、错误传播非 catch-to-empty（LOCK-5101/5125）；块级 `(created_at, message_id, block_id)` 游标、不额外 deleted-topic 过滤（LOCK-5123/5128）。`SearchResults.tsx` 调用方仍为 Dexie（仅复用共享归一化函数），切到 `SearchMessages` 属 Phase 5.2A。10k 基准（确定性 10,000 MAIN_TEXT 块、3 warmup + 10 measured × 10 query、强制有序 parity）：LIKE p50 8.96 / p95 10.28 / mean 8.83ms；hybrid p50 2.90 / p95 6.51 / mean 3.40ms；加速 p50 3.09x / p95 1.58x（LOCK-5129）。聚焦验证：Main 1838 passed / 72 skipped / 0 failed；Phase 5.1B 聚焦套件与 typecheck 通过；全量 format/lint/test/typecheck 门通过。已提交 `e44e413f30`（未推送） |
| **2026-07-31** | **Phase 6 交付收尾（closure）本地完成** | 本地交付关闭证据已记录：A-class/B-class E2E 证据分离（LOCK-MD2——A-class `import-cherrystudio.spec.ts` 保持历史证据、未重跑；B-class `import-cherrystudio-genuine.spec.ts` fresh ABI145 build 后精确标准 Playwright 命令 1/1 PASS，host ABI137 恢复）；B-class 源为 **disposable production-format Chromium IndexedDB ZIP fixture**（Level 1 automated compatibility evidence，非历史用户备份；历史 release-generated backup 为 Level 2、未测试，LOCK-MD3）；B-class 硬证据（LOCK-MD4：public `cherryImport.start` production path / 经 finalizing 必需链 / 原目标进程退出 / 安装后 `Data/chat.db` fixed topic/message/block/segment IDs + `topic_segment_messages` / baseline replace-all / retained snapshot + journal/staging 无残留 / exact-token relaunch 清理 / host ABI137 恢复）；六个交付阻塞项修复（LOCK-MD5：窄化 Main log bridge/no-console；嵌套 HTML path；自包含 sandbox preload；listener-before-ready handshake；ensure-open-per-read with per-page close；post-verification checkpoint reseal）；本地 gates 全 PASS（LOCK-MD6：Node v24.12.0 / pnpm 10.27.0；format PASS；CI=true lint 0 errors（76 oxlint + 4 ESLint warnings）；CI=true test 312 文件 / 7009 / 72 skip / 0 fail；typecheck node/web/aiCore PASS；i18n PASS；git diff --check PASS）；C-4/C-5/C-7 未实现、parked（LOCK-MD7）；独立 artifact audit pass-with-nonblocking findings；**push/remote CI 事实（LOCK-MD8）**——origin 分支已推送（remote SHA `89803503fc...`，upstream `origin/jorkey/refactor/sqlite-migration` 建立）；GitHub Actions runs for this branch = 0（**未运行/无 run**，非失败、非 green CI）；ci.yml push trigger 仅 `main`/`v1`、未创建 PR、未手动 dispatch；E2E 仍为非远程 CI 证据；no-console baseline 注释为 closure 中 resolved（LOCK-MD9）。未定义 Phase 7、未重开 Phase 0–6 |
| **2026-08-04** | **Post-closure L2 产品闭环最终实现完成（deterministic identity / residuals / large blocks / FTS / imported trash / post-close helper）** | L2 导入管线产品闭环收口完成（非 Phase 7；Phase 0–6 Done 状态不变）。确定性全出现消息身份（`(outerTopicId, legacyMessageId)` tuple + magic `cherry-chat:l2-message-id` / version `0x01` / `uint32be` 帧 → `l2m1:` + 64 小写 SHA256；129150/129150 零碰撞、顺序无关；同 topic askId 确定性重映射、16 dangling askId 保留原值不解析碰撞防护；manifest/hash/writer/verifier canonical）。规范化残余：absent-topic/all-members-absent segments 跳过（2 rows/4 memberships）、unembedded existing-owner block 跳过防内容复活（1）、absent-owner 孤儿保持既有行为、strict 冲突保持严格；规范化统计扩展为**六类 exact-once count-only 类别**（Main-only、finalize 后恰好一次 count-only warning、无 ID/内容/路径/源值）；已知计数以 closure/test 证据标注、**不声称 final run 未发出计数**（LOCK-DOC-3）。大块：L2/fetch 8MiB/string、16MiB/row、64MiB/page/result、depth20/array100k；generic 1MiB 不变；精确 artifact 3 >1MiB 行（1 orphan、2 reachable）、max 约 2.67MB、reachable 导入 orphan 跳过。FTS：migration 003 派生结构 **candidate-only 延迟** + seal 前**一次原子重建**（rebuild ~85ms @10k vs 每页 16–41s 超线性）；**search_projection 为第 14 verifier 维度** + 只读 gates、精确有序 multiset parity、结构性基准 ~103ms/page；candidate 路径隔离/生命周期硬化。导入回收站：源 deletedAt 保留；Main-only `l2TrashRetentionStartedAt` overflow marker 每导入一次、置于 manifest/writer 前；purge 生效 max(deletedAt, 有效 marker)、**自导入起五天**；restore 清 marker；invalid 回退 count-warning；wire 剥离 marker；最终 artifact SQLite **2707** / active nav **2704** / deletedTopics **3**。post-close helper/observer（test-only）：payload-aware retained status history、typed 批量只读验证 ≤60s 动态 deadline、精确 integrity/FK/six counts/deletedTopics、snapshot strict、隐私。导航/投影/重启/选择性 ZIP handoff 合同保持、最终合成 E2E 通过。验证：Node **latest-source**（Node24.12 ABI137，2026-08-04 最终序列）`native:rebuild:node` exit 0（ABI137 SQL PASS）/ format exit 0（1 个文件首次 pass 被修复、二次 clean，身份未指明）/ lint exit 0 / 0 errors / **81 oxlint + 4 ESLint pre-existing warnings** / typecheck+i18n PASS / `CI=true pnpm test` exit 0 / **335 files（1 skipped）/ 7901 tests passed / 75 skipped / 0 failed**（user-source 7890/74 为 helper/privacy docs 前历史证据）；Electron native rebuild/check/build PASS、ordinary/genuine/dev/large 1/1、精确真实 spec 1/1 6m48s（candidate 2707/129150/158441/13/39/4158、pages 365、elapsed 136307）、全链 promoted、integrity/FK/six counts/snapshot/14 dims/projection/UI/reload PASS、ZIP 指纹不变（size 1393936335、SHA locked、inode/mode/mtime 不变）、final ABI145。provenance（本次 closure）：实现与 E2E 已本地提交（`26c7190333` feat(import)：complete L2 Cherry Studio migration flow / `1c2c70a3dd` test(import)：add end-to-end migration coverage）；本节文档收尾提交后 HEAD = 本节文档收尾提交（哈希见当前 git history）、远程 tip `3a64da6020` 不变、本地 ahead 11（pre-existing 8 + 本次 closure 3）、工作树 clean；无 push/PR、远程 CI 无新 run。文档更新：top-level 状态注释与最后更新、三分类 provenance、新增 post-closure L2 产品闭环小节（LOCK-L2ID-1 / LOCK-RES-1 / LOCK-LGBLK-1 / LOCK-FTS-1 / LOCK-TRASH-1 / LOCK-HELPER-1）、§17 最终交付验证（2026-08-04） |

---

## 15. 进度日志

| 日期 | 阶段 | 进展 |
|---|---|---|
| 2026-07-19 | Phase 0 | 资产调查完成（Done） |
| 2026-07-19 | Phase 0 | Group A 清理完成（Done）：C-1 agents scripts 已删除，C-6 README 标记废弃，C-8 CLAUDE.md 已清理 |
| 2026-07-19 | Phase 1 | 骨架完成（In progress）：better-sqlite3 + Drizzle ORM 安装；ChatDbService、schema、migration runner、repository 目录已创建；TypeScript 编译通过 |
| 2026-07-19 | 决策 | A-7 Accepted（better-sqlite3 + Drizzle ORM，PowerSync 兼容）；A-5 Accepted（一次性切换 + Dexie 快照回滚） |
| 2026-07-20 | Phase 1 | 完成（Done）：ChatDbService 生命周期硬化；WAL/fk/synchronous/busy_timeout pragmas；inline build-safe initial migration；integrity check；restored-first-open repair gating（repair-required 时 app 继续运行，chat DB 不可用）；startup/will-quit wiring；replaceable online backup adapter（better-sqlite3 `backup()`）；BackupManager full-operation coordination（互斥锁、staging、生产路径过滤）；production-path tests |
| 2026-07-20 | 决策 | A-6 Accepted（online backup adapter + full-operation coordination）；Q-7 Closed/Accepted |
| 2026-07-20 | Phase 2 | 完成（Done）：append-only migration 002；Main-local DTO/codec/mappers/typed cursors；TopicsRepository、MessagesRepository、BlocksRepository、TopicSegmentsRepository、FileReferencesRepository；block-linked file references（完整元数据快照）；CRUD/batches/keyset pagination/dense ordering/ownership/cascades/rollback 测试（real better-sqlite3）；Q-3 Resolved（file references 策略）；Q-5 Resolved（无 FTS） |
| 2026-07-20 | Phase 3.1 | 完成（Done）：14 个 ChatDb IPC channels（IpcChannel.ts）；packages/shared/chatDb/ 新增 types.ts（JSON wire DTO/result envelope/command map）、result.ts（ok/fail/isSuccess/isFailure/envelope）、validation.ts（runtime JSON validator，深度 20，拒绝非法类型）、contracts.ts（channel→allowedKeys+validate 映射）、index.ts（barrel）；199 个 shared tests（validation.test.ts 99 + contracts.test.ts 100；初始完成时为 107，后续扩展至当前 199）；typecheck / format 通过 |
| 2026-07-20 | Phase 3.2 | 完成（Done）：ChatDbAggregateService（14 命令实现）；repository factory（root DB / transaction 绑定）；wire adapters（JSON ↔ Domain，保留结构化 renderer model/tool-object/unknown JSON/nullable 语义）；errors.ts（错误映射 9 类）；ipc.ts（14 个 IPC handler 注册 + request/result 运行时验证 + 结构化错误映射 + disposer）；shared contract 修正（blocks 数组前置验证、identity/reparenting 拒绝、所有权一致性、新错误码）；78 个新 tests 通过；438 个 tests 全部通过（Phase 3.2 初始完成时的快照基线）；typecheck / format 通过 |
| 2026-07-20 | Phase 3.2 审计修复 | 修复 9 项审计发现：fetchMessages topic priming；updateBlocks/updateSingleBlock/deleteBlocks/clearMessages 原子性（root tx + tx-bound repos）；clearMessages 移除 fileRefs.deleteByMessage（FK cascade）；typed aggregate errors + SQLite code inspection；IPC validateChatDbResult + malformed result containment；channel ChatDbChannel 类型；错误消息 sanitize；generic storage error non-retryable；53 个新 tests；932 个 total tests 通过（审计修复后的快照基线） |
| 2026-07-20 | Phase 3.2 评审修复 | 修复 5 项评审发现：① 替换伪回滚测试为基于 SQLite trigger 的确定性回滚测试（appendMessage/updateMessageAndBlocks/updateSingleBlock 三个 genuine rollback cases）；② IPC 注册模块级生命周期管理（activeRegistrationId + activeDisposer + stale-disposer ownership）；③ shared contract updateMessage/updateSingleBlock patch 拒绝 sortOrder 字段；④ 移除 "abort due to constraint" 冲突误分类（避免 unstructured FK message 被分类为 CONFLICT）；⑤ 141 个 Phase 3.2 tests 通过，870+ total tests 通过（评审修复后的快照基线；低于932因伪回滚测试替换为3个真实回滚测试） |
| 2026-07-20 | Phase 3.4 完成 | 不可变注入路由策略（DbRoutingPolicy：dexie / sqlite-validation / sqlite-authoritative）；routingPolicy.ts 定义 OrdinaryMessageSource / DexieMessageSource / AgentMessageSource 依赖接口和 DbServiceDeps 构造选项；DbService 重构为公共构造函数 + 不可变注入策略 + 懒加载 SQLite 源（首次普通操作创建一次）+ 永久 Dexie 单例；sqlite-authoritative 构造同步抛出 Phase 5 错误；Agent 路由策略无关最高优先级；updateFileCount(s) 始终 Dexie；无 readiness 检测 / fallback / shadow / dual-write；102 个新 DbService tests 通过（路由 / 懒加载 / Agent / 分区 / 文件操作 / 错误传播 / 无探针 / 参数保持）；168 个 renderer db tests 通过；typecheck / format 通过 |
| 2026-07-20 | Phase 3.3 完成 | Preload bridge（window.api.chatDb 14 个命名方法 ipcRenderer.invoke）；Renderer SqliteMessageDataSource（ChatDbApi 构造注入 + ChatDbResultError + cloneForWire + 14 方法 + dispatch parity）；Main structured model 缺陷修复（wireToMessage 对象→overflow + column null + modelId 提取；messageToWire overflow 恢复；wireToMessagePatch null model 清除 overflow）；803 个 tests 通过 |
| 2026-07-20 | Phase 3 | **Done**（Phase 3.1 Done, Phase 3.2 Done (audit-fixed), Phase 3.3 Done, Phase 3.4 Done） |
| 2026-07-19 | Phase 4 | Not started |
| 2026-07-19 | Phase 5 | Not started |
| 2026-07-19 | Phase 6 | Not started |
| **2026-07-20** | **策略更正** | **A-8 Accepted：外部应用兼容性导入模型替代 in-place Dexie→SQLite shadow/cutover（A-5 Superseded）。Phase 4 重定义为外部导入管线（4.0 spike → 4.1 ZIP intake → 4.2 bulk import → 4.3 verification → 4.4 atomic promotion）。Phase 5 重定义为 SQLite-only runtime 完成。Phase 6 重定义为 Cherry Chat 备份/恢复分离 + 清理。文档全面更新反映新模型** |
| **2026-07-21** | **Phase 4.0 Done** | **Isolated-profile feasibility spike 完成 — Go on macOS arm64。**验证：`session.fromPath(absolutePath, { cache: false })` 为正确 Electron API（非 `session.defaultSession.fromPath()`）；file:// origin 正确；`IndexedDB/file__0.indexeddb.leveldb` 为观测到的 profile 映射；Dexie logical 4→native 40, 11→native 110, 12→native 120（×10 乘数）；v4 通过 production upgrades (v5→v7→v8→v11) 升级；v12 被正确拒绝；default session 隔离确认；A/B markers 不跨 session；Local Storage 非 discovery/read 必需；10/10 fresh-root 迭代通过，cleanupAttempts=1，无 leftovers。**未验证**：Windows/Linux、真实 ZIP snapshot 一致性。helper 进程回退为 contingency only，未选用 |
| **2026-07-21** | 决策 | A-9 Accepted（Phase 4.1 macOS-first + 平台拒绝）；A-10 Accepted（Phase 4.0 harness 保留至 Phase 5）；Q-12 Resolved（import renderer 专用独立 HTML 入口） |
| **2026-07-21** | Phase 4.1 | 只读诊断完成（In progress）：fresh Analyzer 产出 source-reader 侧生产化方案；3 项 deferred 问题（跨平台/spike/HTML 入口）已闭环并文档化 |
| **2026-07-21** | Phase 4.1 | **Source-reader 生产化完成（Done）**：17 新文件 + 4 修改文件（chatDbImport/ + chatImport preload + chatImport renderer + shared types/IpcChannel + electron.vite.config + main/ipc/index）。审计 4 blockers 修复 + 复审 2 orchestrators 修复 + 最终 Auditor Clean。主进程 977/977。合入 `6a1e98e7ef` |
| **2026-07-27** | Phase 4.2 | **Candidate bulk importer 完成（Done）**：实际模块 `CandidateDbResource` / `ChatImportDataPlane` / `ChatImportWriter` / `startupRecovery`；每页一事务、import-only 保序 writer、`candidate-ready` exact-once、`SourceReadStats` vs `CandidateImportStats` 分离；10k 基准（25 topics / 10,000 messages / 11,000 blocks / 26 segments / 250 memberships / 667 file refs / 19 pages；两次运行 1016.2ms、978.5ms；`integrity_check` ok、`foreign_key_check` 空；live `chat.db` 未改）；最终审计 0 blockers；聚焦测试通过；全量本地验证通过（2026-07-27）：`pnpm format` exit 0 无改动；`pnpm lint` exit 0（node/web/aicore typecheck 全过、i18n 校验通过、0 errors，仅 pre-existing warnings）；`pnpm test` exit 0，252 文件 / 5325 通过 / 72 跳过；无遗留产物（local-only full validation，未涉及 commit/push/CI） |
| **2026-07-27** | Phase 4.3 | **Deterministic verification 完成（Done，已提交/已推送）**：实际模块 `CandidateVerifier` / `SourceVerificationManifest` / `VerificationReport`；只读 13 维度验证 + 有界安全诊断；manifest 按页事务后落盘 + stable canonical SHA-256（~5,019KiB）；会话状态机 candidate-ready→verifying→verified-candidate | verification-failed；取消/退出 close-before-discard；通过保留候选供 4.4、失败报告后清理；corruption matrix 覆盖全部维度；10k 验证证据（25 topics / 10,000 messages / 11,000 blocks / 26 segments / 250 memberships / 667 file refs / 19 pages；~250–290ms）；聚焦测试 271 通过；`pnpm format` exit 0 无改动；`pnpm lint` exit 0（0 errors，109 warnings）；`typecheck:node` 通过；首次 `pnpm test` 5420 通过 / 2 失败（BackupManager 共享临时目录非确定性 flakes，排查否定 Phase 4.3 干扰）/ 72 跳过；复跑 `pnpm test` 258 文件 / 5422 通过 / 72 跳过 / 0 失败；Main 与全量多次复跑干净；最终审计 0 findings（本地全量验证，未涉及 CI） |
| **2026-07-27** | Phase 4.4.0 | **Promotion 协议基础完成（Done，纯协议层）**：`chatDbImport/promotion/{protocol,journal,recovery}` + `chatDb/maintenanceCoordination` + `chatDbImport/index` 状态扩展（`promoting/promoted/promotion-failed`）+ `claimPromotion()`/`completePromotion()` exact-once + cancel/dispose/will-quit 边界 + startupRecovery 纯契约 re-export；journal v1 严格 codec（无路径）；恢复矩阵 90 组合穷举、12 崩溃点覆盖（LOCK-4406）；五操作互斥 lease 契约（LOCK-4402，未接线）；无任何 live/candidate/snapshot 文件操作或 promotion IPC（LOCK-4405）；聚焦 chatDb+chatDbImport 29 文件 / 895 通过（基线 822 + 新增 73）；`typecheck:node` 通过 |
| **2026-07-27** | Phase 4.4.1 | **Durable Preparation Gate 完成（Done，未提交/未推送）**：在 4.4.0 协议层之上落地 LOCK-4411…4417。统一维护接线（`maintenanceCoordination.ts` promotion 接入既有 backup/restore/init/close 互斥、唯一 lease 持有者、无第三锁）；rollback 快照创建（`chat.db.pre-import-backup`：live→staging→验证→原子 rename，不复制 WAL/SHM，仅发布不 restore）；严格持久化 journal store（`promotion/journal.ts` 新增 crash-safe 原子 rename 落盘 writer，journal `snapshot-ready` 已落盘）；启动候选保护（`startupRecovery.ts` 扩展为读 journal、保护 journal-referenced candidate 排除年龄清理、按 4.4.0 恢复矩阵安全分类中断资产）；exact-once prepared handle（`claimPromotion()` 不可复用 token 准备窗口唯一可消费、promotion-owned dispose/will-quit 保留候选）；非破坏性边界（不关闭/替换/重命名 live `chat.db`、失败回退 keep-old-live/repair-required、全写为 staging+原子 rename）；最大边界止于 snapshot-ready。审计：首轮独立审计发现 candidateId 与 session 集成两阻塞，均已修复，复审 0 findings。验证：`pnpm format` 通过（无改动）；`pnpm lint` exit 0（82 oxlint + 33 eslint known warnings，115 emitted warning instances，0 errors）；`pnpm typecheck:node` 通过；`pnpm test` exit 0，272 文件 / 5860 通过 / 72 跳过 / 0 失败；本地全量验证，未涉及 CI / 未提交 / 未推送 |
| **2026-07-27** | Phase 4.4.2 | **Destructive Promotion Executor 完成（Done，实现 + 聚焦验证 + 独立审计 pass-with-findings、两项接受的 ownership/isolation 硬化修正已落地复验（成功 handoff 独占 capability 转移；post-install recovery-required 保留 lease 阻断 ordinary maintenance 至 Phase 4.4.3 或进程退出）；未提交/未推送）**：exact-once prepared→executing capability 转移（`preparation.ts` consume，LOCK-4421）；owner-aware live 生命周期（`chatDb/index.ts` closeForPromotion/reopenForPromotion + `maintenanceCoordination.ts` validatePromotionAuthorization，同一持续持有 lease 授权全窗口，LOCK-4422）；原子 rename-only install + sidecar 处理 + fsync + identity receipt + closed-live proof（`install.ts`，EXDEV 无 copy fallback，LOCK-4423/4426/4427）；严格 journal 递进 transition API（`journalStore.ts`，snapshot-ready→candidate-installed→replacement-verified，LOCK-4423/4424/4425）；identity-bound replacement 验证（`replacementVerifier.ts` + `readonlyDbValidation.ts` 共享只读门，LOCK-4424）；执行编排 8 subphase + pre/post-install 失败分类 + 协作式 abort + `startPromotionExecution()` 唯一入口（`execution.ts` + `chatDbImport/index.ts`，LOCK-4425/4428）；执行止于 durable `replacement-verified` handoff——无 restore/relaunch/清理；审计硬化后终局 ownership 结算唯一归属 `startPromotionExecution` continuation（成功/post-install → `TerminalPromotionOwnership` 终局记录持有 capability，stale session 清理不可释放；pre-install → quiesce 后释放）。验证：聚焦受影响区域（chatDb + chatDbImport）35 文件 / 1141 测试通过 / 0 失败（修正前基线 1138，保留为聚焦验证证据）；`typecheck:node` 通过；changed-files biome/eslint 干净；**最终全量验证通过（未涉及 CI / 未提交 / 未推送）**：`pnpm format` 通过（无文件改动）；`pnpm lint` 通过（0 errors / 87 warnings）；`pnpm test` 通过，275 文件 / 5983 通过 / 72 跳过；`pnpm typecheck:node` 通过；独立审计与复验均 pass。Phase 4.4.3（rollback restore 执行/relaunch/启动恢复动作执行）Not started |
| **2026-07-27** | Phase 4.4.2 已提交 | Phase 4.4.0+4.4.1+4.4.2 一并提交至 `3a81557ac6`（`feat(chat-db): execute durable candidate promotion`），未推送 |
| **2026-07-28** | Phase 4.4.3 | **Recovery/Finalization 完成（Done，commit `f6a6741b8e`；实现 + 独立审计 pass + 全量验证通过）**：LOCK-4431…4439 全落地。5 个新文件 + 5 个修改文件 + 4 个测试文件扩展。① artifact probes（`artifactProbe.ts`）：只读磁盘 truth 等价探测，路径 strict derive + candidateId allowlist，sidecar-free invariant + before/after dir snapshots；② rollback（`rollback.ts`）：staging clone（`fs.copyFileSync`）+ fsync + readonly validation + consume proof + atomic rename → fsync + identity confirm + restored live validation；retained snapshot never consumed（LOCK-4434）；③ journal cleanup（`journalStore.ts` 扩展）：idempotent fixed-path cleanup + phase-gated API + guard-read + unlink + best-effort staging + fsync parent dir（LOCK-4438）；④ terminal ownership take（`chatDbImport/index.ts`）：`takeTerminalPromotionOwnership()` atomic take-and-clear（LOCK-4433）；⑤ repair marker（`chatDb/index.ts`）：`markRepairRequiredBeforeInit()` durable write，idempotent，refuse when initialized（LOCK-4437）；⑥ recovery executor（`recoveryExecutor.ts`）：7 subphases + four actions + authorization resolution + cooperative abort；⑦ relaunch（`relaunch.ts`）：exact-once receipt-gated `app.relaunch()+exit(0)`（LOCK-4438）；⑧ startup gate（`gate.ts`）：absent-journal fast path + valid journal → probe → decide → execute；⑨ startup reorder（`src/main/index.ts`）：BackupManager restore → gate → chatDbService.init() → orphan cleanup/window。独立审计 pass（两项 accepted fixes：real durable repair marker、startup gate fail-closed）；聚焦测试 71 文件 / 1709 通过 / 72 跳过；全量验证通过：format 无改动；lint 0 errors/97 warnings；test 281/6205/72 skipped；typecheck:node pass；prior two ENOENT failures non-reproducible |
| **2026-07-28** | Phase 5.0 | **基线就绪与子阶段划分完成（Done）**：在合并后基线上确立 Phase 5 拆为 5.0/5.1A/5.1B/5.2A/5.2B/5.3/5.4；命令面清单（14 + 9 + 12 = 35）；LOCK-5101…5113 / LOCK-5121…5129 持久化框架。不新增代码 |
| **2026-07-28** | Phase 5.1A | **SQLite 命令面补全完成（Done，已提交 `6fa5ff5ef9`，未推送）**：9 命令（segments / file-ref / reorder）经 aggregate + IPC + preload + renderer datasource 全链路；segment 全量替换、file-ref 只读、reorder 仅 topic 内；类型检查与聚焦测试通过 |
| **2026-07-28** | Phase 5.1B | **Done（已提交 `e44e413f30`，未推送）**：主题生命周期 + 复合命令 + 搜索实现完成。12 命令/表面；`FileCleanupResult` 无文件系统副作用（LOCK-5108/5109）；复合单 root 事务 + 所有权强制（LOCK-5106/5107）；purge cutoff 调用方提供（LOCK-5113）；migration 003 FTS 归一化投影 append-only 幂等（LOCK-5121/5126/5127）；搜索 FTS 候选加速器 + 精确 regex + 错误传播（LOCK-5101/5123/5124/5125/5128）；块级游标；SearchResults 调用方仍 Dexie（Phase 5.2A 边界）。10k 基准：LIKE p50 8.96/p95 10.28/mean 8.83ms；hybrid p50 2.90/p95 6.51/mean 3.40ms；加速 p50 3.09x/p95 1.58x（LOCK-5129）。聚焦验证通过；全量 format/lint/test/typecheck 通过 |
| **2026-07-28** | Phase 5.2A | **Done（已提交 `e9de29ff97`，未推送）**：SearchResults 调用方迁移（Dexie → SQLite 搜索）。`SearchResults.tsx` 切到 `chatDb.searchMessages`；新增测试套件（620 行）；i18n 字段更新；`SqliteMessageDataSource` 适配 |
| **2026-07-28** | Phase 5.2B | **实现 + 独立审计 + 全量验证完成（未提交/未推送）**：主题生命周期调用方集成（`topicMetadataPersist.ts` / `topicTrashLifecycle.ts` / `topicDeletionFlow.ts`）+ 助手空 trash 原子操作 + FileCleanupResult 消费 + 普通 topic 所有权保障 + agent Dexie 边界 + 确定性分页。已知延后（LOCK-DOC4）：MoveTopic ownership / legacy ImportService / assistant-removal。已知限制（LOCK-DOC5）：agent session focused assertions 通过，runtime agent UI 不可用（无 Main handler/IPC/UI entry）。全量验证：289 文件 / 6629 通过 / 72 跳过；focused/shared/Main/renderer checks 通过；`pnpm format` 无改动；`pnpm lint` exit 0 / 33 warnings / 0 errors；`pnpm typecheck` pass；`git diff --check` pass。CI 环境 `CI=true` 下 30 个 pre-existing no-console errors 为 baseline 行为（非 Phase 5.2B 回归）。**closure 注（LOCK-MD9）**：该 no-console baseline 已由 2026-07-31 交付收尾的窄化 Main log bridge/no-console 修复解决（closure 后 CI=true lint 0 errors）。未提交/未推送 |
| **2026-07-29** | Phase 5.3 | **Done（已提交 `b81a35c054`，未推送）**：DbService 默认路由直连 SQLite；routingPolicy scaffolding 移除（C-13：`routingPolicy.ts` 删除、构造注入策略 / 懒加载切换 / 永久 Dexie 单例 / `sqlite-authoritative` 拒绝路径全部移除）；DexieMessageDataSource 从普通聊天路径移除（C-11）；agent session 操作保持 `AgentMessageDataSource` stub 路由（策略无关最高优先级）；import renderer 内部仍使用 Dexie（Phase 4 隔离 import 架构不变）。原子 ownership / reset / resend / destructive cleanup 语义在直连 SQLite 路径上完整保留（LOCK-5106…5109）。**全量验证**：`pnpm format` exit 0 无改动；`pnpm lint` exit 0（97 oxlint + 34 ESLint warnings / 0 errors）；`pnpm test` 295 文件 / 6577 通过 / 72 跳过 / 0 失败；`pnpm typecheck` pass；`git diff --check` pass。独立审计 pass（0 blockers）。未提交/未推送 |
| **2026-07-28** | Phase 5.3 / 5.4 | ~~Not started~~ → Phase 5.3 Done（2026-07-29，已提交 `b81a35c054`）；Phase 5.4 Done（2026-07-30，feature commit `6c250f19a2` + docs commit `6b2f140955`） |
| **2026-07-30** | **Phase 5.4** | **Done（实现 + E2E + 性能基准 + A-10 spike harness 清理 + 文档收尾；feature commit `6c250f19a2` + docs commit `6b2f140955`）**。Electron ABI 145 重建成功，E2E 运行时通过。E2E 验证矩阵：4 个 spec 通过（ordinary-chat real send/edit/resend/regenerate/copy + exact request/SQL；topic-trash soft-delete/restore/hard-delete/empty-trash + name/title + cross-assistant isolation；multi-model append + real dnd reorder persisted；topic-move real delete + undo/redo persisted）。Agent session 185 focused assertions 通过，runtime agent UI 不可用（无 Main handler/IPC/UI entry，非 ABI 问题）。性能基准：消息加载 p50 7.42ms / p95 8.23ms；repository two-transaction write microbenchmark 38.5 batch ops/s / 385.2 msgs/s（microbenchmark 非聚合生产吞吐）；cold open p95 6.91ms < 500ms。历史 Dexie comparator 不可用，仅报告绝对 SQLite 结果。Phase 4 spike gate 已通过（A pass、C1 4/4、C2a 8/8、C2b 10/10）后 22 个 spike-only 文件 + build gate 移除（A-10 fulfilled/deleted）。零 ordinary runtime Dexie chat-table references 确认（有效例外 agent/import（LOCK-6023 隔离 import renderer 保留））。Topic name persistence + durable file lifecycle correctness fixes 在 E2E 过程中发现并实现/审计。文档收尾：更新本迁移文档反映 Phase 5.4 最终态。LOCK-DOC6/LOCK-DOC7 新增（性能方法学/历史 Dexie comparator 不可用）。feature commit `6c250f19a2` + docs commit `6b2f140955` |
| **2026-07-31** | **Phase 6.0** | **L2/L3 架构决策与合同确立完成（Done）**：确立 L2/L3 产品语义边界（LOCK-6001）、L2 replace-all + macOS-first + 独立 UI（LOCK-6002）、隔离 import renderer 保留（LOCK-6023）、agents.db 永久保留（LOCK-6024） |
| **2026-07-31** | **Phase 6.1** | **L2 Cherry Studio ZIP 兼容导入产品合同实现完成（Done）**：replace-all 语义 + 真实 Phase 4 preparation/execution/recovery 管线 + macOS-first + 独立 UI；L2 controller 生命周期（generation/session-scoped + finalizing before promoted + terminal handoff settlement）经验证 |
| **2026-07-31** | **Phase 6.2** | **L3 Cherry Chat 备份/恢复适配与 v7 metadata 实现完成（Done）**：沿用现有产品流程适配 chat.db；v7 metadata 实现（LOCK-6004/6005/6008/6009）；metadata-less/data.json/.bak ordinary restore 已移除；L3 与 L2 语义分离 |
| **2026-07-31** | **Phase 6.3** | **安全/可靠性加固完成（Done）**：ZIP containment（LOCK-6012–6014/6019）、ChatDbBackup workspace 隔离（LOCK-6020–6022）、stream settlement and cleanup-before-exit across local/WebDAV/S3/Nutstore；隔离 import renderer 保留（LOCK-6023）；agents.db 永久保留（LOCK-6024） |
| **2026-07-31** | **Phase 6.4** | **验证门、清理收尾、文档更新完成（Done）**：聚焦安全/ownership/UI 套件通过；full validation：format PASS、lint PASS（0 errors / 76 pre-existing warnings）、test PASS（三次连续运行最终 311/311 文件 / 6976 passed / 72 skipped / 0 failed，含 timing flakes 分类为 pre-existing）、typecheck PASS（node/web/aicore）、git-diff-check PASS；E2E 1/1 PASS（A-class `import-cherrystudio.spec.ts`，41.9s，Electron ABI 145，disposable profile，host ABI 137 已恢复；标准 E2E 覆盖 selecting-phase UI reachability，见 LOCK-DOC8；A-class 保持历史证据，closure 未重跑，LOCK-MD2；B-class `import-cherrystudio-genuine.spec.ts` 为独立 closure 证据，见「Phase 6 交付收尾」）；Group D/E 清理完成（C-9 有效保留/LOCK-6023；C-10 Phase 5.3 Done；C-11 Phase 5.3 移除；C-12 永久保留/LOCK-6024；C-13 Phase 5.3 移除）；stale contradictions 已移除；文档更新完成 |
| **2026-07-31** | **决策** | Q-6 Resolved（LOCK-6024：agents.db 永久保留，Phase 6 不自动删除/不提示删除） |
| **2026-07-31** | **Phase 6** | **Done（实现 + 验证完成）**。Phase 6 拆为 6.0（L2/L3 架构决策）、6.1（L2 产品合同）、6.2（L3 适配 + v7 metadata）、6.3（安全/可靠性加固）、6.4（验证门/清理/文档）。Phase 6 Decision Locks：LOCK-6001…6036 全落地。Phase 4 全部 LOCK-44xx 与 Phase 5 全部 LOCK-51xx 继续有效 |
| **2026-07-31** | **Phase 6 交付收尾（closure）** | **本地 closure 完成（Done）**：B-class `import-cherrystudio-genuine.spec.ts` 1/1 PASS（fresh ABI145 build 后精确标准 Playwright 命令；host ABI137 恢复）；A-class 未重跑（历史证据，LOCK-MD2）；六个交付阻塞项修复（LOCK-MD5）；本地 gates 全 PASS（CI=true lint 0 errors；CI=true test 312 文件 / 7009 通过 / 72 跳过 / 0 失败，LOCK-MD6）；C-4/C-5/C-7 parked（LOCK-MD7）；独立 artifact audit pass-with-nonblocking；**push/remote CI 事实（LOCK-MD8，post-push 填写）**——分支已推送（remote SHA `89803503fc...`，upstream `origin/jorkey/refactor/sqlite-migration` 建立）；GitHub Actions runs for this branch = 0（**未运行/无 run**，非失败、非 green CI）；ci.yml push trigger 仅 `main`/`v1`、无 PR、无手动 dispatch；no-console baseline 注释为 resolved（LOCK-MD9） |
| **2026-08-01** | **Post-closure 发现：L2 dev-origin 兼容性缺口** | Phase 6 closure 后发现 L2 导入管线 dev-origin 兼容性缺口：Cherry Studio ZIP 从 electron-vite dev 模式生成时 IndexedDB 为 `http_localhost_5173.indexeddb.leveldb`（dev origin）；ZIP intake（R-12）正确接受，但隔离 import renderer 固定通过 `file://` 协议加载，Chromium 将 `file://` origin 映射为 `file__0.indexeddb.leveldb`，discovery 失败（`[DISCOVERY_FAILED] CherryStudio database not found in isolated IndexedDB`）。failure 发生在 candidate DB 初始化/promotion 之前，live chat.db 不受影响。Phase 0–6 Done 状态不变；此为 closure 后兼容性修正项，非 Phase 7。B-class E2E 使用 production-format fixture（`file__0`），不受影响 |
| **2026-08-02** | **Post-closure L2 dev-origin 兼容性实现完成（LOCK-DEV-1…8）** | 精确 `http://localhost:5173` dev-origin 已在 L2 导入管线中实现。Chromium 41.2.1 自然将精确 `http://localhost:5173` 映射为 `IndexedDB/http_localhost_5173.indexeddb.leveldb`，与 `file://` origin 隔离。Trusted URL 为 app-owned exact constant（`http://localhost:5173/src/windows/chatImport/chatImport.html`，LOCK-DEV-1）。Main intake 分类精确 file__0/dev 映射并在 IPC/窗口/candidate 之前拒绝不支持/歧义/多个 origin（LOCK-DEV-3）。Renderer 验证精确 dev origin/path/no-search/no-hash；最终验证重构 application-owned exact URL fields（LOCK-DEV-4…5）。Pipeline/state/cancel/promotion 语义不变。Real Chromium E2E fixture 自然生成无需 rename（LOCK-DEV-6）。Dev E2E PASS 1/1 51.2s；genuine file-origin PASS 1/1 53.4s；state chain discovering→candidate-ready→verified-candidate→promoting→finalizing；4 records；original exit/relaunch exact cleanup。Fresh build pass；Electron ABI145 proven；host restored Node v24.12.0 ABI137（LOCK-DEV-7…8）。Focused main 82 files/2309 pass/72 skip。Phase 0–6 Done 状态不变；非 Phase 7。文档更新：top-level 状态注释、A-8 Origin 支持边界、Phase 4.1 Origin 支持边界、post-closure section 转为实现记录、LOCK-DEV-1…8 决策锁 |
| **2026-08-02** | **Post-closure L2 explicit-undefined JSON wire 兼容性修复完成（LOCK-N2/N3/N5/N6/N8/N11 + LOCK-C2/C3/C4 + LOCK-F2/F3）** | 原始真实 dev-origin ZIP 首次导入在 candidate init 后因 `topics[0].messages[0].mentions` 显式 `undefined` 失败（upgradeToV7 structured-clone 行形态）；Chromium IndexedDB structured clone 保留显式 undefined own-properties，JSON wire 不允许 undefined。修复：依赖中立 renderer 工具 `src/renderer/src/utils/jsonWire.ts`（`cloneForWire`，LOCK-N2/N3），`SqliteMessageDataSource` 复用（LOCK-N5），import 页行在 `entryPoint.ts` `handleReadPage` 于 `toArray()` 后、IPC 前归一化（LOCK-N6）；Main/shared validators 未改。自动化验证（fresh Electron ABI145 build）：dev-origin E2E 1/1 PASS 55.6s；genuine file-origin E2E 1/1 PASS 51.8s（origin 非回归）；13/13 explicit undefined own-properties 经真实 Chromium IndexedDB readback 存活（hasOwnProperty/valueIsUndefined 均 true，LOCK-N8/N11/F2/F3）；两 flow 均达 candidate-ready→verified-candidate→promoting→finalizing；original exited；live DB 含 source 非 baseline、rollback snapshot 含 baseline 非 source；promotion artifacts/processes/ports/workspaces 已清理；host ABI137 恢复。独立审计 pass。**原始真实用户 ZIP 为历史失败点（explicit undefined 为失败链第 ① 步）；当时尚未重跑——该「不得声称成功」语句为 chronology，已由「原始真实 ZIP 重跑 PASS（2026-08-02）」条目履行**；全量最终验证完成（Node v24.12.0 ABI137 / pnpm 10.27.0）：`pnpm format` exit 0（1803 files，4 个预期文件首次 pass 被格式化、二次 pass clean）；`CI=true pnpm lint` exit 0 / 0 errors / 76 oxlint + 4 ESLint pre-existing warnings / node/web/aicore typecheck + i18n 通过；最终有效 `CI=true pnpm test` exit 0 / 318 files / 7148 passed / 72 skipped / 0 failed / 309.41s（初始全量 run 的单一 parseDataUrl <10ms timing failure 经 focused rerun 确认 flaky、由最终 clean 全量 run 取代）。Phase 0–6 Done 状态不变；非 Phase 7。文档更新：top-level 状态注释、post-closure section 新增本修复记录、LOCK-N2/N3/N5/N6/N8/N11 + LOCK-C2/C3/C4 + LOCK-F2/F3 决策锁 |
| **2026-08-02** | **Post-closure L2 遗留 Dexie 嵌入消息 topicId 归属规范化完成（LOCK-OWN-1/2）** | `importDataPlane.ts::projectTopicsPage` 保留 `requireNonEmptyString` 前置校验；仅对「有效非空字符串但与外层 `topic.id` 不一致」的嵌入 `message.topicId` 计数并规范化：`wireToMessage` 后始终投影外层 topicId（LOCK-OWN-1：外层 Topic 包含关系权威；消息不移动到其声称的 topic；原始 JsonObject 不突变）。缺失/空/类型非法与全部其他 ownership 校验（重复 ID、block owner、segment membership、file-reference）保持严格。Main-only `DataPlaneNormalizationStats.topicIdNormalizationCount` 快照访问器 + StagedPage delta 事务性合并（LOCK-D9 语义：回滚/拒绝页不泄漏；finalize 后稳定）；编排器 finalize 后恰好一次 count-only `logger.warn`（LOCK-OWN-2：无 ID/内容/路径/源值）。shared DTO 未扩展、Main/shared 全局校验未放宽。只读诊断：25 topics / 107 messages，恰好 2 条有效字符串不一致、0 缺失/空/非法、无重复 message ID（LOCK-OWN-3：仅计数与无重复事实，无完整 ID）。**原始真实 ZIP ownership 失败为历史事实（chronology）；LOCK-OWN-3 已由「原始真实 ZIP 重跑 PASS（2026-08-02）」条目履行——harness 重跑 PASS 1/1（38.9s，fresh ABI145 build），topicId normalized 2**。聚焦验证：importDataPlane / index（loggerService mock）/ candidateVerifier 全链集成 / verificationBenchmark 10k 回归 / Main typecheck / 聚焦 lint+format+git-diff 全 PASS；`native:check:electron` PASS（ABI 145，binding hash 不变，未 rebuild）；未 commit / 未 push（当日快照；当前三分类见 §17 远程 CI 行）。文档更新：top-level 状态注释、post-closure section 新增本实现记录、LOCK-OWN-1/2/3 决策锁 |
| **2026-08-02** | **Post-closure L2 不可达孤儿 block 规范化完成（LOCK-BLOCK-1/2/3）** | `importDataPlane.ts::projectBlocksPage` 在**源投影边界**跳过不可达孤儿 `message_blocks` 行——当且仅当 (a) block id 不在任何导入 message.blocks[] 注册表（`blockOwnerById` 无 owner）且 (b) 声称的 `messageId` 不在任何导入消息（`messageTopicById` 无该 message）。**跳过发生在投影时，从不写后删除**；被跳过行不产生 MessageBlockData / file references / manifest 行 / writer 插入 / seen 标记。声称已存在 message 的未引用行仍严格 `OWNERSHIP_MISMATCH`；引用 owner 不匹配、重复 source block id（含被跳过孤儿，页内/跨页，经事务性 `sourceSeenBlockIds` registry）、cross-message 引用、finalize `MISSING_BLOCKS` 全部保持严格。Main-only `DataPlaneNormalizationStats.unreachableBlockSkipCount` 快照访问器 + StagedPage delta 事务性合并（LOCK-D9 语义：回滚/拒绝页不泄漏、source-seen 不污染）；编排器 finalize 后恰好一次 count-only `logger.warn`（LOCK-BLOCK-2：每非零类别一条或两类别合并一条；仅 session 上下文 + 聚合计数，无 ID/内容/路径/源值）。`SourceReadStats.blockRecordCount` 保持 125（源行分页）；`CandidateImportStats.blockCount` / import manifest / block hashes 保持 120（reachable-only；manifest 与 verifier 自动 reachable-only 因跳过行从不 staging）。shared DTO 未扩展、无 archive/schema 变更。只读诊断精确聚合：25 topics / 107 messages；嵌入引用 120 不同 id；源行 125；120 引用各恰好一次且 messageId 匹配；**5 未引用孤儿全部声称不存在 messageId**；0 无效/重复/wrong-owner/multi-message/缺失引用。**原始真实 ZIP 失败链（explicit undefined → false shared-ref cycle → topicId mismatch → 孤儿 block 严格拒绝 → approved canonicalizations）为历史事实（chronology）；LOCK-BLOCK-3 已由「原始真实 ZIP 重跑 PASS（2026-08-02）」条目履行——harness 重跑 PASS 1/1（38.9s，fresh ABI145 build），source 125 / skipped 5 / candidate 120**。聚焦验证：importDataPlane（125/120/5 fixture、严格矩阵、回滚事务性）/ index（loggerService mock：skip-only 与合并 warning）/ candidateVerifier 全链集成 13 维度 / verificationBenchmark + importBenchmark 10k 回归 / Main typecheck / 聚焦 lint+format+git-diff 全 PASS；`native:check:electron` PASS（ABI 145，binding hash 不变，未 rebuild）；未 commit / 未 push（当日快照；当前三分类见 §17 远程 CI 行）。文档更新：top-level 状态注释、post-closure section 新增本实现记录、LOCK-BLOCK-1/2/3 决策锁、LOCK-OWN-3 失败链更新 |
| **2026-08-02** | **原始真实 ZIP 重跑 PASS（LOCK-OWN-3 / LOCK-BLOCK-3 履行，definitive evidence）** | 原始真实用户 ZIP 经导入 harness 在 fresh Electron ABI145 build 后重跑 **PASS 1/1（38.9s）**。ZIP 以隐私安全角色描述（不记录绝对用户路径）；不可变证据：size 1056109、mtime/inode/mode 不变（MD5 一致）。status chain discovering→candidate-ready→verified-candidate→promoting→finalizing；candidate/live 计数 topics 25 / messages 107 / blocks 120 / segments 6 / memberships 16 / fileRefs 4；source blocks 125 / skipped 5（不可达孤儿）；topicId normalized 2；**恰好一条合并 count-only warning（topicId 2 + 孤儿跳过 5）**；original PID exit / relaunch exact-token 清理；`integrity_check` ok / `foreign_key_check` 空；无 orphan parent / 重复 / cross-topic 链接；snapshot（topics 2 / messages 1 / blocks 1）保留 baseline、排除导入源；journals/staging 无残留；candidate shells 空；ZIP / binding（ABI 145，hash `48191d9b…`）/ git 全部未变。历史失败链以 PASS 终结：explicit undefined → false shared-ref cycle → topicId mismatch → orphan block strict rejection → approved canonicalizations → **PASS**。LOCK-OWN-3 / LOCK-BLOCK-3 及 explicit-undefined「未重跑/不得声称成功」残余仅对本 artifact 履行；strict residuals（缺失/空/非法 topicId、未引用+已存在 message 行、owner 不匹配、重复 id 含孤儿、finalize 缺失引用 block）保持严格；canonicalization 仅限 L2 导入管线（LOCK-6001/6002/6023 不变）。**无远程 CI 声明；未 commit / 未 push（当日快照；当前三分类见 §17 远程 CI 行）**。文档更新：top-level 状态注释、LOCK-OWN/LOCK-BLOCK/explicit-undefined post-closure 小节残余与最终验证证据、§17 关闭证据、决策日志 |
| **2026-08-03** | **最终交付验证（latest-source authoritative closure，active final）** | 在最新源上完成最终交付验证：`pnpm native:rebuild:node` exit 0 + 独立 Node ABI137 SQL PASS；`pnpm format` exit 0 无改动；`CI=true pnpm lint` exit 0 / 0 errors / 76 oxlint + 4 ESLint pre-existing warnings / node/web/aicore typecheck + i18n 通过；`CI=true pnpm test` exit 0 / **319 files / 7274 passed** / 72 skipped / 0 failed / 449.99s（active final closure；2026-08-02 explicit-undefined 318/7148 与 staged-validation 319/7230 保持为历史计数，时间顺序保留）；`pnpm native:rebuild:electron` exit 0 + 独立 Electron 41.2.1 ABI145 SQL PASS；`pnpm build` exit 0 / built 9.02s；标准 E2E：ordinary-chat 1/1 37.5s / genuine 1/1 67.5s / dev-origin 1/1 59.7s；原始真实 ZIP harness latest build PASS 1/1 **41.9s**（candidate/live 25/107/120/6/16/4；topicId normalized 2 / orphan skipped 5 / 恰好一条合并 count-only warning；integrity/FK/snapshot/relaunch/cleanup PASS；ZIP 未变；final ABI145 hash `48191d9b…`）；最终 node_modules 状态 Electron ABI145；远程 CI 三分类无变化（无新 commit/push/PR 声明）。仅更新本文档（docs-only）；未 commit / 未 push。文档更新：§17 最终交付验证（2026-08-03）active closure 表 + 历史计数/定时区分、top-level 状态注释 |
| **2026-08-04** | **Post-closure L2 产品闭环最终实现完成（Done，docs-only）** | 确定性消息身份（精确真实 artifact 129150 全出现零碰撞；`(outerTopicId, legacyMessageId)` tuple + `cherry-chat:l2-message-id` 帧 → `l2m1:` + 64 lowercase SHA256；顺序无关；同 topic askId 重映射、16 dangling askId 保留原值碰撞防护）、规范化残余（segments 2 rows/4 memberships、unembedded block 1、六类 exact-once count-only）、L2/fetch 大块边界（8MiB/16MiB/64MiB/depth20/array100k；3 >1MiB 行 max ~2.67MB）、candidate-only FTS 原子重建（14 维 verifier、~103ms/page、rebuild ~85ms @10k）、导入回收站五天保留（2707/2704/3）、post-close helper/observer test-only 硬化、导航/投影/重启/选择性 ZIP 合同保持且最终合成 E2E 通过。验证：Node **latest-source**（Node24.12 ABI137）**335 files（1 skipped）/ 7901 tests passed / 75 skipped / 0 failed**（user-source 7890/74 为 helper/privacy docs 前历史证据）；Electron 精确真实 spec 1/1 6m48s 候选 2707/129150/158441/13/39/4158、全链 promoted、integrity/FK/six counts/snapshot/14 dims/projection/UI/reload PASS、ZIP 指纹不变（size 1393936335、SHA locked、inode/mode/mtime 不变）、final ABI145。实现与 E2E 已本地提交（`26c7190333` feat(import)：complete L2 Cherry Studio migration flow / `1c2c70a3dd` test(import)：add end-to-end migration coverage）；本文档收尾提交（本节文档收尾提交，哈希见当前 git history）后 HEAD = 本节文档收尾提交、远程 tip `3a64da6020` 不变、本地 ahead 11（pre-existing 8 + 本次 closure 3）、工作树 clean；无 push/PR、远程 CI 无新 run（LOCK-GIT）。文档更新：top-level 状态注释与最后更新、三分类 provenance、新增 post-closure L2 产品闭环小节、§17 最终交付验证（2026-08-04）、决策日志 |

---

## 16. 代码证据索引

### 当前活跃资产

| 路径 | 说明 |
|---|---|
| `src/renderer/src/databases/index.ts` | Dexie `CherryStudio` 数据库定义，所有表结构 |
| `src/renderer/src/databases/upgrades.ts` | Dexie schema 升级函数 |
| `src/renderer/src/services/db/DbService.ts` | DbService facade，Phase 5.3 后直连 SQLite（无路由策略注入、无 Dexie 路由） |
| `src/renderer/src/services/db/AgentMessageDataSource.ts` | Agent 数据源 stub（no-op） |
| `src/renderer/src/services/db/types.ts` | MessageDataSource 接口 + agent topic ID 工具函数 |
| `src/renderer/src/services/db/README.md` | 过时文档，描述不存在的 Agent IPC 实现 |
| `src/main/services/memory/MemoryService.ts` | Memory `memories.db`，直接 `@libsql/client` |
| `src/main/services/KnowledgeService.ts` | Knowledge `KnowledgeBase/*`，`embedjs-libsql` |
| `src/main/services/BackupManager.ts` | 备份/恢复，直接复制 Data 目录 |
| `src/main/index.ts:240` | `will-quit` handler，未调用 Memory/Knowledge close |
| `package.json:35-38` | 失效 `agents:*` scripts |
| `package.json:308-309` | 残留 `drizzle-kit`/`drizzle-orm` 依赖 |
| `packages/shared/IpcChannel.ts` | ChatDb enum entries（14 channels） |
| `packages/shared/chatDb/types.ts` | JSON wire primitives、result envelope、request/response DTOs、command map |
| `packages/shared/chatDb/result.ts` | ok/fail constructors、isSuccess/isFailure type guards、error code constants |
| `packages/shared/chatDb/validation.ts` | Runtime JSON validator（depth limit、type rejection、request/field/array validators） |
| `packages/shared/chatDb/contracts.ts` | Channel→contract registry（allowedKeys + validate per command） |
| `packages/shared/chatDb/index.ts` | Barrel export for chatDb shared domain |
| `packages/shared/chatDb/__tests__/validation.test.ts` | 99 tests: JSON primitives, composites, depth limit, result envelope |
| `packages/shared/chatDb/__tests__/contracts.test.ts` | 100 tests: registry completeness, valid/invalid payloads, JSON round-trip |
| `src/main/services/chatDb/ChatDbAggregateService.ts` | 14-command aggregate service combining five Phase 2 repositories |
| `src/main/services/chatDb/repository/factory.ts` | Repository factory binding all five repos to root DB or transaction executor |
| `src/main/services/chatDb/wireAdapters.ts` | Wire ↔ Domain adapters (JSON ↔ persistence DTOs, tool-object content, file refs, relational blocks) |
| `src/main/services/chatDb/errors.ts` | Structured error mapping (9 error categories → shared codes + retryable semantics) |
| `src/main/services/chatDb/ipc.ts` | 14 fixed IPC handler registration with request/result validation and error mapping |
| `src/main/services/chatDb/__tests__/aggregate.test.ts` | 60 tests: all 14 commands, transaction rollback, ordering, file refs |
| `src/main/services/chatDb/__tests__/wireAdapters.test.ts` | 29 tests: wire ↔ domain round-trip, tool content, file refs, nullable semantics, structured model |
| `src/main/services/chatDb/__tests__/ipc.test.ts` | 27 tests: 14 handlers, validation, identity rejection, error mapping, disposer |
| `src/preload/index.ts` | Preload bridge: `window.api.chatDb` with 14 named IPC methods (ChatDb_FetchMessages etc.) |
| `src/renderer/src/services/db/SqliteMessageDataSource.ts` | Renderer SqliteMessageDataSource: ChatDbApi interface, ChatDbResultError, cloneForWire, 14 methods, updateTopicUpdatedAt dispatch |
| `src/renderer/src/services/db/__tests__/SqliteMessageDataSource.test.ts` | 66 tests: method mapping, forceReload omission, null→undefined, insertIndex, JSON boundary, unsupported types, ChatDbResultError, transport errors, no retry, dispatch parity, no file-count methods |
| `src/renderer/src/services/db/__tests__/DbService.test.ts` | 102 tests: dexie/sqlite-validation routing (14 ops each), lazy factory, agent routing (20 ops), block partitioning, file ops always Dexie, getSourceType, error propagation, no readiness probes, no mutable API, argument preservation |

### 历史路径（已不存在）

| 路径 | 说明 |
|---|---|
| `src/main/services/agents/` | 已删除的 agents SQLite 子系统目录 |
| `src/main/services/agents/drizzle.config.ts` | agents drizzle 配置（scripts 引用但不存在） |
| `Data/agents.db` | 用户设备上可能遗留的 agents 数据库文件 |

### Phase 4 实现区域（实际已创建 / 规划）

| 区域 | 实际/预期路径 | 说明 |
|---|---|---|
| ZIP intake + extract | `src/main/services/chatDbImport/`（zipIntake/tempWorkspace，Phase 4.1 已创建） | 安全解压、IndexedDB 结构校验、临时工作区管理 |
| Isolated session/profile | `src/main/services/chatDbImport/isolatedSession.ts`（Phase 4.1 已创建） | `session.fromPath(absolutePath, { cache: false })` / isolated profile + origin 创建 |
| Import renderer | `src/renderer/src/windows/chatImport/`（Phase 4.1 已创建） | 隐藏 sandboxed renderer，当前 Dexie schema against isolated profile |
| Import IPC | `packages/shared/chatImport/`（Phase 4.1 已创建，ChatImport_* 6 channels） | 窄 import-only IPC channels；`packages/shared/IpcChannel.ts` 已登记 |
| Candidate DB resource | `src/main/services/chatDbImport/CandidateDbResource`（Phase 4.2 已创建） | per-session 自有候选目录，内含独立候选 `chat.db` |
| Import data plane | `src/main/services/chatDbImport/ChatImportDataPlane`（Phase 4.2 已创建） | Main 侧分页数据面，承载 `SourceReadStats`；Main page 背压驱动 |
| Import writer | `src/main/services/chatDbImport/ChatImportWriter`（Phase 4.2 已创建） | import-only 保序 writer（order-preserving），每页一事务，`candidate-ready` exact-once；`CandidateImportStats` |
| Startup recovery | `src/main/services/chatDbImport/startupRecovery`（Phase 4.2 已创建；Phase 4.4.1 扩展；Phase 4.4.3 re-export gate API） | 取消/错误/孤儿候选目录确定性清理；Phase 4.4.1 扩展为读取 promotion journal、保护 journal-referenced 候选（排除年龄清理）、按 4.4.0 恢复矩阵安全分类中断 promotion 资产（LOCK-4414）；Phase 4.4.3 re-export `runStartupRecoveryGate` + `StartupRecoveryGateResult` |
| Verification | `src/main/services/chatDb/import/`（CandidateVerifier / SourceVerificationManifest / VerificationReport，Phase 4.3 已创建） | 只读 13 维度验证；manifest 按页事务后落盘 + stable canonical SHA-256；有界安全诊断；会话状态机 candidate-ready→verifying→verified-candidate\|verification-failed；close-before-discard |
| Promotion protocol foundations | `src/main/services/chatDbImport/promotion/`（protocol/journal/recovery，Phase 4.4.0 已创建；Phase 4.4.1 新增 journalStore 落盘；Phase 4.4.2 加严 transition；Phase 4.4.3 新增 artifactProbe/gate/recoveryExecutor/rollback/relaunch + cleanup APIs） | 纯协议层：promotion 状态/exact-once claim、journal v1 严格 codec、确定性恢复矩阵；Phase 4.4.1 新增独立 `journalStore.ts` crash-safe 落盘 writer；Phase 4.4.2 受门控 phase transition API；Phase 4.4.3 新增 5 个模块（artifactProbe/gate/recoveryExecutor/rollback/relaunch）+ journal cleanup APIs + `validateClosedLiveProof` extracted from install.ts |
| Maintenance coordination contract | `src/main/services/chatDb/maintenanceCoordination.ts`（Phase 4.4.0 已创建；Phase 4.4.1 接线；Phase 4.4.2 扩展验证缝） | backup/restore/promotion/init/close 统一互斥 lease 契约（LOCK-4402）；Phase 4.4.1 将 promotion 实际接入既有互斥协调；Phase 4.4.2 新增 `validatePromotionAuthorization` 验证缝 + `ChatDbService.closeForPromotion/reopenForPromotion`；Phase 4.4.3 recovery executor 通过此 API 获取 fresh promotion lease（restart path） |
| Atomic promotion executor | `src/main/services/chatDbImport/promotion/`（Phase 4.4.1 交付 Durable Preparation Gate；Phase 4.4.2 交付破坏性执行；Phase 4.4.3 交付恢复/终结管线） | Phase 4.4.1：rollback 快照创建 + journal `snapshot-ready` + exact-once prepared handle + 非破坏性边界。Phase 4.4.2：execution/install/replacementVerifier/readonlyDbValidation，止于 durable `replacement-verified` handoff。**Phase 4.4.3**：`recoveryExecutor.ts`（7 subphases 编排 four actions + authorization resolution + abort）、`rollback.ts`（staging clone + atomic rename restore）、`relaunch.ts`（exact-once receipt-gated）、`gate.ts`（startup recovery gate，absent-journal fast path）、`artifactProbe.ts`（只读磁盘 truth 等价探测）、`journalStore.ts` cleanup APIs（phase-gated idempotent removal）。四动作全部落地：keep-old-live / accept-verified-replacement / restore-rollback-snapshot / repair-required |

### 已废弃/待移除路径

| 路径 | 状态 | 说明 |
|---|---|---|
| `src/renderer/src/services/db/routingPolicy.ts` | **Phase 5.3 已移除（C-13）** | 临时验证用路由策略注入，Phase 5.3 权威切换时删除 |
| `src/renderer/src/services/db/DexieMessageDataSource.ts` | **Phase 5.3 从普通路径移除（C-11）** | 仅保留于隔离 import renderer 内部 |

---

## 17. 原生 ABI 管理契约（post-closure，2026-08-02）

> **定位**：Phase 6 closure 与 L2 explicit-undefined 修复之后实现（2026-08-02）的**仓库级原生 ABI 管理工具化**：把单一 better-sqlite3 binding 的 Node ABI137 ↔ Electron ABI145 状态变为显式、确定性、由真实运行时 SQL 验证、并在工作流边界 fail-fast。**不是 Phase 7**，不重开 Phase 0–6。Phase 0–6 Done 状态不变。

### 单一 binding 限制（LOCK-ABI-1 / LOCK-ABI-9）

仓库只有**一个** native module：`better-sqlite3@12.11.1`。它的编译产物在同一时刻只可能是 **Node24 ABI 137** 或 **Electron 41.2.1 ABI 145** 之一，不可能同时满足两者。因此：

- Node 单元测试/typecheck/format/lint 全量 gates 需要 **Node ABI137** binding；
- `pnpm dev` 与 Playwright E2E 需要 **Electron ABI145** binding；
- **运行时 lane 契约（LOCK-ABI-3）**：canonical Node/Electron 命令自我确保所在 lane——先只读 probe binding，仅当真实运行时 SQL probe 证明不匹配时才 rebuild；无需手工 `native:check:*` / `native:rebuild:*` 顺序即可到达 lane 状态（旧「切换只能通过显式命令 / preflight 永不自动 rebuild」表述已被该自我确保语义取代）。`native:check:*` 为只读诊断；`native:rebuild:*` 仅为异常修复/调试。

### 命令面（`scripts/native-abi/`）

| 命令 | 行为 |
|---|---|
| `pnpm native:check:node` | 只读；要求当前 Node ≥24.11.1 且 ABI137；校验 resolved better-sqlite3 **精确 12.11.1**；打印 runtime name/version/ABI/platform/arch、better-sqlite3 package realpath、实际 resolved binding path（`compiled/<node runtime version>/…` 候选使用目标 runtime 的 Node 版本，非 package 版本）；真实 `Database(':memory:')` + `select 1 as ok` + close；失败给出修复或依赖 remediation |
| `pnpm native:check:electron` | 只读；要求 darwin arm64 或 win32 x64 + Electron 精确 41.2.1 + ABI145；校验 resolved better-sqlite3 精确 12.11.1；通过 `ELECTRON_RUN_AS_NODE=1` 以安装的 Electron 可执行文件运行仓库自有 probe（`scripts/native-abi/probe.cjs`），保留 child stdout/stderr 与 exit code，失败时仍报告 probe 运行时事实与 resolved binding path。**LOCK-ABI-2 加固**：probe 生产模式硬编码 resolved `better-sqlite3` 模块合同（`NATIVE_ABI_PROBE_MODULE` 仅在该探针的显式 test-seam gate 下生效），且 `spawnElectronProbe` 在 spawn 前**显式删除** `NATIVE_ABI_PROBE_MODULE` 与 test-seam 变量——继承的恶意环境无法重定向真实运行时 SQL 证明 |
| `pnpm native:rebuild:node` | 显式 node-gyp source build（仅 better-sqlite3 realpath，`--nodedir` 指向已验证 Node 的头文件，`nodeDirFromExecPath` 必须证明 `<prefix>/include/node/node.h` 存在——缺失时在 spawn 子进程前以精确错误 fail precondition，绝不 fallback）；**child env 已 sanitize（LOCK-ABI-5/7）**：剥离全部 target-affecting npm/node-gyp 变量（runtime/target/target_arch/arch/dist_url/nodedir/devdir/electron_version/build_from_source 及大小写 `npm_config`/`NPM_CONFIG` 变体）并显式注入已验证 arch/platform/`--arch`/`--nodedir`/`--platform` 受控参数，保留 proxy/compiler 变量；前置校验 Node/ABI/execPath/pnpm10.27.0/PATH + 依赖版本精确 12.11.1；自动执行 `native:check:node` 并失败即停；清理（marker/stale bin）失败使 rebuild 结果 FAIL（不吞错） |
| `pnpm native:rebuild:electron` | 显式 `@electron/rebuild` API（`force=true`、`buildFromSource=true`、`onlyModules=['better-sqlite3']`、sequential、显式 resolved buildPath/projectRootPath）；前置校验同上 + darwin arm64 或 win32 x64 + Electron 41.2.1；自动执行 `native:check:electron` 并失败即停 |

### 依赖版本强制（LOCK-ABI finding A）

`check` 与 `rebuild` 都在准备阶段校验 resolved `better-sqlite3` 版本**精确等于**锁定常量 `12.11.1`（与 `package.json`/`pnpm-lock.yaml` 的 exact pin 一致）。版本不匹配时：

- 以**依赖 remediation** 失败（`package.json` 精确 pin + 重新 `pnpm install`），**绝不声称 native rebuild 可以修复**依赖版本不匹配（`repair:` 不会打印 rebuild 命令）；
- `rebuild` 在任何构建动作前 fail-fast，不触碰 marker/binding。

### 验证只认真实运行时 SQL（LOCK-ABI-2）

成功仅由目标 runtime **实际创建** `Database(':memory:')`、执行 `select 1 as ok`、关闭数据库证明。`.forge-meta` 标记、目录/文件名**永不**作为成功证据。checks 完全不读 marker（报告固定 `marker: ignored`）。

Probe 诚实性（finding D）：Node 与 Electron probe 均在 `finally` 中关闭已打开的 `Database`（错误路径不泄漏）；SQL 结果不为 `ok:1` 时 child 输出 `ok:false`/`sqlOk:false` 并**非零退出**（绝不 `ok:true`/exit 0）；主要错误与 close 错误都保留在输出中。

诊断可见性（finding H，2026-08-02 修正后）：check 报告结构化保留并格式化显示 probe close 错误（`probe close:`，Node 与 Electron 均**叠加**在主错误之上、不覆盖主错误）与 Electron child 退出码（`probe exit:`）；Electron 失败详情恒包含显式 `Probe exit code: N` 行与 `Electron probe close error: …` 行（不只在自由文本中埋没）。

### Marker 安全（LOCK-ABI-6，finding C）

- rebuild 前捕获 marker 状态并报告（before-state 保留）；
- rebuild 失败或自动 post-check 失败 ⇒ 移除任何可能宣称成功的 `.forge-meta`；**移除失败作为可观测错误保留在报告中**（绝不吞错），rebuild 结果恒为 FAIL；
- 成功路径上的 stale marker / stale `bin/darwin-arm64-*` 清理失败同样使 rebuild FAIL；**可选 stale 目录不存在不是错误**（不因缺席误失败）；
- **目录枚举失败（finding H，2026-08-02 修正后）**：`listDir` 将 ENOENT（可选目录缺失）视为空目录，但 **EACCES 等其他枚举错误是可观测失败**——marker build 目录枚举失败使 rebuild 在任何构建动作前 fail-fast（`marker enumeration failed`），stale `bin/` 目录枚举失败使成功 rebuild 结果转为 FAIL（`post-rebuild cleanup failed`），绝不把枚举失败误当作空目录后报告成功；
- 工具从不手工写成功 marker；成功的 Electron rebuild 可能留下 tool-written marker，但文档声明其**非权威**（non-authoritative）；
- 成功 Node rebuild 会移除 stale Electron marker 与 stale `bin/darwin-arm64-145/` 拷贝，避免误导性状态。

### 运行时 lane 契约（canonical 命令自我确保，2026-08-10 更新）

canonical Node/Electron 命令按 **lane 运行时契约** 运行：每个命令自我确保所在
lane，不再需要任何手工 `native:check:*` / `native:rebuild:*` 顺序（旧的 preflight
调用图与手工 Node→Electron rebuild 顺序已被自我确保语义取代，finding F/G 的
「preflight 一次」表述不再适用）：

- **canonical lane 命令自我确保所在 lane**：每个命令先只读 probe binding，仅当
  真实 SQL probe 证明不匹配时才 rebuild。Node-lane（ABI137）：`pnpm test`、
  `test:*`、`test:coverage`、`test:ui`、`test:watch`、`bench:*`、`ci:test-check`；
  Electron-lane（ABI145）：`pnpm dev`、`pnpm dev:watch`、`pnpm start`、
  `pnpm debug`、`pnpm build`、`build:*`、`analyze:*`、`pnpm test:e2e`；neutral
  （不进入 lane、永不切换 binding）：`pnpm lint`、`pnpm format`、`pnpm typecheck`、
  `i18n:*`、`openapi:check`、`skills:check`、`ci:basic-check`。
- **本地 Node-lane 之后恢复 Electron ABI145 默认；CI 跳过恢复**：本地 `pnpm test`
  结束后 binding 恢复为 Electron ABI145，下一个 dev/build/E2E 命令无需手工切换；
  CI 运行跳过恢复步骤。
- **并发按 checkout 串行化**：lane 命令持有 checkout 作用域锁；opposite-lane
  命令在锁被持有时 fail-fast 报冲突（等待该 lane 完成或改跑其命令），绝不在另一
  个运行者期间静默切换 lane。
- **check 只读诊断 / rebuild 例外修复**：`pnpm native:check:node` 与
  `pnpm native:check:electron` 仅用于检查/证明当前 binding 状态；`pnpm native:rebuild:*`
  是显式修复/调试工具、绝非常规工作流——lane 命令在自身 probe 失败时修复自己的
  lane。内部 `*:run` helper（`test:run`、`dev:run`、`build:run`、…）不是入口，
  一律使用 canonical 公开命令。
- **E2E 入口**：`pnpm test:e2e` 是唯一受支持的 Playwright 入口（Electron-lane，
  自我确保 ABI145）；scoped 运行 `pnpm test:e2e tests/e2e/specs/<spec>.spec.ts`
  （路径转发给 Playwright），`--` 后接 Playwright 选项（如 `pnpm test:e2e -- -g "…"`）。
  直接 `pnpm playwright test` 绕过 lane 管理，不受支持。
- 默认外层 shell 若为 Node22（ABI127），`native:check:node` 以清晰信息失败并给出
  修复命令——必须以受支持的 Node24 在 PATH 上运行。

### 最终状态报告

每个命令在 PASS/FAIL 时都打印 runtime name/version/ABI/platform/arch（Electron 附带 embedded Node 版本）、package realpath、实际 resolved binding path、SQL 验证结果、marker 状态（check 恒为 ignored）、以及失败时的精确修复命令或依赖 remediation；Electron check 在 probe 已执行时恒打印 `probe exit:` 行，probe 存在 close 错误时打印 `probe close:` 行（finding H）。

### 当前恢复证据（2026-08-02，修正阶段状态）

| 项 | 证据 |
|---|---|
| 实现时 binding | Electron ABI145（`build/Release/better_sqlite3.node` 与 `bin/darwin-arm64-145/better-sqlite3.node` SHA-256 均为 `48191d9b…`；`.forge-meta` = `arm64--145`） |
| `pnpm native:check:electron` | PASS（真实 Electron SQL probe；ABI 145；darwin/arm64；embedded Node 24.14.1） |
| `pnpm native:check:node`（Node22 shell） | FAIL（ABI 127 / 版本不足），输出 `pnpm native:rebuild:node` 修复命令——按设计 |
| `pnpm native:check:node`（Node24 + Electron binding） | FAIL（NODE_MODULE_VERSION 145 vs 137），输出修复命令——按设计 |
| 单元测试（scripts Vitest project） | 全部 PASS，全部注入 fakes + narrow 真实 subprocess probe 覆盖（stub module，ABI 无关），**未**触碰真实 binding；binding 前后哈希一致（read-only） |
| 静态检查 | `pnpm typecheck:node` PASS；oxlint/eslint/biome clean（仅改动的 ABI 文件）；`git diff --check` PASS |
| 依赖 pin | `package.json` `"better-sqlite3": "12.11.1"` exact；`pnpm-lock.yaml` importer specifier 同步 `12.11.1`（仅 importer 一行，resolution 不变）；binding 哈希未变 |

### 残余风险

| 风险 | 说明 |
|---|---|
| 平台范围 | Electron rebuild/check 当前支持 darwin arm64 与 win32 x64（LOCK-ABI-5）；其他平台按设计 fail 而非猜测 |
| Node 头文件 | Node rebuild **必须**以已验证 Node 的 `include/node`（`--nodedir`，`nodeDirFromExecPath` 证明 `<prefix>/include/node/node.h` 存在）构建；本地头文件缺失 ⇒ **在 spawn 任何子进程之前**以精确错误 fail precondition（绝不 fallback 到网络下载或继承的 `npm_config_nodedir`） |
| 单一 binding | 两个 runtime 共享一个 binding，任何时刻只能服务一个目标；这是 LOCK-ABI-9 接受的架构限制 |
| 全量 gates | 全量 `pnpm test`/lint/format 需在 Node ABI137 状态下运行（与既有 Phase 5.4/6 全量验证证据一致）；本实现阶段按要求未跑全量 gates |

### 最终分阶段验证 / 关闭证据（2026-08-02 追加，distinct staged-validation closure）

> **定位**：本小节是 §17 的**最终分阶段验证与关闭证据**（final staged validation / closure），**不重写**上述历史证据，也不重写第 15 节进度日志 / 顶部状态注释中的 explicit-undefined closure 计数（Node v24.12.0 ABI137：318 files / 7148 passed / 72 skipped / 0 failed，2026-08-02 当时）。此处按时间顺序**追加**最终分阶段验证事实，并记录 stale-bin 递归清理的边界加固（removeDir 与 removeFile 同契约）与关闭状态。下方表格为 **2026-08-02 staged-validation 历史证据**（其中 7230 计数、E2E 31.2s/53.5s/54.5s 与 ZIP 38.9s 均以日期限定为历史运行）；**当前有效最终计数 319 files / 7274 passed 与最新 E2E / ZIP 定时记录于本小节末尾「最终交付验证（2026-08-03）」**。仍**不是 Phase 7**；Phase 0–6 Done 状态不变。

| 项 | 最终事实 |
|---|---|
| **最终 binding 状态（最终验证）** | **Electron ABI145**：`build/Release/better_sqlite3.node` 与 `bin/darwin-arm64-145/better-sqlite3.node` SHA-256 **均为 `48191d9b…`**；`.forge-meta` = `arm64--145`；`native:check:electron` PASS（Electron 41.2.1 / embedded Node 24.14.1 / ABI 145 / darwin arm64 / 真实 SQL probe `Database(':memory:')`+`select 1 as ok`+close / probe exit 0 / marker ignored） |
| **Node 24.12.0 ABI137 rebuild** | exit 0；marker 零（无成功 marker 遗留）；`pnpm format` exit 0（1 个文件被修复，身份未指明）；`pnpm lint` exit 0（仅 pre-existing warnings） |
| **最终 clean 全量测试（2026-08-02 staged-validation，历史证据）** | 319 files / **7230 passed** / 72 skipped / 0 failed；active final closure 为 2026-08-03 的 319 files / **7274 passed**（见本小节末尾「最终交付验证（2026-08-03）」） |
| **Electron rebuild（ABI145 恢复）** | exit 0，`onlyModules=['better-sqlite3']`（仅 better-sqlite3 被重建）；随后 `native:check:electron` PASS（同上）；`pnpm build` PASS |
| **标准 disposable dev-origin E2E（2026-08-02 历史运行；fresh ABI145 production build、一次性 profile）** | **PASS**：`ordinary-chat.spec.ts` 1/1 31.2s；`import-cherrystudio-genuine.spec.ts` 1/1 53.5s；`import-cherrystudio-dev-origin.spec.ts` 1/1 54.5s，13 个显式 undefined properties 经真实 Chromium IndexedDB readback 存活；2026-08-03 latest 定时（37.5s / 67.5s / 59.7s）见本小节末尾「最终交付验证（2026-08-03）」 |
| **原始真实用户 dev ZIP（2026-08-02 历史 rerun；latest definitive 见 2026-08-03）** | **已重跑 PASS**（导入 harness 1/1，38.9s，fresh ABI145 build，2026-08-02 历史运行）；路径保持隐私安全角色描述（redact，不记录绝对用户路径）；不可变证据：size 1056109、mtime/inode/mode 不变（MD5 一致）；binding hash `48191d9b…` 前后一致、git 未变。此前「未搜索/未读取/未重跑」语句为该 ZIP 在 explicit-undefined closure 时的 chronology，已由本次重跑 PASS 履行（LOCK-OWN-3 / LOCK-BLOCK-3）；与 disposable E2E fixture 证据仍明确区分（fixture 为自动化兼容性证据，此为原始真实用户数据最终证明）。**最新 definitive rerun（2026-08-03，latest fresh ABI145 build）：PASS 1/1 41.9s，见本小节末尾「最终交付验证（2026-08-03）」** |
| **远程 CI** | **push 时序（三分类，明确区分）**：① **远程已推送 tip**：`3a64da6020`（2026-07-31 `docs(sqlite-migration): record push and workflow facts`，其父恰为 closure push 点 `89803503fc`——远程由 `89803503fc` 推进至 `3a64da6020` 仅因该 push-facts docs commit 被推送；LOCK-MD8 的 2026-07-31 post-push 历史事实保留，upstream `origin/jorkey/refactor/sqlite-migration` 已建立）；② **本地已提交、未推送**（`origin/jorkey/refactor/sqlite-migration`..HEAD 共 8 个 commit）：原 3 个 `1fc19f590c`（docs：post-closure L2 dev-origin 兼容性 findings）、`6b48d33e72`（fix(import)：精确 dev-origin 备份支持）、`6d2db496b1`（fix(import)：JSON wire undefined 归一化），加上本次新增 5 个 commit——`b23c4ff4cb`（feat(native)：ABI 管理工具化，含 `scripts/native-abi/`/CI workflow/依赖/CLAUDE.md）、`81a438b208`（fix(renderer)：JSON wire 共享引用）、`cbc19db426`（fix(import)：遗留 ownership 规范化）、`dbabae7eb8`（test(import)：规范化路径测试覆盖）、本 docs closure commit（`docs/sqlite-migration.md` + `tests/e2e/README.md`，无 SHA）；③ **工作树 clean**（本 docs closure commit 提交后无未提交内容）。对 ② 全部（8 个本地未推送 commit）**均无远程 CI run**（LOCK-MD8：GitHub Actions runs for this branch = 0；ci.yml push trigger 仅 `main`/`v1`；未创建 PR、未手动 dispatch）——不得对 ② 声称远程 CI 成功；本地 gates 证据如上 |
| **stale-bin 递归清理边界加固（本小节实现）** | `removeDir(p, boundary?)` 现在与 `removeFile` 同契约：parent 组件链（含 `bin` 组件本身）逐一 lstat/realpath 校验，必须落在 resolved package realpath 内；**symlinked `bin` 解析到包外、或 stale 条目是解析到包外的 symlink ⇒ 以可观测错误拒绝**，递归删除不可能经由包路径触及外部树；ENOENT/ENOTDIR 父组件 = 无操作；EACCES 等保留为可观测错误。真实文件系统测试：外部 symlink bin 拒绝、内部合法 stale 目录删除、`..` 路径逃逸拒绝、ENOENT 容忍、悬空 symlink unlink、权限失败可观测。`removeStaleBinDirs` 向 `removeDir` 传入 resolved `packagePath` 作为 boundary |

**锁契约补充（§17 关闭状态）**

- **LOCK-ABI-8（无 fail-soft / 无产品行为掩盖）**：所有清理/边界失败均为**可观测错误**，使 rebuild 结果 FAIL（finding C/H）——绝不静默吞错、绝不弱化产品逻辑。`ChatDbService` fail-soft / chat 逻辑**未修改**（LOCK-ABI-8 保持；本次仅触及 `scripts/native-abi/` 与文档）。
- **LOCK-ABI-10（用户批准 commit 已执行；仍无 push / PR）**：用户明确批准后，ABI/import/jsonWire/test 累积已本地提交（`b23c4ff4cb` / `81a438b208` / `cbc19db426` / `dbabae7eb8`），本 docs closure 为最后本地 commit——全部**不 push、不创建 PR**。与既有 LOCK-MD8 的 push 时序一致且无歧义：① **远程已推送 tip** `3a64da6020`（2026-07-31 push-facts docs commit，其父为 closure push 点 `89803503fc`）不变；② **本地已提交、未推送** 共 8 个 commit（原 `1fc19f590c` / `6b48d33e72` / `6d2db496b1` + 新增 `b23c4ff4cb`（feat(native)）/ `81a438b208`（fix(renderer)）/ `cbc19db426`（fix(import)）/ `dbabae7eb8`（test(import)）/ 本 docs closure commit（无 SHA））；③ 本 docs closure commit 提交后**工作树 clean**。全部本地未推送 commit 的 GitHub Actions runs = 0（push trigger 仅 `main`/`v1`、无 PR、无手动 dispatch）——不虚构任何本地未推送 commit 的远程状态。

**验证补充（本小节关闭验证，session-local）**

- focused native-abi 测试：82/82 PASS（含新增 stale-bin 边界真实文件系统测试）；
- `pnpm test:scripts`：139 PASS（4 files）；`pnpm typecheck:node` PASS；
- oxlint 0 warnings / 0 errors、eslint clean、biome format clean（仅改动的 `scripts/native-abi/` 文件）；`git diff --check` PASS；
- 只读 `pnpm native:check:electron` PASS；binding 哈希**前后一致**（`48191d9b…`，read-only）。

**残余风险（追加）**

| 风险 | 说明 |
|---|---|
| TOCTOU（残余，接受） | boundary 校验与 `fs.rmSync` 之间的同步 Node fs API 窗口（目录被换为包外 symlink）作为残余限制接受；`rmSync(recursive)` 从不跟随 symlink，校验过的 parent 链是唯一外部可达路径 |
| 原始真实用户 ZIP 路径保密 | 路径保持隐私安全角色描述（不记录绝对用户路径）；已由导入 harness 重跑 PASS（1/1，41.9s，2026-08-03 latest fresh ABI145 build；ZIP 不可变：size 1056109 / mtime / inode / mode 不变；2026-08-02 的 38.9s 为历史运行）；与标准 disposable dev-origin E2E fixture 证据明确区分（fixture 为自动化兼容性证据，原始 ZIP 为真实用户数据最终证明） |
| 历史计数保留 | explicit-undefined closure 的 318/7148（2026-08-02）、staged-validation closure 的 319/7230（2026-08-02）与最终交付验证的 319/7274（2026-08-03，active）计数**并存**（时间顺序追加），互不覆盖 |

### 最终交付验证（2026-08-03 追加，active final closure / latest-source authoritative）

> **定位**：本小节是 §17 的**最新最终交付验证**（active final closure），在 2026-08-02 staged-validation 关闭证据之上，于**最新源（latest source）**重新完成最终交付验证。**不重写**上述历史证据：explicit-undefined closure 的 318/7148（2026-08-02）与 staged-validation closure 的 319/7230（2026-08-02）均为历史计数（时间顺序保留，互不覆盖）；**当前有效最终计数为 319 files / 7274 passed**。最终 node_modules 状态为 **Electron ABI145**（binding hash `48191d9b…`）。仍**不是 Phase 7**；Phase 0–6 Done 状态不变。

| 项 | 最终事实（2026-08-03，latest source） |
|---|---|
| **最终 binding / node_modules 状态** | **Electron ABI145**：`build/Release/better_sqlite3.node` 与 `bin/darwin-arm64-145/better-sqlite3.node` SHA-256 均为 `48191d9b…`；`.forge-meta` = `arm64--145`；`native:check:electron` PASS；**最终 node_modules 状态为 Electron ABI145** |
| **Node rebuild + 独立 SQL 验证** | `pnpm native:rebuild:node` exit 0（自动 `native:check:node` PASS）+ 独立 Node ABI137 SQL 验证 PASS（`Database(':memory:')` + `select 1 as ok` + close） |
| **format** | `pnpm format` exit 0 无改动 |
| **lint** | `CI=true pnpm lint` exit 0 / 0 errors / 76 oxlint + 4 ESLint pre-existing warnings / node/web/aicore typecheck + i18n 通过 |
| **最终 clean 全量测试（active）** | `CI=true pnpm test` exit 0 / 319 files / **7274 passed** / 72 skipped / 0 failed / 449.99s |
| **Electron rebuild + 独立 SQL 验证** | `pnpm native:rebuild:electron` exit 0（自动 `native:check:electron` PASS）+ 独立 Electron 41.2.1 ABI145 SQL 验证 PASS（真实 Electron SQL probe） |
| **build** | `pnpm build` exit 0 / built / 9.02s |
| **标准 disposable E2E（fresh ABI145 production build、一次性 profile）** | **PASS**：`ordinary-chat.spec.ts` 1/1 37.5s；`import-cherrystudio-genuine.spec.ts` 1/1 67.5s；`import-cherrystudio-dev-origin.spec.ts` 1/1 59.7s（2026-08-02 的 31.2s / 53.5s / 54.5s 为历史运行，时间顺序保留） |
| **原始真实用户 dev ZIP（latest definitive rerun）** | **PASS 1/1（41.9s，latest fresh ABI145 build）**：candidate/live 计数 topics 25 / messages 107 / blocks 120 / segments 6 / memberships 16 / fileRefs 4；topicId normalized 2 / 孤儿 block skipped 5；**恰好一条合并 count-only warning**；integrity / FK / snapshot / relaunch / cleanup 全部 PASS；**ZIP 未变**（size 1056109、mtime/inode/mode 不变，MD5 一致）；final ABI145 binding hash `48191d9b…` 前后一致、git 未变。2026-08-02 的 38.9s 为历史运行（时间顺序保留） |
| **历史计数保留** | explicit-undefined closure 318/7148（2026-08-02）、staged-validation closure 319/7230（2026-08-02）、**最终交付验证 319/7274（2026-08-03，active）** 三者**并存**（时间顺序追加），互不覆盖 |
| **远程 CI** | 2026-08-03 docs closure 后更新：① 远程已推送 tip `3a64da6020` 不变；② 本地已提交、未推送共 8 个 commit——原 `1fc19f590c`/`6b48d33e72`/`6d2db496b1` + 新增 `b23c4ff4cb`（feat(native)：ABI 管理工具化）/`81a438b208`（fix(renderer)：JSON wire 共享引用）/`cbc19db426`（fix(import)：遗留 ownership 规范化）/`dbabae7eb8`（test(import)：规范化路径测试覆盖）+ 本 docs closure commit（无 SHA）；③ 本 docs closure commit 提交后工作树 clean。② 全部 8 个本地未推送 commit 均无远程 CI run（GitHub Actions runs for this branch = 0；ci.yml push trigger 仅 `main`/`v1`；未创建 PR、未手动 dispatch）；**无 push / 无 PR / 无远程 CI 变更** |

### 最终交付验证（2026-08-04 追加，L2 产品闭环 final closure / latest-source Node + final Electron）

> **定位**：本小节在 2026-08-03 active final closure 之上追加 **L2 产品闭环最终实现（2026-08-04）** 的最终交付验证与仓库 provenance。**不重写**既有历史证据：318/7148（2026-08-02）、319/7230（2026-08-02）、319/7274（2026-08-03）均为历史计数（时间顺序保留，互不覆盖）；2026-08-04 Node 证据 **335/7890/74** 为 **user-source 历史证据**（运行于最后 tiny helper + retention 隐私 docs 之前），**latest-source 重跑已完成（2026-08-04 最终序列）——当前权威计数 335 files（1 skipped）/ 7901 tests passed / 75 skipped / 0 failed**。仍**不是 Phase 7**；Phase 0–6 Done 状态不变。全程隐私安全（LOCK-DOC-2）。

| 项 | 最终事实（2026-08-04） |
|---|---|
| **Node gates（latest-source，Node v24.12.0 ABI137，2026-08-04 最终序列）** | `native:rebuild:node` exit 0（ABI137 SQL PASS）；`pnpm format` exit 0（1 个文件首次 pass 被修复、二次 pass clean，身份未指明）；`CI=true pnpm lint` 0 errors / **81 oxlint + 4 ESLint pre-existing warnings**；typecheck（node/web/aicore）+ i18n PASS；`CI=true pnpm test` exit 0 / **335 files（1 skipped）/ 7901 tests passed / 75 skipped / 0 failed**。**时间顺序（LOCK-DOC-3）**：user-source 7890/74 为 helper/privacy docs 前历史证据；latest-source 重跑已完成、无 pending |
| **Electron gates（final）** | `native:rebuild:electron` / `native:check:electron` / `pnpm build` PASS；标准 E2E **ordinary / genuine / dev / large 均 1/1**；**精确真实 spec 1/1（6m48s）**：candidate topics **2707** / messages **129150** / blocks **158441** / segments **13** / memberships **39** / fileRefs **4158** / pages **365** / elapsed **136307**；**全链 promoted** |
| **精确真实 spec 验证** | integrity / FK、six counts、snapshot、**14 维**（含 search_projection 第 14 维）、projection / UI / reload 全 PASS |
| **ZIP 指纹** | **不变**：size **1393936335**、full SHA **locked**、inode / mode / mtime 不变（既有指纹证据风格，LOCK-DOC-2） |
| **最终 ABI** | **ABI145**（Electron 41.2.1） |
| **历史计数保留** | explicit-undefined 318/7148（2026-08-02）、staged-validation 319/7230（2026-08-02）、最终交付验证 319/7274（2026-08-03）、**L2 产品闭环 user-source 335/7890/74（2026-08-04，helper/privacy docs 前）** 与 **latest-source 335 files（1 skipped）/ 7901 tests passed / 75 skipped / 0 failed（2026-08-04 最终序列，当前权威）** 并存（时间顺序追加，互不覆盖） |
| **provenance（2026-08-04 三 commit 收尾后快照）** | **HEAD = 本节文档收尾提交（哈希见当前 git history）**（docs(migration)：record L2 product closure）；**远程 tip = `3a64da6020` 不变**；**本地已提交、未推送共 11 个 commit**——pre-existing 8 个（`1fc19f590c` / `6b48d33e72` / `6d2db496b1` / `b23c4ff4cb` / `81a438b208` / `cbc19db426` / `dbabae7eb8` / `4dc3912840`）+ 本次 closure 3 个（`26c7190333` feat(import)：complete L2 Cherry Studio migration flow / `1c2c70a3dd` test(import)：add end-to-end migration coverage / 本节文档收尾提交）；**工作树 clean**。全部 11 个本地未推送 commit 均无远程 CI run（LOCK-MD8：GitHub Actions runs for this branch = 0；ci.yml push trigger 仅 `main`/`v1`；无 PR、无手动 dispatch）；**无 push / 无 PR / 无远程 CI 变更（LOCK-GIT）** |
