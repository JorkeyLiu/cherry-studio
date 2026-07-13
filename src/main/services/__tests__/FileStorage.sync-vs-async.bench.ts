import { afterAll, beforeAll, bench, describe, vi } from 'vitest'

// Bypass global fs and os mocks, use real modules
vi.unmock('node:fs')
vi.unmock('node:os')

const fs = await import('node:fs')
const fsPromises = await import('node:fs/promises')
const path = await import('node:path')
const os = await import('node:os')

describe('fs.statSync vs fs.promises.stat', () => {
  const tmpDir = os.default.tmpdir()
  const testFiles: string[] = []

  beforeAll(async () => {
    // Create 100 test files
    for (let i = 0; i < 100; i++) {
      const filePath = path.default.join(tmpDir, `bench-file-${i}.txt`)
      fs.default.writeFileSync(filePath, 'x'.repeat(1024))
      testFiles.push(filePath)
    }
  })

  afterAll(() => {
    testFiles.forEach((f) => {
      try {
        fs.default.unlinkSync(f)
      } catch {}
    })
  })

  bench('statSync (100 files)', () => {
    for (const f of testFiles) {
      fs.default.statSync(f)
    }
  })

  bench('promises.stat parallel (100 files)', async () => {
    await Promise.all(testFiles.map((f) => fsPromises.default.stat(f)))
  })

  bench('statSync sequential (100 files)', () => {
    for (const f of testFiles) {
      fs.default.statSync(f)
    }
  })

  bench('promises.stat sequential (100 files)', async () => {
    for (const f of testFiles) {
      await fsPromises.default.stat(f)
    }
  })
})

describe('fs.existsSync vs fs.promises.access', () => {
  const tmpDir = os.default.tmpdir()
  const existingFiles: string[] = []
  const nonExistingFiles: string[] = []

  beforeAll(async () => {
    for (let i = 0; i < 100; i++) {
      const filePath = path.default.join(tmpDir, `bench-exists-${i}.txt`)
      fs.default.writeFileSync(filePath, 'x'.repeat(1024))
      existingFiles.push(filePath)
      nonExistingFiles.push(path.default.join(tmpDir, `bench-noexist-${i}.txt`))
    }
  })

  afterAll(() => {
    existingFiles.forEach((f) => {
      try {
        fs.default.unlinkSync(f)
      } catch {}
    })
  })

  bench('existsSync (200 files)', () => {
    for (const f of existingFiles) {
      fs.default.existsSync(f)
    }
    for (const f of nonExistingFiles) {
      fs.default.existsSync(f)
    }
  })

  bench('promises.access parallel (100 existing files)', async () => {
    await Promise.all(
      existingFiles.map(async (f) => {
        try {
          await fsPromises.default.access(f)
        } catch {}
      })
    )
  })
})

describe('fs.readFileSync vs fs.promises.readFile', () => {
  const tmpDir = os.default.tmpdir()
  const testFiles: string[] = []

  beforeAll(async () => {
    for (let i = 0; i < 50; i++) {
      const filePath = path.default.join(tmpDir, `bench-read-${i}.txt`)
      fs.default.writeFileSync(filePath, 'x'.repeat(4096))
      testFiles.push(filePath)
    }
  })

  afterAll(() => {
    testFiles.forEach((f) => {
      try {
        fs.default.unlinkSync(f)
      } catch {}
    })
  })

  bench('readFileSync (50 files)', () => {
    for (const f of testFiles) {
      fs.default.readFileSync(f, 'utf-8')
    }
  })

  bench('promises.readFile parallel (50 files)', async () => {
    await Promise.all(testFiles.map((f) => fsPromises.default.readFile(f, 'utf-8')))
  })

  bench('promises.readFile sequential (50 files)', async () => {
    for (const f of testFiles) {
      await fsPromises.default.readFile(f, 'utf-8')
    }
  })
})

describe('writeFileSync vs fs.promises.writeFile', () => {
  const tmpDir = os.default.tmpdir()
  const testFiles: string[] = []

  beforeAll(() => {
    for (let i = 0; i < 50; i++) {
      testFiles.push(path.default.join(tmpDir, `bench-write-${i}.txt`))
    }
  })

  afterAll(() => {
    testFiles.forEach((f) => {
      try {
        fs.default.unlinkSync(f)
      } catch {}
    })
  })

  bench('writeFileSync (50 files)', () => {
    for (const f of testFiles) {
      fs.default.writeFileSync(f, 'x'.repeat(4096))
    }
  })

  bench('promises.writeFile parallel (50 files)', async () => {
    await Promise.all(testFiles.map((f) => fsPromises.default.writeFile(f, 'x'.repeat(4096))))
  })
})
