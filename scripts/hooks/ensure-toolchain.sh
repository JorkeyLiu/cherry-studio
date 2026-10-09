#!/bin/sh
# Hook toolchain bootstrap (sourced, never executed directly).
#
# Ensures the repository-pinned Node + pnpm are resolvable for noninteractive
# Git/VS Code hook environments, without sourcing any interactive shell rc.
#
# Bounded policy (this machine only, no toolchain-manager framework):
#   1. If the inherited PATH already resolves node at the repo-pinned version
#      AND resolves pnpm at the packageManager-pinned version (derived from
#      package.json via the selected Node, never a duplicated literal), the
#      inherited pair is used untouched.
#   2. Otherwise the repo-pinned nvm fallback
#      ("$HOME/.nvm/versions/node/v<pinned>/bin", overridable via
#      HOOK_NVM_ROOT for tests) is prepended to PATH when it provides the
#      pinned node AND the packageManager-pinned pnpm. This overrides a
#      conflicting wrong-version node or a wrong-version pnpm. The prepended
#      bin keeps the pnpm/corepack shim on the selected Node.
#   3. Otherwise fail closed with exit 127 and a deterministic diagnostic
#      naming the required Node + pnpm versions.
# Never selects an arbitrary/newest Node; never touches shell dotfiles.

hook_ensure_toolchain() {
  _hook_script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd) || {
    printf '%s\n' 'hook-toolchain: cannot resolve hook script directory' >&2
    return 127
  }
  _hook_repo_root=$(CDPATH= cd -- "$_hook_script_dir/../.." 2>/dev/null && pwd) || {
    printf '%s\n' 'hook-toolchain: cannot resolve repository root' >&2
    return 127
  }
  _hook_pinned=""
  if [ -f "$_hook_repo_root/.nvmrc" ]; then
    _hook_pinned=$(tr -d ' \t\r\n' <"$_hook_repo_root/.nvmrc" 2>/dev/null)
  fi
  if [ -z "$_hook_pinned" ] && [ -f "$_hook_repo_root/.node-version" ]; then
    _hook_pinned=$(tr -d ' \t\r\n' <"$_hook_repo_root/.node-version" 2>/dev/null)
  fi
  if [ -z "$_hook_pinned" ]; then
    printf '%s\n' 'hook-toolchain: pinned Node version not found (.nvmrc/.node-version unreadable)' >&2
    unset _hook_script_dir _hook_repo_root _hook_pinned
    return 127
  fi

  _hook_pinned_pnpm=""
  _hook_node_version=""
  _hook_pnpm_version=""
  _hook_inherited_node=""
  _hook_nvm_base=""
  _hook_candidate=""
  _hook_candidate_version=""
  _hook_candidate_pnpm_version=""
  _hook_derive_out=""

  # 1. Prefer a valid inherited pair (pinned node + packageManager-pinned pnpm).
  if command -v node >/dev/null 2>&1; then
    _hook_node_version=$(node --version 2>/dev/null) || _hook_node_version=""
    if [ "$_hook_node_version" = "v$_hook_pinned" ]; then
      _hook_inherited_node=$(command -v node 2>/dev/null) || _hook_inherited_node=""
      if [ -n "$_hook_inherited_node" ]; then
        _hook_derive_out=$("$_hook_inherited_node" -e 'try{var fs=require("fs");var path=require("path");var root=process.argv[1];var raw=fs.readFileSync(path.join(root,"package.json"),"utf8");var pm=(JSON.parse(raw).packageManager||"").trim();var m=/^pnpm@([^\s+]+)/.exec(pm);if(!m||!m[1]){process.exit(1)}console.log(m[1])}catch(e){process.exit(1)}' "$_hook_repo_root" 2>/dev/null) || _hook_derive_out=""
        if [ -n "$_hook_derive_out" ]; then
          _hook_pinned_pnpm="$_hook_derive_out"
          if command -v pnpm >/dev/null 2>&1; then
            _hook_pnpm_version=$(pnpm --version 2>/dev/null) || _hook_pnpm_version=""
            if [ "$_hook_pnpm_version" = "$_hook_pinned_pnpm" ]; then
              unset _hook_script_dir _hook_repo_root _hook_pinned _hook_pinned_pnpm _hook_node_version _hook_pnpm_version _hook_inherited_node _hook_nvm_base _hook_candidate _hook_candidate_version _hook_candidate_pnpm_version _hook_derive_out
              return 0
            fi
          fi
        fi
      fi
    fi
  fi

  # 2. Pinned nvm fallback (overrides wrong-version node or wrong-version pnpm).
  _hook_nvm_base=${HOOK_NVM_ROOT:-$HOME/.nvm/versions/node}
  _hook_candidate="$_hook_nvm_base/v$_hook_pinned/bin"
  if [ -x "$_hook_candidate/node" ]; then
    _hook_candidate_version=$("$_hook_candidate/node" --version 2>/dev/null) || _hook_candidate_version=""
    if [ "$_hook_candidate_version" = "v$_hook_pinned" ]; then
      _hook_derive_out=$("$_hook_candidate/node" -e 'try{var fs=require("fs");var path=require("path");var root=process.argv[1];var raw=fs.readFileSync(path.join(root,"package.json"),"utf8");var pm=(JSON.parse(raw).packageManager||"").trim();var m=/^pnpm@([^\s+]+)/.exec(pm);if(!m||!m[1]){process.exit(1)}console.log(m[1])}catch(e){process.exit(1)}' "$_hook_repo_root" 2>/dev/null) || _hook_derive_out=""
      if [ -n "$_hook_derive_out" ]; then
        _hook_pinned_pnpm="$_hook_derive_out"
        PATH="$_hook_candidate:$PATH"
        export PATH
        if command -v pnpm >/dev/null 2>&1; then
          _hook_candidate_pnpm_version=$(pnpm --version 2>/dev/null) || _hook_candidate_pnpm_version=""
          if [ "$_hook_candidate_pnpm_version" = "$_hook_pinned_pnpm" ]; then
            unset _hook_script_dir _hook_repo_root _hook_pinned _hook_pinned_pnpm _hook_node_version _hook_pnpm_version _hook_inherited_node _hook_nvm_base _hook_candidate _hook_candidate_version _hook_candidate_pnpm_version _hook_derive_out
            return 0
          fi
        fi
      fi
    fi
  fi

  # 3. No valid pair: fail closed with the required Node + pnpm versions.
  if [ -z "$_hook_pinned_pnpm" ]; then
    _hook_pinned_pnpm=$(sed -n 's/.*"packageManager"[[:space:]]*:[[:space:]]*"pnpm@\([^"+]*\)["+].*/\1/p' "$_hook_repo_root/package.json" 2>/dev/null) || _hook_pinned_pnpm=""
    if [ -z "$_hook_pinned_pnpm" ]; then
      _hook_pinned_pnpm="<unreadable packageManager pin>"
    fi
  fi
  printf '%s\n' "hook-toolchain: require node v$_hook_pinned and pnpm $_hook_pinned_pnpm (packageManager pin); no usable toolchain on PATH and no usable nvm fallback (looked in $_hook_candidate); install Node $_hook_pinned via nvm (no other Node will be selected)" >&2
  unset _hook_script_dir _hook_repo_root _hook_pinned _hook_pinned_pnpm _hook_node_version _hook_pnpm_version _hook_inherited_node _hook_nvm_base _hook_candidate _hook_candidate_version _hook_candidate_pnpm_version _hook_derive_out
  return 127
}
