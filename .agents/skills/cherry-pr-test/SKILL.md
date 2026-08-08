---
name: cherry-pr-test
description: Exploratory PR UI validation for Cherry Chat — checks out a PR, runs static analysis, runs relevant existing Playwright E2E specs when available, and launches the Electron app in debug mode for interactive CDP observation. Screenshots/CDP are diagnostic observations, not final regression evidence; standard regression evidence comes from the repo Playwright suite (tests/e2e/README.md).
---

# Cherry Chat PR Test

Exploratory PR UI validation workflow for Cherry Chat. Checks out a PR,
performs static analysis, runs any relevant existing Playwright E2E spec, and
launches the Electron app in debug mode for interactive UI observation via
agent-browser/CDP. Produces an evidence-classified report.

This skill is **exploratory/diagnostic by design**. It helps understand and
triage PR behavior, but it does **not** replace the repository Playwright E2E
suite.

## Evidence Classification (READ FIRST)

Per the repository UI testing standard (AGENTS.md "E2E Testing" and
`tests/e2e/README.md`):

- **Standard regression evidence comes from the Playwright Electron E2E suite**
  (`tests/e2e/`), run against a fresh production build (`pnpm build`) with the
  standard `tests/e2e` fixture, a unique disposable user profile, mocked
  external providers, and deterministic assertions.
- **This skill may run existing repo Playwright specs** — scoped to the
  behavior the PR changes — and report their results as automated evidence
  (LOCK-UI2). It does not write new regression tests and does not improvise a
  one-off regression pass of its own.
- **Screenshots, manual CDP sessions, agent-driven browsers, and dev-mode runs
  are diagnostic only — never sufficient regression evidence (LOCK-UI3).**
- Dev-mode interactive observation is useful for triage and understanding, but
  cannot alone establish that a PR is regression-free.

The final report MUST state the evidence level:

- `exploratory-only` — CDP/agent-browser observations only; no Playwright
  coverage was run for the changed behavior.
- `exploratory + Playwright` — a relevant repo Playwright spec also ran on the
  PR branch.

The report MUST separate (LOCK-UI9): standard Playwright results, exploratory
findings, and missing automated coverage.

Reproducible regressions discovered during exploration MUST be recommended
(or, when requested, added) as Playwright coverage under `tests/e2e/specs`.

## Prerequisites

- `gh` CLI installed and authenticated
- `agent-browser` installed (for CDP-based interactive observation)
- `pnpm` installed with project dependencies (`pnpm install`)
- For the Playwright phase: fresh production build via `pnpm build`

## Constraints

- **Ownership-scoped cleanup only (LOCK-UI8).** This skill terminates only
  processes it launched and deletes only paths it created. Never use
  `pkill -f`, `killall`, or `lsof -ti :<port> | xargs kill` — those patterns
  can affect unrelated sessions. Never delete a profile directory this
  invocation did not create.
- **Fail-closed cleanup (LOCK-UI8).** Every delete or signal requires non-empty
  `PR_NUMBER`, `RUN_ID`, `TOKEN`, `PROFILE_DIR`, `WORK_DIR` and exact expected
  path equality under `/tmp` derived from those values (the Phase 6/8 guard).
  Uncertainty means abort and report, never guess. `REPORT_DIR` is validated
  but never deleted.
- **Never kill processes we do not own.** If the CDP port is already in use
  before launch, abort and report the conflict; do not kill the owner.
- **Ownership contract for termination.** Never leave debug processes running
  after testing completes. The exact-token owned processes (exact argv element
  match on `--user-data-dir=<PROFILE_DIR>`) must be gone; afterward probe port
  9222 and report any remaining listener without killing it or attributing it
  to this invocation. lsof probe errors remain fail-closed (BLOCKER).
- **Branch safety.** Record the branch or commit active before checkout — a
  detached HEAD is recorded as its commit SHA — and restore that exact state
  afterwards. Require a clean worktree (or an isolated worktree) before
  checking out a PR; abort safely if the tree is dirty — never stash, reset,
  or force.
- Always show the test report to the user before posting it.
- **Report before cleanup.** Generate and show the report before removing
  temporary runtime resources. The report artifact lives in a separate report
  directory that cleanup never deletes.
- Screenshots and CDP observations are **diagnostic evidence only (LOCK-UI3)**;
  they must not be reported as E2E/regression proof. Regression claims are only
  supported by the repo Playwright suite (LOCK-UI2).
- **Regression contract.** This skill runs existing repo Playwright specs when
  they cover the changed behavior; it cannot manufacture E2E proof for
  behavior no spec covers. If a PR changes behavior that no Playwright spec
  covers, say so, list it as missing automated coverage, and recommend
  coverage; do not claim the interactive pass substitutes for it.

## Arguments

`$ARGUMENTS` may contain:
- A PR number (e.g., `13955`)
- A PR URL (e.g., `https://github.com/CherryHQ/cherry-studio/pull/13955`)
- Keywords like "latest", "recent" to pick a recent PR
- Empty — list recent PRs and let the user choose

## Workflow

The phases run in a strict, sequential order — no phase starts while an earlier
phase is still running unless the phase text explicitly says otherwise:

1. Select & checkout PR
2. Inspect & map changes to existing specs
3. Build to completion
4. Automated regression (scoped Playwright)
5. Static analysis (optional)
6. Exploratory launch & CDP observation (optional)
7. Test report (before cleanup)
8. Cleanup & branch restore

### Phase 1: Select & Checkout PR

1. If no PR number given, list recent open PRs:
   ```bash
   gh pr list --repo CherryHQ/cherry-studio --state open --limit 10 \
     --json number,title,author,createdAt,headRefName,changedFiles \
     --template '{{range .}}#{{.number}} | {{.title}} | by {{.author.login}} | files: {{.changedFiles}}
   {{end}}'
   ```
2. Ask the user to pick one (or auto-pick if "latest"/"recent").
3. View PR details to understand what changed:
   ```bash
   gh pr view <NUMBER> --json title,body,headRefName,files
   ```
4. **Record the original state (branch or detached commit) and verify a clean
   worktree** *before* any checkout. A detached HEAD is recorded as its commit
   SHA so Phase 8 can restore the exact detached state. Abort safely if the
   tree is dirty — never stash, reset, or force:
   ```bash
   if git symbolic-ref -q HEAD >/dev/null 2>&1; then
     ORIGINAL_BRANCH="$(git symbolic-ref --short -q HEAD)"
     ORIGINAL_COMMIT=""
   else
     ORIGINAL_BRANCH=""
     ORIGINAL_COMMIT="$(git rev-parse HEAD)"
   fi
   STATUS_RC=0
   STATUS_OUTPUT=""
   STATUS_OUTPUT="$(git status --porcelain 2>&1)" || STATUS_RC=$?
   if [ "${STATUS_RC}" -ne 0 ]; then
     echo "BLOCKER: git status failed (exit ${STATUS_RC}) — cannot verify a clean worktree before checkout."
     exit 1
   fi
   if [ -n "${STATUS_OUTPUT}" ]; then
     echo "BLOCKER: worktree has uncommitted changes (branch: '${ORIGINAL_BRANCH:-<detached commit>}')."
     echo "Commit/stash them or use an isolated worktree (git worktree add) before running this skill."
     exit 1
   fi
   ```
   Keep `ORIGINAL_BRANCH` / `ORIGINAL_COMMIT` for Phase 8.
5. Checkout the PR branch and record it:
   ```bash
   gh pr checkout <NUMBER>
   PR_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
   ```
6. Read the key changed files to understand the scope of changes.

### Phase 2: Inspect & Map Changes to Existing Specs

Determine, before building, what automated coverage could apply.

1. **List the PR's changed files**:
   ```bash
   gh pr view <NUMBER> --json files --jq '.files[].path'
   ```
2. **Map the changes to existing Playwright specs**: search
   `tests/e2e/specs/` for specs that cover the changed behavior (e.g. by
   feature area: `navigation`, `conversation/`, `settings/`, `app-launch`).
   Read the relevant spec(s) to confirm coverage.
3. Record the mapped spec(s) for Phase 4, or conclude that **no existing spec
   covers the changed behavior** — that conclusion becomes "missing automated
   coverage" in the report.

### Phase 3: Build to Completion

Playwright runs against a fresh production build, and the build must finish
before any later phase starts.

- If Phase 2 found relevant specs, build now:
  ```bash
  pnpm build
  ```
- If Phase 2 found **no** relevant specs, no build is required: `pnpm debug`
  (Phase 6) runs in dev mode and does not depend on `pnpm build`.

Wait for `pnpm build` to complete successfully before proceeding. Do not start
Playwright or the debug launch while the build is still running.

### Phase 4: Automated Regression Check (scoped Playwright)

This phase establishes what regression evidence the repo already provides for
this PR's changes. Run it **before** the exploratory launch so the two don't
interfere. This phase runs only when Phase 2 found relevant specs; otherwise
the behavior is reported as missing automated coverage.

1. **If a relevant spec exists**, run it — prefer scoped runs over the full
   suite:
   ```bash
   pnpm playwright test tests/e2e/specs/<relevant>.spec.ts
   # or several specs:
   pnpm playwright test tests/e2e/specs/conversation/basic-chat.spec.ts tests/e2e/specs/navigation.spec.ts
   # full suite when appropriate:
   pnpm test:e2e
   ```
2. **Record results** (passed/failed, which assertions failed) for the report's
   Playwright section.
3. **If no spec covers the changed behavior**: state explicitly in the report
   that no existing Playwright coverage matches, list the behavior as missing
   automated coverage, and mark the evidence level `exploratory-only`. Do not
   run an improvised "regression pass" as a substitute.

### Phase 5: Static Analysis (optional)

Run after the build and Playwright phases. It does not require a running app
and is read-only.

1. **TypeScript typecheck** (catch type errors early). Run it directly and
   capture its exit code — never pipe through `grep`, which masks the real
   exit status:
   ```bash
   set +e
   pnpm typecheck
   TYPECHECK_EXIT=$?
   set -e
   if [ "${TYPECHECK_EXIT}" -eq 0 ]; then
     echo "TYPECHECK OK"
   else
     echo "TYPECHECK FAILED (exit ${TYPECHECK_EXIT})"
   fi
   ```
2. **Review blocked files**: Check if the PR modifies files with
   `@deprecated` / `V2 DATA&UI REFACTORING` headers. These files are blocked
   for feature changes until v2.0.0.
3. **Scan for common issues** — scope the scan to application code (`src/`,
   `packages/`) and exclude test files. `tests/e2e` is exempt entirely: per
   AGENTS.md the Playwright fixture may emit `[E2E]`-prefixed diagnostics by
   design, so they must not be flagged:
   - Hardcoded strings (should use i18n)
   - `console.log` usage (should use `loggerService`):
     ```bash
     rg -n --glob '!**/__tests__/**' --glob '!**/*.test.*' --glob '!**/*.spec.*' \
       'console\.(log|debug|warn)\(' src packages || true
     ```
   - Missing type annotations on new public interfaces

Record all findings for the final report.

### Phase 6: Exploratory Launch & CDP Observation (optional, disposable profile)

The `pnpm debug` script (`electron-vite -- --inspect --sourcemap
--remote-debugging-port=9222`) forwards extra args after `--` to Electron, so a
disposable profile can be passed via `--user-data-dir`. The CDP port is
**hard-coded to 9222** by the script — see Limitations.

Every invocation creates a unique, invocation-owned disposable profile plus a
separate report directory that cleanup preserves. This block is self-contained
and **fail-closed**: it derives every path from `PR_NUMBER` and `RUN_ID`,
validates them before touching anything, and arms interruption/failure traps
that clean the runtime/profile while preserving the report directory. If any
step fails or the block is interrupted, the trap runs the same guarded cleanup.

**This block must run in Bash.** It is a self-contained Bash script (note the
shebang); execute it as Bash — write it to a temporary file and run
`bash <file>`, or paste it into a Bash session. Do not rely on the code-fence
language tag to select the shell.

```bash
#!/usr/bin/env bash
# --- Fail-closed runtime launch ---
# All paths are derived from PR_NUMBER and RUN_ID. Phase 8 uses the same
# derivation and refuses to delete/signal unless the exact values match.
set -euo pipefail

PR_NUMBER=<NUMBER>
RUN_ID="$(date +%s)-$$"
WORK_DIR="/tmp/cherry-pr-${PR_NUMBER}-${RUN_ID}"
PROFILE_DIR="${WORK_DIR}/profile"
LOG_FILE="${WORK_DIR}/debug.log"
REPORT_DIR="/tmp/cherry-pr-${PR_NUMBER}-${RUN_ID}-report"
TOKEN="--user-data-dir=${PROFILE_DIR}"

# Paths created by THIS invocation. Partial-setup cleanup removes only the
# paths this invocation created (CREATED_* flags). REPORT_DIR is preserved
# once created for reporting and is never deleted.
CREATED_WORK_DIR=0
CREATED_REPORT_DIR=0
CREATED_PROFILE_DIR=0
CLEANED=0

# Fail-closed guard: every invocation value must be non-empty and every path
# must equal exactly what this invocation derived from PR_NUMBER/RUN_ID under
# /tmp. On any mismatch: abort and report — never guess.
guard_owned_runtime() {
  if [ -z "${PR_NUMBER}" ]; then
    echo "BLOCKER: PR_NUMBER is empty — refusing to delete or signal anything." >&2
    exit 1
  fi
  if [ -z "${RUN_ID}" ]; then
    echo "BLOCKER: RUN_ID is empty — refusing to delete or signal anything." >&2
    exit 1
  fi
  if [ -z "${TOKEN}" ]; then
    echo "BLOCKER: TOKEN is empty — refusing to delete or signal anything." >&2
    exit 1
  fi
  if [ -z "${PROFILE_DIR}" ]; then
    echo "BLOCKER: PROFILE_DIR is empty — refusing to delete or signal anything." >&2
    exit 1
  fi
  if [ -z "${WORK_DIR}" ]; then
    echo "BLOCKER: WORK_DIR is empty — refusing to delete or signal anything." >&2
    exit 1
  fi
  if [ -z "${REPORT_DIR}" ]; then
    echo "BLOCKER: REPORT_DIR is empty — refusing to delete or signal anything." >&2
    exit 1
  fi
  if [[ ! "${PR_NUMBER}" =~ ^[0-9]+$ ]]; then
    echo "BLOCKER: PR_NUMBER '${PR_NUMBER}' is not numeric." >&2
    exit 1
  fi
  if [[ ! "${RUN_ID}" =~ ^[0-9]+-[0-9]+$ ]]; then
    echo "BLOCKER: RUN_ID '${RUN_ID}' does not match ^[0-9]+-[0-9]+$ (<epoch>-<pid>)." >&2
    exit 1
  fi
  if [ "${WORK_DIR}" != "/tmp/cherry-pr-${PR_NUMBER}-${RUN_ID}" ]; then
    echo "BLOCKER: WORK_DIR '${WORK_DIR}' != /tmp/cherry-pr-${PR_NUMBER}-${RUN_ID}" >&2
    exit 1
  fi
  if [ "${PROFILE_DIR}" != "${WORK_DIR}/profile" ]; then
    echo "BLOCKER: PROFILE_DIR '${PROFILE_DIR}' != \${WORK_DIR}/profile" >&2
    exit 1
  fi
  if [ "${REPORT_DIR}" != "/tmp/cherry-pr-${PR_NUMBER}-${RUN_ID}-report" ]; then
    echo "BLOCKER: REPORT_DIR '${REPORT_DIR}' != expected report path." >&2
    exit 1
  fi
  if [ "${TOKEN}" != "--user-data-dir=${PROFILE_DIR}" ]; then
    echo "BLOCKER: TOKEN '${TOKEN}' != --user-data-dir=\${PROFILE_DIR}." >&2
    exit 1
  fi
}

# Owned processes = those whose argv contains the EXACT argv element
# `--user-data-dir=${PROFILE_DIR}` — a complete argument boundary, never a
# substring. Profile paths are space-free by construction
# (/tmp/cherry-pr-<NUMBER>-<RUN_ID>/profile), so a space-delimited exact
# element match is reliable. Only the profile path is passed via `-v` and the
# token is rebuilt inside awk, so matcher processes (ps/awk/shell) never carry
# the exact token in their own argv and are excluded by construction.
# Fail-closed: `ps` status and `awk` status are each captured and checked
# independently; any failure returns nonzero and callers abort signaling and
# deletion. No launcher-PID fallback — PIDs can be reused, so signaling by PID
# alone is never done.
owned_pids() {
  local ps_out=""
  local ps_rc=0
  ps_out="$(ps -ww -axo pid=,args= 2>&1)" || ps_rc=$?
  if [ "${ps_rc}" -ne 0 ]; then
    echo "BLOCKER: ps failed (exit ${ps_rc}) — refusing to signal or delete." >&2
    return 1
  fi
  local matched=""
  local awk_rc=0
  matched="$(printf '%s\n' "${ps_out}" | awk -v p="${PROFILE_DIR}" '
    {
      line = $0
      sub(/^[[:space:]]*[0-9]+[[:space:]]+/, "", line)
      n = split(line, argv, " ")
      for (i = 1; i <= n; i++) {
        if (argv[i] == "--user-data-dir=" p) { print $1; break }
      }
    }')" || awk_rc=$?
  if [ "${awk_rc}" -ne 0 ]; then
    echo "BLOCKER: awk failed (exit ${awk_rc}) — refusing to signal or delete." >&2
    return 1
  fi
  printf '%s\n' "${matched}"
  return 0
}

# Fail-closed CDP port probe (port 9222). lsof rc=0 means the port is occupied,
# rc=1 means free, and any other rc — or a missing lsof — is a BLOCKER/error.
# This function never kills anything by port.
probe_cdp_port() {
  if ! command -v lsof >/dev/null 2>&1; then
    echo "BLOCKER: lsof not found — cannot probe CDP port 9222." >&2
    return 2
  fi
  local rc=0
  lsof -nP -iTCP:9222 -sTCP:LISTEN >/dev/null 2>&1 || rc=$?
  if [ "${rc}" -eq 0 ]; then
    return 0
  fi
  if [ "${rc}" -eq 1 ]; then
    return 1
  fi
  echo "BLOCKER: lsof probe for CDP port 9222 failed (exit ${rc})." >&2
  return 2
}

# Interruption/failure cleanup: terminate only owned processes, then remove
# only the exact paths THIS invocation created (tracked via CREATED_*). The
# report directory is preserved and never deleted. Idempotent; re-runs the
# guard so a mismatch aborts instead of deleting anything. Any failed scan or
# any still-running owned process is a BLOCKER: nothing is deleted.
cleanup_owned_runtime() {
  trap - INT TERM EXIT
  if [ "${CLEANED}" -eq 1 ]; then
    return 0
  fi
  CLEANED=1
  guard_owned_runtime
  local first="" remaining="" final=""
  if ! first="$(owned_pids)"; then
    echo "BLOCKER: ownership scan failed during cleanup — refusing to signal or delete." >&2
    return 1
  fi
  if [ -n "${first}" ]; then
    for pid in ${first}; do kill -TERM "${pid}" 2>/dev/null || true; done
    sleep 3
  fi
  if ! remaining="$(owned_pids)"; then
    echo "BLOCKER: ownership rescan after TERM failed — refusing to delete." >&2
    return 1
  fi
  if [ -n "${remaining}" ]; then
    for pid in ${remaining}; do kill -KILL "${pid}" 2>/dev/null || true; done
    sleep 2
  fi
  if ! final="$(owned_pids)"; then
    echo "BLOCKER: ownership rescan after KILL failed — refusing to delete." >&2
    return 1
  fi
  if [ -n "${final}" ]; then
    echo "BLOCKER: owned processes still running: $(printf '%s' "${final}" | tr '\n' ' ') — refusing to delete." >&2
    return 1
  fi
  if [ -f "${LOG_FILE}" ]; then
    cp "${LOG_FILE}" "${REPORT_DIR}/debug.log"
  fi
  if [ "${CREATED_PROFILE_DIR}" -eq 1 ]; then
    rm -rf "${PROFILE_DIR}"
  fi
  if [ "${CREATED_WORK_DIR}" -eq 1 ]; then
    rm -rf "${WORK_DIR}"
  fi
  echo "CLEANUP: removed owned runtime ${WORK_DIR}; preserved ${REPORT_DIR}"
}

# Arm the cleanup traps BEFORE creating any owned path.
trap 'cleanup_owned_runtime; exit 130' INT TERM
trap 'rc=$?; if [ "${rc}" -ne 0 ]; then cleanup_owned_runtime; fi; exit "${rc}"' EXIT

# Pre-flight: port 9222 must be free. If busy, it belongs to another
# invocation — abort and report. Do NOT kill the owner. Probe errors abort.
PROBE_RC=0
probe_cdp_port || PROBE_RC=$?
if [ "${PROBE_RC}" -eq 0 ]; then
  echo "BLOCKER: port 9222 already in use. Refusing to launch or kill. Report and stop."
  exit 1
fi
if [ "${PROBE_RC}" -ne 1 ]; then
  echo "BLOCKER: port 9222 probe failed (exit ${PROBE_RC}) — refusing to launch or kill. Report and stop."
  exit 1
fi

# Validate identifiers and exact derived paths BEFORE touching the filesystem.
guard_owned_runtime

# Refuse setup if any owned root already exists or is a symlink — never touch
# a path this invocation did not create. PROFILE_DIR is the only profile path
# this invocation owns (the runtime appDataPath equals it exactly — no Dev
# suffix), so a pre-existing or symlinked profile blocks setup and remains
# untouched.
for d in "${WORK_DIR}" "${REPORT_DIR}" "${PROFILE_DIR}"; do
  if [ -e "${d}" ] || [ -L "${d}" ]; then
    echo "BLOCKER: ${d} already exists or is a symlink — refusing to touch it." >&2
    exit 1
  fi
done

# Create owned roots with exclusive plain `mkdir` (never `mkdir -p`): WORK_DIR
# and REPORT_DIR first, then PROFILE_DIR under the newly created WORK_DIR.
mkdir "${WORK_DIR}"
CREATED_WORK_DIR=1
mkdir "${REPORT_DIR}"
CREATED_REPORT_DIR=1
mkdir "${PROFILE_DIR}"
CREATED_PROFILE_DIR=1

# Launch with the invocation-owned disposable profile (forwarded via `--`).
nohup pnpm debug -- --user-data-dir="${PROFILE_DIR}" > "${LOG_FILE}" 2>&1 &

# Wait for the CDP endpoint (typically 20-30s).
for i in $(seq 1 30); do
  PROBE_RC=0
  probe_cdp_port || PROBE_RC=$?
  if [ "${PROBE_RC}" -eq 0 ]; then
    break
  fi
  if [ "${PROBE_RC}" -ne 1 ]; then
    echo "BLOCKER: port 9222 probe failed (exit ${PROBE_RC}) during startup wait — aborting launch. See ${LOG_FILE}" >&2
    exit 1
  fi
  sleep 2
done

# Confirm the instance is OURS: some process must carry the exact argv element
# `--user-data-dir=${PROFILE_DIR}`. A failed scan or a missing match exits
# non-zero so the trap cleans up without deleting anything.
if ! owned="$(owned_pids)"; then
  echo "BLOCKER: ownership scan failed — aborting launch. See ${LOG_FILE}" >&2
  exit 1
fi
if [ -z "${owned}" ]; then
  echo "BLOCKER: no process with our exact profile token is running. See ${LOG_FILE}"
  exit 1
fi
echo "LAUNCH OK: owned processes: $(printf '%s' "${owned}" | tr '\n' ' ')"
```

If this block ends normally, the app stays running for observation and Phase 8
performs the same guarded cleanup. If the block errors or is interrupted, the
trap above cleans the runtime/profile immediately and preserves the report
directory; if the whole session dies before the trap can run (e.g. the agent
process was killed), use the manual fail-closed cleanup in Troubleshooting.

Keep the recorded values (`PR_NUMBER`, `RUN_ID`, `WORK_DIR`, `PROFILE_DIR`,
`LOG_FILE`, `REPORT_DIR`, `TOKEN`) for cleanup and the report. If the app must
be relaunched mid-session (e.g. after a first-launch flow requests a restart),
first terminate only this invocation's processes (exact-profile-token match,
see Phase 8) and relaunch with the **same** `PROFILE_DIR` so state persists.

Save every screenshot to `${REPORT_DIR}/` so it survives cleanup.

#### Connect agent-browser and verify ownership

1. **Connect**:
   ```bash
   agent-browser connect 9222
   ```
   If `connect` fails, fall back to the websocket URL from **our** log:
   ```bash
   WS_URL=$(grep "DevTools listening" "${LOG_FILE}" | sed 's/.*\(ws:\/\/[^ ]*\)/\1/')
   agent-browser --cdp "$WS_URL" navigate http://localhost:5173
   ```
2. **Verify connection and instance ownership**: identify the main page and
   confirm the running app is using OUR disposable profile. The app preserves
   an explicit `--user-data-dir` override verbatim (`src/main/config.ts` — no
   `Dev` suffix), so the runtime appDataPath must equal `${PROFILE_DIR}`
   exactly. On macOS `/tmp` resolves to `/private/tmp`, so normalize both
   sides before comparing. Require **exact** equality with `${PROFILE_DIR}` —
   never a substring match:
   ```bash
   normalize_path() {
     local p="$1"
     case "$p" in
       /private/tmp/*) p="/tmp${p#/private/tmp}" ;;
     esac
     printf '%s' "${p%/}"
   }
   EXPECTED_APPDATA="$(normalize_path "${PROFILE_DIR}")"
   agent-browser tab
   ACTUAL_APPDATA="$(normalize_path "$(agent-browser eval "window.api.getAppInfo().then(i => i.appDataPath)")")"
   if [ "${ACTUAL_APPDATA}" != "${EXPECTED_APPDATA}" ]; then
     echo "BLOCKER: appDataPath '${ACTUAL_APPDATA}' != expected '${EXPECTED_APPDATA}'."
     echo "Stop and report — never interact with or modify real user data."
     exit 1
   fi
   echo "OWNERSHIP OK: appDataPath is exactly our disposable profile"
   ```
   If the check fails, stop and report — never interact with or modify real
   user data.
3. **First-launch / onboarding flows**: A fresh disposable profile may trigger
   first-launch flows (onboarding, data migration, or other wizards) before the
   main UI. Treat these cautiously:
   - Screenshot and note the flow in the report. Do **not** blindly click
     through steps that mutate persistent data (e.g. do not confirm a data
     migration you have not verified is safe).
   - If the flow requests an app restart, terminate only this invocation's
     processes (Phase 8 step 1) and relaunch with the same `PROFILE_DIR` — the
     in-app restart may not work in dev mode.
   - If the flow blocks reaching the main UI, record it as a blocker in the
     report instead of guessing through irreversible steps.
4. **Splash screen**: Wait up to 30s for the splash to dismiss.

#### Interactive UI testing (exploratory — diagnostic only)

Based on the PR's changed files, navigate to the relevant pages and observe.
Use your judgement on what to test — the PR description and changed files
should guide the strategy.

General approach:

1. Take a screenshot of the current state (save to `${REPORT_DIR}/`)
2. Use `agent-browser snapshot -i` to discover interactive elements
3. Interact with elements (click, fill, drag, etc.)
4. Screenshot and verify the result
5. Verify state changes if relevant (via `agent-browser eval`)

Key testing points:

- **UI renders correctly**: New components appear in the right place
- **Interactions work**: Toggles, inputs, buttons all function
- **State persistence**: Changes survive across page navigations
- **Theme compatibility**: Test in both light and dark modes
- **Layout modes**: If sidebar/layout is involved, test at different sizes
- **i18n**: Switch language and verify new strings appear correctly
- **Edge cases**: Boundary conditions, rapid toggling, empty states

Remember: everything observed here is diagnostic. Observations that indicate a
reproducible regression should be captured in the report under missing
automated coverage with a recommendation for a Playwright spec.

### Phase 7: Test Report

Generate the report in `${REPORT_DIR}` (which already holds the screenshots).
This phase runs **before** cleanup (Phase 8) so the report artifact survives;
cleanup never deletes `${REPORT_DIR}`. Show the report to the user. If the
user requests, copy the report directory to a more accessible location (e.g.
Desktop).

```markdown
# PR #<NUMBER> 测试报告

**PR 标题**: <title>
**作者**: @<author>
**分支**: <branch>
**修改文件数**: <count>

## 证据等级 (Evidence Level)

- [ ] exploratory-only — 仅 CDP/agent-browser 观察（诊断性，不构成回归证据）
- [ ] exploratory + Playwright — 已运行相关 Playwright spec

## Playwright 自动化结果 (regression evidence)

| Spec | 命令 | 结果 |
|------|------|------|
| <spec> | `pnpm playwright test <spec>` | PASS / FAIL (details) |

## 静态分析

| 检查项 | 结果 | 说明 |
|--------|------|------|
| TypeScript 类型检查 | ✅/❌ | ... |
| 受阻文件检查 | ✅/⚠️ | ... |
| console.log 使用 | ✅/❌ | ... |

## 探索性观察 (diagnostic only, 非回归证据)

### <Observation Case Name>
<description of what was observed and the result>
![screenshot](<filename>.png)

## 缺失的自动化覆盖 (Missing automated coverage)

- <behavior exercised during exploration but not covered by tests/e2e/specs>
- 建议：为可复现的回归场景添加 Playwright spec（参考 tests/e2e/README.md）

## 发现的问题
(if any)

## 结论
- 证据等级：<exploratory-only | exploratory + Playwright>
- 问题总数：N
- 建议：APPROVE / REQUEST_CHANGES / COMMENT
  (仅当涉及行为已有 Playwright 覆盖且通过时，回归结论可引用自动化结果；否则注明回归验证待补)
```

The conclusion must not claim regression completion based on screenshots or
CDP observations alone.

### Phase 8: Cleanup & Branch Restore (fail-closed, ownership-scoped)

Terminate only what this invocation launched, remove only what it created
(after validating the exact paths), then restore the recorded branch-or-commit.
Run this **after** the report has been generated and shown (Phase 7).

**This block must run in Bash.** It is a self-contained Bash script (note the
shebang); execute it as Bash — write it to a temporary file (e.g.
`cleanup-script.sh`) and run `bash cleanup-script.sh <PR_NUMBER> <RUN_ID>`, or
paste it into a Bash session with the recorded values as positional arguments.
Do not rely on the code-fence language tag to select the shell. The script
takes the recorded `PR_NUMBER` as `$1` and `RUN_ID` as `$2`, validates them
before any use, then re-derives every path exactly as Phase 6 does; never
delete or signal anything that fails the guard.

```bash
#!/usr/bin/env bash
# --- Fail-closed owned-runtime cleanup (same procedure as the Phase 6 trap) ---
set -euo pipefail

# Recorded values are passed as positional arguments: $1 = PR_NUMBER,
# $2 = RUN_ID. They are validated before any use, then every path is derived
# exactly as Phase 6 does. Every delete/signal below is guarded: PR_NUMBER,
# RUN_ID, TOKEN, PROFILE_DIR, WORK_DIR, LOG_FILE and
# REPORT_DIR must be non-empty, and every path must equal exactly what this
# invocation derived from PR_NUMBER/RUN_ID under /tmp. REPORT_DIR is validated
# but never deleted. On any mismatch: abort and report — never guess.
PR_NUMBER="${1:-}"
RUN_ID="${2:-}"

if [ -z "${PR_NUMBER}" ]; then
  echo "BLOCKER: PR_NUMBER is empty — pass the recorded PR number as \$1." >&2
  exit 1
fi
if [ -z "${RUN_ID}" ]; then
  echo "BLOCKER: RUN_ID is empty — pass the recorded run ID as \$2." >&2
  exit 1
fi

WORK_DIR="/tmp/cherry-pr-${PR_NUMBER}-${RUN_ID}"
PROFILE_DIR="${WORK_DIR}/profile"
LOG_FILE="${WORK_DIR}/debug.log"
REPORT_DIR="/tmp/cherry-pr-${PR_NUMBER}-${RUN_ID}-report"
TOKEN="--user-data-dir=${PROFILE_DIR}"

guard_owned_runtime() {
  if [ -z "${PR_NUMBER}" ]; then
    echo "BLOCKER: PR_NUMBER is empty — refusing to delete or signal anything." >&2
    exit 1
  fi
  if [ -z "${RUN_ID}" ]; then
    echo "BLOCKER: RUN_ID is empty — refusing to delete or signal anything." >&2
    exit 1
  fi
  if [ -z "${LOG_FILE}" ]; then
    echo "BLOCKER: LOG_FILE is empty — refusing to delete or signal anything." >&2
    exit 1
  fi
  if [ -z "${TOKEN}" ]; then
    echo "BLOCKER: TOKEN is empty — refusing to delete or signal anything." >&2
    exit 1
  fi
  if [ -z "${PROFILE_DIR}" ]; then
    echo "BLOCKER: PROFILE_DIR is empty — refusing to delete or signal anything." >&2
    exit 1
  fi
  if [ -z "${WORK_DIR}" ]; then
    echo "BLOCKER: WORK_DIR is empty — refusing to delete or signal anything." >&2
    exit 1
  fi
  if [ -z "${REPORT_DIR}" ]; then
    echo "BLOCKER: REPORT_DIR is empty — refusing to delete or signal anything." >&2
    exit 1
  fi
  if [[ ! "${PR_NUMBER}" =~ ^[0-9]+$ ]]; then
    echo "BLOCKER: PR_NUMBER '${PR_NUMBER}' is not numeric." >&2
    exit 1
  fi
  if [[ ! "${RUN_ID}" =~ ^[0-9]+-[0-9]+$ ]]; then
    echo "BLOCKER: RUN_ID '${RUN_ID}' does not match ^[0-9]+-[0-9]+$ (<epoch>-<pid>)." >&2
    exit 1
  fi
  if [ "${WORK_DIR}" != "/tmp/cherry-pr-${PR_NUMBER}-${RUN_ID}" ]; then
    echo "BLOCKER: WORK_DIR '${WORK_DIR}' != /tmp/cherry-pr-${PR_NUMBER}-${RUN_ID}" >&2
    exit 1
  fi
  if [ "${PROFILE_DIR}" != "${WORK_DIR}/profile" ]; then
    echo "BLOCKER: PROFILE_DIR '${PROFILE_DIR}' != \${WORK_DIR}/profile" >&2
    exit 1
  fi
  if [ "${REPORT_DIR}" != "/tmp/cherry-pr-${PR_NUMBER}-${RUN_ID}-report" ]; then
    echo "BLOCKER: REPORT_DIR '${REPORT_DIR}' != expected report path." >&2
    exit 1
  fi
  if [ "${TOKEN}" != "--user-data-dir=${PROFILE_DIR}" ]; then
    echo "BLOCKER: TOKEN '${TOKEN}' != --user-data-dir=\${PROFILE_DIR}." >&2
    exit 1
  fi
}

# Owned processes = EXACT argv element `--user-data-dir=${PROFILE_DIR}`
# (complete argument boundary, never substring). Profile paths are space-free
# by construction, so a space-delimited exact element match is reliable. Only
# the profile path is passed via `-v` and the token is rebuilt inside awk, so
# matcher processes (ps/awk/shell) never carry the exact token in their own
# argv and are excluded by construction. Fail-closed: `ps` status and `awk`
# status are each captured and checked independently; any failure returns
# nonzero and callers abort signaling and deletion. No launcher-PID fallback.
owned_pids() {
  local ps_out=""
  local ps_rc=0
  ps_out="$(ps -ww -axo pid=,args= 2>&1)" || ps_rc=$?
  if [ "${ps_rc}" -ne 0 ]; then
    echo "BLOCKER: ps failed (exit ${ps_rc}) — refusing to signal or delete." >&2
    return 1
  fi
  local matched=""
  local awk_rc=0
  matched="$(printf '%s\n' "${ps_out}" | awk -v p="${PROFILE_DIR}" '
    {
      line = $0
      sub(/^[[:space:]]*[0-9]+[[:space:]]+/, "", line)
      n = split(line, argv, " ")
      for (i = 1; i <= n; i++) {
        if (argv[i] == "--user-data-dir=" p) { print $1; break }
      }
    }')" || awk_rc=$?
  if [ "${awk_rc}" -ne 0 ]; then
    echo "BLOCKER: awk failed (exit ${awk_rc}) — refusing to signal or delete." >&2
    return 1
  fi
  printf '%s\n' "${matched}"
  return 0
}

# Fail-closed CDP port probe (port 9222), same semantics as Phase 6. lsof rc=0
# means the port is occupied, rc=1 means free, and any other rc — or a missing
# lsof — is a BLOCKER/error. This function never kills anything by port.
probe_cdp_port() {
  if ! command -v lsof >/dev/null 2>&1; then
    echo "BLOCKER: lsof not found — cannot probe CDP port 9222." >&2
    return 2
  fi
  local rc=0
  lsof -nP -iTCP:9222 -sTCP:LISTEN >/dev/null 2>&1 || rc=$?
  if [ "${rc}" -eq 0 ]; then
    return 0
  fi
  if [ "${rc}" -eq 1 ]; then
    return 1
  fi
  echo "BLOCKER: lsof probe for CDP port 9222 failed (exit ${rc})." >&2
  return 2
}

guard_owned_runtime

# 1) Terminate ONLY owned processes (exact argv element). No launcher PID
#    fallback: PIDs can be reused, so signaling by PID alone is forbidden. If
#    no owned process is found, nothing is signaled. A failed scan at any
#    point or any still-running owned process is a BLOCKER: nothing is
#    deleted and the branch is not restored.
if ! owned="$(owned_pids)"; then
  echo "BLOCKER: ownership scan failed — refusing to signal or delete." >&2
  exit 1
fi
for pid in ${owned}; do
  kill -TERM "${pid}" 2>/dev/null || true
done
sleep 3

if ! remaining="$(owned_pids)"; then
  echo "BLOCKER: ownership rescan after TERM failed — refusing to delete." >&2
  exit 1
fi
if [ -n "${remaining}" ]; then
  for pid in ${remaining}; do
    kill -KILL "${pid}" 2>/dev/null || true
  done
  sleep 2
fi

if ! final_remaining="$(owned_pids)"; then
  echo "BLOCKER: ownership rescan after KILL failed — refusing to delete." >&2
  exit 1
fi
if [ -n "${final_remaining}" ]; then
  echo "BLOCKER: owned processes still running after TERM+KILL: $(printf '%s' "${final_remaining}" | tr '\n' ' ')" >&2
  echo "BLOCKER: refusing to delete PROFILE_DIR/WORK_DIR and refusing to restore the branch." >&2
  exit 1
fi
echo "CLEANUP OK: all owned processes terminated"

PROBE_RC=0
probe_cdp_port || PROBE_RC=$?
if [ "${PROBE_RC}" -eq 0 ]; then
  echo "CLEANUP WARNING: port 9222 still listening — report owning PID, do NOT kill it"
elif [ "${PROBE_RC}" -eq 1 ]; then
  echo "CLEANUP OK: port 9222 released"
else
  echo "BLOCKER: port 9222 probe failed (exit ${PROBE_RC}) — report owning PID, do NOT kill it." >&2
  exit 1
fi

# 2) Only after the successful empty rescan: preserve the report, copy the
#    runtime log into REPORT_DIR if it exists, then remove ONLY the exact
#    paths this invocation created (the guard already proved they equal the
#    expected /tmp paths derived from PR_NUMBER/RUN_ID). The runtime
#    appDataPath equals PROFILE_DIR exactly (no Dev suffix), so only
#    PROFILE_DIR is removed. REPORT_DIR is validated but
#    deliberately never deleted.
if [ -f "${LOG_FILE}" ]; then
  cp "${LOG_FILE}" "${REPORT_DIR}/debug.log"
  echo "CLEANUP OK: copied runtime log to ${REPORT_DIR}/debug.log"
fi
rm -rf "${PROFILE_DIR}"
rm -rf "${WORK_DIR}"
echo "CLEANUP OK: removed ${WORK_DIR}; preserved ${REPORT_DIR}"

# 3) Restore the branch-or-commit recorded before checkout (Phase 1). Runs
#    only after successful runtime cleanup above. The recorded state comes from
#    the session environment (ORIGINAL_BRANCH / ORIGINAL_COMMIT kept from
#    Phase 1); if this block runs in cleanup-only mode with no recorded state,
#    the restore is skipped. Never force: if the tree is dirty, report and
#    stop. Cleanup/report artifacts are preserved — only the branch restore is
#    skipped.
STATUS_RC=0
STATUS_OUTPUT=""
STATUS_OUTPUT="$(git status --porcelain 2>&1)" || STATUS_RC=$?
if [ "${STATUS_RC}" -ne 0 ]; then
  echo "BLOCKER: git status failed (exit ${STATUS_RC}) before branch restore — refusing to checkout." >&2
  echo "BLOCKER: cleanup/report artifacts are preserved. Resolve manually, then restore ${ORIGINAL_BRANCH:-${ORIGINAL_COMMIT:-<detached commit>}}." >&2
  exit 1
fi
if [ -n "${STATUS_OUTPUT}" ]; then
  echo "BLOCKER: worktree is dirty before restore — refusing to checkout." >&2
  echo "BLOCKER: cleanup/report artifacts are preserved. Resolve or stash the changes manually, then restore ${ORIGINAL_BRANCH:-${ORIGINAL_COMMIT:-<detached commit>}}." >&2
  exit 1
fi
if [ -n "${ORIGINAL_BRANCH:-}" ]; then
  git checkout "${ORIGINAL_BRANCH}"
elif [ -n "${ORIGINAL_COMMIT:-}" ]; then
  git checkout "${ORIGINAL_COMMIT}"
else
  echo "CLEANUP OK: no recorded branch/commit to restore (cleanup-only mode)."
fi
```

If any cleanup warning appears, report it in the results. Do not escalate to
broad kills — leaving a reported orphan is safer than killing another
session's processes. If the `git checkout` fails because the worktree became
dirty, report it; do not use `git reset --hard` or `git checkout --force`.

## Troubleshooting

### Port 9222 already in use at launch

Another invocation owns it. This is a blocker: do not launch, do not kill the
owner. Report the conflict and stop.

### Port 9222 not listening after startup

- Check our log: `tail -50 "${LOG_FILE}"`
- Confirm our instance exists (exact argv element match, never substring;
  matcher processes are excluded by construction):
  ```bash
  ps -ww -axo pid=,args= | awk -v p="${PROFILE_DIR}" '
    {
      line = $0
      sub(/^[[:space:]]*[0-9]+[[:space:]]+/, "", line)
      n = split(line, argv, " ")
      for (i = 1; i <= n; i++) {
        if (argv[i] == "--user-data-dir=" p) { print $1; break }
      }
    }'
  ```
- Do **not** kill by port (`lsof -ti :9222 | xargs kill`). If a foreign
  process holds the port, report it.

### agent-browser connect fails

Use the direct websocket URL from our log:
```bash
WS_URL=$(grep "DevTools listening" "${LOG_FILE}" | grep 9222 | sed 's/.*\(ws:\/\/[^ ]*\)/\1/')
agent-browser --cdp "$WS_URL" tab
```

### agent-browser target jumps to wrong page

Electron apps have multiple CDP targets (main window + webviews for mini-apps).
If `agent-browser` connects to a webview instead of the main page:
```bash
# List all targets
agent-browser tab
# Switch to the main page (usually tab 0, URL contains localhost:5173)
agent-browser tab 0
```
After opening/closing mini-apps, always verify you're on the right target
with `agent-browser tab`.

### First-launch / onboarding wizard appears

A fresh disposable profile may show an onboarding, data-migration, or welcome
wizard before the main UI. This is **not a bug** — it is expected on the first
launch of a new profile. Observe cautiously: screenshot it, do not blindly
confirm steps that mutate persistent data, and if the flow requests a restart,
terminate only this invocation's processes (Phase 8 step 1) and relaunch with
the same `PROFILE_DIR`. Record the flow and any blocker in the report.

### App stuck on splash screen

Wait longer (up to 30s on first launch). The app needs to:
- Build and serve renderer via Vite dev server (port 5173)
- Run database migrations
- Initialize services (MCP, etc.)

### Empty CDP target list

After connecting, if `agent-browser tab` shows only `about:blank`:
```bash
agent-browser navigate http://localhost:5173
sleep 10
agent-browser tab
```

### Interrupted session left the app running

If the session died mid-observation and the Phase 6 trap did not run (e.g. the
agent process was killed), re-run the **Phase 8 cleanup block** with the
recorded values as positional arguments — `bash cleanup-script.sh <PR_NUMBER>
<RUN_ID>` — it is the same fail-closed procedure and is fully self-contained
(guards, exact argv-element matching, exact-path deletes, `REPORT_DIR`
preserved). In cleanup-only mode (no recorded `ORIGINAL_BRANCH` /
`ORIGINAL_COMMIT` environment values) the branch restore is skipped.

### No Playwright spec covers the changed behavior

State in the report that no existing automated coverage matches, list the
behavior as missing coverage, and recommend a spec under `tests/e2e/specs`
(follow the guidance in `tests/e2e/README.md`).

## Limitations

- **CDP port is fixed at 9222.** The `pnpm debug` script hard-codes
  `--remote-debugging-port=9222`, so this skill cannot pick a unique port
  through that launch path; it pre-flight-checks the port and never kills the
  owner. If port isolation is required, invoke electron-vite directly instead
  of `pnpm debug` (e.g.
  `pnpm exec electron-vite dev --remoteDebuggingPort <free-port> -- --user-data-dir=<profile>`),
  and adjust the wait/cleanup tokens accordingly.
- **Profile isolation scope.** `--user-data-dir` is honored by Electron in dev
  mode and keeps the session out of the real user profile. The app preserves an
  explicit `--user-data-dir` override verbatim (`src/main/config.ts` — no `Dev`
  suffix), so the runtime appDataPath equals the exact token; cleanup removes
  that exact profile dir only.
- **Interruption window.** The fail-closed trap covers the Phase 6 launch block
  only. If the whole session dies during interactive observation, re-run the
  Phase 8 cleanup block (see Troubleshooting "Interrupted session") instead.
- **Diagnostic, not regression evidence.** Screenshots, CDP sessions,
  agent-driven browsers, and dev-mode runs are diagnostic observations. They
  cannot establish regression completion — only the repo Playwright suite can.
- **No improvised regression pass.** This skill runs existing repo Playwright
  specs when they cover the changed behavior; it does not write new tests and
  cannot manufacture E2E proof for PRs that lack automated coverage.
