import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

import electronViteConfig from './electron.vite.config'

const mainConfig = (electronViteConfig as any).main
const rendererConfig = (electronViteConfig as any).renderer

export default defineConfig({
  test: {
    projects: [
      // 主进程单元测试配置
      {
        extends: true,
        plugins: mainConfig.plugins,
        resolve: {
          alias: mainConfig.resolve.alias
        },
        test: {
          name: 'main',
          environment: 'node',
          setupFiles: ['tests/main.setup.ts'],
          include: ['src/main/**/*.{test,spec}.{ts,tsx}', 'src/main/**/__tests__/**/*.{test,spec}.{ts,tsx}'],
          benchmark: {
            include: ['src/main/**/*.bench.{ts,tsx}', 'src/main/**/__tests__/**/*.bench.{ts,tsx}']
          }
        }
      },
      // 渲染进程单元测试配置
      {
        extends: true,
        plugins: rendererConfig.plugins.filter((plugin: any) => plugin.name !== 'tailwindcss'),
        resolve: {
          alias: rendererConfig.resolve.alias
        },
        test: {
          name: 'renderer',
          environment: 'jsdom',
          setupFiles: ['@vitest/web-worker', 'tests/renderer.setup.ts'],
          include: ['src/renderer/**/*.{test,spec}.{ts,tsx}', 'src/renderer/**/__tests__/**/*.{test,spec}.{ts,tsx}'],
          benchmark: {
            include: ['src/renderer/**/*.bench.{ts,tsx}', 'src/renderer/**/__tests__/**/*.bench.{ts,tsx}']
          }
        }
      },
      // 脚本单元测试配置
      {
        extends: true,
        test: {
          name: 'scripts',
          environment: 'node',
          include: ['scripts/**/*.{test,spec}.{ts,tsx}', 'scripts/**/__tests__/**/*.{test,spec}.{ts,tsx}'],
          benchmark: {
            include: ['scripts/**/*.bench.{ts,tsx}', 'scripts/**/__tests__/**/*.bench.{ts,tsx}']
          }
        }
      },
      // aiCore 包单元测试配置
      {
        extends: 'packages/aiCore/vitest.config.ts',
        test: {
          name: 'aiCore',
          environment: 'node',
          include: [
            'packages/aiCore/**/*.{test,spec}.{ts,tsx}',
            'packages/aiCore/**/__tests__/**/*.{test,spec}.{ts,tsx}'
          ],
          benchmark: {
            include: ['packages/aiCore/**/*.bench.{ts,tsx}', 'packages/aiCore/**/__tests__/**/*.bench.{ts,tsx}']
          }
        }
      },
      // shared 包单元测试配置
      {
        extends: true,
        resolve: {
          alias: {
            '@shared': resolve('packages/shared')
          }
        },
        test: {
          name: 'shared',
          environment: 'node',
          include: [
            'packages/shared/**/*.{test,spec}.{ts,tsx}',
            'packages/shared/**/__tests__/**/*.{test,spec}.{ts,tsx}'
          ],
          benchmark: {
            include: ['packages/shared/**/*.bench.{ts,tsx}', 'packages/shared/**/__tests__/**/*.bench.{ts,tsx}']
          }
        }
      },
      // E2E utility tests (non-Electron, non-Playwright unit tests)
      {
        extends: true,
        test: {
          name: 'e2e-utils',
          environment: 'node',
          include: ['tests/e2e/utils/**/*.test.ts'],
          testTimeout: 15000
        }
      }
    ],
    // 全局共享配置
    globals: true,
    setupFiles: [],
    exclude: ['**/node_modules/**', '**/dist/**', '**/out/**', '**/build/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov', 'text-summary'],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/out/**',
        '**/build/**',
        '**/coverage/**',
        '**/tests/**',
        '**/.yarn/**',
        '**/.cursor/**',
        '**/.vscode/**',
        '**/.github/**',
        '**/.husky/**',
        '**/*.d.ts',
        '**/types/**',
        '**/__tests__/**',
        '**/*.{test,spec}.{ts,tsx}',
        '**/*.config.{js,ts}'
      ]
    },
    testTimeout: 20000,
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: false
      }
    },
    // Native-module (better-sqlite3) suites run in fork processes so the
    // Node ABI 137 binding is loaded under process isolation (LOCK-ABI-2 —
    // real runtime SQL only; markers are never trusted). Thread-pool runs of
    // the native binding are flaky (SIGSEGV), so every native suite in the
    // v2 recovery verification scope is pinned to forks. recoveryV2.test.ts
    // is pure TS but is ALSO pinned to forks (LOCK-MEM-4): its exhaustive
    // 236,196-combination sweep must run in a single bounded-memory fork
    // process, not a thread-pool worker. The canonical single-fork command
    // is documented with the recoveryV2 test itself.
    poolMatchGlobs: [
      ['**/promotion/__tests__/execution.test.ts', 'forks'],
      ['**/promotion/__tests__/recoveryExecutorV2.test.ts', 'forks'],
      ['**/promotion/__tests__/rollbackV2.test.ts', 'forks'],
      ['**/promotion/__tests__/rollback.test.ts', 'forks'],
      ['**/promotion/__tests__/artifactProbe.test.ts', 'forks'],
      ['**/promotion/__tests__/install.test.ts', 'forks'],
      ['**/promotion/__tests__/preparation.test.ts', 'forks'],
      ['**/promotion/__tests__/replacementVerifier.test.ts', 'forks'],
      ['**/promotion/__tests__/snapshot.test.ts', 'forks'],
      ['**/promotion/__tests__/recoveryV2.test.ts', 'forks'],
      // Shiki exact-HTML contract: pin to a single bounded fork process so the
      // exact HTML toBe() assertions are isolated from thread-pool contention
      // in full-suite runs (LOCK-STAB).
      ['**/ShikiStreamTokenizer.test.ts', 'forks']
    ]
  }
})
