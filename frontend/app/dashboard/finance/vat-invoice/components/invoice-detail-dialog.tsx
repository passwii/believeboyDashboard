'use client'

import { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Download, Loader2 } from 'lucide-react'
import { getInvoiceDetail, downloadInvoicePdf, type VatInvoiceDetail } from '../lib/vat-history-api'

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
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>发票详情</DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            加载中…
          </div>
        ) : !detail ? (
          <p className="text-sm text-muted-foreground">未找到该发票。</p>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2 text-sm">
              <Field label="发票号" value={detail.invoice_no} mono />
              <Field label="状态" value={detail.status} />
              <Field label="店铺 ID" value={String(detail.project_id)} />
              <Field label="货币" value={detail.currency} />
              <Field label="订单号" value={detail.order_id || '—'} />
              <Field label="开票日期" value={detail.invoice_date} />
            </div>

            <section>
              <h3 className="mb-1 text-sm font-semibold">买方</h3>
              <div className="text-sm text-muted-foreground">
                {detail.buyer.name}
                <br />
                {[detail.buyer.address_line, detail.buyer.postal_code, detail.buyer.city, detail.buyer.country]
                  .filter(Boolean)
                  .join(' ')}
              </div>
            </section>

            <section>
              <h3 className="mb-1 text-sm font-semibold">明细行</h3>
              <div className="overflow-x-auto rounded border border-border/60">
                <table className="w-full text-sm">
                  <thead className="bg-[hsl(var(--surface-subtle))]">
                    <tr>
                      <th className="px-2 py-1 text-left">#</th>
                      <th className="px-2 py-1 text-left">描述</th>
                      <th className="px-2 py-1 text-left">ASIN</th>
                      <th className="px-2 py-1 text-right">数量</th>
                      <th className="px-2 py-1 text-right">含税单价</th>
                      <th className="px-2 py-1 text-right">VAT%</th>
                      <th className="px-2 py-1 text-right">小计</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.lines.map((l) => (
                      <tr key={l.id} className="border-t border-border/40">
                        <td className="px-2 py-1">{l.line_no}</td>
                        <td className="px-2 py-1">{l.description}</td>
                        <td className="px-2 py-1 font-mono text-xs">{l.asin || '—'}</td>
                        <td className="px-2 py-1 text-right">{l.qty}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{l.unit_price_incl_vat}</td>
                        <td className="px-2 py-1 text-right">{l.vat_rate}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{l.line_incl}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section>
              <h3 className="mb-1 text-sm font-semibold">按 VAT 率汇总</h3>
              <div className="overflow-x-auto rounded border border-border/60">
                <table className="w-full text-sm">
                  <thead className="bg-[hsl(var(--surface-subtle))]">
                    <tr>
                      <th className="px-2 py-1 text-left">VAT%</th>
                      <th className="px-2 py-1 text-right">商品 excl</th>
                      <th className="px-2 py-1 text-right">商品 VAT</th>
                      <th className="px-2 py-1 text-right">运费 excl</th>
                      <th className="px-2 py-1 text-right">运费 VAT</th>
                      <th className="px-2 py-1 text-right">合计</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.summary_by_rate.map((row, idx) => (
                      <tr key={idx} className="border-t border-border/40">
                        <td className="px-2 py-1">{String(row.rate)}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{String(row.item_excl ?? '')}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{String(row.item_vat ?? '')}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{String(row.shipping_excl ?? '')}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{String(row.shipping_vat ?? '')}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{String(row.total ?? '')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2 text-sm">
                <Field label="不含税合计" value={detail.subtotal_excl} />
                <Field label="VAT 合计" value={detail.total_vat} />
                <Field label="含税合计" value={detail.total_incl} />
              </div>
            </section>

            {detail.void_reason && (
              <p className="text-xs text-red-600">作废原因：{detail.void_reason}</p>
            )}
          </div>
        )}

        <DialogFooter>
          {detail?.r2_url && (
            <Button variant="outline" onClick={() => downloadInvoicePdf(detail.id)}>
              <Download className="mr-1.5 h-4 w-4" />
              下载 PDF
            </Button>
          )}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={mono ? 'font-mono text-xs' : ''}>{value}</div>
    </div>
  )
}
