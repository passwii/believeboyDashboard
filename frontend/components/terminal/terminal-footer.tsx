'use client'

import * as React from 'react'
import { Bell } from 'lucide-react'

import { useExchangeRateTicker } from '@/lib/hooks/use-exchange-rate-ticker'
import { useDailyBrief } from '@/lib/hooks/use-daily-brief'
import { useInventoryAlert } from '@/lib/hooks/use-inventory-alert'
import { useServerNotifications } from '@/components/notifications/server-notifications-context'
import {
  TERMINAL_FOOTER_HEIGHT,
  TERMINAL_TICKER,
} from '@/components/terminal/terminal-constants'
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

function formatMoney(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value)
}

/** 环比涨跌着色：▲绿 / ▼红 / 持平或无数据灰 */
function changeColorClass(changePct: number | null): string {
  if (changePct == null || changePct === 0) return 'text-term-faint'
  return changePct > 0 ? 'text-term-pos' : 'text-term-neg'
}

/**
 * Global Footer 系统状态栏（固定 28px，BLF-809/816）：
 * 多频道滚动 Ticker（汇率全币种+环比 · 全局快报 GMV/订单/Pending · 库存预警 · 数据更新时间 · 更新日志摘要）
 * · 同步引擎状态 · 未读通知 · 双时区时钟。
 * 各段以 1px 竖分隔线切分；移动端隐藏（<sm）。
 */
export function TerminalFooter() {
  const { ticks, status, lastSuccessAt } = useExchangeRateTicker()
  const { brief, status: briefStatus } = useDailyBrief()
  const inventoryAlert = useInventoryAlert()
  const { unreadCount } = useServerNotifications()

  // 时钟仅在客户端挂载后渲染，避免 SSR 水合不一致
  const [now, setNow] = React.useState<Date | null>(null)
  React.useEffect(() => {
    setNow(new Date())
    const timer = window.setInterval(() => setNow(new Date()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  // 更新日志频道：轻量端点，一次拉取即可（changelog 随发版变化，无需轮询）
  const [changelog, setChangelog] = React.useState<{
    version: string
    summary: string
  } | null>(null)
  React.useEffect(() => {
    if (!TERMINAL_TICKER.channels.changelog) return
    let cancelled = false
    fetch('/api/changelog-latest', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((payload: { version?: string; summary?: string }) => {
        if (!cancelled && payload.version && payload.summary) {
          // 摘要截断，避免单频道占满滚动带
          setChangelog({ version: payload.version, summary: payload.summary.slice(0, 60) })
        }
      })
      .catch(() => {
        // 该频道降级：保持 null（隐藏），不影响其他频道
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 相对时间跟随 now 每 30s 刷新
  const lastSyncLabel = React.useMemo(
    () => (lastSuccessAt && now ? formatRelative(lastSuccessAt) : null),
    [lastSuccessAt, now]
  )

  // —— Ticker 各频道内容段（每项为一段 JSX；空数组表示该频道降级隐藏）——
  const channels = React.useMemo(() => {
    const items: React.ReactNode[] = []
    let key = 0

    if (TERMINAL_TICKER.channels.fx) {
      items.push(
        <span key={`fx-${key++}`} className="flex shrink-0 items-center gap-2">
          {ticks.map((tick) => (
            <span key={tick.currency} className="flex items-center">
              <span className="text-term-faint">{tick.currency}/CNY</span>
              <span
                className={cn(
                  'ml-1 font-mono tabular-nums',
                  tick.rate == null ? 'text-term-faint' : 'text-term-text'
                )}
              >
                {tick.rate == null ? '--' : tick.rate.toFixed(4)}
              </span>
              <span className={cn('ml-1 font-mono tabular-nums', changeColorClass(tick.changePct))}>
                {tick.changePct == null ? '' : `${tick.changePct > 0 ? '▲' : tick.changePct < 0 ? '▼' : '—'}${Math.abs(tick.changePct).toFixed(2)}%`}
              </span>
            </span>
          ))}
        </span>
      )
    }

    if (TERMINAL_TICKER.channels.dailyBrief) {
      const briefReady = briefStatus === 'ok'
      items.push(
        <span key={`brief-${key++}`} className="flex shrink-0 items-center">
          <span className="mr-1 font-semibold uppercase tracking-wider text-term-faint">快报</span>
          <span className="text-term-faint">GMV</span>
          <span className={cn('ml-1 mr-3 font-mono tabular-nums', !briefReady && 'text-term-faint')}>
            {briefReady && brief.gmv != null ? formatMoney(brief.gmv) : '--'}
          </span>
          <span className="text-term-faint">订单</span>
          <span className={cn('ml-1 mr-3 font-mono tabular-nums', !briefReady && 'text-term-faint')}>
            {briefReady && brief.orders != null ? brief.orders : '--'}
          </span>
          <span className="text-term-faint">Pending</span>
          <span className={cn('ml-1 font-mono tabular-nums', !briefReady && 'text-term-faint')}>
            {briefReady && brief.pending != null ? brief.pending : '--'}
          </span>
        </span>
      )
    }

    if (TERMINAL_TICKER.channels.syncTime) {
      items.push(
        <span key={`sync-${key++}`} className="flex shrink-0 items-center">
          <span className="text-term-faint">数据更新</span>
          <span className="ml-1 font-mono tabular-nums">{lastSyncLabel ?? '--'}</span>
        </span>
      )
    }

    if (TERMINAL_TICKER.channels.changelog) {
      if (changelog) {
        items.push(
          <span key={`log-${key++}`} className="flex shrink-0 items-center">
            <span className="mr-1 font-semibold uppercase tracking-wider text-term-faint">
              更新
            </span>
            <span className="text-term-text">{changelog.version}</span>
            <span className="ml-1 text-term-faint">{changelog.summary}</span>
          </span>
        )
      }
    }

    if (TERMINAL_TICKER.channels.inventoryAlert) {
      const alertReady = inventoryAlert.status === 'ok'
      const alertCount = inventoryAlert.count
      const hasRisk = alertReady && (alertCount ?? 0) > 0
      items.push(
        <span key={`alert-${key++}`} className="flex shrink-0 items-center">
          <span className="mr-1 font-semibold uppercase tracking-wider text-term-faint">
            库存预警
          </span>
          <span
            className={cn('font-mono tabular-nums', hasRisk ? 'text-term-neg' : 'text-term-faint')}
          >
            {!alertReady || alertCount == null
              ? '--'
              : hasRisk
                ? `${alertCount} SKU 低于安全库存`
                : '正常'}
          </span>
        </span>
      )
    }

    return items
  }, [ticks, brief, briefStatus, lastSyncLabel, changelog, inventoryAlert])

  // 频道间分隔符 + 双拷贝（无缝 marquee）
  const tickerContent = (copy: number) => (
    <span key={copy} className="flex shrink-0 items-center" aria-hidden={copy === 1}>
      {channels.map((channel, index) => (
        <React.Fragment key={`${copy}-ch-${index}`}>
          {index > 0 && <span className="mx-4 text-term-border">│</span>}
          {channel}
        </React.Fragment>
      ))}
    </span>
  )

  // 内容宽度探测：超宽才滚动（并按速度换算时长）；欠宽时静态展示，避免空档跳动
  const trackRef = React.useRef<HTMLDivElement | null>(null)
  const viewportRef = React.useRef<HTMLDivElement | null>(null)
  const [scrollDurationSeconds, setScrollDurationSeconds] = React.useState<number | null>(null)

  React.useEffect(() => {
    if (!TERMINAL_TICKER.staticWhenContentFits) {
      setScrollDurationSeconds(null)
      return
    }
    const measure = () => {
      const track = trackRef.current
      const viewport = viewportRef.current
      if (!track || !viewport) return
      // 单拷贝宽度 = 轨道总宽的一半（双拷贝渲染）
      const contentWidth = track.scrollWidth / 2
      if (contentWidth > viewport.clientWidth) {
        setScrollDurationSeconds(
          Math.max(20, contentWidth / TERMINAL_TICKER.scrollSpeedPxPerSecond)
        )
      } else {
        setScrollDurationSeconds(null)
      }
    }
    measure()
    // 字体/数据异步到达后再量一次
    const raf = window.requestAnimationFrame(measure)
    window.addEventListener('resize', measure)
    return () => {
      window.cancelAnimationFrame(raf)
      window.removeEventListener('resize', measure)
    }
  }, [channels])

  return (
    <footer
      style={{ height: TERMINAL_FOOTER_HEIGHT }}
      data-testid="terminal-footer"
      className="hidden shrink-0 items-stretch overflow-hidden border-t border-term-border bg-term-panel text-sm leading-none text-term-muted sm:flex"
    >
      {/* 多频道滚动 Ticker */}
      <div className="flex min-w-0 flex-1 items-center gap-2 px-3">
        <div
          ref={viewportRef}
          className="relative min-w-0 flex-1 overflow-hidden"
          aria-label="多频道信息流"
        >
          <div
            ref={trackRef}
            data-testid="terminal-ticker-track"
            className={cn('term-marquee-track', scrollDurationSeconds == null && 'term-marquee-static')}
            style={
              scrollDurationSeconds != null
                ? { animationDuration: `${scrollDurationSeconds}s` }
                : undefined
            }
          >
            {[0, 1].map(tickerContent)}
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
          <Bell className="h-3.5 w-3.5" />
          <span className="font-mono tabular-nums">{unreadCount}</span>
        </div>
      )}

      {/* 双时区时钟 */}
      <div className="hidden shrink-0 items-center gap-2 border-l border-term-border px-3 font-mono tabular-nums lg:flex">
        <span>BJ {now ? formatClock(now, 'Asia/Shanghai') : '--:--'}</span>
        <span className="text-term-faint">·</span>
        <span>PT {now ? formatClock(now, 'America/Los_Angeles') : '--:--'}</span>
      </div>
    </footer>
  )
}
