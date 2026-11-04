'use client'

// 实时 VAT 汇总：useMemo 重算 summarizeByRate，展示按 VAT 率分桶的小计。

import { useMemo } from 'react'
import { computeInvoiceTotal, summarizeByRate } from '../lib/vat-calc'
import { CURRENCY_OPTIONS, type InvoiceForm } from '../types'
import styles from '../vat-invoice-warm.module.css'

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
    <section className={styles.panel} aria-labelledby="invoice-summary-title" data-warm-panel="true">
      <header className={styles.panelHeader}>
        <h2 id="invoice-summary-title" className={styles.panelTitle}>
          实时 VAT 汇总
        </h2>
      </header>
      <div className={styles.panelBody}>
        {rows.length === 0 ? (
          <p className={styles.emptyState}>
            添加商品行后开始计算（币种：{form.currency} {symbol}）。
          </p>
        ) : (
          <>
            <div className={styles.formStack}>
              {rows.map((r) => (
                <div key={r.rate} className={styles.summaryBucket}>
                  <div className={styles.summaryBucketHead}>
                    <span>{r.rate}% VAT 桶</span>
                    <span className={styles.moneyValue}>
                      {symbol}
                      {r.total.toFixed(2)}
                    </span>
                  </div>
                  <div className={styles.summaryGrid}>
                    <span>商品不含税</span>
                    <span>
                      {symbol}
                      {r.itemExcl.toFixed(2)}
                    </span>
                    <span>商品 VAT</span>
                    <span>
                      {symbol}
                      {r.itemVat.toFixed(2)}
                    </span>
                    <span>运费不含税</span>
                    <span>
                      {symbol}
                      {r.shippingExcl.toFixed(2)}
                    </span>
                    <span>运费 VAT</span>
                    <span>
                      {symbol}
                      {r.shippingVat.toFixed(2)}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            <div className={styles.divider} />

            <div className={styles.formStack}>
              <div className={styles.summaryLine}>
                <span>Subtotal (excl. VAT)</span>
                <span className={styles.moneyValue}>
                  {symbol}
                  {totalExcl.toFixed(2)}
                </span>
              </div>
              <div className={styles.summaryLine}>
                <span>Total VAT</span>
                <span className={styles.moneyValue}>
                  {symbol}
                  {totalVat.toFixed(2)}
                </span>
              </div>
            </div>

            <div className={styles.summaryTotal}>
              <span>Invoice Total</span>
              <span className={styles.totalValue}>
                {symbol}
                {total.toFixed(2)}
              </span>
            </div>
          </>
        )}
      </div>
    </section>
  )
}
