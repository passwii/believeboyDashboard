'use client'

import * as React from 'react'
import { Bell } from 'lucide-react'

import { useExchangeRateTicker } from '@/lib/hooks/use-exchange-rate-ticker'
import { useServerNotifications } from '@/components/notifications/server-notifications-context'
import { TERMINAL_FOOTER_HEIGHT } from '@/components/terminal/terminal-constants'
import { cn } from '@/lib/utils'

function formatClock(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
  }).format(date)
}

function formatRelative(ms: number): string {
  const deltaSec = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (deltaSec < 60) return `${deltaSec}秒前`
  const deltaMin = Math.floor(deltaSec / 60)
  if (deltaMin < 60) return `${deltaMin}分钟前`
  return `${Math.floor(deltaMin / 60)}小时前`
}

/**
 * Global Footer 系统状态栏（固定 24px，BLF-809）：
 * 汇率 ticker（5 分钟轮询，失败降级 "--"）· 同步引擎状态 · 未读通知 · 双时区时钟。
 * 各段以 1px 竖分隔线切分；移动端隐藏（<sm）。
 */
export function TerminalFooter() {
  const { ticks, status, lastSuccessAt } = useExchangeRateTicker()
  const { unreadCount } = useServerNotifications()

  // 时钟仅在客户端挂载后渲染，避免 SSR 水合不一致
  const [now, setNow] = React.useState<Date | null>(null)
  React.useEffect(() => {
    setNow(new Date())
    const timer = window.setInterval(() => setNow(new Date()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  // 相对时间跟随 now 每 30s 刷新
  const lastSyncLabel = React.useMemo(
    () => (lastSuccessAt && now ? formatRelative(lastSuccessAt) : null),
    [lastSuccessAt, now]
  )

  return (
    <footer
      style={{ height: TERMINAL_FOOTER_HEIGHT }}
      data-testid="terminal-footer"
      className="hidden shrink-0 items-stretch overflow-hidden border-t border-term-border bg-term-panel font-mono text-[11px] leading-none text-term-muted sm:flex"
    >
      {/* 汇率 ticker */}
      <div className="flex min-w-0 flex-1 items-center gap-2 px-3">
        <span className="shrink-0 font-semibold uppercase tracking-wider text-term-faint">FX</span>
        <div className="relative min-w-0 flex-1 overflow-hidden" aria-label="汇率行情">
          <div className="term-marquee-track">
            {[0, 1].map((copy) => (
              <span key={copy} className="flex shrink-0 items-center" aria-hidden={copy === 1}>
                {ticks.map((tick) => (
                  <span key={`${copy}-${tick.currency}`} className="flex items-center">
                    <span className="text-term-faint">{tick.currency}/CNY</span>
                    <span
                      className={cn(
                        'ml-1 mr-4 tabular-nums',
                        tick.rate == null ? 'text-term-faint' : 'text-term-text'
                      )}
                    >
                      {tick.rate == null ? '--' : tick.rate.toFixed(4)}
                    </span>
                  </span>
                ))}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* 同步引擎状态 */}
      <div className="hidden shrink-0 items-center gap-1.5 border-l border-term-border px-3 md:flex">
        <span
          data-testid="terminal-sync-dot"
          className={cn(
            'h-1.5 w-1.5 rounded-full',
            status === 'ok' && 'bg-term-pos',
            status === 'loading' && 'bg-term-warn',
            status === 'error' && 'bg-term-neg'
          )}
        />
        <span>
          {status === 'ok' && `同步正常 ${lastSyncLabel ?? ''}`}
          {status === 'loading' && '同步中…'}
          {status === 'error' && '同步异常'}
        </span>
      </div>

      {/* 未读通知 */}
      {unreadCount > 0 && (
        <div className="flex shrink-0 items-center gap-1 border-l border-term-border px-3 text-term-text">
          <Bell className="h-3 w-3" />
          <span className="tabular-nums">{unreadCount}</span>
        </div>
      )}

      {/* 双时区时钟 */}
      <div className="hidden shrink-0 items-center gap-2 border-l border-term-border px-3 tabular-nums lg:flex">
        <span>BJ {now ? formatClock(now, 'Asia/Shanghai') : '--:--'}</span>
        <span className="text-term-faint">·</span>
        <span>PT {now ? formatClock(now, 'America/Los_Angeles') : '--:--'}</span>
      </div>
    </footer>
  )
}
