import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * Focused workflow-freeze guards (LOCK-RELEASE-FREEZE).
 *
 * These tests lock the repository state after the formal release/nightly/v2-
 * preview application packaging workflows were retired (LOCK-RETIRE-001/002):
 *
 * - no `.github/workflows` file may package or publish application
 *   release/nightly/preview assets (multi-platform app builds, GitHub/GitCode
 *   release publishing, `cherry-studio-*` artifact/feed naming);
 * - `ci.yml` (ordinary CI) and the non-packaging release-support workflows
 *   that were mechanically frozen must remain in the shape they were frozen
 *   in, so re-enabling them is an explicit hub decision.
 *
 * These are static repository-level guards and run in the `scripts` vitest
 * project (node environment, no native/network dependencies).
 */

const WORKFLOWS_DIR = join(process.cwd(), '.github', 'workflows')
const EXISTING_WORKFLOW_FILES = [
  'auto-i18n.yml',
  'ci-rerun-on-base-change.yml',
  'ci.yml',
  'claude-code-review.yml',
  'claude-translator.yml',
  'claude.yml',
  'dispatch-docs-update.yml',
  'github-issue-tracker.yml',
  'issue-management.yml',
  'pr-description-check.yml',
  'prepare-release.yml',
  'release-packages.yml',
  'snapshot.yml',
  'update-app-upgrade-config.yml'
]

// Retired formal application release/nightly/v2-preview packaging workflows.
// Their absence is part of LOCK-RELEASE-FREEZE (no workflow may package or
// publish application release/nightly/preview assets).
const RETIRED_PACKAGING_WORKFLOWS = [
  'release.yml',
  'nightly-build.yml',
  'v2-daily-preview-build.yml',
  'sync-to-gitcode.yml'
]

// Markers that would indicate a remaining (or re-introduced) workflow that
// packages or publishes application release/nightly/preview assets or carries
// a retired Studio target identity.
const FORBIDDEN_APP_PACKAGING_MARKERS = [
  // Multi-platform application packaging (LOCK-PLATFORM-005: macOS arm64 is
  // the only approved formal target).
  'electron-builder --win',
  'electron-builder --linux',
  'pnpm build:win',
  'pnpm build:linux',
  'pnpm build:mac',
  // GitHub / GitCode release publishing of app assets.
  'ncipollo/release-action',
  'gh release create',
  // electron-builder publish flag: would trigger app asset upload to a
  // configured/git-inferred endpoint (LOCK-UPDATER-004 / REPO-MIGRATION-002).
  '--publish',
  // Retired nightly / v2-preview artifact and feed naming.
  'cherry-studio-nightly',
  'cherry-studio-v2-preview',
  // Retired Studio target identity.
  'com.cherryai.cherrystudio',
  'com.kangfenmao.CherryStudio',
  'Cherry Studio Next'
]

function listWorkflowFiles(): string[] {
  return readdirSync(WORKFLOWS_DIR).filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
}

function readWorkflow(name: string): string {
  return readFileSync(join(WORKFLOWS_DIR, name), 'utf8')
}

describe('LOCK-RELEASE-FREEZE — no application packaging/publishing workflow remains', () => {
  const workflowFiles = listWorkflowFiles()

  it('keeps ci.yml and the ordinary non-packaging automation set exactly', () => {
    expect(workflowFiles.sort()).toEqual([...EXISTING_WORKFLOW_FILES].sort())
  })

  it('contains none of the retired release/nightly/v2-preview packaging workflows', () => {
    for (const retired of RETIRED_PACKAGING_WORKFLOWS) {
      expect(workflowFiles, `${retired} must be retired (LOCK-RELEASE-FREEZE)`).not.toContain(retired)
    }
  })

  it('has no remaining workflow that packages or publishes app release/nightly/preview assets', () => {
    for (const file of workflowFiles) {
      const content = readWorkflow(file)
      for (const marker of FORBIDDEN_APP_PACKAGING_MARKERS) {
        expect(content, `${file} must not contain "${marker}" (LOCK-RELEASE-FREEZE)`).not.toContain(marker)
      }
    }
  })

  it('keeps ordinary CI (ci.yml) intact and test-only', () => {
    const ci = readWorkflow('ci.yml')
    expect(ci).toContain('name: CI')
    expect(ci).toContain('pnpm test:main')
    expect(ci).toContain('pnpm test:renderer')
  })
})

describe('LOCK-RELEASE-FREEZE — mechanically frozen release-support workflows', () => {
  it('prepare-release.yml is frozen (if: false) with the freeze marker', () => {
    const content = readWorkflow('prepare-release.yml')
    expect(content).toContain('LOCK-RELEASE-FREEZE')
    expect(content).toMatch(/if: false/)
  })

  it('update-app-upgrade-config.yml is frozen (if: false) with the freeze marker', () => {
    const content = readWorkflow('update-app-upgrade-config.yml')
    expect(content).toContain('LOCK-RELEASE-FREEZE')
    expect(content).toMatch(/if: false/)
  })

  it('the release-feed script exists but only the frozen workflow may reference it', () => {
    // scripts/update-app-upgrade-config.ts remains as a local developer tool.
    // Only the mechanically frozen update-app-upgrade-config.yml may reference
    // it — no ACTIVE workflow may invoke the release-feed script
    // (LOCK-RELEASE-FREEZE).
    const scriptsDir = join(process.cwd(), 'scripts')
    expect(readdirSync(scriptsDir)).toContain('update-app-upgrade-config.ts')
    for (const file of listWorkflowFiles()) {
      const content = readWorkflow(file)
      if (file === 'update-app-upgrade-config.yml') {
        // Frozen workflow: reference allowed, execution impossible (if: false).
        expect(content).toContain('update-app-upgrade-config.ts')
        expect(content).toMatch(/if: false/)
      } else {
        expect(content).not.toContain('update-app-upgrade-config.ts')
      }
    }
  })
})
