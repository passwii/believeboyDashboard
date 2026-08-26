'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { Copy, ExternalLink, Eye, FileCode2, Globe, Loader2, Trash2, Upload } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { TermPanel } from '@/components/terminal/term-panel'
import { TERM_INPUT } from '@/components/terminal/term-controls'
import { Input } from '@/components/ui/input'
import { UploadZone } from '@/components/ui/upload-zone'
import { useNotifications } from '@/components/notifications'
import { useConfirm } from '@/hooks/use-confirm'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { cn } from '@/lib/utils'
import { formatDistanceToNow } from 'date-fns'
import { zhCN } from 'date-fns/locale'

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
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code({ className, children, ...props }) {
          const match = /language-(\w+)/.exec(className || '')
          const isInline = !match && !String(children).includes('\n')
          if (isInline) {
            return (
              <code
                className={cn(
                  'rounded-none bg-term-raised px-1.5 py-0.5 font-mono text-[0.85em]',
                  className
                )}
                {...props}
              >
                {children}
              </code>
            )
          }
          const code = String(children).replace(/\n$/, '')
          return (
            <SyntaxHighlighter
              language={match ? match[1] : 'text'}
              style={oneDark}
              customStyle={{
                margin: '0.75rem 0',
                padding: '0.9rem',
                borderRadius: '0.5rem',
                fontSize: '0.8125rem',
                lineHeight: '1.6',
              }}
            >
              {code}
            </SyntaxHighlighter>
          )
        },
        pre({ children }) {
          return <>{children}</>
        },
      }}
    >
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

  const refreshHistory = useCallback(async () => {
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
    } catch (err) {
      notify({ type: 'error', title: '加载历史失败', message: normalizeErrorMessage(err) })
    } finally {
      setIsLoadingHistory(false)
    }
  }, [notify])

  useEffect(() => {
    void refreshHistory()
  }, [refreshHistory])

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

      // 1) 即时预览（FileReader，不依赖服务端）
      try {
        const text = await readFileAsText(file)
        setPreviewContent(text)
        setPreviewFormat(format)
        setPreviewFilename(file.name)
      } catch (err) {
        notify({ type: 'error', title: '读取文件失败', message: normalizeErrorMessage(err) })
        return
      }

      // 2) 上传到后端
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

  return (
    <div className="flex flex-col gap-5">
      {/* 顶部：标题输入 + 上传区 */}
      <TermPanel
        title="上传 Markdown 或 HTML"
        actions={<Badge variant="outline" className="rounded-none border-term-border font-mono text-[11px] uppercase tracking-wider text-term-faint">特殊功能</Badge>}
        bodyClassName="flex flex-col gap-4 p-4"
      >
          <div className="flex flex-col gap-1.5">
            <label htmlFor="page-render-title" className="font-mono text-xs uppercase tracking-wider text-term-muted">
              页面标题（可选，留空使用文件名）
            </label>
            <Input
              id="page-render-title"
              placeholder="例如：2026 Q3 招商公告"
              value={titleInput}
              onChange={(e) => setTitleInput(e.target.value)}
              maxLength={200}
              className={TERM_INPUT}
            />
          </div>
          <UploadZone
            accept={ACCEPT}
            maxSize={MAX_SIZE_MB}
            showPreview={false}
            uploadingText="正在上传..."
            onUpload={handleUpload}
          />
      </TermPanel>


      {/* 即时预览 */}
      {previewContent && previewFormat ? (
        <TermPanel title={`即时预览${previewFilename ? ` · ${previewFilename}` : ''}`} bodyClassName="p-4">
            <p className="-mt-1 mb-3 font-sans text-xs text-term-faint">仅在浏览器本地渲染，未上传前不会保存到 R2。</p>
            {previewFormat === 'markdown' ? (
              <div
                className={cn(
                  'min-h-[60vh] overflow-y-auto rounded-none border border-term-border bg-term-bg p-5 text-sm leading-7 text-term-text',
                  '[&>blockquote]:border-l-term-accent/50 [&>blockquote]:bg-term-bg [&>blockquote]:px-4 [&>blockquote]:py-3 [&>blockquote]:text-term-muted',
                  '[&>h1]:mb-3 [&>h1]:text-2xl [&>h1]:font-semibold [&>h1]:tracking-tight',
                  '[&>h2]:mb-3 [&>h2]:text-xl [&>h2]:font-semibold',
                  '[&>h3]:mb-2 [&>h3]:text-lg [&>h3]:font-semibold',
                  '[&>table]:w-full [&>table]:overflow-hidden [&>table]:rounded-none [&>table]:border [&>table]:border-term-border [&>table]:font-mono [&>table]:text-xs',
                  '[&_th]:border [&_th]:border-term-border [&_th]:bg-term-raised [&_th]:px-3 [&_th]:py-2 [&_th]:font-semibold [&_th]:normal-case [&_th]:tracking-normal [&_th]:text-term-muted',
                  '[&_td]:border [&_td]:border-term-border [&_td]:px-3 [&_td]:py-2',
                  '[&_ul]:ml-5 [&_ul]:list-disc [&_ul]:space-y-1 [&_ol]:ml-5 [&_ol]:list-decimal [&>ol]:space-y-1'
                )}
              >
                <MarkdownPreview content={previewContent} />
              </div>
            ) : (
              <iframe
                sandbox="allow-scripts"
                srcDoc={previewContent}
                title="HTML 预览"
                className="w-full min-h-[60vh] rounded-none border border-term-border bg-white"
              />
            )}
        </TermPanel>

      ) : null}

      {/* 公开链接卡片 */}
      {recentlyUploaded ? (
        <TermPanel title="公开链接已生成" bodyClassName="p-4">
            <p className="mb-3 font-sans text-xs text-term-faint">任何人打开下面的链接即可查看该页面（未登录也可访问）。</p>
            <div className="flex flex-wrap items-center gap-2">
              <code className="flex-1 truncate rounded-none border border-term-border bg-term-bg px-3 py-2 font-mono text-xs text-term-text">
                {typeof window !== 'undefined'
                  ? `${window.location.origin}/p/${recentlyUploaded.id}`
                  : `/p/${recentlyUploaded.id}`}
              </code>
              <Button variant="outline" size="sm" onClick={() => handleCopyLink(recentlyUploaded)}>
                <Copy className="mr-1.5 h-4 w-4" />
                复制链接
              </Button>
              <Button variant="ghost" size="sm" asChild>
                <a href={`/p/${recentlyUploaded.id}`} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="mr-1.5 h-4 w-4" />
                  打开
                </a>
              </Button>
            </div>
        </TermPanel>

      ) : null}

      {/* 历史列表 */}
      <TermPanel
        title="我的历史"
        actions={
          <>
            <Badge variant="secondary" className="rounded-none border-term-border bg-term-bg font-mono text-[11px] tabular-nums text-term-muted">{historyTotal}</Badge>
            <Button variant="ghost" size="sm" className="h-7 rounded-none px-2 font-mono text-xs text-term-muted hover:text-term-text" onClick={refreshHistory} disabled={isLoadingHistory}>
              {isLoadingHistory ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : '刷新'}
            </Button>
          </>
        }
        bodyClassName="p-4"
      >
          {historyRows.length === 0 ? (
            <div className="flex h-32 flex-col items-center justify-center font-mono text-xs text-term-faint">
              {isLoadingHistory ? '加载中...' : '暂无记录，上传一个文件试试'}
            </div>
          ) : (
            <div className="overflow-x-auto rounded-none border border-term-border">
              <table className="w-full font-mono text-xs tabular-nums">
                <thead className="bg-term-raised text-xs text-term-muted">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">标题</th>
                    <th className="px-3 py-2 text-left font-medium">格式</th>
                    <th className="px-3 py-2 text-left font-medium">原文件名</th>
                    <th className="px-3 py-2 text-right font-medium">大小</th>
                    <th className="px-3 py-2 text-left font-medium">创建时间</th>
                    <th className="px-3 py-2 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {historyRows.map((row) => (
                    <tr key={row.id} className="border-t border-term-border transition-colors hover:bg-term-hover">
                      <td className="max-w-[260px] truncate px-3 py-2 font-medium text-term-text">
                        {row.title}
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant="outline" className='rounded-none border-term-border font-mono text-[11px] text-term-muted'>
                          {row.source_format === 'markdown' ? 'Markdown' : 'HTML'}
                        </Badge>
                      </td>
                      <td className="max-w-[240px] truncate px-3 py-2 text-xs text-term-faint">
                        {row.original_filename}
                      </td>
                      <td className="px-3 py-2 text-right text-xs text-term-muted">
                        {formatBytes(row.file_size)}
                      </td>
                      <td className="px-3 py-2 text-xs text-term-muted">
                        {formatDistanceToNow(new Date(row.created_at), {
                          addSuffix: true,
                          locale: zhCN,
                        })}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center justify-end gap-1">
                          <Button variant="ghost" size="sm" asChild>
                            <a href={`/p/${row.id}`} target="_blank" rel="noopener noreferrer">
                              <ExternalLink className="h-3.5 w-3.5" />
                            </a>
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleCopyLink(row)}
                            title="复制链接"
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDelete(row)}
                            title="删除"
                            className="text-rose-600 hover:text-rose-700 dark:text-rose-400"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </TermPanel>

    </div>
  )
}
