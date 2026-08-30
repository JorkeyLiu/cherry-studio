import type * as XLSX from '@e965/xlsx'

type XLSXModule = typeof XLSX

let cachedModule: XLSXModule | null = null
let pendingPromise: Promise<XLSXModule> | null = null

export function loadXLSX(): Promise<XLSXModule> {
  if (cachedModule) {
    return Promise.resolve(cachedModule)
  }
  if (pendingPromise) {
    return pendingPromise
  }
  pendingPromise = (import('@e965/xlsx') as Promise<XLSXModule>)
    .then((mod) => {
      cachedModule = mod
      pendingPromise = null
      return mod
    })
    .catch((error) => {
      pendingPromise = null
      throw error
    })
  return pendingPromise
}
