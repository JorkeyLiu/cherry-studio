import type { MessageWindow } from './messageWindow'

export type MessageViewportLoadDirection = 'older' | 'newer'
export type MessageViewportNavigationSource = 'restore' | 'event' | 'pending' | 'imperative' | 'group'
export type MessageViewportNavigationPhase = 'idle' | 'pending' | 'preparing' | 'scrolling'
export type MessageViewportNavigationAlignment = 'start' | 'center' | 'end'
export type MessageViewportScrollMode = 'user' | 'programmatic' | 'anchoring'
export type MessageViewportNavigationToken = object
export type MessageViewportLoadToken = object
export type MessageViewportScrollToken = object

interface MessageViewportLoadState {
  active: boolean
  token: MessageViewportLoadToken | null
  topicGeneration: number
}

export interface MessageViewportState {
  window: MessageWindow | null
  loading: Record<MessageViewportLoadDirection, boolean>
  loads: Record<MessageViewportLoadDirection, MessageViewportLoadState>
  topicGeneration: number
  navigation: {
    generation: number
    token: MessageViewportNavigationToken | null
    targetId: string | null
    source: MessageViewportNavigationSource | null
    alignment: MessageViewportNavigationAlignment
    phase: MessageViewportNavigationPhase
  }
  scrollGeneration: number
  scrollMode: MessageViewportScrollMode
  scrollToken: MessageViewportScrollToken | null
}

export type MessageViewportAction =
  | { type: 'window/apply'; window: MessageWindow }
  | { type: 'window/reset'; window: MessageWindow | null }
  | { type: 'load/start'; direction: MessageViewportLoadDirection; token: MessageViewportLoadToken }
  | {
      type: 'load/finish'
      direction: MessageViewportLoadDirection
      token: MessageViewportLoadToken
      topicGeneration: number
      window: MessageWindow
    }
  | {
      type: 'load/cancel'
      direction: MessageViewportLoadDirection
      token: MessageViewportLoadToken
      topicGeneration: number
    }
  | {
      type: 'navigation/begin'
      token: MessageViewportNavigationToken
      targetId: string | null
      source: MessageViewportNavigationSource
      alignment?: MessageViewportNavigationAlignment
      phase?: Exclude<MessageViewportNavigationPhase, 'idle'>
    }
  | {
      type: 'navigation/phase'
      token: MessageViewportNavigationToken
      phase: Exclude<MessageViewportNavigationPhase, 'idle' | 'pending'>
    }
  | { type: 'navigation/finish'; token: MessageViewportNavigationToken }
  | { type: 'navigation/cancel'; token?: MessageViewportNavigationToken }
  | { type: 'navigation/apply-window'; token: MessageViewportNavigationToken; window: MessageWindow }
  | { type: 'scroll/begin'; mode: Exclude<MessageViewportScrollMode, 'user'>; token: MessageViewportScrollToken }
  | { type: 'scroll/end'; token: MessageViewportScrollToken }
  | { type: 'topic/reset'; window?: MessageWindow | null }

export const createMessageViewportState = (window: MessageWindow | null = null): MessageViewportState => ({
  window,
  loading: { older: false, newer: false },
  loads: {
    older: { active: false, token: null, topicGeneration: 0 },
    newer: { active: false, token: null, topicGeneration: 0 }
  },
  topicGeneration: 0,
  navigation: {
    generation: 0,
    token: null,
    targetId: null,
    source: null,
    alignment: 'start',
    phase: 'idle'
  },
  scrollGeneration: 0,
  scrollMode: 'user',
  scrollToken: null
})

const finishNavigation = (state: MessageViewportState): MessageViewportState => ({
  ...state,
  navigation: {
    ...state.navigation,
    token: null,
    targetId: null,
    source: null,
    alignment: 'start',
    phase: 'idle'
  }
})

export const messageViewportReducer = (
  state: MessageViewportState,
  action: MessageViewportAction
): MessageViewportState => {
  switch (action.type) {
    case 'window/apply':
      return { ...state, window: action.window }
    case 'window/reset':
      return { ...state, window: action.window }
    case 'load/start':
      return {
        ...state,
        loading: { ...state.loading, [action.direction]: true },
        loads: {
          ...state.loads,
          [action.direction]: { active: true, token: action.token, topicGeneration: state.topicGeneration }
        }
      }
    case 'load/finish': {
      const load = state.loads[action.direction]
      if (load.token !== action.token || load.topicGeneration !== action.topicGeneration || !load.active) return state
      return {
        ...state,
        window: action.window,
        loading: { ...state.loading, [action.direction]: false },
        loads: { ...state.loads, [action.direction]: { ...load, active: false } }
      }
    }
    case 'load/cancel': {
      const load = state.loads[action.direction]
      if (load.token !== action.token || load.topicGeneration !== action.topicGeneration || !load.active) return state
      return {
        ...state,
        loading: { ...state.loading, [action.direction]: false },
        loads: { ...state.loads, [action.direction]: { ...load, active: false } }
      }
    }
    case 'navigation/begin':
      return {
        ...state,
        navigation: {
          generation: state.navigation.generation + 1,
          token: action.token,
          targetId: action.targetId,
          source: action.source,
          alignment: action.alignment ?? 'start',
          phase: action.phase ?? 'preparing'
        }
      }
    case 'navigation/phase':
      if (action.token !== state.navigation.token || state.navigation.phase === 'idle') return state
      return { ...state, navigation: { ...state.navigation, phase: action.phase } }
    case 'navigation/finish':
      return action.token === state.navigation.token
        ? finishNavigation({ ...state, scrollMode: 'user', scrollToken: null })
        : state
    case 'navigation/cancel':
      if (action.token !== undefined && action.token !== state.navigation.token) return state
      return finishNavigation({
        ...state,
        scrollMode: 'user',
        scrollToken: null,
        navigation: { ...state.navigation, generation: state.navigation.generation + 1 }
      })
    case 'navigation/apply-window':
      if (action.token !== state.navigation.token || state.navigation.phase === 'idle') return state
      return { ...state, window: action.window, navigation: { ...state.navigation, phase: 'preparing' } }
    case 'scroll/begin':
      return {
        ...state,
        scrollGeneration: state.scrollGeneration + 1,
        scrollMode: action.mode,
        scrollToken: action.token
      }
    case 'scroll/end':
      return state.scrollToken === action.token ? { ...state, scrollMode: 'user', scrollToken: null } : state
    case 'topic/reset':
      return {
        ...createMessageViewportState(action.window ?? null),
        topicGeneration: state.topicGeneration + 1,
        navigation: {
          ...createMessageViewportState().navigation,
          generation: state.navigation.generation + 1
        }
      }
  }
}
