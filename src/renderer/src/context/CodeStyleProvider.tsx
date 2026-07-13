import { useTheme } from '@renderer/context/ThemeProvider'
import { useMermaid } from '@renderer/hooks/useMermaid'
import { useSettings } from '@renderer/hooks/useSettings'
import type { HighlightChunkResult, ShikiPreProperties } from '@renderer/services/ShikiStreamService'
import { shikiStreamService } from '@renderer/services/ShikiStreamService'
import { ThemeMode } from '@renderer/types'
import { getHighlighter, getMarkdownIt, getShiki, loadLanguageIfNeeded, loadThemeIfNeeded } from '@renderer/utils/shiki'
import type React from 'react'
import { createContext, type PropsWithChildren, use, useCallback, useEffect, useMemo, useState } from 'react'
import type { BundledThemeInfo } from 'shiki/types'

/**
 * Static list of CodeMirror theme names exported by @uiw/codemirror-themes-all.
 * Derived from Object.keys(cmThemes) with functions, defaultSettings, and *Style filtered out.
 * This avoids eagerly importing the entire theme bundle.
 */
export const CM_THEME_NAMES: string[] = [
  'abcdef',
  'abyss',
  'androidstudio',
  'andromeda',
  'atomone',
  'aura',
  'basicDark',
  'basicLight',
  'bbedit',
  'bespin',
  'consoleDark',
  'consoleLight',
  'copilot',
  'darcula',
  'dracula',
  'duotoneDark',
  'duotoneLight',
  'eclipse',
  'githubDark',
  'githubLight',
  'gruvboxDark',
  'gruvboxLight',
  'kimbie',
  'material',
  'materialDark',
  'materialLight',
  'monokai',
  'monokaiDimmed',
  'noctisLilac',
  'nord',
  'okaidia',
  'quietlight',
  'red',
  'solarizedDark',
  'solarizedLight',
  'sublime',
  'tokyoNight',
  'tokyoNightStorm',
  'tokyoNightDay',
  'tomorrowNightBlue',
  'vscodeLight',
  'vscodeDark',
  'whiteDark',
  'whiteLight',
  'xcodeDark',
  'xcodeLight'
]

// Module-level cache for the lazily loaded theme module
let cmThemesCache: Record<string, unknown> | null = null
let cmThemesPromise: Promise<Record<string, unknown>> | null = null

/**
 * Lazily load the @uiw/codemirror-themes-all module.
 * Returns a cached module after the first load, avoiding redundant network requests.
 */
async function loadCmThemes(): Promise<Record<string, unknown>> {
  if (cmThemesCache) {
    return cmThemesCache
  }
  if (!cmThemesPromise) {
    cmThemesPromise = import('@uiw/codemirror-themes-all').then((mod) => {
      cmThemesCache = mod as unknown as Record<string, unknown>
      return cmThemesCache
    })
  }
  return cmThemesPromise
}

interface CodeStyleContextType {
  highlightCodeChunk: (trunk: string, language: string, callerId: string) => Promise<HighlightChunkResult>
  highlightStreamingCode: (code: string, language: string, callerId: string) => Promise<HighlightChunkResult>
  cleanupTokenizers: (callerId: string) => void
  getShikiPreProperties: (language: string) => Promise<ShikiPreProperties>
  highlightCode: (code: string, language: string) => Promise<string>
  shikiMarkdownIt: (code: string) => Promise<string>
  themeNames: string[]
  activeShikiTheme: string
  isShikiThemeDark: boolean
  activeCmTheme: any
}

const defaultCodeStyleContext: CodeStyleContextType = {
  highlightCodeChunk: async () => ({ lines: [], recall: 0 }),
  highlightStreamingCode: async () => ({ lines: [], recall: 0 }),
  cleanupTokenizers: () => {},
  getShikiPreProperties: async () => ({ class: '', style: '', tabindex: 0 }),
  highlightCode: async () => '',
  shikiMarkdownIt: async () => '',
  themeNames: ['auto'],
  activeShikiTheme: 'auto',
  isShikiThemeDark: false,
  activeCmTheme: null
}

const CodeStyleContext = createContext<CodeStyleContextType>(defaultCodeStyleContext)

export const CodeStyleProvider: React.FC<PropsWithChildren> = ({ children }) => {
  const { codeEditor, codeViewer } = useSettings()
  const { theme } = useTheme()
  const [shikiThemesInfo, setShikiThemesInfo] = useState<BundledThemeInfo[]>([])
  const [loadedCmThemes, setLoadedCmThemes] = useState<Record<string, unknown> | null>(null)
  useMermaid()

  useEffect(() => {
    if (!codeEditor.enabled) {
      void getShiki().then(({ bundledThemesInfo }) => {
        setShikiThemesInfo(bundledThemesInfo)
      })
    }
  }, [codeEditor.enabled])

  // Lazily load CodeMirror themes when the code editor is enabled
  useEffect(() => {
    if (codeEditor.enabled && !loadedCmThemes) {
      void loadCmThemes().then(setLoadedCmThemes)
    }
  }, [codeEditor.enabled, loadedCmThemes])

  // 获取支持的主题名称列表
  const themeNames = useMemo(() => {
    // CodeMirror 主题
    // 使用静态主题名列表，避免加载整个主题包
    if (codeEditor.enabled) {
      return ['auto', 'light', 'dark'].concat(CM_THEME_NAMES)
    }

    // Shiki 主题，取出所有 BundledThemeInfo 的 id 作为主题名
    return ['auto', ...shikiThemesInfo.map((info) => info.id)]
  }, [codeEditor.enabled, shikiThemesInfo])

  // 获取当前使用的 Shiki 主题名称（只用于代码预览）
  const activeShikiTheme = useMemo(() => {
    const field = theme === ThemeMode.light ? 'themeLight' : 'themeDark'
    const codeStyle = codeViewer[field]
    if (!codeStyle || codeStyle === 'auto' || !themeNames.includes(codeStyle)) {
      return theme === ThemeMode.light ? 'one-light' : 'material-theme-darker'
    }
    return codeStyle
  }, [theme, codeViewer, themeNames])

  const isShikiThemeDark = useMemo(() => {
    const themeInfo = shikiThemesInfo.find((info) => info.id === activeShikiTheme)
    return themeInfo?.type === 'dark'
  }, [activeShikiTheme, shikiThemesInfo])

  // 获取当前使用的 CodeMirror 主题对象（只用于编辑器）
  const activeCmTheme = useMemo(() => {
    const field = theme === ThemeMode.light ? 'themeLight' : 'themeDark'
    let themeName = codeEditor[field]
    if (!themeName || themeName === 'auto' || !themeNames.includes(themeName)) {
      themeName = theme === ThemeMode.light ? 'materialLight' : 'dark'
    }
    if (!loadedCmThemes) {
      // While themes are loading, return a safe built-in fallback instead of
      // raw theme name strings which are not valid CodeMirror extensions.
      return theme === ThemeMode.light ? 'light' : 'dark'
    }
    return loadedCmThemes[themeName] || (theme === ThemeMode.light ? 'light' : 'dark')
  }, [theme, codeEditor, themeNames, loadedCmThemes])

  // 自定义 shiki 语言别名
  const languageAliases = useMemo(() => {
    return {
      bash: 'shell',
      'objective-c++': 'objective-cpp',
      svg: 'xml',
      vab: 'vb',
      graphviz: 'dot'
    } as Record<string, string>
  }, [])

  useEffect(() => {
    // 在组件卸载时清理 Worker
    return () => {
      shikiStreamService.dispose()
    }
  }, [])

  // 流式代码高亮，返回已高亮的 token lines
  const highlightCodeChunk = useCallback(
    async (trunk: string, language: string, callerId: string) => {
      const normalizedLang = languageAliases[language] || language.toLowerCase()
      return shikiStreamService.highlightCodeChunk(trunk, normalizedLang, activeShikiTheme, callerId)
    },
    [activeShikiTheme, languageAliases]
  )

  // 清理代码高亮资源
  const cleanupTokenizers = useCallback((callerId: string) => {
    shikiStreamService.cleanupTokenizers(callerId)
  }, [])

  // 高亮流式输出的代码
  const highlightStreamingCode = useCallback(
    async (fullContent: string, language: string, callerId: string) => {
      const normalizedLang = languageAliases[language] || language.toLowerCase()
      return shikiStreamService.highlightStreamingCode(fullContent, normalizedLang, activeShikiTheme, callerId)
    },
    [activeShikiTheme, languageAliases]
  )

  // 获取 Shiki pre 标签属性
  const getShikiPreProperties = useCallback(
    async (language: string) => {
      const normalizedLang = languageAliases[language] || language.toLowerCase()
      return shikiStreamService.getShikiPreProperties(normalizedLang, activeShikiTheme)
    },
    [activeShikiTheme, languageAliases]
  )

  const highlightCode = useCallback(
    async (code: string, language: string) => {
      const highlighter = await getHighlighter()
      await loadLanguageIfNeeded(highlighter, language)
      await loadThemeIfNeeded(highlighter, activeShikiTheme)
      return highlighter.codeToHtml(code, { lang: language, theme: activeShikiTheme })
    },
    [activeShikiTheme]
  )

  // 使用 Shiki 和 Markdown-it 渲染代码
  const shikiMarkdownIt = useCallback(
    async (code: string) => {
      const renderer = await getMarkdownIt(activeShikiTheme, code)
      if (!renderer) {
        return code
      }
      return renderer.render(code)
    },
    [activeShikiTheme]
  )

  const contextValue = useMemo(
    () => ({
      highlightCodeChunk,
      highlightStreamingCode,
      cleanupTokenizers,
      getShikiPreProperties,
      highlightCode,
      shikiMarkdownIt,
      themeNames,
      activeShikiTheme,
      isShikiThemeDark,
      activeCmTheme
    }),
    [
      highlightCodeChunk,
      highlightStreamingCode,
      cleanupTokenizers,
      getShikiPreProperties,
      highlightCode,
      shikiMarkdownIt,
      themeNames,
      activeShikiTheme,
      isShikiThemeDark,
      activeCmTheme
    ]
  )

  return <CodeStyleContext value={contextValue}>{children}</CodeStyleContext>
}

export const useCodeStyle = () => {
  const context = use(CodeStyleContext)
  if (!context) {
    throw new Error('useCodeStyle must be used within a CodeStyleProvider')
  }
  return context
}
