# Cherry Studio Performance Optimization — Status

> Last updated: 2026-07-14
> Branch: `jorkey/refactor/overhaul`
> Session context for continuing work

## Completed Rounds

### Round 1: Render Process Hot Paths (commit `161516b`)
- Eliminated unnecessary re-renders in 10+ components during streaming
- Selector stability, useMemo, useCallback optimization

### Round 2: Main Process I/O (commit `9a742a5`)
- Memory -60%, IPC -98%
- Event throttling, connection pooling

### Round 3: Build Optimization (commit `a70ef38`)
- Main chunk -1.46MB, store -41%
- Code splitting, tree shaking

### Round 4: Audit Fix (commit `bd9d0ff`)
- Fixed 3 severe + 5 medium issues from rounds 1-3

### Round 5: Data Layer + Security + Bundle (this session)

**Batch A — Render Cascade Elimination:**
- `#6`: selectMessagesForTopic shallowEqual (47 consumers, 3 files modified)
- `#11`: MessageGroup.renderMessage deps messages → messages.length
- `#10`: MessagesContent React.memo + stable props
- Commit: `3706318`

**Batch B — Security & Stability:**
- `#3`: ReduxService executeJavaScript → type-safe ReduxSelector enum + ReduxAction union
- `#9`: MCP progress throttle (100ms/callId) + log batching (200ms flush)
- Commit: `57dad71`

**Audit Fix:**
- Major#1: Remove stale assistant/topic useMemo
- Major#2: Expand ReduxAction union with provider cache invalidation actions
- Minor#1: Use ReduxSelector enum in renderer resolver
- Commit: `b71044b`

**P0 — Bundle Lazy-Loading:**
- `@uiw/codemirror-themes-all` → dynamic import (46 themes on-demand)
- `@xyflow/react` → React.lazy in ChatFlowHistory
- `react-player` → React.lazy in VideoBlock + VideoItem
- Commit: `da5d0af`

**P1 — Bundle Optimization:**
- `lodash` (CJS) → `lodash-es` (ESM) + vendor-lodash chunk (89KB)
- 28 lodash functions replaced with native JS
- Ant Design 12 locale files → dynamic import
- EmojiPicker → React.lazy with emoji data deferred
- motion/framer-motion → CSS @keyframes in 5 files
- Commit: `04d0dcd`

### Round 6: Feature Removal + Startup Optimization

**MiniWindow (Quick Assistant) 完全移除:**
- 删除 28 个文件，~1600 行代码
- 移除 IPC channels、WindowService 方法、ShortcutService handler、TrayService 集成
- 清理 Redux store（settings、llm、shortcuts slices）
- 清理 12 个 i18n locale 文件
- 保留 Redux 迁移链完整性（migration 57 中 qwenlm 逻辑保留）
- Commit: `c750069`

**P2 — devTools 生产环境关闭:**
- `store/index.ts`: `devTools: true` → `devTools: import.meta.env.DEV`
- 生产环境不再注册 Redux DevTools 钩子

**P2 — PersistGate 异步化:**
- 移除 PersistGate wrapper，应用立即渲染（使用 Redux initialState）
- redux-persist 在后台 rehydrate，完成后触发 re-render
- 首屏不再阻塞于 state rehydration

- Commit: `aab0d19`

**Bundle 瘦身 — react-player 移除:**
- `dash.all.min` (1.3MB) + `hls` (936KB) 两个 chunk 完全消除
- react-player 仅用于 2 个文件的本地 `file://` 视频播放，用原生 `<video>` 替代
- 移除 react-player 及所有 transitive 依赖（dashjs、hls-video-element 等）
- Bundle 总体积 70MB → 67MB（-3MB）
- Commit: `ab1f24b`

## Bundle Size Comparison

| Chunk | Baseline | After P0+P1 | Delta |
|---|---|---|---|
| store | 5.4MB | 5.3MB | -100KB |
| i18n | 3.0MB | 2.9MB | -100KB |
| ImageViewer | 1.5MB | 1.1MB | -400KB |
| vendor-lodash | N/A (inline) | 89KB (standalone) | Extracted |
| vendor-antd | 6.9MB | 6.9MB | 0 |
| dash.all.min | 1.3MB | ELIMINATED | -1.3MB |
| hls | 936KB | ELIMINATED | -936KB |

## Remaining Items

### P2 — Low Priority
| # | Issue | Effort | Status |
|---|---|---|---|
| 9 | MiniWindow 按需创建 | 1-2h | ✅ 功能已完全移除（Round 6） |
| 10 | PersistGate 异步化 | 1-2h | ✅ 完成（Round 6） |
| 11 | devTools 生产环境关闭 | 30m | ✅ 完成（Round 6） |

### Bundle 瘦身 — 已完成
| 目标 | 大小 | 状态 |
|---|---|---|
| dash.all.min | 1.3MB | ✅ 死代码移除（Round 6） |
| hls | 936KB | ✅ 随 react-player 移除（Round 6） |
| svg chunk | 2.3MB | ✅ tree-shaking 已生效，无优化空间 |
| vendor-antd | 6.9MB | ✅ tree-shaking 已生效，无优化空间 |

### Round 7: 消息列表虚拟化（P1-8）

**Phase 1 — 基础虚拟化架构:**
- 用 `react-virtuoso` 替代 `react-infinite-scroll-component`
- 实现 `VirtuosoMessageList` 组件，支持 column-reverse 布局
- 消息分组渲染：`MessageGroup` + `UserMessage` + `AssistantMessage`

**Phase 2 — 交互功能迁移:**
- ChatNavigation 跳转集成 Virtuoso `scrollToIndex`
- MessageAnchorLine 锚点功能迁移到 Virtuoso
- 消息选择、编辑模式集成

**Phase 3 — 性能优化:**
- `computeDisplayMessages` 优化（消除 spread + reverse）
- 消息渲染 memoization（`React.memo` + `useMemo`）
- 虚拟化列表的 overscan 调优

**Phase 4 — 清理收尾:**
- 移除 `react-infinite-scroll-component` 依赖
- 移除 `MessageAnchorLine` 组件及相关 i18n key
- 移除 `INITIAL_MESSAGES_COUNT`、`LOAD_MORE_COUNT`、`SCROLL_CONTEXT_COUNT` 常量
- 清理 `messageNavigation` Redux store 中 `'anchor'` 选项
- 添加 Redux migration 将 `'anchor'` 转换为 `'buttons'`
- 移除 `Messages.bench.ts`（dead code benchmark）
- 清理测试文件中的 `react-infinite-scroll-component` mock

**验证结果:**
- `pnpm build:check` ✅ 通过
- `pnpm test` ✅ 3965 tests pass, 72 skipped, 0 fail

### Deferred — Independent Projects
| Issue | Effort | Notes |
|---|---|---|
| #1 topics.messages 反范式化 | 5-8天 | 重度用户（200+消息/topic）写入放大200倍。轻量方案：.modify() 原地突变（2-3天）。完整方案：新建 messages 表。暂不执行，等 SQLite 迁移。 |
| #2 历史搜索全表扫描 | 1-2天 | O(N²) join + 无 type 索引。等 SQLite 迁移后用 FTS5 解决。 |
| #4 useLiveQuery 全量加载 | 0.5-1天 | 搜索页从 DB 重复加载 Redux 已有数据。等 SQLite 迁移。 |
| IndexedDB → SQLite 迁移 | 8-12周 | 已有基础设施：MessageDataSource 接口、DbService facade、drizzle-orm 依赖。推荐方案：IPC to Main + better-sqlite3 + Drizzle。v2 Data API 层已在迁移中。 |

## Verification Framework

三层门禁：
1. **静态门禁**: `pnpm build:check`（lint + typecheck + i18n + format + openapi + test）
2. **Bundle 门禁**: 构建前后 chunk size 对比（.bundle-baseline.txt vs .bundle-after-p1.txt）
3. **功能门禁**: 3965 tests pass, 0 fail, 72 skip

## Key Files Modified

### Core Data Layer
- `src/renderer/src/store/newMessage.ts` — selectMessagesForTopic memoized
- `src/renderer/src/store/index.ts` — ReduxSelector resolver, devTools config

### IPC & Security
- `packages/shared/ReduxIpc.ts` — ReduxSelector enum + ReduxAction type
- `src/main/services/ReduxService.ts` — Type-safe select/dispatch
- `src/main/services/MCPService.ts` — Progress throttle + log batching

### Rendering
- `src/renderer/src/pages/home/Messages/Messages.tsx` — MessagesContent React.memo
- `src/renderer/src/pages/home/Messages/MessageGroup.tsx` — renderMessage deps fix

### Bundle
- `src/renderer/src/context/CodeStyleProvider.tsx` — CodeMirror themes lazy-load
- `src/renderer/src/context/AntdProvider.tsx` — Antd locales lazy-load
- `src/renderer/src/components/EmojiPicker/` — Split into lazy wrapper + inner
- `src/renderer/src/pages/home/Messages/ChatNavigation.tsx` — ReactFlow lazy-load
- `src/renderer/src/pages/home/Messages/Blocks/VideoBlock.tsx` — react-player lazy-load
- `src/renderer/src/assets/styles/animation.css` — CSS keyframes for motion replacement

### Feature Removal
- `src/renderer/src/windows/mini/` — 整个目录删除（12 files）
- `src/renderer/miniWindow.html` — 删除
- `src/renderer/src/pages/settings/QuickAssistantSettings.tsx` — 删除
- `src/main/services/WindowService.ts` — 移除 miniWindow 方法（~200 lines）
- `src/main/services/ShortcutService.ts` — 移除 mini_window handler
- `src/main/services/TrayService.ts` — 简化 tray 行为
- `src/main/services/ConfigManager.ts` — 移除 QA 配置项
- `packages/shared/IpcChannel.ts` — 移除 7 个 MiniWindow channel
- `src/preload/index.ts` — 移除 miniWindow API

### Bundle 瘦身
- `src/renderer/src/pages/home/Messages/MessageVideo.tsx` — ReactPlayer → 原生 `<video>`
- `src/renderer/src/pages/knowledge/components/KnowledgeSearchItem/VideoItem.tsx` — 同上
- `package.json` — 移除 react-player 依赖

### Startup Optimization
- `src/renderer/src/store/index.ts` — devTools 仅开发环境启用
- `src/renderer/src/App.tsx` — 移除 PersistGate，立即渲染

### Message List Virtualization
- `src/renderer/src/pages/home/Messages/Messages.tsx` — react-virtuoso 集成
- `src/renderer/src/pages/home/Messages/ChatNavigation.tsx` — Virtuoso scrollToIndex 跳转
- `src/renderer/src/store/settings.ts` — messageNavigation 类型清理
- `src/renderer/src/store/migrate.ts` — migration 211: 'anchor' → 'buttons'
- `src/renderer/src/config/constant.ts` — 移除 INITIAL_MESSAGES_COUNT 等常量

## Dependencies Changed
- `lodash` → `lodash-es` (+ @types/lodash → @types/lodash-es)
- `react-player` removed (replaced with native `<video>`)
- `react-infinite-scroll-component` removed (replaced with `react-virtuoso`)
- electron.vite.config.ts: added vendor-lodash manualChunks rule

### Round 5 Audit Fix (commit `1868c45`)
- Major#1: selectMessagesForTopic cache now includes entity refs in fast-path check
- Major#2: MCP progress throttle emits terminal 100% events, flushes last skipped in finally
- Major#3: CodeMirror lazy theme fallback returns 'light'/'dark' instead of raw theme names
- Minor: AntdProvider locale loading .catch handler for chunk load failures
