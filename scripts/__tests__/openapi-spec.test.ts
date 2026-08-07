import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { appIdentity } from '../../packages/shared/config/identity'
import { generate, resolveSpecIdentity } from '../generate-openapi-spec'

/**
 * Focused OpenAPI metadata tests for the single Cherry Chat identity
 * (LOCK-RETIRE-001/002). The generated spec always carries Cherry Chat
 * metadata only — no Cherry Studio product references anywhere.
 *
 * `swagger-jsdoc` only parses local source files, so generation never invokes
 * the network.
 */

const REPO_ROOT = process.cwd()
const COMMITTED_SPEC_FILE = join(REPO_ROOT, 'src/main/apiServer/generated/openapi-spec.json')

function parseSpec(content: string): Record<string, any> {
  return JSON.parse(content) as Record<string, any>
}

describe('OpenAPI spec generation — single Cherry Chat identity (LOCK-RETIRE-001)', () => {
  it('keeps the locked Cherry Chat generated metadata (title, description, contact, bearer hint)', () => {
    const spec = parseSpec(generate(appIdentity))

    expect(spec.info.title).toBe('Cherry Chat API')
    expect(spec.info.description).toBe(
      'OpenAI-compatible API for Cherry Chat with additional Cherry-specific endpoints'
    )
    expect(spec.info.contact).toEqual({
      name: 'Cherry Chat',
      url: 'https://github.com/CherryHQ/cherry-studio'
    })
    expect(spec.components.securitySchemes.BearerAuth.description).toBe('Use the API key from Cherry Chat settings')
  })

  it('matches the committed generated spec semantically', () => {
    const committed = parseSpec(readFileSync(COMMITTED_SPEC_FILE, 'utf8'))
    const regenerated = parseSpec(generate(appIdentity))

    // Byte-level stability is verified by `pnpm openapi:check`; here we prove
    // the full document (info + schemas + routes) is semantically identical.
    expect(regenerated).toEqual(committed)
  })

  it('packages no Cherry Studio product references anywhere', () => {
    const spec = parseSpec(generate(appIdentity))
    const serialized = JSON.stringify(spec)
    // The `/` root endpoint example is aligned with the runtime `name`
    // (appIdentity.apiTitle); any other leak fails this assertion.
    expect(serialized).not.toContain('Cherry Studio')
  })
})

describe('OpenAPI spec generation — identity resolution (LOCK-RETIRE-002)', () => {
  it('always resolves the single Cherry Chat identity (no flavor selection)', () => {
    expect(resolveSpecIdentity()).toBe(appIdentity)
    expect(resolveSpecIdentity().apiTitle).toBe('Cherry Chat API')
  })
})
