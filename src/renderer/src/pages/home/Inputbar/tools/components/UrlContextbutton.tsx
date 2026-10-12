import { ActionIconButton } from '@renderer/components/Buttons'
import { useAssistant } from '@renderer/hooks/useAssistant'
import { useTimer } from '@renderer/hooks/useTimer'
import { Tooltip } from 'antd'
import { Link } from 'lucide-react'
import type { FC } from 'react'
import { memo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'

interface Props {
  assistantId: string
}

const UrlContextButton: FC<Props> = ({ assistantId }) => {
  const { t } = useTranslation()
  const { assistant, updateAssistant } = useAssistant(assistantId)
  const { setTimeoutTimer } = useTimer()

  const urlContentNewState = !assistant.enableUrlContext

  const handleToggle = useCallback(() => {
    setTimeoutTimer(
      'handleToggle',
      () => {
        updateAssistant({ ...assistant, enableUrlContext: urlContentNewState })
      },
      100
    )
  }, [setTimeoutTimer, assistant, urlContentNewState, updateAssistant])

  return (
    <Tooltip placement="top" title={t('chat.input.url_context')} arrow>
      <ActionIconButton
        onClick={handleToggle}
        active={assistant.enableUrlContext}
        aria-label={t('chat.input.url_context')}
        aria-pressed={assistant.enableUrlContext}>
        <Link size={18} />
      </ActionIconButton>
    </Tooltip>
  )
}

export default memo(UrlContextButton)
