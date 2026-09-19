import { beforeEach, describe, expect, it, vi } from 'vitest'

// i18n mocked to echo the key: factories must pass the exact translation key
// plus interpolation context; the English fallback then carries the values.
vi.mock('@renderer/i18n', () => ({
  default: { t: vi.fn((key: string) => key) }
}))

import i18n from '@renderer/i18n'

import {
  ATTACHMENT_ERROR_NAME,
  attachmentEncodeUnsupportedError,
  attachmentFailedError,
  attachmentImageUrlError,
  attachmentTextExtractionError,
  isAttachmentError,
  webSearchEndpointError
} from '../attachmentErrors'

const t = vi.mocked(i18n.t)

describe('attachmentErrors translation keys and interpolation', () => {
  beforeEach(() => {
    t.mockClear()
    t.mockImplementation(((key: string) => key) as never)
  })

  it('attachmentFailedError uses attach_failed with name/type/reason', () => {
    const error = attachmentFailedError('doc.pdf', 'document', 'ENOENT')
    expect(error.name).toBe(ATTACHMENT_ERROR_NAME)
    expect(isAttachmentError(error)).toBe(true)
    expect(t).toHaveBeenCalledWith('message.error.attachment.attach_failed', {
      name: 'doc.pdf',
      type: 'document',
      reason: 'ENOENT'
    })
    expect(error.message).toContain('doc.pdf')
    expect(error.message).toContain('document')
    expect(error.message).toContain('ENOENT')
  })

  it('attachmentEncodeUnsupportedError uses encode_unsupported with name/type', () => {
    const error = attachmentEncodeUnsupportedError('a.bin', 'other')
    expect(t).toHaveBeenCalledWith('message.error.attachment.encode_unsupported', { name: 'a.bin', type: 'other' })
    expect(error.message).toContain('a.bin')
  })

  it('attachmentTextExtractionError uses text_extraction_failed with name/type/reason', () => {
    const error = attachmentTextExtractionError('a.docx', 'document', 'parse failed')
    expect(t).toHaveBeenCalledWith('message.error.attachment.text_extraction_failed', {
      name: 'a.docx',
      type: 'document',
      reason: 'parse failed'
    })
    expect(error.message).toContain('a.docx')
    expect(error.message).toContain('parse failed')
  })

  it('attachmentImageUrlError uses image_url_failed with reason', () => {
    const error = attachmentImageUrlError('malformed or non-base64 data URL')
    expect(t).toHaveBeenCalledWith('message.error.attachment.image_url_failed', {
      reason: 'malformed or non-base64 data URL'
    })
    expect(error.message).toContain('malformed or non-base64 data URL')
  })

  it('webSearchEndpointError uses web_search_unsupported with endpoint', () => {
    const error = webSearchEndpointError('openai-compatible')
    expect(t).toHaveBeenCalledWith('message.error.endpoint.web_search_unsupported', { endpoint: 'openai-compatible' })
    expect(error.message).toContain('openai-compatible')
  })

  it('isAttachmentError rejects plain errors', () => {
    expect(isAttachmentError(new Error('Failed to attach'))).toBe(false)
    expect(isAttachmentError(undefined)).toBe(false)
    expect(isAttachmentError(null)).toBe(false)
  })
})
