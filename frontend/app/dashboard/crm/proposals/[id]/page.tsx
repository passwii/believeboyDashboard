'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { ArrowLeft, Download, Loader2, Pencil, Upload } from 'lucide-react'

import {
  ProposalPreview,
  ProposalStatusPill,
  ProposalTypePill,
  ProposalVersionForm,
  ProposalVersionTimeline,
  type CustomerOption,
} from '@/components/crm/proposal'
import {
  CrmPageShell,
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
import { downloadBlob } from '@/lib/download-blob'
import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import { useCrmDataScope } from '@/hooks/use-crm-data-scope'
import {
  PROPOSAL_STATUS_LABELS,
  PROPOSAL_STATUS_ORDER,
  PROPOSAL_TYPE_LABELS,
  PROPOSAL_TYPE_ORDER,
  proposalDownloadFilename,
  type ProposalDetail,
  type ProposalStatus,
  type ProposalType,
} from '@/lib/crm/types'

export default function ProposalDetailPage() {
  const params = useParams<{ id: string }>()
  const proposalId = params?.id ?? ''
  const client = useCrmClient()
  const { scope } = useCrmDataScope()
  const { notify } = useNotifications()

  const [detail, setDetail] = useState<ProposalDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [selectedVersionNo, setSelectedVersionNo] = useState<number | null>(null)
  const [previewRaw, setPreviewRaw] = useState(false)
  const [content, setContent] = useState<string>('')
  const [contentLoading, setContentLoading] = useState(false)
  const [downloadingVersionNo, setDownloadingVersionNo] = useState<number | null>(null)

  const [versionOpen, setVersionOpen] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [customers, setCustomers] = useState<CustomerOption[]>([])
  const [editTitle, setEditTitle] = useState('')
  const [editType, setEditType] = useState<ProposalType>('other')
  const [editStatus, setEditStatus] = useState<ProposalStatus>('draft')
  const [editCustomerId, setEditCustomerId] = useState('')

  const load = useCallback(async () => {
    if (!proposalId) return
    setLoading(true)
    setError(null)
    try {
      const data = await client.getProposal(proposalId)
      setDetail(data)
      setSelectedVersionNo((prev) => prev ?? data.currentVersionNo)
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载方案失败')
      setDetail(null)
    } finally {
      setLoading(false)
    }
  }, [client, proposalId])

  useEffect(() => {
    void load()
  }, [load])

  const refreshRef = useRef(load)
  refreshRef.current = load
  useHeaderRefresh(() => refreshRef.current(), { loading })

  const selectedVersion = useMemo(
    () => detail?.versions.find((v) => v.versionNo === selectedVersionNo) ?? null,
    [detail, selectedVersionNo]
  )

  // 预览内容：从后端取（经鉴权转发），不直连 R2、不用公开 URL。
  useEffect(() => {
    if (!detail || selectedVersionNo == null) return
    let cancelled = false
    setContentLoading(true)
    void (async () => {
      try {
        const res = await client.getProposalVersionContent(detail.id, selectedVersionNo, {
          raw: previewRaw,
        })
        if (!cancelled) setContent(res.content)
      } catch (e) {
        if (!cancelled) {
          setContent('')
          notify({
            type: 'error',
            title: '预览失败',
            message: e instanceof Error ? e.message : '加载预览失败',
          })
        }
      } finally {
        if (!cancelled) setContentLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [client, detail, selectedVersionNo, previewRaw, notify])

  const openEdit = useCallback(() => {
    if (!detail) return
    setEditTitle(detail.title)
    setEditType(detail.proposalType)
    setEditStatus(detail.status)
    setEditCustomerId(detail.customerId ?? '')
    setEditOpen(true)
  }, [detail])

  useEffect(() => {
    if (!editOpen) return
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
  }, [client, scope, editOpen])

  const handleSaveEdit = useCallback(async () => {
    if (!detail) return
    setSaving(true)
    try {
      const next = await client.updateProposal(detail.id, {
        title: editTitle.trim() || undefined,
        proposalType: editType,
        status: editStatus,
        customerId: editCustomerId || null,
      })
      setDetail((prev) => (prev ? { ...prev, ...next } : prev))
      setEditOpen(false)
      notify({ type: 'success', title: '已保存', message: next.title })
    } catch (e) {
      notify({
        type: 'error',
        title: '保存失败',
        message: e instanceof Error ? e.message : '保存失败',
      })
    } finally {
      setSaving(false)
    }
  }, [client, detail, editTitle, editType, editStatus, editCustomerId, notify])

  const handleUploadVersion = useCallback(
    async (input: Parameters<typeof client.addProposalVersion>[1]) => {
      if (!detail) return
      setUploading(true)
      try {
        const result = await client.addProposalVersion(detail.id, input)
        setVersionOpen(false)
        setSelectedVersionNo(result.version.versionNo)
        setPreviewRaw(false)
        await load()
        if (result.warnings.length > 0) {
          notify({
            type: 'warning',
            title: `已上传 v${result.version.versionNo}，但有适配提示`,
            message: result.warnings.join('；'),
          })
        } else {
          notify({
            type: 'success',
            title: '新版本已上传',
            message: `v${result.version.versionNo}`,
          })
        }
      } catch (e) {
        notify({
          type: 'error',
          title: '上传失败',
          message: e instanceof Error ? e.message : '上传失败',
        })
      } finally {
        setUploading(false)
      }
    },
    [client, detail, load, notify]
  )

  const handleDownload = useCallback(
    async (versionNo: number, opts?: { raw?: boolean }) => {
      if (!detail) return
      setDownloadingVersionNo(versionNo)
      try {
        const blob = await client.downloadProposalVersion(detail.id, versionNo, opts)
        downloadBlob(blob, proposalDownloadFilename(detail.title, versionNo, opts?.raw))
      } catch (e) {
        notify({
          type: 'error',
          title: '下载失败',
          message: e instanceof Error ? e.message : '下载失败',
        })
      } finally {
        setDownloadingVersionNo(null)
      }
    },
    [client, detail, notify]
  )

  if (loading && !detail) {
    return <div className="py-16 text-center font-mono text-xs text-term-faint">加载中…</div>
  }
  if (error || !detail) {
    return (
      <div className="flex flex-col items-start gap-2">
        <div
          role="alert"
          className="border border-term-neg/50 bg-term-neg/10 px-2 py-1 font-mono text-xs text-term-neg"
        >
          ERR · {error ?? '方案不存在'}
        </div>
        <Link href="/dashboard/crm/proposals" className={TERM_BUTTON}>
          返回列表
        </Link>
      </div>
    )
  }

  return (
    <CrmPageShell>
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href="/dashboard/crm/proposals"
          className={`${TERM_BUTTON} h-7 px-1.5`}
          aria-label="返回方案列表"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </Link>
        <h1 className="min-w-0 truncate text-sm text-term-text" title={detail.title}>
          {detail.title}
        </h1>
        <ProposalStatusPill status={detail.status} />
        <ProposalTypePill type={detail.proposalType} />
        <span className="font-mono text-xs text-term-muted">
          客户：{detail.customerName ?? '未关联'}
        </span>
        <span className="font-mono text-xs text-term-faint">
          负责人：{detail.ownerName ?? detail.ownerId ?? '—'}
        </span>

        <div className="ml-auto flex items-center gap-1.5">
          <button type="button" onClick={openEdit} className={`${TERM_BUTTON} gap-1.5`}>
            <Pencil className="h-3.5 w-3.5" />
            编辑
          </button>
          <button
            type="button"
            onClick={() => setVersionOpen(true)}
            className={`${TERM_BUTTON} gap-1.5`}
          >
            <Upload className="h-3.5 w-3.5" />
            上传新版本
          </button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 lg:grid-cols-[1fr_320px]">
        {/* 预览 */}
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-term-muted">
              预览 · v{selectedVersionNo ?? detail.currentVersionNo}
              {previewRaw ? '（原始上传版）' : '（适配版）'}
            </span>
            <label className="flex items-center gap-1 font-mono text-[11px] text-term-faint">
              <input
                type="checkbox"
                checked={previewRaw}
                onChange={(e) => setPreviewRaw(e.target.checked)}
              />
              查看原始版
            </label>
            <button
              type="button"
              onClick={() => void handleDownload(selectedVersionNo ?? detail.currentVersionNo)}
              className={`${TERM_BUTTON} h-7 gap-1.5 px-1.5`}
            >
              {downloadingVersionNo === (selectedVersionNo ?? detail.currentVersionNo) ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              下载此版本
            </button>
          </div>

          {contentLoading && !content ? (
            <div className="flex min-h-[70vh] items-center justify-center border border-term-border">
              <span className="font-mono text-xs text-term-faint">加载预览…</span>
            </div>
          ) : content ? (
            <ProposalPreview content={content} title={detail.title} />
          ) : (
            <div className="flex min-h-[70vh] items-center justify-center border border-term-border">
              <span className="font-mono text-xs text-term-faint">暂无内容</span>
            </div>
          )}

          {selectedVersion?.changeNote ? (
            <p className="font-mono text-[11px] text-term-faint">
              变更说明：{selectedVersion.changeNote}
            </p>
          ) : null}
        </div>

        {/* 版本链 */}
        <div className="flex min-h-0 flex-col gap-1.5">
          <h2 className="font-mono text-xs uppercase text-term-faint">
            版本历史（{detail.versionCount}）
          </h2>
          <ProposalVersionTimeline
            versions={detail.versions}
            currentVersionNo={detail.currentVersionNo}
            selectedVersionNo={selectedVersionNo ?? detail.currentVersionNo}
            onSelect={(no) => setSelectedVersionNo(no)}
            onDownload={(no, opts) => void handleDownload(no, opts)}
            downloadingVersionNo={downloadingVersionNo}
          />
        </div>
      </div>

      <Dialog open={versionOpen} onOpenChange={setVersionOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>上传新版本</DialogTitle>
            <DialogDescription>
              旧版本不会被改写；新版本成为当前版本（v{detail.currentVersionNo + 1}）。
            </DialogDescription>
          </DialogHeader>
          <ProposalVersionForm submitting={uploading} onSubmit={handleUploadVersion} />
        </DialogContent>
      </Dialog>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>编辑方案</DialogTitle>
            <DialogDescription>改标题 / 类型 / 状态 / 关联客户。</DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault()
              void handleSaveEdit()
            }}
          >
            <label className="flex flex-col gap-1">
              <span className="font-mono text-xs text-term-muted">标题</span>
              <input
                className={TERM_INPUT}
                value={editTitle}
                maxLength={200}
                onChange={(e) => setEditTitle(e.target.value)}
              />
            </label>
            <div className="flex flex-wrap gap-3">
              <label className="flex min-w-[140px] flex-1 flex-col gap-1">
                <span className="font-mono text-xs text-term-muted">类型</span>
                <select
                  className={TERM_SELECT_NATIVE}
                  value={editType}
                  onChange={(e) => setEditType(e.target.value as ProposalType)}
                >
                  {PROPOSAL_TYPE_ORDER.map((t) => (
                    <option key={t} value={t}>
                      {PROPOSAL_TYPE_LABELS[t]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex min-w-[140px] flex-1 flex-col gap-1">
                <span className="font-mono text-xs text-term-muted">状态</span>
                <select
                  className={TERM_SELECT_NATIVE}
                  value={editStatus}
                  onChange={(e) => setEditStatus(e.target.value as ProposalStatus)}
                >
                  {PROPOSAL_STATUS_ORDER.map((s) => (
                    <option key={s} value={s}>
                      {PROPOSAL_STATUS_LABELS[s]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="flex flex-col gap-1">
              <span className="font-mono text-xs text-term-muted">关联客户</span>
              <select
                className={TERM_SELECT_NATIVE}
                value={editCustomerId}
                onChange={(e) => setEditCustomerId(e.target.value)}
              >
                <option value="">不关联</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex justify-end">
              <button type="submit" disabled={saving} className={`${TERM_BUTTON} gap-1.5`}>
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                保存
              </button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </CrmPageShell>
  )
}
