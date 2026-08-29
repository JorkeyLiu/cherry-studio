/**
 * S6.4/S6.5 review-preparation summary.
 *
 * This module is deliberately ingestion-only. It accepts schema-v1 benchmark
 * values already held in memory and a caller-supplied fixed inventory. It does
 * not read files, databases, profiles, ZIPs, Dexie, or live repository state.
 * The result is decision support only: it preserves the exact review status
 * `Candidate — Not Authorized` and contains no threshold or production
 * decision fields.
 */

import type { BenchmarkResult } from '../../../src/main/services/chatDb/__tests__/benchResult'
import { validateBenchmarkResult } from '../../../src/main/services/chatDb/__tests__/benchResult'

export const S6_REVIEW_PREPARATION_SCHEMA_VERSION = 1 as const
export const S6_REVIEW_PREPARATION_ID = 's6-review-preparation' as const
export const S6_AUTHORIZATION_STATUS = 'Candidate — Not Authorized' as const
export const S6_PRIVACY_ATTESTATION =
  'Summary uses only supplied schema-v1 numeric/boolean evidence and fixed inventory; no user data, real profile, ZIP, Dexie, Files, paths, content, credentials, or raw database size were inspected; no production write occurred.'

export const S6_REQUIRED_GOVERNANCE = [
  'SQLite migration governance for schema, index, storage, or authority changes',
  'Shared IPC/preload coordinated review for any cross-process contract change',
  'Privacy review for any real-corpus or physical-size probe',
  'Context-window governance if contextWindowAnchor semantics are involved',
  'Sync MVP governance if synchronization metadata or authority is involved'
] as const

export type S6EvidenceSource = 'm1' | 'm2' | 'm3' | 'm4' | 'm5'
export type S6M4Scale = '1k' | '10k' | '50k'
export type S6M5Scale = 'small' | 'medium'

/** Fixed, non-sensitive inventory supplied by the review caller. */
export interface S6ReviewInventory {
  reviewedFiles: readonly string[]
  staticIndexInventory: {
    existingIndexes: readonly string[]
    normalizedProjectionPresent: boolean
    ftsTablePresent: boolean
  }
  searchInventory: {
    collectCandidatesPresent: boolean
    likeCandidatesPresent: boolean
    fetchResultsPresent: boolean
  }
  fileConsistencyInventory: {
    fileReferencesPresent: boolean
    attachmentAvailabilityMarkerPresent: boolean
  }
}

export interface S6ReviewEvidence {
  source: S6EvidenceSource
  result: BenchmarkResult
}

export interface S6ReviewPreparationInput {
  results: readonly S6ReviewEvidence[]
  inventory: S6ReviewInventory
}

export interface S6M4InputSummary {
  present: boolean
  scales: Record<S6M4Scale, boolean>
}

export interface S6M5InputSummary {
  present: boolean
  scales: Record<S6M5Scale, boolean>
}

export interface S6ReviewInputsSummary {
  m1ArtifactPresent: boolean
  m2ArtifactPresent: boolean
  m3ArtifactPresent: boolean
  m4: S6M4InputSummary
  m5: S6M5InputSummary
}

export interface S6ReviewEvidenceSummary {
  m1: { paritiesPass: boolean; gatesPass: boolean } | null
  m2: { gatesPass: boolean } | null
  m3: { gatesPass: boolean } | null
  m4: { logicalDuplicationBytes: number | null; gatesPass: boolean } | null
  m5: { scenarios: number | null; gatesPass: boolean } | null
}

export interface S6ReviewGaps {
  realCorpusMissing: boolean
  physicalSizeMissing: boolean
  m6EvidenceMissing: boolean
  indexBenefitUnproven: boolean
  fileConsistencyUnproven: boolean
}

export interface S6ReviewPreparationSummary {
  schemaVersion: typeof S6_REVIEW_PREPARATION_SCHEMA_VERSION
  reviewId: typeof S6_REVIEW_PREPARATION_ID
  inputs: S6ReviewInputsSummary
  evidenceSummary: S6ReviewEvidenceSummary
  inventory: S6ReviewInventory
  gaps: S6ReviewGaps
  requiredGovernance: readonly string[]
  authorizationStatus: typeof S6_AUTHORIZATION_STATUS
  privacyAttestation: typeof S6_PRIVACY_ATTESTATION
}

const EVIDENCE_SOURCES: readonly S6EvidenceSource[] = ['m1', 'm2', 'm3', 'm4', 'm5']

const SOURCE_BENCHMARK_ID_PATTERNS: Record<S6EvidenceSource, RegExp> = {
  m1: /^chatdb-sort-order-shift$/,
  m2: /^chatdb-search-stage-50k$/,
  m3: /^chatdb-search-stage-plan-50k$/,
  m4: /^chatdb-m4-fts-duplication-(1k|10k|50k)$/,
  m5: /^chatdb-m5-file-dual-state$/
}

const SUMMARY_KEYS = [
  'schemaVersion',
  'reviewId',
  'inputs',
  'evidenceSummary',
  'inventory',
  'gaps',
  'requiredGovernance',
  'authorizationStatus',
  'privacyAttestation'
] as const

const GAPS_KEYS = [
  'realCorpusMissing',
  'physicalSizeMissing',
  'm6EvidenceMissing',
  'indexBenefitUnproven',
  'fileConsistencyUnproven'
] as const

const FORBIDDEN_KEYS = new Set([
  'content',
  'credential',
  'credentials',
  'password',
  'secret',
  'token',
  'apiKey',
  'dbPath',
  'dbSize',
  'profile',
  'userData',
  'attachment',
  'raw'
])

const DECISION_KEYS = /threshold|authorization|authorized|baseline|capacity|eviction/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isDenseArray(value: unknown): value is readonly unknown[] {
  if (!Array.isArray(value)) return false
  for (let index = 0; index < value.length; index++) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) return false
  }
  return true
}

function validateDenseArray(value: unknown, at: string, problems: string[]): value is readonly unknown[] {
  if (!Array.isArray(value)) return false
  const dense = isDenseArray(value)
  if (!dense) problems.push(`${at} must not be sparse`)
  return dense
}

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  const allowedSet = new Set(allowed)
  return Object.keys(value)
    .filter((key) => !allowedSet.has(key))
    .sort()
}

function collectForbiddenKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectForbiddenKeys(item, out)
  } else if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key) || DECISION_KEYS.test(key)) out.push(key)
      collectForbiddenKeys(child, out)
    }
  }
  return out
}

function forbiddenKeys(value: unknown, allowedKeys: ReadonlySet<string> = new Set()): string[] {
  return [...new Set(collectForbiddenKeys(value).filter((key) => !allowedKeys.has(key)))].sort()
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function sortedStrings(values: readonly string[]): string[] {
  return [...values].sort()
}

function cloneInventory(inventory: S6ReviewInventory): S6ReviewInventory {
  return {
    reviewedFiles: sortedStrings(inventory.reviewedFiles),
    staticIndexInventory: {
      existingIndexes: sortedStrings(inventory.staticIndexInventory.existingIndexes),
      normalizedProjectionPresent: inventory.staticIndexInventory.normalizedProjectionPresent,
      ftsTablePresent: inventory.staticIndexInventory.ftsTablePresent
    },
    searchInventory: { ...inventory.searchInventory },
    fileConsistencyInventory: { ...inventory.fileConsistencyInventory }
  }
}

function emptyM4Scales(): Record<S6M4Scale, boolean> {
  return { '1k': false, '10k': false, '50k': false }
}

function emptyM5Scales(): Record<S6M5Scale, boolean> {
  return { small: false, medium: false }
}

function allGatesPassed(result: BenchmarkResult): boolean {
  return result.gates.length > 0 && result.gates.every((gate) => gate.passed)
}

function parityGatesPassed(result: BenchmarkResult): boolean {
  const parityGates = result.gates.filter((gate) => gate.id.toLowerCase().includes('parity'))
  return parityGates.length > 0 && parityGates.every((gate) => gate.passed)
}

function metricValue(result: BenchmarkResult, id: string): number | null {
  const metric = result.metrics.find((candidate) => candidate.id === id)
  return metric === undefined ? null : metric.value
}

function m4Scale(result: BenchmarkResult): S6M4Scale | null {
  const resultRecord = result as unknown as Record<string, unknown>
  const benchmarkValue = resultRecord.benchmark
  const benchmark = isRecord(benchmarkValue) ? benchmarkValue : null
  const scale = benchmark !== null && isRecord(benchmark.scale) ? benchmark.scale : null
  const blocks = scale?.blocks
  if (blocks === 1_000) return '1k'
  if (blocks === 10_000) return '10k'
  if (blocks === 50_000) return '50k'
  return null
}

function m5Scale(result: BenchmarkResult): S6M5Scale | null {
  const resultRecord = result as unknown as Record<string, unknown>
  const benchmarkValue = resultRecord.benchmark
  const benchmark = isRecord(benchmarkValue) ? benchmarkValue : null
  const scale = benchmark !== null && isRecord(benchmark.scale) ? benchmark.scale : null
  const references = scale?.references
  if (references === 100) return 'small'
  if (references === 1_000) return 'medium'
  return null
}

function sourceBenchmarkIdMatches(source: S6EvidenceSource, result: unknown): boolean {
  if (!isRecord(result) || !isRecord(result.benchmark) || typeof result.benchmark.id !== 'string') return false
  return SOURCE_BENCHMARK_ID_PATTERNS[source].test(result.benchmark.id)
}

function isRepositoryRelativePath(value: unknown): value is string {
  return (
    isNonEmptyString(value) &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !/^[A-Za-z]:[\\/]/.test(value) &&
    !value.includes('..')
  )
}

function validateInventory(value: unknown, at = 'inventory'): string[] {
  const problems: string[] = []
  if (!isRecord(value)) return [`${at} must be an object`]

  const inventoryKeys = [
    'reviewedFiles',
    'staticIndexInventory',
    'searchInventory',
    'fileConsistencyInventory'
  ] as const
  for (const key of unknownKeys(value, inventoryKeys))
    problems.push(`${at}.${key} is not a permitted field (schema is closed)`)

  if (!Array.isArray(value.reviewedFiles)) {
    problems.push(`${at}.reviewedFiles must be an array`)
  } else if (validateDenseArray(value.reviewedFiles, `${at}.reviewedFiles`, problems)) {
    value.reviewedFiles.forEach((item, index) => {
      if (!isRepositoryRelativePath(item)) {
        problems.push(`${at}.reviewedFiles[${index}] must be a non-empty repository-relative string`)
      }
    })
  }

  const indexInventory = value.staticIndexInventory
  if (!isRecord(indexInventory)) {
    problems.push(`${at}.staticIndexInventory must be an object`)
  } else {
    for (const key of unknownKeys(indexInventory, [
      'existingIndexes',
      'normalizedProjectionPresent',
      'ftsTablePresent'
    ])) {
      problems.push(`${at}.staticIndexInventory.${key} is not a permitted field (schema is closed)`)
    }
    if (!Array.isArray(indexInventory.existingIndexes)) {
      problems.push(`${at}.staticIndexInventory.existingIndexes must be an array`)
    } else if (
      validateDenseArray(indexInventory.existingIndexes, `${at}.staticIndexInventory.existingIndexes`, problems) &&
      indexInventory.existingIndexes.some((item) => !isNonEmptyString(item) || /[\\/]/.test(item))
    ) {
      problems.push(`${at}.staticIndexInventory.existingIndexes must contain non-empty names without path segments`)
    }
    if (typeof indexInventory.normalizedProjectionPresent !== 'boolean') {
      problems.push(`${at}.staticIndexInventory.normalizedProjectionPresent must be a boolean`)
    }
    if (typeof indexInventory.ftsTablePresent !== 'boolean') {
      problems.push(`${at}.staticIndexInventory.ftsTablePresent must be a boolean`)
    }
  }

  for (const [name, keys] of [
    ['searchInventory', ['collectCandidatesPresent', 'likeCandidatesPresent', 'fetchResultsPresent']],
    ['fileConsistencyInventory', ['fileReferencesPresent', 'attachmentAvailabilityMarkerPresent']]
  ] as const) {
    const section = value[name]
    if (!isRecord(section)) {
      problems.push(`${at}.${name} must be an object`)
      continue
    }
    for (const key of unknownKeys(section, keys))
      problems.push(`${at}.${name}.${key} is not a permitted field (schema is closed)`)
    for (const key of keys)
      if (typeof section[key] !== 'boolean') problems.push(`${at}.${name}.${key} must be a boolean`)
  }

  return problems
}

function validateBenchmarkResultArrays(value: Record<string, unknown>, at: string, problems: string[]): void {
  for (const key of ['metrics', 'gates'] as const) {
    if (Array.isArray(value[key])) validateDenseArray(value[key], `${at}.${key}`, problems)
  }
}

/** Validate the closed in-memory input contract without reading external state. */
export function validateS6ReviewPreparationInput(value: unknown): string[] {
  const problems: string[] = []
  if (!isRecord(value)) return ['input must be an object']
  const forbidden = forbiddenKeys(value)
  if (forbidden.length > 0) problems.push(`input contains forbidden fields: ${forbidden.join(', ')}`)
  for (const key of unknownKeys(value, ['results', 'inventory']))
    problems.push(`input.${key} is not a permitted field (schema is closed)`)
  if (!Array.isArray(value.results)) {
    problems.push('input.results must be an array')
  } else if (validateDenseArray(value.results, 'input.results', problems)) {
    const seen = new Set<string>()
    value.results.forEach((item, index) => {
      const at = `input.results[${index}]`
      if (!isRecord(item)) {
        problems.push(`${at} must be an object`)
        return
      }
      for (const key of unknownKeys(item, ['source', 'result']))
        problems.push(`${at}.${key} is not a permitted field (schema is closed)`)
      if (!EVIDENCE_SOURCES.includes(item.source as S6EvidenceSource))
        problems.push(`${at}.source must be one of ${EVIDENCE_SOURCES.join(', ')}`)
      const resultProblems = validateBenchmarkResult(item.result)
      problems.push(...resultProblems.map((problem) => `${at}.result: ${problem}`))
      const forbidden = forbiddenKeys(item.result)
      if (forbidden.length > 0) problems.push(`${at}.result contains forbidden fields: ${forbidden.join(', ')}`)
      if (isRecord(item.result)) validateBenchmarkResultArrays(item.result, `${at}.result`, problems)
      if (
        isRecord(item.result) &&
        isDenseArray(item.result.gates) &&
        item.result.gates.some((gate) => isRecord(gate) && gate.kind === 'threshold')
      ) {
        problems.push(`${at}.result must not contain threshold gates`)
      }
      if (isRecord(item.result) && EVIDENCE_SOURCES.includes(item.source as S6EvidenceSource)) {
        const source = item.source as S6EvidenceSource
        if (!sourceBenchmarkIdMatches(source, item.result)) {
          problems.push(`${at}.result.benchmark.id is not permitted for source ${source}`)
        }
        const scale =
          source === 'm4'
            ? m4Scale(item.result as unknown as BenchmarkResult)
            : source === 'm5'
              ? m5Scale(item.result as unknown as BenchmarkResult)
              : null
        const identity = `${source}:${scale ?? 'single'}`
        if (seen.has(identity)) problems.push(`${at} duplicates evidence identity ${identity}`)
        seen.add(identity)
        if (source === 'm4' && scale === null)
          problems.push(`${at}.result must use blocks scale 1000, 10000, or 50000 for m4`)
        if (source === 'm5' && scale === null)
          problems.push(`${at}.result must use references scale 100 or 1000 for m5`)
      }
    })
  }
  problems.push(...validateInventory(value.inventory))
  return problems
}

function buildInputs(results: readonly S6ReviewEvidence[]): S6ReviewInputsSummary {
  const m4Scales = emptyM4Scales()
  const m5Scales = emptyM5Scales()
  for (const evidence of results) {
    if (evidence.source === 'm4') {
      const scale = m4Scale(evidence.result)
      if (scale !== null) m4Scales[scale] = true
    }
    if (evidence.source === 'm5') {
      const scale = m5Scale(evidence.result)
      if (scale !== null) m5Scales[scale] = true
    }
  }
  return {
    m1ArtifactPresent: results.some((evidence) => evidence.source === 'm1'),
    m2ArtifactPresent: results.some((evidence) => evidence.source === 'm2'),
    m3ArtifactPresent: results.some((evidence) => evidence.source === 'm3'),
    m4: { present: Object.values(m4Scales).some(Boolean), scales: m4Scales },
    m5: { present: Object.values(m5Scales).some(Boolean), scales: m5Scales }
  }
}

function buildEvidenceSummary(results: readonly S6ReviewEvidence[]): S6ReviewEvidenceSummary {
  const m1 = results.filter((evidence) => evidence.source === 'm1').map((evidence) => evidence.result)
  const m2 = results.filter((evidence) => evidence.source === 'm2').map((evidence) => evidence.result)
  const m3 = results.filter((evidence) => evidence.source === 'm3').map((evidence) => evidence.result)
  const m4 = results.filter((evidence) => evidence.source === 'm4').map((evidence) => evidence.result)
  const m5 = results.filter((evidence) => evidence.source === 'm5').map((evidence) => evidence.result)

  return {
    m1:
      m1.length === 0
        ? null
        : {
            paritiesPass: m1.every(parityGatesPassed),
            gatesPass: m1.every(allGatesPassed)
          },
    m2: m2.length === 0 ? null : { gatesPass: m2.every(allGatesPassed) },
    m3: m3.length === 0 ? null : { gatesPass: m3.every(allGatesPassed) },
    m4:
      m4.length === 0
        ? null
        : {
            logicalDuplicationBytes: (() => {
              const values = m4
                .map((result) => metricValue(result, 'duplication.logicalBytesUtf8'))
                .filter(isFiniteNumber)
              return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0)
            })(),
            gatesPass: m4.every(allGatesPassed)
          },
    m5:
      m5.length === 0
        ? null
        : {
            scenarios: (() => {
              const values = m5.map((result) => metricValue(result, 'scenario.count')).filter(isFiniteNumber)
              return values.length === 0 ? null : Math.max(...values)
            })(),
            gatesPass: m5.every(allGatesPassed)
          }
  }
}

/** Build a deterministic, closed, non-authorizing S6 review summary. */
export function buildS6ReviewPreparationSummary(input: S6ReviewPreparationInput): S6ReviewPreparationSummary {
  const problems = validateS6ReviewPreparationInput(input)
  if (problems.length > 0) throw new Error(`invalid S6 review-preparation input: ${problems.join('; ')}`)

  const orderedResults = [...input.results].sort((a, b) => {
    const left = `${a.source}:${a.result.benchmark.id}`
    const right = `${b.source}:${b.result.benchmark.id}`
    return left < right ? -1 : left > right ? 1 : 0
  })

  return {
    schemaVersion: S6_REVIEW_PREPARATION_SCHEMA_VERSION,
    reviewId: S6_REVIEW_PREPARATION_ID,
    inputs: buildInputs(orderedResults),
    evidenceSummary: buildEvidenceSummary(orderedResults),
    inventory: cloneInventory(input.inventory),
    gaps: {
      realCorpusMissing: true,
      physicalSizeMissing: true,
      m6EvidenceMissing: true,
      indexBenefitUnproven: true,
      fileConsistencyUnproven: true
    },
    requiredGovernance: [...S6_REQUIRED_GOVERNANCE],
    authorizationStatus: S6_AUTHORIZATION_STATUS,
    privacyAttestation: S6_PRIVACY_ATTESTATION
  }
}

/** Validate a generated summary against its exact closed output contract. */
export function validateS6ReviewPreparation(value: unknown): string[] {
  const problems: string[] = []
  if (!isRecord(value)) return ['summary must be an object']
  for (const key of unknownKeys(value, SUMMARY_KEYS))
    problems.push(`summary.${key} is not a permitted field (schema is closed)`)
  const forbidden = forbiddenKeys(value, new Set(['authorizationStatus']))
  if (forbidden.length > 0) problems.push(`summary contains forbidden fields: ${forbidden.join(', ')}`)
  if (value.schemaVersion !== S6_REVIEW_PREPARATION_SCHEMA_VERSION)
    problems.push('summary.schemaVersion must be exactly 1')
  if (value.reviewId !== S6_REVIEW_PREPARATION_ID)
    problems.push(`summary.reviewId must be '${S6_REVIEW_PREPARATION_ID}'`)
  if (value.authorizationStatus !== S6_AUTHORIZATION_STATUS)
    problems.push(`summary.authorizationStatus must be exactly '${S6_AUTHORIZATION_STATUS}'`)
  if (value.privacyAttestation !== S6_PRIVACY_ATTESTATION)
    problems.push('summary.privacyAttestation must be the fixed privacy attestation')
  if (!Array.isArray(value.requiredGovernance)) {
    problems.push('summary.requiredGovernance must contain the complete fixed governance reference set')
  } else if (!validateDenseArray(value.requiredGovernance, 'summary.requiredGovernance', problems)) {
    problems.push('summary.requiredGovernance must contain the complete fixed governance reference set')
  } else if (value.requiredGovernance.length !== S6_REQUIRED_GOVERNANCE.length) {
    problems.push('summary.requiredGovernance must contain the complete fixed governance reference set')
  } else if (JSON.stringify(value.requiredGovernance) !== JSON.stringify(S6_REQUIRED_GOVERNANCE)) {
    problems.push('summary.requiredGovernance must match the fixed governance reference set')
  }
  if (!isRecord(value.inputs)) {
    problems.push('summary.inputs must be an object')
  } else {
    for (const key of unknownKeys(value.inputs, [
      'm1ArtifactPresent',
      'm2ArtifactPresent',
      'm3ArtifactPresent',
      'm4',
      'm5'
    ])) {
      problems.push(`summary.inputs.${key} is not a permitted field (schema is closed)`)
    }
    for (const key of ['m1ArtifactPresent', 'm2ArtifactPresent', 'm3ArtifactPresent']) {
      if (typeof value.inputs[key] !== 'boolean') problems.push(`summary.inputs.${key} must be a boolean`)
    }
    for (const [name, scales] of [
      ['m4', ['1k', '10k', '50k']],
      ['m5', ['small', 'medium']]
    ] as const) {
      const section = value.inputs[name]
      if (!isRecord(section)) {
        problems.push(`summary.inputs.${name} must be an object`)
        continue
      }
      for (const key of unknownKeys(section, ['present', 'scales'])) {
        problems.push(`summary.inputs.${name}.${key} is not a permitted field (schema is closed)`)
      }
      if (typeof section.present !== 'boolean') problems.push(`summary.inputs.${name}.present must be a boolean`)
      if (!isRecord(section.scales)) {
        problems.push(`summary.inputs.${name}.scales must be an object`)
      } else {
        for (const key of unknownKeys(section.scales, scales)) {
          problems.push(`summary.inputs.${name}.scales.${key} is not a permitted field (schema is closed)`)
        }
        for (const key of scales)
          if (typeof section.scales[key] !== 'boolean')
            problems.push(`summary.inputs.${name}.scales.${key} must be a boolean`)
      }
    }
  }
  if (!isRecord(value.evidenceSummary)) {
    problems.push('summary.evidenceSummary must be an object')
  } else {
    for (const key of unknownKeys(value.evidenceSummary, ['m1', 'm2', 'm3', 'm4', 'm5'])) {
      problems.push(`summary.evidenceSummary.${key} is not a permitted field (schema is closed)`)
    }
    const evidenceSections = [
      ['m1', ['paritiesPass', 'gatesPass']],
      ['m2', ['gatesPass']],
      ['m3', ['gatesPass']],
      ['m4', ['logicalDuplicationBytes', 'gatesPass']],
      ['m5', ['scenarios', 'gatesPass']]
    ] as const
    for (const [name, keys] of evidenceSections) {
      const section = value.evidenceSummary[name]
      if (section === null) continue
      if (!isRecord(section)) {
        problems.push(`summary.evidenceSummary.${name} must be an object or null`)
        continue
      }
      for (const key of unknownKeys(section, keys)) {
        problems.push(`summary.evidenceSummary.${name}.${key} is not a permitted field (schema is closed)`)
      }
      if (name === 'm1') {
        if (typeof section.paritiesPass !== 'boolean')
          problems.push('summary.evidenceSummary.m1.paritiesPass must be a boolean')
        if (typeof section.gatesPass !== 'boolean')
          problems.push('summary.evidenceSummary.m1.gatesPass must be a boolean')
      } else if (name === 'm2' || name === 'm3') {
        if (typeof section.gatesPass !== 'boolean')
          problems.push(`summary.evidenceSummary.${name}.gatesPass must be a boolean`)
      } else {
        const numericKey = name === 'm4' ? 'logicalDuplicationBytes' : 'scenarios'
        if (section[numericKey] !== null && !isFiniteNumber(section[numericKey])) {
          problems.push(`summary.evidenceSummary.${name}.${numericKey} must be a finite number or null`)
        }
        if (typeof section.gatesPass !== 'boolean')
          problems.push(`summary.evidenceSummary.${name}.gatesPass must be a boolean`)
      }
    }
  }
  problems.push(...validateInventory(value.inventory, 'summary.inventory'))
  // Closed-schema: summary.gaps must contain exactly the five declared gap keys — reject any extra nested keys.
  if (!isRecord(value.gaps)) problems.push('summary.gaps must be an object')
  else {
    for (const key of unknownKeys(value.gaps, GAPS_KEYS)) {
      problems.push(`summary.gaps.${key} is not a permitted field (schema is closed)`)
    }
    for (const key of GAPS_KEYS) {
      if (value.gaps[key] !== true) problems.push(`summary.gaps.${key} must be true`)
    }
  }

  if (isRecord(value.inputs) && isRecord(value.evidenceSummary)) {
    for (const [inputField, evidenceField] of [
      ['m1ArtifactPresent', 'm1'],
      ['m2ArtifactPresent', 'm2'],
      ['m3ArtifactPresent', 'm3']
    ] as const) {
      const artifactPresent = value.inputs[inputField]
      const evidencePresent = value.evidenceSummary[evidenceField] !== null
      if (typeof artifactPresent === 'boolean' && artifactPresent !== evidencePresent) {
        problems.push(`summary.inputs.${inputField} must match summary.evidenceSummary.${evidenceField} presence`)
      }
    }

    for (const name of ['m4', 'm5'] as const) {
      const inputSection = value.inputs[name]
      const evidencePresent = value.evidenceSummary[name] !== null
      if (!isRecord(inputSection)) continue
      if (typeof inputSection.present === 'boolean' && inputSection.present !== evidencePresent) {
        problems.push(`summary.inputs.${name}.present must match summary.evidenceSummary.${name} presence`)
      }
      if (!isRecord(inputSection.scales)) continue
      const hasScale = Object.values(inputSection.scales).some((scale) => scale === true)
      if (typeof inputSection.present === 'boolean' && inputSection.present !== hasScale) {
        problems.push(`summary.inputs.${name}.present must match summary.inputs.${name}.scales`)
      }
    }
  }
  return problems
}

export function assertValidS6ReviewPreparation(value: unknown): asserts value is S6ReviewPreparationSummary {
  const problems = validateS6ReviewPreparation(value)
  if (problems.length > 0) throw new Error(`invalid S6 review-preparation summary: ${problems.join('; ')}`)
}
