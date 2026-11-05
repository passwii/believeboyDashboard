'use client'

import { ArrowDown, ArrowUp, Hash, Timer } from 'lucide-react'
import { formatTokenCount } from '@/lib/format/token-count'
import type { TokenUsage } from './types'
import styles from './warm-chat.module.css'

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
          className={`${styles.tokenChip} inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px]`}
          aria-label={
            hasDuration
              ? `本条消息消耗 ${formatTokenCount(tokenUsage.total)} tokens`
              : `本条消息消耗 ${formatTokenCount(tokenUsage.total)} tokens，时长未记录`
          }
        >
          <Hash className="size-3" aria-hidden />
          <span className="font-medium">{formatTokenCount(tokenUsage.total)}</span>
          <span>·</span>
          <ArrowUp className="size-2.5" aria-hidden />
          <span>{formatTokenCount(tokenUsage.prompt)}</span>
          <ArrowDown className="size-2.5" aria-hidden />
          <span>{formatTokenCount(tokenUsage.completion)}</span>
        </div>
      )}
      {hasDuration && (
        <div
          className={`${styles.tokenChip} inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px]`}
          aria-label={`本条消息耗时 ${formatDuration(durationMs!)}`}
        >
          <Timer className="size-3" aria-hidden />
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
