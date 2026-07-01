'use client'

import { useEffect, useState } from 'react'
import { Loader2, Save, Truck } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DatePicker,
  formatDateInputValue,
  parseDateInputValue,
} from '@/components/ui/date-picker'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useNotifications } from '@/components/notifications'
import { normalizeErrorMessage } from '@/lib/error-utils'

/**
 * FBM 订单补录/编辑 Dialog
 *
 * 受父组件权限/范围控制：父组件决定哪些行显示「编辑」按钮；
 * 此组件只关心单个订单行的字段编辑、提交、错误提示。
 *
 * 字段（与后端 OrderInfoUpdate 对齐）：
 *   carrier        string  物流商（UPS / USPS / FedEx / DHL / 顺丰 …）
 *   tracking_no    string  物流单号
 *   shipped_at     string  YYYY-MM-DD（北京时间当天的 UTC 零点）
 *   updated_by     string  操作人；默认取 session.user.name，可改
 */

export type OrderEditDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 订单基础信息（read-only，顶部展示） */
  order: {
    id: number
    amazon_order_id: string
    sku: string | null
    asin: string | null
    product_name: string | null
    project_name: string
    quantity: number
    country: string
  }
  /** 后端鉴权头（含 X-Operator / X-Is-Admin） */
  authHeaders: () => Headers
  /** 当前登录用户名（默认填到 updated_by） */
  defaultUpdatedBy?: string
  /** 保存成功回调，父组件更新行内数据 */
  onSaved?: (updated: OrderEditResponsePayload) => void
}

/** 后端 PATCH /api/v1/order-info/{id} 返回的 OrderInfoItem 中我们关心的字段 */
export type OrderEditResponsePayload = {
  id: number
  carrier: string | null
  tracking_no: string | null
  shipped_at: string | null
  updated_by: string | null
  updated_at: string | null
}

type FormState = {
  carrier: string
  tracking_no: string
  shipped_at: string // YYYY-MM-DD or ''
  updated_by: string
}

function buildEmptyForm(): FormState {
  return { carrier: '', tracking_no: '', shipped_at: '', updated_by: '' }
}

export function OrderEditDialog(props: OrderEditDialogProps) {
  const { open, onOpenChange, order, authHeaders, defaultUpdatedBy, onSaved } = props
  const { notify } = useNotifications()

  const [form, setForm] = useState<FormState>(() => buildEmptyForm())
  const [submitting, setSubmitting] = useState(false)
  const [initialCarrier, setInitialCarrier] = useState('')

  // 打开 / 切换订单 → 初始化表单
  useEffect(() => {
    if (!open) return
    setForm({
      carrier: '',
      tracking_no: '',
      shipped_at: '',
      updated_by: defaultUpdatedBy ?? '',
    })
    setInitialCarrier('')
  }, [open, order.id, defaultUpdatedBy])

  const handleFieldChange = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }))
  }

  const handleSubmit = async () => {
    // 校验：四个字段都允许空（清空），但至少 carrier + tracking_no 要同时存在或同时为空
    if (form.carrier.trim() && !form.tracking_no.trim()) {
      notify({ type: 'error', title: '请填写物流单号', message: '物流商和单号需同时填写' })
      return
    }
    if (!form.carrier.trim() && form.tracking_no.trim()) {
      notify({ type: 'error', title: '请填写物流商', message: '物流商和单号需同时填写' })
      return
    }

    setSubmitting(true)
    try {
      const payload: Record<string, unknown> = {}
      // 只有与初始值不同的字段才提交（避免无意义 PATCH）
      const trimmedCarrier = form.carrier.trim()
      if (trimmedCarrier !== initialCarrier) payload.carrier = trimmedCarrier || null
      if (form.tracking_no.trim()) payload.tracking_no = form.tracking_no.trim()
      if (form.shipped_at) payload.shipped_at = form.shipped_at
      if (form.updated_by.trim()) payload.updated_by = form.updated_by.trim()

      // 没变化就跳过网络
      if (Object.keys(payload).length === 0) {
        notify({ type: 'info', title: '无修改' })
        onOpenChange(false)
        return
      }

      const response = await fetch(`/api/backend/api/v1/order-info/${order.id}`, {
        method: 'PATCH',
        headers: { ...Object.fromEntries(authHeaders().entries()), 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        cache: 'no-store',
      })
      if (!response.ok) {
        const errPayload = (await response.json().catch(() => null)) as
          | { error?: string; detail?: string; message?: string }
          | null
        const msg = errPayload?.error || errPayload?.detail || errPayload?.message
        throw new Error(normalizeErrorMessage(msg, '保存失败'))
      }

      const updated = (await response.json()) as OrderEditResponsePayload
      notify({ type: 'success', title: 'FBM 订单已更新' })
      onSaved?.(updated)
      onOpenChange(false)
    } catch (error) {
      notify({
        type: 'error',
        title: '保存失败',
        message: normalizeErrorMessage(error, '未知错误'),
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !submitting && onOpenChange(v)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Truck className="h-4 w-4" />
            编辑 FBM 订单 · 物流信息
          </DialogTitle>
          <DialogDescription>
            订单号{' '}
            <span className="font-mono text-xs">{order.amazon_order_id}</span> · 店铺{' '}
            {order.project_name}
            {order.sku ? ` · SKU ${order.sku}` : ''}
            {order.country ? ` · 收货国 ${order.country}` : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <label className="text-xs font-medium text-muted-foreground">物流商（Carrier）</label>
            <Input
              value={form.carrier}
              onChange={(e) => handleFieldChange('carrier', e.target.value)}
              placeholder="例如 UPS / USPS / FedEx / DHL / 顺丰"
              disabled={submitting}
              maxLength={64}
              autoComplete="off"
            />
          </div>

          <div className="grid gap-2">
            <label className="text-xs font-medium text-muted-foreground">
              物流单号（Tracking No.）
            </label>
            <Input
              value={form.tracking_no}
              onChange={(e) => handleFieldChange('tracking_no', e.target.value)}
              placeholder="例如 1Z999AA10123456784"
              disabled={submitting}
              maxLength={128}
              autoComplete="off"
            />
          </div>

          <div className="grid gap-2">
            <label className="text-xs font-medium text-muted-foreground">
              发货时间（Shipped At · 北京时间）
            </label>
            <DatePicker
              mode="single"
              value={parseDateInputValue(form.shipped_at)}
              onChange={(date) => handleFieldChange('shipped_at', formatDateInputValue(date))}
              placeholder="选择发货日期"
            />
          </div>

          <div className="grid gap-2">
            <label className="text-xs font-medium text-muted-foreground">
              操作人（Updated By）
            </label>
            <Input
              value={form.updated_by}
              onChange={(e) => handleFieldChange('updated_by', e.target.value)}
              placeholder={defaultUpdatedBy ?? '填写操作人姓名'}
              disabled={submitting}
              maxLength={64}
              autoComplete="off"
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            取消
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={submitting} className="gap-1">
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}