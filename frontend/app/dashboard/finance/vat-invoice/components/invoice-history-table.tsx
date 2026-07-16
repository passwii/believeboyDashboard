'use client'

import { Button } from '@/components/ui/button'
import { Download, Eye, Ban } from 'lucide-react'
import type { VatInvoiceListItem } from '../lib/vat-history-api'

interface Props {
  rows: VatInvoiceListItem[]
  onSelect: (id: number) => void
  onDownload: (id: number) => void
  onVoid: (id: number) => void
  loading?: boolean
}

const STATUS_LABEL: Record<VatInvoiceListItem['status'], string> = {
  draft: '草稿',
  issued: '已签发',
  voided: '已作废',
}

export function InvoiceHistoryTable({ rows, onSelect, onDownload, onVoid, loading }: Props) {
  if (loading) {
    return <p className="text-sm text-muted-foreground">加载中…</p>
  }
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">没有匹配的发票。</p>
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-border/60">
      <table className="w-full text-sm">
        <thead className="bg-[hsl(var(--surface-subtle))]">
          <tr>
            <th className="px-3 py-2 text-left font-medium">发票号</th>
            <th className="px-3 py-2 text-left font-medium">店铺</th>
            <th className="px-3 py-2 text-left font-medium">买方</th>
            <th className="px-3 py-2 text-left font-medium">货币</th>
            <th className="px-3 py-2 text-left font-medium">日期</th>
            <th className="px-3 py-2 text-right font-medium">总额（含税）</th>
            <th className="px-3 py-2 text-left font-medium">状态</th>
            <th className="px-3 py-2 text-right font-medium">操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-border/40">
              <td className="px-3 py-2 font-mono text-xs">{r.invoice_no}</td>
              <td className="px-3 py-2">{r.project_name}</td>
              <td className="px-3 py-2">{r.buyer_name}</td>
              <td className="px-3 py-2">{r.currency}</td>
              <td className="px-3 py-2">{r.invoice_date}</td>
              <td className="px-3 py-2 text-right tabular-nums">{r.total_incl}</td>
              <td className="px-3 py-2">{STATUS_LABEL[r.status]}</td>
              <td className="px-3 py-2">
                <div className="flex justify-end gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    title="详情"
                    onClick={() => onSelect(r.id)}
                  >
                    <Eye className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    title="下载 PDF"
                    onClick={() => onDownload(r.id)}
                    disabled={!r.has_pdf}
                  >
                    <Download className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-red-600"
                    title="作废"
                    onClick={() => onVoid(r.id)}
                    disabled={r.status === 'voided'}
                  >
                    <Ban className="h-4 w-4" />
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
