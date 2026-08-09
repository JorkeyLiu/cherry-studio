---
name: github-workflow
description: GitHub pull request workflow and code review skill. Use when asked to create/open/update a PR so the assistant reads `.github/pull_request_template.md`, fills every template section, preserves markdown structure exactly, and marks missing data as N/A or None instead of skipping sections. Also use for automated code review of local branches, PRs (by number or URL), commits, and files — single-agent review with interactive fix selection, or multi-agent adversarial review with risk-based auto-fix — plus GitHub CI check/log inspection via `gh` and GitHub CLI workflow decisions.
---

<!-- Based on https://github.com/Tencent/tgfx/tree/main/.codebuddy/skills/cr -->
<!-- Adapted for Claude Code Agent tool and Cherry Studio tech stack -->

# /github-workflow — GitHub Pull Request Workflow

Unified skill for creating/updating pull requests and reviewing code. Detects the
requested mode from the user's intent and `$ARGUMENTS`, then routes to the relevant
reference flow — PR creation/update with template compliance, quick single-agent
review with interactive fix selection, multi-agent deep review with risk-based
auto-fix, or CI/check/log inspection.

All user-facing text matches the user's language. All questions and option
selections MUST use your interactive dialog tool (e.g. AskUserQuestion) — never
output options as plain text. Do not proceed until the user replies. When
presenting multi-select options: ≤4 items → one question. >4 items → group by
priority or category (each group ≤4 options), then present all groups as
separate questions in a single prompt.

## Route

Run pre-checks, then match the **first** applicable rule top-to-bottom:

1. `git branch --show-current` → record whether on main/master.
2. `git status --porcelain` → record whether uncommitted changes exist.
3. Check whether the current environment supports Agent tool with parallel
   subagents (agent teams).

| # | Condition | Action |
|---|-----------|--------|
| 1 | User asks to **create/update** a PR (open a PR, edit PR title/body, `prepare-release` handoff) | → `references/pr-create.md` |
| 2 | User asks to **inspect CI/checks/logs** (`gh pr checks`, `gh pr view`, `gh run view --log-failed`, "why did CI fail") | → `references/ci-inspection.md` |
| 3 | `$ARGUMENTS` is `diag` | → `references/diagnosis.md` |
| 4 | `$ARGUMENTS` is a PR number or URL containing `/pull/` | → `references/pr-review.md` |
| 5 | Agent teams NOT supported | → `references/local-review.md` |
| 6 | Uncommitted changes exist | → `references/local-review.md` |
| 7 | On main/master branch | → `references/local-review.md` |
| 8 | Everything else | → Question below |

Each `→` means: `Read` the target file and follow it as the sole remaining
instruction. Ignore all sections below. Do NOT review from memory or habit —
each target file defines specific constraints on how to obtain diffs, apply
fixes, and submit results.

---

## Question

Ask a **single question**:
"Agent Teams is available (multiple agents working in parallel). Enable multi-agent review with reviewer–verifier adversarial mechanism and auto-fix?"
Provide 4 options:

| Option | Description |
|--------|-------------|
| Teams + auto-fix low & medium risk (recommended) | Multi-agent review; auto-fix most issues, only confirm high-risk ones (e.g., API changes, architecture). |
| Teams + auto-fix low risk | Multi-agent review; auto-fix only the safest issues (e.g., null checks, typos, naming). Confirm everything else. |
| Teams + auto-fix all | Multi-agent review; auto-fix everything. Only issues affecting test baselines are deferred. |
| Single-agent + manual fix | Single-agent review; interactively choose which issues to fix afterward. |

### Hand off

| Option | → | FIX_MODE |
|--------|---|----------|
| Teams + auto-fix low & medium risk (recommended) | `references/teams-review.md` | low_medium |
| Teams + auto-fix low risk | `references/teams-review.md` | low |
| Teams + auto-fix all | `references/teams-review.md` | full |
| Single-agent + manual fix | `references/local-review.md` | — |

Pass `$ARGUMENTS` to the target file. For teams-review, also pass `FIX_MODE`
(low / low_medium / full).
