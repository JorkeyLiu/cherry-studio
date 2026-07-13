/**
 * Type-safe Redux IPC types for main ↔ renderer communication.
 *
 * This replaces the insecure string interpolation pattern in ReduxService
 * with a fixed enum of selectors and typed action objects.
 */

/**
 * Enum of allowed state selectors.
 *
 * Each value is a dotted path into the Redux state tree.
 * The renderer-side resolver (`__reduxSelectState`) maps these to actual state access.
 */
export enum ReduxSelector {
  KnowledgeBases = 'knowledge.bases',
  LlmProviders = 'llm.providers',
  LlmSettingsCherryInAccessToken = 'llm.settings.cherryIn.accessToken',
  LlmSettingsCherryInRefreshToken = 'llm.settings.cherryIn.refreshToken',
  LlmSettingsVertexAI = 'llm.settings.vertexai',
  McpServers = 'mcp.servers',
  Settings = 'settings'
}

/**
 * Discriminated union of allowed Redux actions dispatched from the main process.
 *
 * Each variant specifies a known action type and its expected payload shape.
 */
export type ReduxAction =
  | { type: 'settings/setApiServerApiKey'; payload: string }
  | { type: 'llm/setCherryInTokens'; payload: { accessToken: string; refreshToken?: string } }
  | { type: 'llm/clearCherryInTokens' }
