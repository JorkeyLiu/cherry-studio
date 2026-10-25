# Pagination Cap and Browse-Render Convergence — Followup Record

> **Status**: Followup record for the unified bidirectional paging + browse-input render-containment unit. The committed scope is validated; the cap-bound continuous-paging residual is **explicitly deferred** — observed, bounded, and not fixed, not claimed fixed.
> **Role**: Owns the deferred-outcome statement, the verification bounds of the sustained real-key observation, the reproduction steps, the open inspection list, and the current test state. Paging/product semantics stay with the code and its tests; this document introduces no new contract.
> **Scope discipline**: Records no raw user content, no user-data paths, and no profiler artifact paths.
> **Last updated**: 2026-10-18

## 1. Delivered and validated in this unit

- **One browse-edge gate for both directions.** The former external scroll-library `next`/latch was replaced by a single app-owned gate that fires only from genuine user navigation at the direction's edge, decided against actual geometry (navigation idle + user scroll mode, live user gesture session, no route transition owning the viewport, no restore-owned divider search, live container at that direction's edge).
- **Stable-input broadcast containment (root source fix).** Genuine input publishes a viewport notification only on the idle → live transition; the per-repeat path no longer broadcasts. Message rows subscribe to the stable command surface instead of the versioned projection, so a notification no longer re-renders the mounted conversation.
- **Bidirectional paging internals.** Current-store atomic pagination with typed merge and missing-anchor fail-closed cancel plus route-generation lease; Main-side branch/ref-group boundaries; keeper paired-sample + bounded-trim preflight; navigation-disjoint rebase.
- **Measured effect** (single 1600x1000 isolated production snapshot, real imported long topic, held native PageUp/PageDown): Phase-B `ScriptDuration` 9.486 s → 0.909 s, Phase-B long tasks 10 → 0, accepted keydown median interval 383 ms → 31 ms, and the older-page fetch now starts ~0.5 s into the hold instead of at the gesture end. Whole-run long tasks 133 → 5; `defaultPrevented` 0 in both, app scroll writes 0 in both.

## 2. Deferred residual — cap-bound continuous paging

The display window has a **220-group calibration cap**. Under sustained real input the loaded window can pin at exactly that cap (oldest edge index stationary, newest edge not regressing, e.g. a resident `100..319 (n=220)` window) while the viewport repeatedly reaches the clamped oldest edge and is pushed back by roughly the same distance each time. The cap's opposite-edge trim — the next older page committing and trimming the newer edge — is then not observed.

- **Intermittent.** It does not reproduce on every run: earlier runs advanced 100 → 200 → 220 normally and passed their legs, while the newer-cap scenario run failed its growth step. Retried runs of the same scenario reproduced the stall.
- **Occasional jump at a commit boundary.** The sampled scroll position changes by ~2–3 k px with the keys still held and zero app-authored scroll writes. This is consistent with the live native page animation rather than an app-authored jump, but it was **not** isolated.
- **Not attributed.** Whether the cause is "the edge trigger never fired", "the fetch was refused by the single-owner pagination fetch lease", or "the fetch returned no older page" could not be distinguished: the in-flight pagination fetch is not observable from the E2E spec. The dead pagination-hold arm has no production reader; that arm is accepted as deferred rather than removed in this unit.

## 3. Verification bounds of the sustained real-key observation

- Held-key input was a CDP `keyboard.down` with auto-repeat at a fixed ~30 ms non-awaited schedule plus a single `keyup` — a repeat **proxy**, not genuine OS auto-repeat. Genuine OS-level held-key repeat through the fetch wait was **not** tested.
- One run per leg: no distribution, no repetition statistics.
- All rendered/interactive evidence comes from the isolated production snapshot at 1600x1000 with a disposable profile; the live development window was never reloaded or restarted.
- The residual stall was observed at the cap under sustained paging, but the boundary between "large-window continuous reading is fast" and "continuous reading stalls once the cap is reached" is therefore only bounded, not closed.

## 4. Steps to reproduce the remaining regime

1. Build a fresh production bundle from the current worktree.
2. Launch the isolated build at 1600x1000 with a disposable profile and a real long topic that exceeds the 220-group calibration cap.
3. Focus the message scroll host and drive **real native** PageUp/PageDown input: both discrete presses and a genuinely held key that stays down through the whole fetch wait and the commit.
4. Observe each step's loaded window span, the oldest/newest edge indices, the reading-row offset, and app-authored scroll writes.
5. Expected (currently not reliable at the cap): the oldest edge advances past the cap while the reading row stays held inside the offset tolerance and no app-authored scroll write appears.

## 5. What still needs inspection

1. Which gate predicate holds the page at the clamped edge once the cap is reached (edge vicinity, direction confirmation, in-flight direction loading, fetch-lease ownership, programmatic ownership, divider search, live session, exact-edge geometry).
2. Whether the older fetch is actually issued at the clamped edge, and what it returns (no rows vs. refused vs. committed-but-not-trimmed) — needs a Main-side observation of the window-fetch request around the stall.
3. Whether the commit-window scroll change is app-authored or purely native animation — needs an instrument correlating a Main-side commit with the renderer scroll position.
4. Genuine OS-level held-key repeat through the wait, on a real desktop session.

## 6. Test state

- Of the eight conversation paging E2E scenarios (keyboard viewport scroll + older/newer held position), seven are enabled and pass; the newer-cap scenario ("newer page at the clamped newest edge … and trims inside one page") is marked `test.fixme` with an inline reason pointing here. Its assertions are retained unmodified for the future.
- The unit is therefore **not** presented as fully green: one known scenario is deferred, matching §2.
