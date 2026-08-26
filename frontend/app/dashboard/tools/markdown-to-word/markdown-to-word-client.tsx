'use client'

import { useCallback, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { TermPanel } from '@/components/terminal/term-panel'
import { UploadZone } from '@/components/ui/upload-zone'
import { Download, Eye, FileCode2, FileDown, FileText, Loader2, Trash2, Upload } from 'lucide-react'
import { useNotifications } from '@/components/notifications'
import { cn } from '@/lib/utils'

import {
  createPdfFilename,
  createWordFilename,
  downloadMarkdownAsPdf,
  downloadMarkdownAsWord,
  readMarkdownFile,
} from './lib/markdown-to-word'

const DEFAULT_MARKDOWN = ''

export default function MarkdownToWordClient() {
  const { notify } = useNotifications()
  const [markdown, setMarkdown] = useState(DEFAULT_MARKDOWN)
  const [sourceFileName, setSourceFileName] = useState<string | null>(null)
  const [sourceFileSize, setSourceFileSize] = useState<number | null>(null)
  const [isDownloading, setIsDownloading] = useState(false)
  const [isDownloadingPdf, setIsDownloadingPdf] = useState(false)

  const isEmpty = useMemo(() => markdown.trim().length === 0, [markdown])

  const handleUploadFile = useCallback(
    async (file: File) => {
      try {
        const content = await readMarkdownFile(file)
        setMarkdown(content)
        setSourceFileName(file.name)
        setSourceFileSize(file.size)
        notify({
          type: 'success',
          title: 'Markdown 文件已读取',
          message: file.name,
        })
      } catch (error) {
        notify({
          type: 'error',
          title: '读取文件失败',
          message: error instanceof Error ? error.message : '请重试',
        })
      }
    },
    [notify]
  )

  const handleDownload = useCallback(async () => {
    if (isEmpty) {
      notify({ type: 'error', title: '无法生成 Word', message: '请先填写 Markdown 内容' })
      return
    }

    setIsDownloading(true)
    try {
      const filename = createWordFilename(sourceFileName ?? undefined)
      await downloadMarkdownAsWord(markdown, filename)
      notify({
        type: 'success',
        title: 'Word 文件已生成',
        message: filename,
      })
    } catch (error) {
      notify({
        type: 'error',
        title: 'Word 生成失败',
        message: error instanceof Error ? error.message : '请稍后重试',
      })
    } finally {
      setIsDownloading(false)
    }
  }, [isEmpty, markdown, notify, sourceFileName])

  const handleDownloadPdf = useCallback(async () => {
    if (isEmpty) {
      notify({ type: 'error', title: '无法生成 PDF', message: '请先填写 Markdown 内容' })
      return
    }

    setIsDownloadingPdf(true)
    try {
      const filename = createPdfFilename(sourceFileName ?? undefined)
      await downloadMarkdownAsPdf(markdown, filename)
      notify({
        type: 'success',
        title: 'PDF 文件已生成',
        message: filename,
      })
    } catch (error) {
      notify({
        type: 'error',
        title: 'PDF 生成失败',
        message: error instanceof Error ? error.message : '请稍后重试',
      })
    } finally {
      setIsDownloadingPdf(false)
    }
  }, [isEmpty, markdown, notify, sourceFileName])

  const handleClear = useCallback(() => {
    setMarkdown('')
    setSourceFileName(null)
    setSourceFileSize(null)
  }, [])

  return (
    <div className="flex h-auto min-h-[calc(100vh-4rem)] flex-col gap-2 xl:h-[calc(100vh-4rem)]">
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 xl:grid-cols-2">
        <TermPanel
          title="Markdown 编辑区"
          actions={<Badge variant="outline" className="rounded-none border-term-border font-mono text-[11px] text-term-faint">.md</Badge>}
          bodyClassName="flex min-h-0 flex-1 flex-col gap-3 p-3"
        >
            <p className="font-sans text-xs text-term-faint">上方上传文件，下方直接粘贴或编辑 Markdown 内容。</p>
            <UploadZone
              accept=".md,text/markdown,text/plain"
              maxSize={5}
              showPreview
              uploadingText="正在读取 Markdown..."
              onUpload={handleUploadFile}
            />

            <div className="flex min-h-0 flex-1 flex-col gap-2">
              <div className="flex items-center justify-between gap-3">
                <label htmlFor="markdown-input" className="font-mono text-xs uppercase tracking-wider text-term-muted">
                  直接粘贴 Markdown
                </label>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleClear}
                    className="h-7 rounded-none border border-term-border bg-term-panel px-2 font-mono text-xs text-term-muted hover:border-term-border-strong hover:text-term-text"
                  >
                    <Trash2 className="mr-1.5 h-4 w-4" />
                    清空
                  </Button>
                </div>
              </div>
              <textarea
                id="markdown-input"
                value={markdown}
                onChange={(event) => setMarkdown(event.target.value)}
                placeholder="在这里粘贴 Markdown 内容..."
                className="min-h-[240px] w-full flex-1 resize-none rounded-none border border-term-border bg-term-bg px-3 py-2 font-mono text-sm leading-6 text-term-text placeholder:text-term-faint focus-visible:outline-none focus-visible:border-term-border-strong"
                spellCheck={false}
              />
            </div>
                      <div className="mt-auto flex items-center justify-between gap-3 border-t border-term-border pt-3 font-sans text-xs text-term-faint">
              <span>
                提示：支持标题、列表、表格、引用、代码块和链接；DOCX/PDF 会保留主要段落结构。
              </span>
              <span className="font-mono">{isEmpty ? '暂无内容' : '可导出'}</span>
            </div>
        </TermPanel>

        <TermPanel
          title="实时预览"
          actions={
            <>
              <p className="mr-2 hidden font-sans text-xs text-term-faint sm:inline">Markdown 渲染预览</p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={isEmpty || isDownloadingPdf}
                  onClick={handleDownloadPdf}
                  className="h-8 min-w-[6.5rem] rounded-none border border-term-border bg-term-panel px-2 font-mono text-xs text-term-muted transition-colors hover:border-term-border-strong hover:text-term-text"
                >
                  {isDownloadingPdf ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      生成中
                    </>
                  ) : (
                    <>
                      <FileDown className="mr-2 h-4 w-4" />
                      下载 PDF
                    </>
                  )}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={isEmpty || isDownloading}
                  onClick={handleDownload}
                  className="h-8 min-w-[6.5rem] rounded-none font-mono text-xs"
                >
                  {isDownloading ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      生成中
                    </>
                  ) : (
                    <>
                      <Download className="mr-2 h-4 w-4" />
                      下载 Word
                    </>
                  )}
                </Button>
            </>
          }
          bodyClassName="flex min-h-0 flex-1 flex-col p-3"
        >
            <div
              className={cn(
                'min-h-0 flex-1 overflow-y-auto rounded-none border border-term-border bg-term-bg p-5 text-sm leading-7 text-term-text',
                'markdown-preview [&>blockquote]:border-l-primary/40 [&>blockquote]:bg-primary/5 [&>blockquote]:px-4 [&>blockquote]:py-3 [&>blockquote]:text-muted-foreground',
                '[&>code]:rounded-none [&>code]:bg-term-raised [&>code]:px-1.5 [&>code]:py-0.5 [&>code]:font-mono [&>pre]:overflow-x-auto [&>pre]:rounded-none [&>pre]:border [&>pre]:border-term-border [&>pre]:bg-term-bg [&>pre]:p-4',
                '[&>h1]:mb-3 [&>h1]:text-2xl [&>h1]:font-semibold [&>h1]:tracking-tight [&>h2]:mb-3 [&>h2]:text-xl [&>h2]:font-semibold [&>h2]:tracking-tight [&>h3]:mb-2 [&>h3]:text-lg [&>h3]:font-semibold',
                '[&>ul]:ml-5 [&>ul]:list-disc [&>ul]:space-y-1 [&>ol]:ml-5 [&>ol]:list-decimal [&>ol]:space-y-1 [&>table]:w-full [&>table]:overflow-hidden [&>table]:rounded-none [&>table]:border [&>table]:border-term-border [&>table]:font-mono [&>table]:text-xs',
                '[&>table_th]:border [&>table_th]:border-term-border [&>table_th]:bg-term-raised [&>table_th]:px-3 [&>table_th]:py-2 [&>table_th]:font-semibold [&_th]:normal-case [&_th]:tracking-normal',
                '[&>table_td]:border [&>table_td]:border-term-border [&>table_td]:px-3 [&>table_td]:py-2'
              )}
            >
              {isEmpty ? (
                <div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-3 text-center font-mono text-xs text-term-faint">
                  <FileText className="h-10 w-10 opacity-40" strokeWidth={1.75} />
                  <div>
                    <p className="text-sm font-medium text-term-muted">暂无 Markdown 内容</p>
                    <p className="mt-1 text-sm">上传文件或粘贴内容后，这里会实时显示预览。</p>
                  </div>
                </div>
              ) : (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
              )}
            </div>
                      <div className="mt-auto flex flex-wrap items-center justify-between gap-3 border-t border-term-border pt-3 font-sans text-xs text-term-faint">
              <span className="flex items-center gap-2">
                <Upload className="h-3.5 w-3.5" strokeWidth={1.75} />
                文件仅在浏览器本地处理
              </span>
              <span className="font-mono">导出格式：DOCX / PDF</span>
            </div>
        </TermPanel>
      </div>
    </div>
  )
}
