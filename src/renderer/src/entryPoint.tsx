import './assets/styles/index.css'
import './assets/styles/tailwind.css'
import '@ant-design/v5-patch-for-react-19'

import { createRoot } from 'react-dom/client'

import { initialI18nReady } from './i18n'

// Fresh-profile startup ordering: App/store/fresh-assistant factories call
// `i18n.t` at module evaluation. They must not evaluate until the initial
// i18n resource activation has settled, otherwise fresh defaults hit the
// missing-key path. The dynamic App import below defers that evaluation;
// the readiness promise never rejects, and a load failure still starts the
// renderer on the fallback language.
async function boot(): Promise<void> {
  try {
    await initialI18nReady
  } catch {
    // Failure retains the fallback language — still start the renderer.
  }
  const { default: App } = await import('./App')
  const root = createRoot(document.getElementById('root') as HTMLElement)
  root.render(<App />)
}

void boot()
