# 🖥️ Develop

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
- Preflights (`pnpm dev` / `pnpm test` / …) only verify the binding — they never rebuild.
- Switch explicitly between ABIs when needed:
  - `pnpm native:rebuild:node` — rebuild for Node24 (ABI 137), then `pnpm native:check:node`
  - `pnpm native:rebuild:electron` — rebuild for Electron 41.2.1 (ABI 145), then `pnpm native:check:electron`

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
