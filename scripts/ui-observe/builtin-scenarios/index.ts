/**
 * Registry of built-in ui:observe scenario selectors. Static imports only —
 * each built-in is a normal scenario module; the registry is listed by
 * `pnpm ui:observe --list` and resolved by name.
 */
import type { BuiltinScenarioEntry } from '../scenario'
import { appReadyScenario } from './app-ready'

export const builtinScenarioEntries: readonly BuiltinScenarioEntry[] = [{ name: 'app-ready', module: appReadyScenario }]
