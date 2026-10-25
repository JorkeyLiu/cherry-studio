import { BaseEmbeddings } from '@cherrystudio/embedjs-interfaces'
import { VoyageEmbeddings as _VoyageEmbeddings } from '@langchain/community/embeddings/voyage'

/**
 * 支持设置嵌入维度的模型
 */
export class VoyageEmbeddings extends BaseEmbeddings {
  private model: _VoyageEmbeddings
  constructor(
    private readonly configuration?: ConstructorParameters<typeof _VoyageEmbeddings>[0] & {
      headers?: Record<string, string>
    }
  ) {
    super()
    if (!this.configuration) {
      throw new Error('Invalid configuration')
    }
    if (!this.configuration.modelName) this.configuration.modelName = 'voyage-3'

    this.model = new _VoyageEmbeddings(this.configuration)
    // Upstream langchain VoyageEmbeddings declares `headers` but its
    // constructor never assigns it, so constructor-passed custom headers
    // would otherwise be silently dropped. Assign explicitly so forwarded
    // provider custom headers actually reach the wire (`...this.headers` in
    // `embeddingWithRetry`). No transport replacement: the SDK's own fetch
    // path is unchanged.
    const forwardedHeaders = (this.configuration as { headers?: Record<string, string> }).headers
    if (forwardedHeaders) {
      ;(this.model as unknown as { headers?: Record<string, string> }).headers = { ...forwardedHeaders }
    }
  }
  override async getDimensions(): Promise<number> {
    return this.configuration?.outputDimension ?? (this.configuration?.modelName === 'voyage-code-2' ? 1536 : 1024)
  }

  override async embedDocuments(texts: string[]): Promise<number[][]> {
    try {
      return this.model.embedDocuments(texts)
    } catch (error) {
      throw new Error('Embedding documents failed - you may have hit the rate limit or there is an internal error', {
        cause: error
      })
    }
  }

  override async embedQuery(text: string): Promise<number[]> {
    return this.model.embedQuery(text)
  }
}
