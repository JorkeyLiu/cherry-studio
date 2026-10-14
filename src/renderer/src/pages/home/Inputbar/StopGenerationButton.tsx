import ComposerIconButton from '@renderer/components/Buttons/ComposerIconButton'
import { Tooltip } from 'antd'
import { CirclePause } from 'lucide-react'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'

interface Props {
  onStop?: () => void
}

/**
 * Composer stop control. Rendered in the same action slot as the send
 * control while a generation is in flight (the two are mutually exclusive).
 * Click invokes the original pause/cancel path; no disabled state — the
 * button only exists while stopping is meaningful.
 */
const StopGenerationButton: FC<Props> = ({ onStop }) => {
  const { t } = useTranslation()

  return (
    <Tooltip placement="top" title={t('chat.input.pause')} mouseLeaveDelay={0} arrow>
      <ComposerIconButton
        onClick={onStop}
        style={{ marginRight: -2 }}
        aria-label={t('chat.input.pause')}
        data-testid="stop-generation-button">
        {/* Inline style (not the `color` prop): the wrapper pins glyph color via stylesheet,
            which beats lucide presentation attributes but loses to inline style. */}
        <CirclePause size={16} style={{ color: 'var(--color-error)' }} />
      </ComposerIconButton>
    </Tooltip>
  )
}

export default StopGenerationButton
