import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  BUILD_STEPS,
  buildStepEnv,
  CHERRY_CHAT_FLAVOR,
  CHERRY_CHAT_FLAVOR_ENV,
  OPENAPI_SPEC_RELATIVE_PATH,
  resolveBin,
  runChatMacArm64Build,
  type RunStep
} from '../build-chat-mac-arm64'

/**
 * Focused wrapper tests for the Cherry Chat macOS arm64 build (finding F1).
 *
 * The flavor build regenerates the TRACKED
 * `src/main/apiServer/generated/openapi-spec.json` with Cherry Chat metadata
 * before electron-vite and electron-builder consume it. These tests prove the
 * wrapper always restores the exact original bytes afterwards — on success and
 * on simulated failure — and that both phases receive the locked flavor env in
 * order, without invoking a real build (temp files + fake runner).
 *
 * Locks covered: IDENTITY-001 (tracked default spec byte-restored), IDENTITY-002
 * (cherry-chat flavor reaches both phases), IDENTITY-005 (macOS arm64 only).
 */

const ORIGINAL_SPEC = '{"info":{"title":"Cherry Studio API"}}'
const GENERATED_CHERRY_CHAT_SPEC = '{"info":{"title":"Cherry Chat API"}}'

interface RecordedStep {
  command: string
  args: string[]
  env: Record<string, string | undefined>
  cwd: string
}

function setupFixture(): { tmp: string; specPath: string; cleanup(): void } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-build-test-'))
  fs.mkdirSync(path.join(tmp, path.dirname(OPENAPI_SPEC_RELATIVE_PATH)), { recursive: true })
  const specPath = path.join(tmp, OPENAPI_SPEC_RELATIVE_PATH)
  fs.writeFileSync(specPath, ORIGINAL_SPEC, 'utf8')
  return {
    tmp,
    specPath,
    cleanup(): void {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }
}

describe('build-chat-mac-arm64 wrapper (finding F1)', () => {
  it('defines the flavor build phase before the packaging phase', () => {
    expect(BUILD_STEPS).toEqual([
      { command: 'dotenv', args: ['npm', 'run', 'build'] },
      { command: 'electron-builder', args: ['--config', 'electron-builder.cherry-chat.yml', '--mac', '--arm64'] }
    ])
    expect(CHERRY_CHAT_FLAVOR_ENV).toEqual({ VITE_APP_FLAVOR: CHERRY_CHAT_FLAVOR })
  })

  it('buildStepEnv merges the inherited environment with the locked flavor key', () => {
    expect(buildStepEnv({ PATH: '/mock/bin' })).toEqual({ PATH: '/mock/bin', VITE_APP_FLAVOR: 'cherry-chat' })
  })

  it('resolveBin prefers the repo-local node_modules/.bin over PATH', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-build-bin-'))
    try {
      fs.mkdirSync(path.join(tmp, 'node_modules', '.bin'), { recursive: true })
      const local = path.join(tmp, 'node_modules', '.bin', 'fake-tool')
      fs.writeFileSync(local, '#!/bin/sh\n', 'utf8')
      expect(resolveBin('fake-tool', tmp)).toBe(local)
      expect(resolveBin('not-installed-anywhere', tmp)).toBe('not-installed-anywhere')
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('runs build then packaging sequentially with the cherry-chat flavor and restores the tracked spec bytes', async () => {
    const { tmp, specPath, cleanup } = setupFixture()
    try {
      const recorded: RecordedStep[] = []
      const runStep: RunStep = async (ctx) => {
        recorded.push({ command: ctx.command, args: [...ctx.args], env: { ...ctx.env }, cwd: ctx.cwd })
        if (ctx.command === 'dotenv') {
          // Simulate generate:openapi rewriting the tracked spec with Cherry Chat metadata.
          fs.writeFileSync(specPath, GENERATED_CHERRY_CHAT_SPEC, 'utf8')
        }
      }

      await runChatMacArm64Build({
        repoRoot: tmp,
        steps: BUILD_STEPS,
        runStep,
        baseEnv: { PATH: '/mock/bin', CUSTOM_MARKER: 'inherited-value' }
      })

      // Phase order: flavor build first, packaging second.
      expect(recorded.map((step) => step.command)).toEqual(['dotenv', 'electron-builder'])
      // Every step inherits the base env AND carries the locked flavor (IDENTITY-002).
      for (const step of recorded) {
        expect(step.env.VITE_APP_FLAVOR).toBe('cherry-chat')
        expect(step.env.CUSTOM_MARKER).toBe('inherited-value')
        expect(step.cwd).toBe(tmp)
      }
      // The packaging command targets the overlay and macOS arm64 only (IDENTITY-005).
      expect(recorded[1].args).toEqual(['--config', 'electron-builder.cherry-chat.yml', '--mac', '--arm64'])
      // The packaged output was generated (spec mutated mid-build) but the
      // tracked file is restored byte-for-byte after packaging consumed it.
      expect(fs.readFileSync(specPath, 'utf8')).toBe(ORIGINAL_SPEC)
    } finally {
      cleanup()
    }
  })

  it('restores the exact tracked bytes when the packaging phase fails', async () => {
    const { tmp, specPath, cleanup } = setupFixture()
    try {
      const commands: string[] = []
      const runStep: RunStep = async (ctx) => {
        commands.push(ctx.command)
        if (ctx.command === 'dotenv') {
          fs.writeFileSync(specPath, GENERATED_CHERRY_CHAT_SPEC, 'utf8')
        }
        if (ctx.command === 'electron-builder') {
          const err = new Error('electron-builder exited with code 3') as Error & { code?: number }
          err.code = 3
          throw err
        }
      }

      await expect(
        runChatMacArm64Build({ repoRoot: tmp, runStep, baseEnv: { PATH: '/mock/bin' } })
      ).rejects.toMatchObject({ code: 3, message: 'electron-builder exited with code 3' })

      expect(commands).toEqual(['dotenv', 'electron-builder'])
      // Failure-safe cleanup: the tracked default spec is restored after a failed chain.
      expect(fs.readFileSync(specPath, 'utf8')).toBe(ORIGINAL_SPEC)
    } finally {
      cleanup()
    }
  })

  it('removes the spec again when it did not exist before the build (failure-safe restore)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-build-test-'))
    try {
      const specPath = path.join(tmp, OPENAPI_SPEC_RELATIVE_PATH)
      const runStep: RunStep = async () => {
        fs.mkdirSync(path.dirname(specPath), { recursive: true })
        fs.writeFileSync(specPath, GENERATED_CHERRY_CHAT_SPEC, 'utf8')
      }

      await runChatMacArm64Build({ repoRoot: tmp, runStep, baseEnv: { PATH: '/mock/bin' } })

      expect(fs.existsSync(specPath)).toBe(false)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('propagates a real child exit code and restores the spec (structured spawn, no shell)', async () => {
    const { tmp, specPath, cleanup } = setupFixture()
    try {
      // Real (tiny, non-build) subprocess through the default structured spawn:
      // proves exit-code preservation AND the finally-restore on a real child.
      await expect(
        runChatMacArm64Build({
          repoRoot: tmp,
          steps: [{ command: process.execPath, args: ['-e', 'process.exit(7)'] }],
          baseEnv: { PATH: '/mock/bin' }
        })
      ).rejects.toMatchObject({ code: 7 })
      expect(fs.readFileSync(specPath, 'utf8')).toBe(ORIGINAL_SPEC)
    } finally {
      cleanup()
    }
  })

  it('propagates a child signal termination and restores the spec', async () => {
    const { tmp, specPath, cleanup } = setupFixture()
    try {
      await expect(
        runChatMacArm64Build({
          repoRoot: tmp,
          steps: [{ command: process.execPath, args: ['-e', 'process.kill(process.pid, "SIGTERM")'] }],
          baseEnv: { PATH: '/mock/bin' }
        })
      ).rejects.toMatchObject({ signal: 'SIGTERM' })
      expect(fs.readFileSync(specPath, 'utf8')).toBe(ORIGINAL_SPEC)
    } finally {
      cleanup()
    }
  })
})
