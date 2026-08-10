# 🖥️ Develop

> For the always-on AI coding assistant contract, see [`AGENTS.md`](../../../AGENTS.md). For the detailed architecture reference, see [`docs/architecture.md`](../../architecture.md).

## IDE Setup

### VSCode like

- Editor: [Cursor](https://www.cursor.com/), etc. Any VS Code compatible editor.
- Recommended extensions are listed in [`.vscode/extensions.json`](/.vscode/extensions.json).

### Zed

1. Install extensions: [Biome](https://github.com/biomejs/biome-zed), [oxc](https://github.com/oxc-project/zed-oxc)
2. Copy the example settings file to your local Zed config:
   ```bash
   cp .zed/settings.json.example .zed/settings.json
   ```
3. Customize `.zed/settings.json` as needed (it is git-ignored).

## Windows: Enable Symlinks

This project uses symlinks to synchronize files such as AGENTS.md and skills. Windows developers must enable symlink support before cloning:

1. **Enable Developer Mode** (Settings → Update & Security → For developers), or grant `SeCreateSymbolicLinkPrivilege` via `secpol.msc`.
2. **Configure Git**:
   ```bash
   git config --global core.symlinks true
   ```
3. Clone (or re-clone) the repository after enabling symlink support.

## Project Setup

### Install

```bash
pnpm install
```

### Development

### Setup Node.js

The required Node.js version is defined in `.node-version`. Use a version manager like [nvm](https://github.com/nvm-sh/nvm) or [fnm](https://github.com/Schniz/fnm) to install it automatically:

```bash
nvm install
```

### Setup pnpm

The pnpm version is locked in the `packageManager` field of `package.json`. Just enable corepack and it will use the correct version automatically:

```bash
corepack enable
```

### Install Dependencies

```bash
pnpm install
```

### Native ABI (better-sqlite3)

`better-sqlite3` is the single native module. It is compiled for **either** Node24 (ABI 137) **or** Electron 41.2.1 (ABI 145) — never both at once.

- `.node-version` / `.nvmrc` are the source of truth for the required Node version.
- Confirm Node24 is on PATH (`node -v`) before `pnpm install`; installing under the wrong Node can produce an incompatible binding.
- **Public commands manage the ABI lane themselves — no manual check/rebuild prefix is needed.** Node-lane commands (`pnpm test`, `pnpm test:main`, `pnpm test:renderer`, …) self-ensure the Node ABI 137 binding and restore the local Electron ABI 145 default afterwards (CI skips the restoration). Electron-lane commands (`pnpm dev`, `pnpm build`, `pnpm test:e2e`, …) self-ensure the Electron ABI 145 binding. Neutral commands (`pnpm lint`, `pnpm format`, `pnpm typecheck`, …) do not touch the binding.
- Node and Electron commands are **serialized**: concurrent opposite-lane runs fail deterministically with a clear conflict instead of silently switching the binding.
- `pnpm native:check:node` / `pnpm native:check:electron` are **read-only diagnostics** (real runtime SQL probe; they never modify the binding).
- `pnpm native:rebuild:node` / `pnpm native:rebuild:electron` are **explicit repair / debug only** — for a broken binding or a forced fresh build, not daily switching.
- Do not call the internal `*:run` helper scripts directly (`dev:run`, `test:run`, …) or infer the current ABI from files/imports; use the public commands and `native:check:*`.

### ENV

```bash
cp .env.example .env
```

### Start

```bash
pnpm dev
```

### Debug

```bash
pnpm debug
```

Then input chrome://inspect in browser

### Test

```bash
pnpm test
```

### Build

```bash
# For windows
$ pnpm build:win

# For macOS
$ pnpm build:mac

# For Linux
$ pnpm build:linux
```
