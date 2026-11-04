'use client'

import * as React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { Check, Copy, Download } from 'lucide-react'

import { WarmButton } from '@/components/dashboard-v2/warm-ledger/controls'
import { Button } from '@/components/ui/button'
import { usePrefersReducedMotion } from '@/lib/hooks/use-prefers-reduced-motion'
import { splitStreamingMarkdown } from '@/lib/insight/stream-blocks'
import { cn } from '@/lib/utils'

import type { InsightAppearance } from './insight-presentation'
import styles from './insight-warm.module.css'

/**
 * Insight 统一 Markdown 渲染器（BLF-1013）。
 *
 * 两种状态共用同一渲染器与同一份原样 Markdown：
 * - `state="draft"`：流式草稿。经 `splitStreamingMarkdown` 切分，未闭合的
 *   fence/表格/列表留在纯文本 tail，绝不把后续块误解析成代码块；闭合的
 *   code block 才交给 `renderChartBlock`，因此图表只在围栏闭合后挂载。
 * - `state="final"`：服务端规范化的终稿（配 digest），整篇直接渲染。
 *
 * 单换行按硬换行渲染（`remark-breaks`）：角色产出与历史摘要都以单换行作行分隔，
 * 且列表项内的续行不会落在 `<p>` 上（`whitespace-pre-wrap` 管不到），故由插件层保证。
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
  /** Legacy Terminal is the default; Warm opts into the V4 presentation boundary. */
  appearance?: InsightAppearance
  /** Page-local class hook for the copy/export action wrapper. */
  copyExportClassName?: string
  className?: string
}

function InsightCodeBlock({
  language,
  code,
  appearance,
}: InsightChartBlock & { appearance: InsightAppearance }) {
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
    <div
      className={cn(
        appearance === 'warm'
          ? styles.codeBlock
          : 'my-3 border border-term-border bg-term-raised'
      )}
      data-insight-code-block
      data-insight-appearance={appearance}
    >
      <div
        className={cn(
          'flex items-center justify-between',
          appearance === 'warm'
            ? styles.codeHeader
            : 'border-b border-term-border px-2 py-1'
        )}
      >
        <span
          className={cn(
            'font-mono uppercase tracking-wide',
            appearance === 'warm'
              ? styles.codeLanguage
              : 'text-[0.6875rem] text-term-muted'
          )}
        >
          {language || 'text'}
        </span>
        {appearance === 'warm' ? (
          <WarmButton
            type="button"
            variant="quiet"
            className={styles.copyExportAction}
            onClick={handleCopy}
          >
            {copied ? <Check /> : <Copy />}
            <span>{copied ? '已复制' : '复制'}</span>
          </WarmButton>
        ) : (
          <Button type="button" variant="ghost" size="xs" onClick={handleCopy}>
            {copied ? <Check /> : <Copy />}
            <span>{copied ? '已复制' : '复制'}</span>
          </Button>
        )}
      </div>
      <pre
        className={cn(
          'overflow-x-auto',
          appearance === 'warm' ? styles.codePre : 'p-3'
        )}
      >
        <code
          className={cn(
            'font-mono',
            appearance === 'warm' ? styles.code : 'text-[0.8125rem] leading-6'
          )}
        >
          {code}
        </code>
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
  appearance = 'legacy',
  copyExportClassName,
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
          <code
            className={cn(
              'font-mono text-[0.85em]',
              appearance === 'warm'
                ? styles.inlineCode
                : 'rounded-sm bg-term-raised px-1.5 py-0.5'
            )}
          >
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
      return <InsightCodeBlock {...block} appearance={appearance} />
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
  }, [appearance, chartLanguages, renderChartBlock])

  /**
   * stable 段的渲染结果按元素身份缓存（BLF-1072）。逐字吐字时每帧变的只有 tail，
   * stable 字符串只在「换行被吐出来」时变一次；元素身份不变时 React 整棵跳过这棵
   * 子树，`react-markdown` 因此不会每帧重新解析全文（只重渲 tail）。
   *
   * 缓存命中的前提是 `components` 引用稳定（§依赖 `chartLanguages` / `renderChartBlock`）：
   * 调用方用 useCallback / 模块常量传参，否则每帧换新会让缓存失效。
   */
  const stableTree = React.useMemo(
    () => (
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components}>
        {stable}
      </ReactMarkdown>
    ),
    [components, stable]
  )

  /**
   * caret 也缓存：`isStreaming` 在整段流式期间恒为 true，逐帧换新元素虽然只是浅树，
   * 但没有任何理由让它参与比较。
   */
  const caret = React.useMemo(
    () =>
      isStreaming && !reducedMotion ? (
        <span
          aria-hidden
          data-insight-caret
          className={cn(
            'animate-cursor-blink ml-0.5 inline-block h-[1em] w-[2px] translate-y-[0.15em]',
            appearance === 'warm' ? styles.caret : 'bg-primary'
          )}
        />
      ) : null,
    [appearance, isStreaming, reducedMotion]
  )

  /**
   * tail 的函数体缓存：tail 每帧都在变，但「怎么渲染这段纯文本」不随内容变。
   * 缓存后 `{tailView}` 每帧只换 children 文本，div 身份不变。
   */
  const tailView = React.useCallback(
    (text: string) => (
      <div
        data-insight-tail
        className={cn(
          'break-words whitespace-pre-wrap',
          /^ {0,3}(`{3,}|~{3,})/.test(text)
            ? appearance === 'warm'
              ? styles.tailCode
              : 'my-3 border border-term-border bg-term-raised p-3 font-mono text-[0.8125rem] leading-6'
            : appearance === 'warm'
              ? styles.markdownTail
              : 'text-term-muted'
        )}
      >
        {text}
        {caret}
      </div>
    ),
    [appearance, caret]
  )

  return (
    <div
      className={cn(
        'min-w-0 text-sm leading-6',
        appearance === 'warm' ? styles.markdownRoot : 'text-term-text',
        className
      )}
      data-insight-markdown
      data-insight-appearance={appearance}
    >
      {showRawActions && content.length > 0 ? (
        <div
          role="group"
          className={cn(
            'flex flex-wrap items-center justify-end',
            appearance === 'warm'
              ? styles.rawActions
              : 'mb-2 gap-1',
            copyExportClassName
          )}
          aria-label={text.rawActions}
          data-insight-raw-actions
        >
          {appearance === 'warm' ? (
            <>
              <WarmButton
                type="button"
                variant="quiet"
                className={styles.copyExportAction}
                onClick={copyRaw}
              >
                {copied ? <Check /> : <Copy />}
                <span>{copied ? text.copied : text.copy}</span>
              </WarmButton>
              <WarmButton
                type="button"
                variant="quiet"
                className={styles.copyExportAction}
                onClick={exportRaw}
              >
                <Download />
                <span>{text.export}</span>
              </WarmButton>
            </>
          ) : (
            <>
              <Button type="button" variant="ghost" size="xs" onClick={copyRaw}>
                {copied ? <Check /> : <Copy />}
                <span>{copied ? text.copied : text.copy}</span>
              </Button>
              <Button type="button" variant="ghost" size="xs" onClick={exportRaw}>
                <Download />
                <span>{text.export}</span>
              </Button>
            </>
          )}
        </div>
      ) : null}

      <div
        role="document"
        aria-label={text.content}
        aria-busy={isStreaming || undefined}
        data-state={state}
        data-content-digest={digest ?? undefined}
        className={cn(
          'break-words',
          appearance === 'warm'
            ? styles.markdownContent
            : [
                'min-w-0',
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
                '[&_ul>li]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5',
              ]
        )}
      >
        {stableTree}
        {tail ? tailView(tail) : caret}
      </div>
    </div>
  )
}
