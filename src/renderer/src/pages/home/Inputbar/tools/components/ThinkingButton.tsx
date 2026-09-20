import { ActionIconButton } from '@renderer/components/Buttons'
import {
  MdiLightbulbAutoOutline,
  MdiLightbulbOffOutline,
  MdiLightbulbOn,
  MdiLightbulbOn30,
  MdiLightbulbOn50,
  MdiLightbulbOn80,
  MdiLightbulbOn90,
  MdiLightbulbQuestion
} from '@renderer/components/Icons/SVGIcon'
import { getModelSupportedReasoningEffortOptions } from '@renderer/config/models'
import { useAssistant } from '@renderer/hooks/useAssistant'
import ToolPopover from '@renderer/pages/home/Inputbar/components/ToolPopover'
import type { Model, ThinkingOption } from '@renderer/types'
import { getModelReasoningEffortKey } from '@renderer/types'
import { Divider, Switch, Tooltip } from 'antd'
import { Check } from 'lucide-react'
import type { FC, ReactElement } from 'react'
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

interface Props {
  model: Model
  assistantId: string
}

const FULL_OPTIONS: ThinkingOption[] = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'auto']

const ThinkingButton: FC<Props> = ({ model, assistantId }): ReactElement => {
  const { t } = useTranslation()
  const { assistant, updateAssistantSettings } = useAssistant(assistantId)
  const [open, setOpen] = useState(false)

  const currentReasoningEffort: ThinkingOption = useMemo(() => {
    return (assistant.settings?.reasoning_effort as ThinkingOption) || 'default'
  }, [assistant.settings?.reasoning_effort])

  const modelKey = useMemo(() => getModelReasoningEffortKey(model), [model])
  const showAllByModel = assistant.settings?.reasoning_effort_show_all_by_model ?? {}
  const showAll = modelKey ? (showAllByModel[modelKey] ?? false) : false

  const resolvedOptions: ThinkingOption[] = useMemo(() => {
    return (
      (getModelSupportedReasoningEffortOptions(model) as ThinkingOption[]) ?? [
        'default',
        'none',
        'low',
        'medium',
        'high'
      ]
    )
  }, [model])

  const displayOptions: ThinkingOption[] = useMemo(() => {
    if (showAll) return FULL_OPTIONS
    // default view: resolver options + current if missing (so selection not reset)
    const base = [...resolvedOptions]
    if (!base.includes(currentReasoningEffort)) {
      base.push(currentReasoningEffort)
    }
    return base
  }, [showAll, resolvedOptions, currentReasoningEffort])

  const onThinkingChange = useCallback(
    (option: ThinkingOption) => {
      const thinkModeEnabled = option !== 'none' && option !== 'default'
      const key = getModelReasoningEffortKey(model)
      const currentMap = assistant.settings?.reasoning_effort_by_model ?? {}
      updateAssistantSettings({
        reasoning_effort: option,
        reasoning_effort_by_model: key ? { ...currentMap, [key]: option } : currentMap,
        reasoning_effort_cache: option,
        qwenThinkMode: thinkModeEnabled
      })
      setOpen(false)
    },
    [updateAssistantSettings, assistant.settings?.reasoning_effort_by_model, model]
  )

  const handleShowAllToggle = useCallback(
    (checked: boolean) => {
      const key = getModelReasoningEffortKey(model)
      if (!key) return
      const currentMap = assistant.settings?.reasoning_effort_show_all_by_model ?? {}
      updateAssistantSettings({
        reasoning_effort_show_all_by_model: { ...currentMap, [key]: checked }
      })
      // must not change reasoning_effort
    },
    [model, assistant.settings?.reasoning_effort_show_all_by_model, updateAssistantSettings]
  )

  const reasoningEffortOptionLabelMap = {
    default: t('assistants.settings.reasoning_effort.default'),
    none: t('assistants.settings.reasoning_effort.off'),
    minimal: t('assistants.settings.reasoning_effort.minimal'),
    high: t('assistants.settings.reasoning_effort.high'),
    low: t('assistants.settings.reasoning_effort.low'),
    medium: t('assistants.settings.reasoning_effort.medium'),
    auto: t('assistants.settings.reasoning_effort.auto'),
    xhigh: t('assistants.settings.reasoning_effort.xhigh')
  } as const satisfies Record<ThinkingOption, string>

  const reasoningEffortDescriptionMap = {
    default: t('assistants.settings.reasoning_effort.default_description'),
    none: t('assistants.settings.reasoning_effort.off_description'),
    minimal: t('assistants.settings.reasoning_effort.minimal_description'),
    low: t('assistants.settings.reasoning_effort.low_description'),
    medium: t('assistants.settings.reasoning_effort.medium_description'),
    high: t('assistants.settings.reasoning_effort.high_description'),
    xhigh: t('assistants.settings.reasoning_effort.xhigh_description'),
    auto: t('assistants.settings.reasoning_effort.auto_description')
  } as const satisfies Record<ThinkingOption, string>

  const isThinkingEnabled = currentReasoningEffort !== 'none' && currentReasoningEffort !== 'default'

  const popoverContent = (
    <ThinkingPopoverInner data-testid="thinking-popover">
      <PopoverHeaderRow>
        <span>{t('assistants.settings.reasoning_effort.label')}</span>
      </PopoverHeaderRow>
      <SwitchRow onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
        <span>{t('chat.input.thinking.show_all', 'Show all')}</span>
        <Switch
          size="small"
          checked={showAll}
          onChange={handleShowAllToggle}
          onClick={(_: boolean, e: any) => e?.stopPropagation?.()}
          data-testid="thinking-show-all-switch"
        />
      </SwitchRow>
      <Divider style={{ margin: '8px 0' }} />
      <OptionsList>
        {displayOptions.map((option) => {
          const isSelected = currentReasoningEffort === option
          return (
            <OptionItem
              key={option}
              $selected={isSelected}
              onClick={(e) => {
                e.stopPropagation()
                onThinkingChange(option)
              }}
              onMouseDown={(e) => e.stopPropagation()}
              data-testid={`thinking-option-${option}`}
              data-selected={isSelected}>
              <OptionLeft>
                <span style={{ display: 'flex', alignItems: 'center' }}>{ThinkingIcon({ option })}</span>
                <span>
                  <OptionLabel>{reasoningEffortOptionLabelMap[option]}</OptionLabel>
                  <OptionDesc>{reasoningEffortDescriptionMap[option]}</OptionDesc>
                </span>
              </OptionLeft>
              {isSelected && <Check size={14} />}
            </OptionItem>
          )
        })}
      </OptionsList>
    </ThinkingPopoverInner>
  )

  const ariaLabel = t('assistants.settings.reasoning_effort.label')

  return (
    <ToolPopover open={open} onOpenChange={setOpen} content={popoverContent}>
      <Tooltip placement="top" title={ariaLabel} mouseLeaveDelay={0} arrow open={open ? false : undefined}>
        <ActionIconButton active={isThinkingEnabled} aria-label={ariaLabel} aria-pressed={isThinkingEnabled}>
          {ThinkingIcon({ option: currentReasoningEffort })}
        </ActionIconButton>
      </Tooltip>
    </ToolPopover>
  )
}

const ThinkingIcon = (props: { option?: ThinkingOption }) => {
  let IconComponent: React.FC<React.SVGProps<SVGSVGElement>> | null = null
  switch (props.option) {
    case 'minimal':
      IconComponent = MdiLightbulbOn30
      break
    case 'low':
      IconComponent = MdiLightbulbOn50
      break
    case 'medium':
      IconComponent = MdiLightbulbOn80
      break
    case 'high':
      IconComponent = MdiLightbulbOn90
      break
    case 'xhigh':
      IconComponent = MdiLightbulbOn
      break
    case 'auto':
      IconComponent = MdiLightbulbAutoOutline
      break
    case 'none':
      IconComponent = MdiLightbulbOffOutline
      break
    case 'default':
    default:
      IconComponent = MdiLightbulbQuestion
      break
  }

  return <IconComponent className="icon" width={18} height={18} style={{ marginTop: -2 }} />
}

const ThinkingPopoverInner = styled.div`
  width: 100%;
`

const PopoverHeaderRow = styled.div`
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 8px;
`

const SwitchRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
`

const OptionsList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 260px;
  overflow-y: auto;
`

const OptionItem = styled.div<{ $selected?: boolean }>`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  background: ${(p) => (p.$selected ? 'var(--color-background-soft)' : 'transparent')};
  &:hover {
    background: var(--color-background-soft);
  }
`

const OptionLeft = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
`

const OptionLabel = styled.div`
  font-size: 13px;
  line-height: 1;
`

const OptionDesc = styled.div`
  font-size: 11px;
  color: var(--color-text-3);
`

export default ThinkingButton
