/**
 * Built-in baseline scenario: reach a ready main window, capture the home
 * screen, and record the session metadata as a text artifact.
 *
 * This is the documented selector for "does the app launch to a ready state
 * and render the home screen" — a diagnostic observation, never regression
 * evidence.
 */
import type { ObservationContext } from '../scenario'

export const appReadyScenario = {
  name: 'app-ready',
  description: 'Launch to a ready main window, capture the home screen, and record session metadata.',
  run: async (context: ObservationContext): Promise<void> => {
    await context.capture('home')
    await context.writeText('metadata.json', `${JSON.stringify(context.session, null, 2)}\n`)
  }
}
