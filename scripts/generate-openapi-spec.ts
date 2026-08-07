import { fileURLToPath } from 'node:url'

import * as fs from 'fs'
import * as path from 'path'
import swaggerJSDoc from 'swagger-jsdoc'

import { type AppIdentity, appIdentity } from '../packages/shared/config/identity'

const CURRENT_FILE = fileURLToPath(import.meta.url)
const ROOT_DIR = path.resolve(path.dirname(CURRENT_FILE), '..')
const OUTPUT_DIR = path.resolve(ROOT_DIR, 'src/main/apiServer/generated')
const OUTPUT_FILE = path.resolve(OUTPUT_DIR, 'openapi-spec.json')

/**
 * Build the swagger-jsdoc options for a given application identity.
 *
 * Every identity-owned string (info title/description, contact name, bearer
 * auth hint) comes from the resolved `AppIdentity`, so the generated spec
 * carries Cherry Chat metadata only (LOCK-RETIRE-001).
 */
export function buildSwaggerOptions(identity: AppIdentity): swaggerJSDoc.Options {
  return {
    definition: {
      openapi: '3.0.0',
      info: {
        title: identity.apiTitle,
        version: '1.0.0',
        description: `OpenAI-compatible API for ${identity.productName} with additional Cherry-specific endpoints`,
        contact: {
          name: identity.productName,
          url: 'https://github.com/CherryHQ/cherry-studio'
        }
      },
      servers: [
        {
          url: '/',
          description: 'Current server'
        }
      ],
      components: {
        securitySchemes: {
          BearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description: `Use the API key from ${identity.productName} settings`
          }
        },
        schemas: {
          Error: {
            type: 'object',
            properties: {
              error: {
                type: 'object',
                properties: {
                  message: { type: 'string' },
                  type: { type: 'string' },
                  code: { type: 'string' }
                }
              }
            }
          },
          ChatMessage: {
            type: 'object',
            properties: {
              role: {
                type: 'string',
                enum: ['system', 'user', 'assistant', 'tool']
              },
              content: {
                oneOf: [
                  { type: 'string' },
                  {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        type: { type: 'string' },
                        text: { type: 'string' },
                        image_url: {
                          type: 'object',
                          properties: {
                            url: { type: 'string' }
                          }
                        }
                      }
                    }
                  }
                ]
              },
              name: { type: 'string' },
              tool_calls: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    type: { type: 'string' },
                    function: {
                      type: 'object',
                      properties: {
                        name: { type: 'string' },
                        arguments: { type: 'string' }
                      }
                    }
                  }
                }
              }
            }
          },
          ChatCompletionRequest: {
            type: 'object',
            required: ['model', 'messages'],
            properties: {
              model: {
                type: 'string',
                description: 'The model to use for completion, in format provider:model-id'
              },
              messages: {
                type: 'array',
                items: { $ref: '#/components/schemas/ChatMessage' }
              },
              temperature: {
                type: 'number',
                minimum: 0,
                maximum: 2,
                default: 1
              },
              max_tokens: {
                type: 'integer',
                minimum: 1
              },
              stream: {
                type: 'boolean',
                default: false
              },
              tools: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    type: { type: 'string' },
                    function: {
                      type: 'object',
                      properties: {
                        name: { type: 'string' },
                        description: { type: 'string' },
                        parameters: { type: 'object' }
                      }
                    }
                  }
                }
              }
            }
          },
          Model: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              object: { type: 'string', enum: ['model'] },
              created: { type: 'integer' },
              owned_by: { type: 'string' }
            }
          },
          MCPServer: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              command: { type: 'string' },
              args: {
                type: 'array',
                items: { type: 'string' }
              },
              env: { type: 'object' },
              disabled: { type: 'boolean' }
            }
          }
        }
      },
      security: [
        {
          BearerAuth: []
        }
      ]
    },
    apis: [
      path.resolve(ROOT_DIR, 'src/main/apiServer/routes/**/*.ts'),
      path.resolve(ROOT_DIR, 'src/main/apiServer/app.ts')
    ]
  }
}

/**
 * Generate the OpenAPI spec JSON for an application identity.
 *
 * swagger-jsdoc only parses local source files, so this never touches the
 * network — the focused tests rely on that.
 */
export function generate(identity: AppIdentity): string {
  const spec = swaggerJSDoc(buildSwaggerOptions(identity)) as Record<string, any>

  // The `/` root endpoint (src/main/apiServer/app.ts) serves `name` from
  // `appIdentity.apiTitle` at runtime, but its JSDoc example is a static
  // literal. Align the documented example with the identity so the spec does
  // not leak any other product name into packaged API documentation.
  const rootNameSchema =
    spec.paths?.['/']?.get?.responses?.['200']?.content?.['application/json']?.schema?.properties?.name
  if (rootNameSchema != null) {
    rootNameSchema.example = identity.apiTitle
  }

  return JSON.stringify(spec, null, 2) + '\n'
}

/**
 * Resolve the identity the generated spec must carry.
 *
 * This script runs under plain Node/tsx (never through a Vite build). Cherry
 * Chat is the single application identity, so the spec always carries the
 * immutable {@link appIdentity} — there is no flavor selection anymore
 * (LOCK-RETIRE-002).
 */
export function resolveSpecIdentity(): AppIdentity {
  return appIdentity
}

function check(content: string): void {
  if (!fs.existsSync(OUTPUT_FILE)) {
    console.error(`openapi:check failed — ${OUTPUT_FILE} does not exist (run pnpm generate:openapi)`)
    process.exit(1)
  }

  const existing = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf-8'))
  const generated = JSON.parse(content)
  if (JSON.stringify(existing) !== JSON.stringify(generated)) {
    console.error('openapi:check failed — openapi-spec.json is out of date (run pnpm generate:openapi)')
    process.exit(1)
  }

  console.log('openapi:check passed')
}

function write(content: string): void {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true })
  }

  fs.writeFileSync(OUTPUT_FILE, content, 'utf-8')

  const spec = JSON.parse(content)
  const paths: string[] = spec.paths ? Object.keys(spec.paths) : []
  console.log(`OpenAPI spec generated: ${OUTPUT_FILE}`)
  console.log(`  Paths: ${paths.length}`)
  for (const p of paths) {
    const methods = Object.keys(spec.paths[p]).join(', ').toUpperCase()
    console.log(`    ${methods} ${p}`)
  }
}

// Run as a CLI entry point only. When imported from the focused Vitest tests,
// `process.argv[1]` is the Vitest runner, not this file, so nothing is written
// or checked at import time.
const isMainScript = process.argv[1] != null && path.resolve(process.argv[1]) === CURRENT_FILE

if (isMainScript) {
  const isCheck = process.argv.includes('--check')
  const content = generate(resolveSpecIdentity())

  if (isCheck) {
    check(content)
  } else {
    write(content)
  }
}
