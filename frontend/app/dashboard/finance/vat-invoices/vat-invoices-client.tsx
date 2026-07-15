'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
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
import { Download, Loader2 } from 'lucide-react'
import { useNotifications } from '@/components/notifications'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { fetchProjectsManage } from '../vat-invoice/lib/invoice-api'
import {
  listInvoices,
  voidInvoice,
  downloadInvoicePdf,
  exportInvoicesCsv,
  type VatInvoiceListItem,
} from './lib/vat-history-api'
import { InvoiceHistoryTable } from './components/invoice-history-table'
import { InvoiceDetailDialog } from './components/invoice-detail-dialog'

type StatusFilter = '' | 'draft' | 'issued' | 'voided'

export default function VatInvoicesClient() {
  const { notify } = useNotifications()
  const [projects, setProjects] = useState<Array<{ id: number; name: string; vat_enabled: boolean }>>([])
  const [projectId, setProjectId] = useState<string>('')
  const [status, setStatus] = useState<StatusFilter>('')
  const [q, setQ] = useState<string>('')
  const [rows, setRows] = useState<VatInvoiceListItem[]>([])
  const [loading, setLoading] = useState(false)
  const [detailId, setDetailId] = useState<number | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)

  // 拉店铺（仅 vat_enabled）
  useEffect(() => {
    let alive = true
    fetchProjectsManage()
      .then((all) => {
        if (!alive) return
        setProjects(
          all.filter((p) => p.vat_enabled).map((p) => ({
            id: p.id, name: p.name, vat_enabled: p.vat_enabled,
          })),
        )
      })
      .catch((err) => {
        if (!alive) return
        notify({ type: 'error', title: '加载店铺失败', message: normalizeErrorMessage(err) })
      })
    return () => {
      alive = false
    }
  }, [notify])

  const fetchList = useCallback(async () => {
    setLoading(true)
    try {
      const data = await listInvoices({
        project_id: projectId ? Number(projectId) : undefined,
        status: status || undefined,
        q: q || undefined,
      })
      setRows(data)
    } catch (err) {
      notify({ type: 'error', title: '加载发票失败', message: normalizeErrorMessage(err) })
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [projectId, status, q, notify])

  useEffect(() => {
    fetchList()
  }, [fetchList])

  const onVoid = async (id: number) => {
    const reason = typeof window !== 'undefined' ? window.prompt('作废原因（可选）：') ?? '' : ''
    try {
      await voidInvoice(id, reason)
      notify({ type: 'success', title: '已作废' })
      fetchList()
    } catch (err) {
      notify({ type: 'error', title: '作废失败', message: normalizeErrorMessage(err) })
    }
  }

  const onDownload = (id: number) => downloadInvoicePdf(id)

  const onSelect = (id: number) => {
    setDetailId(id)
    setDetailOpen(true)
  }

  const onExportCsv = () => {
    if (rows.length === 0) {
      notify({ type: 'info', title: '没有可导出的数据' })
      return
    }
    const csv = exportInvoicesCsv(rows)
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `vat-invoices-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const projectNameById = useMemo(() => {
    const m: Record<number, string> = {}
    for (const p of projects) m[p.id] = p.name
    return m
  }, [projects])

  return (
    <div className="space-y-4 px-1 py-1">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">VAT 发票历史</h1>
        <p className="text-sm text-muted-foreground">
          查看所有 VAT 店铺下的发票（草稿/已签发/作废），支持筛选与 CSV 导出。
        </p>
      </div>

      <Card className="dashboard-surface">
        <CardHeader>
          <CardTitle className="text-base">筛选</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
            <div>
              <Label htmlFor="project">店铺</Label>
              <Select value={projectId || 'all'} onValueChange={(v) => setProjectId(v === 'all' ? '' : v)}>
                <SelectTrigger id="project">
                  <SelectValue placeholder="全部" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部</SelectItem>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="status">状态</Label>
              <Select value={status || 'all'} onValueChange={(v) => setStatus((v === 'all' ? '' : v) as StatusFilter)}>
                <SelectTrigger id="status">
                  <SelectValue placeholder="全部" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部</SelectItem>
                  <SelectItem value="draft">草稿</SelectItem>
                  <SelectItem value="issued">已签发</SelectItem>
                  <SelectItem value="voided">已作废</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="q">关键字（发票号/订单号）</Label>
              <Input
                id="q"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="INV-… 或 ORDER-…"
              />
            </div>
            <div className="flex items-end">
              <Button onClick={onExportCsv} variant="outline">
                <Download className="mr-1.5 h-4 w-4" />
                导出 CSV
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="dashboard-surface">
        <CardContent className="pt-6">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              加载发票列表…
            </div>
          ) : (
            <InvoiceHistoryTable
              rows={rows}
              onSelect={onSelect}
              onDownload={onDownload}
              onVoid={onVoid}
            />
          )}
        </CardContent>
      </Card>

      <InvoiceDetailDialog
        invoiceId={detailId}
        open={detailOpen}
        onOpenChange={setDetailOpen}
      />

      {/* projectNameById reserved for future per-row actions; keeps the project
          dropdown mapping available without re-fetching. */}
      <span hidden>{Object.keys(projectNameById).length}</span>
    </div>
  )
}
