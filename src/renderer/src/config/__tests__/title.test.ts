import { appIdentity } from '@shared/config/identity'
import { afterEach, describe, expect, it } from 'vitest'

import { applyMainWindowTitle, resolveMainWindowTitle } from '../title'

/**
 * Main-window title seam (IDENTITY-002) — jsdom wiring behavior for the
 * DEFAULT (test-env) flavor. The compiled-flavor baking of the same title
 * module (both `cherry-chat` → `Cherry Chat` and default → `Cherry Studio`)
 * is covered by the compiled-bundle assertions in
 * packages/shared/config/__tests__/buildFlavor.test.ts.
 */
describe('applyMainWindowTitle — main-window title seam (IDENTITY-002)', () => {
  afterEach(() => {
    document.title = ''
  })

  it('resolves the main-window title from appIdentity.productName', () => {
    expect(resolveMainWindowTitle()).toBe(appIdentity.productName)
  })

  it('assigns document.title to the identity product name at startup', () => {
    // The static index.html <title> is shared by every flavor; the bootstrap
    // seam (src/renderer/src/init.ts) overrides it at startup.
    document.title = 'Static HTML Title'
    applyMainWindowTitle()
    expect(document.title).toBe(appIdentity.productName)
  })

  it('keeps the default build title `Cherry Studio` unchanged (IDENTITY-001)', () => {
    applyMainWindowTitle()
    expect(document.title).toBe('Cherry Studio')
    expect(appIdentity.productName).toBe('Cherry Studio')
  })
})
