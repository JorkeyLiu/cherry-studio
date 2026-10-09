#!/bin/sh
# Conditional `pnpm install` for post-checkout / post-merge hooks.
# Usage: install-if-deps-changed.sh <checkout|merge>
# Preserves the automatic dependency-change conditions from
# .pre-commit-config.yaml and propagates real install failures verbatim.
# The toolchain bootstrap runs only on the actual install path: equal refs,
# empty diffs, and unavailable tools skip successfully without a toolchain.
set -u
_hook_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 127
# shellcheck disable=SC1091
. "$_hook_dir/ensure-toolchain.sh" || exit 127
_hook_mode=${1:-}
case "$_hook_mode" in
  checkout)
    if [ "${PRE_COMMIT_FROM_REF:-}" != "${PRE_COMMIT_TO_REF:-}" ] && git diff --name-only "$PRE_COMMIT_FROM_REF" "$PRE_COMMIT_TO_REF" -- "**/package.json" pnpm-lock.yaml | grep -q .; then
      echo "Dependencies changed, running pnpm install..."
      hook_ensure_toolchain || exit $?
      pnpm install
    else
      echo "No dependency changes, skipping pnpm install."
    fi
    ;;
  merge)
    _hook_prev=$(git rev-parse --short HEAD@{1} 2>/dev/null) || _hook_prev=""
    if [ -n "$_hook_prev" ] && git diff --name-only "$_hook_prev" HEAD -- "**/package.json" pnpm-lock.yaml | grep -q .; then
      echo "Dependencies changed, running pnpm install..."
      hook_ensure_toolchain || exit $?
      pnpm install
    else
      echo "No dependency changes, skipping pnpm install."
    fi
    ;;
  *)
    printf '%s\n' "install-if-deps-changed: usage: $0 <checkout|merge>" >&2
    exit 2
    ;;
esac
