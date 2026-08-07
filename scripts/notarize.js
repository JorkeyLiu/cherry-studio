require('dotenv').config()
const { notarize } = require('@electron/notarize')

/**
 * Resolve the macOS bundle identifier for notarization from the active
 * electron-builder packager/appInfo instead of a literal (LOCK-RETIRE-001).
 *
 * Under the single Cherry Chat base config, `context.packager.appInfo.id`
 * resolves to `com.jorkeyliu.CherryChat`. Exported as a pure helper so the
 * resolution can be tested without invoking Apple notarization
 * (scripts/__tests__/notarize.test.ts).
 */
exports.resolveAppBundleId = function resolveAppBundleId(context) {
  return context?.packager?.appInfo?.id
}

exports.default = async function notarizing(context) {
  if (context.electronPlatformName !== 'darwin') {
    return
  }

  if (!process.env.APPLE_ID || !process.env.APPLE_APP_SPECIFIC_PASSWORD || !process.env.APPLE_TEAM_ID) {
    return
  }

  const appName = context.packager.appInfo.productFilename
  const appPath = `${context.appOutDir}/${appName}.app`
  const appBundleId = exports.resolveAppBundleId(context)

  if (!appBundleId) {
    throw new Error('Unable to resolve appBundleId from packager/appInfo for notarization')
  }

  await notarize({
    appPath,
    appBundleId,
    appleId: process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
    teamId: process.env.APPLE_TEAM_ID
  })

  console.log('  • Notarized app:', appPath)
}
