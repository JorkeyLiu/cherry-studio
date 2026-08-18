/// <reference types="vite/client" />

// Compile-time build identity injected by electron.vite.config.ts `define`
// (VERSION-003/004): the per-build Build ID and numeric macOS build version.
// They are separate from the product version returned by app.getVersion().
declare const __BUILD_ID__: string
declare const __BUILD_VERSION__: string

// PERF-STREAM-ATTR-001 measurement switch inlined at build time
// (electron.vite.config.ts / vitest.config.ts `define`); 'true'/'false'
// string. Default builds inline 'false' — the Main collector stays inert.
declare const __PERF_STREAM_ATTR__: string
declare const __PERF_PHASE_ATTR__: string

interface ImportMetaEnv {
  VITE_MAIN_BUNDLE_ID: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
