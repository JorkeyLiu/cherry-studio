export type AsyncInitializerStatus = 'idle' | 'pending' | 'fulfilled' | 'rejected'

export class AsyncInitializer<T> {
  private promise: Promise<T> | null = null
  private status: AsyncInitializerStatus = 'idle'
  private factory: (...args: any[]) => Promise<T>

  constructor(factory: (...args: any[]) => Promise<T>) {
    this.factory = factory
  }

  async get(...args: any[]): Promise<T> {
    if (!this.promise) {
      this.status = 'pending'
      this.promise = this.factory(...args).then(
        (value) => {
          this.status = 'fulfilled'
          return value
        },
        (error) => {
          this.status = 'rejected'
          throw error
        }
      )
    }
    return this.promise
  }

  getStatus(): AsyncInitializerStatus {
    return this.status
  }

  isPending(): boolean {
    return this.status === 'pending'
  }

  /**
   * Clear cached rejection so next get() can retry.
   * Only succeeds when status is 'rejected'.
   */
  resetIfRejected(): boolean {
    if (this.status === 'rejected') {
      this.promise = null
      this.status = 'idle'
      return true
    }
    return false
  }

  /**
   * Explicit reset after settlement (fulfilled or rejected).
   * No-op while pending to avoid racing concurrent callers.
   * Returns true if reset was performed.
   */
  reset(): boolean {
    if (this.status === 'pending') return false
    if (this.promise) {
      this.promise = null
      this.status = 'idle'
      return true
    }
    if (this.status !== 'idle') {
      this.status = 'idle'
      return true
    }
    return false
  }
}
