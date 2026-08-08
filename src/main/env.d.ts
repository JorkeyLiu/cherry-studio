/// <reference types="vite/client" />

// Compile-time build identity injected by electron.vite.config.ts `define`
// (VERSION-003/004): the per-build Build ID and numeric macOS build version.
// They are separate from the product version returned by app.getVersion().
declare const __BUILD_ID__: string
declare const __BUILD_VERSION__: string

interface ImportMetaEnv {
  VITE_MAIN_BUNDLE_ID: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
