'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Download, Eye, Plus, Search, Trash2 } from 'lucide-react'

import {
  ProposalCreateForm,
  ProposalStatusPill,
  ProposalTypePill,
  type CustomerOption,
} from '@/components/crm/proposal'
import {
  WarmCrmPage,
  WarmCrmState,
  WarmCrmTableFrame,
  WarmCrmTableScroller,
  WarmCrmToolbar,
} from '@/components/dashboard-v2/warm-ledger/crm'
import {
  WarmButton,
  WarmIconButton,
  WarmSegmentedControl,
} from '@/components/dashboard-v2/warm-ledger/controls'
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
import { proposalUploadErrorCopy } from '@/lib/crm/method/proposal-upload-error'
import {
  PROPOSAL_STATUS_LABELS,
  PROPOSAL_STATUS_ORDER,
  PROPOSAL_TYPE_LABELS,
  PROPOSAL_TYPE_ORDER,
  proposalBlobFormat,
  proposalDownloadFilename,
  type Proposal,
  type ProposalStatus,
  type ProposalType,
} from '@/lib/crm/types'
import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'
import { cn } from '@/lib/utils'
import sharedStyles from '@/components/crm/proposal/proposal-warm.module.css'
import styles from './proposals-warm.module.css'

const PAGE_SIZE = 50

type StatusFilter = 'all' | ProposalStatus
type TypeFilter = 'all' | ProposalType

export default function ProposalsPage() {
  const client = useCrmClient()
  const { scope, setScope } = useCrmDataScope()
  const { notify } = useNotifications()
  const { confirm } = useConfirm()

  const [itemsResult, setItemsResult] = useState<{
    signature: string
    items: Proposal[]
    total: number
  } | null>(null)
  const [loading, setLoading] = useState(true)
  const [errorResult, setErrorResult] = useState<{ signature: string; message: string } | null>(null)
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
  const querySignature = JSON.stringify([scope, keyword.trim(), filters])
  const items = itemsResult?.signature === querySignature ? itemsResult.items : []
  const total = itemsResult?.signature === querySignature ? itemsResult.total : 0
  const error = errorResult?.signature === querySignature ? errorResult.message : null
  const isLoading = loading || (itemsResult?.signature !== querySignature && !error)

  const load = useCallback(async () => {
    setLoading(true)
    setErrorResult(null)
    try {
      const page = await client.listProposals({
        scope,
        keyword: keyword.trim() || undefined,
        filters: filters.length > 0 ? filters : undefined,
        sortBy: 'updated_at',
        sortOrder: 'desc',
        pageSize: PAGE_SIZE,
      })
      setItemsResult({ signature: querySignature, items: page.items, total: page.total })
    } catch (e) {
      // A failed manual refresh should not erase the last successful page for this query.
      setErrorResult({
        signature: querySignature,
        message: e instanceof Error ? e.message : '加载方案失败',
      })
    } finally {
      setLoading(false)
    }
  }, [client, scope, keyword, filters, querySignature])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  const refreshRef = useRef(load)
  refreshRef.current = load
  useHeaderRefresh(() => refreshRef.current(), { loading: isLoading })

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
        // BLF-1404：按状态码区分 413（文件超 20MB）/ 504（上传超时）/ 其它，
        // 避免三类根因都落成同一句「创建失败」。
        const copy = proposalUploadErrorCopy(e, {
          title: '创建失败',
          message: '创建方案失败',
        })
        notify({ type: 'error', title: copy.title, message: copy.message })
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
        downloadBlob(
          blob,
          proposalDownloadFilename(
            proposal.title,
            proposal.currentVersionNo,
            raw,
            proposalBlobFormat(blob)
          )
        )
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
    <WarmCrmPage className={styles.listPage}>
      <WarmCrmToolbar
        ariaLabel="客户方案筛选与操作"
        start={
          <>
            <label className={styles.searchField}>
              <span className={sharedStyles.visuallyHidden}>搜索方案标题</span>
              <Search aria-hidden="true" className={styles.searchIcon} />
              <input
                aria-label="搜索方案标题"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="搜索方案标题…"
                className={cn(sharedStyles.input, styles.searchInput)}
              />
            </label>
            <select
              aria-label="按状态筛选"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
              className={cn(sharedStyles.select, styles.filterSelect)}
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
              className={cn(sharedStyles.select, styles.filterSelect)}
            >
              <option value="all">全部类型</option>
              {PROPOSAL_TYPE_ORDER.map((t) => (
                <option key={t} value={t}>
                  {PROPOSAL_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </>
        }
        end={
          <>
            <WarmSegmentedControl
              ariaLabel="数据范围"
              value={scope}
              options={[
                { value: 'mine', label: '我的' },
                { value: 'all', label: '全部' },
              ]}
              onChange={setScope}
            />
            <WarmButton variant="primary" onClick={() => setCreateOpen(true)}>
              <Plus aria-hidden="true" />
              新建方案
            </WarmButton>
          </>
        }
      />

      {error ? (
        <WarmCrmState
          action={<WarmButton onClick={() => void load()}>重试</WarmButton>}
          kind="error"
          title={`ERR · ${error}`}
        />
      ) : null}

      <WarmCrmTableFrame footer={<span className={styles.footerCount}>共 {total} 个方案</span>}>
        <WarmCrmTableScroller ariaLabel="客户方案列表">
          <table>
            <thead>
              <tr>
                <th>标题</th>
                <th>客户</th>
                <th>类型</th>
                <th>状态</th>
                <th>版本</th>
                <th>更新时间</th>
                <th className={styles.actionsCell}>操作</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && items.length === 0 ? (
                <tr>
                  <td colSpan={7} className={styles.stateCell}>
                    <WarmCrmState kind="loading" title="加载中…" />
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={7} className={styles.stateCell}>
                    <WarmCrmState
                      kind="empty"
                      title="还没有方案 · 点右上「新建方案」上传第一个 HTML / PDF"
                    />
                  </td>
                </tr>
              ) : (
                items.map((p) => (
                  <tr key={p.id}>
                    <td className={styles.titleCell}>
                      <Link
                        href={`/dashboard/crm/proposals/${p.id}`}
                        className={styles.titleLink}
                        title={p.title}
                      >
                        {p.title}
                      </Link>
                    </td>
                    <td className={styles.customerCell}>{p.customerName ?? '—'}</td>
                    <td>
                      <ProposalTypePill type={p.proposalType} />
                    </td>
                    <td>
                      <ProposalStatusPill status={p.status} />
                    </td>
                    <td className={styles.versionCell}>
                      v{p.currentVersionNo}
                      <span className={styles.versionCount}> · {p.versionCount} 版</span>
                    </td>
                    <td className={styles.dateCell}>
                      {new Date(p.updatedAt).toLocaleString('zh-CN', { hour12: false })}
                    </td>
                    <td className={styles.actionsCell}>
                      <div className={styles.rowActions}>
                        <Link
                          href={`/dashboard/crm/proposals/${p.id}`}
                          className="warm-ledger__icon-button"
                          aria-label={`查看 ${p.title}`}
                          title="查看"
                        >
                          <Eye aria-hidden="true" />
                        </Link>
                        <WarmIconButton
                          aria-label={`下载 ${p.title}`}
                          title="下载当前版本"
                          loading={downloadingId === p.id}
                          onClick={() => void handleDownload(p)}
                        >
                          <Download aria-hidden="true" />
                        </WarmIconButton>
                        <WarmIconButton
                          className={styles.dangerButton}
                          aria-label={`删除 ${p.title}`}
                          title="删除"
                          onClick={() => void handleDelete(p)}
                        >
                          <Trash2 aria-hidden="true" />
                        </WarmIconButton>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </WarmCrmTableScroller>
      </WarmCrmTableFrame>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className={cn('warm-ledger', styles.dialog)}>
          <DialogHeader>
            <DialogTitle className={styles.dialogTitle}>新建客户方案</DialogTitle>
            <DialogDescription className={styles.dialogDescription}>
              上传单个 HTML 或 PDF 文件。HTML 会解析并注入本项目主题令牌，PDF 原样保存；两者都固化为 v1。
            </DialogDescription>
          </DialogHeader>
          <ProposalCreateForm
            customers={customers}
            submitting={creating}
            onSubmit={handleCreate}
          />
        </DialogContent>
      </Dialog>
    </WarmCrmPage>
  )
}
