'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Download, Eye, Loader2, Plus, Search, Trash2 } from 'lucide-react'

import {
  ProposalCreateForm,
  ProposalStatusPill,
  ProposalTypePill,
  type CustomerOption,
} from '@/components/crm/proposal'
import {
  CrmPageShell,
  CrmToolbarRow,
  TERM_BUTTON,
  TERM_INPUT,
  TERM_SELECT_NATIVE,
} from '@/components/crm/term-shared'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useNotifications } from '@/components/notifications'
import { useConfirm } from '@/hooks/use-confirm'
import { downloadBlob } from '@/lib/download-blob'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import { useCrmDataScope } from '@/hooks/use-crm-data-scope'
import {
  PROPOSAL_STATUS_LABELS,
  PROPOSAL_STATUS_ORDER,
  PROPOSAL_TYPE_LABELS,
  PROPOSAL_TYPE_ORDER,
  proposalDownloadFilename,
  type Proposal,
  type ProposalStatus,
  type ProposalType,
} from '@/lib/crm/types'
import { ScopeToggle } from '../customers/components/scope-toggle'
import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'

const PAGE_SIZE = 50

type StatusFilter = 'all' | ProposalStatus
type TypeFilter = 'all' | ProposalType

export default function ProposalsPage() {
  const client = useCrmClient()
  const { scope } = useCrmDataScope()
  const { notify } = useNotifications()
  const { confirm } = useConfirm()

  const [items, setItems] = useState<Proposal[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [keyword, setKeyword] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [refreshKey, setRefreshKey] = useState(0)

  const [createOpen, setCreateOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [customers, setCustomers] = useState<CustomerOption[]>([])
  const [downloadingId, setDownloadingId] = useState<string | null>(null)

  const filters = useMemo(() => {
    const out: Array<{ field: string; op: 'eq'; value: unknown }> = []
    if (statusFilter !== 'all') out.push({ field: 'status', op: 'eq', value: statusFilter })
    if (typeFilter !== 'all') out.push({ field: 'proposal_type', op: 'eq', value: typeFilter })
    return out
  }, [statusFilter, typeFilter])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const page = await client.listProposals({
        scope,
        keyword: keyword.trim() || undefined,
        filters: filters.length > 0 ? filters : undefined,
        sortBy: 'updated_at',
        sortOrder: 'desc',
        pageSize: PAGE_SIZE,
      })
      setItems(page.items)
      setTotal(page.total)
    } catch (e) {
      // A failed manual refresh should not erase the last successful page.
      setError(e instanceof Error ? e.message : '加载方案失败')
    } finally {
      setLoading(false)
    }
  }, [client, scope, keyword, filters])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  const refreshRef = useRef(load)
  refreshRef.current = load
  useHeaderRefresh(() => refreshRef.current(), { loading })

  // 建方案时要选客户：按当前数据范围拉一页（管理员 all 可见全部）。
  useEffect(() => {
    if (!createOpen) return
    let cancelled = false
    void (async () => {
      try {
        const page = await client.listCustomers({ scope, pageSize: 200 })
        if (!cancelled) setCustomers(page.items.map((c) => ({ id: c.id, name: c.name })))
      } catch {
        if (!cancelled) setCustomers([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [client, scope, createOpen])

  const handleCreate = useCallback(
    async (input: Parameters<typeof client.createProposal>[0]) => {
      setCreating(true)
      try {
        const result = await client.createProposal(input)
        setCreateOpen(false)
        setRefreshKey((k) => k + 1)
        if (result.warnings.length > 0) {
          notify({
            type: 'warning',
            title: '已创建，但有适配提示',
            message: result.warnings.join('；'),
          })
        } else {
          notify({ type: 'success', title: '方案已创建', message: `${result.proposal.title} · v1` })
        }
      } catch (e) {
        notify({
          type: 'error',
          title: '创建失败',
          message: e instanceof Error ? e.message : '创建方案失败',
        })
      } finally {
        setCreating(false)
      }
    },
    [client, notify]
  )

  const handleDownload = useCallback(
    async (proposal: Proposal, raw = false) => {
      setDownloadingId(proposal.id)
      try {
        const blob = await client.downloadProposalVersion(
          proposal.id,
          proposal.currentVersionNo,
          { raw }
        )
        downloadBlob(blob, proposalDownloadFilename(proposal.title, proposal.currentVersionNo, raw))
      } catch (e) {
        notify({
          type: 'error',
          title: '下载失败',
          message: e instanceof Error ? e.message : '下载失败',
        })
      } finally {
        setDownloadingId(null)
      }
    },
    [client, notify]
  )

  const handleDelete = useCallback(
    async (proposal: Proposal) => {
      const ok = await confirm({
        title: '删除方案',
        description: `删除「${proposal.title}」及其全部 ${proposal.versionCount} 个版本？此操作不可撤销。`,
        confirmText: '删除',
        variant: 'destructive',
      })
      if (!ok) return
      try {
        await client.deleteProposal(proposal.id)
        notify({ type: 'success', title: '已删除', message: proposal.title })
        setRefreshKey((k) => k + 1)
      } catch (e) {
        notify({
          type: 'error',
          title: '删除失败',
          message: e instanceof Error ? e.message : '删除失败',
        })
      }
    },
    [client, confirm, notify]
  )

  return (
    <CrmPageShell>
      <CrmToolbarRow
        left={
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-term-faint" />
              <input
                aria-label="搜索方案标题"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="搜索方案标题…"
                className={`${TERM_INPUT} w-56 pl-7`}
              />
            </div>
            <select
              aria-label="按状态筛选"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
              className={TERM_SELECT_NATIVE}
            >
              <option value="all">全部状态</option>
              {PROPOSAL_STATUS_ORDER.map((s) => (
                <option key={s} value={s}>
                  {PROPOSAL_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
            <select
              aria-label="按类型筛选"
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value as TypeFilter)}
              className={TERM_SELECT_NATIVE}
            >
              <option value="all">全部类型</option>
              {PROPOSAL_TYPE_ORDER.map((t) => (
                <option key={t} value={t}>
                  {PROPOSAL_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </div>
        }
        right={
          <div className="flex items-center gap-1.5">
            <ScopeToggle />
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className={`${TERM_BUTTON} gap-1.5`}
            >
              <Plus className="h-3.5 w-3.5" />
              新建方案
            </button>
          </div>
        }
      />

      {error ? (
        <div
          role="alert"
          className="border border-term-neg/50 bg-term-neg/10 px-2 py-1 font-mono text-xs text-term-neg"
        >
          ERR · {error}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto border border-term-border">
        <table className="w-full border-collapse text-left">
          <thead className="sticky top-0 bg-term-panel">
            <tr className="border-b border-term-border font-mono text-[11px] uppercase text-term-faint">
              <th className="px-2 py-1.5 font-normal">标题</th>
              <th className="px-2 py-1.5 font-normal">客户</th>
              <th className="px-2 py-1.5 font-normal">类型</th>
              <th className="px-2 py-1.5 font-normal">状态</th>
              <th className="px-2 py-1.5 font-normal">版本</th>
              <th className="px-2 py-1.5 font-normal">更新时间</th>
              <th className="px-2 py-1.5 text-right font-normal">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading && items.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-2 py-16 text-center font-mono text-xs text-term-faint">
                  加载中…
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-2 py-16 text-center font-mono text-xs text-term-faint">
                  还没有方案 · 点右上「新建方案」上传第一个单个 HTML
                </td>
              </tr>
            ) : (
              items.map((p) => (
                <tr key={p.id} className="border-b border-term-border/60 hover:bg-term-hover">
                  <td className="max-w-[280px] px-2 py-1.5">
                    <Link
                      href={`/dashboard/crm/proposals/${p.id}`}
                      className="truncate text-xs text-term-text hover:underline"
                      title={p.title}
                    >
                      {p.title}
                    </Link>
                  </td>
                  <td className="px-2 py-1.5 font-mono text-xs text-term-muted">
                    {p.customerName ?? '—'}
                  </td>
                  <td className="px-2 py-1.5">
                    <ProposalTypePill type={p.proposalType} />
                  </td>
                  <td className="px-2 py-1.5">
                    <ProposalStatusPill status={p.status} />
                  </td>
                  <td className="px-2 py-1.5 font-mono text-xs text-term-muted">
                    v{p.currentVersionNo}
                    <span className="text-term-faint"> · {p.versionCount} 版</span>
                  </td>
                  <td className="px-2 py-1.5 font-mono text-[11px] text-term-faint">
                    {new Date(p.updatedAt).toLocaleString('zh-CN', { hour12: false })}
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="flex items-center justify-end gap-1">
                      <Link
                        href={`/dashboard/crm/proposals/${p.id}`}
                        className={`${TERM_BUTTON} h-7 px-1.5`}
                        aria-label={`查看 ${p.title}`}
                        title="查看"
                      >
                        <Eye className="h-3.5 w-3.5" />
                      </Link>
                      <button
                        type="button"
                        onClick={() => void handleDownload(p)}
                        disabled={downloadingId === p.id}
                        className={`${TERM_BUTTON} h-7 px-1.5`}
                        aria-label={`下载 ${p.title}`}
                        title="下载当前版本"
                      >
                        {downloadingId === p.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Download className="h-3.5 w-3.5" />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDelete(p)}
                        className={`${TERM_BUTTON} h-7 px-1.5 hover:text-term-neg`}
                        aria-label={`删除 ${p.title}`}
                        title="删除"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className="font-mono text-[11px] text-term-faint">共 {total} 个方案</p>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>新建客户方案</DialogTitle>
            <DialogDescription>
              上传单个 HTML 文件；系统会解析并注入本项目主题令牌后固化保存为 v1。
            </DialogDescription>
          </DialogHeader>
          <ProposalCreateForm
            customers={customers}
            submitting={creating}
            onSubmit={handleCreate}
          />
        </DialogContent>
      </Dialog>
    </CrmPageShell>
  )
}
