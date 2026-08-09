# PR Create / Update

Create or update GitHub pull requests using the repository-required workflow and
template compliance. Always read `.github/pull_request_template.md`, fill every
template section, preserve markdown structure exactly, and mark missing data as
`N/A` or `None` instead of skipping sections.

## References

| File | Purpose |
|------|---------|
| `ci-inspection.md` | Check CI status and logs after creating/updating a PR |

---

## Step 1: Read the template

Read `.github/pull_request_template.md` before drafting the PR body.

## Step 2: Collect PR context

Collect PR context from the current branch (base/head, scope, linked issues,
testing status, breaking changes, release note content).

## Step 3: Push the branch (if needed)

Check if the current branch has been pushed to remote. If not, push it first:
- Default remote is `origin`, but ask the user if they want to use a different
  remote.
```bash
git push -u <remote> <head-branch>
```

## Step 4: Determine the base branch

- For official repo (CherryHQ/cherry-studio) as `origin`: default base is `main`
  from `origin`, but allow the user to explicitly indicate a base branch.
- For fork repo as `origin`: check available remotes with `git remote -v`, default
  base may be `upstream/main` or another remote. Always assume that user wants to
  merge head to CherryHQ/cherry-studio/main, unless the user explicitly indicates
  a base branch.
- Ask the user to confirm the base branch if it's not the default.

## Step 5: Draft the body

Create a temp file and write the PR body:
- Use `pr_body_file="$(mktemp /tmp/gh-pr-body-XXXXXX).md"`
- Fill content using the template structure exactly (keep section order, headings,
  checkbox formatting).
- If not applicable, write `N/A` or `None`.

Preview the temp file content. **Show the file path** (e.g.,
`/tmp/gh-pr-body-XXXXXX.md`) and ask for explicit confirmation before creating.
**Skip this step if the user explicitly indicates no preview/confirmation is
needed** (for example, automation workflows).

## Step 6: Create the PR

```bash
gh pr create --base <base> --head <head> --title "<title>" --body-file "$pr_body_file"
```

Clean up the temp file: `rm -f "$pr_body_file"`

Report the created PR URL and summarize title/base/head and any required follow-up.

## Update an existing PR

For updates to an existing PR (title/body after review feedback, CI-mode
follow-ups):

1. Draft the updated body in a temp file (same template rules).
2. Preview and ask for confirmation unless the user explicitly waives it.
3. Apply the update:
   ```bash
   gh pr edit {number} --title "<title>" --body-file "$pr_body_file"
   ```
4. Clean up the temp file: `rm -f "$pr_body_file"`

---

## Constraints

- Never skip template sections.
- Never rewrite the template format.
- Keep content concise and specific to the current change set.
- PR title and body must be written in English.
- Never create the PR before showing the full final body to the user, unless they
  explicitly waive the preview or confirmation.
- Never rely on command permission prompts as PR body preview.
- **Release note & Documentation checkbox** — both are driven by whether the change
  is **user-facing**. Use the table below:

  | Change type | Release note | Docs `[x]` |
  |---|---|---|
  | New user-facing feature / setting / UI | Describe the change | ✅ |
  | Bug fix visible to users | Describe the fix | ✅ if behavior changed |
  | Behavior change / default value change | Describe + `action required` | ✅ |
  | Security fix in a user-facing dependency | Describe the fix | ✅ if usage changed |
  | CI / GitHub Actions changes | `NONE` | ❌ |
  | Internal refactoring (user cannot tell) | `NONE` | ❌ |
  | Dev / build tooling changes | `NONE` | ❌ |
  | Dev-only dependency bump | `NONE` | ❌ |
  | Test-only / code style changes | `NONE` | ❌ |

## Command Pattern

```bash
# read template
cat .github/pull_request_template.md

# show this full Markdown body in chat first
pr_body_file="$(mktemp /tmp/gh-pr-body-XXXXXX).md"
cat > "$pr_body_file" <<'EOF'
...filled template body...
EOF

# run only after explicit user confirmation
gh pr create --base <base> --head <head> --title "<title>" --body-file "$pr_body_file"
rm -f "$pr_body_file"
```
