#!/bin/sh
# `pnpm dev:sync` command-local launcher (POSIX sh).
#
# Goal: `pnpm dev:sync` works from the user's current terminal even when the
# host `node` on PATH is not the pinned toolchain (e.g. Node 22 shadowing
# Node 24). This entrypoint auto-selects the already-installed pinned Node
# for this command and its descendants only:
#
#   1. read the pin from `.nvmrc` (fallback `.node-version`) — read, never sourced;
#   2. prefer the installed exact pin under `${NVM_DIR:-$HOME/.nvm}/versions/node/v<pin>/bin`
#      (validated as exactly the pin with ABI 137, so placeholders and wrong
#      binaries are rejected);
#   3. otherwise keep a supported current host Node (same major, >= pin, ABI 137);
#   4. otherwise fail closed before the lane/installs/ports/children, with
#      install guidance.
#
# The selected bin dir is prepended to this command's PATH only (exported so
# descendants — the preflight, the Electron lane, the isolated relay's
# `process.execPath` and pnpm-driven children — stay consistent). No nvm
# shell-init loading, no user-default change, no Node
# install/download, no cache/binding deletion, no manual rebuild, no lane
# bypass, and no version-override environment bypass. The final lane step uses
# `exec` so exit codes and signals pass through verbatim with no extra process
# owner, no second signal forwarding, and no wrapper cleanup.
#
# Safe diagnostics only: versions/ABI on stderr, never full private paths or
# credentials. (The outer pnpm itself starts under the host Node and may print
# its own engine warning; that warning does not stop this launcher.)

set -u

REQUIRED_ABI='137'

# --- repo root from this script's location (never sourced, never $CWD) ---
_script_path="$0"
case "$_script_path" in
  */*) _script_dir=$(CDPATH= cd -- "$(dirname -- "$_script_path")" && pwd) ;;
  *) _script_dir=$(pwd) ;;
esac
if [ -z "${_script_dir:-}" ]; then
  printf '[dev-sync] cannot resolve launcher directory; refusing to start.\n' >&2
  exit 1
fi
repo_root=$(CDPATH= cd -- "$_script_dir/../.." && pwd)
if [ -z "${repo_root:-}" ]; then
  printf '[dev-sync] cannot resolve repository root; refusing to start.\n' >&2
  exit 1
fi

# --- pin: read `.nvmrc` (fallback `.node-version`); fail closed, never guess ---
read_pin_from_file() {
  _pin_file="$1"
  [ -f "$_pin_file" ] || return 1
  _raw=$(sed -n '1p' "$_pin_file" 2>/dev/null || true)
  _raw=$(printf '%s' "$_raw" | tr -d '\r')
  _trimmed=$(printf '%s' "$_raw" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  _stripped=$(printf '%s' "$_trimmed" | sed -e 's/^[vV=]*//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  [ -n "$_stripped" ] || return 1
  printf '%s' "$_stripped" | grep -E -q '^[0-9]+\.[0-9]+\.[0-9]+([-+].*)?$' || return 1
  printf '%s' "$_stripped"
  return 0
}

PIN=''
for _candidate in "$repo_root/.nvmrc" "$repo_root/.node-version"; do
  if _value=$(read_pin_from_file "$_candidate"); then
    PIN="$_value"
    break
  fi
done
if [ -z "$PIN" ]; then
  printf '[dev-sync] unreadable Node pin (.nvmrc/.node-version missing or invalid; expected e.g. 24.11.1).\n' >&2
  printf '[dev-sync] refusing to start before the Electron lane, installs, ports, or children (fail-closed).\n' >&2
  printf '[dev-sync] restore the repository pin files, then retry: pnpm dev:sync\n' >&2
  exit 1
fi

# --- version helpers (numeric compare; prerelease/build suffix ignored) ---
split_version() {
  _nums=$(printf '%s' "$1" | sed -e 's/[-+].*$//')
  _v_major=$(printf '%s' "$_nums" | cut -d. -f1)
  _v_minor=$(printf '%s' "$_nums" | cut -d. -f2)
  _v_patch=$(printf '%s' "$_nums" | cut -d. -f3)
  case "$_v_major" in '' | *[!0-9]*) return 1 ;; esac
  case "$_v_minor" in '' | *[!0-9]*) return 1 ;; esac
  case "$_v_patch" in '' | *[!0-9]*) return 1 ;; esac
  return 0
}

version_gte() {
  split_version "$1" || return 1
  _a1="$_v_major"
  _a2="$_v_minor"
  _a3="$_v_patch"
  split_version "$2" || return 1
  _b1="$_v_major"
  _b2="$_v_minor"
  _b3="$_v_patch"
  if [ "$_a1" -gt "$_b1" ]; then return 0; fi
  if [ "$_a1" -lt "$_b1" ]; then return 1; fi
  if [ "$_a2" -gt "$_b2" ]; then return 0; fi
  if [ "$_a2" -lt "$_b2" ]; then return 1; fi
  if [ "$_a3" -ge "$_b3" ]; then return 0; else return 1; fi
}

is_supported() {
  # $1 = current version (leading v already stripped), $2 = current ABI
  [ -n "${1:-}" ] || return 1
  [ -n "${2:-}" ] || return 1
  split_version "$1" || return 1
  _current_major="$_v_major"
  split_version "$PIN" || return 1
  [ "$_current_major" = "$_v_major" ] || return 1
  version_gte "$1" "$PIN" || return 1
  [ "$2" = "$REQUIRED_ABI" ] || return 1
  return 0
}

probe_version() {
  _probe_out=$("$1" -v 2>/dev/null || true)
  _probe_out=$(printf '%s' "$_probe_out" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^[vV=]*//')
  printf '%s' "$_probe_out"
}

probe_abi() {
  _abi_out=$("$1" -p 'process.versions.modules' 2>/dev/null || true)
  _abi_out=$(printf '%s' "$_abi_out" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  printf '%s' "$_abi_out"
}

# --- host observation (before any PATH change), versions/ABI only ---
host_node_path=$(command -v node 2>/dev/null || true)
if [ -n "$host_node_path" ]; then
  host_version=$(probe_version "$host_node_path")
  host_abi=$(probe_abi "$host_node_path")
else
  host_version=''
  host_abi=''
fi

# --- selection: installed exact pin first, else supported current host ---
if [ -z "${HOME:-}" ]; then
  printf '[dev-sync] HOME is unset; cannot locate the installed pinned Node.\n' >&2
  printf '[dev-sync] refusing to start before the Electron lane, installs, ports, or children (fail-closed).\n' >&2
  exit 1
fi
nvm_base="${NVM_DIR:-$HOME/.nvm}"
candidate_bin="$nvm_base/versions/node/v$PIN/bin"
candidate_node="$candidate_bin/node"

selected_node=''
selected_mode=''
candidate_note=''
if [ -x "$candidate_node" ]; then
  cand_version=$(probe_version "$candidate_node")
  cand_abi=$(probe_abi "$candidate_node")
  if [ "$cand_version" = "$PIN" ] && [ "$cand_abi" = "$REQUIRED_ABI" ]; then
    selected_node="$candidate_node"
    selected_mode='pin'
  else
    candidate_note="installed candidate for v$PIN failed validation (got v${cand_version:-unknown} ABI ${cand_abi:-unknown}); ignoring it."
  fi
fi
if [ -z "$selected_node" ]; then
  if [ -n "$host_node_path" ] && is_supported "$host_version" "$host_abi"; then
    selected_node="$host_node_path"
    selected_mode='current'
  fi
fi
if [ -z "$selected_node" ]; then
  if [ -n "$host_version" ]; then
    _host_desc="v$host_version ABI ${host_abi:-unknown}"
  else
    _host_desc='none'
  fi
  printf '[dev-sync] no supported Node runtime for this command: host %s; installed pin v%s (ABI %s) not found or invalid under the nvm versions dir.\n' "$_host_desc" "$PIN" "$REQUIRED_ABI" >&2
  if [ -n "$candidate_note" ]; then
    printf '[dev-sync] %s\n' "$candidate_note" >&2
  fi
  printf '[dev-sync] refusing to start before the Electron lane, installs, ports, or children (fail-closed).\n' >&2
  printf '[dev-sync] fix (command-local auto-select needs the pin installed; no dotfile change, no cache deletion needed):\n' >&2
  printf '[dev-sync]   nvm install %s\n' "$PIN" >&2
  printf '[dev-sync]   which -a node\n' >&2
  printf '[dev-sync] then retry: pnpm dev:sync\n' >&2
  exit 1
fi

# --- command-local PATH: selected bin first, exported to descendants only ---
if [ "$selected_mode" = 'pin' ]; then
  case ":$PATH:" in
    "$candidate_bin:"*) ;;
    *) PATH="$candidate_bin:$PATH"; export PATH ;;
  esac
  if [ "${host_version:-}" != "$PIN" ] || [ "${host_abi:-}" != "$REQUIRED_ABI" ]; then
    if [ -n "${host_version:-}" ]; then
      _was="v$host_version ABI ${host_abi:-unknown}"
    else
      _was='no host node'
    fi
    printf '[dev-sync] command-local Node v%s (ABI %s) selected for this command (host was %s); no shell/dotfile change.\n' "$PIN" "$REQUIRED_ABI" "$_was" >&2
  fi
fi

# --- existing preflight with the selected Node, then exec the canonical lane ---
"$selected_node" "$repo_root/scripts/dev-sync/runtime-preflight.js"
_preflight_code="$?"
if [ "$_preflight_code" -ne 0 ]; then
  exit "$_preflight_code"
fi

exec pnpm native:run electron -- tsx scripts/dev-sync/cli.ts ${1+"$@"}
