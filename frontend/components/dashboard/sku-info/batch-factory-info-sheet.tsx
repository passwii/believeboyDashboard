'use client'

import { useEffect, useState, type ComponentProps } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useNotifications } from '@/components/notifications'
import { useConfirm } from '@/hooks/use-confirm'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Badge } from '@/components/ui/badge'

type ParsedFactoryInfo = Record<string, unknown>

const API_BASE = '/api/backend'

export interface SkuRecordItem {
  id: number
  project_name: string
  sku: string
  asin: string
  fnsku: string | null
  product_name: string | null
  fob_unit_cost: number
  first_leg_cost_rmb: number
  package_length_cm: number
  package_width_cm: number
  package_height_cm: number
  weight_kg: number
  carton_length_cm: number
  carton_width_cm: number
  carton_height_cm: number
  carton_weight_kg: number
  units_per_carton: number
  currency: string
  country: string
  sort_order: number
  is_active: boolean
  sku_factory_info: Record<string, unknown> | null
  sku_factory_info_updated_at: string | null
  sku_factory_info_updated_by: string | null
}

interface BatchFactoryInfoSheetProps {
  open: boolean
  selectedSkus: SkuRecordItem[]
  onClose: () => void
  onSaved: () => void
  portalContainer?: HTMLElement | null
  contentClassName?: string
  onCloseAutoFocus?: ComponentProps<typeof SheetContent>['onCloseAutoFocus']
}

export default function BatchFactoryInfoSheet({
  open,
  selectedSkus,
  onClose,
  onSaved,
  portalContainer,
  contentClassName,
  onCloseAutoFocus,
}: BatchFactoryInfoSheetProps) {
  const { notify } = useNotifications()
  const { confirm } = useConfirm()
  const [description, setDescription] = useState('')
  const [parsedInfo, setParsedInfo] = useState<ParsedFactoryInfo | null>(null)
  const [parsing, setParsing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [rawResponse, setRawResponse] = useState('')

  // 重置状态
  useEffect(() => {
    if (open) {
      setDescription('')
      setParsedInfo(null)
      setRawResponse('')
      setParsing(false)
      setSaving(false)
    }
  }, [open])

  const handleParse = async () => {
    if (!description.trim()) {
      notify({ type: 'warning', title: '请输入产品属性描述' })
      return
    }

    setParsing(true)
    setParsedInfo(null)
    setRawResponse('')

    try {
      const response = await fetch(`${API_BASE}/api/v1/sku-info/batch-parse-factory-info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: description.trim() }),
      })

      if (!response.ok) {
        const errText = await response.text()
        throw new Error(errText || 'AI 解析失败')
      }

      const data = await response.json()
      setParsedInfo(data.result || {})
      setRawResponse(data.raw || '')

      if (!data.result || Object.keys(data.result).length === 0) {
        notify({ type: 'warning', title: '解析结果为空', message: '请检查输入描述是否正确' })
      }
    } catch (err) {
      notify({
        type: 'error',
        title: 'AI 解析失败',
        message: err instanceof Error ? err.message : '未知错误',
      })
    } finally {
      setParsing(false)
    }
  }

  const handleSave = async () => {
    if (!parsedInfo || Object.keys(parsedInfo).length === 0) {
      notify({ type: 'warning', title: '请先解析产品属性' })
      return
    }

    const skuIds = selectedSkus.map((sku) => sku.id)

    setSaving(true)
    try {
      const response = await fetch(`${API_BASE}/api/v1/sku-info/batch-update-factory-info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sku_ids: skuIds,
          sku_factory_info: parsedInfo,
        }),
      })

      if (!response.ok) {
        const errText = await response.text()
        throw new Error(errText || '保存失败')
      }

      const data = await response.json()
      notify({
        type: 'success',
        title: '批量更新成功',
        message: `已更新 ${data.updated} 个 SKU 的产品属性`,
      })
      onSaved()
      onClose()
    } catch (err) {
      notify({
        type: 'error',
        title: '保存失败',
        message: err instanceof Error ? err.message : '未知错误',
      })
    } finally {
      setSaving(false)
    }
  }

  const handleClear = async () => {
    if (
      !(await confirm({ title: '确定要清除所有选中 SKU 的产品属性吗？', variant: 'destructive' }))
    )
      return

    const skuIds = selectedSkus.map((sku) => sku.id)

    setSaving(true)
    try {
      const response = await fetch(`${API_BASE}/api/v1/sku-info/batch-update-factory-info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sku_ids: skuIds,
          sku_factory_info: null,
        }),
      })

      if (!response.ok) throw new Error('清除失败')

      notify({ type: 'success', title: '产品属性已清除' })
      onSaved()
      onClose()
    } catch {
      notify({ type: 'error', title: '清除失败' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(openState) => {
        if (!openState) onClose()
      }}
    >
      <SheetContent
        portalContainer={portalContainer}
        onCloseAutoFocus={onCloseAutoFocus}
        className={['w-full max-w-2xl overflow-y-auto', contentClassName].filter(Boolean).join(' ')}
      >
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            批量编辑产品属性
            <Badge variant="secondary">已选中 {selectedSkus.length} 个 SKU</Badge>
          </SheetTitle>
        </SheetHeader>

        <div className="mt-6 space-y-6">
          {/* 输入区域 */}
          <div className="space-y-3">
            <label className="text-sm font-medium">产品属性描述</label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="请输入产品属性描述，例如：电压 220V，功率 1500W，防水等级 IP65"
              className="min-h-[120px]"
              disabled={parsing}
            />
            <div className="flex justify-end">
              <Button onClick={handleParse} disabled={parsing || !description.trim()}>
                {parsing ? 'AI 解析中...' : 'AI 解析'}
              </Button>
            </div>
          </div>

          {/* 预览区域 */}
          {parsedInfo && Object.keys(parsedInfo).length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">解析结果预览</label>
                <span className="text-xs text-muted-foreground">将应用到所有选中 SKU</span>
              </div>
              <div className="rounded-lg border border-border/60 bg-muted/30 p-4">
                <div className="grid grid-cols-2 gap-3">
                  {Object.entries(parsedInfo).map(([key, value]) => (
                    <div key={key} className="rounded-md border border-border/40 bg-background p-2">
                      <div className="text-xs text-muted-foreground">{key}</div>
                      <div className="font-medium break-all">
                        {typeof value === 'string' ? value : JSON.stringify(value)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="rounded-md border border-border/40 bg-muted/30 p-3">
                <div className="text-xs text-muted-foreground mb-1">当前选中 SKU:</div>
                <div className="flex flex-wrap gap-1">
                  {selectedSkus.slice(0, 5).map((sku) => (
                    <Badge key={sku.id} variant="outline" className="text-xs">
                      {sku.sku}
                    </Badge>
                  ))}
                  {selectedSkus.length > 5 && (
                    <Badge variant="outline" className="text-xs">
                      +{selectedSkus.length - 5} 更多
                    </Badge>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* 操作按钮 */}
          <div className="flex items-center justify-between border-t border-border/60 pt-4">
            <Button
              variant="outline"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={handleClear}
              disabled={saving}
            >
              清除属性
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
                取消
              </Button>
              <Button size="sm" onClick={handleSave} disabled={saving || !parsedInfo}>
                {saving ? '保存中...' : '确认'}
              </Button>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
