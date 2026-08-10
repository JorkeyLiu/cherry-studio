import AssistantAvatar from '@renderer/components/Avatar/AssistantAvatar'
import { CopyIcon, DeleteIcon, EditIcon } from '@renderer/components/Icons'
import { useAssistant, useAssistants } from '@renderer/hooks/useAssistant'
import AssistantSettingsPopup from '@renderer/pages/settings/AssistantSettings'
import type { Assistant } from '@renderer/types'
import { cn, uuid } from '@renderer/utils'
import { hasTopicPendingRequests } from '@renderer/utils/queue'
import type { MenuProps } from 'antd'
import { Dropdown } from 'antd'
import { omit } from 'lodash'
import { ArrowDownAZ, ArrowUpAZ, BrushCleaning, MoreVertical, Save } from 'lucide-react'
import type { FC, PropsWithChildren } from 'react'
import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as tinyPinyin from 'tiny-pinyin'

interface AssistantItemProps {
  assistant: Assistant
  isActive: boolean
  onSwitch: (assistant: Assistant) => void
  onDelete: (assistant: Assistant) => void
  onCreateDefaultAssistant: () => void
  addPreset: (agent: any) => void
  copyAssistant: (assistant: Assistant) => void
  sortByPinyinAsc?: () => void
  sortByPinyinDesc?: () => void
}

const AssistantItem: FC<AssistantItemProps> = ({
  assistant,
  isActive,
  onSwitch,
  onDelete,
  addPreset,
  copyAssistant,
  sortByPinyinAsc: externalSortByPinyinAsc,
  sortByPinyinDesc: externalSortByPinyinDesc
}) => {
  const { t } = useTranslation()
  const { removeAllTopics } = useAssistant(assistant.id)
  const { assistants, updateAssistants } = useAssistants()

  const [isPending, setIsPending] = useState(false)
  const [isHovered, setIsHovered] = useState(false)

  useEffect(() => {
    if (isActive) {
      setIsPending(false)
      return
    }

    const hasPending = assistant.topics.some((topic) => hasTopicPendingRequests(topic.id))
    setIsPending(hasPending)
  }, [isActive, assistant.topics])

  // Local sort functions
  const localSortByPinyinAsc = useCallback(() => {
    updateAssistants(sortAssistantsByPinyin(assistants, true))
  }, [assistants, updateAssistants])

  const localSortByPinyinDesc = useCallback(() => {
    updateAssistants(sortAssistantsByPinyin(assistants, false))
  }, [assistants, updateAssistants])

  // Use external sort functions if provided, otherwise use local ones
  const sortByPinyinAsc = externalSortByPinyinAsc || localSortByPinyinAsc
  const sortByPinyinDesc = externalSortByPinyinDesc || localSortByPinyinDesc

  const menuItems = useMemo(
    () =>
      getMenuItems({
        assistant,
        t,
        addPreset,
        copyAssistant,
        onSwitch,
        onDelete,
        removeAllTopics,
        sortByPinyinAsc,
        sortByPinyinDesc
      }),
    [assistant, t, addPreset, copyAssistant, onSwitch, onDelete, removeAllTopics, sortByPinyinAsc, sortByPinyinDesc]
  )

  const handleSwitch = useCallback(async () => {
    // LOCK-002: topics always render on the right — no sidebar switch needed.
    onSwitch(assistant)
  }, [onSwitch, assistant])

  const assistantName = useMemo(() => assistant.name || t('chat.default.name'), [assistant.name, t])
  const fullAssistantName = useMemo(
    () => (assistant.emoji ? `${assistant.emoji} ${assistantName}` : assistantName),
    [assistant.emoji, assistantName]
  )

  const handleMenuButtonClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
  }, [])

  return (
    <Dropdown
      menu={{ items: menuItems }}
      trigger={['contextMenu']}
      popupRender={(menu) => <div onPointerDown={(e) => e.stopPropagation()}>{menu}</div>}>
      <Container
        onClick={handleSwitch}
        isActive={isActive}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}>
        <AssistantNameRow className="name" title={fullAssistantName}>
          <AssistantAvatar
            assistant={assistant}
            size={24}
            className={isPending && !isActive ? 'animation-pulse' : ''}
          />
          <AssistantName className="text-nowrap">{assistantName}</AssistantName>
        </AssistantNameRow>
        {(isActive || isHovered) && (
          <Dropdown
            menu={{ items: menuItems }}
            trigger={['click']}
            popupRender={(menu) => <div onPointerDown={(e) => e.stopPropagation()}>{menu}</div>}>
            <MenuButton onClick={handleMenuButtonClick}>
              <MoreVertical size={14} className="text-(--color-text-secondary)" />
            </MenuButton>
          </Dropdown>
        )}
      </Container>
    </Dropdown>
  )
}

// 提取排序相关的工具函数
const sortAssistantsByPinyin = (assistants: Assistant[], isAscending: boolean) => {
  return [...assistants].sort((a, b) => {
    const pinyinA = tinyPinyin.convertToPinyin(a.name, '', true)
    const pinyinB = tinyPinyin.convertToPinyin(b.name, '', true)
    return isAscending ? pinyinA.localeCompare(pinyinB) : pinyinB.localeCompare(pinyinA)
  })
}

// 提取创建菜单配置的函数
// LOCK-007: icon-type and tag-related items/actions and list/tags view
// switching are removed; edit, duplicate, clear, save-to-agent, sorting and
// delete remain. Assistant tags data itself is preserved for compatibility.
export function getMenuItems({
  assistant,
  t,
  addPreset,
  copyAssistant,
  onSwitch,
  onDelete,
  removeAllTopics,
  sortByPinyinAsc,
  sortByPinyinDesc
}): MenuProps['items'] {
  return [
    {
      label: t('assistants.edit.title'),
      key: 'edit',
      icon: <EditIcon size={14} />,
      onClick: () => AssistantSettingsPopup.show({ assistant })
    },
    {
      label: t('assistants.copy.title'),
      key: 'duplicate',
      icon: <CopyIcon size={14} />,
      onClick: async () => {
        // LOCK-533: copyAssistant persists SQLite topic ownership first.
        const _assistant = await copyAssistant(assistant)
        if (_assistant) {
          onSwitch(_assistant)
        }
      }
    },
    {
      label: t('assistants.clear.title'),
      key: 'clear',
      icon: <BrushCleaning size={14} />,
      onClick: () => {
        window.modal.confirm({
          title: t('assistants.clear.title'),
          content: t('assistants.clear.content'),
          centered: true,
          okButtonProps: { danger: true },
          onOk: removeAllTopics
        })
      }
    },
    {
      label: t('assistants.save.title'),
      key: 'save-to-agent',
      icon: <Save size={14} />,
      onClick: async () => {
        const preset = omit(assistant, ['model'])
        preset.id = uuid()
        preset.type = 'agent'
        addPreset(preset)
        window.toast.success(t('assistants.save.success'))
      }
    },
    {
      type: 'divider'
    },
    {
      label: t('common.sort.pinyin.asc'),
      key: 'sort-asc',
      icon: <ArrowDownAZ size={14} />,
      onClick: sortByPinyinAsc
    },
    {
      label: t('common.sort.pinyin.desc'),
      key: 'sort-desc',
      icon: <ArrowUpAZ size={14} />,
      onClick: sortByPinyinDesc
    },
    {
      type: 'divider'
    },
    {
      label: t('common.delete'),
      key: 'delete',
      icon: <DeleteIcon size={14} className="lucide-custom" />,
      danger: true,
      onClick: () => {
        window.modal.confirm({
          title: t('assistants.delete.title'),
          content: t('assistants.delete.content'),
          centered: true,
          okButtonProps: { danger: true },
          onOk: () => onDelete(assistant)
        })
      }
    }
  ]
}

const Container = ({
  children,
  isActive,
  className,
  ...props
}: PropsWithChildren<{ isActive?: boolean } & React.HTMLAttributes<HTMLDivElement>>) => (
  <div
    {...props}
    className={cn(
      'relative flex h-9.25 w-[calc(var(--assistants-width)-20px)] cursor-pointer flex-row justify-between rounded-(--list-item-border-radius) border-[0.5px] border-transparent px-2',
      !isActive && 'hover:bg-(--color-list-item-hover)',
      isActive && 'bg-(--color-list-item) shadow-[0_1px_2px_0_rgba(0,0,0,0.05)]',
      className
    )}>
    {children}
  </div>
)

const AssistantNameRow = ({
  children,
  className,
  ...props
}: PropsWithChildren<{} & React.HTMLAttributes<HTMLDivElement>>) => (
  <div
    {...props}
    className={cn('flex min-w-0 flex-1 flex-row items-center gap-2 text-(--color-text) text-[13px]', className)}>
    {children}
  </div>
)

const AssistantName = ({
  children,
  className,
  ...props
}: PropsWithChildren<{} & React.HTMLAttributes<HTMLDivElement>>) => (
  <div
    {...props}
    className={cn('min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[13px]', className)}>
    {children}
  </div>
)

const MenuButton = ({
  children,
  className,
  ...props
}: PropsWithChildren<{} & React.HTMLAttributes<HTMLDivElement>>) => (
  <div
    {...props}
    className={cn(
      'absolute top-1.5 right-2.25 flex h-5.5 min-h-5.5 min-w-5.5 flex-row items-center justify-center rounded-[11px] border-(--color-border) border-[0.5px] bg-(--color-background) px-1.25',
      className
    )}>
    {children}
  </div>
)

export default memo(AssistantItem)
