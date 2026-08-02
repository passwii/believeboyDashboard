'use client'

import { ArrowDown, ArrowUp, Hash, Timer } from 'lucide-react'
import { formatTokenCount } from '@/lib/format/token-count'
import type { TokenUsage } from './types'

interface TokenFooterProps {
  /** Per-message token usage. When all-zero / missing the footer renders nothing
   *  (and only the duration chip is shown if `durationMs` is provided). */
  tokenUsage?: TokenUsage
  /** Wall-clock duration of the assistant turn in ms. Backend currently writes
   *  null (`duration_ms=None` in `ai_chat_v2._finalize_db`); the footer tolerates
   *  null/undefined/0 by hiding the duration chip. */
  durationMs?: number | null
}

/**
 * Polished per-message token & duration footer for assistant messages.
 *
 * Renders two glass chips (matching the dark `bg-white/[0.04]` / `border-white/[0.06]`
 * design language used across the chat):
 *  1. A **tokens chip** showing the compact total + in/out breakdown.
 *  2. A **duration chip** (only when `durationMs > 0`).
 *
 * Returns `null` when there is nothing meaningful to show, so callers can mount it
 * unconditionally without producing empty wrappers.
 */
export function TokenFooter({ tokenUsage, durationMs }: TokenFooterProps) {
  const hasTokens =
    !!tokenUsage && (tokenUsage.total > 0 || tokenUsage.prompt > 0 || tokenUsage.completion > 0)
  const hasDuration = typeof durationMs === 'number' && durationMs > 0

  if (!hasTokens && !hasDuration) return null

  return (
    <div className="mt-1.5 flex items-center gap-1.5 px-1" aria-label="消息统计">
      {hasTokens && tokenUsage && (
        <div
          className="inline-flex items-center gap-1 rounded-md border border-white/[0.06] bg-white/[0.03] px-1.5 py-0.5 text-[10px] text-[#8a8a8f]"
          aria-label={
            hasDuration
              ? `本条消息消耗 ${formatTokenCount(tokenUsage.total)} tokens`
              : `本条消息消耗 ${formatTokenCount(tokenUsage.total)} tokens，时长未记录`
          }
        >
          <Hash className="size-3 text-[#5a5a5f]" aria-hidden />
          <span className="font-medium text-[#a0a0a5]">{formatTokenCount(tokenUsage.total)}</span>
          <span className="text-[#4a4a4f]">·</span>
          <ArrowUp className="size-2.5 text-[#5a5a5f]" aria-hidden />
          <span>{formatTokenCount(tokenUsage.prompt)}</span>
          <ArrowDown className="size-2.5 text-[#5a5a5f]" aria-hidden />
          <span>{formatTokenCount(tokenUsage.completion)}</span>
        </div>
      )}
      {hasDuration && (
        <div
          className="inline-flex items-center gap-1 rounded-md border border-white/[0.06] bg-white/[0.03] px-1.5 py-0.5 text-[10px] text-[#8a8a8f]"
          aria-label={`本条消息耗时 ${formatDuration(durationMs!)}`}
        >
          <Timer className="size-3 text-[#5a5a5f]" aria-hidden />
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