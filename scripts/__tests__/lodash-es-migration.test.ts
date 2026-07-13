import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'

const ROOT = join(__dirname, '..', '..')

/**
 * Recursively collect all .ts/.tsx/.js/.jsx files under a directory,
 * skipping node_modules, dist, out, and build directories.
 */
function collectSourceFiles(dir: string): string[] {
  const results: string[] = []
  const skipDirs = new Set(['node_modules', 'dist', 'out', 'build', '.git', 'coverage'])

  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry)
    const stat = statSync(fullPath)
    if (stat.isDirectory()) {
      if (!skipDirs.has(entry)) {
        results.push(...collectSourceFiles(fullPath))
      }
    } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry)) {
      results.push(fullPath)
    }
  }
  return results
}

describe('lodash → lodash-es migration', () => {
  test('package.json has lodash-es as a devDependency (not lodash)', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'))
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }

    expect(allDeps['lodash-es']).toBeDefined()
    expect(allDeps['lodash']).toBeUndefined()
  })

  test('package.json has @types/lodash-es (not @types/lodash)', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'))
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }

    expect(allDeps['@types/lodash-es']).toBeDefined()
    expect(allDeps['@types/lodash']).toBeUndefined()
  })

  test('no source file imports from "lodash" (all should be "lodash-es")', () => {
    const files = collectSourceFiles(ROOT)
    const violations: { file: string; line: string }[] = []

    // Only match actual import/require statements, not string literals or comments
    const importRegex = /^\s*import\s+.*\s+from\s+['"]lodash['"]/
    const requireRegex = /require\s*\(\s*['"]lodash['"]\s*\)/

    for (const file of files) {
      // Skip this test file to avoid matching its own string content
      if (file.includes('lodash-es-migration.test.ts')) continue

      const content = readFileSync(file, 'utf-8')
      const lines = content.split('\n')
      for (const line of lines) {
        if (importRegex.test(line)) {
          violations.push({
            file: relative(ROOT, file),
            line: line.trim()
          })
        }
        if (requireRegex.test(line)) {
          violations.push({
            file: relative(ROOT, file),
            line: line.trim()
          })
        }
      }
    }

    expect(
      violations,
      `Found files still importing from 'lodash' instead of 'lodash-es':\n${violations.map((v) => `  ${v.file}: ${v.line}`).join('\n')}`
    ).toHaveLength(0)
  })
})
