'use client'

import { Button } from '@/components/ui/button'
import { Download, Eye, Ban } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  densityCell,
  densityHead,
  numericCell,
  numericHead,
  StatusPill,
  type TableStatus,
} from '@/components/ui/table-presets'
import { EmptyTableState } from '@/components/ui/empty-state'
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

const STATUS_PILL: Record<VatInvoiceListItem['status'], TableStatus> = {
  draft: 'neutral',
  issued: 'success',
  voided: 'negative',
}

export function InvoiceHistoryTable({ rows, onSelect, onDownload, onVoid, loading }: Props) {
  if (loading) {
    return <p className="text-sm text-muted-foreground">加载中…</p>
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-border/60">
      <Table className="min-w-[760px]">
        <TableHeader>
          <TableRow>
            <TableHead className={cn(densityHead.compact)}>发票号</TableHead>
            <TableHead className={cn(densityHead.compact)}>店铺</TableHead>
            <TableHead className={cn(densityHead.compact)}>买方</TableHead>
            <TableHead className={cn(densityHead.compact)}>货币</TableHead>
            <TableHead className={cn(densityHead.compact)}>日期</TableHead>
            <TableHead className={cn(densityHead.compact, numericHead)}>总额（含税）</TableHead>
            <TableHead className={cn(densityHead.compact)}>状态</TableHead>
            <TableHead className={cn(densityHead.compact, numericHead)}>操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <EmptyTableState colSpan={8} message="没有匹配的发票。" />
          ) : (
            rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className={cn(densityCell.compact, 'font-mono text-xs')}>
                  {r.invoice_no}
                </TableCell>
                <TableCell className={densityCell.compact}>{r.project_name}</TableCell>
                <TableCell className={densityCell.compact}>{r.buyer_name}</TableCell>
                <TableCell className={densityCell.compact}>{r.currency}</TableCell>
                <TableCell className={densityCell.compact}>{r.invoice_date}</TableCell>
                <TableCell className={cn(densityCell.compact, numericCell)}>
                  {r.total_incl}
                </TableCell>
                <TableCell className={densityCell.compact}>
                  <StatusPill status={STATUS_PILL[r.status]} label={STATUS_LABEL[r.status]} />
                </TableCell>
                <TableCell className={cn(densityCell.compact, 'text-right')}>
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 max-md:h-11 max-md:w-11"
                      title="详情"
                      onClick={() => onSelect(r.id)}
                    >
                      <Eye className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 max-md:h-11 max-md:w-11"
                      title="下载 PDF"
                      onClick={() => onDownload(r.id)}
                      disabled={!r.has_pdf}
                    >
                      <Download className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 text-muted-foreground hover:text-destructive max-md:h-11 max-md:w-11"
                      title="作废"
                      onClick={() => onVoid(r.id)}
                      disabled={r.status === 'voided'}
                    >
                      <Ban className="h-4 w-4" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  )
}
