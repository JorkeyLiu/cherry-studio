import CopyIcon from '@renderer/components/Icons/CopyIcon'
import { getModelMetadataForDisplay } from '@renderer/config/models/modelMetadata'
import { useModelMetadataStatus } from '@renderer/hooks/useModelMetadataStatus'
import type { Model, Provider } from '@renderer/types'
import { getDefaultGroupName } from '@renderer/utils'
import { getModelMetadataDisplayName, isDefaultModelNameForEdit } from '@renderer/utils/modelDisplayName'
import type { ModalProps } from 'antd'
import { Button, Flex, Form, Input, message, Modal } from 'antd'
import { SaveIcon } from 'lucide-react'
import type { FC } from 'react'
import { useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import ModelCapabilityGroups, { hasKnownFeatures, hasKnownInputModalities } from './ModelCapabilityGroups'
import ModelMetadataReference, { hasConcreteModelData } from './ModelMetadataReference'

export { isDefaultModelNameForEdit }

interface ModelEditContentProps {
  provider: Provider
  model: Model
  onUpdateModel: (model: Model) => void
}

/**
 * Read-only model editor: id/name/group stay editable; capabilities and
 * model data are information-only. Capability groups read the exact
 * models.dev entry only (never persisted ModelType predicates). Save submits
 * id/name/group and preserves every unshown field (capabilities,
 * supported_text_delta, pricing, endpoint_type/supported_endpoint_types, ...)
 * exactly as stored — never cleared, zeroed, or rewritten from display state.
 */
const ModelEditContent: FC<ModelEditContentProps & ModalProps> = ({ provider, model, onUpdateModel, ...props }) => {
  const [form] = Form.useForm()
  const { t } = useTranslation()
  // Reactive registry status: subscribing re-renders this open popup when the
  // async init/refresh round completes, and drives the all-empty state below.
  const metadataStatus = useModelMetadataStatus()

  // Effective model metadata for display: exact serving entry wins, canonical
  // fills only missing fields (serving and canonical are never merged as one
  // identity; the helper keeps sources distinct and the reference below shows
  // which source contributed).
  const display = useMemo(
    () => getModelMetadataForDisplay(model, provider),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, provider, metadataStatus]
  )
  const entry = display.effective
  const metadataName = useMemo(
    () => getModelMetadataDisplayName(model, provider),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, provider, metadataStatus, display.effective?.name]
  )

  // Enrichment-only: metadata may update only form state, never Redux/Model
  // directly. Track user edits to avoid overwriting typing.
  const nameDirtyRef = useRef(false)
  useEffect(() => {
    // Reset dirty when the edited model identity changes (popup reused).
    nameDirtyRef.current = false
  }, [model.id])

  // Async enrichment: when metadata arrives while the popup is open, update
  // the name only if the form has not been user-modified and still qualifies
  // as a default ID-like name. Reuses the already resolved display name
  // rather than adding identity heuristics.
  useEffect(() => {
    if (!metadataName) return
    if (nameDirtyRef.current) return
    const current = form.getFieldValue('name') as string | undefined
    // Fallback to persisted value before form init completes.
    const curName = current !== undefined ? current : model.name
    if (isDefaultModelNameForEdit(curName, model.id)) {
      if ((curName ?? '').trim() !== metadataName) {
        form.setFieldsValue({ name: metadataName })
      }
    }
  }, [metadataName, model.id, model.name, form])

  // All three metadata groups empty: one status line, never per-group hints.
  // A cached snapshot means ready even for an unknown model id.
  const allMetadataEmpty = !hasKnownInputModalities(entry) && !hasKnownFeatures(entry) && !hasConcreteModelData(entry)
  const emptyStateKey =
    metadataStatus.kind === 'loading'
      ? 'models.reference.loading'
      : metadataStatus.kind === 'unavailable'
        ? 'models.reference.unavailable'
        : 'models.reference.no_data'

  const onFinish = (values: any) => {
    const updatedModel: Model = {
      ...model,
      id: values.id || model.id,
      name: values.name || model.name,
      group: values.group || model.group
    }
    onUpdateModel(updatedModel)
    props.onOk?.(undefined as any)
  }

  return (
    <Modal
      title={t('models.edit')}
      transitionName="animation-move-down"
      centered
      {...props}
      footer={
        <Flex justify="flex-end" align="center" gap={8}>
          <Button onClick={(e) => props.onCancel?.(e as any)}>{t('common.cancel')}</Button>
          <Button type="primary" icon={<SaveIcon size={16} />} onClick={() => form.submit()}>
            {t('common.save')}
          </Button>
        </Flex>
      }>
      <Form
        form={form}
        labelCol={{ flex: '110px' }}
        labelAlign="left"
        colon={false}
        style={{ marginTop: 15 }}
        initialValues={{
          id: model.id,
          name: isDefaultModelNameForEdit(model.name, model.id) && metadataName ? metadataName : model.name,
          group: model.group
        }}
        onFinish={onFinish}
        onValuesChange={(changed) => {
          if (changed && typeof changed === 'object' && 'name' in changed) {
            nameDirtyRef.current = true
          }
        }}>
        <Form.Item name="id" label={t('settings.models.add.model_id.label')} rules={[{ required: true }]}>
          <Flex justify="space-between" gap={5}>
            <Input
              placeholder={t('settings.models.add.model_id.placeholder')}
              spellCheck={false}
              maxLength={200}
              disabled={true}
              value={model.id}
              onChange={(e) => {
                const value = e.target.value
                form.setFieldValue('name', value)
                form.setFieldValue('group', getDefaultGroupName(value))
              }}
              suffix={
                <CopyIcon
                  size={14}
                  style={{ cursor: 'pointer' }}
                  onClick={() => {
                    const val = form.getFieldValue('name')
                    void navigator.clipboard.writeText((val.id || model.id) as string)
                    message.success(t('message.copied'))
                  }}
                />
              }
            />
          </Flex>
        </Form.Item>
        <Form.Item name="name" label={t('settings.models.add.model_name.label')}>
          <Input placeholder={t('settings.models.add.model_name.placeholder')} spellCheck={false} />
        </Form.Item>
        <Form.Item name="group" label={t('settings.models.add.group_name.label')}>
          <Input placeholder={t('settings.models.add.group_name.placeholder')} spellCheck={false} />
        </Form.Item>
      </Form>
      <ModelCapabilityGroups entry={entry} />
      <ModelMetadataReference entry={entry} />
      {allMetadataEmpty && <MetadataEmpty data-testid="model-metadata-empty">{t(emptyStateKey)}</MetadataEmpty>}
    </Modal>
  )
}

const MetadataEmpty = styled.div`
  margin-top: 4px;
  font-size: 12px;
  font-weight: 400;
  line-height: 1.5;
  color: var(--color-text-2);
`

export default ModelEditContent
