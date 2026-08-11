import { compareTrashTopicsForDisplay, listOrdinaryTrashTopics } from '@renderer/services/db/topicTrashLifecycle'
import type { Topic } from '@renderer/types'
import { cn } from '@renderer/utils'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import { RotateCcw, Trash2 } from 'lucide-react'
import type { FC, PropsWithChildren } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

dayjs.extend(relativeTime)

export interface TopicTrashPanelProps {
  assistantId: string
  refreshVersion: number
  onRestore: (topicId: string) => void | Promise<void>
  onPermanentDelete: (topicId: string) => void | Promise<void>
  onEmptyTrash: () => void | Promise<void>
}

export const TopicTrashPanel: React.FC<TopicTrashPanelProps> = ({
  assistantId,
  refreshVersion,
  onRestore,
  onPermanentDelete,
  onEmptyTrash
}) => {
  const { t } = useTranslation()
  const [isExpanded, setIsExpanded] = useState(false)
  const [trashTopics, setTrashTopics] = useState<Topic[]>([])
  const [loading, setLoading] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)

  const fetchTrashTopics = useCallback(async () => {
    if (!assistantId) return
    setLoading(true)
    try {
      // Phase 5.2B: ordinary trash listing is SQLite-backed and complete
      // (cursor pages are drained inside the read, LOCK-530).
      const ordinaryTopics = await listOrdinaryTrashTopics(assistantId)
      // Deterministic display order: deletedAt DESC, id DESC (LOCK-523).
      setTrashTopics([...ordinaryTopics].sort(compareTrashTopicsForDisplay))
    } catch {
      // silently fail, keep current state
    } finally {
      setLoading(false)
    }
  }, [assistantId])

  useEffect(() => {
    void fetchTrashTopics()
  }, [fetchTrashTopics, refreshVersion])

  const handleRestore = useCallback(
    async (e: React.MouseEvent, topicId: string) => {
      e.stopPropagation()
      try {
        await onRestore(topicId)
      } catch {
        // Mutation failed: keep the row so the UI stays convergent with
        // the persisted trash state (LOCK-528).
        return
      }
      setTrashTopics((prev) => prev.filter((t) => t.id !== topicId))
    },
    [onRestore]
  )

  const handlePermanentDelete = useCallback(
    async (e: React.MouseEvent, topicId: string) => {
      e.stopPropagation()
      try {
        await onPermanentDelete(topicId)
      } catch {
        // Mutation failed: keep the row (LOCK-528).
        return
      }
      setTrashTopics((prev) => prev.filter((t) => t.id !== topicId))
    },
    [onPermanentDelete]
  )

  const handleEmptyTrash = useCallback(async () => {
    try {
      await onEmptyTrash()
    } catch {
      // Mutation failed: keep the rows (LOCK-528).
      return
    }
    setTrashTopics([])
  }, [onEmptyTrash])

  const handleToggle = useCallback(() => {
    if (!isExpanded) {
      void fetchTrashTopics()
    }
    setIsExpanded((prev) => !prev)
  }, [isExpanded, fetchTrashTopics])

  const count = trashTopics.length

  // Collapsed bar
  if (!isExpanded) {
    return (
      <PanelWrapper>
        <CollapsedBar
          data-testid="trash-collapsed-bar"
          onClick={handleToggle}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && handleToggle()}>
          <DragHandle />
          <TrashLabel>{t('chat.topics.trash.label', { count })}</TrashLabel>
          <CountBadge>{count}</CountBadge>
          <DragHandle />
        </CollapsedBar>
      </PanelWrapper>
    )
  }

  // Expanded panel
  return (
    <PanelWrapper>
      <ExpandedPanel>
        {/* Header */}
        <PanelHeader
          data-testid="trash-expanded-header"
          onClick={handleToggle}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && handleToggle()}>
          <DragHandle />
          <TrashLabel>{t('chat.topics.trash.label', { count })}</TrashLabel>
          <CountBadge>{count}</CountBadge>
        </PanelHeader>

        {/* Content area */}
        <PanelContent ref={contentRef}>
          {loading && <EmptyState>{t('common.loading')}</EmptyState>}

          {!loading && count === 0 && <EmptyState>{t('chat.topics.trash.empty')}</EmptyState>}

          {!loading &&
            trashTopics.map((topic) => {
              const displayName = topic.name.trim() || t('common.unnamed')
              return (
                <TrashItem key={topic.id} data-testid="trash-item" data-topic-id={topic.id}>
                  <TrashItemInfo>
                    <TrashItemName title={displayName}>{displayName}</TrashItemName>
                    <TrashItemTime>{topic.deletedAt ? dayjs(topic.deletedAt).fromNow() : ''}</TrashItemTime>
                  </TrashItemInfo>
                  <TrashItemActions>
                    <IconButton
                      data-testid="trash-restore-btn"
                      data-topic-id={topic.id}
                      title={t('chat.topics.trash.restore')}
                      onClick={(e) => void handleRestore(e, topic.id)}>
                      <RotateCcw size={14} />
                    </IconButton>
                    <IconButton
                      data-testid="trash-hard-delete-btn"
                      data-topic-id={topic.id}
                      danger
                      title={t('common.delete')}
                      onClick={(e) => void handlePermanentDelete(e, topic.id)}>
                      <Trash2 size={14} />
                    </IconButton>
                  </TrashItemActions>
                </TrashItem>
              )
            })}
        </PanelContent>

        {/* Footer actions */}
        {!loading && count > 0 && (
          <PanelFooter>
            <EmptyTrashButton data-testid="trash-empty-btn" onClick={() => void handleEmptyTrash()}>
              <Trash2 size={14} />
              <span>{t('chat.topics.trash.empty_trash')}</span>
            </EmptyTrashButton>
          </PanelFooter>
        )}
      </ExpandedPanel>
    </PanelWrapper>
  )
}

// ─── Styled sub-components ───────────────────────────────────────────────────

const PanelWrapper: FC<PropsWithChildren> = ({ children }) => (
  <div className="relative mt-auto w-full shrink-0 px-3 pb-3">{children}</div>
)

const CollapsedBar: FC<PropsWithChildren<React.HTMLAttributes<HTMLDivElement>>> = ({
  children,
  className,
  ...props
}) => (
  <div
    {...props}
    className={cn(
      'flex cursor-pointer flex-row items-center justify-center gap-2 rounded-xl bg-[var(--color-background)] px-3 py-2 shadow-[0_2px_8px_rgba(0,0,0,0.08),0_0_0_1px_var(--color-border)] transition-all duration-200 hover:shadow-[0_2px_8px_rgba(0,0,0,0.12)]',
      className
    )}>
    {children}
  </div>
)

const ExpandedPanel: FC<PropsWithChildren> = ({ children }) => (
  <div className="overflow-hidden rounded-xl bg-[var(--color-background)] shadow-[0_4px_12px_rgba(0,0,0,0.15),0_0_0_1px_var(--color-border)]">
    {children}
  </div>
)

const PanelHeader: FC<PropsWithChildren<React.HTMLAttributes<HTMLDivElement>>> = ({
  children,
  className,
  ...props
}) => (
  <div
    {...props}
    className={cn(
      'flex cursor-pointer flex-row items-center gap-2 border-[var(--color-border)] border-b px-4 py-2.5 transition-colors duration-150 hover:bg-[var(--color-background-mute)]',
      className
    )}>
    {children}
  </div>
)

const PanelContent: FC<PropsWithChildren<{ ref?: React.Ref<HTMLDivElement> }>> = ({ children, ref }) => (
  <div ref={ref} className="max-h-[240px] overflow-y-auto overscroll-contain">
    {children}
  </div>
)

const PanelFooter: FC<PropsWithChildren> = ({ children }) => (
  <div className="flex items-center justify-center border-[var(--color-border)] border-t px-4 py-2">{children}</div>
)

const DragHandle: FC = () => (
  <div className="flex items-center justify-center">
    <div className="h-[3px] w-5 rounded-full bg-[var(--color-text-3)] opacity-50" />
  </div>
)

const TrashLabel: FC<PropsWithChildren> = ({ children }) => (
  <span className="select-none font-medium text-[12px] text-[var(--color-text-2)]">{children}</span>
)

const CountBadge: FC<PropsWithChildren> = ({ children }) => (
  <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[9px] bg-[var(--color-primary)] px-[5px] font-medium text-[11px] text-white leading-none">
    {children}
  </span>
)

const EmptyState: FC<PropsWithChildren> = ({ children }) => (
  <div className="flex items-center justify-center px-4 py-6 text-[13px] text-[var(--color-text-3)]">{children}</div>
)

const TrashItem: FC<PropsWithChildren<React.HTMLAttributes<HTMLDivElement>>> = ({ children, className, ...props }) => (
  <div
    {...props}
    className={cn(
      'flex flex-row items-center gap-2 px-4 py-2.5 transition-colors duration-150 hover:bg-[var(--color-background-mute)]',
      className
    )}>
    {children}
  </div>
)

const TrashItemInfo: FC<PropsWithChildren> = ({ children }) => (
  <div className="flex min-w-0 flex-1 flex-col gap-0.5 overflow-hidden">{children}</div>
)

const TrashItemName: FC<PropsWithChildren<{ title?: string }>> = ({ children, title }) => (
  <span
    title={title}
    className="overflow-hidden text-ellipsis whitespace-nowrap text-[13px] text-[var(--color-text-1)]">
    {children}
  </span>
)

const TrashItemTime: FC<PropsWithChildren> = ({ children }) => (
  <span className="text-[11px] text-[var(--color-text-3)]">{children}</span>
)

const TrashItemActions: FC<PropsWithChildren> = ({ children }) => (
  <div className="flex shrink-0 flex-row items-center gap-1">{children}</div>
)

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  danger?: boolean
}

const IconButton: FC<PropsWithChildren<IconButtonProps>> = ({ children, className, danger, disabled, ...props }) => (
  <button
    {...props}
    type="button"
    disabled={disabled}
    className={cn(
      'flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-none bg-transparent text-[var(--color-text-2)] transition-all duration-200',
      disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer',
      !disabled && !danger && 'hover:bg-[var(--color-background-mute)] hover:text-[var(--color-text-1)]',
      danger && 'text-[var(--color-text-3)]',
      danger && !disabled && 'hover:bg-[var(--color-error)] hover:text-white',
      className
    )}>
    {children}
  </button>
)

const EmptyTrashButton: FC<PropsWithChildren<React.HTMLAttributes<HTMLButtonElement>>> = ({
  children,
  className,
  ...props
}) => (
  <button
    {...props}
    type="button"
    className={cn(
      'flex cursor-pointer flex-row items-center gap-1.5 rounded-lg border-none bg-transparent px-3 py-1.5 text-[12px] text-[var(--color-text-3)] transition-all duration-200 hover:bg-[var(--color-error-bg,var(--color-background-mute))] hover:text-[var(--color-error)]',
      className
    )}>
    {children}
  </button>
)

export default TopicTrashPanel
