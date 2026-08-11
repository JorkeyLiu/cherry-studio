import { loggerService } from '@logger'
import type { PluginMetadata } from '@types'
import * as crypto from 'crypto'
import * as fs from 'fs'
import matter from 'gray-matter'
import * as path from 'path'
import { parse } from 'yaml'

const logger = loggerService.withContext('Utils:MarkdownParser')

const YAML_PARSE_OPTIONS = { schema: 'failsafe' as const }

type FrontmatterContext = {
  filePath?: string
}

const isString = (value: unknown): value is string => typeof value === 'string'

function toStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.filter(isString)
  }
  if (isString(value)) {
    return value
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
  }
  return undefined
}

function toString(value: unknown): string | undefined {
  return isString(value) ? value : undefined
}

function parseLooseValue(raw: string): unknown {
  if (!raw) return ''
  try {
    const parsed = parse(raw, YAML_PARSE_OPTIONS)
    return parsed === undefined ? raw : parsed
  } catch {
    return raw
  }
}

function parseFrontmatterLoose(content: string): Record<string, unknown> {
  const lines = content.split(/\r?\n/)
  if (lines.length === 0 || lines[0].trim() !== '---') {
    return {}
  }

  let endIndex = -1
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      endIndex = i
      break
    }
  }
  if (endIndex === -1) {
    return {}
  }

  const frontmatterLines = lines.slice(1, endIndex)
  const data: Record<string, unknown> = {}
  let currentKey: string | null = null
  let buffer: string[] = []

  const flush = () => {
    if (!currentKey) return
    const rawValue = buffer.join('\n').trim()
    data[currentKey] = parseLooseValue(rawValue)
    buffer = []
    currentKey = null
  }

  for (const line of frontmatterLines) {
    const keyMatch = line.match(/^([A-Za-z0-9_-]+)\s*:(.*)$/)
    if (keyMatch) {
      flush()
      currentKey = keyMatch[1]
      const rest = keyMatch[2].trimStart()
      if (rest.length > 0) {
        data[currentKey] = parseLooseValue(rest)
        currentKey = null
      }
      continue
    }
    if (currentKey) {
      buffer.push(line)
    }
  }

  flush()
  return data
}

function recoverFrontmatter(content: string, context: FrontmatterContext): Record<string, unknown> {
  const data = parseFrontmatterLoose(content)
  logger.warn('Recovered frontmatter using loose parser', {
    ...context,
    keys: Object.keys(data)
  })
  return data
}

/**
 * Parse plugin metadata from a markdown file with frontmatter
 * @param filePath Absolute path to the markdown file
 * @param sourcePath Relative source path from plugins directory
 * @param category Category name derived from parent folder
 * @param type Plugin type (agent or command)
 * @returns PluginMetadata object with parsed frontmatter and file info
 */
export async function parsePluginMetadata(
  filePath: string,
  sourcePath: string,
  category: string,
  type: 'agent' | 'command'
): Promise<PluginMetadata> {
  const content = await fs.promises.readFile(filePath, 'utf8')
  const stats = await fs.promises.stat(filePath)

  // Parse frontmatter safely with FAILSAFE_SCHEMA to prevent deserialization attacks
  let data: Record<string, unknown> = {}
  try {
    const parsed = matter(content, {
      engines: {
        yaml: (s) => parse(s, YAML_PARSE_OPTIONS) as object
      }
    })
    data = (parsed.data ?? {}) as Record<string, unknown>
  } catch (error: any) {
    logger.warn('Failed to parse plugin frontmatter, attempting recovery', {
      filePath,
      error: error?.message || String(error)
    })
    data = recoverFrontmatter(content, { filePath })
  }

  // Calculate content hash for integrity checking
  const contentHash = crypto.createHash('sha256').update(content).digest('hex')

  // Extract filename
  const filename = path.basename(filePath)

  // Parse allowed_tools - handle both array and comma-separated string
  const allowedTools = toStringArray(data['allowed-tools'] ?? data.allowed_tools)

  // Parse tools - similar handling
  const tools = toStringArray(data.tools)

  // Parse tags
  const tags = toStringArray(data.tags)

  const name = toString(data.name) ?? filename.replace(/\.md$/, '')
  const description = toString(data.description)
  const version = toString(data.version)
  const author = toString(data.author)

  return {
    sourcePath,
    filename,
    name,
    description,
    allowed_tools: allowedTools,
    tools,
    category,
    type,
    tags,
    version,
    author,
    size: stats.size,
    contentHash
  }
}
