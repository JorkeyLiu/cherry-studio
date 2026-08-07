import { appIdentity } from '@shared/config/identity'
import { afterEach, describe, expect, it } from 'vitest'

import { applyMainWindowTitle, resolveMainWindowTitle } from '../title'

/**
 * Main-window title seam (LOCK-RETIRE-001) — jsdom wiring behavior for the
 * single Cherry Chat identity.
 */
describe('applyMainWindowTitle — main-window title seam (LOCK-RETIRE-001)', () => {
  afterEach(() => {
    document.title = ''
  })

  it('resolves the main-window title from appIdentity.productName', () => {
    expect(resolveMainWindowTitle()).toBe(appIdentity.productName)
  })

  it('assigns document.title to the identity product name at startup', () => {
    // The static index.html <title> is shared; the bootstrap seam
    // (src/renderer/src/init.ts) overrides it at startup.
    document.title = 'Static HTML Title'
    applyMainWindowTitle()
    expect(document.title).toBe(appIdentity.productName)
  })

  it('keeps the single identity title exactly `Cherry Chat`', () => {
    applyMainWindowTitle()
    expect(document.title).toBe('Cherry Chat')
    expect(appIdentity.productName).toBe('Cherry Chat')
  })
})
