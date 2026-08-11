'use client'

// 动态商品明细行编辑器 + 运费输入
// 字段：Description / Qty / Unit Price (incl. VAT) / VAT% / Line Total (自动算)
// 操作：每行删除 / 底部 + Add row / 运费行跟随第一行 VAT 率

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Plus, Trash2, Truck } from 'lucide-react'
import { lineSubtotal } from '../lib/vat-calc'
import { VAT_RATE_OPTIONS, type InvoiceForm, type InvoiceLineItem } from '../types'

interface LineItemsEditorProps {
  form: InvoiceForm
  currencySymbol: string
  onChange: (form: InvoiceForm) => void
}

function makeBlankItem(): InvoiceLineItem {
  return {
    description: '',
    asin: '',
    qty: 1,
    unit_price_incl_vat: 0,
    vat_rate: 20,
  }
}

export function LineItemsEditor({ form, currencySymbol, onChange }: LineItemsEditorProps) {
  const items = form.line_items
  const firstItemRate = items[0]?.vat_rate ?? null

  const updateRow = (idx: number, patch: Partial<InvoiceLineItem>) => {
    onChange({
      ...form,
      line_items: items.map((it, i) => (i === idx ? { ...it, ...patch } : it)),
    })
  }

  // 数字输入：允许临时空字符串态，blur/onBlur 时再 clamp 到合法值。
  // 避免 "1 → 删成 '' → 跳 1" 这种无法输入两位数的问题。
  const handleNumberInput = (
    idx: number,
    key: 'qty' | 'unit_price_incl_vat',
    raw: string,
    min: number
  ) => {
    if (raw === '') {
      updateRow(idx, { [key]: min } as Partial<InvoiceLineItem>)
      return
    }
    const n = Number(raw)
    updateRow(idx, {
      [key]: Number.isFinite(n) ? Math.max(min, n) : min,
    } as Partial<InvoiceLineItem>)
  }

  const addRow = () => {
    onChange({ ...form, line_items: [...items, makeBlankItem()] })
  }

  const removeRow = (idx: number) => {
    onChange({ ...form, line_items: items.filter((_, i) => i !== idx) })
  }

  return (
    <Card className="dashboard-surface">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">3. 商品明细</CardTitle>
        <Button size="sm" variant="outline" onClick={addRow}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          添加行
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            暂无明细行。点击右上角「添加行」开始录入。
          </p>
        ) : (
          <>
            {/* 表头 */}
            <div className="hidden grid-cols-12 gap-2 text-xs font-medium text-muted-foreground md:grid">
              <div className="col-span-5">商品描述</div>
              <div className="col-span-2">ASIN</div>
              <div className="col-span-1 text-right">数量</div>
              <div className="col-span-2 text-right">单价 (含税)</div>
              <div className="col-span-1">VAT%</div>
              <div className="col-span-1 text-right">小计 (含税)</div>
            </div>

            {/* 行 */}
            {items.map((it, idx) => {
              const sub = lineSubtotal(it)
              return (
                <div
                  key={idx}
                  className="grid grid-cols-12 items-center gap-2 rounded-lg border border-border/60 bg-background/50 p-2"
                >
                  <div className="col-span-12 md:col-span-5">
                    <Label className="text-xs text-muted-foreground md:hidden">商品描述</Label>
                    <Input
                      value={it.description}
                      onChange={(e) => updateRow(idx, { description: e.target.value })}
                      placeholder="商品名称 / 描述"
                    />
                  </div>
                  <div className="col-span-6 md:col-span-2">
                    <Label className="text-xs text-muted-foreground md:hidden">ASIN</Label>
                    <Input
                      value={it.asin}
                      onChange={(e) => updateRow(idx, { asin: e.target.value })}
                      placeholder="B0G4N65TD5"
                    />
                  </div>
                  <div className="col-span-3 md:col-span-1">
                    <Label className="text-xs text-muted-foreground md:hidden">数量</Label>
                    <Input
                      type="number"
                      min={1}
                      step={1}
                      value={it.qty}
                      onChange={(e) => handleNumberInput(idx, 'qty', e.target.value, 1)}
                      className="text-right"
                    />
                  </div>
                  <div className="col-span-3 md:col-span-2">
                    <Label className="text-xs text-muted-foreground md:hidden">单价 (含税)</Label>
                    <Input
                      type="number"
                      min={0}
                      step={0.01}
                      value={it.unit_price_incl_vat}
                      onChange={(e) =>
                        handleNumberInput(idx, 'unit_price_incl_vat', e.target.value, 0)
                      }
                      className="text-right"
                      placeholder="0.00"
                    />
                  </div>
                  <div className="col-span-6 md:col-span-1">
                    <Label className="text-xs text-muted-foreground md:hidden">VAT%</Label>
                    <Select
                      value={String(it.vat_rate)}
                      onValueChange={(v) => updateRow(idx, { vat_rate: Number(v) })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {VAT_RATE_OPTIONS.map((r) => (
                          <SelectItem key={r} value={String(r)}>
                            {r}%
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="col-span-4 flex items-center justify-end md:col-span-1">
                    <span className="text-sm font-medium tabular-nums">
                      {currencySymbol}
                      {sub.incl.toFixed(2)}
                    </span>
                  </div>
                  <div className="col-span-2 flex items-center justify-end md:col-span-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removeRow(idx)}
                      className="h-8 w-8 text-muted-foreground hover:text-destructive max-md:h-10 max-md:w-10"
                      aria-label="删除该行"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              )
            })}

            {/* 运费行 */}
            <div className="grid grid-cols-12 items-center gap-2 rounded-lg border border-dashed border-border/60 bg-[hsl(var(--surface-subtle))] p-2">
              <div className="col-span-12 flex items-center gap-1.5 text-sm font-medium md:col-span-7">
                <Truck className="h-3.5 w-3.5 text-muted-foreground" />
                运费（含税） · VAT 跟随第一行：{firstItemRate ?? 0}%
              </div>
              <div className="col-span-8 md:col-span-3">
                <Input
                  type="number"
                  min={0}
                  step={0.01}
                  value={form.shipping_incl_vat}
                  onChange={(e) => {
                    const raw = e.target.value
                    if (raw === '') {
                      onChange({ ...form, shipping_incl_vat: 0 })
                      return
                    }
                    const n = Number(raw)
                    onChange({
                      ...form,
                      shipping_incl_vat: Number.isFinite(n) ? Math.max(0, n) : 0,
                    })
                  }}
                  className="text-right"
                  placeholder="0.00"
                  aria-label="运费（含税）"
                />
              </div>
              <div className="col-span-2 flex items-center justify-end text-sm tabular-nums text-muted-foreground md:col-span-1">
                {currencySymbol}
                {form.shipping_incl_vat.toFixed(2)}
              </div>
              <div className="hidden md:col-span-1 md:block" />
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
