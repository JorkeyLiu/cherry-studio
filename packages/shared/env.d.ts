/// <reference types="vite/client" />

/**
 * Compile-time application flavor constant injected by
 * `electron.vite.config.ts` (Vite `define`, see
 * `packages/shared/config/buildFlavor.ts`). Replaced with the flavor literal
 * in every build target; under plain Node/tsx it is not defined and must only
 * be read via `typeof`.
 */
declare const __APP_FLAVOR__: string | undefined

interface ImportMetaEnv {
  /**
   * Build-time application flavor selector consumed by
   * `electron.vite.config.ts`. Unset/invalid values resolve to the default
   * `cherry-studio` identity. Set to `cherry-chat` to build the Cherry Chat
   * flavor (see `docs/cherry-chat-application-identity.md`). The runtime
   * identity module reads the flavor from the injected `__APP_FLAVOR__`
   * constant, not from `import.meta.env` (dynamic property access is not
   * replaced by Vite).
   */
  VITE_APP_FLAVOR?: string
}
