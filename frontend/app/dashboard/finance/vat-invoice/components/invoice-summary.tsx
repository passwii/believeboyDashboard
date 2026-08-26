'use client'

// 实时 VAT 汇总：useMemo 重算 summarizeByRate，展示按 VAT 率分桶的小计。

import { useMemo } from 'react'
import { TermPanel } from '@/components/terminal/term-panel'
import { Separator } from '@/components/ui/separator'
import { computeInvoiceTotal, summarizeByRate } from '../lib/vat-calc'
import { CURRENCY_OPTIONS, type InvoiceForm } from '../types'

interface InvoiceSummaryProps {
  form: InvoiceForm
}

function getSymbol(currency: InvoiceForm['currency']): string {
  return CURRENCY_OPTIONS.find((c) => c.value === currency)?.symbol ?? currency
}

export function InvoiceSummary({ form }: InvoiceSummaryProps) {
  const symbol = getSymbol(form.currency)
  const rows = useMemo(() => summarizeByRate(form), [form])
  const total = useMemo(() => computeInvoiceTotal(form), [form])

  const totalVat = useMemo(() => rows.reduce((s, r) => s + r.itemVat + r.shippingVat, 0), [rows])
  const totalExcl = useMemo(() => rows.reduce((s, r) => s + r.itemExcl + r.shippingExcl, 0), [rows])

  return (
    <TermPanel title="实时 VAT 汇总">
      <div className="space-y-3 p-3 text-xs">
        {rows.length === 0 ? (
          <p className="text-term-faint">
            添加商品行后开始计算（币种：{form.currency} {symbol}）。
          </p>
        ) : (
          <>
            {/* 按 VAT 率分桶 */}
            <div className="space-y-2">
              {rows.map((r) => (
                <div
                  key={r.rate}
                  className="rounded-none border border-term-border bg-term-raised p-2"
                >
                  <div className="mb-1 flex items-center justify-between">
                    <span className="font-mono font-medium text-term-text">{r.rate}% VAT 桶</span>
                    <span className="font-mono font-semibold tabular-nums text-term-text">
                      {symbol}
                      {r.total.toFixed(2)}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs text-term-muted">
                    <span>商品不含税</span>
                    <span className="text-right font-mono tabular-nums">
                      {symbol}
                      {r.itemExcl.toFixed(2)}
                    </span>
                    <span>商品 VAT</span>
                    <span className="text-right font-mono tabular-nums">
                      {symbol}
                      {r.itemVat.toFixed(2)}
                    </span>
                    <span>运费不含税</span>
                    <span className="text-right font-mono tabular-nums">
                      {symbol}
                      {r.shippingExcl.toFixed(2)}
                    </span>
                    <span>运费 VAT</span>
                    <span className="text-right font-mono tabular-nums">
                      {symbol}
                      {r.shippingVat.toFixed(2)}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            <Separator className="my-3" />

            <div className="space-y-1 text-xs">
              <div className="flex justify-between text-term-muted">
                <span>Subtotal (excl. VAT)</span>
                <span className="font-mono tabular-nums">
                  {symbol}
                  {totalExcl.toFixed(2)}
                </span>
              </div>
              <div className="flex justify-between text-term-muted">
                <span>Total VAT</span>
                <span className="font-mono tabular-nums">
                  {symbol}
                  {totalVat.toFixed(2)}
                </span>
              </div>
            </div>

            <div className="flex items-baseline justify-between rounded-none border border-term-border bg-term-raised px-3 py-2">
              <span className="text-sm font-semibold text-term-text">Invoice Total</span>
              <span className="font-mono text-base font-bold tabular-nums text-term-text">
                {symbol}
                {total.toFixed(2)}
              </span>
            </div>
          </>
        )}
    </div>
  </TermPanel>
  )
}
