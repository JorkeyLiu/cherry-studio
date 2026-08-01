/**
 * Server-only Vite dev-server child for the dev-origin E2E (LOCK-DEV-5).
 *
 * This module is spawned as a detached child process by owned-vite-server.ts.
 * It uses Vite's `createServer` API directly — it NEVER imports or starts
 * Electron. This is the replacement for `electron-vite dev --rendererOnly`,
 * which unconditionally calls startElectron() even with --rendererOnly.
 *
 * The config is built from the repository's actual renderer configuration
 * (from electron.vite.config.ts) as faithfully as needed for the chatImport
 * entryPoint and its imports. The minimal config covers:
 *   - Exact root: src/renderer (where chatImport.html lives)
 *   - Resolve aliases: @renderer, @shared, @types, @logger, @mcp-trace/*, @cherrystudio/*
 *   - Plugin: @vitejs/plugin-react-swc with tsDecorators
 *   - Server: host=localhost, port=5173, strictPort=true
 *
 * Rationale for not importing electron.vite.config.ts directly:
 *   The config imports local scripts (buildProxyBootstrapPlugin) and packages
 *   that aren't resolvable in a plain Node context without Electron/rollup
 *   setup. Building the minimal config avoids this dependency while covering
 *   exactly what the chatImport entry needs.
 *
 * Lifecycle:
 *   1. Parent sends projectRoot via argv.
 *   2. Child creates a Vite dev server with the minimal renderer config.
 *   3. Child sends { type: 'ready', port, host, origin, base, url } via IPC.
 *   4. On error, child sends { type: 'error', message } via IPC.
 *   5. Parent sends SIGTERM to stop; child closes server and exits 0.
 *
 * LOCK-DEV-5: True server-only — no Electron process spawned.
 * LOCK-DEV-7: strictPort=true, port=5173, host='localhost'.
 */
import path from 'node:path'
import { createServer } from 'vite'

// ---------------------------------------------------------------------------
// IPC helpers
// ---------------------------------------------------------------------------

function send(msg) {
  if (process.send) {
    process.send(msg)
  }
}

function fatal(message, err) {
  const detail = err instanceof Error ? err.message : String(err)
  send({ type: 'error', message: `${message}: ${detail}` })
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Signal handling
// ---------------------------------------------------------------------------

let server = null
let closing = false

async function shutdown() {
  if (closing) return
  closing = true
  if (server) {
    try {
      await server.close()
    } catch {
      // Ignore close errors — we're shutting down.
    }
  }
  process.exit(0)
}

process.on('SIGTERM', () => shutdown())
process.on('SIGINT', () => shutdown())

// Uncaught errors must not leave the child as a zombie.
process.on('uncaughtException', (err) => {
  fatal('Uncaught exception in Vite server child', err)
})
process.on('unhandledRejection', (reason) => {
  fatal('Unhandled rejection in Vite server child', reason)
})

// ---------------------------------------------------------------------------
// Minimal renderer config (sourced from electron.vite.config.ts renderer section)
// ---------------------------------------------------------------------------

function buildRendererConfig(projectRoot) {
  // Root: src/renderer — this is where chatImport.html lives.
  // The HTML script src "/src/windows/chatImport/entryPoint.ts" resolves
  // relative to this root as src/renderer/src/windows/chatImport/entryPoint.ts.
  const rendererRoot = path.join(projectRoot, 'src', 'renderer')

  // Aliases: extracted from the renderer section of electron.vite.config.ts.
  // These are required by the chatImport entry point and its dynamic imports.
  const alias = {
    '@renderer': path.join(projectRoot, 'src', 'renderer', 'src'),
    '@shared': path.join(projectRoot, 'packages', 'shared'),
    '@types': path.join(projectRoot, 'src', 'renderer', 'src', 'types'),
    '@logger': path.join(projectRoot, 'src', 'renderer', 'src', 'services', 'LoggerService'),
    '@mcp-trace/trace-core': path.join(projectRoot, 'packages', 'mcp-trace', 'trace-core'),
    '@mcp-trace/trace-web': path.join(projectRoot, 'packages', 'mcp-trace', 'trace-web'),
    '@cherrystudio/ai-core/provider': path.join(projectRoot, 'packages', 'aiCore', 'src', 'core', 'providers'),
    '@cherrystudio/ai-core/built-in/plugins': path.join(
      projectRoot,
      'packages',
      'aiCore',
      'src',
      'core',
      'plugins',
      'built-in'
    ),
    '@cherrystudio/ai-core': path.join(projectRoot, 'packages', 'aiCore', 'src'),
    '@cherrystudio/extension-table-plus': path.join(projectRoot, 'packages', 'extension-table-plus', 'src'),
    '@cherrystudio/ai-sdk-provider': path.join(projectRoot, 'packages', 'ai-sdk-provider', 'src')
  }

  // Plugins: @vitejs/plugin-react-swc with tsDecorators (from electron.vite.config.ts).
  // Dynamic import to handle ESM resolution.
  return {
    root: rendererRoot,
    resolve: { alias },
    plugins: [], // populated dynamically below
    optimizeDeps: {
      exclude: ['pyodide'],
      esbuildOptions: { target: 'esnext' }
    },
    worker: { format: 'es' },
    server: {
      host: 'localhost',
      port: Number(process.argv[3]) || 5173,
      strictPort: true
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const projectRoot = process.argv[2]
  if (!projectRoot) {
    fatal('Missing required argument: projectRoot', new Error('No projectRoot argument'))
  }

  try {
    const config = buildRendererConfig(projectRoot)

    // Load plugins dynamically — @vitejs/plugin-react-swc and @tailwindcss/vite.
    // These must be imported after the process is in the project context so
    // bare-package resolution works from node_modules.
    const reactSwc = await import('@vitejs/plugin-react-swc')
    config.plugins.push(reactSwc.default({ tsDecorators: true }))

    try {
      const tailwindcss = await import('@tailwindcss/vite')
      config.plugins.push(tailwindcss.default())
    } catch {
      // TailwindCSS plugin is optional — chatImport doesn't use Tailwind directly.
    }

    server = await createServer(config)
    await server.listen()

    const addr = server.httpServer?.address()
    if (!addr || typeof addr === 'string') {
      fatal('HTTP server address not available', new Error('No address'))
    }

    const host = 'localhost'
    const port = typeof addr === 'object' ? addr.port : 5173
    const origin = `http://${host}:${port}`
    const url = origin

    send({ type: 'ready', port, host, origin, base: '/', url })
  } catch (err) {
    fatal('Failed to start Vite dev server', err)
  }
}

main()
