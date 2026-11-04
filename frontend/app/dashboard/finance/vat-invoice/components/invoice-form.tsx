'use client'

// 订单与买方表单（不含动态明细行）
// 字段：币种、Order ID、发票日期、买方

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
import { cn } from '@/lib/utils'
import { CURRENCY_OPTIONS, type Currency, type InvoiceForm } from '../types'
import styles from '../vat-invoice-warm.module.css'

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
    <section className={styles.panel} aria-labelledby="invoice-order-title" data-warm-panel="true">
      <header className={styles.panelHeader}>
        <h2 id="invoice-order-title" className={styles.panelTitle}>
          2 · 订单与买方
        </h2>
      </header>
      <div className={styles.panelBody}>
        <div className={styles.fieldGrid}>
          <div className={styles.field}>
            <Label htmlFor="currency" className={styles.label}>
              币种 *
            </Label>
            <Select value={form.currency} onValueChange={(v) => update('currency', v as Currency)}>
              <SelectTrigger id="currency" className={styles.selectTrigger}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className={cn('warm-ledger', styles.selectContent)}>
                {CURRENCY_OPTIONS.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className={styles.field}>
            <Label htmlFor="order-id" className={styles.label}>
              Order ID *
            </Label>
            <Input
              id="order-id"
              className={cn(styles.control, styles.numericControl)}
              value={form.order_id}
              onChange={(e) => update('order_id', e.target.value)}
              placeholder="205-3678957-4241932"
            />
          </div>

          <div className={cn(styles.field, styles.fieldFull)}>
            <Label className={styles.label}>发票日期 *</Label>
            <DatePicker
              value={parseDateInputValue(form.invoice_date)}
              onChange={(d) => update('invoice_date', d ? formatDateInputValue(d) : '')}
              placeholder="选择发票日期"
              className={styles.control}
              popoverClassName="warm-ledger warm-ledger__date-picker-content"
            />
          </div>
        </div>

        <div className={styles.subpanel}>
          <h3 className={styles.subpanelTitle}>买方（Bill To）</h3>
          <div className={styles.fieldGrid}>
            <div className={cn(styles.field, styles.fieldFull)}>
              <Label htmlFor="buyer-name" className={styles.label}>
                姓名 / 公司名 *
              </Label>
              <Input
                id="buyer-name"
                className={styles.control}
                value={form.buyer.name}
                onChange={(e) => updateBuyer('name', e.target.value)}
                placeholder="Greg Richardson"
              />
            </div>
            <div className={cn(styles.field, styles.fieldFull)}>
              <Label htmlFor="buyer-addr" className={styles.label}>
                街道地址 *
              </Label>
              <Input
                id="buyer-addr"
                className={styles.control}
                value={form.buyer.address_line}
                onChange={(e) => updateBuyer('address_line', e.target.value)}
                placeholder="2, Welsh Drive"
              />
            </div>
            <div className={styles.field}>
              <Label htmlFor="buyer-postal" className={styles.label}>
                邮编
              </Label>
              <Input
                id="buyer-postal"
                className={cn(styles.control, styles.numericControl)}
                value={form.buyer.postal_code}
                onChange={(e) => updateBuyer('postal_code', e.target.value)}
                placeholder="ML3 7AN"
              />
            </div>
            <div className={styles.field}>
              <Label htmlFor="buyer-city" className={styles.label}>
                城市
              </Label>
              <Input
                id="buyer-city"
                className={styles.control}
                value={form.buyer.city}
                onChange={(e) => updateBuyer('city', e.target.value)}
                placeholder="Hamilton"
              />
            </div>
            <div className={cn(styles.field, styles.fieldFull)}>
              <Label htmlFor="buyer-country" className={styles.label}>
                国家（ISO 2 字母）
              </Label>
              <Input
                id="buyer-country"
                className={cn(styles.control, styles.numericControl)}
                value={form.buyer.country}
                onChange={(e) =>
                  updateBuyer('country', e.target.value.toUpperCase().slice(0, 2))
                }
                placeholder="GB"
                maxLength={2}
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
