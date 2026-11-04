'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { ArrowLeft, Pencil, Upload } from 'lucide-react'

import {
  ProposalPdfPreview,
  ProposalPreview,
  ProposalStatusPill,
  ProposalTypePill,
  ProposalVersionForm,
  ProposalVersionTimeline,
  type CustomerOption,
} from '@/components/crm/proposal'
import {
  WarmCrmPage,
  WarmCrmSection,
  WarmCrmState,
  WarmCrmStatusPill,
} from '@/components/dashboard-v2/warm-ledger/crm'
import {
  WarmButton,
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
import { cn } from '@/lib/utils'
import { downloadBlob } from '@/lib/download-blob'
import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import { useCrmDataScope } from '@/hooks/use-crm-data-scope'
import { proposalUploadErrorCopy } from '@/lib/crm/method/proposal-upload-error'
import {
  PROPOSAL_STATUS_LABELS,
  PROPOSAL_STATUS_ORDER,
  PROPOSAL_TYPE_LABELS,
  PROPOSAL_TYPE_ORDER,
  proposalDownloadFilename,
  proposalFileFormat,
  type ProposalDetail,
  type ProposalFileFormat,
  type ProposalStatus,
  type ProposalType,
} from '@/lib/crm/types'
import sharedStyles from '@/components/crm/proposal/proposal-warm.module.css'
import styles from '../proposals-warm.module.css'

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

  // 当前版本的载荷格式：PDF 走原生阅读器（blob URL），HTML 走 sandbox iframe。
  const selectedVersion =
    detail?.versions.find((v) => v.versionNo === selectedVersionNo) ?? null
  const selectedFormat: ProposalFileFormat = selectedVersion
    ? proposalFileFormat(selectedVersion)
    : 'html'

  // 预览内容：从后端取（经鉴权转发），不直连 R2、不用公开 URL。
  useEffect(() => {
    if (!detail || selectedVersionNo == null) return
    // PDF 版本没有 HTML 文本，改由 ProposalPdfPreview 拉字节。
    if (selectedFormat === 'pdf') return
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
  }, [client, detail, selectedVersionNo, previewRaw, notify, selectedFormat])

  // PDF 字节：同样经后端鉴权转发，前端只把字节转成 blob URL 给内嵌阅读器。
  const loadPdf = useCallback(async () => {
    if (!detail || selectedVersionNo == null) throw new Error('未选择版本')
    return client.downloadProposalVersion(detail.id, selectedVersionNo, { raw: previewRaw })
  }, [client, detail, selectedVersionNo, previewRaw])

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
        // BLF-1404：按状态码区分 413（文件超 20MB）/ 504（上传超时）/ 其它。
        const copy = proposalUploadErrorCopy(e, {
          title: '上传失败',
          message: '上传失败',
        })
        notify({ type: 'error', title: copy.title, message: copy.message })
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
        const version = detail.versions.find((v) => v.versionNo === versionNo)
        const format = version ? proposalFileFormat(version) : 'html'
        downloadBlob(blob, proposalDownloadFilename(detail.title, versionNo, opts?.raw, format))
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
    return (
      <WarmCrmPage>
        <WarmCrmState kind="loading" title="加载中…" />
      </WarmCrmPage>
    )
  }
  if (!detail) {
    return (
      <WarmCrmPage>
        <WarmCrmState
          action={
            <Link
              href="/dashboard/crm/proposals"
              className={sharedStyles.linkButton}
            >
              返回列表
            </Link>
          }
          kind="error"
          title={`ERR · ${error ?? '方案不存在'}`}
        />
      </WarmCrmPage>
    )
  }

  return (
    <WarmCrmPage className={styles.detailPage} data-proposal-preview-layout>
      <div className={styles.sidebar}>
        {error ? (
          <WarmCrmState kind="error" title={`ERR · ${error}`} />
        ) : null}

        <WarmCrmSection
          aria-label="方案信息"
          bodyClassName={styles.infoBody}
          className={styles.infoPanel}
        >
          <div className={styles.titleRow}>
            <Link
              href="/dashboard/crm/proposals"
              className={cn('warm-ledger__icon-button', styles.backLink)}
              aria-label="返回方案列表"
            >
              <ArrowLeft aria-hidden="true" />
            </Link>
            <h1 className={styles.title} title={detail.title}>
              {detail.title}
            </h1>
          </div>

          <div className={styles.pills}>
            <ProposalStatusPill status={detail.status} />
            <ProposalTypePill type={detail.proposalType} />
          </div>

          <div className={styles.meta}>
            <span
              className={styles.metaLine}
              title={detail.customerName ?? undefined}
            >
              客户：{detail.customerName ?? '未关联'}
            </span>
            <span
              className={styles.metaLine}
              title={detail.ownerName ?? detail.ownerId ?? undefined}
            >
              负责人：{detail.ownerName ?? detail.ownerId ?? '—'}
            </span>
          </div>

          <div className={styles.infoActions}>
            <WarmButton className={styles.infoAction} onClick={openEdit}>
              <Pencil aria-hidden="true" />
              编辑
            </WarmButton>
            <WarmButton className={styles.infoAction} onClick={() => setVersionOpen(true)}>
              <Upload aria-hidden="true" />
              上传新版本
            </WarmButton>
          </div>
        </WarmCrmSection>

        <WarmCrmSection
          actions={
            selectedFormat === 'pdf' ? (
              <WarmCrmStatusPill>PDF</WarmCrmStatusPill>
            ) : (
              <WarmSegmentedControl
                ariaLabel="预览模式"
                value={previewRaw ? 'raw' : 'adapted'}
                options={[
                  { value: 'adapted', label: '适配版' },
                  { value: 'raw', label: '原始版' },
                ]}
                onChange={(value) => setPreviewRaw(value === 'raw')}
              />
            )
          }
          bodyClassName={styles.versionsBody}
          className={styles.versionsSection}
          title={`版本历史（${detail.versionCount}）`}
        >
          <ProposalVersionTimeline
            versions={detail.versions}
            currentVersionNo={detail.currentVersionNo}
            selectedVersionNo={selectedVersionNo ?? detail.currentVersionNo}
            onSelect={(no) => setSelectedVersionNo(no)}
            onDownload={(no, opts) => void handleDownload(no, opts)}
            downloadingVersionNo={downloadingVersionNo}
          />
        </WarmCrmSection>
      </div>

      <WarmCrmSection
        aria-label="方案预览"
        bodyClassName={styles.previewBody}
        className={styles.previewSection}
      >
        {selectedFormat === 'pdf' ? (
          <ProposalPdfPreview
            title={detail.title}
            load={loadPdf}
            heightClassName={styles.previewFill}
            onError={(message) =>
              notify({ type: 'error', title: 'PDF 预览失败', message })
            }
          />
        ) : contentLoading && !content ? (
          <WarmCrmState
            className={sharedStyles.previewState}
            kind="loading"
            title="加载预览…"
          />
        ) : content ? (
          <ProposalPreview
            content={content}
            title={detail.title}
            heightClassName={styles.previewFill}
          />
        ) : (
          <WarmCrmState
            className={sharedStyles.previewState}
            kind="empty"
            title="暂无内容"
          />
        )}
      </WarmCrmSection>

      <Dialog open={versionOpen} onOpenChange={setVersionOpen}>
        <DialogContent className={cn('warm-ledger', styles.dialog)}>
          <DialogHeader>
            <DialogTitle className={styles.dialogTitle}>上传新版本</DialogTitle>
            <DialogDescription className={styles.dialogDescription}>
              旧版本不会被改写；新版本成为当前版本（v{detail.currentVersionNo + 1}）。
            </DialogDescription>
          </DialogHeader>
          <ProposalVersionForm submitting={uploading} onSubmit={handleUploadVersion} />
        </DialogContent>
      </Dialog>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className={cn('warm-ledger', styles.dialog, styles.editDialog)}>
          <DialogHeader>
            <DialogTitle className={styles.dialogTitle}>编辑方案</DialogTitle>
            <DialogDescription className={styles.dialogDescription}>
              改标题 / 类型 / 状态 / 关联客户。
            </DialogDescription>
          </DialogHeader>
          <form
            className={styles.editForm}
            onSubmit={(e) => {
              e.preventDefault()
              void handleSaveEdit()
            }}
          >
            <label className={sharedStyles.field}>
              <span className={sharedStyles.label}>标题</span>
              <input
                className={sharedStyles.input}
                value={editTitle}
                maxLength={200}
                onChange={(e) => setEditTitle(e.target.value)}
              />
            </label>
            <div className={styles.editFields}>
              <label className={sharedStyles.field}>
                <span className={sharedStyles.label}>类型</span>
                <select
                  className={sharedStyles.select}
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
              <label className={sharedStyles.field}>
                <span className={sharedStyles.label}>状态</span>
                <select
                  className={sharedStyles.select}
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
            <label className={sharedStyles.field}>
              <span className={sharedStyles.label}>关联客户</span>
              <select
                className={sharedStyles.select}
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
            <div className={styles.editActions}>
              <WarmButton type="submit" variant="primary" disabled={saving} loading={saving}>
                保存
              </WarmButton>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </WarmCrmPage>
  )
}
