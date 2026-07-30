/**
 * In-process mock OpenAI-compatible endpoint for E2E testing.
 *
 * LOCK-003: Returns deterministic completions without any paid API dependency.
 * Conforms to the OpenAI chat completions streaming format consumed by
 * the repository's AI SDK provider path (@ai-sdk/openai-compatible).
 *
 * Request validation: logs method, URL, parsed body shape, and asserts
 * the body contains the expected `model` and `messages` array.
 */
import * as http from 'http'

import { createMonotonicRequestLog } from '../../../src/main/test-utils/monotonicRequestLog'

export interface MockServerPort {
  port: number
}

export interface MockRequestEntry {
  method: string
  url: string
  body: string
  parsed: Record<string, unknown> | null
  timestamp: number
  /** Monotonically increasing sequence number for operation-specific matching. */
  sequence: number
}

const requestLog = createMonotonicRequestLog<Omit<MockRequestEntry, 'sequence'>>()

export function getRequestLog(): MockRequestEntry[] {
  return requestLog.getEntries()
}

export function clearRequestLog(): void {
  requestLog.clear()
  // LOCK-003: Do NOT reset requestSequence — sequences remain monotonic
  // across clears so findProductRequestAfter(capturedSeq) always works.
}

/**
 * Returns the first product-originated chat completion request (POST /v1/chat/completions
 * or POST /chat/completions) or null if none was received.
 */
export function findProductRequest(): MockRequestEntry | null {
  return (
    requestLog
      .getEntries()
      .find(
        (entry) =>
          entry.method === 'POST' && (entry.url === '/v1/chat/completions' || entry.url === '/chat/completions')
      ) ?? null
  )
}

/**
 * Returns the first product-originated chat completion request with sequence >= afterSequence.
 * The caller captures the current counter before an operation, and the first new request
 * receives that exact counter value because request entries use post-increment semantics.
 */
export function findProductRequestAfter(afterSequence: number): MockRequestEntry | null {
  return (
    requestLog
      .getEntries()
      .find(
        (entry) =>
          entry.method === 'POST' &&
          (entry.url === '/v1/chat/completions' || entry.url === '/chat/completions') &&
          entry.sequence >= afterSequence
      ) ?? null
  )
}

/**
 * Returns the current request sequence counter (for capturing before an operation).
 */
export function getRequestSequence(): number {
  return requestLog.getSequence()
}

function buildChatCompletion(body: Record<string, unknown>) {
  const messages = body.messages as Array<{ role: string; content: string }> | undefined
  // Use the LAST user message (the current turn), not the first (historical context)
  const userMsg = messages?.filter((m) => m.role === 'user').pop()
  const content = userMsg?.content || 'hello'
  const model = (body.model as string) || 'mock-model'

  const reply = `[Mock ${model}] You said: "${String(content).slice(0, 100)}"`

  return {
    id: `chatcmpl-mock-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: reply
        },
        finish_reason: 'stop'
      }
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30
    }
  }
}

function buildChatCompletionChunks(body: Record<string, unknown>) {
  const messages = body.messages as Array<{ role: string; content: string }> | undefined
  // Use the LAST user message (the current turn), not the first (historical context)
  const userMsg = messages?.filter((m) => m.role === 'user').pop()
  const content = userMsg?.content || 'hello'
  const model = (body.model as string) || 'mock-model'
  const reply = `[Mock ${model}] You said: "${String(content).slice(0, 100)}"`
  const id = `chatcmpl-mock-${Date.now()}`
  const created = Math.floor(Date.now() / 1000)

  const chunks: Array<Record<string, unknown>> = []
  const words = reply.split(' ')

  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    const isLast = i === words.length - 1
    const token = isLast ? word : word + ' '

    chunks.push({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [
        {
          index: 0,
          delta: i === 0 ? { role: 'assistant', content: token } : { content: token },
          finish_reason: null
        }
      ]
    })
  }

  // Final chunk with stop reason (no content delta)
  chunks.push({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: 'stop'
      }
    ]
  })

  return { id, chunks }
}

function createMockServer(): Promise<MockServerPort> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk.toString()
      })
      req.on('end', () => {
        const url = req.url || ''
        const method = req.method || 'GET'

        let parsed: Record<string, unknown> | null = null
        try {
          parsed = JSON.parse(body) as Record<string, unknown>
        } catch {
          // Not JSON or empty body
        }

        requestLog.append({ method, url, body, parsed, timestamp: Date.now() })

        // Health check / model listing
        if (url === '/v1/models' || url === '/models' || url === '/health' || url === '/') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              data: [{ id: 'mock-model', object: 'model', owned_by: 'mock' }]
            })
          )
          return
        }

        // Chat completions — both streaming and non-streaming
        if (url === '/v1/chat/completions' || url === '/chat/completions') {
          if (!parsed) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: { message: 'Invalid JSON', type: 'invalid_request_error' } }))
            return
          }

          // Validate request shape
          const messages = parsed.messages
          if (!Array.isArray(messages) || messages.length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(
              JSON.stringify({
                error: { message: 'messages array is required', type: 'invalid_request_error' }
              })
            )
            return
          }

          const hasUserMessage = messages.some(
            (m: Record<string, unknown>) => m.role === 'user' && typeof m.content === 'string'
          )
          if (!hasUserMessage) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(
              JSON.stringify({
                error: {
                  message: 'At least one user message with content is required',
                  type: 'invalid_request_error'
                }
              })
            )
            return
          }

          if (parsed.stream) {
            // Streaming SSE response
            const { chunks } = buildChatCompletionChunks(parsed)
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive'
            })

            for (const chunk of chunks) {
              res.write(`data: ${JSON.stringify(chunk)}\n\n`)
            }
            res.write('data: [DONE]\n\n')
            res.end()
          } else {
            // Non-streaming JSON response
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(buildChatCompletion(parsed)))
          }
          return
        }

        // Default 404
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Not found', type: 'invalid_request_error' } }))
      })
    })

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (typeof addr === 'object' && addr !== null) {
        resolve({ port: addr.port })
      } else {
        reject(new Error('Failed to get server address'))
      }
    })

    // Keep reference for cleanup
    ;(globalThis as any).__mockOpenAIServer = server
  })
}

export function stopMockServer(): void {
  const server = (globalThis as any).__mockOpenAIServer
  if (server) {
    server.close()
    ;(globalThis as any).__mockOpenAIServer = null
  }
}

export { createMockServer }
