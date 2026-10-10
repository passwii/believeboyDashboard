'use client'

import { useCallback, useMemo, useState } from 'react'
import { FileDown, Loader2, RotateCcw, Tag, Upload } from 'lucide-react'

import { TermPanel } from '@/components/terminal/term-panel'
import { TERM_BUTTON, TERM_INPUT } from '@/components/terminal/term-controls'
import { Checkbox } from '@/components/ui/checkbox'
import { UploadZone } from '@/components/ui/upload-zone'
import { useNotifications } from '@/components/notifications'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { cn } from '@/lib/utils'

import {
  MAX_TEXT_CHARS,
  MAX_TEXT_LINES,
  downloadBlob,
  generateProductLabel,
  validateBeforeGenerate,
} from './lib/product-label'

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
    <div className="grid h-auto min-h-[calc(100vh-4rem)] grid-cols-1 gap-2 xl:h-[calc(100vh-4rem)] xl:grid-cols-2">
      <TermPanel
        title="上传产品标签"
        actions={
          <span className="font-mono text-[11px] uppercase tracking-wider text-term-faint">.pdf</span>
        }
        bodyClassName="flex min-h-0 flex-1 flex-col gap-3 p-3"
      >
        <p className="font-sans text-xs text-term-faint">
          上传单个产品标签 PDF。服务端只读取文件内容，原始文件不会被修改，返回的是新文件。
        </p>

        <UploadZone
          accept=".pdf,application/pdf"
          maxSize={50}
          showPreview
          uploadingText="正在读取标签..."
          onUpload={handleUpload}
        />

        <dl className="mt-1 grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1.5 border-t border-term-border pt-3 font-mono text-xs">
          <dt className="text-term-muted">文件</dt>
          <dd
            data-testid="selected-file-name"
            className="truncate text-term-text"
            title={file?.name ?? undefined}
          >
            {file ? file.name : <span className="text-term-faint">未选择</span>}
          </dd>
          <dt className="text-term-muted">大小</dt>
          <dd className="text-term-text">
            {file ? `${(file.size / 1024).toFixed(1)} KB` : <span className="text-term-faint">—</span>}
          </dd>
        </dl>

        <div className="mt-auto flex items-start gap-2 border-t border-term-border pt-3 font-sans text-xs text-term-faint">
          <Tag className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
          <span>
            插入点按标签自身的商品名末行自动定位；若底部安全边距不足或文案超出标签宽度，
            会直接报错而不是裁字，请换用更短的文案或更大的标签。
          </span>
        </div>
      </TermPanel>

      <TermPanel
        title="文案设置"
        actions={
          <>
            <button
              type="button"
              onClick={handleReset}
              disabled={!file && !text && !lastGenerated}
              className={TERM_BUTTON}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              重置
            </button>
            <button
              type="button"
              onClick={handleGenerate}
              disabled={!canGenerate}
              className={cn(TERM_BUTTON, 'border-term-accent/60 text-term-text')}
            >
              {isGenerating ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  生成中
                </>
              ) : (
                <>
                  <FileDown className="h-3.5 w-3.5" />
                  生成并下载
                </>
              )}
            </button>
          </>
        }
        bodyClassName="flex min-h-0 flex-1 flex-col gap-3 p-3"
      >
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <label
              htmlFor="product-label-text"
              className="font-mono text-xs uppercase tracking-wider text-term-muted"
            >
              文案
            </label>
            <span className="font-mono text-[11px] text-term-faint">
              {lineCount}/{MAX_TEXT_LINES} 行 · {text.length}/{MAX_TEXT_CHARS} 字
            </span>
          </div>
          <textarea
            id="product-label-text"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={'例如：Designed in California\nAssembled with care'}
            spellCheck={false}
            className={cn(
              TERM_INPUT,
              'h-auto min-h-[160px] flex-1 resize-none py-2 leading-6'
            )}
          />
          <p className="font-sans text-xs text-term-faint">
            支持换行，最多 {MAX_TEXT_LINES} 行。文案会接在标签原有商品名之后，与商品名同字号、左对齐。
          </p>
        </div>

        <label
          htmlFor="product-label-made-in-china"
          className="flex cursor-pointer items-center gap-2 border-t border-term-border pt-3 font-mono text-xs text-term-text"
        >
          <Checkbox
            id="product-label-made-in-china"
            checked={madeInChina}
            onCheckedChange={(checked) => setMadeInChina(checked === true)}
          />
          Made In China
        </label>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-term-border pt-3 font-sans text-xs text-term-faint">
          <span className="flex items-center gap-2">
            <Upload className="h-3.5 w-3.5" strokeWidth={1.75} />
            上传即处理，不保存到服务器
          </span>
          {lastGenerated ? (
            <button
              type="button"
              onClick={handleRedownload}
              className="font-mono text-xs text-term-muted underline-offset-2 hover:text-term-text hover:underline"
            >
              重新下载 {lastGenerated.filename}
            </button>
          ) : (
            <span className="font-mono">导出格式：PDF</span>
          )}
        </div>
      </TermPanel>
    </div>
  )
}
