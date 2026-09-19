import CollapsibleSearchBar from '@renderer/components/CollapsibleSearchBar'
import { LoadingIcon, StreamlineGoodHealthAndWellBeing } from '@renderer/components/Icons'
import { HStack } from '@renderer/components/Layout'
import CustomTag from '@renderer/components/Tags/CustomTag'
import { useProvider } from '@renderer/hooks/useProvider'
import { SettingSubtitle } from '@renderer/pages/settings'
import EditModelPopup from '@renderer/pages/settings/ProviderSettings/EditModelPopup/EditModelPopup'
import AddModelPopup from '@renderer/pages/settings/ProviderSettings/ModelList/AddModelPopup'
import ManageModelsPopup from '@renderer/pages/settings/ProviderSettings/ModelList/ManageModelsPopup'
import type { Model } from '@renderer/types'
import { filterModelsByKeywords } from '@renderer/utils'
import { getDuplicateModelNames } from '@renderer/utils/model'
import { Button, Flex, Space, Spin, Tooltip } from 'antd'
import { groupBy, isEmpty, sortBy, toPairs } from 'lodash'
import { Plus, RefreshCw } from 'lucide-react'
import React, { memo, startTransition, useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import ModelListGroup from './ModelListGroup'
import { useHealthCheck } from './useHealthCheck'

interface ModelListProps {
  providerId: string
}

type ModelGroups = Record<string, Model[]>
const MODEL_COUNT_THRESHOLD = 10

/**
 * 根据搜索文本筛选模型、分组并排序
 */
const calculateModelGroups = (models: Model[], searchText: string): ModelGroups => {
  const filteredModels = searchText ? filterModelsByKeywords(searchText, models) : models
  const grouped = groupBy(filteredModels, 'group')
  return sortBy(toPairs(grouped), [0]).reduce((acc, [key, value]) => {
    acc[key] = value
    return acc
  }, {})
}

/**
 * 模型列表组件，用于 CRUD 操作和健康检查
 */
const ModelList: React.FC<ModelListProps> = ({ providerId }) => {
  const { t } = useTranslation()
  const { provider, models, removeModel } = useProvider(providerId)

  // 稳定的编辑模型回调，避免内联函数导致子组件 memo 失效
  const handleEditModel = useCallback((model: Model) => EditModelPopup.show({ provider, model }), [provider])

  const [searchText, _setSearchText] = useState('')
  const [displayedModelGroups, setDisplayedModelGroups] = useState<ModelGroups | null>(() => {
    if (models.length > MODEL_COUNT_THRESHOLD) {
      return null
    }
    return calculateModelGroups(models, '')
  })

  const { isChecking: isHealthChecking, modelStatuses, runHealthCheck } = useHealthCheck(provider, models)
  const duplicateModelNames = useMemo(() => getDuplicateModelNames(models), [models])

  // 将 modelStatuses 数组转换为 Map，实现 O(1) 查找
  const modelStatusMap = useMemo(() => {
    return new Map(modelStatuses.map((status) => [status.model.id, status]))
  }, [modelStatuses])

  const setSearchText = useCallback((text: string) => {
    startTransition(() => {
      _setSearchText(text)
    })
  }, [])

  useEffect(() => {
    if (models.length > MODEL_COUNT_THRESHOLD) {
      startTransition(() => {
        setDisplayedModelGroups(calculateModelGroups(models, searchText))
      })
    } else {
      setDisplayedModelGroups(calculateModelGroups(models, searchText))
    }
  }, [models, searchText])

  const modelCount = useMemo(() => {
    return Object.values(displayedModelGroups ?? {}).reduce((acc, group) => acc + group.length, 0)
  }, [displayedModelGroups])

  const onManageModel = useCallback(() => {
    void ManageModelsPopup.show({ providerId: provider.id })
  }, [provider.id])

  const onAddModel = useCallback(() => {
    // Generic model add flow for all approved protocols. Unknown/manual
    // models remain editable/requestable via the same popup.
    void AddModelPopup.show({ title: t('settings.models.add.add_model'), provider })
  }, [provider, t])

  const isLoading = useMemo(() => displayedModelGroups === null, [displayedModelGroups])
  const hasNoModels = useMemo(() => models.length === 0, [models.length])

  const actionButtons = (
    <Space.Compact>
      <Button onClick={onManageModel} icon={<RefreshCw size={16} />} disabled={isHealthChecking}>
        {t('settings.models.manage.fetch_list')}
      </Button>
      <Tooltip title={t('button.add')} mouseLeaveDelay={0}>
        <Button onClick={onAddModel} icon={<Plus size={16} />} disabled={isHealthChecking} />
      </Tooltip>
    </Space.Compact>
  )

  return (
    <>
      <SettingSubtitle style={{ marginBottom: 12 }}>
        <HStack alignItems="center" justifyContent="space-between" style={{ width: '100%' }}>
          <HStack alignItems="center" gap={8}>
            <SettingSubtitle style={{ marginTop: 0 }}>{t('common.models')}</SettingSubtitle>
            <CustomTag color="#8c8c8c" size={10}>
              {modelCount}
            </CustomTag>
            {!hasNoModels && (
              <>
                <Tooltip title={t('settings.models.check.button_caption')} mouseLeaveDelay={0}>
                  <Button
                    type="text"
                    onClick={runHealthCheck}
                    icon={
                      <StreamlineGoodHealthAndWellBeing
                        size={16}
                        isActive={isHealthChecking}
                        color="var(--color-icon)"
                      />
                    }
                  />
                </Tooltip>
                <CollapsibleSearchBar
                  onSearch={setSearchText}
                  placeholder={t('models.search.placeholder')}
                  tooltip={t('models.search.tooltip')}
                />
              </>
            )}
          </HStack>
          {actionButtons}
        </HStack>
      </SettingSubtitle>
      <Spin spinning={isLoading} indicator={<LoadingIcon color="var(--color-text-2)" />}>
        {displayedModelGroups && !isEmpty(displayedModelGroups) && (
          <Flex gap={12} vertical>
            {Object.keys(displayedModelGroups).map((group, i) => (
              <ModelListGroup
                key={group}
                groupName={group}
                models={displayedModelGroups[group]}
                provider={provider}
                duplicateModelNames={duplicateModelNames}
                modelStatusMap={modelStatusMap}
                defaultOpen={i <= 5}
                onEditModel={handleEditModel}
                onRemoveModel={removeModel}
                onRemoveGroup={() => displayedModelGroups[group].forEach((model) => removeModel(model))}
              />
            ))}
          </Flex>
        )}
      </Spin>
      <Flex justify="space-between" align="center">
        <div style={{ height: 5 }} />
      </Flex>
    </>
  )
}

export default memo(ModelList)
