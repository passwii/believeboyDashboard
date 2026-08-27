'use client'

import { ArrowDown, ArrowUp, Hash, Timer } from 'lucide-react'
import { formatTokenCount } from '@/lib/format/token-count'
import type { TokenUsage } from './types'

interface TokenFooterProps {
  tokenUsage?: TokenUsage
  durationMs?: number | null
}

export function TokenFooter({ tokenUsage, durationMs }: TokenFooterProps) {
  const hasTokens =
    !!tokenUsage && (tokenUsage.total > 0 || tokenUsage.prompt > 0 || tokenUsage.completion > 0)
  const hasDuration = typeof durationMs === 'number' && durationMs > 0

  if (!hasTokens && !hasDuration) return null

  return (
    <div className="mt-1.5 flex items-center gap-1.5 px-1" aria-label="消息统计">
      {hasTokens && tokenUsage && (
        <div
          className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] bg-slate-50 border-slate-200 text-slate-500 dark:bg-white/[0.03] dark:border-white/[0.06] dark:text-[#8a8a8f]"
          aria-label={
            hasDuration
              ? `本条消息消耗 ${formatTokenCount(tokenUsage.total)} tokens`
              : `本条消息消耗 ${formatTokenCount(tokenUsage.total)} tokens，时长未记录`
          }
        >
          <Hash className="size-3 text-slate-400 dark:text-[#5a5a5f]" aria-hidden />
          <span className="font-medium text-slate-600 dark:text-[#a0a0a5]">{formatTokenCount(tokenUsage.total)}</span>
          <span className="text-slate-300 dark:text-[#4a4a4f]">·</span>
          <ArrowUp className="size-2.5 text-slate-400 dark:text-[#5a5a5f]" aria-hidden />
          <span>{formatTokenCount(tokenUsage.prompt)}</span>
          <ArrowDown className="size-2.5 text-slate-400 dark:text-[#5a5a5f]" aria-hidden />
          <span>{formatTokenCount(tokenUsage.completion)}</span>
        </div>
      )}
      {hasDuration && (
        <div
          className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] bg-slate-50 border-slate-200 text-slate-500 dark:bg-white/[0.03] dark:border-white/[0.06] dark:text-[#8a8a8f]"
          aria-label={`本条消息耗时 ${formatDuration(durationMs!)}`}
        >
          <Timer className="size-3 text-slate-400 dark:text-[#5a5a5f]" aria-hidden />
          <span>{formatDuration(durationMs!)}</span>
        </div>
      )}
    </div>
  )
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}
