# CI / Check / Log Inspection

Inspect GitHub CI status, check details, PR state, and failure logs using the
GitHub CLI. Do NOT re-run `pnpm lint`, `pnpm test`, or `pnpm format` locally when
inspecting a PR's CI — read the CI results directly from GitHub.

## Rules

- For PR review and CI inspection, check CI status directly using GitHub CLI —
  do not re-run local lint/test/format. Local lint/test/format runs belong to the
  local branch review flows (`local-review.md`, `teams-review.md`).
- Investigate CI failures by reading the logs, not by re-running checks locally.
- Only investigate what the user asks about — do not expand scope to unrelated
  runs.

## Commands

### View all CI check results for a PR

```bash
gh pr checks <PR_NUMBER>
```

### View PR status, reviews, and merge readiness

```bash
gh pr view <PR_NUMBER>
```

### Inspect logs for failed CI runs

```bash
gh run view <RUN_ID> --log-failed
```

### Related read-only inspection

```bash
# list recent workflow runs for the repo
gh run list --limit 20

# diff a PR
gh pr diff <PR_NUMBER>

# check mergeability / review status
gh pr view <PR_NUMBER> --json mergeable,reviewDecision,statusCheckRollup
```

## Report

Summarize: which checks passed/failed, why the failing check failed (from the
logs), and whether the PR is mergeable. If a check is still running, report that
it is pending and re-check when appropriate.
