'use client'

import { useEffect, useRef, useState } from 'react'
import { Loader2, RotateCcw } from 'lucide-react'

import { TERM_BUTTON } from '@/components/crm/term-shared'
import { cn } from '@/lib/utils'

/**
 * 客户方案 PDF 预览。
 *
 * 复用浏览器自带的 PDF 阅读器：把后端鉴权转发回来的字节转成 blob URL，
 * 塞进 `<iframe>`（Chrome / Edge / Firefox / Safari 均支持内嵌 PDF）。
 * 不引入 pdf.js —— 只读预览，原生阅读器足够，且不额外增加包体。
 *
 * 安全边界：iframe 拿到的是同源 blob URL + 浏览器内置 PDF 插件，不执行
 * 上传文件里的脚本（与 HTML 预览的 sandbox 思路一致）。
 */
export interface ProposalPdfPreviewProps {
  title: string
  /** 拉取 PDF 字节（经后端鉴权转发，不直连 R2、不用公开 URL）。 */
  load: () => Promise<Blob>
  /** 加载失败回调（父级可弹通知）；用 ref 保存，避免父级内联函数触发重复拉取。 */
  onError?: (message: string) => void
  className?: string
  /** 高度用 CSS 高度类控制；默认 70vh。 */
  heightClassName?: string
}

export function ProposalPdfPreview({
  title,
  load,
  onError,
  className,
  heightClassName = 'min-h-[70vh]',
}: ProposalPdfPreviewProps) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)

  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  useEffect(() => {
    let cancelled = false
    let url: string | null = null
    setLoading(true)
    setError(null)
    setObjectUrl(null)

    void (async () => {
      try {
        const blob = await load()
        if (cancelled) return
        // 强制 application/pdf：后端响应头缺失/不准确时，iframe 仍能唤起内嵌阅读器。
        const pdfBlob =
          blob.type === 'application/pdf'
            ? blob
            : new Blob([blob], { type: 'application/pdf' })
        url = URL.createObjectURL(pdfBlob)
        setObjectUrl(url)
      } catch (e) {
        if (cancelled) return
        const message = e instanceof Error ? e.message : '加载 PDF 失败'
        setError(message)
        onErrorRef.current?.(message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [load, reloadKey])

  if (loading) {
    return (
      <div
        className={cn(
          'flex items-center justify-center border border-term-border',
          heightClassName,
          className
        )}
        data-testid="proposal-pdf-loading"
      >
        <span className="flex items-center gap-1.5 font-mono text-xs text-term-faint">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          加载 PDF…
        </span>
      </div>
    )
  }

  if (error || !objectUrl) {
    return (
      <div
        className={cn(
          'flex flex-col items-start gap-2 border border-term-neg/50 bg-term-neg/10 p-2',
          heightClassName,
          className
        )}
        data-testid="proposal-pdf-error"
      >
        <p role="alert" className="font-mono text-xs text-term-neg">
          ERR · {error ?? 'PDF 预览不可用'}
        </p>
        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          className={cn(TERM_BUTTON, 'h-7 gap-1.5 px-1.5')}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          重新加载
        </button>
      </div>
    )
  }

  return (
    <iframe
      title={`${title} · PDF`}
      src={objectUrl}
      data-testid="proposal-pdf-preview"
      className={cn(
        'w-full rounded-none border border-term-border bg-white dark:bg-term-bg',
        heightClassName,
        className
      )}
    />
  )
}
