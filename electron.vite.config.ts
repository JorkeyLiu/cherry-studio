import react from '@vitejs/plugin-react-swc'
import { CodeInspectorPlugin } from 'code-inspector-plugin'
import { defineConfig } from 'electron-vite'
import { resolve } from 'path'
import { visualizer } from 'rollup-plugin-visualizer'

// assert not supported by biome
// import pkg from './package.json' assert { type: 'json' }
import pkg from './package.json'
import { BUILD_ID_ENV, BUILD_VERSION_ENV, currentBuildIdentity } from './scripts/build-identity'
import { buildProxyBootstrapPlugin } from './scripts/buildProxyBootstrapPlugin'

const visualizerPlugin = (type: 'renderer' | 'main') => {
  return process.env[`VISUALIZER_${type.toUpperCase()}`] ? [visualizer({ open: true })] : []
}

const isDev = process.env.NODE_ENV === 'development'
const isProd = process.env.NODE_ENV === 'production'

// Application identity is a single immutable constant
// (packages/shared/config/identity.ts, LOCK-RETIRE-001); there is no
// build-time flavor define anymore (LOCK-RETIRE-002).

// VERSION-003: one build invocation computes the Build ID once (build-identity
// wrapper sets CHERRY_CHAT_BUILD_ID / CHERRY_CHAT_BUILD_VERSION for the whole
// spawn tree). When absent (plain `electron-vite build`, `dev`), compute a
// fallback identity here so the About surface still has a traceable value.
//
// A hand-crafted PARTIAL environment (exactly one of the two env halves set)
// is treated as absent so buildId and buildVersion always come from the SAME
// single capture and can never disagree (VERSION-003 coherence). This compile
// side is the only place a partial env is absorbed: on the PACKAGING path a
// partial env is a hard failure (scripts/assert-build-identity-env.js via the
// beforePack hook), so no artifact can ever carry a split identity.
function resolveBuildIdentity(): { buildId: string; macBuildVersion: string } {
  const envBuildId = process.env[BUILD_ID_ENV]
  const envBuildVersion = process.env[BUILD_VERSION_ENV]
  if (envBuildId && envBuildVersion) {
    return { buildId: envBuildId, macBuildVersion: envBuildVersion }
  }
  // Under Vitest this config is loaded only for its plugins/aliases — the
  // `define` values are never consumed, so never spawn git subprocesses while
  // test configs load (process.env.VITEST is the Vitest marker).
  if (process.env.VITEST === 'true') {
    return { buildId: 'test-build-identity', macBuildVersion: '0' }
  }
  // Partial env or no env: compute both halves fresh from ONE captured
  // timestamp so buildId/buildVersion always agree.
  const identity = currentBuildIdentity()
  return { buildId: identity.buildId, macBuildVersion: identity.macBuildVersion }
}

const buildIdentity = resolveBuildIdentity()

export default defineConfig({
  main: {
    plugins: [
      ...visualizerPlugin('main'),
      buildProxyBootstrapPlugin({
        dependencies: Object.keys(pkg.dependencies),
        isProd,
        rootDir: __dirname
      })
    ],
    resolve: {
      alias: {
        '@main': resolve('src/main'),
        '@types': resolve('src/renderer/src/types'),
        '@shared': resolve('packages/shared'),
        '@logger': resolve('src/main/services/LoggerService'),
        '@mcp-trace/trace-core': resolve('packages/mcp-trace/trace-core'),
        '@mcp-trace/trace-node': resolve('packages/mcp-trace/trace-node')
      }
    },
    define: {
      // VERSION-004: Build ID / numeric build version are separate fields from
      // the product version (`app.getVersion()` stays package.json 0.1.0).
      __BUILD_ID__: JSON.stringify(buildIdentity.buildId),
      __BUILD_VERSION__: JSON.stringify(buildIdentity.macBuildVersion)
    },
    build: {
      rollupOptions: {
        external: ['bufferutil', 'utf-8-validate', 'electron', ...Object.keys(pkg.dependencies)],
        output: {
          manualChunks: undefined, // 彻底禁用代码分割 - 返回 null 强制单文件打包
          inlineDynamicImports: true // 内联所有动态导入，这是关键配置
        },
        onwarn(warning, warn) {
          if (warning.code === 'COMMONJS_VARIABLE_IN_ESM') return
          warn(warning)
        }
      },
      sourcemap: isDev
    },
    esbuild: isProd ? { legalComments: 'none' } : {},
    optimizeDeps: {
      noDiscovery: isDev
    }
  },
  preload: {
    plugins: [
      react({
        tsDecorators: true
      })
    ],
    resolve: {
      alias: {
        '@shared': resolve('packages/shared'),
        '@mcp-trace/trace-core': resolve('packages/mcp-trace/trace-core')
      }
    },
    build: {
      lib: {
        entry: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          'chat-import-preload': resolve(__dirname, 'src/preload/chatImport/index.ts')
        },
        formats: ['cjs' as const]
      },
      rollupOptions: {
        external: ['electron'],
        output: {
          entryFileNames: '[name].js'
        }
      },
      sourcemap: isDev
    }
  },
  renderer: {
    plugins: [
      (async () => (await import('@tailwindcss/vite')).default())(),
      react({
        tsDecorators: true
      }),
      ...(isDev ? [CodeInspectorPlugin({ bundler: 'vite' })] : []), // 只在开发环境下启用 CodeInspectorPlugin
      ...visualizerPlugin('renderer')
    ],
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('packages/shared'),
        '@types': resolve('src/renderer/src/types'),
        '@logger': resolve('src/renderer/src/services/LoggerService'),
        '@mcp-trace/trace-core': resolve('packages/mcp-trace/trace-core'),
        '@mcp-trace/trace-web': resolve('packages/mcp-trace/trace-web'),
        '@cherrystudio/ai-core/provider': resolve('packages/aiCore/src/core/providers'),
        '@cherrystudio/ai-core/built-in/plugins': resolve('packages/aiCore/src/core/plugins/built-in'),
        '@cherrystudio/ai-core': resolve('packages/aiCore/src'),
        '@cherrystudio/extension-table-plus': resolve('packages/extension-table-plus/src')
      }
    },
    optimizeDeps: {
      exclude: ['pyodide'],
      esbuildOptions: {
        target: 'esnext' // for dev
      }
    },
    worker: {
      format: 'es'
    },
    build: {
      target: 'esnext', // for build
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          miniWindow: resolve(__dirname, 'src/renderer/miniWindow.html'),
          traceWindow: resolve(__dirname, 'src/renderer/traceWindow.html'),
          chatImport: resolve(__dirname, 'src/renderer/src/windows/chatImport/chatImport.html')
        },
        onwarn(warning, warn) {
          if (warning.code === 'COMMONJS_VARIABLE_IN_ESM') return
          warn(warning)
        }
      }
    },
    esbuild: isProd ? { legalComments: 'none' } : {}
  }
})
