// Fails the packaging run when exactly one half of the build identity env
// bridge is present (VERSION-003 coherence).
//
// The build-identity wrapper (scripts/build-identity.ts --spawn) always sets
// CHERRY_CHAT_BUILD_ID and CHERRY_CHAT_BUILD_VERSION TOGETHER from one
// captured timestamp. A hand-crafted PARTIAL environment (exactly one half
// set) would otherwise let electron-builder consume the raw half: the
// `mac.artifactName` macro reads CHERRY_CHAT_BUILD_ID while
// scripts/apply-build-version.js reads CHERRY_CHAT_BUILD_VERSION — producing
// an artifact whose file name and bundle metadata disagree (re-audit Finding
// A). The compile path (electron.vite.config.ts) treats a partial env as
// absent and recomputes both halves from one capture, so without this guard
// a partial env silently yields a split identity between the artifact name
// and the baked bundle.
//
// This guard runs from the beforePack hook (scripts/before-pack.js), i.e.
// BEFORE electron-builder evaluates the artifactName macro (packager flow:
// doPack -> emitBeforePack -> packageInDistributableFormat -> target.build)
// and BEFORE any artifact file is written; throwing here aborts the build so
// no split-identity artifact can ever be produced.
//
// Both-present passes through (supported wrapper path). Neither-present keeps
// the existing degraded behavior: electron-builder's `${env.…}` macro hard
// fails on the missing Build ID for macOS artifacts
// (ERR_ELECTRON_BUILDER_ENV_NOT_DEFINED) and apply-build-version is a no-op.
//
// Empty-string halves count as unset, matching the truthiness the compile
// path and apply-build-version use.

const BUILD_ID_ENV = 'CHERRY_CHAT_BUILD_ID'
const BUILD_VERSION_ENV = 'CHERRY_CHAT_BUILD_VERSION'

function isSet(value) {
  return value != null && value !== ''
}

exports.BUILD_ID_ENV = BUILD_ID_ENV
exports.BUILD_VERSION_ENV = BUILD_VERSION_ENV

exports.assertBuildIdentityEnv = function assertBuildIdentityEnv() {
  const buildId = process.env[BUILD_ID_ENV]
  const buildVersion = process.env[BUILD_VERSION_ENV]
  const buildIdSet = isSet(buildId)
  const buildVersionSet = isSet(buildVersion)
  if (buildIdSet === buildVersionSet) {
    return
  }
  const present = buildIdSet ? BUILD_ID_ENV : BUILD_VERSION_ENV
  const missing = buildIdSet ? BUILD_VERSION_ENV : BUILD_ID_ENV
  throw new Error(
    `[build-identity] split environment: ${present} is set but ${missing} is not. ` +
      `${BUILD_ID_ENV} and ${BUILD_VERSION_ENV} must be set together from one capture; ` +
      `use the wrapper: dotenv -- tsx scripts/build-identity.ts --spawn "<build && electron-builder ...>"`
  )
}

exports.default = exports.assertBuildIdentityEnv
