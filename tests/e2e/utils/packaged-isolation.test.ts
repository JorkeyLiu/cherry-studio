import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

import { hashMachOUnsignedPayload, provenanceOfMachOPrebuilt } from './packaged-isolation'

const KNOWN_REPO_UUID = 'c87a9325f7483e3191dc18cfb1217a68'

function repoPrebuiltPath(): string {
  return path.join(process.cwd(), 'node_modules', 'better-sqlite3', 'prebuilds', 'darwin-arm64.node')
}

function packagedPrebuiltPath(): string {
  return path.join(
    process.cwd(),
    'dist',
    'mac-arm64',
    'Cherry Chat.app',
    'Contents',
    'Resources',
    'app.asar.unpacked',
    'node_modules',
    'better-sqlite3',
    'prebuilds',
    'darwin-arm64.node'
  )
}

/**
 * Build a minimal synthetic Mach-O thin image in memory: header + __LINKEDIT
 * + UUID + CODE_SIG, identical code bytes up to dataOff, caller-chosen
 * LINKEDIT sizes and trailing signature bytes. Proves the parser discovers
 * field offsets dynamically instead of relying on hardcoded file offsets.
 */
function syntheticImage(options: {
  vmsize: number
  filesize: number
  signatureByte: number
  signatureSize: number
}): Buffer {
  const dataOff = 512
  const total = dataOff + options.signatureSize
  const buf = Buffer.alloc(total, 0)
  buf.fill(0xab, 144, dataOff)
  buf.writeUInt32LE(0xfeedfacf, 0)
  buf.writeUInt32LE(0x0100000c, 4)
  buf.writeUInt32LE(0, 8)
  buf.writeUInt32LE(0x8, 12)
  buf.writeUInt32LE(3, 16)
  buf.writeUInt32LE(72 + 24 + 16, 20)
  buf.writeUInt32LE(0, 24)
  buf.writeUInt32LE(0, 28)
  // LC_SEGMENT_64 __LINKEDIT at 32.
  buf.writeUInt32LE(0x19, 32)
  buf.writeUInt32LE(72, 36)
  buf.write('__LINKEDIT', 40, 'utf8')
  buf.writeBigUInt64LE(BigInt(0x1c0000), 32 + 24)
  buf.writeBigUInt64LE(BigInt(options.vmsize), 32 + 32)
  buf.writeBigUInt64LE(BigInt(0x1c0000), 32 + 40)
  buf.writeBigUInt64LE(BigInt(options.filesize), 32 + 48)
  // LC_UUID at 104.
  buf.writeUInt32LE(0x1b, 104)
  buf.writeUInt32LE(24, 108)
  Buffer.from(KNOWN_REPO_UUID, 'hex').copy(buf, 112)
  // LC_CODE_SIGNATURE at 128.
  buf.writeUInt32LE(0x1d, 128)
  buf.writeUInt32LE(16, 132)
  buf.writeUInt32LE(dataOff, 136)
  buf.writeUInt32LE(options.signatureSize, 140)
  buf.fill(options.signatureByte, dataOff, total)
  return buf
}

describe('Mach-O signing-normalized payload (packaged-isolation)', () => {
  it('parses the locked repo darwin-arm64 prebuilt with a trailing signature blob', () => {
    const repoPath = repoPrebuiltPath()
    if (!fs.existsSync(repoPath)) {
      console.warn(`[packaged-isolation.test] repo prebuilt absent, skipping: ${repoPath}`)
      return
    }
    const provenance = provenanceOfMachOPrebuilt(repoPath)
    expect(provenance.uuid).toBe(KNOWN_REPO_UUID)
    expect(provenance.dataOff).toBeGreaterThan(0)
    expect(provenance.dataSize).toBeGreaterThan(0)
    expect(provenance.fileSize).toBe(provenance.dataOff + provenance.dataSize)
    expect(provenance.rawHash).toMatch(/^[0-9a-f]{64}$/)
    expect(provenance.normalizedHash).toMatch(/^[0-9a-f]{64}$/)
    expect(provenance.normalizedHash).not.toBe(provenance.rawHash)
  })

  it('normalizes only signing-size fields across different LINKEDIT/signature sizes', () => {
    const a = syntheticImage({ vmsize: 147456, filesize: 145728, signatureByte: 0x11, signatureSize: 64 })
    const b = syntheticImage({ vmsize: 180224, filesize: 163872, signatureByte: 0x22, signatureSize: 128 })
    expect(Buffer.compare(a, b) === 0).toBe(false)
    const parsedA = hashMachOUnsignedPayload(a)
    const parsedB = hashMachOUnsignedPayload(b)
    expect(parsedA.uuid).toBe(KNOWN_REPO_UUID)
    expect(parsedB.uuid).toBe(KNOWN_REPO_UUID)
    expect(parsedA.dataOff).toBe(parsedB.dataOff)
    expect(parsedA.normalizedHash).toBe(parsedB.normalizedHash)
  })

  it('matches the packaged prebuild payload when the packaged file exists', () => {
    const repoPath = repoPrebuiltPath()
    const packagedPath = packagedPrebuiltPath()
    if (!fs.existsSync(repoPath) || !fs.existsSync(packagedPath)) {
      console.warn('[packaged-isolation.test] repo or packaged prebuilt absent, skipping packaged comparison')
      return
    }
    const repo = provenanceOfMachOPrebuilt(repoPath)
    const packaged = provenanceOfMachOPrebuilt(packagedPath)
    expect(packaged.uuid).toBe(repo.uuid)
    expect(packaged.dataOff).toBe(repo.dataOff)
    expect(packaged.fileSize - repo.fileSize).toBe(packaged.dataSize - repo.dataSize)
    expect(packaged.normalizedHash).toBe(repo.normalizedHash)
  })

  it('rejects non-Mach-O input without claiming provenance', () => {
    expect(() => hashMachOUnsignedPayload(Buffer.from('not-a-macho'))).toThrow()
  })
})
