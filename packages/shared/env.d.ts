/// <reference types="vite/client" />

/**
 * Cherry Chat is the sole application identity (LOCK-RETIRE-001/002); there is
 * no build-time flavor selector and no `VITE_APP_FLAVOR`/`__APP_FLAVOR__`
 * compile-time define anymore. Application identity lives in the single
 * immutable `packages/shared/config/identity.ts` constant.
 */
interface ImportMetaEnv {}
