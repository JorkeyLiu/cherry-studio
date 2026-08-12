import 'katex/dist/katex.min.css'
import 'katex/dist/contrib/copy-tex'
import 'katex/dist/contrib/mhchem'
import 'remark-github-blockquote-alert/alert.css'

import ImageViewer from '@renderer/components/ImageViewer'
import MarkdownShadowDOMRenderer from '@renderer/components/MarkdownShadowDOMRenderer'
import { useSmoothStream } from '@renderer/hooks/useSmoothStream'
import type { MainTextMessageBlock, ThinkingMessageBlock, TranslationMessageBlock } from '@renderer/types/newMessage'
import { removeSvgEmptyLines } from '@renderer/utils/formats'
import { processLatexBrackets } from '@renderer/utils/markdown'
import { isEmpty } from 'lodash'
import { type FC, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown, { type Components, defaultUrlTransform } from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import rehypeRaw from 'rehype-raw'
import remarkCjkFriendly from 'remark-cjk-friendly'
import remarkGfm from 'remark-gfm'
import remarkAlert from 'remark-github-blockquote-alert'
import remarkMath from 'remark-math'
import type { Pluggable } from 'unified'

import CodeBlock from './CodeBlock'
import Link from './Link'
import MarkdownSvgRenderer from './MarkdownSvgRenderer'
import { scheduleParsedContentCommit } from './parsedContentSchedule'
import rehypeHeadingIds from './plugins/rehypeHeadingIds'
import rehypeScalableSvg from './plugins/rehypeScalableSvg'
import remarkDisableConstructs from './plugins/remarkDisableConstructs'
import Table from './Table'

const ALLOWED_ELEMENTS =
  /<(style|p|div|span|b|i|strong|em|ul|ol|li|table|tr|td|th|thead|tbody|h[1-6]|blockquote|pre|code|br|hr|svg|path|circle|rect|line|polyline|polygon|text|g|defs|title|desc|tspan|sub|sup|details|summary)/i
const DISALLOWED_ELEMENTS = ['iframe', 'script']

/**
 * Bounded cadence for the expensive full Markdown parse/render while a block
 * is streaming (LOCK-004). Aligned with the existing 150ms block-commit
 * throttle in messageThunk so visible progress stays at the committed cadence
 * instead of re-parsing the full accumulated text on every animation frame.
 */
const MARKDOWN_PARSE_CADENCE_MS = 150

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
  // Hoisted/stabilized plugin configuration: module-level plugin references
  // and a fixed plugin list — the array identity does not change between
  // parses, so ReactMarkdown's processor inputs are stable per parsed commit.
  const remarkPlugins = useMemo(() => {
    const plugins = [
      [remarkGfm, { singleTilde: false }] as Pluggable,
      [remarkAlert] as Pluggable,
      remarkCjkFriendly,
      remarkDisableConstructs(['codeIndented']),
      // LOCK-106: single-dollar math is always enabled.
      [remarkMath, { singleDollarTextMath: true }] as Pluggable
    ]
    return plugins
  }, [])

  const messageContent = useMemo(() => {
    if (isPausedEmpty) {
      return t('message.chat.completion.paused')
    }
    return removeSvgEmptyLines(processLatexBrackets(parsedContent))
  }, [isPausedEmpty, parsedContent, t])

  const rehypePlugins = useMemo(() => {
    const plugins: Pluggable[] = []
    if (ALLOWED_ELEMENTS.test(messageContent)) {
      plugins.push(rehypeRaw, rehypeScalableSvg)
    }
    plugins.push([rehypeHeadingIds, { prefix: `heading-${blockId}` }])
    // LOCK-106: KaTeX is the fixed math renderer.
    plugins.push(rehypeKatex)
    return plugins
  }, [messageContent, blockId])

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
  const isTrulyDone = 'status' in block && block.status === 'success'
  const [displayedContent, setDisplayedContent] = useState(postProcess ? postProcess(block.content) : block.content)
  // LOCK-004: frequent lightweight stream state (`displayedContent`) is
  // separated from the expensive parsed Markdown source (`parsedContent`),
  // which is updated at a bounded cadence and scheduled as non-urgent.
  const [parsedContent, setParsedContent] = useState(displayedContent)
  const [isStreamDone, setIsStreamDone] = useState(isTrulyDone)
  // LOCK-001 completion guard: synchronous mirror of the stream-done state so
  // the trailing cadence timer can refuse to write a stale ref after the
  // stream completed (the urgent final flush owns the authoritative ref from
  // then on).
  const streamDoneRef = useRef(isStreamDone)

  const prevContentRef = useRef(block.content)
  const prevBlockIdRef = useRef(block.id)
  const lastParsedTextRef = useRef(displayedContent)
  const lastParseAtRef = useRef(0)
  const latestDisplayedTextRef = useRef(displayedContent)

  const onUpdate = useCallback(
    (rawText: string) => {
      // 如果提供了后处理函数就调用，否则直接使用原始文本
      const finalText = postProcess ? postProcess(rawText) : rawText
      setDisplayedContent(finalText)
    },
    [postProcess]
  )

  const { addChunk, reset } = useSmoothStream({
    onUpdate,
    streamDone: isStreamDone,
    initialText: block.content
  })

  // Keep a ref to the newest displayed text so the trailing cadence flush
  // always parses the latest committed text.
  useEffect(() => {
    latestDisplayedTextRef.current = displayedContent
  })

  useEffect(() => {
    const newContent = block.content || ''
    const oldContent = prevContentRef.current || ''

    const isDifferentBlock = block.id !== prevBlockIdRef.current

    const isContentReset = oldContent && newContent && !newContent.startsWith(oldContent)

    if (isDifferentBlock || isContentReset) {
      reset(newContent)
      // Block switch/reset must render immediately: flush parsed content now
      // (synchronously, not transitioned) so transitions and resets are exact.
      const flushed = postProcess ? postProcess(newContent) : newContent
      lastParsedTextRef.current = flushed
      lastParseAtRef.current = performance.now()
      setParsedContent(flushed)
    } else {
      const delta = newContent.substring(oldContent.length)
      if (delta) {
        addChunk(delta)
      }
    }

    prevContentRef.current = newContent
    prevBlockIdRef.current = block.id

    // 更新 stream 状态
    const isStreaming = block.status === 'streaming'
    setIsStreamDone(!isStreaming)
    streamDoneRef.current = !isStreaming
  }, [block.content, block.id, block.status, addChunk, reset, postProcess])

  // Bounded, non-urgent Markdown parse cadence (LOCK-004).
  useEffect(() => {
    if (isStreamDone) {
      // Completion / error / pause: flush the exact final content promptly and
      // urgently. `block.content` is the authoritative final text and
      // `displayedContent` can lag it by at most the smooth-stream tail drain,
      // so this is the no-truncation final render source.
      const finalText = postProcess ? postProcess(block.content) : block.content
      if (finalText !== lastParsedTextRef.current) {
        lastParsedTextRef.current = finalText
        lastParseAtRef.current = performance.now()
        setParsedContent(finalText)
      }
      return
    }

    // While streaming, parse at most once per cadence window. Updates are
    // wrapped in startTransition so React treats them as non-urgent work that
    // yields to scroll/input.
    if (displayedContent === lastParsedTextRef.current) return

    const now = performance.now()
    const elapsed = now - lastParseAtRef.current
    if (elapsed >= MARKDOWN_PARSE_CADENCE_MS) {
      lastParsedTextRef.current = displayedContent
      lastParseAtRef.current = now
      // LOCK-001 race guard: the transition reads the authoritative ref at
      // commit time, so a pending cadence commit can never overwrite the
      // urgent final flush with stale streaming text.
      scheduleParsedContentCommit(setParsedContent, () => lastParsedTextRef.current)
      return
    }

    // Trailing flush: parse the latest accumulated text at the cadence boundary.
    const timer = setTimeout(() => {
      // LOCK-001 completion guard: if the stream completed while this trailing
      // timer was pending, the urgent final flush has already written the exact
      // final content to the authoritative ref. Writing the trailing (possibly
      // stale) text into the ref now would let a later transition re-apply it
      // and clobber the final content — refuse the write entirely.
      if (streamDoneRef.current) return
      const latest = latestDisplayedTextRef.current
      lastParsedTextRef.current = latest
      lastParseAtRef.current = performance.now()
      // Same LOCK-001 race guard as above: the trailing commit re-reads the
      // authoritative ref, which the final flush has already updated, so an
      // overdue trailing transition re-applies exact final content.
      scheduleParsedContentCommit(setParsedContent, () => lastParsedTextRef.current)
    }, MARKDOWN_PARSE_CADENCE_MS - elapsed)
    return () => clearTimeout(timer)
  }, [displayedContent, isStreamDone, postProcess, block.content])

  const isPausedEmpty = 'status' in block && block.status === 'paused' && isEmpty(block.content)

  return <MarkdownBody blockId={block.id} isPausedEmpty={isPausedEmpty} parsedContent={parsedContent} t={t} />
}

export default memo(Markdown)
