'use client'

import * as React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, Copy, Download } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { usePrefersReducedMotion } from '@/lib/hooks/use-prefers-reduced-motion'
import { splitStreamingMarkdown } from '@/lib/insight/stream-blocks'
import { cn } from '@/lib/utils'

/**
 * Insight 统一 Markdown 渲染器（BLF-1013）。
 *
 * 两种状态共用同一渲染器与同一份原样 Markdown：
 * - `state="draft"`：流式草稿。经 `splitStreamingMarkdown` 切分，未闭合的
 *   fence/表格/列表留在纯文本 tail，绝不把后续块误解析成代码块；闭合的
 *   code block 才交给 `renderChartBlock`，因此图表只在围栏闭合后挂载。
 * - `state="final"`：服务端规范化的终稿（配 digest），整篇直接渲染。
 *
 * 复制/导出始终使用原始 Markdown（含尚未渲染的 tail），不是渲染后的 DOM 文本。
 */

export type InsightChartBlock = {
  language: string
  code: string
}

export type InsightMarkdownLabels = {
  copy: string
  copied: string
  export: string
  rawActions: string
  content: string
}

const DEFAULT_LABELS: InsightMarkdownLabels = {
  copy: '复制 Markdown',
  copied: '已复制',
  export: '导出 .md',
  rawActions: '原始 Markdown',
  content: 'Insight 内容',
}

const DEFAULT_CHART_LANGUAGES = ['chart']

export type InsightMarkdownProps = {
  /** 展示内容：draft 传实时草稿，final 传服务端规范化 Markdown */
  content: string
  state?: 'draft' | 'final'
  /** 是否仍在流式输出（决定 caret 与 aria-busy） */
  isStreaming?: boolean
  /** 终稿内容摘要（服务端 digest），作为 data 属性暴露给消费者 */
  digest?: string | null
  chartLanguages?: string[]
  /** 图表 code block 渲染器；仅在对应围栏闭合后被调用 */
  renderChartBlock?: (block: InsightChartBlock) => React.ReactNode
  onCopyRaw?: (markdown: string) => void
  onExportRaw?: (markdown: string) => void
  exportFileName?: string
  showRawActions?: boolean
  labels?: Partial<InsightMarkdownLabels>
  className?: string
}

function InsightCodeBlock({ language, code }: InsightChartBlock) {
  const [copied, setCopied] = React.useState(false)

  React.useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  const handleCopy = React.useCallback(async () => {
    try {
      await navigator.clipboard?.writeText(code)
    } catch {
      // 剪贴板不可用（http / 权限拒绝）时不阻断阅读，静默降级。
    }
    setCopied(true)
  }, [code])

  return (
    <div className="my-3 border border-term-border bg-term-raised" data-insight-code-block>
      <div className="flex items-center justify-between border-b border-term-border px-2 py-1">
        <span className="font-mono text-[0.6875rem] uppercase tracking-wide text-term-muted">
          {language || 'text'}
        </span>
        <Button type="button" variant="ghost" size="xs" onClick={handleCopy}>
          {copied ? <Check /> : <Copy />}
          <span>{copied ? '已复制' : '复制'}</span>
        </Button>
      </div>
      <pre className="overflow-x-auto p-3">
        <code className="font-mono text-[0.8125rem] leading-6">{code}</code>
      </pre>
    </div>
  )
}

function downloadMarkdown(fileName: string, markdown: string): void {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return
  const blobUrl = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = blobUrl
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(blobUrl)
}

export function InsightMarkdown({
  content,
  state = 'draft',
  isStreaming = false,
  digest,
  chartLanguages = DEFAULT_CHART_LANGUAGES,
  renderChartBlock,
  onCopyRaw,
  onExportRaw,
  exportFileName = 'insight.md',
  showRawActions = true,
  labels,
  className,
}: InsightMarkdownProps) {
  const text = { ...DEFAULT_LABELS, ...labels }
  const reducedMotion = usePrefersReducedMotion()
  const [copied, setCopied] = React.useState(false)

  React.useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  const { stable, tail } =
    state === 'final' ? { stable: content, tail: '' } : splitStreamingMarkdown(content)

  const copyRaw = React.useCallback(async () => {
    try {
      await navigator.clipboard?.writeText(content)
    } catch {
      // 同 InsightCodeBlock：剪贴板不可用时保持只读体验。
    }
    onCopyRaw?.(content)
    setCopied(true)
  }, [content, onCopyRaw])

  const exportRaw = React.useCallback(() => {
    onExportRaw?.(content)
    downloadMarkdown(exportFileName, content)
  }, [content, exportFileName, onExportRaw])

  const components = React.useMemo(() => {
    const code = (props: { className?: string; children?: React.ReactNode }) => {
      const match = /language-([\w-]+)/.exec(props.className ?? '')
      const raw = String(props.children ?? '')
      const isBlock = Boolean(match) || raw.includes('\n')

      if (!isBlock) {
        return (
          <code className="rounded-sm bg-term-raised px-1.5 py-0.5 font-mono text-[0.85em]">
            {props.children}
          </code>
        )
      }

      const block: InsightChartBlock = {
        language: match?.[1] ?? '',
        code: raw.replace(/\n$/, ''),
      }
      // 只有闭合的围栏才可能走到这里（stable 内所有围栏均已闭合）。
      if (renderChartBlock && chartLanguages.includes(block.language)) {
        return <>{renderChartBlock(block)}</>
      }
      return <InsightCodeBlock {...block} />
    }

    return {
      code,
      // 表格自带横向滚动容器：移动端可横滑，不压缩列宽。
      table: (props: { children?: React.ReactNode }) => (
        <div className="my-3 w-full overflow-x-auto" data-insight-table-scroll>
          <table className="w-full border-collapse">{props.children}</table>
        </div>
      ),
      a: (props: { href?: string; children?: React.ReactNode }) => (
        <a href={props.href} target="_blank" rel="noreferrer">
          {props.children}
        </a>
      ),
      pre: (props: { children?: React.ReactNode }) => <>{props.children}</>,
    }
  }, [chartLanguages, renderChartBlock])

  const showCaret = isStreaming && !reducedMotion
  const caret = showCaret ? (
    <span
      aria-hidden
      data-insight-caret
      className="animate-cursor-blink ml-0.5 inline-block h-[1em] w-[2px] translate-y-[0.15em] bg-primary"
    />
  ) : null

  return (
    <div className={cn('min-w-0 text-sm leading-6 text-term-text', className)} data-insight-markdown>
      {showRawActions && content.length > 0 ? (
        <div
          className="mb-2 flex flex-wrap items-center justify-end gap-1"
          aria-label={text.rawActions}
          data-insight-raw-actions
        >
          <Button type="button" variant="ghost" size="xs" onClick={copyRaw}>
            {copied ? <Check /> : <Copy />}
            <span>{copied ? text.copied : text.copy}</span>
          </Button>
          <Button type="button" variant="ghost" size="xs" onClick={exportRaw}>
            <Download />
            <span>{text.export}</span>
          </Button>
        </div>
      ) : null}

      <div
        role="document"
        aria-label={text.content}
        aria-busy={isStreaming || undefined}
        data-state={state}
        data-content-digest={digest ?? undefined}
        className={cn(
          'min-w-0 break-words',
          '[&_a]:text-primary [&_a]:underline-offset-4 hover:[&_a]:underline',
          '[&_blockquote]:border-l-2 [&_blockquote]:border-term-border [&_blockquote]:pl-4 [&_blockquote]:text-term-muted',
          '[&_h1]:mt-5 [&_h1]:text-lg [&_h1]:font-semibold',
          '[&_h2]:mt-4 [&_h2]:text-base [&_h2]:font-semibold',
          '[&_h3]:mt-3 [&_h3]:text-sm [&_h3]:font-semibold',
          '[&_hr]:my-4 [&_hr]:border-term-border',
          '[&_li]:ml-5 [&_li]:list-disc',
          '[&_ol>li]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-5',
          '[&_p]:break-words [&_p]:whitespace-pre-wrap',
          '[&_tbody_tr]:border-t [&_tbody_tr]:border-term-border',
          '[&_td]:border [&_td]:border-term-border [&_td]:px-3 [&_td]:py-2 [&_td]:align-top',
          '[&_th]:border [&_th]:border-term-border [&_th]:bg-term-raised [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-medium',
          '[&_ul>li]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5'
        )}
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {stable}
        </ReactMarkdown>
        {tail ? (
          <div
            data-insight-tail
            className={cn(
              'break-words whitespace-pre-wrap',
              /^ {0,3}(`{3,}|~{3,})/.test(tail)
                ? 'my-3 border border-term-border bg-term-raised p-3 font-mono text-[0.8125rem] leading-6'
                : 'text-term-muted'
            )}
          >
            {tail}
            {caret}
          </div>
        ) : (
          caret
        )}
      </div>
    </div>
  )
}
