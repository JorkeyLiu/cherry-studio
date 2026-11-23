import 'remark-github-blockquote-alert/alert.css'

import { loggerService } from '@logger'
import ImageViewer from '@renderer/components/ImageViewer'
import MarkdownShadowDOMRenderer from '@renderer/components/MarkdownShadowDOMRenderer'
import type { MainTextMessageBlock, ThinkingMessageBlock, TranslationMessageBlock } from '@renderer/types/newMessage'
import { removeSvgEmptyLines } from '@renderer/utils/formats'
import { normalizeAttachedBlockMathClose, processLatexBrackets } from '@renderer/utils/markdown'
import { isEmpty } from 'lodash'
import { type FC, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown, { type Components, defaultUrlTransform } from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import remarkCjkFriendly from 'remark-cjk-friendly'
import remarkGfm from 'remark-gfm'
import remarkAlert from 'remark-github-blockquote-alert'
import type { Pluggable } from 'unified'

import CodeBlock from './CodeBlock'
import { containsMath } from './containsMath'
import Link from './Link'
import MarkdownSvgRenderer from './MarkdownSvgRenderer'
import { loadMathRuntime, type MathRuntime } from './mathLoader'
import { scheduleParsedContentCommit } from './parsedContentSchedule'
import rehypeHeadingIds from './plugins/rehypeHeadingIds'
import rehypeScalableSvg from './plugins/rehypeScalableSvg'
import remarkDisableConstructs from './plugins/remarkDisableConstructs'
import Table from './Table'

const ALLOWED_ELEMENTS =
  /<(style|p|div|span|b|i|strong|em|ul|ol|li|table|tr|td|th|thead|tbody|h[1-6]|blockquote|pre|code|br|hr|svg|path|circle|rect|line|polyline|polygon|text|g|defs|title|desc|tspan|sub|sup|details|summary)/i
const DISALLOWED_ELEMENTS = ['iframe', 'script']

/**
 * Maximum cadence window for the expensive full Markdown parse/render while a
 * block is streaming. Kept as a distinct named constant from the per-block
 * Redux/persistence throttle (messageThunk BLOCK_UPDATE_THROTTLE_MS) so each
 * gate can evolve independently. While chunks keep arriving, at most one parse
 * is planned per window and the planned parse always reads the latest raw
 * content; chunk arrival timing and React scheduler timing mean not every
 * window produces a visible commit.
 */
export const MARKDOWN_PARSE_CADENCE_MS = 50
const MATH_LOAD_MAX_ATTEMPTS_PER_BLOCK = 2

interface Props {
  // message: Message & { content: string }
  block: MainTextMessageBlock | TranslationMessageBlock | ThinkingMessageBlock
  // 可选的后处理函数，用于在流式渲染过程中处理文本（如引用标签转换）
  postProcess?: (text: string) => string
}

/**
 * Heavy renderer: full-text preprocessing + ReactMarkdown parse/render.
 *
 * This is memoized on the parsed content so it re-renders (and re-parses) only
 * at the bounded cadence while streaming, never on the per-frame lightweight
 * stream-state updates of the outer component.
 */
interface MarkdownBodyProps {
  blockId: string
  isPausedEmpty: boolean
  parsedContent: string
  t: (key: string) => string
}

const MarkdownBody: FC<MarkdownBodyProps> = memo(({ blockId, isPausedEmpty, parsedContent, t }: MarkdownBodyProps) => {
  const messageContent = useMemo(() => {
    if (isPausedEmpty) {
      return t('message.chat.completion.paused')
    }
    return removeSvgEmptyLines(normalizeAttachedBlockMathClose(processLatexBrackets(parsedContent)))
  }, [isPausedEmpty, parsedContent, t])

  const [mathRuntime, setMathRuntime] = useState<MathRuntime | null>(null)
  const mathFailureCountRef = useRef(0)
  const lastMathBlockIdRef = useRef(blockId)
  const logger = useMemo(() => loggerService.withContext('Markdown'), [])

  useEffect(() => {
    if (blockId !== lastMathBlockIdRef.current) {
      mathFailureCountRef.current = 0
      lastMathBlockIdRef.current = blockId
    }
    if (!containsMath(messageContent)) {
      if (mathFailureCountRef.current !== 0) {
        mathFailureCountRef.current = 0
      }
      return
    }
    if (mathRuntime) {
      return
    }
    if (mathFailureCountRef.current >= MATH_LOAD_MAX_ATTEMPTS_PER_BLOCK) {
      return
    }
    let cancelled = false
    loadMathRuntime()
      .then((runtime) => {
        if (cancelled) {
          return
        }
        setMathRuntime(runtime)
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return
        }
        if (blockId === lastMathBlockIdRef.current) {
          mathFailureCountRef.current += 1
        }
        const err = error instanceof Error ? error : new Error(String(error))
        logger.error('Failed to load math runtime', err)
      })
    return () => {
      cancelled = true
    }
  })

  // Hoisted/stabilized plugin configuration: module-level plugin references
  // and a fixed plugin list — the array identity does not change between
  // parses, so ReactMarkdown's processor inputs are stable per parsed commit.
  // Math plugins are only included after the atomic runtime load succeeds,
  // preserving ordinary Markdown rendering during pending/failure.
  const remarkPlugins = useMemo(() => {
    const plugins: Pluggable[] = [
      [remarkGfm, { singleTilde: false }] as Pluggable,
      [remarkAlert] as Pluggable,
      remarkCjkFriendly,
      remarkDisableConstructs(['codeIndented'])
    ]
    if (mathRuntime) {
      plugins.push([mathRuntime.remarkMath, { singleDollarTextMath: true }] as Pluggable)
    }
    return plugins
  }, [mathRuntime])

  const rehypePlugins = useMemo(() => {
    const plugins: Pluggable[] = []
    if (ALLOWED_ELEMENTS.test(messageContent)) {
      plugins.push(rehypeRaw, rehypeScalableSvg)
    }
    plugins.push([rehypeHeadingIds, { prefix: `heading-${blockId}` }])
    if (mathRuntime) {
      // LOCK-106: KaTeX is the fixed math renderer; atomic with remarkMath.
      plugins.push(mathRuntime.rehypeKatex as unknown as Pluggable)
    }
    return plugins
  }, [messageContent, blockId, mathRuntime])

  const components = useMemo(() => {
    return {
      a: (props: any) => <Link {...props} />,
      code: (props: any) => <CodeBlock {...props} blockId={blockId} />,
      table: (props: any) => <Table {...props} blockId={blockId} />,
      img: (props: any) => <ImageViewer style={{ maxWidth: 500, maxHeight: 500 }} {...props} />,
      pre: (props: any) => <pre style={{ overflow: 'visible' }} {...props} />,
      p: (props) => {
        const hasImage = props?.node?.children?.some((child: any) => child.tagName === 'img')
        if (hasImage) return <div {...props} />
        return <p {...props} />
      },
      svg: MarkdownSvgRenderer
    } as Partial<Components>
  }, [blockId])

  if (/<style\b[^>]*>/i.test(messageContent)) {
    components.style = MarkdownShadowDOMRenderer as any
  }

  const urlTransform = useCallback((value: string) => {
    if (value.startsWith('data:image/png') || value.startsWith('data:image/jpeg')) return value
    return defaultUrlTransform(value)
  }, [])

  const remarkRehypeOptions = useMemo(
    () => ({
      footnoteLabel: t('common.footnotes'),
      footnoteLabelTagName: 'h4',
      footnoteBackContent: ' '
    }),
    [t]
  )

  return (
    <div className="markdown">
      <ReactMarkdown
        rehypePlugins={rehypePlugins}
        remarkPlugins={remarkPlugins}
        components={components}
        disallowedElements={DISALLOWED_ELEMENTS}
        urlTransform={urlTransform}
        remarkRehypeOptions={remarkRehypeOptions}>
        {messageContent}
      </ReactMarkdown>
    </div>
  )
})

const Markdown: FC<Props> = ({ block, postProcess }) => {
  const { t } = useTranslation()
  // LOCK-106: Markdown math rendering is fixed to KaTeX with single-dollar
  // syntax enabled. The math engine settings are removed.
  //
  // The initial parsed content is post-processed exactly once (lazily, so it
  // is not re-processed on every render) and is already the authoritative
  // text: streaming mounts never start from a cleared intermediate state.
  const [parsedContent, setParsedContent] = useState(() => (postProcess ? postProcess(block.content) : block.content))

  // Raw block content is the single authority for what gets parsed; the
  // processed text derived from it is what the bounded cadence publishes.
  const lastParsedRawRef = useRef(block.content)
  const lastParsedProcessRef = useRef(postProcess)
  const lastParsedTextRef = useRef(parsedContent)
  const lastParseAtRef = useRef(0)
  const latestRawRef = useRef(block.content)
  // Latest post-processing callback, read at plan time. Callers may rebuild
  // this callback on every chunk, so a planned parse must never reuse a stale
  // identity captured when the plan was made.
  const latestProcessRef = useRef(postProcess)
  const prevContentRef = useRef(block.content)
  const prevBlockIdRef = useRef(block.id)
  const prevPostProcessRef = useRef(postProcess)
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Generation token: every exact flush invalidates the generation captured by
  // a pending trailing timer, so a stale timer can never write old text back.
  const generationRef = useRef(0)

  const cancelPendingTimer = useCallback(() => {
    if (pendingTimerRef.current !== null) {
      clearTimeout(pendingTimerRef.current)
      pendingTimerRef.current = null
    }
  }, [])

  // Publish the latest raw content through the bounded cadence as non-urgent
  // React work. Both the raw text and the post-processing callback are read
  // from refs at plan time, and the plan is skipped only when BOTH already
  // match the last parse, so a callback change with unchanged raw text still
  // produces a planned (trailing) update. Post-processing runs once per
  // planned parse.
  const runStreamingParse = useCallback((generation: number) => {
    if (generation !== generationRef.current) return
    const raw = latestRawRef.current
    const processText = latestProcessRef.current
    if (raw === lastParsedRawRef.current && processText === lastParsedProcessRef.current) return
    lastParsedRawRef.current = raw
    lastParsedProcessRef.current = processText
    lastParseAtRef.current = performance.now()
    lastParsedTextRef.current = processText ? processText(raw) : raw
    scheduleParsedContentCommit(setParsedContent, () => lastParsedTextRef.current)
  }, [])

  // At most one pending trailing timer exists at a time: new chunks or a
  // rebuilt post-processing callback do not cancel/restart it, they are simply
  // picked up from the latest refs when the cadence window closes.
  const scheduleStreamingParse = useCallback(() => {
    if (pendingTimerRef.current !== null) return
    const generation = generationRef.current
    const elapsed = performance.now() - lastParseAtRef.current
    if (elapsed >= MARKDOWN_PARSE_CADENCE_MS) {
      runStreamingParse(generation)
      return
    }
    pendingTimerRef.current = setTimeout(() => {
      pendingTimerRef.current = null
      runStreamingParse(generation)
    }, MARKDOWN_PARSE_CADENCE_MS - elapsed)
  }, [runStreamingParse])

  // Exact synchronous flush: block switch, same-id non-prefix rewrite
  // (including a clear), and any non-streaming status commit the authoritative
  // text immediately and invalidate every pending timer/transition generation.
  // A post-processing callback change alone is NOT an exact path: while
  // streaming it only marks pending reprocessing for the bounded cadence.
  // The exact flush still re-processes when the last published text was
  // produced by a different callback identity, so an exact commit (e.g. stream
  // completion) never leaves text from a superseded callback on screen.
  const flushExactContent = useCallback(
    (raw: string, processText: Props['postProcess'], reprocess: boolean) => {
      cancelPendingTimer()
      generationRef.current += 1
      if (reprocess || raw !== lastParsedRawRef.current || processText !== lastParsedProcessRef.current) {
        lastParsedRawRef.current = raw
        lastParsedProcessRef.current = processText
        lastParsedTextRef.current = processText ? processText(raw) : raw
      }
      lastParseAtRef.current = performance.now()
      setParsedContent(lastParsedTextRef.current)
    },
    [cancelPendingTimer]
  )

  // The initial content was already parsed by the lazy state initializer, so
  // the cadence baseline starts at mount instead of firing a duplicate parse.
  useEffect(() => {
    lastParseAtRef.current = performance.now()
  }, [])

  useEffect(() => {
    const raw = block.content || ''
    const prevRaw = prevContentRef.current || ''
    const isDifferentBlock = block.id !== prevBlockIdRef.current
    const isNonPrefixRewrite = !raw.startsWith(prevRaw)
    const isStreaming = block.status === 'streaming'
    const postProcessChanged = prevPostProcessRef.current !== postProcess

    prevContentRef.current = raw
    prevBlockIdRef.current = block.id
    prevPostProcessRef.current = postProcess
    latestRawRef.current = raw
    latestProcessRef.current = postProcess

    if (isDifferentBlock || isNonPrefixRewrite || !isStreaming) {
      flushExactContent(raw, postProcess, isDifferentBlock || isNonPrefixRewrite || postProcessChanged)
      return
    }
    if (raw !== lastParsedRawRef.current || postProcessChanged) {
      scheduleStreamingParse()
    }
  }, [block.content, block.id, block.status, postProcess, flushExactContent, scheduleStreamingParse])

  // A pending trailing timer never outlives the component.
  useEffect(() => {
    return () => {
      cancelPendingTimer()
      generationRef.current += 1
    }
  }, [cancelPendingTimer])

  const isPausedEmpty = 'status' in block && block.status === 'paused' && isEmpty(block.content)

  return <MarkdownBody blockId={block.id} isPausedEmpty={isPausedEmpty} parsedContent={parsedContent} t={t} />
}

export default memo(Markdown)
