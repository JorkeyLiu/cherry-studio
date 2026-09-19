import i18n from '@renderer/i18n'

function interpolate(template: string, params: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => params[key] ?? `{{${key}}}`)
}

function localized(key: string, params: Record<string, string>, fallback: string): string {
  const translated = i18n.t(key, params as never) as unknown as string
  if (typeof translated !== 'string' || translated === key) {
    return interpolate(fallback, params)
  }
  return translated
}

export const ATTACHMENT_ERROR_NAME = 'AttachmentError'

function mark(error: Error): Error {
  error.name = ATTACHMENT_ERROR_NAME
  return error
}

export function isAttachmentError(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { name?: unknown }).name === ATTACHMENT_ERROR_NAME
}

/**
 * Local attachment/endpoint errors. Every message carries filename/media-type
 * or endpoint context via i18n interpolation; the English fallback keeps the
 * same template so unit tests and early-startup (i18n not yet initialized)
 * still carry context instead of a bare key. No console usage.
 */
export function attachmentFailedError(name: string, type: string, reason: string): Error {
  const params = { name, type, reason }
  return mark(
    new Error(
      localized('message.error.attachment.attach_failed', params, 'Failed to attach "{{name}}" ({{type}}): {{reason}}')
    )
  )
}

export function attachmentEncodeUnsupportedError(name: string, type: string): Error {
  const params = { name, type }
  return mark(
    new Error(
      localized(
        'message.error.attachment.encode_unsupported',
        params,
        'Failed to attach "{{name}}" ({{type}}): the current endpoint cannot encode this format'
      )
    )
  )
}

export function attachmentTextExtractionError(name: string, type: string, reason: string): Error {
  const params = { name, type, reason }
  return mark(
    new Error(
      localized(
        'message.error.attachment.text_extraction_failed',
        params,
        'Failed to extract text from attachment "{{name}}" ({{type}}): {{reason}}'
      )
    )
  )
}

export function attachmentImageUrlError(reason: string): Error {
  const params = { reason }
  return mark(
    new Error(
      localized('message.error.attachment.image_url_failed', params, 'Failed to attach image (url): {{reason}}')
    )
  )
}

export function webSearchEndpointError(endpoint: string): Error {
  const params = { endpoint }
  return mark(
    new Error(
      localized(
        'message.error.endpoint.web_search_unsupported',
        params,
        'Web search cannot be encoded on the {{endpoint}} endpoint: no explicit search adapter for the current provider'
      )
    )
  )
}
