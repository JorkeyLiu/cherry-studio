import * as fs from 'fs'
import * as path from 'path'
import { expect, test } from '../../fixtures/electron.fixture'
import { waitForAppReady } from '../../utils/wait-helpers'

/**
 * Restricted media open contract (reject-only, never launches a system app).
 *
 * Covers the stable cross-IPC surface renderer/preload
 * `window.api.file.openMediaAttachment`:
 * - unregistered external media (.mp3) must reject (never reaches shell.openPath)
 * - non-media external path (.txt) must reject
 * - stored traversal (`../...`) must reject
 *
 * Optionally proves the registration API (`window.api.file.get`) exists by
 * registering a separate temp media file — the allow branch of
 * `openMediaAttachment` is deliberately NEVER invoked so no OS default app is
 * launched. All temp files live under the fixture-owned `ownedTmpRoot` and are
 * removed by fixture teardown; no codec playback is attempted.
 */
test.describe('Media attachment restricted open (reject-only)', () => {
  test.beforeEach(async ({ mainWindow }) => {
    await waitForAppReady(mainWindow)
  })

  test('rejects unregistered/non-media/traversal opens without launching an app', async ({
    mainWindow,
    ownedTmpRoot
  }) => {
    const dir = path.join(ownedTmpRoot, 'media-open-e2e')
    fs.mkdirSync(dir, { recursive: true })
    const unregisteredMedia = path.join(dir, 'unregistered.mp3')
    const nonMedia = path.join(dir, 'note.txt')
    // Separate file used ONLY for the get() registration-existence probe below.
    // It is never passed to openMediaAttachment, so the shell.openPath allow
    // branch is never exercised in this spec.
    const registerOnlyMedia = path.join(dir, 'register-only.mp3')
    // Fake payload bytes only: Main checks extension + regular file + allow-set,
    // never decodes audio, so no real codec data is needed.
    fs.writeFileSync(unregisteredMedia, 'ID3-fake-e2e-probe')
    fs.writeFileSync(nonMedia, 'e2e non-media probe')
    fs.writeFileSync(registerOnlyMedia, 'ID3-fake-e2e-register-only')

    await test.step('preload exposes the narrow open API', async () => {
      const surface = await mainWindow.evaluate(() => {
        const api = (window as any).api
        return {
          openMediaAttachment: typeof api?.file?.openMediaAttachment,
          get: typeof api?.file?.get
        }
      })
      expect(surface.openMediaAttachment).toBe('function')
      expect(surface.get).toBe('function')
    })

    await test.step('unregistered external media rejects', async () => {
      const result = await mainWindow.evaluate(async (filePath: string) => {
        try {
          const api = (window as any).api
          await api.file.openMediaAttachment({ kind: 'external', filePath })
          return { ok: true, error: '' }
        } catch (err: any) {
          return { ok: false, error: String(err?.message ?? err) }
        }
      }, unregisteredMedia)
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/not registered/)
    })

    await test.step('non-media external path rejects', async () => {
      const result = await mainWindow.evaluate(async (filePath: string) => {
        try {
          const api = (window as any).api
          await api.file.openMediaAttachment({ kind: 'external', filePath })
          return { ok: true, error: '' }
        } catch (err: any) {
          return { ok: false, error: String(err?.message ?? err) }
        }
      }, nonMedia)
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/not supported/)
    })

    await test.step('stored traversal rejects', async () => {
      const result = await mainWindow.evaluate(async () => {
        try {
          const api = (window as any).api
          await api.file.openMediaAttachment({ kind: 'stored', storedFileName: '../e2e-probe-secret.mp3' })
          return { ok: true, error: '' }
        } catch (err: any) {
          return { ok: false, error: String(err?.message ?? err) }
        }
      })
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/unavailable|Invalid/i)
    })

    await test.step('registration API exists (allow branch never invoked)', async () => {
      const meta = await mainWindow.evaluate(async (filePath: string) => {
        const api = (window as any).api
        const result = await api.file.get(filePath)
        if (!result || typeof result !== 'object') {
          return null
        }
        return { path: result.path, ext: result.ext }
      }, registerOnlyMedia)
      expect(meta).not.toBeNull()
      expect(meta!.path).toBe(registerOnlyMedia)
      expect(meta!.ext).toBe('.mp3')
      // Intentionally no openMediaAttachment call on registerOnlyMedia here:
      // invoking the allow branch would call shell.openPath and launch the OS
      // default app.
    })
  })
})
