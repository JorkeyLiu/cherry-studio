import { useTheme } from '@renderer/context/ThemeProvider'
import { useSettings } from '@renderer/hooks/useSettings'
import type { HighlightChunkResult, ShikiPreProperties } from '@renderer/services/ShikiStreamService'
import { shikiStreamService } from '@renderer/services/ShikiStreamService'
import { ThemeMode } from '@renderer/types'
import { getHighlighter, getMarkdownIt, getShiki, loadLanguageIfNeeded, loadThemeIfNeeded } from '@renderer/utils/shiki'
import * as cmThemes from '@uiw/codemirror-themes-all'
import type React from 'react'
import { createContext, type PropsWithChildren, use, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BundledThemeInfo } from 'shiki/types'

type ShikiMetadataStatus = 'idle' | 'pending' | 'ready' | 'failed'

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
  ensureShikiThemesLoaded: () => Promise<void>
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
  activeCmTheme: null,
  ensureShikiThemesLoaded: async () => {}
}

const CodeStyleContext = createContext<CodeStyleContextType>(defaultCodeStyleContext)

const DEFAULT_FALLBACKS = ['one-light', 'material-theme-darker'] as const

export const CodeStyleProvider: React.FC<PropsWithChildren> = ({ children }) => {
  // LOCK-107: the editable CodeMirror code-editor path is removed from message
  // code blocks; the shiki viewer theme comes from `codeViewer` only.
  const { codeViewer } = useSettings()
  const { theme } = useTheme()
  const [shikiThemesInfo, setShikiThemesInfo] = useState<BundledThemeInfo[]>([])
  const [metadataStatus, setMetadataStatus] = useState<ShikiMetadataStatus>('idle')

  const metadataStatusRef = useRef<ShikiMetadataStatus>('idle')
  const shikiThemesInfoRef = useRef<BundledThemeInfo[]>([])
  const pendingRef = useRef<Promise<void> | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const ensureShikiThemesLoaded = useCallback(async (): Promise<void> => {
    if (metadataStatusRef.current === 'ready') return
    if (pendingRef.current) return pendingRef.current
    metadataStatusRef.current = 'pending'
    setMetadataStatus('pending')
    const p = getShiki()
      .then(({ bundledThemesInfo }) => {
        if (!mountedRef.current) {
          // still capture ref for consistency but do not update state to avoid unmounted warning
          shikiThemesInfoRef.current = bundledThemesInfo
          metadataStatusRef.current = 'ready'
          return
        }
        shikiThemesInfoRef.current = bundledThemesInfo
        setShikiThemesInfo(bundledThemesInfo)
        metadataStatusRef.current = 'ready'
        setMetadataStatus('ready')
      })
      .catch((err) => {
        if (!mountedRef.current) {
          metadataStatusRef.current = 'failed'
          throw err
        }
        metadataStatusRef.current = 'failed'
        setMetadataStatus('failed')
        throw err
      })
      .finally(() => {
        if (pendingRef.current === p) {
          pendingRef.current = null
        }
      })
    pendingRef.current = p
    return p
  }, [])

  // Keep ref in sync if state changes via other paths (e.g., initial sync)
  useEffect(() => {
    shikiThemesInfoRef.current = shikiThemesInfo
  }, [shikiThemesInfo])
  useEffect(() => {
    metadataStatusRef.current = metadataStatus
  }, [metadataStatus])

  // 获取支持的主题名称列表
  const themeNames = useMemo(() => {
    // Shiki 主题，取出所有 BundledThemeInfo 的 id 作为主题名
    return ['auto', ...shikiThemesInfo.map((info) => info.id)]
  }, [shikiThemesInfo])

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

  // 获取当前使用的 CodeMirror 主题对象（仅用于共享的 CodeEditor 组件；
  // LOCK-107: message code blocks no longer use the editor path）
  const activeCmTheme = useMemo(() => {
    return theme === ThemeMode.light ? cmThemes['materialLight' as keyof typeof cmThemes] || 'materialLight' : 'dark'
  }, [theme])

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

  const getSelectedTheme = useCallback(() => {
    const field = theme === ThemeMode.light ? 'themeLight' : 'themeDark'
    return (codeViewer as any)[field] as string | undefined
  }, [codeViewer, theme])

  const isCustomThemeSelected = useCallback(() => {
    const selected = getSelectedTheme()
    return !!selected && selected !== 'auto' && !(DEFAULT_FALLBACKS as readonly string[]).includes(selected)
  }, [getSelectedTheme])

  const computeEffectiveTheme = useCallback(() => {
    const selected = getSelectedTheme()
    const names = ['auto', ...shikiThemesInfoRef.current.map((info) => info.id)]
    if (!selected || selected === 'auto' || !names.includes(selected)) {
      return theme === ThemeMode.light ? 'one-light' : 'material-theme-darker'
    }
    return selected
  }, [getSelectedTheme, theme])

  const ensureThemeMetadataForHighlight = useCallback(async () => {
    if (isCustomThemeSelected() && metadataStatusRef.current !== 'ready') {
      try {
        await ensureShikiThemesLoaded()
      } catch {
        // failure preserves fallback
      }
    } else {
      void ensureShikiThemesLoaded().catch(() => {})
    }
  }, [ensureShikiThemesLoaded, isCustomThemeSelected])

  // 流式代码高亮，返回已高亮的 token lines
  const highlightCodeChunk = useCallback(
    async (trunk: string, language: string, callerId: string) => {
      await ensureThemeMetadataForHighlight()
      const effectiveTheme = computeEffectiveTheme()
      const normalizedLang = languageAliases[language] || language.toLowerCase()
      return shikiStreamService.highlightCodeChunk(trunk, normalizedLang, effectiveTheme, callerId)
    },
    [languageAliases, ensureThemeMetadataForHighlight, computeEffectiveTheme]
  )

  // 清理代码高亮资源
  const cleanupTokenizers = useCallback((callerId: string) => {
    shikiStreamService.cleanupTokenizers(callerId)
  }, [])

  // 高亮流式输出的代码
  const highlightStreamingCode = useCallback(
    async (fullContent: string, language: string, callerId: string) => {
      await ensureThemeMetadataForHighlight()
      const effectiveTheme = computeEffectiveTheme()
      const normalizedLang = languageAliases[language] || language.toLowerCase()
      return shikiStreamService.highlightStreamingCode(fullContent, normalizedLang, effectiveTheme, callerId)
    },
    [languageAliases, ensureThemeMetadataForHighlight, computeEffectiveTheme]
  )

  // 获取 Shiki pre 标签属性
  const getShikiPreProperties = useCallback(
    async (language: string) => {
      await ensureThemeMetadataForHighlight()
      const effectiveTheme = computeEffectiveTheme()
      const normalizedLang = languageAliases[language] || language.toLowerCase()
      return shikiStreamService.getShikiPreProperties(normalizedLang, effectiveTheme)
    },
    [languageAliases, ensureThemeMetadataForHighlight, computeEffectiveTheme]
  )

  const highlightCode = useCallback(
    async (code: string, language: string) => {
      await ensureThemeMetadataForHighlight()
      const effectiveTheme = computeEffectiveTheme()
      const highlighter = await getHighlighter()
      await loadLanguageIfNeeded(highlighter, language)
      await loadThemeIfNeeded(highlighter, effectiveTheme)
      return highlighter.codeToHtml(code, { lang: language, theme: effectiveTheme })
    },
    [ensureThemeMetadataForHighlight, computeEffectiveTheme]
  )

  // 使用 Shiki 和 Markdown-it 渲染代码
  const shikiMarkdownIt = useCallback(
    async (code: string) => {
      await ensureThemeMetadataForHighlight()
      const effectiveTheme = computeEffectiveTheme()
      const renderer = await getMarkdownIt(effectiveTheme, code)
      if (!renderer) {
        return code
      }
      return renderer.render(code)
    },
    [ensureThemeMetadataForHighlight, computeEffectiveTheme]
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
      activeCmTheme,
      ensureShikiThemesLoaded
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
      activeCmTheme,
      ensureShikiThemesLoaded
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
