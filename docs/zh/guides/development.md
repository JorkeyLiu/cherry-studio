# 🖥️ 开发指南

> AI 编码助手的常驻契约见 [`AGENTS.md`](../../../AGENTS.md)。详细架构参考见 [`docs/architecture.md`](../../architecture.md)。

## IDE 配置

### VSCode like

- 编辑器：[Cursor](https://www.cursor.com/) 等，任何 VS Code 兼容编辑器均可。
- 推荐扩展见 [`.vscode/extensions.json`](/.vscode/extensions.json)。

### Zed

1. 安装扩展：[Biome](https://github.com/biomejs/biome-zed)、[oxc](https://github.com/oxc-project/zed-oxc)
2. 复制示例配置文件到本地 Zed 配置目录：
   ```bash
   cp .zed/settings.json.example .zed/settings.json
   ```
3. 按需自定义 `.zed/settings.json`（该文件已被 git 忽略）。

## Windows：启用符号链接

本项目使用符号链接同步 AGENTS.md、skills 等文件。Windows 开发者在克隆前需启用符号链接支持：

1. **启用开发者模式**（设置 → 更新和安全 → 开发者选项），或通过 `secpol.msc` 授予 `SeCreateSymbolicLinkPrivilege` 权限。
2. **配置 Git**：
   ```bash
   git config --global core.symlinks true
   ```
3. 启用后重新克隆仓库。

## 项目配置

### 安装 Node.js

项目所需的 Node.js 版本定义在 `.node-version` 文件中。推荐使用 [nvm](https://github.com/nvm-sh/nvm)、[fnm](https://github.com/Schniz/fnm) 等版本管理工具自动切换：

```bash
nvm install
```

### 安装 pnpm

pnpm 版本已锁定在 `package.json` 的 `packageManager` 字段中，通过 corepack 即可自动安装对应版本：

```bash
corepack enable
```

### 安装依赖

```bash
pnpm install
```

### 原生 ABI（better-sqlite3）

`better-sqlite3` 是唯一的原生模块，编译目标为 **Node24（ABI 137）** 或 **Electron 41.2.1（ABI 145）** 之一——两者不可同时存在。

- `.node-version` / `.nvmrc` 是所需 Node 版本的权威来源。
- 执行 `pnpm install` 前请确认 Node24 已在 PATH 中（`node -v`）；在错误的 Node 版本下安装可能产生不兼容的 binding。
- **公开命令自行管理 ABI lane，无需手动前置 check/rebuild。** Node lane 命令（`pnpm test`、`pnpm test:main`、`pnpm test:renderer` 等）自确保 Node ABI 137 binding，并在本地结束后恢复 Electron ABI 145 默认状态（CI 跳过该恢复）。Electron lane 命令（`pnpm dev`、`pnpm build`、`pnpm test:e2e` 等）自确保 Electron ABI 145 binding。中性命令（`pnpm lint`、`pnpm format`、`pnpm typecheck` 等）不触碰 binding。
- Node 与 Electron 命令**串行化**：并发的反向 lane 运行会以明确的冲突确定性失败，而不会静默切换 binding。
- `pnpm native:check:node` / `pnpm native:check:electron` 为**只读诊断**（真实运行时 SQL 探针；绝不修改 binding）。
- `pnpm native:rebuild:node` / `pnpm native:rebuild:electron` 为**显式修复/调试专用**——仅在 binding 损坏或需要强制全新编译时使用，日常切换请使用公开命令。
- 不要直接调用内部 `*:run` 辅助脚本（`dev:run`、`test:run` 等），也不要从文件/import 推断当前 ABI；请使用公开命令与 `native:check:*`。

### 环境变量

```bash
cp .env.example .env
```

### 启动开发

```bash
pnpm dev
```

### 调试

```bash
pnpm debug
```

然后在浏览器中访问 chrome://inspect

### 测试

```bash
pnpm test
```

### 构建

```bash
# Windows
$ pnpm build:win

# macOS
$ pnpm build:mac

# Linux
$ pnpm build:linux
```
