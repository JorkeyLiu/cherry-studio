# Chat normal-flow evaluation — formal migration record (main checkout)

> Status: **正式结果待补** — this unit implements and statically checks only;
> no `pnpm build` / Playwright E2E was run here (production parallel not ready).
> The durable adapted E2E assets and the two new combo cases below are
> **unverified on the migrated tree** until the exact commands in §0 are run.
>
> Prototype history: the body (§1–§7) is copied **verbatim** from the persistent
> prototype report
> `/Users/jorkeyliu/workspace/worktrees/cherry-chat-normal-flow-prototype/docs/work/chat-normal-flow-evaluation.md`
> (177 lines, prototype base `71d77aacd0`) as **prototype-history evidence
> only**. Its unit/build/rendered numbers were measured on the prototype
> worktree state and **cannot count as a final-state pass** for the formal
> migration (main checkout, HEAD `a327b7f`, normal-flow implementation +
> adapted E2E assets). Observation backup (persistent sibling):
> `/Users/jorkeyliu/workspace/worktrees/cherry-chat-normal-flow-observations/`;
> per-run scratch artifacts per the §2 paths inside the copied body.
>
> ## §0. Formal-migration delta (this checkout, to be proven by rerun)
>
> - Adapted persistent E2E assets to the normal-flow coordinate
>   (top/oldest 0, bottom/newest max(0, sh − ch)): shared
>   `tests/e2e/utils/viewport-scroll-sync.ts` (+ its unit test) and all
>   consumer specs — `older-pagination-held-position`,
>   `page-viewport-resume`, `conversation-navigation`,
>   `streaming-click-pause`, `chat-scroll-intent`,
>   `keyboard-viewport-scroll`, fold region (`fold-region`,
>   `message-fold`), `top-visible-incremental-rebase`, `true-branch`,
>   `route-settings-session`, `fork-viewport-asymmetric` — plus the three
>   run-geometry diag scenarios (`route-residual-midviewport`,
>   `route-displayed-transient`, `route-default-topic-real`). Business
>   semantics and strictness kept; no relaxed tolerances, no deleted
>   assertions; `Math.abs` kept only for displacement diffs.
> - New long-value combo coverage (mock-only streaming, no new fixture
>   subsystem): (a) `older-pagination-held-position.spec.ts` —
>   `older prepend during an active extended slow stream holds the mid-list
>   reading anchor` (history pagination × sustained streaming growth, same
>   user reading anchor); (b) `fold-region.spec.ts` round trip pinned to
>   conventional 1280×800 desktop geometry.
> - Still to run (exact commands + expected case counts in the unit's closing
>   report); uncovered risks: the three untouched reverse-flow files
>   (`message-editor-codemirror`, `lazy-activation`,
>   `inheritance-boundary-undo`) and wider geometries/DPR/zoom (deferred to a
>   follow-up observation unit; no global fixture/config change).

--- Prototype-history evidence below (verbatim copy; not a final-state pass) ---

# Chat normal-flow prototype — evaluation (prototype worktree only)

Scope: implementation reconnaissance + bounded F1 fix + rendered comparison of a
**normal document flow** (`column`) Messages viewport against the
`column-reverse` baseline. Comparison only — **not a production rollout
proposal**. This file lives inside the prototype worktree
(`normal-flow-prototype`, detached at `71d77aacd0`) and changes nothing in the
main repository, ADRs, or root governance.

- Base: `71d77aacd0` (`jorkey/integration` at the time the worktree was created).
- Final status: source frozen; unit gate 128 files / 1759 tests PASS; `pnpm build`
  exit 0 (post lint-autofix, see §5); three final rendered scenarios
  (fold / stream / paging) PASS on both states; full-cycle ablation contrast
  recorded (§4). No durability claim is made here (see §7).

## 1. Mechanism ledger (what the prototype changes, from its own diff)

Removed:

- `columnReverseGeometry.ts` → renamed to `flowScrollGeometry.ts` (bottom/top
  distances, thresholds, and coordinate-space tag redefined for normal flow).
- The viewport pixel-quantum synchronisation path is gone: its contract test
  `viewportPixelQuantum.test.tsx` is deleted, and the wrapper contract test now
  asserts bottom-alignment by auto margin with no quantum workaround on either
  side (`Messages.contentWrapperIntrinsic.test.ts`).
- Legacy `scroll:topic-<id>` records are coordinate-gated: `normalizeSaved`
  (exported from `useScrollPosition.ts`, applied in
  `getLegacyMainSavedPosition`) drops foreign-space numeric offsets while
  preserving the convention-independent identity anchor
  (`messageId`/`anchorId` + `intraRowOffset`) and the bottom classification;
  anchorless foreign numbers fall through to the bottom/latest default. Covers
  findings item F1; no new migration subsystem, no call-site changes.

Retained:

- Interaction-region keeper hold (reading-row pinning during row-height
  change), fold settle pass, and ordinary user/manual scroll ownership. The
  guard experiments (§4) observe their *writes*, they do not remove them.

## 2. Outcome table — baseline vs prototype, same scenarios and seeds

Full per-run artifacts (manifests, summaries, frame samples, captures) live in
the scratch comparison directory, not in any repository:

- Method + baseline rows + failure record:
  `/Users/jorkeyliu/.pi-desktop/scratch/9fd45c4c-5164-46c4-811f-eb42ad166eee/normal-flow-observations/README.md`
 - Run artifacts:
   `/Users/jorkeyliu/.pi-desktop/scratch/9fd45c4c-5164-46c4-811f-eb42ad166eee/normal-flow-observations/runs/`
   (prior: `baseline-fold`, `baseline-stream`, `baseline-paging`,
   `baseline-fullcycle`, `final-prototype-fold`, `final-prototype-stream`,
   `final-prototype-paging`, `final-prototype-fullcycle`,
   `final-prototype-ablation-rapid`; **delivered on the final formatted build
   (§3): `delivered-prototype-fold`, `delivered-prototype-stream`,
   `delivered-prototype-paging`, `delivered-prototype-fullcycle`)

| Scenario | Baseline (`reversed`) | Prototype (`normal`) |
| --- | --- | --- |
| fold-reversal-stability | PASS, anchor drift 0.00 px, pointer mismatch 0/324 | PASS, anchor drift 0.00 px, pointer mismatch 0/324 |
| stream-read-follow | PASS, bottom maxAbs 0.00 px, reading-anchor drift 0.00 px | PASS, identical numbers, `layoutSet = {normal}` |
| paging-restore-navigation | PASS, commits held 0.37 / 0.44 px, restore drift 0.32 px | PASS, same values to the digit |
| full-cycle fold ablation | 30 setter attempts blocked, anchor settled 0 px, shell-top excursion 1998.01 px (= expansion size) | 0 setter attempts, anchor 0.00 px all 864 frames, shell-top 0.00 px |

The positional numbers reproduce with only the axis flipped (`reversed` →
`normal`, negative `scrollTop` → positive, identical `distBottom` semantics).
The layout difference is the intended experimental treatment, compared under
identical scenario files, seeds, and guards — it is not admitted here as a
confound or blocker. The prototype diff touches 54 files, so no claim is made
isolating any single source contributor; the scoped claim is the observed
 ## 3. Freshness note (code vs observed build) — CLOSED by delivered verification
 
 The post-autofix finalizer changes (9 files, import order / whitespace only,
 no behaviour change) were rebuilt (`pnpm build` exit 0; `out/main/index.js`
 and `out/renderer/index.html` stamped 2026-11-19 10:59:45/47) and the four
 scenarios re-executed unchanged against that fresh `out/`, worktree at 56
 status lines (55 implementation + the untracked evaluation file and F1 gate
 test), no scenario edits, no baseline rerun (baseline unchanged):
 
 - `runs/delivered-prototype-fold` — EXIT 0, manifest 24078 ms, all 6 checks
   True (topology `normal`/`column`; anchor drift 0.00 px over 323 frames;
   pointer mismatch 0; phases `expanding → collapsing → none`, latency 7 ms).
 - `runs/delivered-prototype-stream` — EXIT 0, manifest 27822 ms, all 10
   checks True (phase-A bottom maxAbs 0 px over 154/154 streaming frames,
   +999 chars; reading anchor 0 px over 215 frames while +1448 chars arrived;
   phase-C maxAbs 0 px over 116 frames; `layoutSet = {normal}`).
 - `runs/delivered-prototype-paging` — EXIT 0, manifest 33739 ms, all 8 checks
   True (20 → 60 over 2 pages, 39 wheels; commits held 0.37 / 0.44 px; B→A
   restore drift 0.32 px; `distBottom` 22836, no bottom snap).
 - `runs/delivered-prototype-fullcycle` — EXIT 0, manifest 31132 ms, all 7
   checks True (complete 1998 px expansion settled + collapse completed;
   guard attempted 0 / blocked 0 / realized 0, SIV/scrollTo/scrollBy 0;
   anchor + shell drift 0.00 px all 864 frames; `criterion.met = true`,
   reading `zero-attempted`).
 
 Command pattern (prototype worktree cwd, pinned Node v24.11.1 / pnpm 10.27.0,
 Bash foreground, 1800 s budget each, one shot, no retries): `pnpm ui:observe
 "$S/<scenario>" -- --output-dir "$S/runs/delivered-prototype-<name>"
 --timeout-ms 300000`; `S=…/normal-flow-observations`. Success logs cleaned
 per task order; comparison artifacts (summaries, frames, captures) retained.
 Conclusions stay scoped to this measured prototype behaviour; the earlier
 `final-prototype-*` runs (pre-format build) are retained as superseded.
behaviour. The rendered observations therefore stand for the evaluated
behaviour; a rollout would still rebuild and re-run.

## 4. Guard experiment and its limits

The `scrollTop`-setter guard intercepts only the `#messages` instance setter
(forwards gets, logs + drops non-same-value writes while armed); `scrollTo` /
`scrollBy` / `scrollIntoView` are counted passively (0 calls observed);
`window.scroll*`, `scrollIntoViewIfNeeded`, and prototype-level descriptors are
not intercepted. Findings: baseline full-cycle expansion drew 30 blocked setter
attempts with the reading anchor settling at 0 px; prototype drew 0 attempts
with 0 drift across the same ~1998 px expansion. Rapid (8 ms) reversal is
non-discriminating on both states (≤ 2 px transient inside tolerance).

Explicitly not probed: restore/navigate phases are measured post-settle only
(no mid-transition sampling); navigation uses sidebar/topic-list clicks, not
keyboard; single-DPR harness windows with a 347 × 402 `#messages` host; no
paging-during-stream combo; no durable `tests/e2e` asset admitted. Two
`baseline-paging` failures during the window were a scenario-side bug (deleted
`activateTopic` line), fixed in the scenario, with passing reruns reusing the
output dirs — no product claim is drawn from them.

## 5. Unit / build / lint evidence (exact exits, attribution)

Toolchain for every command: pinned Node `v24.11.1`, pnpm `10.27.0`. All runs
in the prototype worktree; logs for passing runs were cleaned per task order
(commands below re-verified post-fix where noted).

- Focused regression (Messages `__tests__` + `useScrollPosition.test.ts`,
  includes the 4 new F1 gate tests): `pnpm native:run node -- vitest run …` →
  exit 0, **128 files / 1759 tests passed** (final post-autofix run; pre-autofix
  run identical at 128/1759).
- `pnpm build` → exit 0 (final post-autofix run; pre-autofix run also exit 0,
  invalidated as evidence only by the import reorder, which is
  behaviour-neutral).
- Affected-file lint/format over all 54 changed TS/TSX files (read-only first):
  `biome format` exit 1 (8 files with wrap/spacing deviations),
  `eslint` exit 1 (2 `simple-import-sort` errors in
  `routeViewportContext.tsx` and `streamingFollowResume.test.ts`),
  `oxlint` exit 0 (0 errors, 26 warnings). Fixed with `eslint --fix` on the 2
  files plus `biome format --write` on the 8 files — import order and
  whitespace only, no behaviour change, so the §3 freshness statement stands.
  Re-verified: `biome format` exit 0, `eslint` exit 0 (0 errors; 15
  pre-existing `exhaustive-deps` warnings in untouched regions), `oxlint`
  exit 0, `git diff --check` exit 0.

tsgo was not run for this closure (prior `TS6307`-only report claimed a
baseline without a clean-HEAD proof; no baseline classification is repeated
here). The retained `tsgo-web-*.log` files predate this closure and are kept
only as unverified diagnostics (see §6).

## 6. Provenance notes

- The observation README records baseline builds from `out/` produced at 09:19
  on `71d77aacd0`, before the concurrent unrelated commit `a327b7f00a`
  (`fix(chat): rename selected-turn fold menu label` — one i18n label string
  plus its specs). No viewport, fold, paging, restore, or streaming code
  differs between the observed build and current `HEAD`; no false provenance
  is claimed for the comparison.
- No live profile, user-data path, or raw payload is recorded in this file or
  linked from it; all seeds are disposable throwaway rows in harness-owned
  disposable profiles.

## 7. Decision and remaining evidence

Nexus recommendation: migrate the Messages viewport to normal flow, because the
common layout becomes the natural one — compensation writes observed on the
legacy axis (30 blocked attempts per full fold cycle) have no counterpart
under normal flow (0 attempts, 0 drift), while every held/restored-position
number reproduces exactly. Rollout is a separate decision and is **not**
authorised by this evaluation.

Remaining evidence before any rollout: durable E2E adaptation of the three
comparison scenarios (admission is a separate owner decision), plus wider
viewport geometries, additional DPRs, keyboard navigation, mid-transition
restore sampling, and paging-during-stream coverage. No `production ready`
claim is made.
