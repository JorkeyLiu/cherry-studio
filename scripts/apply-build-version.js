// Applies the numeric macOS build version to electron-builder's AppInfo so it
// lands in CFBundleVersion (VERSION-003).
//
// electron-builder does NOT macro-expand the top-level `buildVersion` config
// (AppInfo reads it raw), so a `${env.…}` template would reach the plist as a
// literal. The build-identity wrapper (scripts/build-identity.ts) sets
// `CHERRY_CHAT_BUILD_VERSION` once per build invocation; this hook is invoked
// from `beforePack` (scripts/before-pack.js), which runs before the macOS
// Info.plist is written, and copies the env value into the in-memory AppInfo.
// When the env is absent (electron-builder invoked without the wrapper) the
// AppInfo default (product version) is left untouched.

exports.default = function applyBuildVersion(context) {
  // VERSION-003/005: the numeric build version feeds CFBundleVersion — a
  // macOS-only concept. When the platform is known and is NOT macOS, leave
  // AppInfo untouched (Windows/Linux metadata is out of scope,
  // LOCK-PLATFORM-005). When platform info is absent the macOS-preserving
  // behavior is unchanged.
  const platform = context && context.packager && context.packager.platform && context.packager.platform.name
  if (platform != null && platform !== 'mac') {
    return
  }
  const envBuildVersion = process.env.CHERRY_CHAT_BUILD_VERSION
  if (envBuildVersion && context && context.packager && context.packager.appInfo) {
    context.packager.appInfo.buildVersion = envBuildVersion
  }
}
