import { useTheme } from '@renderer/context/ThemeProvider'
import { ModelList } from '@renderer/pages/settings/ProviderSettings/ModelList'
import type { FC } from 'react'

import { SettingContainer } from '..'
import ProviderConfigPane from './ProviderConfigPane'

interface Props {
  providerId: string
}

/**
 * Provider settings content area for the resolved connection: one continuous
 * pane, configuration sections (API key, request host) above the model list.
 *
 * The pane itself is the flow owner — `SettingContainer` is a full-width
 * vertical stack — so the existing model list toolbar and its group stack are
 * stacked blocks that span the content width, and there is no separate
 * configuration navigation or tab shell.
 */
const ProviderSetting: FC<Props> = ({ providerId }) => {
  const { theme } = useTheme()

  return (
    <SettingContainer theme={theme} data-testid="provider-content">
      <ProviderConfigPane providerId={providerId} />
      <ModelList providerId={providerId} />
    </SettingContainer>
  )
}

export default ProviderSetting
