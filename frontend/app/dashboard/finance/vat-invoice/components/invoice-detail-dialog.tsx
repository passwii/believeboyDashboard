'use client'

import { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { WarmButton } from '@/components/dashboard-v2/warm-ledger/controls'
import { cn } from '@/lib/utils'
import { Download, Loader2 } from 'lucide-react'
import { getInvoiceDetail, downloadInvoicePdf, type VatInvoiceDetail } from '../lib/vat-history-api'
import styles from '../vat-invoice-warm.module.css'

interface Props {
  invoiceId: number | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function InvoiceDetailDialog({ invoiceId, open, onOpenChange }: Props) {
  const [detail, setDetail] = useState<VatInvoiceDetail | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open || invoiceId == null) return
    let alive = true
    setLoading(true)
    getInvoiceDetail(invoiceId)
      .then((d) => {
        if (!alive) return
        setDetail(d)
      })
      .catch(() => {
        if (!alive) return
        setDetail(null)
      })
      .finally(() => {
        if (!alive) return
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [open, invoiceId])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn('warm-ledger', styles.dialog)}>
        <DialogHeader>
          <DialogTitle>发票详情</DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className={styles.loadingState} role="status">
            <Loader2 className="h-4 w-4 animate-spin" />
            加载中…
          </div>
        ) : !detail ? (
          <p className={styles.emptyState}>未找到该发票。</p>
        ) : (
          <div className={styles.formStack}>
            <div className={styles.detailFacts}>
              <Field label="发票号" value={detail.invoice_no} mono />
              <Field label="状态" value={detail.status} />
              <Field label="店铺 ID" value={String(detail.project_id)} />
              <Field label="货币" value={detail.currency} />
              <Field label="订单号" value={detail.order_id || '—'} />
              <Field label="开票日期" value={detail.invoice_date} />
            </div>

            <section className={styles.section}>
              <h3 className={styles.sectionTitle}>买方</h3>
              <div className={styles.bodyCopy}>
                {detail.buyer.name}
                <br />
                {[detail.buyer.address_line, detail.buyer.postal_code, detail.buyer.city, detail.buyer.country]
                  .filter(Boolean)
                  .join(' ')}
              </div>
            </section>

            <section className={styles.section}>
              <h3 className={styles.sectionTitle}>明细行</h3>
              <div className={styles.detailTableScroller}>
                <table className={styles.detailTable} data-warm-table="true">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>描述</th>
                      <th>ASIN</th>
                      <th className={styles.detailTableNumeric}>数量</th>
                      <th className={styles.detailTableNumeric}>含税单价</th>
                      <th className={styles.detailTableNumeric}>VAT%</th>
                      <th className={styles.detailTableNumeric}>小计</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.lines.map((l) => (
                      <tr key={l.id}>
                        <td>{l.line_no}</td>
                        <td>{l.description}</td>
                        <td className={styles.tableCellMono}>{l.asin || '—'}</td>
                        <td className={styles.detailTableNumeric}>{l.qty}</td>
                        <td className={styles.detailTableNumeric}>
                          {l.unit_price_incl_vat}
                        </td>
                        <td className={styles.detailTableNumeric}>{l.vat_rate}</td>
                        <td className={styles.detailTableNumeric}>
                          {l.line_incl}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className={styles.section}>
              <h3 className={styles.sectionTitle}>按 VAT 率汇总</h3>
              <div className={styles.detailTableScroller}>
                <table className={styles.detailTable} data-warm-table="true">
                  <thead>
                    <tr>
                      <th>VAT%</th>
                      <th className={styles.detailTableNumeric}>商品 excl</th>
                      <th className={styles.detailTableNumeric}>商品 VAT</th>
                      <th className={styles.detailTableNumeric}>运费 excl</th>
                      <th className={styles.detailTableNumeric}>运费 VAT</th>
                      <th className={styles.detailTableNumeric}>合计</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.summary_by_rate.map((row, idx) => (
                      <tr key={idx}>
                        <td>{String(row.rate)}</td>
                        <td className={styles.detailTableNumeric}>
                          {String(row.item_excl ?? '')}
                        </td>
                        <td className={styles.detailTableNumeric}>
                          {String(row.item_vat ?? '')}
                        </td>
                        <td className={styles.detailTableNumeric}>
                          {String(row.shipping_excl ?? '')}
                        </td>
                        <td className={styles.detailTableNumeric}>
                          {String(row.shipping_vat ?? '')}
                        </td>
                        <td className={styles.detailTableNumeric}>
                          {String(row.total ?? '')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className={styles.detailFacts}>
                <Field label="不含税合计" value={detail.subtotal_excl} />
                <Field label="VAT 合计" value={detail.total_vat} />
                <Field label="含税合计" value={detail.total_incl} />
              </div>
            </section>

            {detail.void_reason && (
              <p className={styles.emptyState}>作废原因：{detail.void_reason}</p>
            )}
          </div>
        )}

        <DialogFooter>
          {detail?.r2_url && (
            <WarmButton variant="secondary" onClick={() => downloadInvoicePdf(detail.id)}>
              <Download aria-hidden />
              下载 PDF
            </WarmButton>
          )}
          <WarmButton variant="quiet" onClick={() => onOpenChange(false)}>
            关闭
          </WarmButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className={styles.fact}>
      <div className={styles.factLabel}>{label}</div>
      <div className={cn(styles.factValue, mono && styles.factValueMono)}>{value}</div>
    </div>
  )
}
