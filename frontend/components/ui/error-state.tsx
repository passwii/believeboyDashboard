import type * as React from 'react'
import { AlertCircle, RefreshCw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * ErrorState 原语（BLF-503 §8 页面模式，三态统一之「错误态」）：
 * 与 `empty-state.tsx` 同构的加载失败提示，可带重试按钮。
 *
 * 三态配方（详见 docs/FRONTEND-DESIGN-SPEC.md §8.4）：
 * - 空态 → `EmptyState` / `EmptyTableState` / `EmptyChartState`（ui/empty-state.tsx）
 * - 加载 → `page-skeletons.tsx` / `table-skeleton.tsx` 骨架
 * - 错误 → 本组件（页面级 `ErrorState`，表格内 `ErrorState colSpan={n}`）
 *
 * 用法：
 * ```tsx
 * {error ? <ErrorState title="数据加载失败" message={error} onRetry={reload} /> : <Content />}
 * ```
 */
export interface ErrorStateProps extends React.HTMLAttributes<HTMLDivElement> {
  /** 错误标题，默认「加载失败」 */
  title?: string
  /** 错误详情（可空） */
  message?: string
  /** 重试回调；不传则不渲染重试按钮 */
  onRetry?: () => void
  /** 重试按钮文案，默认「重试」 */
  retryLabel?: string
  /** 表格内错误行用法：传表头列数，渲染 <td colSpan> 行 */
  colSpan?: number
}

export function ErrorState({
  title = '加载失败',
  message,
  onRetry,
  retryLabel = '重试',
  colSpan,
  className,
  ...props
}: ErrorStateProps) {
  const content = (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 py-10 text-center',
        colSpan ? 'py-8' : 'py-6',
        className
      )}
      {...props}
    >
      <AlertCircle className="h-8 w-8 text-destructive/70" strokeWidth={1.5} />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        {message ? <p className="text-sm text-muted-foreground">{message}</p> : null}
      </div>
      {onRetry ? (
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          {retryLabel}
        </Button>
      ) : null}
    </div>
  )

  if (colSpan !== undefined) {
    return (
      <tr>
        <td colSpan={colSpan} className="text-center text-muted-foreground">
          {content}
        </td>
      </tr>
    )
  }

  return (
    <div className="rounded-lg border border-dashed border-destructive/40 bg-destructive/[0.03]">
      {content}
    </div>
  )
}

export default ErrorState
