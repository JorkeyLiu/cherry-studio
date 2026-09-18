import { describe, expect, it } from 'vitest'

import {
  buildProviderLogoUrl,
  isSafeLogoSourceId,
  isSafeProviderSvg,
  parseProviderLogoCache,
  PROVIDER_LOGO_BASE_URL,
  toProviderLogoDataUrl
} from '../providerLogo'

const SAFE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2v20"/></svg>'

describe('isSafeLogoSourceId — exact source alphabet only', () => {
  it('accepts lowercase kebab sources', () => {
    expect(isSafeLogoSourceId('anthropic')).toBe(true)
    expect(isSafeLogoSourceId('openai')).toBe(true)
    expect(isSafeLogoSourceId('google-vertex')).toBe(true)
    expect(isSafeLogoSourceId('a')).toBe(true)
  })

  it('rejects arbitrary provider ids, traversal, and prototype keys', () => {
    expect(isSafeLogoSourceId('')).toBe(false)
    expect(isSafeLogoSourceId('OpenAI')).toBe(false)
    expect(isSafeLogoSourceId('my connection')).toBe(false)
    expect(isSafeLogoSourceId('../etc')).toBe(false)
    expect(isSafeLogoSourceId('a/b')).toBe(false)
    expect(isSafeLogoSourceId('a.svg')).toBe(false)
    expect(isSafeLogoSourceId('__proto__')).toBe(false)
    expect(isSafeLogoSourceId('constructor')).toBe(false)
    expect(isSafeLogoSourceId('prototype')).toBe(false)
    expect(isSafeLogoSourceId('-lead')).toBe(false)
    expect(isSafeLogoSourceId('trail-')).toBe(false)
    expect(isSafeLogoSourceId('x'.repeat(65))).toBe(false)
    expect(isSafeLogoSourceId(null)).toBe(false)
    expect(isSafeLogoSourceId(undefined)).toBe(false)
    expect(isSafeLogoSourceId(42)).toBe(false)
  })
})

describe('buildProviderLogoUrl — official endpoint only', () => {
  it('builds the official logo URL for safe sources', () => {
    expect(buildProviderLogoUrl('anthropic')).toBe(`${PROVIDER_LOGO_BASE_URL}/anthropic.svg`)
    expect(PROVIDER_LOGO_BASE_URL).toBe('https://models.dev/logos')
  })

  it('never turns arbitrary local ids into a logo URL key', () => {
    // Format-unsafe local values can never become a URL key. Format-safe
    // values (e.g. `conn-1`) are still never requested without exact source
    // attribution plus the Main known-source gate — covered by service tests.
    expect(buildProviderLogoUrl('My Connection')).toBeNull()
    expect(buildProviderLogoUrl('../anthropic')).toBeNull()
    expect(buildProviderLogoUrl('__proto__')).toBeNull()
    expect(buildProviderLogoUrl('')).toBeNull()
    expect(buildProviderLogoUrl('CONN-1')).toBeNull()
  })
})

describe('isSafeProviderSvg', () => {
  it('accepts a minimal inline-path logo', () => {
    expect(isSafeProviderSvg(SAFE_SVG)).toBe(true)
  })

  it('requires SVG content', () => {
    expect(isSafeProviderSvg('')).toBe(false)
    expect(isSafeProviderSvg('not svg')).toBe(false)
    expect(isSafeProviderSvg('<div>hi</div>')).toBe(false)
    expect(isSafeProviderSvg('<svg><path d="x"/></svg>')).toBe(true)
    expect(isSafeProviderSvg(null)).toBe(false)
  })

  it('rejects scripts, event handlers, and embedded frames/objects', () => {
    expect(isSafeProviderSvg('<svg><script>alert(1)</script></svg>')).toBe(false)
    expect(isSafeProviderSvg('<svg><path onload="alert(1)" d="M0 0h24"/></svg>')).toBe(false)
    expect(isSafeProviderSvg('<svg><path ONCLICK="x" d="M0"/></svg>')).toBe(false)
    expect(isSafeProviderSvg('<svg><iframe src="https://evil.example"/></svg>')).toBe(false)
    expect(isSafeProviderSvg('<svg><object data="x"/></svg>')).toBe(false)
    expect(isSafeProviderSvg('<svg><embed src="x"/></svg>')).toBe(false)
    expect(isSafeProviderSvg('<svg><foreignObject><div>hi</div></foreignObject></svg>')).toBe(false)
    expect(isSafeProviderSvg('<svg><image href="https://evil.example/x.png"/></svg>')).toBe(false)
  })

  it('rejects unsafe URLs and external resource references', () => {
    expect(isSafeProviderSvg('<svg><a href="javascript:alert(1)">x</a></svg>')).toBe(false)
    expect(isSafeProviderSvg('<svg><a href="https://evil.example/x">x</a></svg>')).toBe(false)
    expect(isSafeProviderSvg('<svg><style>@import "https://evil.example/x.css"</style></svg>')).toBe(false)
    expect(isSafeProviderSvg('<svg><rect style="fill:url(https://evil.example/x)"/></svg>')).toBe(false)
    expect(isSafeProviderSvg('<!ENTITY xxe SYSTEM "file:///etc/passwd"><svg><path d="M0"/></svg>')).toBe(false)
  })

  it('allows the required xmlns namespace and fragment urls', () => {
    expect(
      isSafeProviderSvg(
        '<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"><stop offset="0"/></linearGradient></defs><rect fill="url(#g)"/></svg>'
      )
    ).toBe(true)
  })
})

describe('toProviderLogoDataUrl', () => {
  it('encodes svg as a data url', () => {
    const url = toProviderLogoDataUrl(SAFE_SVG)
    expect(url.startsWith('data:image/svg+xml;utf8,')).toBe(true)
    expect(decodeURIComponent(url.slice('data:image/svg+xml;utf8,'.length))).toBe(SAFE_SVG)
  })
})

describe('parseProviderLogoCache', () => {
  it('round-trips a versioned envelope and drops unsafe entries', () => {
    const envelope = {
      version: 1,
      fetchedAt: 999,
      logos: {
        anthropic: { svg: SAFE_SVG, fetchedAt: 999, etag: '"v1"' },
        __proto__: { svg: SAFE_SVG, fetchedAt: 999 },
        evil: { svg: '<svg><script>x</script></svg>', fetchedAt: 999 }
      }
    }
    const parsed = parseProviderLogoCache(envelope)!
    expect(Object.keys(parsed.logos)).toEqual(['anthropic'])
    expect(parsed.logos['anthropic'].etag).toBe('"v1"')
    expect(Object.prototype.hasOwnProperty.call(parsed.logos, '__proto__')).toBe(false)
  })

  it('rejects wrong versions and malformed envelopes', () => {
    expect(parseProviderLogoCache(null)).toBeNull()
    expect(parseProviderLogoCache({ version: 2, fetchedAt: 1, logos: {} })).toBeNull()
    expect(parseProviderLogoCache({ version: 1, fetchedAt: 1 })).toBeNull()
  })
})
