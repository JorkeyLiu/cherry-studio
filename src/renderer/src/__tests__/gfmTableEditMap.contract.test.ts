/**
 * Contract for the patched `micromark-extension-gfm-table` edit map.
 *
 * The patch replaces the linear scan in `EditMap.add` (one scan of every
 * already-registered change for each new edit) with a position index that
 * keeps the same change tuples. Registration order, same-position merging,
 * `consume` ordering and the clear-on-consume lifecycle are therefore the
 * behaviour that must not change.
 *
 * Two layers of evidence, both against the REAL installed artifacts (no mocks):
 *
 * 1. `EditMap` itself: loaded by absolute path from the installed patched
 *    package for both resolution builds (`lib` and `development`), because the
 *    class is internal and not part of the package's exported surface.
 * 2. The real `remark-parse` + `remark-gfm` pipeline, asserting the business
 *    results the edit map produces for tables: independent tables in one
 *    document, alignment and empty cells, escaped pipes and code spans,
 *    footnotes referenced from cells, delimiter requirements, streaming
 *    prefixes, and a many-table document.
 *
 * No timing thresholds and no giant snapshots: every assertion is a derived
 * structural fact.
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { describe, expect, it } from 'vitest'

interface MdNode {
  type: string
  value?: string
  align?: Array<'left' | 'right' | 'center' | null>
  identifier?: string
  children?: MdNode[]
  position?: { start: Position; end: Position }
}

interface Position {
  line: number
  column: number
  offset: number
}

interface ParsedTable {
  align: Array<'left' | 'right' | 'center' | null> | undefined
  header: string[]
  rows: string[][]
  start: Position
  end: Position
}

type Event = [string, Record<string, unknown>, unknown]
type Change = [number, number, Array<Event>]

interface EditMapLike {
  map: Array<Change>
  add(index: number, remove: number, add: Array<Event>): void
  consume(events: Array<Event>): void
}

type EditMapConstructor = new () => EditMapLike

// `micromark-extension-gfm-table` is transitive (remark-gfm →
// micromark-extension-gfm → micromark-extension-gfm-table), so bare deep
// imports do not resolve from source: anchor resolution at its direct
// dependent and load the installed file by absolute path.
const sourceRequire = createRequire(import.meta.url)
const gfmRequire = createRequire(sourceRequire.resolve('remark-gfm'))
const extGfmRequire = createRequire(gfmRequire.resolve('micromark-extension-gfm'))
// The package exposes a `development` resolution condition, so the resolved
// entry point may live under `dev/`: walk up to the package root instead of
// assuming a fixed layout.
const findPackageRoot = (entryFile: string): string => {
  let dir = dirname(entryFile)
  while (!existsSync(join(dir, 'package.json'))) {
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`no package.json above ${entryFile}`)
    dir = parent
  }
  return dir
}
const tablePackageDir = findPackageRoot(extGfmRequire.resolve('micromark-extension-gfm-table'))

const EDIT_MAP_BUILDS = [
  { name: 'lib', file: join(tablePackageDir, 'lib', 'edit-map.js') },
  { name: 'development', file: join(tablePackageDir, 'dev', 'lib', 'edit-map.js') }
]

const editMaps = await Promise.all(
  EDIT_MAP_BUILDS.map(async (build) => {
    // Absolute path import: the runner executes the installed file as-is.
    const mod = (await import(build.file)) as unknown as { EditMap: EditMapConstructor }
    return { name: build.name, EditMap: mod.EditMap }
  })
)

const tagEvent = (tag: string): Event => ['enter', { type: 'text', tag }, undefined]
const tagsOf = (events: Array<Event>): string[] => events.map((event) => (event[1] as { tag: string }).tag)

const parseDocument = (markdown: string): MdNode =>
  unified().use(remarkParse).use(remarkGfm).parse(markdown) as unknown as MdNode

const textOf = (node: MdNode): string => {
  if (node.type === 'text' || node.type === 'inlineCode') {
    return node.value ?? ''
  }
  return (node.children ?? []).map(textOf).join('')
}

const collectTables = (node: MdNode, found: ParsedTable[] = []): ParsedTable[] => {
  if (node.type === 'table' && node.position) {
    const rows = node.children ?? []
    found.push({
      align: node.align,
      header: (rows[0]?.children ?? []).map(textOf),
      rows: rows.slice(1).map((row) => (row.children ?? []).map(textOf)),
      start: node.position.start,
      end: node.position.end
    })
  }
  for (const child of node.children ?? []) collectTables(child, found)
  return found
}

const walkNodes = (node: MdNode, visit: (node: MdNode) => void): void => {
  visit(node)
  for (const child of node.children ?? []) walkNodes(child, visit)
}

describe.each(editMaps)('gfm table EditMap contract [$name build]', ({ EditMap }) => {
  it('merges repeated edits at the same position in registration order', () => {
    const map = new EditMap()
    map.add(3, 1, [tagEvent('a')])
    map.add(3, 2, [tagEvent('b'), tagEvent('c')])
    map.add(7, 0, [tagEvent('d')])
    map.add(1, 0, []) // nothing removed and nothing added: not registered

    expect(map.map.length).toBe(2)
    expect(map.map[0][0]).toBe(3)
    expect(map.map[0][1]).toBe(3)
    expect(tagsOf(map.map[0][2])).toEqual(['a', 'b', 'c'])
    expect(tagsOf(map.map[1][2])).toEqual(['d'])
    // Registration order is preserved until `consume` sorts by position.
    expect([map.map[0][0], map.map[1][0]]).toEqual([3, 7])
  })

  it('splices events in position order and clears the change list', () => {
    const map = new EditMap()
    map.add(3, 3, [tagEvent('a'), tagEvent('b'), tagEvent('c')])
    map.add(7, 0, [tagEvent('d'), tagEvent('e')])

    const events = Array.from({ length: 12 }, (_, index) => tagEvent(`e${index}`))
    map.consume(events)

    expect(tagsOf(events)).toEqual(['e0', 'e1', 'e2', 'a', 'b', 'c', 'e6', 'd', 'e', 'e7', 'e8', 'e9', 'e10', 'e11'])
    expect(map.map.length).toBe(0)
  })

  it('accepts a second batch after consume without stale positions', () => {
    const map = new EditMap()
    map.add(2, 0, [tagEvent('first')])
    const firstBatch = Array.from({ length: 4 }, (_, index) => tagEvent(`e${index}`))
    map.consume(firstBatch)
    expect(tagsOf(firstBatch)).toEqual(['e0', 'e1', 'first', 'e2', 'e3'])

    // Same position as a previous batch: must register anew, not merge into it.
    map.add(2, 0, [tagEvent('second')])
    map.add(2, 0, [tagEvent('third')])
    const secondBatch = Array.from({ length: 4 }, (_, index) => tagEvent(`f${index}`))
    map.consume(secondBatch)
    expect(map.map.length).toBe(0)
    expect(tagsOf(secondBatch)).toEqual(['f0', 'f1', 'second', 'third', 'f2', 'f3'])
  })

  it('indexes every live change tuple and clears the index with the change list', () => {
    // Patch-integrity guard: the index is the whole point of the patch, so a
    // silently unpatched install tree must not look healthy here.
    const map = new EditMap()
    const index = (map as unknown as { mapByAt?: Map<number, Change> }).mapByAt
    expect(index).toBeInstanceOf(Map)

    map.add(0, 0, [tagEvent('a')])
    map.add(4, 0, [tagEvent('b')])
    map.add(4, 0, [tagEvent('c')])
    expect(index?.size).toBe(map.map.length)
    expect(index?.get(4)).toBe(map.map[1])

    map.consume([tagEvent('x'), tagEvent('y'), tagEvent('z'), tagEvent('w'), tagEvent('v')])
    expect(map.map.length).toBe(0)
    expect(index?.size).toBe(0)
  })
})

describe('real remark-gfm pipeline table results', () => {
  it('keeps independent tables independent within one document', () => {
    const doc = [
      '| a1 | a2 |',
      '| :-- | --: |',
      '| 1 | 2 |',
      '',
      'middle paragraph',
      '',
      '> | q1 | q2 |',
      '> | --- | --- |',
      '> | 8 | 9 |'
    ].join('\n')

    const tables = collectTables(parseDocument(doc))
    expect(tables).toHaveLength(2)

    // Document order, plain table first.
    expect(tables[0].align).toEqual(['left', 'right'])
    expect(tables[0].header).toEqual(['a1', 'a2'])
    expect(tables[0].rows).toEqual([['1', '2']])
    expect(tables[1].header).toEqual(['q1', 'q2'])
    expect(tables[1].rows).toEqual([['8', '9']])

    // The quoted table keeps its own (container-relative) source positions.
    expect(tables[0].end.offset).toBeLessThan(tables[1].start.offset)
    expect(tables[1].start.line).toBe(7)
  })

  it('preserves alignment columns and empty cells', () => {
    const doc = ['|  |  |', '| --- | :-: |', '|  | x |', '| y |  |'].join('\n')

    const [table] = collectTables(parseDocument(doc))
    expect(table.align).toEqual([null, 'center'])
    expect(table.header).toEqual(['', ''])
    expect(table.rows).toEqual([
      ['', 'x'],
      ['y', '']
    ])
  })

  it('keeps an escaped pipe inside its cell and treats an unescaped code-span pipe as a divider', () => {
    const escaped = ['| a | `c \\| d` |', '| --- | --- |', '| 1 | 2 |'].join('\n')
    const [table] = collectTables(parseDocument(escaped))
    expect(table.header).toEqual(['a', 'c | d'])
    expect(table.rows).toEqual([['1', '2']])

    // An unescaped pipe inside a code span widens the header row, so the
    // delimiter row no longer matches and the construct is not a table.
    const raw = ['| a | `c | d` |', '| --- | --- |', '| 1 | 2 |'].join('\n')
    expect(collectTables(parseDocument(raw))).toHaveLength(0)
    expect(parseDocument(raw).children?.[0]?.type).toBe('paragraph')
  })

  it('keeps footnote references inside table cells resolvable to their definitions', () => {
    const doc = [
      'Intro.[^1]',
      '',
      '| ref | text |',
      '| --- | --- |',
      '| [^2] | note[^1] |',
      '',
      '[^1]: First definition.',
      '',
      '[^2]: Second definition.',
      ''
    ].join('\n')

    const tree = parseDocument(doc)
    const [table] = collectTables(tree)
    expect(table.header).toEqual(['ref', 'text'])
    expect(table.rows).toEqual([['', 'note']])

    const references: string[] = []
    walkNodes(tree, (node) => {
      if (node.type === 'footnoteReference') references.push(node.identifier ?? '')
    })
    expect(references).toEqual(['1', '2', '1'])

    const definitions: Array<{ identifier?: string; start?: Position }> = []
    walkNodes(tree, (node) => {
      if (node.type === 'footnoteDefinition')
        definitions.push({ identifier: node.identifier, start: node.position?.start })
    })
    expect(definitions.map((definition) => definition.identifier)).toEqual(['1', '2'])
    // Definitions live after the tables and keep their own source positions.
    for (const definition of definitions) {
      expect(definition.start?.line).toBeGreaterThan(table.end.line)
    }
  })

  it('requires the delimiter row and accepts a header-only table', () => {
    const headerOnly = '| h1 | h2 |\n| --- | --- |'
    const noDelimiter = '| h1 | h2 |\n| --'

    const [table] = collectTables(parseDocument(headerOnly))
    expect(table.header).toEqual(['h1', 'h2'])
    expect(table.rows).toEqual([])
    expect(table.end.line).toBe(2)

    expect(collectTables(parseDocument(noDelimiter))).toHaveLength(0)
    expect(parseDocument(noDelimiter).children?.[0]?.type).toBe('paragraph')
  })

  it('parses streaming prefixes without changing completed cells', () => {
    const complete = '| h1 | h2 |\n| --- | --- |\n| a | b |'
    const prefixes = [
      { input: '| h1 | h2 |', tables: 0, rows: [] as string[][] },
      { input: '| h1 | h2 |\n| --- |', tables: 0, rows: [] as string[][] },
      { input: '| h1 | h2 |\n| --- | --- |', tables: 1, rows: [] as string[][] },
      { input: '| h1 | h2 |\n| --- | --- |\n| a |', tables: 1, rows: [['a']] },
      { input: complete, tables: 1, rows: [['a', 'b']] }
    ]

    for (const prefix of prefixes) {
      const tables = collectTables(parseDocument(prefix.input))
      expect(tables).toHaveLength(prefix.tables)
      if (prefix.tables === 1) {
        expect(tables[0].header).toEqual(['h1', 'h2'])
        expect(tables[0].rows).toEqual(prefix.rows)
      }
    }
    expect(collectTables(parseDocument(complete))).toHaveLength(1)
  })

  it('keeps every table of a many-table document structurally intact', () => {
    const tableCount = 40
    const doc = Array.from({ length: tableCount }, (_, index) => {
      const alignment = ['---', ':--', '--:', ':-:'][index % 4]
      return [
        `| t${index}-a | t${index}-b |`,
        `| ${alignment} | ${alignment} |`,
        `| r${index}-a |  |`,
        `|  | r${index}-b |`,
        ''
      ].join('\n')
    }).join('\n')

    const tables = collectTables(parseDocument(doc))
    expect(tables).toHaveLength(tableCount)
    for (let index = 0; index < tableCount; index += 1) {
      const table = tables[index]
      expect(table.header).toEqual([`t${index}-a`, `t${index}-b`])
      expect(table.rows).toEqual([
        [`r${index}-a`, ''],
        ['', `r${index}-b`]
      ])
      if (index > 0) {
        expect(table.start.offset).toBeGreaterThan(tables[index - 1].end.offset)
      }
    }
  })
})
