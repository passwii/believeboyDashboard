'use client'

import { useCallback, useMemo, useState } from 'react'
import { FileDown, RotateCcw, Tag, Upload } from 'lucide-react'

import { WarmButton } from '@/components/dashboard-v2/warm-ledger/controls'
import { useNotifications } from '@/components/notifications'
import { normalizeErrorMessage } from '@/lib/error-utils'

import { ToolsPageFrame, ToolsPanel, ToolsUploadZone } from '../_components'
import {
  MAX_TEXT_CHARS,
  MAX_TEXT_LINES,
  downloadBlob,
  generateProductLabel,
  validateBeforeGenerate,
} from './lib/product-label'
import styles from './product-label-client.module.css'

interface GeneratedFile {
  blob: Blob
  filename: string
}

export default function ProductLabelClient() {
  const { notify } = useNotifications()

  const [file, setFile] = useState<File | null>(null)
  const [text, setText] = useState('')
  const [madeInChina, setMadeInChina] = useState(true)
  const [isGenerating, setIsGenerating] = useState(false)
  const [lastGenerated, setLastGenerated] = useState<GeneratedFile | null>(null)

  const lineCount = useMemo(
    () => text.split('\n').filter((line) => line.trim()).length,
    [text]
  )
  const hasContent = text.trim().length > 0 || madeInChina
  const canGenerate = Boolean(file) && hasContent && !isGenerating

  const handleUpload = useCallback(
    (next: File) => {
      setFile(next)
      setLastGenerated(null)
      notify({ type: 'success', title: '标签已就绪', message: next.name })
    },
    [notify]
  )

  const handleReset = useCallback(() => {
    setFile(null)
    setText('')
    setMadeInChina(true)
    setLastGenerated(null)
  }, [])

  const handleGenerate = useCallback(async () => {
    if (!file) {
      notify({ type: 'error', title: '请先上传产品标签', message: '仅支持单页 PDF 标签' })
      return
    }

    const invalid = validateBeforeGenerate(text, madeInChina)
    if (invalid) {
      notify({ type: 'error', title: '无法生成', message: invalid })
      return
    }

    setIsGenerating(true)
    try {
      const generated = await generateProductLabel({ file, text, madeInChina })
      setLastGenerated(generated)
      downloadBlob(generated.blob, generated.filename)
      notify({ type: 'success', title: '标签已生成', message: generated.filename })
    } catch (error) {
      notify({
        type: 'error',
        title: '生成失败',
        message: normalizeErrorMessage(error),
      })
    } finally {
      setIsGenerating(false)
    }
  }, [file, madeInChina, notify, text])

  const handleRedownload = useCallback(() => {
    if (!lastGenerated) return
    downloadBlob(lastGenerated.blob, lastGenerated.filename)
  }, [lastGenerated])

  return (
    <ToolsPageFrame layout="split" className={styles.workbench}>
      <header className={styles.header}>
        <h1 className={styles.title}>产品标签制作</h1>
      </header>

      <ToolsPanel
        title="上传产品标签"
        actions={
          <span className={styles.formatBadge}>.pdf</span>
        }
        className={styles.panel}
      >
        <div className={styles.panelContent}>
          <p className={styles.intro}>
            上传单个产品标签 PDF。服务端只读取文件内容，原始文件不会被修改，返回的是新文件。
          </p>

          <ToolsUploadZone
            accept=".pdf,application/pdf"
            maxSize={50}
            showPreview
            uploadingText="正在读取标签..."
            onUpload={handleUpload}
          />

          <dl className={styles.fileMeta}>
            <div className={styles.metaRow}>
              <dt className={styles.metaLabel}>文件</dt>
              <dd
                data-testid="selected-file-name"
                className={styles.fileValue}
                title={file?.name ?? undefined}
              >
                {file ? file.name : <span className={styles.emptyValue}>未选择</span>}
              </dd>
            </div>
            <div className={styles.metaRow}>
              <dt className={styles.metaLabel}>大小</dt>
              <dd className={styles.fileValue}>
                {file ? (
                  `${(file.size / 1024).toFixed(1)} KB`
                ) : (
                  <span className={styles.emptyValue}>—</span>
                )}
              </dd>
            </div>
          </dl>

          <div className={styles.processingNote}>
            <Tag className={styles.noteIcon} strokeWidth={1.75} aria-hidden="true" />
            <span>
              插入点按标签自身的商品名末行自动定位；若底部安全边距不足或文案超出标签宽度，
              会直接报错而不是裁字，请换用更短的文案或更大的标签。
            </span>
          </div>
        </div>
      </ToolsPanel>

      <ToolsPanel
        title="文案设置"
        actions={
          <div className={styles.actionGroup}>
            <WarmButton
              variant="quiet"
              onClick={handleReset}
              disabled={!file && !text && !lastGenerated}
            >
              <RotateCcw className={styles.buttonIcon} aria-hidden="true" />
              重置
            </WarmButton>
            <WarmButton
              variant="primary"
              onClick={handleGenerate}
              disabled={!canGenerate}
              loading={isGenerating}
              loadingLabel="正在生成产品标签"
            >
              {!isGenerating ? (
                <FileDown className={styles.buttonIcon} aria-hidden="true" />
              ) : null}
              {isGenerating ? '生成中' : '生成并下载'}
            </WarmButton>
          </div>
        }
        className={styles.panel}
      >
        <div className={`${styles.panelContent} ${styles.editorContent}`}>
          <div className={styles.editorField}>
            <div className={styles.fieldHeading}>
              <label
                htmlFor="product-label-text"
                className={styles.fieldLabel}
              >
                文案
              </label>
              <span className={styles.counter}>
                {lineCount}/{MAX_TEXT_LINES} 行 · {text.length}/{MAX_TEXT_CHARS} 字
              </span>
            </div>
            <textarea
              id="product-label-text"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={'例如：Designed in California\nAssembled with care'}
              spellCheck={false}
              aria-describedby="product-label-text-help"
              className={styles.textarea}
            />
            <p id="product-label-text-help" className={styles.help}>
              支持换行，最多 {MAX_TEXT_LINES} 行。文案会接在标签原有商品名之后，与商品名同字号、左对齐。
            </p>
          </div>

          <label
            htmlFor="product-label-made-in-china"
            className={styles.checkRow}
          >
            <input
              id="product-label-made-in-china"
              type="checkbox"
              checked={madeInChina}
              onChange={(event) => setMadeInChina(event.target.checked)}
              className={styles.checkbox}
            />
            <span>Made In China</span>
          </label>

          <div className={styles.exportRow}>
            <span className={styles.localNote}>
              <Upload className={styles.noteIcon} strokeWidth={1.75} aria-hidden="true" />
              上传即处理，不保存到服务器
            </span>
            {lastGenerated ? (
              <WarmButton
                variant="quiet"
                onClick={handleRedownload}
                className={styles.redownload}
                title={lastGenerated.filename}
              >
                <span className={styles.redownloadName}>
                  重新下载 {lastGenerated.filename}
                </span>
              </WarmButton>
            ) : (
              <span className={styles.exportFormat}>导出格式：PDF</span>
            )}
          </div>
        </div>
      </ToolsPanel>
    </ToolsPageFrame>
  )
}
