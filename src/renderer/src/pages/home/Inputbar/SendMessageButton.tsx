import ComposerIconButton from '@renderer/components/Buttons/ComposerIconButton'
import { Tooltip } from 'antd'
import { Send } from 'lucide-react'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'

interface Props {
  disabled: boolean
  sendMessage: () => void
}

/**
 * Composer send control. Native `disabled` carries the enabled/disabled
 * constraint (unfocusable + no click synthesis while disabled); keyboard
 * activation relies solely on native button Enter/Space synthesis, so each
 * of click/Enter/Space fires `sendMessage` exactly once. Enabled glyph uses
 * `tone="primary"` (`var(--color-primary)`); disabled falls back to
 * `var(--color-text-3)` via the shared composer wrapper.
 */
const SendMessageButton: FC<Props> = ({ disabled, sendMessage }) => {
  const { t } = useTranslation()

  return (
    <Tooltip placement="top" title={t('chat.input.send')} mouseLeaveDelay={0} arrow>
      <ComposerIconButton
        tone="primary"
        onClick={sendMessage}
        disabled={disabled}
        aria-label={t('chat.input.send')}
        data-testid="send-message-button">
        <Send size={16} />
      </ComposerIconButton>
    </Tooltip>
  )
}

export default SendMessageButton
