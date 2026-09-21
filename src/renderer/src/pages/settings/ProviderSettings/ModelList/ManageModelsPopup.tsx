import { loggerService } from '@logger'
import { LoadingIcon } from '@renderer/components/Icons'
import { HStack } from '@renderer/components/Layout'
import { TopView } from '@renderer/components/TopView'
import { useModelMetadataStatus } from '@renderer/hooks/useModelMetadataStatus'
import { useProvider } from '@renderer/hooks/useProvider'
import { fetchModels } from '@renderer/services/ApiService'
import type { Model, Provider } from '@renderer/types'
import { getFancyProviderName } from '@renderer/utils'
import { INPUT_MODALITIES, type InputModality } from '@renderer/utils/inputModalities'
import { getNormalizedInputModalitySet } from '@renderer/utils/inputModalities'
import { includeKeywords } from '@renderer/utils/match'
import { getDuplicateModelNames } from '@renderer/utils/model'
import { getModelMetadataDisplayName, isDefaultModelName } from '@renderer/utils/modelDisplayName'
import { getModelPresentation } from '@renderer/utils/modelPresentation'
import { Button, Empty, Flex, Modal, Spin, Tabs, Tooltip } from 'antd'
import Input from 'antd/es/input/Input'
import { groupBy, isEmpty, uniqBy } from 'lodash'
import { debounce } from 'lodash'
import { ListMinus, ListPlus, RefreshCcw, Search } from 'lucide-react'
import { useCallback, useEffect, useMemo, useOptimistic, useRef, useState, useTransition } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import ManageModelsList from './ManageModelsList'
import { isModelInProvider } from './utils'

const logger = loggerService.withContext('ManageModelsPopup')

// 管理页签只提供五个精确输入模态，由 INPUT_MODALITIES 单一真相映射。
// 旧能力键（reasoning/vision/free/embedding/function_calling/rerank/
// websearch）为兼容保留、落入 default（全部）；Embedding/Reranker 的业务槽位
// 执行筛选不在此处。
const INPUT_MODALITY_TABS: ReadonlySet<InputModality> = new Set(INPUT_MODALITIES)

/** Static label keys for the five modality tabs; iteration order comes from INPUT_MODALITIES. */
const MODALITY_TAB_LABEL_KEYS: Record<InputModality, string> = {
  text: 'models.capabilities.modality_text',
  image: 'models.capabilities.modality_image',
  audio: 'models.capabilities.modality_audio',
  video: 'models.capabilities.modality_video',
  pdf: 'models.capabilities.modality_pdf'
}

interface ShowParams {
  providerId: string
}

interface Props extends ShowParams {
  resolve: (data: any) => void
}

const PopupContainer: React.FC<Props> = ({ providerId, resolve }) => {
  const [open, setOpen] = useState(true)
  const { provider, models, addModel, removeModel } = useProvider(providerId)
  const [listModels, setListModels] = useState<Model[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [searchText, setSearchText] = useState('')
  const [filterSearchText, setFilterSearchText] = useState('')
  const debouncedSetFilterText = useMemo(
    () =>
      debounce((value: string) => {
        startSearchTransition(() => {
          setFilterSearchText(value)
        })
      }, 300),
    []
  )
  useEffect(() => {
    return () => {
      debouncedSetFilterText.cancel()
    }
  }, [debouncedSetFilterText])
  const [actualFilterType, setActualFilterType] = useState<string>('all')
  const [optimisticFilterType, setOptimisticFilterTypeFn] = useOptimistic(
    actualFilterType,
    (_currentFilterType, newFilterType: string) => newFilterType
  )
  const [isSearchPending, startSearchTransition] = useTransition()
  const [isFilterTypePending, startFilterTypeTransition] = useTransition()
  const { t, i18n } = useTranslation()
  const searchInputRef = useRef<any>(null)

  // Custom-connection product: Manage Models combines only user-stored
  // models plus protocol listModels results. Built-in defaults are never
  // merged; unknown/manual models remain editable/requestable.
  const allModels = useMemo(() => uniqBy([...listModels, ...models], 'id'), [listModels, models])
  const duplicateModelNames = useMemo(() => getDuplicateModelNames(allModels), [allModels])

  // Subscribe to metadata status so late snapshot arrival updates the open popup.
  const metadataStatus = useModelMetadataStatus()

  // Derive readonly presentation views from projection; do not mutate raw fetched state.
  // Single metadata call per model drives both displayName and effective modalities/tags.
  const presentationMap = useMemo(() => {
    const map = new Map<string, ReturnType<typeof getModelPresentation>>()
    for (const m of allModels) {
      map.set(m.id, getModelPresentation(m, provider))
    }
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps -- provider identity pins attribution; metadataStatus triggers re-render on snapshot change
  }, [allModels, provider?.id, metadataStatus])

  const viewModels = useMemo(() => {
    return allModels.map((m) => {
      const p = presentationMap.get(m.id)
      if (p && p.displayName !== m.name) {
        return { ...m, name: p.displayName }
      }
      return m
    })
  }, [allModels, presentationMap])

  const isLoading = useMemo(
    () => loadingModels || isFilterTypePending || isSearchPending,
    [loadingModels, isFilterTypePending, isSearchPending]
  )

  // 管理页签只提供五个精确输入模态（unknown 永不出现）。
  // Filtering uses the same presentation effective for modalities so list/tags never diverge.
  const list = useMemo(() => {
    let filtered = viewModels
    if (filterSearchText.trim()) {
      const kw = filterSearchText.toLowerCase().split(/\s+/).filter(Boolean)
      filtered = filtered.filter((model) => {
        const p = presentationMap.get(model.id)
        const displayName = p?.displayName ?? model.name
        // ID-aware search: displayName + exact id + provider name/id (decoupled from rendered name)
        const searchText = `${displayName} ${model.id} ${provider ? `${provider.name} ${provider.id}` : ''}`
        return includeKeywords(searchText, kw)
      })
    }
    if ((INPUT_MODALITY_TABS as ReadonlySet<string>).has(actualFilterType)) {
      const modality = actualFilterType as InputModality
      filtered = filtered.filter((model) => {
        const p = presentationMap.get(model.id)
        const effective = p?.effective
        if (!effective) return false
        const present = getNormalizedInputModalitySet(effective)
        return present.has(modality)
      })
    }
    return filtered
  }, [filterSearchText, actualFilterType, viewModels, presentationMap, provider])

  // Generic grouping for all connections; no brand-specific paths.
  const modelGroups = useMemo(() => groupBy(list, 'group'), [list])

  const onOk = useCallback(() => setOpen(false), [])

  const onCancel = useCallback(() => setOpen(false), [])

  const onClose = useCallback(() => resolve({}), [resolve])

  const onAddModel = useCallback(
    (model: Model) => {
      // Generic add flow for all approved protocols. Re-resolve from the
      // current snapshot at add time (not fetch time) and only replace when
      // the fetched name is a fallback (trimmed name === trimmed id) so real
      // provider display names (e.g. Gemini) are preserved. Metadata is
      // enrichment-only: absence/unknown never blocks add. Preserve exact ID/group.
      if (isEmpty(model.name)) {
        return
      }
      // Use raw fetched state for fallback detection, not the presented viewModel name.
      const raw = allModels.find((m) => m.id === model.id) ?? model
      const isFallbackIdName = isDefaultModelName(raw.name, raw.id)
      let finalModel = model
      if (isFallbackIdName) {
        const metaName = getModelMetadataDisplayName(raw, provider)
        if (metaName) {
          finalModel = { ...raw, name: metaName, group: raw.group, id: raw.id, provider: raw.provider }
        } else {
          finalModel = raw
        }
      } else {
        // Real provider display name wins — preserve exact ID/group/provider.
        finalModel = raw
      }
      addModel(finalModel)
    },
    [addModel, provider, allModels]
  )

  const onRemoveModel = useCallback((model: Model) => removeModel(model), [removeModel])

  const onRemoveAll = useCallback(() => {
    list.filter((model) => isModelInProvider(provider, model.id)).forEach(onRemoveModel)
  }, [list, onRemoveModel, provider])

  const onAddAll = useCallback(() => {
    const wouldAddModel = list.filter((model) => !isModelInProvider(provider, model.id))
    window.modal.confirm({
      title: t('settings.models.manage.add_listed.label'),
      content: t('settings.models.manage.add_listed.confirm'),
      centered: true,
      onOk: () => {
        wouldAddModel.forEach(onAddModel)
      }
    })
  }, [list, onAddModel, provider, t])

  const loadModels = useCallback(async (provider: Provider) => {
    setLoadingModels(true)
    try {
      const models = await fetchModels(provider)
      const filteredModels = models.filter((model) => !isEmpty(model.name))
      setListModels(filteredModels)
    } catch (error) {
      logger.error(`Failed to load models for provider ${getFancyProviderName(provider)}`, error as Error)
    } finally {
      setLoadingModels(false)
    }
  }, [])

  useEffect(() => {
    void loadModels(provider)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (open && searchInputRef.current) {
      const timer = setTimeout(() => {
        searchInputRef.current?.focus()
      }, 350)

      return () => {
        clearTimeout(timer)
      }
    }
    return
  }, [open])

  const ModalHeader = () => {
    return (
      <Flex>
        <ModelHeaderTitle>
          {getFancyProviderName(provider)}
          {i18n.language.startsWith('zh') ? '' : ' '}
          {t('common.models')}
        </ModelHeaderTitle>
      </Flex>
    )
  }

  const renderTopTools = useCallback(() => {
    const isAllFilteredInProvider = list.length > 0 && list.every((model) => isModelInProvider(provider, model.id))

    return (
      <HStack gap={8}>
        <Tooltip
          title={
            isAllFilteredInProvider
              ? t('settings.models.manage.remove_listed')
              : t('settings.models.manage.add_listed.label')
          }
          mouseLeaveDelay={0}>
          <Button
            type="default"
            icon={isAllFilteredInProvider ? <ListMinus size={18} /> : <ListPlus size={18} />}
            size="large"
            onClick={(e) => {
              e.stopPropagation()
              isAllFilteredInProvider ? onRemoveAll() : onAddAll()
            }}
            disabled={loadingModels || list.length === 0}
          />
        </Tooltip>
        <Tooltip title={t('settings.models.manage.refetch_list')} mouseLeaveDelay={0}>
          <Button
            type="default"
            icon={<RefreshCcw size={16} />}
            size="large"
            onClick={() => loadModels(provider)}
            disabled={loadingModels}
          />
        </Tooltip>
      </HStack>
    )
  }, [list, t, loadingModels, provider, onRemoveAll, onAddAll, loadModels])

  return (
    <Modal
      title={<ModalHeader />}
      open={open}
      onOk={onOk}
      onCancel={onCancel}
      afterClose={onClose}
      footer={null}
      width="800px"
      transitionName="animation-move-down"
      styles={{
        body: {
          overflowY: 'hidden'
        }
      }}
      centered>
      <SearchContainer>
        <TopToolsWrapper>
          <Input
            prefix={<Search size={16} style={{ marginRight: 4 }} />}
            size="large"
            ref={searchInputRef}
            placeholder={t('settings.provider.search_placeholder')}
            allowClear
            value={searchText}
            onChange={(e) => {
              const newSearchValue = e.target.value
              setSearchText(newSearchValue) // Update input field immediately
              debouncedSetFilterText(newSearchValue)
            }}
            disabled={loadingModels}
          />
          {renderTopTools()}
        </TopToolsWrapper>
        <Tabs
          size={i18n.language.startsWith('zh') ? 'middle' : 'small'}
          defaultActiveKey="all"
          activeKey={optimisticFilterType}
          items={[
            { label: t('models.all'), key: 'all' },
            ...INPUT_MODALITIES.map((modality) => ({
              label: t(MODALITY_TAB_LABEL_KEYS[modality]),
              key: modality
            }))
          ]}
          onChange={(key) => {
            setOptimisticFilterTypeFn(key)
            startFilterTypeTransition(() => {
              setActualFilterType(key)
            })
          }}
        />
      </SearchContainer>
      <Spin
        spinning={isLoading}
        indicator={<LoadingIcon color="var(--color-text-2)" style={{ opacity: loadingModels ? 1 : 0 }} />}>
        <ListContainer>
          {loadingModels || isEmpty(list) ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={t('settings.models.empty')}
              style={{
                visibility: loadingModels ? 'hidden' : 'visible',
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                height: '100%',
                margin: '0'
              }}
            />
          ) : (
            <ManageModelsList
              modelGroups={modelGroups}
              duplicateModelNames={duplicateModelNames}
              provider={provider}
              onAddModel={onAddModel}
              onRemoveModel={onRemoveModel}
            />
          )}
        </ListContainer>
      </Spin>
    </Modal>
  )
}

const SearchContainer = styled.div`
  display: flex;
  flex-direction: column;
  gap: 5px;

  .ant-radio-group {
    display: flex;
    flex-wrap: wrap;
  }
`

const TopToolsWrapper = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  margin-bottom: 0;
`

const ListContainer = styled.div`
  height: calc(90vh - 300px);
`

const ModelHeaderTitle = styled.div`
  color: var(--color-text);
  font-size: 18px;
  font-weight: 600;
  margin-right: 10px;
`

const TopViewKey = 'ManageModelsPopup'

export default class ManageModelsPopup {
  static topviewId = 0
  static hide() {
    TopView.hide(TopViewKey)
  }
  static show(props: ShowParams) {
    return new Promise<any>((resolve) => {
      TopView.show(
        <PopupContainer
          {...props}
          resolve={(v) => {
            resolve(v)
            this.hide()
          }}
        />,
        TopViewKey
      )
    })
  }
}
