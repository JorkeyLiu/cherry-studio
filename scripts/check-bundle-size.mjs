#!/usr/bin/env node

/**
 * Bundle Size Checker
 *
 * Reads out/renderer/assets/ and reports JS/CSS bundle sizes.
 * Can optionally compare against a baseline JSON file.
 *
 * Usage:
 *   node scripts/check-bundle-size.mjs [--baseline path/to/baseline.json] [--threshold 10]
 */

import fs from 'fs'
import path from 'path'

const ASSETS_DIR = 'out/renderer/assets'
const BASELINE_PATH = 'src/renderer/__tests__/bundle-baseline.json'

// Parse CLI args
const args = process.argv.slice(2)
let baselinePath = BASELINE_PATH
let threshold = 10 // percent increase allowed before warning

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--baseline' && args[i + 1]) {
    baselinePath = args[++i]
  }
  if (args[i] === '--threshold' && args[i + 1]) {
    threshold = Number(args[++i])
  }
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB'
  return (bytes / 1024).toFixed(2) + ' KB'
}

function getFileSize(filePath) {
  return fs.statSync(filePath).size
}

function getBundleStats() {
  if (!fs.existsSync(ASSETS_DIR)) {
    console.error(`Assets directory not found: ${ASSETS_DIR}`)
    console.error('Run "pnpm build" first to generate the renderer bundle.')
    process.exit(1)
  }

  const files = fs.readdirSync(ASSETS_DIR)
  const jsFiles = files.filter((f) => f.endsWith('.js'))
  const cssFiles = files.filter((f) => f.endsWith('.css'))
  const jsonFiles = files.filter((f) => f.endsWith('.json'))
  const fontFiles = files.filter((f) => /\.(ttf|woff|woff2)$/.test(f))
  const imageFiles = files.filter((f) => /\.(png|webp|svg|gif|jpg|jpeg)$/.test(f))

  const jsSize = jsFiles.reduce((sum, f) => sum + getFileSize(path.join(ASSETS_DIR, f)), 0)
  const cssSize = cssFiles.reduce((sum, f) => sum + getFileSize(path.join(ASSETS_DIR, f)), 0)
  const jsonSize = jsonFiles.reduce((sum, f) => sum + getFileSize(path.join(ASSETS_DIR, f)), 0)
  const fontSize = fontFiles.reduce((sum, f) => sum + getFileSize(path.join(ASSETS_DIR, f)), 0)
  const imageSize = imageFiles.reduce((sum, f) => sum + getFileSize(path.join(ASSETS_DIR, f)), 0)

  const allFiles = files.map((f) => ({
    name: f,
    sizeBytes: getFileSize(path.join(ASSETS_DIR, f))
  }))

  const largestJsCss = allFiles
    .filter((f) => f.name.endsWith('.js') || f.name.endsWith('.css'))
    .sort((a, b) => b.sizeBytes - a.sizeBytes)

  return {
    buildDate: new Date().toISOString().split('T')[0],
    jsFiles: jsFiles.length,
    jsSizeBytes: jsSize,
    jsSizeFormatted: formatSize(jsSize),
    cssFiles: cssFiles.length,
    cssSizeBytes: cssSize,
    cssSizeFormatted: formatSize(cssSize),
    jsonFiles: jsonFiles.length,
    jsonSizeBytes: jsonSize,
    jsonSizeFormatted: formatSize(jsonSize),
    fontFiles: fontFiles.length,
    fontSizeBytes: fontSize,
    fontSizeFormatted: formatSize(fontSize),
    imageFiles: imageFiles.length,
    imageSizeBytes: imageSize,
    imageSizeFormatted: formatSize(imageSize),
    totalSizeBytes: jsSize + cssSize + jsonSize + fontSize + imageSize,
    totalSizeFormatted: formatSize(jsSize + cssSize + jsonSize + fontSize + imageSize),
    totalFiles: files.length,
    largestFiles: largestJsCss.slice(0, 20).map((f) => ({
      name: f.name,
      sizeBytes: f.sizeBytes,
      sizeFormatted: formatSize(f.sizeBytes)
    }))
  }
}

function compareWithBaseline(current, baseline) {
  const comparisons = [
    { label: 'JS Total', currentBytes: current.jsSizeBytes, baselineBytes: baseline.jsSizeBytes },
    { label: 'CSS Total', currentBytes: current.cssSizeBytes, baselineBytes: baseline.cssSizeBytes },
    { label: 'JSON Total', currentBytes: current.jsonSizeBytes, baselineBytes: baseline.jsonSizeBytes },
    { label: 'Font Total', currentBytes: current.fontSizeBytes, baselineBytes: baseline.fontSizeBytes },
    { label: 'Image Total', currentBytes: current.imageSizeBytes, baselineBytes: baseline.imageSizeBytes },
    { label: 'Grand Total', currentBytes: current.totalSizeBytes, baselineBytes: baseline.totalSizeBytes }
  ]

  let hasWarning = false

  console.log('\n=== Comparison with Baseline ===')
  console.log(`Baseline date: ${baseline.buildDate}`)
  console.log('')

  for (const c of comparisons) {
    const diff = c.currentBytes - c.baselineBytes
    const pct = ((diff / c.baselineBytes) * 100).toFixed(1)
    const sign = diff >= 0 ? '+' : ''
    const arrow = diff > 0 ? '▲' : diff < 0 ? '▼' : '='
    const isWarning = diff > 0 && Math.abs(Number(pct)) > threshold
    if (isWarning) hasWarning = true

    const marker = isWarning ? ' ⚠️' : ''
    console.log(`${c.label}: ${formatSize(c.currentBytes)} (${sign}${pct}% ${arrow} from baseline)${marker}`)
  }

  console.log('')
  return hasWarning
}

// Main
const stats = getBundleStats()

console.log('=== Renderer Bundle Size Report ===')
console.log(`Build date: ${stats.buildDate}`)
console.log('')
console.log(`JS files:       ${stats.jsFiles}`)
console.log(`JS total:       ${stats.jsSizeFormatted}`)
console.log('')
console.log(`CSS files:      ${stats.cssFiles}`)
console.log(`CSS total:      ${stats.cssSizeFormatted}`)
console.log('')
console.log(`JSON files:     ${stats.jsonFiles}`)
console.log(`JSON total:     ${stats.jsonSizeFormatted}`)
console.log('')
console.log(`Font files:     ${stats.fontFiles}`)
console.log(`Font total:     ${stats.fontSizeFormatted}`)
console.log('')
console.log(`Image files:    ${stats.imageFiles}`)
console.log(`Image total:    ${stats.imageSizeFormatted}`)
console.log('')
console.log(`Total files:    ${stats.totalFiles}`)
console.log(`Grand total:    ${stats.totalSizeFormatted}`)
console.log('')

console.log('=== Top 20 Largest JS/CSS Chunks ===')
stats.largestFiles.forEach((item, i) => {
  console.log(`${(i + 1).toString().padStart(2)}. ${item.name} (${item.sizeFormatted})`)
})

// Compare with baseline if available
let hasWarning = false
if (fs.existsSync(baselinePath)) {
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'))
  hasWarning = compareWithBaseline(stats, baseline)
}

// Exit with non-zero if there are warnings (useful for CI)
if (hasWarning) {
  console.warn('\n⚠️  Bundle size exceeded threshold. Consider investigating.')
  process.exit(1)
}
