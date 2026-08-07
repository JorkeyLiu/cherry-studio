import { loggerService } from '@logger'
import { convertSpanToSpanEntity, FunctionSpanExporter, FunctionSpanProcessor } from '@mcp-trace/trace-core'
import { WebTracer } from '@mcp-trace/trace-web'
import { trace } from '@opentelemetry/api'
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'
import { appIdentity } from '@shared/config/identity'

const logger = loggerService.withContext('WebTraceService')

// Internal telemetry identity — flavor-aware product token (IDENTITY-002).
const TRACER_NAME = appIdentity.userAgentProduct

class WebTraceService {
  init() {
    const exporter = new FunctionSpanExporter((spans: ReadableSpan[]): Promise<void> => {
      // Implement your save logic here if needed
      // For now, just resolve immediately
      logger.info(`Saving spans: ${spans.length}`)
      return Promise.resolve()
    })

    const processor = new FunctionSpanProcessor(
      exporter,
      (span: ReadableSpan) => {
        void window.api.trace.saveEntity(convertSpanToSpanEntity(span))
      },
      (span: ReadableSpan) => {
        void window.api.trace.saveEntity(convertSpanToSpanEntity(span))
      }
    )
    WebTracer.init(
      {
        defaultTracerName: TRACER_NAME,
        serviceName: TRACER_NAME
      },
      processor
    )
  }

  getTracer() {
    return trace.getTracer(TRACER_NAME, '1.0.0')
  }
}

export const webTraceService = new WebTraceService()
