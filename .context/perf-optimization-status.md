# Cherry Studio Performance Optimization — Status

> Last updated: 2026-07-13
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

## Bundle Size Comparison

| Chunk | Baseline | After P0+P1 | Delta |
|---|---|---|---|
| store | 5.4MB | 5.3MB | -100KB |
| i18n | 3.0MB | 2.9MB | -100KB |
| ImageViewer | 1.5MB | 1.1MB | -400KB |
| vendor-lodash | N/A (inline) | 89KB (standalone) | Extracted |
| vendor-antd | 6.9MB | 6.9MB | 0 |

## Remaining Items

### P2 — Low Priority
| # | Issue | Effort |
|---|---|---|
| 9 | MiniWindow 按需创建（启动时不再预创建） | 1-2h |
| 10 | PersistGate 异步化（首屏不阻塞） | 1-2h |
| 11 | devTools 生产环境关闭 | 30m |

### Deferred — Independent Projects
| Issue | Effort | Notes |
|---|---|---|
| P1-8 消息列表虚拟化 | 9-13天 | 用 @tanstack/react-virtual 替代 react-infinite-scroll-component。column-reverse 布局、变高消息组、全对话截图是主要挑战。调查报告已完成。 |
| #1 topics.messages 反范式化 | 5-8天 | 重度用户（200+消息/topic）写入放大200倍。轻量方案：.modify() 原地突变（2-3天）。完整方案：新建 messages 表。暂不执行，等 SQLite 迁移。 |
| #2 历史搜索全表扫描 | 1-2天 | O(N²) join + 无 type 索引。等 SQLite 迁移后用 FTS5 解决。 |
| #4 useLiveQuery 全量加载 | 0.5-1天 | 搜索页从 DB 重复加载 Redux 已有数据。等 SQLite 迁移。 |
| IndexedDB → SQLite 迁移 | 8-12周 | 已有基础设施：MessageDataSource 接口、DbService facade、drizzle-orm 依赖。推荐方案：IPC to Main + better-sqlite3 + Drizzle。v2 Data API 层已在迁移中。 |

## Verification Framework

三层门禁：
1. **静态门禁**: `pnpm build:check`（lint + typecheck + i18n + format + openapi + test）
2. **Bundle 门禁**: 构建前后 chunk size 对比（.bundle-baseline.txt vs .bundle-after-p1.txt）
3. **功能门禁**: 3966 tests pass, 0 fail, 72 skip

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

## Dependencies Changed
- `lodash` → `lodash-es` (+ @types/lodash → @types/lodash-es)
- electron.vite.config.ts: added vendor-lodash manualChunks rule
