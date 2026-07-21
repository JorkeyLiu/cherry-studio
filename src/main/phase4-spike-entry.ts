/**
 * Phase 4.0-A/B/C1/C2a/C2b Spike Entry Point
 *
 * TEST/FEASIBILITY-ONLY. Not referenced by any production entry point.
 * Excluded from normal builds by PHASE4_SPIKE gating in electron.vite.config.ts.
 * Retained through Phase 4.1 as reproducibility harness.
 *
 * Minimal entry that imports only the spike harness. Does NOT fall through
 * to the normal app entry (that would inline ~24 MB of unrelated code and
 * trigger side-effects from bootstrap/config before the spike can set an
 * isolated userData path).
 *
 * Build:   PHASE4_SPIKE=1 npx electron-vite build
 * Launch:  env -u ELECTRON_RUN_AS_NODE npx electron .
 *    or:   scripts/phase4-spike.sh
 *    or:   scripts/phase4-fixtures.sh
 *    or:   scripts/phase4-verify.sh
 *    or:   scripts/phase4-c2a.sh
 *    or:   scripts/phase4-c2b.sh
 *
 * Mode detection:
 *   --fixture=v4|v11a|v11b|v12   → Phase 4.0-B fixture generation
 *   --verify=<manifest-root>     → Phase 4.0-C1 verification
 *   --c2a=<manifest-root>        → Phase 4.0-C2a retained-session isolation
 *   --c2b=<workspace>            → Phase 4.0-C2b Local Storage necessity
 *   (no flag)                    → Phase 4.0-A ping round trip
 */

// Belt-and-suspenders: detect ELECTRON_RUN_AS_NODE early.
// The launcher script unsets it; this catches direct `electron .` invocations
// where the caller forgot to unset it.
if (process.env.ELECTRON_RUN_AS_NODE) {
  console.error('[phase4-spike] ERROR: ELECTRON_RUN_AS_NODE is set.')
  console.error('[phase4-spike] This process must run as an Electron app, not as Node.')
  console.error('[phase4-spike] Use: env -u ELECTRON_RUN_AS_NODE electron .')
  process.exit(2)
}

/* ── Detect mode from argv ── */
const fixtureArg = process.argv.find((a) => a.startsWith('--fixture='))
const verifyArg = process.argv.find((a) => a.startsWith('--verify='))
const c2aArg = process.argv.find((a) => a.startsWith('--c2a='))
const c2bArg = process.argv.find((a) => a.startsWith('--c2b='))

if (c2bArg) {
  const workspace = c2bArg.split('=')[1]
  import('./phase4-c2b')
    .then(({ runC2bVerifier }) => runC2bVerifier(workspace))
    .catch((err) => {
      console.error('[phase4-spike] C2b entry failed:', err)
      process.exit(2)
    })
} else if (c2aArg) {
  const manifestRoot = c2aArg.split('=')[1]
  import('./phase4-c2a')
    .then(({ runC2aVerifier }) => runC2aVerifier(manifestRoot))
    .catch((err) => {
      console.error('[phase4-spike] C2a entry failed:', err)
      process.exit(2)
    })
} else if (verifyArg) {
  const manifestRoot = verifyArg.split('=')[1]
  import('./phase4-spike')
    .then(({ runVerifier }) => runVerifier(manifestRoot))
    .catch((err) => {
      console.error('[phase4-spike] Verify entry failed:', err)
      process.exit(2)
    })
} else if (fixtureArg) {
  const fixtureId = fixtureArg.split('=')[1]
  import('./phase4-spike')
    .then(({ runFixture }) => runFixture(fixtureId))
    .catch((err) => {
      console.error('[phase4-spike] Fixture entry failed:', err)
      process.exit(2)
    })
} else {
  import('./phase4-spike')
    .then(({ runSpike }) => runSpike())
    .catch((err) => {
      console.error('[phase4-spike] Entry failed:', err)
      process.exit(2)
    })
}
