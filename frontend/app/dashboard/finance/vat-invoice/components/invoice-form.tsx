'use client'

// 订单与买方表单（不含动态明细行）
// 字段：币种、Order ID、发票日期、买方

import { TermPanel } from '@/components/terminal/term-panel'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { DatePicker, formatDateInputValue, parseDateInputValue } from '@/components/ui/date-picker'
import { CURRENCY_OPTIONS, type Currency, type InvoiceForm } from '../types'

interface InvoiceFormProps {
  form: InvoiceForm
  onChange: (next: InvoiceForm) => void
}

export function InvoiceFormSection({ form, onChange }: InvoiceFormProps) {
  const update = <K extends keyof InvoiceForm>(key: K, value: InvoiceForm[K]) =>
    onChange({ ...form, [key]: value })

  const updateBuyer = <K extends keyof InvoiceForm['buyer']>(
    key: K,
    value: InvoiceForm['buyer'][K]
  ) => onChange({ ...form, buyer: { ...form.buyer, [key]: value } })

  return (
    <>
      {/* 2. 订单与买方 */}
      <TermPanel title="2 · 订单与买方">
        <div className="space-y-4 p-3">
          {/* 第一行：币种 / Order ID */}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="currency">币种 *</Label>
              <Select
                value={form.currency}
                onValueChange={(v) => update('currency', v as Currency)}
              >
                <SelectTrigger id="currency">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CURRENCY_OPTIONS.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="order-id">Order ID *</Label>
              <Input
                id="order-id"
                value={form.order_id}
                onChange={(e) => update('order_id', e.target.value)}
                placeholder="205-3678957-4241932"
              />
            </div>
          </div>

          {/* 第二行：发票日期 */}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-1">
            <div className="space-y-1.5">
              <Label>发票日期 *</Label>
              <DatePicker
                value={parseDateInputValue(form.invoice_date)}
                onChange={(d) => update('invoice_date', d ? formatDateInputValue(d) : '')}
                placeholder="选择发票日期"
              />
            </div>
          </div>

          {/* 买方（Bill To） */}
          <div className="rounded-lg border border-border/60 bg-[hsl(var(--surface-subtle))] p-4">
            <div className="mb-3 text-sm font-medium text-foreground">买方（Bill To）</div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="space-y-1.5 md:col-span-2">
                <Label htmlFor="buyer-name">姓名 / 公司名 *</Label>
                <Input
                  id="buyer-name"
                  value={form.buyer.name}
                  onChange={(e) => updateBuyer('name', e.target.value)}
                  placeholder="Greg Richardson"
                />
              </div>
              <div className="space-y-1.5 md:col-span-2">
                <Label htmlFor="buyer-addr">街道地址 *</Label>
                <Input
                  id="buyer-addr"
                  value={form.buyer.address_line}
                  onChange={(e) => updateBuyer('address_line', e.target.value)}
                  placeholder="2, Welsh Drive"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="buyer-postal">邮编</Label>
                <Input
                  id="buyer-postal"
                  value={form.buyer.postal_code}
                  onChange={(e) => updateBuyer('postal_code', e.target.value)}
                  placeholder="ML3 7AN"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="buyer-city">城市</Label>
                <Input
                  id="buyer-city"
                  value={form.buyer.city}
                  onChange={(e) => updateBuyer('city', e.target.value)}
                  placeholder="Hamilton"
                />
              </div>
              <div className="space-y-1.5 md:col-span-2">
                <Label htmlFor="buyer-country">国家（ISO 2 字母）</Label>
                <Input
                  id="buyer-country"
                  value={form.buyer.country}
                  onChange={(e) => updateBuyer('country', e.target.value.toUpperCase().slice(0, 2))}
                  placeholder="GB"
                  maxLength={2}
                />
              </div>
            </div>
          </div>
        </div>
      </TermPanel>
    </>
  )
}
