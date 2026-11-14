'use client'

// 动态商品明细行编辑器 + 运费输入
// 字段：Description / Qty / Unit Price (incl. VAT) / VAT% / Line Total (自动算)
// 操作：每行删除 / 底部 + Add row / 运费行跟随第一行 VAT 率

import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Plus, Trash2, Truck } from 'lucide-react'
import {
  WarmButton,
  WarmIconButton,
} from '@/components/dashboard-v2/warm-ledger/controls'
import { cn } from '@/lib/utils'
import { lineSubtotal } from '../lib/vat-calc'
import { VAT_RATE_OPTIONS, type InvoiceForm, type InvoiceLineItem } from '../types'
import styles from '../vat-invoice-warm.module.css'

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
    <section className={styles.panel} aria-labelledby="invoice-lines-title" data-warm-panel="true">
      <header className={styles.panelHeader}>
        <h2 id="invoice-lines-title" className={styles.panelTitle}>
          3 · 商品明细
        </h2>
        <div className={styles.panelActions}>
          <WarmButton variant="secondary" onClick={addRow}>
            <Plus aria-hidden />
          添加行
          </WarmButton>
        </div>
      </header>
      <div className={styles.panelBody}>
        {items.length === 0 ? (
          <p className={styles.emptyState}>
            暂无明细行。点击右上角「添加行」开始录入。
          </p>
        ) : (
          <div className={styles.formStack}>
            <div
              className={styles.lineItemsScroller}
              tabIndex={0}
              role="region"
              aria-label="商品明细与运费列表"
            >
              <div className={styles.lineItemsTable}>
                <div className={styles.lineHeader}>
                  <span>商品描述</span>
                  <span>ASIN</span>
                  <span className={styles.lineHeaderNumeric}>数量</span>
                  <span className={styles.lineHeaderNumeric}>单价（含税）</span>
                  <span>VAT%</span>
                  <span className={styles.lineHeaderNumeric}>小计（含税）</span>
                  <span aria-hidden />
                </div>

                {items.map((it, idx) => {
                  const sub = lineSubtotal(it)
                  return (
                    <div key={idx} className={styles.lineRow}>
                      <div className={styles.lineCell}>
                        <Input
                          aria-label={`第 ${idx + 1} 行商品描述`}
                          className={styles.control}
                          value={it.description}
                          onChange={(e) => updateRow(idx, { description: e.target.value })}
                          placeholder="商品名称 / 描述"
                        />
                      </div>
                      <div className={styles.lineCell}>
                        <Input
                          aria-label={`第 ${idx + 1} 行 ASIN`}
                          className={cn(styles.control, styles.numericControl)}
                          value={it.asin}
                          onChange={(e) => updateRow(idx, { asin: e.target.value })}
                          placeholder="B0G4N65TD5"
                        />
                      </div>
                      <div className={styles.lineCell}>
                        <Input
                          aria-label={`第 ${idx + 1} 行数量`}
                          type="number"
                          min={1}
                          step={1}
                          value={it.qty}
                          onChange={(e) => handleNumberInput(idx, 'qty', e.target.value, 1)}
                          className={cn(styles.control, styles.numericControl)}
                        />
                      </div>
                      <div className={styles.lineCell}>
                        <Input
                          aria-label={`第 ${idx + 1} 行含税单价`}
                          type="number"
                          min={0}
                          step={0.01}
                          value={it.unit_price_incl_vat}
                          onChange={(e) =>
                            handleNumberInput(idx, 'unit_price_incl_vat', e.target.value, 0)
                          }
                          className={cn(styles.control, styles.numericControl)}
                          placeholder="0.00"
                        />
                      </div>
                      <div className={styles.lineCell}>
                        <Select
                          value={String(it.vat_rate)}
                          onValueChange={(v) => updateRow(idx, { vat_rate: Number(v) })}
                        >
                          <SelectTrigger
                            aria-label={`第 ${idx + 1} 行 VAT 税率`}
                            className={styles.selectTrigger}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className={cn('warm-ledger', styles.selectContent)}>
                            {VAT_RATE_OPTIONS.map((r) => (
                              <SelectItem key={r} value={String(r)}>
                                {r}%
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <span className={styles.lineAmount}>
                        {currencySymbol}
                        {sub.incl.toFixed(2)}
                      </span>
                      <div className={styles.lineCell}>
                        <WarmIconButton
                          onClick={() => removeRow(idx)}
                          aria-label="删除该行"
                          title="删除该行"
                        >
                          <Trash2 aria-hidden />
                        </WarmIconButton>
                      </div>
                    </div>
                  )
                })}

                <div className={styles.shippingRow}>
                  <div className={styles.shippingLabel}>
                    <Truck className="h-3.5 w-3.5" aria-hidden />
                    运费（含税） · VAT 跟随第一行：{firstItemRate ?? 0}%
                  </div>
                  <div>
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
                      className={cn(styles.control, styles.numericControl)}
                      placeholder="0.00"
                      aria-label="运费（含税）"
                    />
                  </div>
                  <span className={styles.lineAmount}>
                    {currencySymbol}
                    {form.shipping_incl_vat.toFixed(2)}
                  </span>
                  <span aria-hidden />
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
