import * as fs from 'node:fs'

import { describe, expect, it } from 'vitest'

import type { MessageMenubarButtonId } from '../messageMenubar'
import { getMessageMenubarConfig } from '../messageMenubar'
import { DEFAULT_MESSAGE_MENUBAR_SCOPE } from '../messageMenubar'

describe('true-branch toolbar registry', () => {
  it('places the true-branch button at the head of the Branch → Insert → Edit → Delete group', () => {
    const ids = getMessageMenubarConfig(DEFAULT_MESSAGE_MENUBAR_SCOPE).buttonIds
    const branchIdx = ids.indexOf('true-branch')
    const deleteIdx = ids.indexOf('delete')
    expect(branchIdx).toBeGreaterThanOrEqual(0)
    // Insert + Edit sit between Branch and Delete (exact order pinned below).
    expect(deleteIdx).toBe(branchIdx + 3)
    expect(ids.slice(branchIdx, deleteIdx + 1)).toEqual(['true-branch', 'assistant-insert', 'assistant-edit', 'delete'])
  })

  it('exact visible order: Branch → Insert Message → Edit → Delete', () => {
    const ids = getMessageMenubarConfig(DEFAULT_MESSAGE_MENUBAR_SCOPE).buttonIds
    const order: MessageMenubarButtonId[] = ['true-branch', 'assistant-insert', 'assistant-edit', 'delete']
    const positions = order.map((id) => ids.indexOf(id))
    for (const pos of positions) {
      expect(pos).toBeGreaterThanOrEqual(0)
    }
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    expect(positions[1]).toBe(positions[0] + 1)
    expect(positions[2]).toBe(positions[1] + 1)
    expect(positions[3]).toBe(positions[2] + 1)
  })

  it('Translate and Save to Notes are overflow-only (not visible by default)', () => {
    const ids = getMessageMenubarConfig(DEFAULT_MESSAGE_MENUBAR_SCOPE).buttonIds
    expect(ids).not.toContain('translate')
    expect(ids).not.toContain('notes')
    const source = fs.readFileSync('src/renderer/src/pages/home/Messages/MessageMenubar.tsx', 'utf8')
    // Render code stays reusable for scopes that still list them.
    expect(source).toMatch(/translate:/)
    expect(source).toMatch(/notes:/)
    // Overflow membership: translate + save-to-notes live in the More menu.
    const dropdownStart = source.indexOf('const dropdownItems')
    expect(dropdownStart).toBeGreaterThanOrEqual(0)
    const dropdown = source.slice(dropdownStart, dropdownStart + 4000)
    expect(dropdown).toMatch(/key: 'translate'/)
    expect(dropdown).toMatch(/key: 'save-to-notes'/)
    expect(dropdown).toMatch(/message-translate-menu-btn/)
    expect(dropdown).toMatch(/message-save-notes-menu-btn/)
  })

  it('Edit and Insert Message are visible toolbar buttons (not More menu items)', () => {
    const source = fs.readFileSync('src/renderer/src/pages/home/Messages/MessageMenubar.tsx', 'utf8')
    const dropdownStart = source.indexOf('const dropdownItems')
    const dropdown = source.slice(dropdownStart, dropdownStart + 4000)
    expect(dropdown).not.toMatch(/key: 'edit'/)
    expect(dropdown).not.toMatch(/key: 'insert-message'/)
    expect(source).toMatch(/'assistant-insert':/)
    expect(source).toMatch(/'assistant-edit':/)
    expect(source).toMatch(/msg-insert-btn/)
    expect(source).toMatch(/msg-assistant-edit-btn/)
  })

  it('renders the true-branch button only for assistant messages (source check)', () => {
    const source = fs.readFileSync('src/renderer/src/pages/home/Messages/MessageMenubar.tsx', 'utf8')
    const start = source.indexOf(`'true-branch':`)
    expect(start).toBeGreaterThanOrEqual(0)
    const renderer = source.slice(start, start + 1400)
    expect(renderer).toMatch(/isAssistantMessage/)
    expect(renderer).toMatch(/msg-true-branch-btn/)
    expect(renderer).toMatch(/Split/)
    expect(renderer).toMatch(/onTrueBranch/)
  })

  it('keeps the legacy overflow item as Copy Topic wired to NEW_BRANCH (unchanged data behavior)', () => {
    const source = fs.readFileSync('src/renderer/src/pages/home/Messages/MessageMenubar.tsx', 'utf8')
    expect(source).toMatch(/message-copy-topic-btn/)
    expect(source).toMatch(/chat\.message\.copy_topic\.label/)
    expect(source).toMatch(/emitNewBranch/)
    // The overflow never emits the true-branch event.
    const dropdownStart = source.indexOf('const dropdownItems')
    const dropdown = source.slice(dropdownStart, dropdownStart + 4000)
    expect(dropdown).not.toMatch(/emitTrueBranch/)
  })

  it('emits NEW_TRUE_BRANCH only from the toolbar path (unique creation method)', () => {
    const branchSource = fs.readFileSync('src/renderer/src/pages/home/Messages/messageBranch.ts', 'utf8')
    expect(branchSource).toMatch(/emitTrueBranch/)
    expect(branchSource).toMatch(/NEW_TRUE_BRANCH/)
    const menubar = fs.readFileSync('src/renderer/src/pages/home/Messages/MessageMenubar.tsx', 'utf8')
    const trueBranchUses = (menubar.match(/emitTrueBranch/g) ?? []).length
    // Definition import + single toolbar callback.
    expect(trueBranchUses).toBe(2)
  })
})
