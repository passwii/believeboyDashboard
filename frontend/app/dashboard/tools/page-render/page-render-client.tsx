'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Copy,
  ExternalLink,
  FileCode2,
  FileText,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { zhCN } from 'date-fns/locale'

import {
  WarmBadge,
  WarmButton,
  WarmIconButton,
} from '@/components/dashboard-v2/warm-ledger/controls'
import { useNotifications } from '@/components/notifications'
import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'
import { useConfirm } from '@/hooks/use-confirm'
import { normalizeErrorMessage } from '@/lib/error-utils'

import { ToolsPageFrame, ToolsPanel, ToolsUploadZone } from '../_components'
import styles from './page-render.module.css'

const API_BASE = '/api/backend'
const MAX_SIZE_MB = 2
const ACCEPT = '.md,.markdown,.html,.htm,text/markdown,text/x-markdown,text/html,text/plain'

type SourceFormat = 'markdown' | 'html'

type UploadedPage = {
  id: string
  title: string
  source_format: SourceFormat
  public_url: string
  original_filename: string
  file_size: number
  created_at: string
}

function detectFormat(filename: string): SourceFormat | null {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown'
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html'
  return null
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('文件读取失败'))
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.readAsText(file, 'utf-8')
  })
}

function MarkdownPreview({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]}>
      {content}
    </ReactMarkdown>
  )
}

export default function PageRenderClient() {
  const { notify } = useNotifications()
  const { confirm } = useConfirm()

  const [titleInput, setTitleInput] = useState('')
  const [previewContent, setPreviewContent] = useState('')
  const [previewFormat, setPreviewFormat] = useState<SourceFormat | null>(null)
  const [previewFilename, setPreviewFilename] = useState<string | null>(null)
  const [recentlyUploaded, setRecentlyUploaded] = useState<UploadedPage | null>(null)
  const [history, setHistory] = useState<UploadedPage[]>([])
  const [historyTotal, setHistoryTotal] = useState(0)
  const [isUploading, setIsUploading] = useState(false)
  const [isLoadingHistory, setIsLoadingHistory] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)

  const refreshHistory = useCallback(async (preserveExisting = false) => {
    setIsLoadingHistory(true)
    try {
      const res = await fetch(`${API_BASE}/api/v1/page-render/history?limit=50`, {
        cache: 'no-store',
      })
      if (!res.ok) {
        throw new Error(`加载历史失败（${res.status}）`)
      }
      const data = (await res.json()) as { items: UploadedPage[]; total: number }
      setHistory(data.items)
      setHistoryTotal(data.total)
      setHistoryError(null)
    } catch (err) {
      setHistoryError(normalizeErrorMessage(err))
      if (!preserveExisting) {
        notify({ type: 'error', title: '加载历史失败', message: normalizeErrorMessage(err) })
      } else {
        notify({
          type: 'error',
          title: '历史刷新失败，已保留现有列表',
          message: normalizeErrorMessage(err),
        })
      }
    } finally {
      setIsLoadingHistory(false)
    }
  }, [notify])

  useEffect(() => {
    void refreshHistory()
  }, [refreshHistory])

  useHeaderRefresh(() => refreshHistory(true), { loading: isLoadingHistory || isUploading })

  const handleUpload = useCallback(
    async (file: File) => {
      const format = detectFormat(file.name)
      if (!format) {
        notify({
          type: 'error',
          title: '文件类型不支持',
          message: '请上传 .md / .markdown / .html / .htm 文件',
        })
        return
      }

      try {
        const text = await readFileAsText(file)
        setPreviewContent(text)
        setPreviewFormat(format)
        setPreviewFilename(file.name)
      } catch (err) {
        notify({ type: 'error', title: '读取文件失败', message: normalizeErrorMessage(err) })
        return
      }

      setIsUploading(true)
      try {
        const formData = new FormData()
        formData.append('file', file)
        if (titleInput.trim()) {
          formData.append('title', titleInput.trim())
        }
        const res = await fetch(`${API_BASE}/api/v1/page-render/upload`, {
          method: 'POST',
          body: formData,
        })
        if (!res.ok) {
          const detail = (await res.json().catch(() => ({}))) as { detail?: string }
          throw new Error(detail.detail || `上传失败（${res.status}）`)
        }
        const payload = (await res.json()) as UploadedPage
        setRecentlyUploaded(payload)
        notify({ type: 'success', title: '已上传', message: payload.title })
        await refreshHistory()
      } catch (err) {
        notify({ type: 'error', title: '上传失败', message: normalizeErrorMessage(err) })
      } finally {
        setIsUploading(false)
      }
    },
    [notify, refreshHistory, titleInput]
  )

  const handleCopyLink = useCallback(
    async (page: UploadedPage) => {
      const publicPath = `/p/${page.id}`
      const absoluteUrl =
        typeof window !== 'undefined' ? `${window.location.origin}${publicPath}` : publicPath
      try {
        await navigator.clipboard.writeText(absoluteUrl)
        notify({ type: 'success', title: '已复制', message: absoluteUrl })
      } catch {
        notify({ type: 'info', title: '复制失败', message: '请手动复制：' + absoluteUrl })
      }
    },
    [notify]
  )

  const handleDelete = useCallback(
    async (page: UploadedPage) => {
      const ok = await confirm({
        title: '确定删除这个页面？删除后公开链接将立即失效。',
        variant: 'destructive',
      })
      if (!ok) return
      try {
        const res = await fetch(`${API_BASE}/api/v1/page-render/${page.id}`, {
          method: 'DELETE',
        })
        if (!res.ok && res.status !== 204) {
          throw new Error(`删除失败（${res.status}）`)
        }
        notify({ type: 'success', title: '已删除', message: page.title })
        if (recentlyUploaded?.id === page.id) {
          setRecentlyUploaded(null)
        }
        await refreshHistory()
      } catch (err) {
        notify({ type: 'error', title: '删除失败', message: normalizeErrorMessage(err) })
      }
    },
    [confirm, notify, recentlyUploaded, refreshHistory]
  )

  const historyRows = useMemo(() => history, [history])
  const recentPublicUrl =
    recentlyUploaded && typeof window !== 'undefined'
      ? `${window.location.origin}/p/${recentlyUploaded.id}`
      : recentlyUploaded
        ? `/p/${recentlyUploaded.id}`
        : ''

  return (
    <ToolsPageFrame className={styles.page}>
      <ToolsPanel
        title="上传 Markdown 或 HTML"
        className={styles.panel}
        bodyClassName={styles.uploadBody}
        aria-busy={isUploading || undefined}
      >
        <div className={styles.titleField}>
          <label htmlFor="page-render-title" className={styles.fieldLabel}>
            页面标题（可选，留空使用文件名）
          </label>
          <input
            id="page-render-title"
            placeholder="例如：2026 Q3 招商公告"
            value={titleInput}
            onChange={(event) => setTitleInput(event.target.value)}
            maxLength={200}
            className={styles.input}
          />
        </div>
        <div className={styles.uploadField}>
          <p className={styles.uploadHint}>
            文件会先在浏览器本地预览，随后立即上传并生成公开链接。
          </p>
          <ToolsUploadZone
            accept={ACCEPT}
            maxSize={MAX_SIZE_MB}
            showPreview={false}
            uploadingText="正在上传..."
            onUpload={handleUpload}
          />
        </div>
      </ToolsPanel>

      {previewContent && previewFormat ? (
        <ToolsPanel
          title="即时预览"
          className={styles.panel}
          bodyClassName={styles.previewBody}
          actions={
            <WarmBadge tone="neutral">
              {previewFormat === 'markdown' ? 'Markdown' : 'HTML'}
            </WarmBadge>
          }
        >
          {previewFilename ? (
            <div className={styles.previewMeta}>
              <FileCode2 aria-hidden="true" size={16} />
              <span title={previewFilename}>{previewFilename}</span>
            </div>
          ) : null}
          {previewFormat === 'markdown' ? (
            <div
              className={styles.markdownSurface}
              data-preview-surface="themed"
            >
              <MarkdownPreview content={previewContent} />
            </div>
          ) : (
            <iframe
              sandbox="allow-scripts"
              srcDoc={previewContent}
              title="HTML 预览"
              data-preview-surface="paper"
              className={styles.htmlPreview}
            />
          )}
        </ToolsPanel>
      ) : null}

      {recentlyUploaded ? (
        <ToolsPanel
          title="公开链接已生成"
          className={styles.panel}
          bodyClassName={styles.publicLinkBody}
        >
          <p className={styles.sectionNote}>
            任何人打开下面的链接即可查看该页面（未登录也可访问）。
          </p>
          <div className={styles.publicLinkRow}>
            <code className={styles.publicUrl} title={recentPublicUrl}>
              {recentPublicUrl}
            </code>
            <WarmButton
              variant="secondary"
              onClick={() => handleCopyLink(recentlyUploaded)}
            >
              <Copy aria-hidden="true" size={16} />
              复制链接
            </WarmButton>
            <a
              className={`warm-ledger__button warm-ledger__button--secondary ${styles.openButton}`}
              href={`/p/${recentlyUploaded.id}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink aria-hidden="true" size={16} />
              打开
            </a>
          </div>
        </ToolsPanel>
      ) : null}

      <ToolsPanel
        title="我的历史"
        className={styles.panel}
        bodyClassName={styles.historyBody}
        actions={
          <>
            <WarmBadge tone="neutral">{historyTotal}</WarmBadge>
            <WarmButton
              type="button"
              variant="quiet"
              onClick={() => void refreshHistory(true)}
              loading={isLoadingHistory}
              loadingLabel="正在刷新页面历史"
            >
              <RefreshCw aria-hidden="true" size={16} />
              刷新
            </WarmButton>
          </>
        }
      >
        {historyRows.length === 0 ? (
          <div
            className={styles.historyEmpty}
            aria-busy={isLoadingHistory || undefined}
            role={isLoadingHistory ? 'status' : undefined}
          >
            {isLoadingHistory
              ? '加载中...'
              : historyError
                ? `加载失败：${historyError}。请刷新重试。`
                : '暂无记录，上传一个文件试试'}
          </div>
        ) : (
          <div
            className={styles.tableScroll}
            role="region"
            aria-label="页面历史表格"
            tabIndex={0}
          >
            <table className={styles.table}>
              <caption className={styles.visuallyHidden}>我的页面历史</caption>
              <thead>
                <tr>
                  <th scope="col">标题</th>
                  <th scope="col">格式</th>
                  <th scope="col">原文件名</th>
                  <th scope="col" className={styles.numericCell}>
                    大小
                  </th>
                  <th scope="col">创建时间</th>
                  <th scope="col" className={styles.actionCell}>
                    操作
                  </th>
                </tr>
              </thead>
              <tbody>
                {historyRows.map((row) => (
                  <tr key={row.id}>
                    <td className={styles.titleCell}>
                      <span title={row.title}>{row.title}</span>
                    </td>
                    <td>
                      <WarmBadge tone="neutral">
                        {row.source_format === 'markdown' ? 'Markdown' : 'HTML'}
                      </WarmBadge>
                    </td>
                    <td className={styles.filenameCell}>
                      <span title={row.original_filename}>{row.original_filename}</span>
                    </td>
                    <td className={styles.numericCell}>{formatBytes(row.file_size)}</td>
                    <td title={new Date(row.created_at).toLocaleString('zh-CN')}>
                      {formatDistanceToNow(new Date(row.created_at), {
                        addSuffix: true,
                        locale: zhCN,
                      })}
                    </td>
                    <td className={styles.actionCell}>
                      <div className={styles.rowActions}>
                        <a
                          className="warm-ledger__icon-button"
                          href={`/p/${row.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={`打开页面：${row.title}`}
                          title="打开"
                        >
                          <ExternalLink aria-hidden="true" />
                        </a>
                        <WarmIconButton
                          aria-label={`复制链接：${row.title}`}
                          title="复制链接"
                          onClick={() => handleCopyLink(row)}
                        >
                          <Copy aria-hidden="true" />
                        </WarmIconButton>
                        <WarmIconButton
                          aria-label={`删除页面：${row.title}`}
                          title="删除"
                          className={styles.deleteButton}
                          onClick={() => handleDelete(row)}
                        >
                          <Trash2 aria-hidden="true" />
                        </WarmIconButton>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </ToolsPanel>
    </ToolsPageFrame>
  )
}
