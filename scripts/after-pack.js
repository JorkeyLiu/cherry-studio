const fs = require('fs')
const path = require('path')
const { listPackage } = require('@electron/asar')

exports.default = async function (context) {
  const platform = context.packager.platform.name
  if (platform === 'windows') {
    fs.rmSync(path.join(context.appOutDir, 'LICENSE.electron.txt'), { force: true })
    fs.rmSync(path.join(context.appOutDir, 'LICENSES.chromium.html'), { force: true })

    const asarPath = path.join(context.appOutDir, 'resources', 'app.asar')
    const asarUnpackedNative = path.join(
      context.appOutDir,
      'resources',
      'app.asar.unpacked',
      'node_modules',
      '@paymoapp',
      'electron-shutdown-handler',
      'build',
      'Release',
      'PaymoWinShutdownHandler.node'
    )

    if (!fs.existsSync(asarPath)) {
      throw new Error(`Windows packaged runtime validation failed; missing ${asarPath}`)
    }
    if (!fs.existsSync(asarUnpackedNative)) {
      throw new Error(`Windows packaged runtime validation failed; missing ${asarUnpackedNative}`)
    }

    const entries = new Set(listPackage(asarPath).map((entry) => entry.replace(/\\/g, '/').replace(/^\/+/, '')))
    const required = [
      'node_modules/ms/package.json',
      'node_modules/@paymoapp/electron-shutdown-handler/dist/index.js',
      'node_modules/@paymoapp/electron-shutdown-handler/build/Release/PaymoWinShutdownHandler.node'
    ]
    const missing = required.filter((entry) => !entries.has(entry))
    if (missing.length) {
      throw new Error(`Windows packaged runtime validation failed; missing: ${missing.join(', ')}`)
    }
  }
}
