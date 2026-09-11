'use client'

import * as React from 'react'
import { ArrowDown, ChevronDown, ChevronRight, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { InsightMarkdown, type InsightChartBlock } from '@/components/insight/insight-markdown'
import { InsightStatus } from '@/components/insight/insight-status'
import { useInsightFollowBottom } from '@/hooks/use-insight-follow-bottom'
import type { InsightErrorPayload } from '@/lib/insight/protocol'
import { usePrefersReducedMotion } from '@/lib/hooks/use-prefers-reduced-motion'
import { cn } from '@/lib/utils'

/**
 * InsightStreamPanel — 独立 Insight 的共享展示面板（BLF-1013）。
 *
 * 该组件不持有任何请求逻辑：start / cancel / retry / detach 全部由业务 adapter
 * 通过 props 注入（通常来自 `useInsightStream`）。组件内部零领域分支——header、
 * meta、status、inspector 与前后置内容都走 render slots，领域文案由 adapter 决定。
 *
 * 关闭面板只是通知 adapter（`onClose`），run 由 hook 继续在后台执行；detached 时
 * 面板把 `backgroundMessage` 呈现为「后台继续」提示，并保留已生成的部分内容。
 */

export type InsightStreamPanelSlots = {
  header?: React.ReactNode
  meta?: React.ReactNode
  status?: React.ReactNode
  beforeContent?: React.ReactNode
  afterContent?: React.ReactNode
  actions?: React.ReactNode
  inspector?: React.ReactNode
}

export type InsightStreamPanelLabels = {
  empty: string
  scrollToLatest: string
  inspector: string
  close: string
  content: string
}

const DEFAULT_LABELS: InsightStreamPanelLabels = {
  empty: '暂无内容',
  scrollToLatest: '有新内容',
  inspector: '详情',
  close: '关闭',
  content: 'Insight 输出',
}

export type InsightStreamPanelProps = {
  /** canonical run 状态字符串，直接透给 `InsightStatus` */
  status: string
  /** 主状态文案（adapter 决定，如「正在聚合销售数据」） */
  statusLabel: string
  statusDetail?: string | null
  progress?: number | null
  error?: InsightErrorPayload | null
  /** 后台继续提示；非空即表示面板已与 run 解绑但任务仍在跑 */
  backgroundMessage?: string | null
  /** 展示内容：draft 传实时草稿，final 传服务端规范化 Markdown */
  content: string
  contentState?: 'draft' | 'final'
  isStreaming?: boolean
  digest?: string | null
  chartLanguages?: string[]
  renderChartBlock?: (block: InsightChartBlock) => React.ReactNode
  onRetry?: () => void
  onCancel?: () => void
  /** 关闭面板：adapter 应在此 detach 并关闭容器，run 继续 */
  onClose?: () => void
  emptyState?: React.ReactNode
  slots?: InsightStreamPanelSlots
  labels?: Partial<InsightStreamPanelLabels>
  exportFileName?: string
  className?: string
  /** 滚动内容区样式（高度、内边距等由 adapter 决定） */
  contentClassName?: string
}

export function InsightStreamPanel({
  status,
  statusLabel,
  statusDetail = null,
  progress = null,
  error = null,
  backgroundMessage = null,
  content,
  contentState = 'draft',
  isStreaming = false,
  digest = null,
  chartLanguages,
  renderChartBlock,
  onRetry,
  onCancel,
  onClose,
  emptyState,
  slots,
  labels,
  exportFileName,
  className,
  contentClassName,
}: InsightStreamPanelProps) {
  const text = { ...DEFAULT_LABELS, ...labels }
  const reducedMotion = usePrefersReducedMotion()
  const [showInspector, setShowInspector] = React.useState(false)
  const { containerRef, hasNewContent, scrollToBottom } = useInsightFollowBottom({
    signal: content,
    reducedMotion,
  })

  const hasContent = content.trim().length > 0
  const inspectorId = React.useId()

  return (
    <div
      className={cn('flex min-w-0 flex-col gap-2 border border-term-border bg-term-panel', className)}
      data-insight-panel
      data-detached={backgroundMessage ? 'true' : undefined}
    >
      {slots?.header || slots?.actions || onClose ? (
        <div className="flex items-start justify-between gap-2 border-b border-term-border p-2">
          <div className="min-w-0 flex-1">{slots?.header}</div>
          <div className="flex shrink-0 items-center gap-1">
            {slots?.actions}
            {onClose ? (
              <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label={text.close}>
                <X />
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {slots?.meta ? (
        <div className="min-w-0 px-2" data-insight-slot="meta">
          {slots.meta}
        </div>
      ) : null}

      {slots?.status ?? (
        <div className="px-2">
          <InsightStatus
            status={status}
            label={statusLabel}
            detail={statusDetail}
            progress={progress}
            error={error}
            backgroundMessage={backgroundMessage}
            onRetry={onRetry}
            onCancel={onCancel}
          />
        </div>
      )}

      {slots?.inspector ? (
        <div className="px-2">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-expanded={showInspector}
            aria-controls={inspectorId}
            onClick={() => setShowInspector((previous) => !previous)}
          >
            {showInspector ? <ChevronDown /> : <ChevronRight />}
            <span>{text.inspector}</span>
          </Button>
          <div id={inspectorId} hidden={!showInspector} className="mt-1" data-insight-slot="inspector">
            {slots.inspector}
          </div>
        </div>
      ) : null}

      {slots?.beforeContent ? <div className="px-2">{slots.beforeContent}</div> : null}

      <div className="relative min-w-0">
        <div
          ref={containerRef}
          tabIndex={0}
          role="group"
          aria-label={text.content}
          data-insight-scroll
          className={cn(
            'max-h-[60vh] min-h-[8rem] overflow-y-auto overscroll-contain px-2 pb-2',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            contentClassName
          )}
        >
          {hasContent ? (
            <InsightMarkdown
              content={content}
              state={contentState}
              isStreaming={isStreaming}
              digest={digest}
              chartLanguages={chartLanguages}
              renderChartBlock={renderChartBlock}
              exportFileName={exportFileName}
            />
          ) : (
            <div className="py-6 text-center text-xs text-term-muted" data-insight-empty>
              {emptyState ?? text.empty}
            </div>
          )}
        </div>

        {hasNewContent ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-2 z-10 flex justify-center">
            <Button
              type="button"
              variant="term"
              size="sm"
              className="animate-scroll-btn-enter pointer-events-auto border-term-border-strong bg-term-raised"
              onClick={scrollToBottom}
              data-insight-new-content
            >
              <ArrowDown />
              <span>{text.scrollToLatest}</span>
            </Button>
          </div>
        ) : null}
      </div>

      {slots?.afterContent ? <div className="px-2">{slots.afterContent}</div> : null}
    </div>
  )
}
