import { expect, test } from '../../fixtures/electron.fixture'
import { waitForAppReady } from '../../utils/wait-helpers'
import { activateTopic, prepareAssistant, seedSourceTopic, uuidLike } from '../../utils/branch-route-setup'

const COMMON = 8
const MAIN_TAIL = 2
const TOTAL = COMMON + MAIN_TAIL
const tallJS =
  'intro\n```js\n' + Array.from({ length: 40 }, (_, i) => `const js${i}=${i}; // line ${i}`).join('\n') + '\n```\nend'
const tallRust =
  'rust\n```rust\n' + Array.from({ length: 65 }, (_, i) => `fn f${i}(){println!("{}",${i})}`).join('\n') + '\n```\nend'
const tallPy =
  'py\n```python\n' + Array.from({ length: 40 }, (_, i) => `def g${i}(): return ${i} # ${i}`).join('\n') + '\n```\nend'

async function waitVisible(page: any) {
  await page.waitForFunction(
    () => {
      const e = document.getElementById('messages')
      const p = e?.getAttribute('data-viewport-phase')
      return p === 'revealed' || p === 'idle'
    },
    undefined,
    { timeout: 30000 }
  )
}
async function waitActive(page: any, tid: string, bid: string | null) {
  await page.waitForFunction(
    ({ t, b }: any) => ((window as any).store.getState().topicBranch?.activeBranchIdByTopic?.[t] ?? null) === b,
    { t: tid, b: bid },
    { timeout: 30000 }
  )
}
async function stableRects(page: any, ids: string[]) {
  for (const id of ids) {
    await page.evaluate(
      (mid: string) =>
        new Promise<void>((res) => {
          let prev: number | null = null
          let stable = 0
          const tick = () => {
            const el = document.querySelector(`[data-message-id="${mid}"]`) as HTMLElement | null
            const h = el ? el.getBoundingClientRect().height : -1
            if (prev !== null && Math.abs(h - prev) <= 1) {
              stable += 1
              if (stable >= 2) {
                res()
                return
              }
            } else stable = 0
            prev = h
            requestAnimationFrame(() => requestAnimationFrame(tick))
          }
          tick()
        }),
      id
    )
  }
}

function dividerSelector(aid: string): string {
  return `[data-divider-key="${aid}::main"],[data-testid="branch-fork-divider-${aid}-main"],[data-testid="branch-fork-toggle-${aid}"],[data-testid="branch-fork-selected-${aid}"]`
}
async function readDividerState(page: any, anchorId: string) {
  return await page.evaluate((aid: string) => {
    const c = document.querySelector('#messages') as HTMLElement
    const d =
      (document.querySelector(`[data-divider-key="${aid}::main"]`) as HTMLElement | null) ||
      (document.querySelector(`[data-testid="branch-fork-divider-${aid}-main"]`) as HTMLElement | null) ||
      ((document.querySelector(`[data-testid="branch-fork-divider-${aid}"]`) as HTMLElement | null)?.closest(
        '[data-divider-key]'
      ) as HTMLElement | null) ||
      (document.querySelector(`[data-testid="branch-fork-toggle-${aid}"]`) as HTMLElement | null) ||
      (document.querySelector(`[data-testid="branch-fork-selected-${aid}"]`) as HTMLElement | null)
    const cr = c.getBoundingClientRect()
    const dr = d ? d.getBoundingClientRect() : { top: 0 }
    return { off: d ? dr.top - cr.top : -1, st: c.scrollTop, sh: c.scrollHeight, ch: c.clientHeight }
  }, anchorId)
}
interface ForkWheelTarget {
  x: number
  y: number
  hit: string
  chain: string
}

let lastForkWheel: ForkWheelTarget | null = null

async function resolveForkWheelTarget(page: any): Promise<ForkWheelTarget | null> {
  // Deterministic outer-#messages wheel point. Source nesting fact:
  // CodeBlockView renders CodeViewer collapsed by default (codeCollapsible=true,
  // expandOverride starts false, MAX_COLLAPSED_CODE_HEIGHT=350px) and the
  // collapsed `.shiki-scroller` ScrollContainer carries inline
  // overflowY:auto + maxHeight:350px — so every tall fixture block (Py40/JS40/
  // Rust65 lines) is a nested vertical scroller (scrollHeight>clientHeight).
  // A wheel dispatched at the #messages center hits that nested scroller and
  // is intercepted there, which is why the outer scroll stalled at st=-1858
  // (dy=108 no-change, divider off 476 vs target 340). Candidates therefore
  // use the container padding gutters (left/right, several heights) — never
  // the horizontal center — and elementFromPoint + ancestor-chain proof picks
  // the first point whose path to #messages contains NO scrollable nested
  // element (computed overflowY auto/scroll AND scrollHeight>clientHeight).
  // Labels carry tag/id/class only (bounded, no message content).
  return await page.evaluate(() => {
    const c = document.querySelector('#messages') as HTMLElement | null
    if (!c) return null
    const cr = c.getBoundingClientRect()
    const isNestedScroller = (el: Element): boolean => {
      if (el === c) return false
      const cs = getComputedStyle(el as HTMLElement)
      const oy = cs.overflowY
      if (oy !== 'auto' && oy !== 'scroll') return false
      const h = el as HTMLElement
      return h.scrollHeight > h.clientHeight + 1
    }
    const label = (el: Element): string => {
      const t = (el.tagName || '?').toLowerCase()
      const id = (el as HTMLElement).id ? `#${(el as HTMLElement).id}` : ''
      const rawCls = (el as HTMLElement).className
      const cls = typeof rawCls === 'string' ? rawCls.trim().split(/\s+/).slice(0, 3).join('.') : ''
      return `${t}${id}${cls ? `.${cls}` : ''}`
    }
    const xs = [cr.left + 5, cr.left + 9, cr.right - 9, cr.right - 5]
    const ys = [
      cr.top + cr.height * 0.3,
      cr.top + cr.height * 0.4,
      cr.top + cr.height * 0.5,
      cr.top + cr.height * 0.6,
      cr.top + cr.height * 0.7
    ]
    for (const y of ys) {
      for (const x of xs) {
        if (x < cr.left || x >= cr.right || y < cr.top || y >= cr.bottom) continue
        const hit = document.elementFromPoint(x, y) as Element | null
        if (!hit) continue
        // Hit must be the container itself (padding gutter / scrollbar track)
        // or contained within it — otherwise a pointer overlay owns the point.
        if (hit !== c && !c.contains(hit)) continue
        const chain: Element[] = []
        let n: Element | null = hit
        while (n && n !== c) {
          chain.push(n)
          n = n.parentElement
        }
        if (!n) continue
        if (chain.filter(isNestedScroller).length === 0) {
          return { x, y, hit: label(hit), chain: chain.map(label).join('>') }
        }
      }
    }
    return null
  })
}
async function focusForkMessages(page: any): Promise<ForkWheelTarget> {
  const pt: ForkWheelTarget | null = await resolveForkWheelTarget(page)
  expect(
    pt,
    'fork wheel needs a gutter point whose ancestor path has no scrollable nested element before #messages; all candidates blocked (wheel would hit a collapsed code .shiki-scroller instead of the outer pane)'
  ).not.toBeNull()
  await page.mouse.move(pt!.x, pt!.y)
  lastForkWheel = pt
  return pt!
}
async function forkWheel(page: any, dy: number) {
  await focusForkMessages(page)
  await page.mouse.wheel(0, dy)
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
  await page.waitForTimeout(220)
}
async function measureForkRange(page: any, anchorId: string) {
  // Wheel-established reachable range (ordinary user input only). Causal
  // root of the prior empty intersection (main[-1381,-1381]): direct
  // c.scrollTop writes are no-intent scrolls — Messages handleScroll takes
  // the keeper requestHold branch and the stable-anchor keeper compensates
  // scrollTop back to hold the active anchor offset, so the programmatic
  // probe never moved and low==high. Wheel opens declareUserIntent capture
  // + userTakeover, so the scroll genuinely lands and the keeper stands down.
  const exists: any = await page.evaluate((aid: string) => {
    const c = document.querySelector('#messages') as HTMLElement | null
    const d =
      (document.querySelector(`[data-divider-key="${aid}::main"]`) as HTMLElement | null) ||
      (document.querySelector(`[data-testid="branch-fork-divider-${aid}-main"]`) as HTMLElement | null) ||
      (document.querySelector(`[data-testid="branch-fork-toggle-${aid}"]`) as HTMLElement | null) ||
      (document.querySelector(`[data-testid="branch-fork-selected-${aid}"]`) as HTMLElement | null)
    if (!c || !d) return null
    return { ch: c.clientHeight, sh: c.scrollHeight, st: c.scrollTop }
  }, anchorId)
  expect(exists, 'divider must exist for range measure').not.toBeNull()
  expect(
    exists.sh - exists.ch,
    `fork fixture too short for real scroll (sh=${exists.sh} ch=${exists.ch}); seeded tall content must make sh>ch+margin`
  ).toBeGreaterThan(200)
  const isBottom = async (): Promise<boolean> => {
    const s: any = await readDividerState(page, anchorId)
    return Math.abs(s.st) <= 100
  }
  const isTop = async (): Promise<boolean> => {
    const s: any = await readDividerState(page, anchorId)
    const extreme = -(s.sh - s.ch)
    return Math.abs(s.st - extreme) <= 120
  }
  const wheelToBottom = async (): Promise<void> => {
    for (let i = 0; i < 30; i++) {
      if (await isBottom()) break
      await forkWheel(page, 560)
    }
    if (!(await isBottom())) {
      for (let i = 0; i < 30; i++) {
        if (await isBottom()) break
        await forkWheel(page, -560)
      }
    }
    expect(await isBottom(), 'fork range prep must reach true bottom via ordinary wheel').toBe(true)
  }
  const wheelToTop = async (): Promise<void> => {
    for (let i = 0; i < 30; i++) {
      if (await isTop()) break
      await forkWheel(page, -560)
    }
    if (!(await isTop())) {
      for (let i = 0; i < 30; i++) {
        if (await isTop()) break
        await forkWheel(page, 560)
      }
    }
    expect(await isTop(), 'fork range prep must reach true top via ordinary wheel').toBe(true)
  }
  await wheelToBottom()
  await waitVisible(page)
  const atZero: any = await readDividerState(page, anchorId)
  await wheelToTop()
  await waitVisible(page)
  const atMax: any = await readDividerState(page, anchorId)
  expect(
    Math.abs(atMax.st - atZero.st) > 50,
    `fork range prep must show real scroll movement (bottom st=${atZero.st} top st=${atMax.st}); keeper-corrected probe is not a range`
  ).toBe(true)
  const low = Math.min(atZero.off, atMax.off)
  const high = Math.max(atZero.off, atMax.off)
  const stLow = Math.min(atZero.st, atMax.st)
  const stHigh = Math.max(atZero.st, atMax.st)
  // slope: offset per scrollTop
  const slope = atMax.st !== atZero.st ? (atMax.off - atZero.off) / (atMax.st - atZero.st) : 0
  return { atZero, atMax, low, high, stLow, stHigh, slope, ch: atZero.ch }
}

async function positionToTarget(
  page: any,
  anchorId: string,
  target: number,
  range: { low: number; high: number; slope: number; stLow: number; stHigh: number }
) {
  // Ordinary-wheel positioning to the feasible common offset (no direct
  // scrollTop write: the keeper would compensate a programmatic jump as a
  // no-intent scroll). Measured proportional control with exact trial limit
  // (40): one small real-wheel calibration learns the local off/dy + st/dy
  // response, then each step is dy=err/offPerDy (damped, clamped to the safe
  // viewport range) so the step shrinks as the error shrinks. Direction sign
  // comes ONLY from the observed calibration (reverse-column slope is -1, but
  // never assumed); each wheel is ordinary user input followed by bounded
  // stable-geometry settle. Per-trial history is emitted ONLY on failure with
  // exit reason + before/delta/off/st; success returns the actual final
  // geometry (never a tracked best without reposition). Impossible fixtures
  // fail (no skip); convergence within 12px is asserted by the caller.
  const readNow = async (): Promise<{ off: number; st: number; sh: number; ch: number }> =>
    await readDividerState(page, anchorId)
  const settleGeom = async (): Promise<{ off: number; st: number; sh: number; ch: number }> => {
    let cur: any = await readNow()
    for (let i = 0; i < 3; i++) {
      await page.waitForTimeout(120)
      const next: any = await readNow()
      if (Math.abs(next.off - cur.off) <= 2 && Math.abs(next.st - cur.st) <= 2) return next
      cur = next
    }
    return cur
  }
  const before: any = await settleGeom()
  if (Math.abs(before.off - target) <= 12) {
    return { before, after: before, desiredSt: before.st, deltaSt: 0, slope: range.slope }
  }
  // Calibration: one small real wheel in each sign until movement is seen.
  // Keeps ordinary input (declareUserIntent) and never writes scrollTop.
  const trials: { dy: number; off: number; st: number; err: number }[] = []
  let calDy = 160
  let calBefore: any = before
  let calAfter: any = null
  let offPerDy = 0
  let stPerDy = 0
  let calibratedDy = 0
  for (const sign of [1, -1]) {
    const dy = sign * calDy
    await forkWheel(page, dy)
    const cur: any = await settleGeom()
    const dOff = cur.off - calBefore.off
    const dSt = cur.st - calBefore.st
    trials.push({ dy, off: cur.off, st: cur.st, err: Math.abs(cur.off - target) })
    if (Math.abs(dOff) >= 1 || Math.abs(dSt) >= 1) {
      offPerDy = dOff / dy
      stPerDy = dSt / dy
      calibratedDy = dy
      calAfter = cur
      break
    }
  }
  if (!calAfter || Math.abs(offPerDy) < 1e-6) {
    const detail =
      `positionToTarget calibration saw no real wheel movement ` +
      `before off=${before.off} st=${before.st} target=${target} ` +
      trials.map((t) => `dy=${t.dy} off=${t.off} st=${t.st}`).join(' | ')
    expect(Math.abs(offPerDy), detail).toBeGreaterThan(0)
  }
  let cur: any = calAfter
  let gain = 0.8
  let flips = 0
  let prevSign = 0
  let exitReason = 'trial-limit'
  for (let i = 0; i < 40; i++) {
    const err = target - cur.off
    if (Math.abs(err) <= 12) {
      exitReason = 'converged'
      break
    }
    // Proportional bounded delta: raw step from measured response, damped to
    // avoid overshoot, clamped to the safe ordinary-wheel range; magnitude
    // shrinks naturally as err shrinks. Clamp the predicted scrollTop to the
    // measured reachable range so no step asks for an impossible position.
    // No hard minimum step: fixed minStep=40 oscillates around the goal
    // (target362 off348.078<->388.078 with offPerDy=-1/stPerDy=1) because
    // each +-40 moves ~40px and never settles within 12px. Small
    // proportional dy down to +-1 (still an ordinary real wheel at the safe
    // outer gutter) is allowed near the goal so the error settles 1px at a
    // time. Zero-rounding fallback keeps the err/offPerDy sign so reverse
    // slope is respected.
    let dy = Math.round((err / offPerDy) * gain)
    if (!Number.isFinite(dy) || dy === 0) dy = (err / offPerDy > 0 ? 1 : -1) * 1
    const maxStep = 560
    if (Math.abs(dy) > maxStep) dy = (dy > 0 ? 1 : -1) * maxStep
    if (Math.abs(stPerDy) > 1e-6) {
      const predictedSt = cur.st + dy * stPerDy
      const lo = Math.min(range.stLow, range.stHigh) - 20
      const hi = Math.max(range.stLow, range.stHigh) + 20
      if (predictedSt < lo || predictedSt > hi) {
        const clampedSt = Math.max(lo, Math.min(hi, predictedSt))
        const fitDy = Math.round((clampedSt - cur.st) / stPerDy)
        if (Number.isFinite(fitDy) && fitDy !== 0) dy = Math.max(-maxStep, Math.min(maxStep, fitDy))
      }
    }
    const sign = dy > 0 ? 1 : -1
    if (prevSign !== 0 && sign !== prevSign) {
      flips += 1
      if (flips >= 3) gain = Math.max(0.3, gain / 2)
    }
    prevSign = sign
    const prevOff = cur.off
    const prevSt = cur.st
    await forkWheel(page, dy)
    const next: any = await settleGeom()
    trials.push({ dy, off: next.off, st: next.st, err: Math.abs(next.off - target) })
    if (Math.abs(next.st - prevSt) < 1 && Math.abs(next.off - prevOff) < 1) {
      // Fully clamped at an extreme with no movement: cannot converge.
      cur = next
      exitReason = `clamped-no-movement dy=${dy} st=${next.st} off=${next.off}`
      break
    }
    cur = next
  }
  const after: any = await settleGeom()
  trials.push({ dy: 0, off: after.off, st: after.st, err: Math.abs(after.off - target) })
  if (Math.abs(after.off - before.off) < 1 && Math.abs(after.st - before.st) < 1) {
    // No actual scroll occurred; surface as fixture/movement failure, never
    // silently accept the stale position.
    expect(
      Math.abs(after.off - before.off) + Math.abs(after.st - before.st),
      `positionToTarget must move via real wheel (before off=${before.off} st=${before.st} after off=${after.off} st=${after.st} target=${target})`
    ).toBeGreaterThan(0)
  }
  if (Math.abs(after.off - target) > 12) {
    const head = trials
      .slice(0, 6)
      .map((t) => `dy=${t.dy} off=${t.off} st=${t.st} err=${t.err}`)
      .join(' | ')
    const tail = trials
      .slice(-6)
      .map((t) => `dy=${t.dy} off=${t.off} st=${t.st} err=${t.err}`)
      .join(' | ')
    const wheelPt = lastForkWheel
      ? `x=${Math.round(lastForkWheel.x)} y=${Math.round(lastForkWheel.y)} hit=${lastForkWheel.hit} chain=${lastForkWheel.chain.slice(0, 300)}`
      : 'none'
    const detail =
      `positionToTarget failed exit=${exitReason} target=${target} ` +
      `before off=${before.off} st=${before.st} after off=${after.off} st=${after.st} ` +
      `offPerDy=${offPerDy} stPerDy=${stPerDy} calibDy=${calibratedDy} gain=${gain} ` +
      `wheelPt=[${wheelPt}] ` +
      `head=[${head}] tail=[${tail}]`
    // eslint-disable-next-line no-console
    console.log(`[FORK-POS] ${detail}`)
    test.info().annotations.push({ type: 'fork-pos-failure', description: detail.slice(0, 1900) })
  }
  const desiredSt = after.st
  const deltaSt = after.st - before.st
  return { before, after, desiredSt, deltaSt, slope: range.slope }
}

test.describe('Fork viewport asymmetric — minimal divider visible atomic', () => {
  test.skip(process.platform !== 'darwin', 'macOS only')
  test('main<->branch divider keeps shared/fork displacement <=12px with hiddenFrames=0', async ({
    mainWindow,
    electronApp
  }) => {
    test.setTimeout(240000)
    const page = mainWindow
    const bounds = await electronApp.evaluate(({ BrowserWindow }: any) => {
      const w = (BrowserWindow as any).getAllWindows()[0]
      if (!w) return null
      try {
        w.setContentBounds({ width: 1750, height: 1080 })
      } catch {}
      return w.getContentBounds()
    })
    test.info().annotations.push({
      type: 'native-bounds',
      description: `contentBounds=${JSON.stringify(bounds)} page=${await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))}`
    })
    await waitForAppReady(page)
    const assistantId = await prepareAssistant(page, TOTAL + 5)
    const topicId = `fork-asym-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const ids = await seedSourceTopic(page, {
      assistantId,
      topicId,
      name: `ForkAsym ${topicId}`,
      total: TOTAL,
      messageIdForIndex: (i: number) => uuidLike(i),
      contentPrefix: 'fork-',
      contentForIndex: (i: number) => {
        if (i === COMMON - 2) return tallPy
        if (i === COMMON - 1) return tallJS
        if (i === COMMON) return tallRust
        if (i === COMMON + 1) return 'user follow rust'
        return `common ${i}`
      }
    })
    const anchorId = ids[COMMON - 1]
    const mainExclusives = ids.slice(COMMON)
    await activateTopic(page, topicId, TOTAL)
    await page.evaluate((id: string) => {
      const esc = (CSS as any).escape ? (CSS as any).escape(id) : id
      document.querySelector(`[id="message-${esc}"]`)?.scrollIntoView({ block: 'center', behavior: 'instant' as any })
    }, anchorId)
    const sel = `[id="message-${anchorId}"][data-message-id="${anchorId}"]`
    await expect(page.locator(sel).first()).toBeVisible({ timeout: 15000 })
    try {
      await page.locator(sel).first().hover({ timeout: 8000 })
    } catch {}
    const btn = page.locator(sel).first().locator('[data-testid="msg-true-branch-btn"]')
    await expect(btn).toBeAttached({ timeout: 10000 })
    try {
      await btn.click({ timeout: 8000 })
    } catch {
      await btn.click({ force: true } as any)
    }
    await page.waitForFunction(
      ({ tid, n }: any) =>
        Array.isArray((window as any).store.getState().messages?.messageIdsByTopic?.[tid]) &&
        (window as any).store.getState().messages.messageIdsByTopic[tid].length === n,
      { tid: topicId, n: COMMON },
      { timeout: 30000 }
    )
    const br: any = await page.evaluate(
      (tid: string) => (window as any).api.chatDb.listBranches({ topicId: tid }),
      topicId
    )
    expect(br?.ok && br.value.branches.length === 1).toBe(true)
    const branchId = br.value.branches[0].id as string
    let after: string = anchorId
    const branchSuffix: string[] = []
    for (let i = 0; i < 2; i++) {
      const mid = uuidLike(1000 + i)
      branchSuffix.push(mid)
      const role = i % 2 === 0 ? 'assistant' : 'user'
      const content = i === 0 ? tallPy : 'branch alt user'
      const r: any = await page.evaluate(
        async ({ tid, bid, aft, m, aid, role, content }: any) =>
          await (window as any).api.chatDb.insertMessagesAfterAnchor({
            topicId: tid,
            branchId: bid,
            afterMessageId: aft,
            entries: [
              {
                message: {
                  id: m,
                  topicId: tid,
                  role,
                  assistantId: aid,
                  status: 'success',
                  createdAt: '2026-01-01T00:00:00.000Z',
                  updatedAt: '2026-01-01T00:00:00.000Z'
                },
                blocks: [
                  {
                    id: `${m}-b`,
                    messageId: m,
                    type: 'main_text',
                    content,
                    status: 'success',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z'
                  }
                ]
              }
            ]
          }),
        { tid: topicId, bid: branchId, aft: after, m: mid, aid: assistantId, role, content }
      )
      expect(r?.ok).toBe(true)
      after = mid
    }
    // --- FEASIBLE COMMON OFFSET MEASUREMENT (one-off programmatic scroll, no wheel loops) ---
    // Branch active first, then main, verify parsed heights >=2rAF stable before each range
    await page.locator('[data-testid="branch-selector-entry"]').first().click()
    await expect(page.locator('[data-testid="branch-selector-popover"]').first()).toBeVisible({ timeout: 15000 })
    await page.locator(`[data-testid="branch-cascader-item-${branchId}"]`).first().click()
    await waitActive(page, topicId, branchId)
    await waitVisible(page)
    // branch tail tallest (Py 40) + shared anchor JS 40 must be stable
    await stableRects(page, [anchorId, branchSuffix[0]])
    const branchRange = await measureForkRange(page, anchorId)
    test.info().annotations.push({
      type: 'branch-range',
      description: `low=${branchRange.low} high=${branchRange.high} atZeroOff=${branchRange.atZero.off} st=${branchRange.atZero.st} atMaxOff=${branchRange.atMax.off} st=${branchRange.atMax.st} ch=${branchRange.ch} sh=${branchRange.atMax.sh} slope=${branchRange.slope}`
    })

    await page.locator('[data-testid="branch-selector-entry"]').first().click()
    await expect(page.locator('[data-testid="branch-selector-popover"]').first()).toBeVisible({ timeout: 15000 })
    await page.locator('[data-testid="branch-cascader-item-main"]').first().click()
    await waitActive(page, topicId, null)
    await waitVisible(page)
    await stableRects(page, [anchorId, ...mainExclusives.slice(0, 1)])
    const mainRange = await measureForkRange(page, anchorId)
    test.info().annotations.push({
      type: 'main-range',
      description: `low=${mainRange.low} high=${mainRange.high} atZeroOff=${mainRange.atZero.off} st=${mainRange.atZero.st} atMaxOff=${mainRange.atMax.off} st=${mainRange.atMax.st} ch=${mainRange.ch} sh=${mainRange.atMax.sh} slope=${mainRange.slope}`
    })

    // overlap of reachable offsets
    const interLow = Math.max(mainRange.low, branchRange.low)
    const interHigh = Math.min(mainRange.high, branchRange.high)
    expect(
      interLow <= interHigh,
      `fixture insufficient: no common offset overlap main[${mainRange.low},${mainRange.high}] branch[${branchRange.low},${branchRange.high}] inter[${interLow},${interHigh}]`
    ).toBe(true)
    // prefer within viewport
    const ch = Math.min(mainRange.ch, branchRange.ch)
    const viewportLow = Math.max(interLow, 0)
    const viewportHigh = Math.min(interHigh, ch)
    expect(
      viewportLow <= viewportHigh,
      `fixture insufficient: no in-viewport common offset inter[${interLow},${interHigh}] viewport[0,${ch}]`
    ).toBe(true)
    // choose feasible near-bottom but fully visible (divider fully inside viewport) to avoid click auto-scroll
    const dividerH = 38 // measured ~37.1875, use 38 conservative
    const maxFullyVisible = ch - dividerH - 2
    const cappedHigh = Math.min(viewportHigh, maxFullyVisible)
    let want: number
    if (cappedHigh >= viewportLow) {
      // prefer lower near-bottom within fully visible range, closest to 820 but capped
      const target820 = 820
      if (target820 >= viewportLow && target820 <= cappedHigh) want = target820
      else if (target820 > cappedHigh) want = cappedHigh
      else want = viewportLow
      // ensure at least 10px margin from bottom for popup stability, pick lowest that is visible
      // if capped range narrow, pick its low (most margin)
      if (want > cappedHigh) want = cappedHigh
      // for current ch=402, cappedHigh=362, viewportLow=340 => pick low (340) for max popup margin
      if (want === cappedHigh && cappedHigh - viewportLow < 30) want = viewportLow
    } else {
      // no fully visible common offset, fallback to viewportLow with best effort
      let t = 820
      if (t < viewportLow) t = viewportLow
      else if (t > viewportHigh) t = viewportHigh
      want = t
    }
    // ensure want is within common intersection
    expect(
      want >= interLow && want <= interHigh,
      `chosen want ${want} must be within common intersection [${interLow},${interHigh}]`
    ).toBe(true)
    expect(want >= 0 && want <= ch, `chosen want ${want} must be within viewport [0,${ch}]`).toBe(true)
    // position on main (currently at main) to want via one-off programmatic scroll
    const pos = await positionToTarget(page, anchorId, want, mainRange)
    console.log(
      `[SETUP-POS] want=${want} inter=[${interLow},${interHigh}] viewport=[${viewportLow},${viewportHigh}] ch=${ch} beforeOff=${pos.before.off} afterOff=${pos.after.off} desiredSt=${pos.desiredSt} slope=${pos.slope} st=${pos.after.st} sh=${pos.after.sh}`
    )
    test.info().annotations.push({
      type: 'setup-position',
      description: `anchor=${anchorId} want=${want} chosenTarget=${want} inter=[${interLow},${interHigh}] viewport=[${viewportLow},${viewportHigh}] ch=${ch} beforeOff=${pos.before.off} afterOff=${pos.after.off} desiredSt=${pos.desiredSt} slope=${pos.slope} st=${pos.after.st} sh=${pos.after.sh}`
    })
    // feasible in-bounds check (replaces impossible <=20 to target485)
    expect(
      pos.after.off >= mainRange.low - 1 && pos.after.off <= mainRange.high + 1,
      `divider afterOff ${pos.after.off} must be within main reachable [${mainRange.low},${mainRange.high}]`
    ).toBe(true)
    expect(
      Math.abs(pos.after.off - want) <= 12,
      `divider must reach feasible common offset want=${want} afterOff=${pos.after.off}`
    ).toBe(true)

    const runLeg = async (from: string | null, to: string | null, label: string, wantOffset: number) => {
      const sharedIds = ids.slice(0, COMMON)
      await stableRects(page, [anchorId])
      const beforeToggle: any = await page.evaluate((aid: string) => {
        const c = document.querySelector('#messages') as HTMLElement
        const el = document.querySelector(`[data-message-id="${aid}"]`) as HTMLElement | null
        const cr = c.getBoundingClientRect()
        const er = el ? el.getBoundingClientRect() : { top: 0, height: 0 }
        return {
          forkOff: el ? er.top - cr.top : -1,
          st: c.scrollTop,
          sh: c.scrollHeight,
          ch: c.clientHeight,
          phase: c.getAttribute('data-viewport-phase'),
          vis: getComputedStyle(c).visibility
        }
      }, anchorId)
      const toggleSel =
        from === null
          ? `[data-testid="branch-fork-toggle-${anchorId}"]`
          : `[data-testid="branch-fork-selected-${anchorId}"]`
      await page.locator(toggleSel).first().click()
      await expect(page.locator(`[data-testid="branch-fork-list-${anchorId}"]`).first()).toBeVisible({ timeout: 15000 })
      const afterToggle: any = await page.evaluate((aid: string) => {
        const c = document.querySelector('#messages') as HTMLElement
        const el = document.querySelector(`[data-message-id="${aid}"]`) as HTMLElement | null
        const cr = c.getBoundingClientRect()
        const er = el ? el.getBoundingClientRect() : { top: 0 }
        return { forkOff: el ? er.top - cr.top : -1, st: c.scrollTop }
      }, anchorId)
      console.log(
        `[${label}] beforeToggle forkOff=${beforeToggle.forkOff} st=${beforeToggle.st} afterToggle forkOff=${afterToggle.forkOff} st=${afterToggle.st} diff=${Math.abs(afterToggle.forkOff - beforeToggle.forkOff)}`
      )
      expect(
        Math.abs(afterToggle.forkOff - beforeToggle.forkOff),
        `${label} popup must not move fork`
      ).toBeLessThanOrEqual(12)
      expect(Math.abs(afterToggle.st - beforeToggle.st), `${label} popup must not scroll`).toBeLessThanOrEqual(2)
      await page.evaluate(
        ({ aid, sids, w, forkWant }: any) => {
          const c = document.querySelector('#messages') as HTMLElement
          const before = new Map<string, HTMLElement>()
          for (const id of sids) {
            const el = c.querySelector(`[data-message-id="${id}"]`) as HTMLElement | null
            if (el) before.set(id, el)
          }
          const forkEl = c.querySelector(`[data-message-id="${aid}"]`) as HTMLElement | null
          const t0 = performance.now()
          const frames: any[] = []
          let raf = 0
          let running = true
          const tick = () => {
            if (!running) return
            const cr = c.getBoundingClientRect()
            const forkOff = forkEl ? forkEl.getBoundingClientRect().top - cr.top : -9999
            const divider =
              (document.querySelector(`[data-divider-key="${aid}::main"]`) as HTMLElement | null) ||
              (document.querySelector(`[data-testid="branch-fork-divider-${aid}-main"]`) as HTMLElement | null) ||
              (document.querySelector(`[data-testid="branch-fork-toggle-${aid}"]`) as HTMLElement | null) ||
              (document.querySelector(`[data-testid="branch-fork-selected-${aid}"]`) as HTMLElement | null)
            const divOff = divider ? divider.getBoundingClientRect().top - cr.top : -9999
            const incomingIds: string[] = (window as any).__fork_incoming ?? []
            const incomingSum = incomingIds.reduce((acc: number, mid: string) => {
              const el = c.querySelector(`[data-message-id="${mid}"]`) as HTMLElement | null
              return acc + (el ? el.getBoundingClientRect().height : 0)
            }, 0)
            frames.push({
              t: Math.round((performance.now() - t0) * 10) / 10,
              forkOff: Math.round(forkOff * 10) / 10,
              divOff: Math.round(divOff * 10) / 10,
              st: Math.round(c.scrollTop * 10) / 10,
              sh: c.scrollHeight,
              ch: c.clientHeight,
              phase: c.getAttribute('data-viewport-phase'),
              vis: getComputedStyle(c).visibility,
              incomingSum: Math.round(incomingSum * 10) / 10
            })
            raf = requestAnimationFrame(tick)
          }
          tick()
          ;(window as any).__fork_probe = {
            before,
            frames,
            t0,
            raf,
            forkWant,
            w,
            stop: () => {
              running = false
              try {
                cancelAnimationFrame(raf)
              } catch {}
            }
          }
        },
        { aid: anchorId, sids: sharedIds.slice(-4), w: wantOffset, forkWant: beforeToggle.forkOff }
      )
      const incomingForProbe = to === null ? mainExclusives : branchSuffix
      await page.evaluate((ids: string[]) => {
        ;(window as any).__fork_incoming = ids
      }, incomingForProbe)
      const itemSel = to === null ? `branch-fork-item-parent-${anchorId}` : `branch-fork-item-${to}`
      await page.locator(`[data-testid="${itemSel}"]`).first().click()
      await waitActive(page, topicId, to)
      await waitVisible(page)
      await page.evaluate(
        () => new Promise<void>((res) => requestAnimationFrame(() => requestAnimationFrame(() => res())))
      )
      await page.evaluate(
        () => new Promise<void>((res) => requestAnimationFrame(() => requestAnimationFrame(() => res())))
      )
      const probe: any = await page.evaluate(
        ({ aid, sids, w }: any) => {
          const p: any = (window as any).__fork_probe
          try {
            p?.stop?.()
          } catch {}
          const c = document.querySelector('#messages') as HTMLElement
          const frames = p ? [...p.frames] : []
          const before: Map<string, HTMLElement> = p?.before ?? new Map()
          const forkWant: number = p?.forkWant ?? w
          const divWant: number = p?.w ?? w
          const perId = sids.map((id: string) => {
            const cur = c.querySelector(`[data-message-id="${id}"]`) as HTMLElement | null
            const orig = before.get(id) ?? null
            return { id, same: !!(orig && cur && orig === cur), curAttached: !!cur?.isConnected }
          })
          const forkDeltas = frames.map((f: any) => Math.abs(f.forkOff - forkWant))
          const divDeltas = frames.map((f: any) => Math.abs(f.divOff - divWant))
          const hidden = frames.filter((f: any) => f.vis === 'hidden').length
          let firstBad = -1
          for (let i = 0; i < frames.length; i++)
            if (forkDeltas[i] > 12 || divDeltas[i] > 12) {
              firstBad = i
              break
            }
          const incoming = ((window as any).__fork_incoming as string[]) ?? (to === null ? [] : [])
          const incomingHeights = incoming.map((mid: string) => {
            const el = c.querySelector(`[data-message-id="${mid}"]`) as HTMLElement | null
            return el ? Math.round(el.getBoundingClientRect().height * 10) / 10 : -1
          })
          const result = {
            frames,
            hidden,
            firstBad,
            perId,
            incomingHeights,
            st: c.scrollTop,
            sh: c.scrollHeight,
            ch: c.clientHeight,
            phase: c.getAttribute('data-viewport-phase'),
            vis: getComputedStyle(c).visibility
          }
          delete (window as any).__fork_probe
          delete (window as any).__fork_incoming
          return result
        },
        { aid: anchorId, sids: sharedIds.slice(-4), w: wantOffset }
      )
      // timeline + firstBad context
      let firstBadDetail = 'none'
      if (probe.firstBad !== -1) {
        const fb = probe.frames[probe.firstBad]
        const prev = probe.firstBad > 0 ? probe.frames[probe.firstBad - 1] : null
        const next = probe.firstBad + 1 < probe.frames.length ? probe.frames[probe.firstBad + 1] : null
        // detect incoming height grow vs fixed
        const h0 = probe.frames[0]?.incomingSum ?? -1
        const hb = fb?.incomingSum ?? -1
        firstBadDetail = `firstBad=${probe.firstBad} fb=${JSON.stringify(fb)} prev=${JSON.stringify(prev)} next=${JSON.stringify(next)} incomingSum 0->fb ${h0}->${hb} grow=${hb !== h0}`
      }
      console.log(
        `[LEG-${label}] frames=${probe.frames.length} hidden=${probe.hidden} firstBad=${probe.firstBad} ${firstBadDetail} st=${probe.st} sh=${probe.sh} ch=${probe.ch} phase=${probe.phase} vis=${probe.vis} incomingHeights=${probe.incomingHeights}`
      )
      // also log first few frames for timeline
      console.log(
        `[LEG-${label}-FRAMES] ${JSON.stringify(probe.frames.slice(0, 5))} ... ${JSON.stringify(probe.frames.slice(-3))}`
      )
      test.info().annotations.push({
        type: `leg-${label}`,
        description: `frames=${probe.frames.length} hidden=${probe.hidden} firstBad=${probe.firstBad} ${firstBadDetail} st=${probe.st} sh=${probe.sh} ch=${probe.ch} phase=${probe.phase} vis=${probe.vis} incomingHeights=${probe.incomingHeights} perId=${JSON.stringify(probe.perId.map((p: any) => p.same))}`
      })
      expect(probe.hidden, `${label} hiddenFrames must be 0 for eligible visible path`).toBe(0)
      expect(probe.firstBad, `${label} fork/divider displacement must stay <=12px`).toBe(-1)
      for (const r of probe.perId) expect(r.same, `${label} shared ${r.id} must keep DOM identity`).toBe(true)
      const active: string | null = await page.evaluate(
        (tid: string) => (window as any).store.getState().topicBranch?.activeBranchIdByTopic?.[tid] ?? null,
        topicId
      )
      expect(active).toBe(to)
      for (const mid of to === null ? mainExclusives : branchSuffix)
        expect(await page.evaluate((id: string) => !!document.querySelector(`[data-message-id="${id}"]`), mid)).toBe(
          true
        )
      for (const mid of to === null ? branchSuffix : mainExclusives)
        expect(await page.evaluate((id: string) => !!document.querySelector(`[data-message-id="${id}"]`), mid)).toBe(
          false
        )
      return probe
    }
    const p1 = await runLeg(null, branchId, 'main->branch', want)
    const p2 = await runLeg(branchId, null, 'branch->main', want)
    test.info().annotations.push({
      type: 'summary',
      description: `topology common=${COMMON} mainTail=${mainExclusives.length} branchTail=${branchSuffix.length} legs=2 want=${want} inter=[${interLow},${interHigh}] ch=${ch} p1Frames=${p1.frames.length} p2Frames=${p2.frames.length}`
    })
  })
})
