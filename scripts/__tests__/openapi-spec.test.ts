import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { APP_FLAVOR_ENV_VAR } from '../../packages/shared/config/identity'
import { resolveAppIdentity } from '../../packages/shared/config/identity'
import { generate, resolveSpecIdentity } from '../generate-openapi-spec'

/**
 * Focused OpenAPI metadata tests for Phase B (P-B) packaging.
 *
 * The spec generator runs under plain Node/tsx (never through a Vite build),
 * so it must resolve the selected build flavor from
 * `process.env.VITE_APP_FLAVOR` through the pure resolver — otherwise a
 * `cherry-chat` build would package the default "Cherry Studio API" metadata.
 * Locks covered: IDENTITY-001 (default spec byte/format-unchanged) and
 * IDENTITY-002 (Cherry Chat spec carries Cherry Chat metadata only).
 *
 * `swagger-jsdoc` only parses local source files, so generation never invokes
 * the network.
 */

const REPO_ROOT = process.cwd()
const COMMITTED_SPEC_FILE = join(REPO_ROOT, 'src/main/apiServer/generated/openapi-spec.json')

function parseSpec(content: string): Record<string, any> {
  return JSON.parse(content) as Record<string, any>
}

describe('OpenAPI spec generation — default Cherry Studio identity unchanged (IDENTITY-001)', () => {
  it('keeps the default generated metadata (title, description, contact, bearer hint)', () => {
    const spec = parseSpec(generate(resolveAppIdentity('cherry-studio')))

    expect(spec.info.title).toBe('Cherry Studio API')
    expect(spec.info.description).toBe(
      'OpenAI-compatible API for Cherry Studio with additional Cherry-specific endpoints'
    )
    expect(spec.info.contact).toEqual({
      name: 'Cherry Studio',
      url: 'https://github.com/CherryHQ/cherry-studio'
    })
    expect(spec.components.securitySchemes.BearerAuth.description).toBe('Use the API key from Cherry Studio settings')
  })

  it('matches the committed generated spec semantically (default output unchanged)', () => {
    const committed = parseSpec(readFileSync(COMMITTED_SPEC_FILE, 'utf8'))
    const regenerated = parseSpec(generate(resolveAppIdentity('cherry-studio')))

    // Byte-level stability is verified by `pnpm openapi:check` and by the
    // default-flavor regeneration in the Phase B verification; here we prove
    // the full document (info + schemas + routes) is semantically identical.
    expect(regenerated).toEqual(committed)
  })
})

describe('OpenAPI spec generation — Cherry Chat flavor metadata (IDENTITY-002)', () => {
  it('generates Cherry Chat metadata and packages no Cherry Studio product references', () => {
    const spec = parseSpec(generate(resolveAppIdentity('cherry-chat')))
    const serialized = JSON.stringify(spec)

    expect(spec.info.title).toBe('Cherry Chat API')
    expect(spec.info.description).toBe(
      'OpenAI-compatible API for Cherry Chat with additional Cherry-specific endpoints'
    )
    expect(spec.info.contact).toEqual({
      name: 'Cherry Chat',
      url: 'https://github.com/CherryHQ/cherry-studio'
    })
    expect(spec.components.securitySchemes.BearerAuth.description).toBe('Use the API key from Cherry Chat settings')

    // The generated Cherry Chat spec must contain no Cherry Studio product
    // description anywhere (acceptance criterion). The `/` root endpoint
    // example is aligned with the runtime `name` (appIdentity.apiTitle), so
    // only the identity-owned metadata + the root example are flavor-driven;
    // any other leak fails this assertion.
    expect(serialized).not.toContain('Cherry Studio')
  })
})

describe('OpenAPI spec generation — flavor resolved from process.env.VITE_APP_FLAVOR', () => {
  it('resolves cherry-chat when VITE_APP_FLAVOR is set', () => {
    const previous = process.env[APP_FLAVOR_ENV_VAR]
    try {
      process.env[APP_FLAVOR_ENV_VAR] = 'cherry-chat'
      expect(resolveSpecIdentity().flavor).toBe('cherry-chat')
      expect(resolveSpecIdentity().apiTitle).toBe('Cherry Chat API')
    } finally {
      if (previous === undefined) {
        delete process.env[APP_FLAVOR_ENV_VAR]
      } else {
        process.env[APP_FLAVOR_ENV_VAR] = previous
      }
    }
  })

  it('defaults to Cherry Studio when VITE_APP_FLAVOR is unset', () => {
    const previous = process.env[APP_FLAVOR_ENV_VAR]
    try {
      delete process.env[APP_FLAVOR_ENV_VAR]
      expect(resolveSpecIdentity().flavor).toBe('cherry-studio')
      expect(resolveSpecIdentity().apiTitle).toBe('Cherry Studio API')
    } finally {
      if (previous === undefined) {
        delete process.env[APP_FLAVOR_ENV_VAR]
      } else {
        process.env[APP_FLAVOR_ENV_VAR] = previous
      }
    }
  })
})
