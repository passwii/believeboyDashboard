'use client'

import { useCallback, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Download, FileDown, FileText, Trash2, Upload } from 'lucide-react'

import { WarmButton } from '@/components/dashboard-v2/warm-ledger/controls'
import { useNotifications } from '@/components/notifications'

import { ToolsPageFrame, ToolsPanel, ToolsUploadZone } from '../_components'
import {
  createPdfFilename,
  createWordFilename,
  downloadMarkdownAsPdf,
  downloadMarkdownAsWord,
  formatMarkdownFileSize,
  readMarkdownFile,
} from './lib/markdown-to-word'
import styles from './markdown-to-word.module.css'

const DEFAULT_MARKDOWN = ''

export default function MarkdownToWordClient() {
  const { notify } = useNotifications()
  const [markdown, setMarkdown] = useState(DEFAULT_MARKDOWN)
  const [sourceFileName, setSourceFileName] = useState<string | null>(null)
  const [sourceFileSize, setSourceFileSize] = useState<number | null>(null)
  const [uploadKey, setUploadKey] = useState(0)
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
    setUploadKey((current) => current + 1)
  }, [])

  return (
    <ToolsPageFrame layout="split" className={styles.workspace}>
      <ToolsPanel
        title="Markdown 编辑区"
        className={styles.panel}
        bodyClassName={styles.editorBody}
        actions={
          <WarmButton
            type="button"
            variant="quiet"
            onClick={handleClear}
            disabled={isEmpty && !sourceFileName}
          >
            <Trash2 aria-hidden="true" size={16} />
            清空
          </WarmButton>
        }
      >
        <ToolsUploadZone
          key={uploadKey}
          accept=".md,text/markdown,text/plain"
          maxSize={5}
          showPreview
          uploadingText="正在读取 Markdown..."
          onUpload={handleUploadFile}
        />

        {sourceFileName && sourceFileSize !== null ? (
          <dl className={styles.sourceMeta}>
            <div>
              <dt>源文件</dt>
              <dd title={sourceFileName}>{sourceFileName}</dd>
            </div>
            <div>
              <dt>大小</dt>
              <dd>{formatMarkdownFileSize(sourceFileSize)}</dd>
            </div>
          </dl>
        ) : null}

        <div className={styles.editorHeading}>
          <label htmlFor="markdown-input" className={styles.fieldLabel}>
            Markdown 内容
          </label>
          <span id="markdown-hint" className={styles.fieldHint}>
            支持标题、列表、表格、引用、代码块和链接
          </span>
        </div>
        <textarea
          id="markdown-input"
          value={markdown}
          onChange={(event) => setMarkdown(event.target.value)}
          placeholder="在这里粘贴 Markdown 内容..."
          className={styles.textarea}
          aria-describedby="markdown-hint"
          spellCheck={false}
        />

        <div className={styles.footer}>
          <span className={styles.footerStatus}>
            <Upload aria-hidden="true" size={14} />
            文件仅在浏览器本地处理
          </span>
          <span className={styles.footerValue}>
            {isEmpty ? '暂无内容' : '可导出 DOCX / PDF'}
          </span>
        </div>
      </ToolsPanel>

      <ToolsPanel
        title="实时预览"
        className={styles.panel}
        bodyClassName={styles.previewBody}
        actions={
          <>
            <WarmButton
              type="button"
              variant="secondary"
              disabled={isEmpty}
              loading={isDownloadingPdf}
              loadingLabel="正在生成 PDF 文件"
              onClick={handleDownloadPdf}
            >
              <FileDown aria-hidden="true" size={16} />
              下载 PDF
            </WarmButton>
            <WarmButton
              type="button"
              variant="primary"
              disabled={isEmpty}
              loading={isDownloading}
              loadingLabel="正在生成 Word 文件"
              onClick={handleDownload}
            >
              <Download aria-hidden="true" size={16} />
              下载 Word
            </WarmButton>
          </>
        }
      >
        <div
          className={styles.previewSurface}
          data-preview-surface="themed"
          data-testid="markdown-preview"
        >
          {isEmpty ? (
            <div className={styles.emptyState}>
              <FileText aria-hidden="true" size={36} strokeWidth={1.5} />
              <div>
                <p>暂无 Markdown 内容</p>
                <span>上传文件或粘贴内容后，这里会实时显示预览。</span>
              </div>
            </div>
          ) : (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
          )}
        </div>

        <div className={styles.footer}>
          <span>预览随编辑实时更新</span>
          <span className={styles.footerValue}>导出格式：DOCX / PDF</span>
        </div>
      </ToolsPanel>
    </ToolsPageFrame>
  )
}
