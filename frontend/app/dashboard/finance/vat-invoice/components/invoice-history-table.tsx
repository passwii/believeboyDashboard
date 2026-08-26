'use client'

import { Button } from '@/components/ui/button'
import { Download, Eye, Ban } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  TermBody,
  TermCell,
  TermHead,
  TermRow,
  TermTHead,
  TermTable,
} from '@/components/terminal/term-table'
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

const STATUS_TONE: Record<VatInvoiceListItem['status'], 'muted' | 'pos' | 'neg'> = {
  draft: 'muted',
  issued: 'pos',
  voided: 'neg',
}

/**
 * VAT 发票历史表（终端化 BLF-835）：
 * 原 Table + density presets 收口为 TermTable 高密度规格，状态走 term 语义色。
 */
export function InvoiceHistoryTable({ rows, onSelect, onDownload, onVoid, loading }: Props) {
  if (loading) {
    return <p className="text-xs text-term-muted">加载中…</p>
  }
  return (
    <div className="overflow-auto term-scroll">
      <TermTable className="min-w-[760px]">
        <TermTHead>
          <TermRow className="hover:bg-transparent">
            <TermHead>发票号</TermHead>
            <TermHead>店铺</TermHead>
            <TermHead>买方</TermHead>
            <TermHead>货币</TermHead>
            <TermHead>日期</TermHead>
            <TermHead numeric>总额（含税）</TermHead>
            <TermHead>状态</TermHead>
            <TermHead numeric>操作</TermHead>
          </TermRow>
        </TermTHead>
        <TermBody>
          {rows.length === 0 ? (
            <TermRow className="hover:bg-transparent">
              <TermCell colSpan={8} className="h-24 text-center" tone="muted">
                没有匹配的发票。
              </TermCell>
            </TermRow>
          ) : (
            rows.map((r) => (
              <TermRow key={r.id}>
                <TermCell className="font-mono">{r.invoice_no}</TermCell>
                <TermCell>{r.project_name}</TermCell>
                <TermCell title={r.buyer_name}>{r.buyer_name}</TermCell>
                <TermCell tone="muted" className="font-mono uppercase">
                  {r.currency}
                </TermCell>
                <TermCell className="font-mono">{r.invoice_date}</TermCell>
                <TermCell numeric className="font-medium">
                  {r.total_incl}
                </TermCell>
                <TermCell tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</TermCell>
                <TermCell numeric>
                  <span className="inline-flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 rounded-none text-term-muted hover:bg-term-hover hover:text-term-text"
                      title="详情"
                      onClick={() => onSelect(r.id)}
                    >
                      <Eye className="h-3.5 w-3.5" strokeWidth={1.75} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 rounded-none text-term-muted hover:bg-term-hover hover:text-term-text"
                      title="下载 PDF"
                      onClick={() => onDownload(r.id)}
                      disabled={!r.has_pdf}
                    >
                      <Download className="h-3.5 w-3.5" strokeWidth={1.75} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn(
                        'h-7 w-7 rounded-none text-term-muted hover:bg-term-hover',
                        r.status !== 'voided' && 'hover:text-term-neg'
                      )}
                      title="作废"
                      onClick={() => onVoid(r.id)}
                      disabled={r.status === 'voided'}
                    >
                      <Ban className="h-3.5 w-3.5" strokeWidth={1.75} />
                    </Button>
                  </span>
                </TermCell>
              </TermRow>
            ))
          )}
        </TermBody>
      </TermTable>
    </div>
  )
}
