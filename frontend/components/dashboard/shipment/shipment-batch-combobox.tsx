'use client'

import * as React from 'react'

import { Combobox, type ComboboxOption } from '@/components/ui/combobox'
import { WarmButton } from '@/components/dashboard-v2/warm-ledger/controls'
import { useNotifications } from '@/components/notifications'
import { cn } from '@/lib/utils'

const API_BASE = '/api/backend'

interface ShipmentBatchComboboxProps {
  value: string
  onChange: (value: string) => void
  projectId: string
  country: string
  placeholder?: string
  disabled?: boolean
  className?: string
  wrapperClassName?: string
  errorClassName?: string
  triggerClassName?: string
  contentClassName?: string
  showClearButton?: boolean
  triggerGroupClassName?: string
  clearButtonClassName?: string
  portalContainer?: HTMLElement | null
  testId?: string
}

export function ShipmentBatchCombobox({
  value,
  onChange,
  projectId,
  country,
  placeholder = '选择或输入发货批次',
  disabled = false,
  className,
  wrapperClassName,
  errorClassName,
  triggerClassName,
  contentClassName,
  showClearButton = false,
  triggerGroupClassName,
  clearButtonClassName,
  portalContainer,
  testId,
}: ShipmentBatchComboboxProps) {
  const { notify } = useNotifications()
  const [batches, setBatches] = React.useState<string[]>([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const fetchKey = `${projectId}::${country}`

  const refetch = React.useCallback(async () => {
    if (!projectId || !country) {
      setBatches([])
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    const params = new URLSearchParams({ project_id: projectId, country })
    try {
      const res = await fetch(
        `${API_BASE}/api/v1/shipment-schedules/batches?${params.toString()}`,
        { credentials: 'include' }
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { batches?: string[] }
      setBatches(Array.isArray(data.batches) ? data.batches : [])
    } catch (loadError) {
      setBatches([])
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setLoading(false)
    }
  }, [projectId, country])

  React.useEffect(() => {
    void refetch()
  }, [refetch, fetchKey])

  const handleHide = React.useCallback(
    async (batch: string) => {
      setBatches((current) => current.filter((b) => b !== batch))
      try {
        const res = await fetch(`${API_BASE}/api/v1/shipment-schedules/batches/hidden`, {
          method: 'DELETE',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project_id: Number(projectId),
            country,
            shipment_batch: batch,
          }),
        })
        if (!res.ok) {
          await refetch()
          notify({
            type: 'error',
            title: '隐藏失败',
            message: `HTTP ${res.status}`,
          })
        }
      } catch (err) {
        await refetch()
        notify({
          type: 'error',
          title: '隐藏失败',
          message: err instanceof Error ? err.message : String(err),
        })
      }
    },
    [projectId, country, refetch, notify]
  )

  const handleChange = React.useCallback(
    (next: string) => {
      onChange(next)
      if (next && !batches.includes(next)) {
        setBatches((current) => [next, ...current.filter((b) => b !== next)])
      }
    },
    [batches, onChange]
  )

  const options = React.useMemo<ComboboxOption[]>(
    () =>
      batches.map((batch) => ({
        value: batch,
        label: batch,
        onHide: () => void handleHide(batch),
      })),
    [batches, handleHide]
  )

  const isDisabled = disabled || !projectId || !country

  const combobox = (
    <Combobox
      value={value}
      onChange={handleChange}
      options={options}
      placeholder={placeholder}
      emptyText={
        loading
          ? '加载中…'
          : error
            ? ''
            : !projectId
              ? '请先选择项目'
              : !country
                ? '请先选择国家'
                : '暂无历史批次，可直接输入新批次'
      }
      searchPlaceholder="搜索或输入新批次…"
      allowFreeInput
      disabled={isDisabled}
      className={cn(className, contentClassName)}
      triggerClassName={cn(className, triggerClassName)}
      showClearButton={showClearButton}
      triggerGroupClassName={triggerGroupClassName}
      clearButtonClassName={clearButtonClassName}
      portalContainer={portalContainer}
      testId={testId}
    />
  )
  const errorNotice = error ? (
    <div className={errorClassName} role="alert">
      <span>历史批次加载失败：{error}</span>
      <WarmButton onClick={() => void refetch()} loading={loading}>
        重试
      </WarmButton>
    </div>
  ) : null

  if (!wrapperClassName) {
    return (
      <>
        {errorNotice}
        {combobox}
      </>
    )
  }

  return (
    <div className={wrapperClassName}>
      {errorNotice}
      {combobox}
    </div>
  )
}
