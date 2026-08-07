import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

import electronViteConfig from './electron.vite.config'
import { classifyMainBenchFiles, classifyMainTestFiles } from './scripts/vitest-lanes/mainLanes'

const mainConfig = (electronViteConfig as any).main
const rendererConfig = (electronViteConfig as any).renderer

// Deterministic lane manifests for the main-process suite (LOCK-TEST-001..006):
// `main` (core) runs every non-native, non-heavy main test on at most 2 thread
// workers; `main-native` and `main-heavy` each run on a single fork worker so
// the better-sqlite3 binding and the memory-heavy exhaustive/benchmark suites
// never run in a thread-pool worker. See scripts/vitest-lanes/mainLanes.ts.
const mainLanes = classifyMainTestFiles()
const mainBenchLanes = classifyMainBenchFiles()

export default defineConfig({
  test: {
    projects: [
      // 主进程核心 lane：无 native / 无 heavy 的其余主进程测试，threads 上限 2
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
          include: mainLanes.core,
          pool: 'threads',
          poolOptions: {
            threads: {
              maxThreads: 2
            }
          },
          benchmark: {
            include: mainBenchLanes.core
          }
        }
      },
      // 主进程 native lane：直接加载 better-sqlite3、显式 vi.unmock/doUnmock
      // 真实环境测试、以及 legacy fork-pinned 文件；单 fork worker
      // （LOCK-ABI-2 —— 原生绑定绝不在线程池 worker 中加载）
      {
        extends: true,
        plugins: mainConfig.plugins,
        resolve: {
          alias: mainConfig.resolve.alias
        },
        test: {
          name: 'main-native',
          environment: 'node',
          setupFiles: ['tests/main.setup.ts'],
          include: mainLanes.native,
          pool: 'forks',
          poolOptions: {
            forks: {
              maxForks: 1
            }
          },
          benchmark: {
            include: mainBenchLanes.native
          }
        }
      },
      // 主进程 heavy lane：10k 消息 SQLite 集成 benchmark 与 recoveryV2 的
      // 236,196 组合穷举，必须独占一个内存受限的单 fork 进程（LOCK-MEM-4）
      {
        extends: true,
        plugins: mainConfig.plugins,
        resolve: {
          alias: mainConfig.resolve.alias
        },
        test: {
          name: 'main-heavy',
          environment: 'node',
          setupFiles: ['tests/main.setup.ts'],
          include: mainLanes.heavy,
          pool: 'forks',
          poolOptions: {
            forks: {
              maxForks: 1
            }
          },
          benchmark: {
            include: mainBenchLanes.heavy
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
          },
          // Renderer-only fork isolation (LOCK-STAB): the Shiki exact-HTML
          // contract is pinned to a single bounded fork process so its exact
          // HTML toBe() assertions are isolated from thread-pool contention.
          // poolMatchGlobs is deprecated and is deliberately retained ONLY
          // here, scoped to the renderer project — no main-process routing.
          poolMatchGlobs: [['**/ShikiStreamTokenizer.test.ts', 'forks']]
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
    // Root safety caps (LOCK-TEST-005): a direct unfiltered `vitest run` is
    // bounded to at most 2 thread workers / 1 fork worker per project, so the
    // old 7-thread + 7-fork worker peak cannot recur. Lane projects keep these
    // caps; no project raises them.
    pool: 'threads',
    poolOptions: {
      threads: {
        maxThreads: 2
      },
      forks: {
        maxForks: 1
      }
    }
  }
})
