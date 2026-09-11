'use client'

import * as React from 'react'
import { AlertTriangle, CheckCircle2, CircleSlash, Loader2, RotateCcw, X } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { InsightErrorPayload } from '@/lib/insight/protocol'
import { usePrefersReducedMotion } from '@/lib/hooks/use-prefers-reduced-motion'
import { cn } from '@/lib/utils'

/**
 * Insight 状态与操作区（BLF-1013）。
 *
 * 只做展示与交互：阶段文案、进度、错误文案全部由业务 adapter 通过 props 传入，
 * 组件内部不出现 schedule / ad / inventory 等领域分支。状态语义只依赖 canonical
 * run 状态字符串（`InsightRunStatus`），因此任何 role 的 adapter 都能复用。
 *
 * 可访问性：状态行是独立 `role="status"`（polite），错误走 `role="alert"`，
 * 活动期间容器 `aria-busy`；进度条使用原生 `progressbar` 语义，进度未知时
 * 省略 `aria-valuenow` 表示不确定进度。
 */

export type InsightStatusTone = 'idle' | 'active' | 'success' | 'warning' | 'danger'

const STATUS_TONES: Record<string, InsightStatusTone> = {
  queued: 'idle',
  connecting: 'active',
  live: 'active',
  reconnecting: 'warning',
  aggregating: 'active',
  running: 'active',
  generating: 'active',
  finalizing: 'active',
  completed: 'success',
  failed: 'danger',
  cancelled: 'idle',
}

const TONE_BADGE_VARIANTS: Record<InsightStatusTone, 'secondary' | 'info' | 'success' | 'warning' | 'destructive'> = {
  idle: 'secondary',
  active: 'info',
  success: 'success',
  warning: 'warning',
  danger: 'destructive',
}

const TONE_ICONS: Record<InsightStatusTone, React.ComponentType<{ className?: string }>> = {
  idle: CircleSlash,
  active: Loader2,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: AlertTriangle,
}

export function getInsightStatusTone(status: string, isError = false): InsightStatusTone {
  if (isError) return 'danger'
  return STATUS_TONES[status] ?? 'active'
}

export type InsightStatusProps = {
  /** canonical run 状态（`InsightRunStatus`），未知值按活动态展示 */
  status: string
  /** 主文案：由 adapter 给出的人话阶段描述 */
  label: string
  /** 次级细节（子阶段 / 模型 / 耗时等） */
  detail?: string | null
  /** 0–100；`null` 表示进度未知（不确定进度条） */
  progress?: number | null
  /** 后台继续提示（面板关闭、重连失败） */
  backgroundMessage?: string | null
  error?: InsightErrorPayload | null
  onRetry?: () => void
  onCancel?: () => void
  retryLabel?: string
  cancelLabel?: string
  className?: string
}

export function InsightStatus({
  status,
  label,
  detail,
  progress = null,
  backgroundMessage = null,
  error = null,
  onRetry,
  onCancel,
  retryLabel = '重试',
  cancelLabel = '取消',
  className,
}: InsightStatusProps) {
  const reducedMotion = usePrefersReducedMotion()
  const tone = getInsightStatusTone(status, Boolean(error))
  const Icon = TONE_ICONS[tone]
  const isActive = tone === 'active' || tone === 'warning'
  const showProgress = progress !== null && progress !== undefined && isActive
  const clampedProgress = showProgress ? Math.min(100, Math.max(0, Math.round(progress))) : null

  return (
    <div
      className={cn('flex flex-col gap-2 border border-term-border bg-term-panel p-2', className)}
      data-insight-status
      data-tone={tone}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={TONE_BADGE_VARIANTS[tone]} data-insight-status-badge>
          <Icon
            className={cn('mr-1 inline size-3', isActive && !reducedMotion && 'animate-spin')}
            aria-hidden
          />
          {status}
        </Badge>

        <p
          role="status"
          aria-live="polite"
          aria-busy={isActive || undefined}
          className="min-w-0 flex-1 break-words text-xs text-term-text"
          data-insight-status-label
        >
          {error?.message ?? label}
          {detail && !error ? (
            <span className="ml-2 text-term-muted" data-insight-status-detail>
              {detail}
            </span>
          ) : null}
        </p>

        <div className="flex items-center gap-1" data-insight-status-actions>
          {onRetry && tone === 'danger' ? (
            <Button type="button" variant="term" size="xs" onClick={onRetry}>
              <RotateCcw />
              <span>{retryLabel}</span>
            </Button>
          ) : null}
          {onCancel && isActive ? (
            <Button type="button" variant="term" size="xs" onClick={onCancel}>
              <X />
              <span>{cancelLabel}</span>
            </Button>
          ) : null}
        </div>
      </div>

      {clampedProgress !== null ? (
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={clampedProgress}
          aria-label={label}
          className="h-1 w-full bg-term-raised"
          data-insight-progress
        >
          <div className="h-full bg-primary transition-[width]" style={{ width: `${clampedProgress}%` }} />
        </div>
      ) : null}

      {error && (error.code || error.retryable !== undefined) ? (
        <p className="font-mono text-[0.6875rem] text-term-muted" data-insight-error-code>
          {error.code}
          {error.retryable === false ? ' · 不可重试' : error.retryable ? ' · 可重试' : ''}
          {typeof error.retry_after_seconds === 'number' ? ` · ${error.retry_after_seconds}s 后重试` : ''}
        </p>
      ) : null}

      {backgroundMessage ? (
        <p role="status" className="text-[0.6875rem] text-term-muted" data-insight-background-message>
          {backgroundMessage}
        </p>
      ) : null}
    </div>
  )
}
