#!/bin/sh
# Common pnpm entry for prek `language: system` hooks.
# Bootstraps the repository-pinned Node + pnpm onto PATH, then execs pnpm
# with the original argument vector verbatim (filenames with spaces intact).
set -u
_hook_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 127
# shellcheck disable=SC1091
. "$_hook_dir/ensure-toolchain.sh" || exit 127
hook_ensure_toolchain || exit $?
exec pnpm "$@"
