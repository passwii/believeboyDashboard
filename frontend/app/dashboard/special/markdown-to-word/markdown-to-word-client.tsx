'use client'

import { useCallback, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { UploadZone } from '@/components/ui/upload-zone'
import { Download, Eye, FileCode2, FileDown, FileText, Loader2, RefreshCcw, Trash2, Upload } from 'lucide-react'
import { useNotifications } from '@/components/notifications'
import { cn } from '@/lib/utils'

import {
  createPdfFilename,
  createWordFilename,
  downloadMarkdownAsPdf,
  downloadMarkdownAsWord,
  formatMarkdownFileSize,
  readMarkdownFile,
} from './lib/markdown-to-word'

const DEFAULT_MARKDOWN = `# Markdown 转 Word

在这里粘贴或上传 Markdown 内容，右侧会实时预览最终 Word 中的主要结构。

## 支持内容

- 标题
- 普通段落
- 无序列表
- 有序列表
- 表格
- 代码块
- 引用
- 链接
- **加粗**、*斜体*、~~删除线~~、\`行内代码\`

| 商品 | 销售额 | 备注 |
|---|---:|---|
| A | 100 | **重点**商品 |
| B | 80 | [查看明细](https://believeboy.com) |

> 下载时会在浏览器本地生成 DOCX / PDF 文件，不会上传到服务器。`

export default function MarkdownToWordClient() {
  const { notify } = useNotifications()
  const [markdown, setMarkdown] = useState(DEFAULT_MARKDOWN)
  const [sourceFileName, setSourceFileName] = useState<string | null>(null)
  const [sourceFileSize, setSourceFileSize] = useState<number | null>(null)
  const [isDownloading, setIsDownloading] = useState(false)
  const [isDownloadingPdf, setIsDownloadingPdf] = useState(false)

  const isEmpty = useMemo(() => markdown.trim().length === 0, [markdown])
  const lineCount = useMemo(() => (markdown ? markdown.split('\n').length : 0), [markdown])
  const charCount = useMemo(() => markdown.length, [markdown])

  const handleUploadFile = useCallback(async (file: File) => {
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
  }, [notify])

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

  const handleReset = useCallback(() => {
    setMarkdown(DEFAULT_MARKDOWN)
    setSourceFileName(null)
    setSourceFileSize(null)
    notify({ type: 'success', title: '已重置示例内容' })
  }, [notify])

  const handleClear = useCallback(() => {
    setMarkdown('')
    setSourceFileName(null)
    setSourceFileSize(null)
  }, [])

  return (
    <div className="space-y-5">
      <div className="rounded-[2rem] border border-border/70 bg-[hsl(var(--surface-soft)/0.72)] p-5 dark:border-border/80 dark:bg-[hsl(var(--surface-soft)/0.5)]">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary dark:bg-primary/15">
                <FileText className="h-5 w-5" />
              </div>
              <div>
                <h1 className="text-2xl font-semibold tracking-tight text-foreground">Markdown 转 Word</h1>
                <p className="text-sm leading-6 text-muted-foreground">
                  上传或粘贴 Markdown，实时预览后一键导出 DOCX 或 PDF。
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
              <Badge variant="secondary" className="rounded-full px-2.5 py-1">
                本地转换
              </Badge>
              <Badge variant="secondary" className="rounded-full px-2.5 py-1">
                实时预览
              </Badge>
              <Badge variant="secondary" className="rounded-full px-2.5 py-1">
                DOCX
              </Badge>
              <Badge variant="secondary" className="rounded-full px-2.5 py-1">
                PDF
              </Badge>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:min-w-[18rem]">
            <div className="rounded-2xl border border-border/70 bg-background/70 p-3 dark:border-border/90 dark:bg-[hsl(var(--surface-panel)/0.7)]">
              <div className="text-[0.68rem] uppercase tracking-[0.14em] text-muted-foreground">字符</div>
              <div className="mt-1 text-lg font-semibold text-foreground">{charCount.toLocaleString('zh-CN')}</div>
            </div>
            <div className="rounded-2xl border border-border/70 bg-background/70 p-3 dark:border-border/90 dark:bg-[hsl(var(--surface-panel)/0.7)]">
              <div className="text-[0.68rem] uppercase tracking-[0.14em] text-muted-foreground">行数</div>
              <div className="mt-1 text-lg font-semibold text-foreground">{lineCount.toLocaleString('zh-CN')}</div>
            </div>
            <div className="rounded-2xl border border-border/70 bg-background/70 p-3 dark:border-border/90 dark:bg-[hsl(var(--surface-panel)/0.7)] sm:col-span-2 lg:col-span-1">
              <div className="text-[0.68rem] uppercase tracking-[0.14em] text-muted-foreground">来源文件</div>
              <div className="mt-1 truncate text-sm font-medium text-foreground">
                {sourceFileName ? sourceFileName : '未上传'}
              </div>
              {sourceFileSize !== null ? (
                <div className="mt-1 text-xs text-muted-foreground">{formatMarkdownFileSize(sourceFileSize)}</div>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <Card className="dark:border-border/80 dark:bg-[hsl(var(--surface-panel))]">
          <CardHeader>
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-2">
                <CardTitle className="flex items-center gap-2">
                  <FileCode2 className="h-4 w-4 text-primary" />
                  Markdown 编辑区
                </CardTitle>
                <CardDescription>上方上传文件，下方直接粘贴或编辑 Markdown 内容。</CardDescription>
              </div>
              <Badge variant="outline" className="shrink-0">
                .md
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <UploadZone
              accept=".md,text/markdown,text/plain"
              maxSize={5}
              showPreview
              uploadingText="正在读取 Markdown..."
              onUpload={handleUploadFile}
            />

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <label htmlFor="markdown-input" className="text-sm font-medium text-foreground">
                  直接粘贴 Markdown
                </label>
                <div className="flex items-center gap-2">
                  <Button type="button" variant="ghost" size="sm" onClick={handleReset} className="h-9 px-3">
                    <RefreshCcw className="mr-1.5 h-4 w-4" />
                    示例
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={handleClear} className="h-9 px-3">
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
                className="min-h-[280px] w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm leading-6 text-foreground ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 dark:bg-[hsl(var(--surface-subtle))]"
                spellCheck={false}
              />
            </div>
          </CardContent>
          <CardFooter className="flex items-center justify-between gap-3 border-t border-border/70 pt-4 text-xs text-muted-foreground">
            <span>提示：支持标题、列表、表格、引用、代码块和链接；DOCX/PDF 会保留主要段落结构。</span>
            <span>{isEmpty ? '暂无内容' : '可导出'}</span>
          </CardFooter>
        </Card>

        <Card className="dark:border-border/80 dark:bg-[hsl(var(--surface-panel))]">
          <CardHeader>
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-2">
                <CardTitle className="flex items-center gap-2">
                  <Eye className="h-4 w-4 text-primary" />
                  实时预览
                </CardTitle>
                <CardDescription>右侧预览 Markdown 渲染后的文档结构。</CardDescription>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button
                  type="button"
                  size="lg"
                  variant="outline"
                  disabled={isEmpty || isDownloadingPdf}
                  onClick={handleDownloadPdf}
                  className="min-w-[8.5rem]"
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
                  size="lg"
                  disabled={isEmpty || isDownloading}
                  onClick={handleDownload}
                  className="min-w-[8.5rem]"
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
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div
              className={cn(
                'min-h-[420px] max-h-[680px] overflow-y-auto rounded-2xl border border-border/70 bg-background/70 p-5 text-sm leading-7 text-foreground dark:border-border/90 dark:bg-[hsl(var(--surface-subtle))]',
                'markdown-preview [&>blockquote]:border-l-primary/40 [&>blockquote]:bg-primary/5 [&>blockquote]:px-4 [&>blockquote]:py-3 [&>blockquote]:text-muted-foreground',
                '[&>code]:rounded-md [&>code]:bg-muted [&>code]:px-1.5 [&>code]:py-0.5 [&>code]:font-mono [&>pre]:overflow-x-auto [&>pre]:rounded-xl [&>pre]:bg-slate-950 [&>pre]:p-4 [&>pre]:text-slate-100',
                '[&>h1]:mb-3 [&>h1]:text-2xl [&>h1]:font-semibold [&>h1]:tracking-tight [&>h2]:mb-3 [&>h2]:text-xl [&>h2]:font-semibold [&>h2]:tracking-tight [&>h3]:mb-2 [&>h3]:text-lg [&>h3]:font-semibold',
                '[&>ul]:ml-5 [&>ul]:list-disc [&>ul]:space-y-1 [&>ol]:ml-5 [&>ol]:list-decimal [&>ol]:space-y-1 [&>table]:w-full [&>table]:overflow-hidden [&>table]:rounded-xl [&>table]:border [&>table]:border-border [&>table]:text-sm',
                '[&>table_th]:border [&>table_th]:border-border [&>table_th]:bg-muted/60 [&>table_th]:px-3 [&>table_th]:py-2 [&>table_th]:font-semibold',
                '[&>table_td]:border [&>table_td]:border-border [&>table_td]:px-3 [&>table_td]:py-2 [&>table_tr]:odd:bg-background/40'
              )}
            >
              {isEmpty ? (
                <div className="flex h-full min-h-[360px] flex-col items-center justify-center gap-3 text-center text-muted-foreground">
                  <FileText className="h-10 w-10 opacity-40" />
                  <div>
                    <p className="font-medium text-foreground">暂无 Markdown 内容</p>
                    <p className="mt-1 text-sm">上传文件或粘贴内容后，这里会实时显示预览。</p>
                  </div>
                </div>
              ) : (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
              )}
            </div>
          </CardContent>
          <CardFooter className="flex flex-wrap items-center justify-between gap-3 border-t border-border/70 pt-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-2">
              <Upload className="h-3.5 w-3.5" />
              文件仅在浏览器本地处理
            </span>
            <span>导出格式：DOCX / PDF</span>
          </CardFooter>
        </Card>
      </div>

      <div className="rounded-2xl border border-border/70 bg-background/60 p-4 text-sm leading-6 text-muted-foreground dark:border-border/90 dark:bg-[hsl(var(--surface-soft)/0.55)]">
        <span className="font-medium text-foreground">注意：</span>
        当前版本会保留标题、段落、列表、表格、引用、代码块、链接和常见行内样式；图片会在预览中显示，但 DOCX 导出暂不嵌入远程图片。
      </div>
    </div>
  )
}
