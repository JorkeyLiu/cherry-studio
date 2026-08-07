import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'

import { describe, expect, it } from 'vitest'

import { APP_FLAVOR_DEFINE_KEY, flavorDefine, readBuildFlavorFromEnv, resolveBuildFlavor } from '../buildFlavor'
import { APP_FLAVOR_ENV_VAR, type AppIdentity, resolveAppIdentity } from '../identity'

/**
 * Build-define generation + compile-time baking tests (Phase B runtime-flavor
 * blocker). IDENTITY-001: the default build must resolve Cherry Studio;
 * IDENTITY-002: a `cherry-chat` build must bake the Cherry Chat identity.
 *
 * The baking tests compile the real `identity.ts` through esbuild's `define`
 * mechanism — the same identifier replacement Vite/electron-vite apply — and
 * then EVALUATE the compiled module, so they are behavioral evidence, not
 * text-only assertions. esbuild is not hoisted to the repo root under pnpm;
 * resolve the exact toolchain version through the installed `electron-vite`
 * peer (same pattern as scripts/__tests__/electron-builder-cherry-chat.test.ts).
 */
const requireFromElectronVite = createRequire(require.resolve('electron-vite/package.json'))

interface TransformOptions {
  loader: string
  format: string
  define?: Record<string, string>
}
interface TransformResult {
  code: string
}
const transform = requireFromElectronVite('esbuild').transform as (
  source: string,
  options: TransformOptions
) => Promise<TransformResult>

const identitySource = readFileSync(new URL('../identity.ts', import.meta.url), 'utf8')

interface CompiledIdentityModule {
  appFlavor: string
  appIdentity: AppIdentity
}

/**
 * Compile `identity.ts` the way a Vite build does: esbuild transform with an
 * optional `define` for `__APP_FLAVOR__`. With a define the constant is
 * textually replaced (baked); without one the module must fall back safely.
 */
async function compileIdentityModule(defineFlavor: string | undefined): Promise<CompiledIdentityModule> {
  const options: TransformOptions = { loader: 'ts', format: 'cjs' }
  if (defineFlavor !== undefined) {
    options.define = { [APP_FLAVOR_DEFINE_KEY]: JSON.stringify(defineFlavor) }
  }
  const { code } = await transform(identitySource, options)

  const module = { exports: {} as CompiledIdentityModule }
  vm.runInNewContext(code, { module, exports: module.exports })
  return module.exports
}

describe('resolveBuildFlavor (build-config normalization)', () => {
  it('normalizes missing/empty/unknown raw values to the default flavor (IDENTITY-001)', () => {
    expect(resolveBuildFlavor(undefined)).toBe('cherry-studio')
    expect(resolveBuildFlavor(null)).toBe('cherry-studio')
    expect(resolveBuildFlavor('')).toBe('cherry-studio')
    expect(resolveBuildFlavor('   ')).toBe('cherry-studio')
    expect(resolveBuildFlavor('bogus-flavor')).toBe('cherry-studio')
  })

  it('accepts only the explicit cherry-chat token (case/space insensitive)', () => {
    expect(resolveBuildFlavor('cherry-chat')).toBe('cherry-chat')
    expect(resolveBuildFlavor(' Cherry-Chat ')).toBe('cherry-chat')
    expect(resolveBuildFlavor('cherry-studio')).toBe('cherry-studio')
  })

  it('rejects near-miss flavor tokens instead of guessing (no runtime flavor switching)', () => {
    expect(resolveBuildFlavor('cherry_chat')).toBe('cherry-studio')
    expect(resolveBuildFlavor('cherrychat')).toBe('cherry-studio')
  })
})

describe('readBuildFlavorFromEnv', () => {
  it('reads VITE_APP_FLAVOR from an injected env record (deterministic tests)', () => {
    expect(readBuildFlavorFromEnv({ VITE_APP_FLAVOR: 'cherry-chat' })).toBe('cherry-chat')
    expect(readBuildFlavorFromEnv({ VITE_APP_FLAVOR: 'cherry-studio' })).toBe('cherry-studio')
    expect(readBuildFlavorFromEnv({ VITE_APP_FLAVOR: 'nope' })).toBe('cherry-studio')
    expect(readBuildFlavorFromEnv({})).toBe('cherry-studio')
  })

  it('documents the env var name used by the build command', () => {
    expect(APP_FLAVOR_ENV_VAR).toBe('VITE_APP_FLAVOR')
  })
})

describe('flavorDefine (Vite define generation)', () => {
  it('generates a JSON string literal define for the default flavor', () => {
    expect(flavorDefine('cherry-studio')).toEqual({ [APP_FLAVOR_DEFINE_KEY]: '"cherry-studio"' })
  })

  it('generates a JSON string literal define for cherry-chat', () => {
    expect(flavorDefine('cherry-chat')).toEqual({ [APP_FLAVOR_DEFINE_KEY]: '"cherry-chat"' })
  })

  it('exposes the define key matching the identifier read by identity.ts', () => {
    expect(APP_FLAVOR_DEFINE_KEY).toBe('__APP_FLAVOR__')
    expect(identitySource).toContain('typeof __APP_FLAVOR__')
  })
})

describe('compile-time baking of identity.ts (define replacement)', () => {
  it('bakes the cherry-chat identity when compiled with the cherry-chat define', async () => {
    const compiled = await compileIdentityModule('cherry-chat')

    expect(compiled.appFlavor).toBe('cherry-chat')
    expect(compiled.appIdentity).toEqual(resolveAppIdentity('cherry-chat'))
    expect(compiled.appIdentity.productName).toBe('Cherry Chat')
    expect(compiled.appIdentity.appId).toBe('com.jorkeyliu.CherryChat')
    expect(compiled.appIdentity.protocolUrlScheme).toBe('cherrychat://')
    expect(compiled.appIdentity.homeDirName).toBe('.cherrychat')
    expect(compiled.appIdentity.userDataDirName).toBe('Cherry Chat')
    expect(compiled.appIdentity.updaterEnabled).toBe(false)
  })

  it('bakes the default Cherry Studio identity when compiled with the default define', async () => {
    const compiled = await compileIdentityModule('cherry-studio')

    expect(compiled.appFlavor).toBe('cherry-studio')
    expect(compiled.appIdentity).toEqual(resolveAppIdentity('cherry-studio'))
    expect(compiled.appIdentity.productName).toBe('Cherry Studio')
    expect(compiled.appIdentity.updaterEnabled).toBe(true)
  })

  it('falls back to the Cherry Studio identity under plain Node (no define) without throwing', async () => {
    const compiled = await compileIdentityModule(undefined)

    expect(compiled.appFlavor).toBe('cherry-studio')
    expect(compiled.appIdentity).toEqual(resolveAppIdentity('cherry-studio'))
    // The default-flavor constants derived from appIdentity stay unchanged.
    expect(compiled.appIdentity.homeDirName).toBe('.cherrystudio')
    expect(compiled.appIdentity.updaterEnabled).toBe(true)
  })

  it('never emits the broken dynamic `{}.env` import.meta read', async () => {
    const { code } = await transform(identitySource, { loader: 'ts', format: 'cjs' })

    // The historical root-cause failure compiled `import.meta` to `{}` and
    // read `.env` off it, always yielding undefined.
    expect(code).not.toContain('{}.env')
    expect(code).not.toContain('.env.VITE_APP_FLAVOR')
  })
})

describe('compile-time baking of the main-window title (renderer seam, IDENTITY-002)', () => {
  // The main-window title seam (`src/renderer/src/config/title.ts`) assigns
  // `document.title = appIdentity.productName`; the identity productName is
  // what the `__APP_FLAVOR__` define bakes (asserted above). Bundling the REAL
  // title module with the REAL identity module and EVALUATING it is behavioral
  // evidence for both flavors — the same define-replacement a Vite build
  // applies to the renderer target. esbuild is resolved through the installed
  // electron-vite peer (no hoisted types), so the API surface is typed
  // structurally, matching the `transform` pattern above.
  interface TitleBundleResult {
    outputFiles: Array<{ text: string }>
  }
  interface TitleBundleOptions {
    stdin: { contents: string; resolveDir: string; loader: string; sourcefile: string }
    bundle: boolean
    write: false
    format: string
    platform: string
    define?: Record<string, string>
    alias?: Record<string, string>
  }
  const build = requireFromElectronVite('esbuild').build as (options: TitleBundleOptions) => Promise<TitleBundleResult>

  const titleSourcePath = path.resolve(__dirname, '../../../../src/renderer/src/config/title.ts')
  const identityModulePath = path.resolve(__dirname, '../identity.ts')

  async function compiledTitleFor(flavor: 'cherry-studio' | 'cherry-chat'): Promise<string> {
    const result = await build({
      stdin: {
        contents: `import { applyMainWindowTitle } from ${JSON.stringify(titleSourcePath)}\napplyMainWindowTitle()`,
        resolveDir: __dirname,
        loader: 'ts',
        sourcefile: 'title-bundle-entry.ts'
      },
      bundle: true,
      write: false,
      format: 'cjs',
      platform: 'node',
      define: { [APP_FLAVOR_DEFINE_KEY]: JSON.stringify(flavor) },
      alias: { '@shared/config/identity': identityModulePath }
    })
    const code = result.outputFiles[0].text
    const module = { exports: {} }
    // Minimal document stub: the seam only assigns `document.title`, which is
    // exactly what the E2E observes on the packaged window.
    const documentStub = { title: '' }
    new Function('module', 'exports', 'document', code)(module, module.exports, documentStub)
    return documentStub.title
  }

  it('bakes `Cherry Chat` into the main-window title when compiled as the cherry-chat flavor', async () => {
    await expect(compiledTitleFor('cherry-chat')).resolves.toBe('Cherry Chat')
  })

  it('bakes `Cherry Studio` into the main-window title when compiled as the default flavor', async () => {
    await expect(compiledTitleFor('cherry-studio')).resolves.toBe('Cherry Studio')
  })
})
