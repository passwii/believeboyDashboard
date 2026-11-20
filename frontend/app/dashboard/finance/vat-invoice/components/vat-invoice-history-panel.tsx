'use client'

import { useCallback, useEffect, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Download } from 'lucide-react'
import { WarmButton } from '@/components/dashboard-v2/warm-ledger/controls'
import { useNotifications } from '@/components/notifications'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { cn } from '@/lib/utils'
import { fetchProjectsManage } from '../lib/invoice-api'
import {
  listInvoices,
  listAllInvoices,
  voidInvoice,
  downloadInvoicePdf,
  exportInvoicesCsv,
  type VatInvoiceListItem,
} from '../lib/vat-history-api'
import { InvoiceHistoryTable } from './invoice-history-table'
import { InvoiceDetailDialog } from './invoice-detail-dialog'
import styles from '../vat-invoice-warm.module.css'

type StatusFilter = '' | 'draft' | 'issued' | 'voided'

const HISTORY_PAGE_SIZE = 100

export function VatInvoiceHistoryPanel() {
  const { notify } = useNotifications()
  const [projects, setProjects] = useState<Array<{ id: number; name: string; vat_enabled: boolean }>>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectsError, setProjectsError] = useState<string | null>(null)
  const [projectRetryKey, setProjectRetryKey] = useState(0)
  const [projectId, setProjectId] = useState<string>('')
  const [status, setStatus] = useState<StatusFilter>('')
  const [q, setQ] = useState<string>('')
  const [rows, setRows] = useState<VatInvoiceListItem[]>([])
  const [page, setPage] = useState(1)
  const [hasNextPage, setHasNextPage] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [detailId, setDetailId] = useState<number | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)

  // 拉店铺（仅 vat_enabled）
  useEffect(() => {
    let alive = true
    setProjectsLoading(true)
    setProjectsError(null)
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
        setProjectsError('店铺列表加载失败')
        notify({ type: 'error', title: '加载店铺失败', message: normalizeErrorMessage(err) })
      })
      .finally(() => {
        if (!alive) return
        setProjectsLoading(false)
      })
    return () => {
      alive = false
    }
  }, [notify, projectRetryKey])

  const fetchList = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const data = await listInvoices({
        project_id: projectId ? Number(projectId) : undefined,
        status: status || undefined,
        q: q || undefined,
        limit: HISTORY_PAGE_SIZE + 1,
        offset: (page - 1) * HISTORY_PAGE_SIZE,
      })
      if (data.length === 0 && page > 1) {
        setPage((current) => Math.max(1, current - 1))
        setRows([])
        setHasNextPage(false)
        return
      }
      setRows(data.slice(0, HISTORY_PAGE_SIZE))
      setHasNextPage(data.length > HISTORY_PAGE_SIZE)
    } catch (err) {
      const message = normalizeErrorMessage(err)
      setLoadError(message)
      notify({ type: 'error', title: '加载发票失败', message })
      setRows([])
      setHasNextPage(false)
    } finally {
      setLoading(false)
    }
  }, [page, projectId, status, q, notify])

  useEffect(() => {
    fetchList()
  }, [fetchList])

  const onVoid = async (id: number) => {
    const reason = typeof window !== 'undefined' ? window.prompt('作废原因（可选）：') : ''
    if (reason === null) return
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

  const onExportCsv = async () => {
    setExporting(true)
    try {
      const exportRows = await listAllInvoices({
        project_id: projectId ? Number(projectId) : undefined,
        status: status || undefined,
        q: q || undefined,
      })
      if (exportRows.length === 0) {
        notify({ type: 'info', title: '没有可导出的数据' })
        return
      }
      const csv = exportInvoicesCsv(exportRows)
      const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `vat-invoices-${new Date().toISOString().slice(0, 10)}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      notify({ type: 'error', title: '导出失败', message: normalizeErrorMessage(err) })
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className={styles.historyStack}>
      <section className={styles.panel} aria-labelledby="vat-history-filters-title" data-warm-panel="true">
        <header className={styles.panelHeader}>
          <h2 id="vat-history-filters-title" className={styles.panelTitle}>
            VAT 发票历史
          </h2>
        </header>
        <div className={styles.historyToolbar}>
            <div className={styles.field} aria-busy={projectsLoading || undefined}>
              <Label htmlFor="project" className={styles.label}>
                店铺
              </Label>
              <Select
                value={projectId || 'all'}
                onValueChange={(v) => {
                  setProjectId(v === 'all' ? '' : v)
                  setPage(1)
                }}
              >
                <SelectTrigger
                  id="project"
                  className={styles.selectTrigger}
                  disabled={projectsLoading}
                  aria-invalid={projectsError ? true : undefined}
                  aria-describedby={projectsError ? 'vat-history-project-error' : undefined}
                >
                  <SelectValue placeholder="全部" />
                </SelectTrigger>
                <SelectContent className={cn('warm-ledger', styles.selectContent)}>
                  <SelectItem value="all">全部</SelectItem>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {projectsLoading ? (
                <span className={styles.projectControlStatus} role="status">
                  正在加载店铺
                </span>
              ) : projectsError ? (
                <div className={styles.projectControlStatus}>
                  <span
                    id="vat-history-project-error"
                    className={styles.projectControlError}
                    role="alert"
                  >
                    {projectsError}
                  </span>
                  <WarmButton
                    className={styles.projectRetry}
                    variant="quiet"
                    onClick={() => setProjectRetryKey((current) => current + 1)}
                  >
                    重试
                  </WarmButton>
                </div>
              ) : null}
            </div>
            <div className={styles.field}>
              <Label htmlFor="status" className={styles.label}>
                状态
              </Label>
              <Select
                value={status || 'all'}
                onValueChange={(v) => {
                  setStatus((v === 'all' ? '' : v) as StatusFilter)
                  setPage(1)
                }}
              >
                <SelectTrigger id="status" className={styles.selectTrigger}>
                  <SelectValue placeholder="全部" />
                </SelectTrigger>
                <SelectContent className={cn('warm-ledger', styles.selectContent)}>
                  <SelectItem value="all">全部</SelectItem>
                  <SelectItem value="draft">草稿</SelectItem>
                  <SelectItem value="issued">已签发</SelectItem>
                  <SelectItem value="voided">已作废</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className={styles.field}>
              <Label htmlFor="q" className={styles.label}>
                关键字（发票号/订单号）
              </Label>
              <Input
                id="q"
                className={cn(styles.control, styles.numericControl)}
                value={q}
                onChange={(e) => {
                  setQ(e.target.value)
                  setPage(1)
                }}
                placeholder="INV-… 或 ORDER-…"
              />
            </div>
            <div>
              <WarmButton
                onClick={() => void onExportCsv()}
                variant="secondary"
                loading={exporting}
                loadingLabel="正在导出 CSV"
                className={styles.historyToolbarAction}
              >
                <Download aria-hidden />
                导出 CSV
              </WarmButton>
            </div>
        </div>
      </section>

      <section className={styles.panel} aria-labelledby="vat-history-list-title" data-warm-panel="true">
        <header className={styles.panelHeader}>
          <h2 id="vat-history-list-title" className={styles.panelTitle}>
            发票列表
          </h2>
          <nav className={styles.panelActions} aria-label="发票历史分页">
            <span className={styles.label} role="status" aria-live="polite">
              第 {page} 页 · 本页 {rows.length} 张
            </span>
            <WarmButton
              variant="secondary"
              disabled={loading || page <= 1}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              上一页
            </WarmButton>
            <WarmButton
              variant="secondary"
              disabled={loading || !hasNextPage}
              onClick={() => setPage((current) => current + 1)}
            >
              下一页
            </WarmButton>
          </nav>
        </header>
        <div className={styles.panelBody} aria-busy={loading || undefined}>
          {loadError ? (
            <div className={styles.loadError} role="alert">
              <span>加载发票列表失败：{loadError}</span>
              <WarmButton variant="quiet" onClick={() => void fetchList()}>
                重试
              </WarmButton>
            </div>
          ) : (
            <InvoiceHistoryTable
              rows={rows}
              loading={loading}
              onSelect={onSelect}
              onDownload={onDownload}
              onVoid={onVoid}
            />
          )}
        </div>
      </section>

      <InvoiceDetailDialog
        invoiceId={detailId}
        open={detailOpen}
        onOpenChange={setDetailOpen}
      />
    </div>
  )
}
