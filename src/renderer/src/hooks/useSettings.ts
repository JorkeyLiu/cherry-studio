import store, { type RootState, useAppDispatch, useAppSelector } from '@renderer/store'
import type { AssistantIconType, SendMessageShortcut, SettingsState } from '@renderer/store/settings'
import {
  setAssistantIconType,
  setAutoCheckUpdate as _setAutoCheckUpdate,
  setDisableHardwareAcceleration,
  setEnableDeveloperMode,
  setLaunchOnBoot,
  setLaunchToTray,
  setNavbarPosition,
  setPinTopicsToTop,
  setSendMessageShortcut as _setSendMessageShortcut,
  setSidebarIcons,
  setTargetLanguage,
  setTestChannel as _setTestChannel,
  setTestPlan as _setTestPlan,
  setTheme,
  setTopicPosition,
  setTray as _setTray,
  setTrayOnClose,
  setUseSystemTitleBar as _setUseSystemTitleBar,
  setWindowStyle
} from '@renderer/store/settings'
import type { SidebarIcon, ThemeMode, TranslateLanguageCode } from '@renderer/types'
import type { UpgradeChannel } from '@shared/config/constant'
import { shallowEqual } from 'react-redux'

export function useSettings() {
  const settings = useAppSelector((state) => state.settings)
  const dispatch = useAppDispatch()

  return {
    ...settings,
    setSendMessageShortcut(shortcut: SendMessageShortcut) {
      dispatch(_setSendMessageShortcut(shortcut))
    },

    setLaunch(isLaunchOnBoot: boolean | undefined, isLaunchToTray: boolean | undefined = undefined) {
      if (isLaunchOnBoot !== undefined) {
        dispatch(setLaunchOnBoot(isLaunchOnBoot))
        void window.api.setLaunchOnBoot(isLaunchOnBoot)
      }

      if (isLaunchToTray !== undefined) {
        dispatch(setLaunchToTray(isLaunchToTray))
        void window.api.setLaunchToTray(isLaunchToTray)
      }
    },

    setTray(isShowTray: boolean | undefined, isTrayOnClose: boolean | undefined = undefined) {
      if (isShowTray !== undefined) {
        dispatch(_setTray(isShowTray))
        void window.api.setTray(isShowTray)
      }
      if (isTrayOnClose !== undefined) {
        dispatch(setTrayOnClose(isTrayOnClose))
        void window.api.setTrayOnClose(isTrayOnClose)
      }
    },

    setAutoCheckUpdate(isAutoUpdate: boolean) {
      dispatch(_setAutoCheckUpdate(isAutoUpdate))
      void window.api.setAutoUpdate(isAutoUpdate)
    },

    setTestPlan(isTestPlan: boolean) {
      dispatch(_setTestPlan(isTestPlan))
      void window.api.setTestPlan(isTestPlan)
    },

    setTestChannel(channel: UpgradeChannel) {
      dispatch(_setTestChannel(channel))
      void window.api.setTestChannel(channel)
    },

    setTheme(theme: ThemeMode) {
      dispatch(setTheme(theme))
    },
    setWindowStyle(windowStyle: 'transparent' | 'opaque') {
      dispatch(setWindowStyle(windowStyle))
    },
    setTargetLanguage(targetLanguage: TranslateLanguageCode) {
      dispatch(setTargetLanguage(targetLanguage))
    },
    setTopicPosition(topicPosition: 'left' | 'right') {
      dispatch(setTopicPosition(topicPosition))
    },
    setPinTopicsToTop(pinTopicsToTop: boolean) {
      dispatch(setPinTopicsToTop(pinTopicsToTop))
    },
    updateSidebarIcons(icons: { visible: SidebarIcon[]; disabled: SidebarIcon[] }) {
      dispatch(setSidebarIcons(icons))
    },
    updateSidebarVisibleIcons(icons: SidebarIcon[]) {
      dispatch(setSidebarIcons({ visible: icons }))
    },
    updateSidebarDisabledIcons(icons: SidebarIcon[]) {
      dispatch(setSidebarIcons({ disabled: icons }))
    },
    setAssistantIconType(assistantIconType: AssistantIconType) {
      dispatch(setAssistantIconType(assistantIconType))
    },
    setDisableHardwareAcceleration(disableHardwareAcceleration: boolean) {
      dispatch(setDisableHardwareAcceleration(disableHardwareAcceleration))
      void window.api.setDisableHardwareAcceleration(disableHardwareAcceleration)
    },
    setUseSystemTitleBar(useSystemTitleBar: boolean) {
      dispatch(_setUseSystemTitleBar(useSystemTitleBar))
      void window.api.setUseSystemTitleBar(useSystemTitleBar)
    }
  }
}

export function useMessageStyle() {
  const messageStyle = useAppSelector((state) => state.settings.messageStyle)
  const isBubbleStyle = messageStyle === 'bubble'

  return {
    isBubbleStyle
  }
}

export const getStoreSetting = <K extends keyof SettingsState>(key: K): SettingsState[K] => {
  return store.getState().settings[key]
}

export const useEnableDeveloperMode = () => {
  const enableDeveloperMode = useAppSelector((state) => state.settings.enableDeveloperMode)
  const dispatch = useAppDispatch()

  return {
    enableDeveloperMode,
    setEnableDeveloperMode: (enableDeveloperMode: boolean) => {
      dispatch(setEnableDeveloperMode(enableDeveloperMode))
      void window.api.config.set('enableDeveloperMode', enableDeveloperMode)
    }
  }
}

export const getEnableDeveloperMode = () => {
  return store.getState().settings.enableDeveloperMode
}

export const useNavbarPosition = () => {
  const navbarPosition = useAppSelector((state) => state.settings.navbarPosition)
  const dispatch = useAppDispatch()

  return {
    navbarPosition,
    isLeftNavbar: navbarPosition === 'left',
    isTopNavbar: navbarPosition === 'top',
    setNavbarPosition: (position: 'left' | 'top') => dispatch(setNavbarPosition(position))
  }
}

// --- Fine-grained settings hooks ---

// 消息渲染样式 — Message, ThinkingBlock, MainTextBlock, MessageMcpTool 共享
export function useMessageRenderSettings() {
  return useAppSelector(
    (state: RootState) => ({
      messageFont: state.settings.messageFont,
      fontSize: state.settings.fontSize,
      messageStyle: state.settings.messageStyle,
      showMessageOutline: state.settings.showMessageOutline,
      thoughtAutoCollapse: state.settings.thoughtAutoCollapse,
      renderInputMessageAsMarkdown: state.settings.renderInputMessageAsMarkdown
    }),
    shallowEqual
  )
}

// 编辑器通用设置 — InputbarCore, MessageEditor 共享
export function useEditorSettings() {
  return useAppSelector(
    (state: RootState) => ({
      fontSize: state.settings.fontSize,
      sendMessageShortcut: state.settings.sendMessageShortcut,
      pasteLongTextAsFile: state.settings.pasteLongTextAsFile,
      pasteLongTextThreshold: state.settings.pasteLongTextThreshold,
      enableSpellCheck: state.settings.enableSpellCheck
    }),
    shallowEqual
  )
}

// 输入框行为 — Inputbar, TokenCount 共享
export function useInputbarSettings() {
  return useAppSelector(
    (state: RootState) => ({
      showInputEstimatedTokens: state.settings.showInputEstimatedTokens,
      enableQuickPanelTriggers: state.settings.enableQuickPanelTriggers,
      sendMessageShortcut: state.settings.sendMessageShortcut,
      targetLanguage: state.settings.targetLanguage,
      autoTranslateWithSpace: state.settings.autoTranslateWithSpace
    }),
    shallowEqual
  )
}

// 多模型分组布局 — MessageGroup, MessageGroupModelList 共享
export function useMessageGroupSettings() {
  return useAppSelector(
    (state: RootState) => ({
      multiModelMessageStyle: state.settings.multiModelMessageStyle,
      gridColumns: state.settings.gridColumns,
      gridPopoverTrigger: state.settings.gridPopoverTrigger,
      foldDisplayMode: state.settings.foldDisplayMode
    }),
    shallowEqual
  )
}
