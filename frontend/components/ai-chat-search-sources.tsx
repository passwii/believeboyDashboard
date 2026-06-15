'use client'

import { useCallback, useRef } from 'react'
import { Clock, Globe } from 'lucide-react'
import Image from 'next/image'

import { cn } from '@/lib/utils'

import type { SearchSource, SearchTimeRange } from '@/lib/api/ai-chat'

/**
 * [BEL-81.B] 搜索结果卡片组件。
 *
 * 三个小目标的合体：
 * - B1 深色化：把浅色 token（`from-surface-panel` / `hover:bg-slate-50/90`）
 *   换成 `border-white/[0.08]` + `bg-white/[0.04]`，与聊天框背景融合。
 * - B2 timeRange chip：在卡片标题上方显示「今日 / 近 7 天 / 近 30 天 /
 *   近 1 年」小 chip。`timeRange` 为 'all' 或缺省时不渲染。
 * - B3 入场动画：每张卡片 `animationDelay: i * 40ms` 错落入场；滚动容器
 *   启用 `scroll-snap-type: x mandatory`，每张卡 `scroll-snap-align: start`。
 *
 * `searching` 状态由父组件（`ChatMessageList`）控制：
 * `tool_searching` 事件触发时置 true，渲染 2 张骨架卡占位；
 * `sources` 事件到达后置 false，渲染真实卡片。
 */
type AIChatSearchSourcesProps = {
  sources: SearchSource[]
  /** [BEL-81.B] 联网搜索时间范围标签。 */
  timeRange?: SearchTimeRange | null
  /** [BEL-81.B] 真实搜索词（来自 `sources` 事件的 `query` 字段，可选）。 */
  query?: string | null
  /** 父组件传入：是否仍在等待搜索结果。true 时渲染骨架卡。 */
  searching?: boolean
  className?: string
}

// 卡片上方时间范围 chip 标签映射。
// 与后端 `detect_time_range_from_query` / tool 透传的 day|week|month|year 对齐。
const TIME_RANGE_LABEL: Record<SearchTimeRange, string> = {
  day: '今日',
  week: '近 7 天',
  month: '近 30 天',
  year: '近 1 年',
  all: '全部时间',
}

function getFaviconUrl(url?: string, favicon?: string | null): string | null {
  if (favicon) {
    return favicon
  }
  if (url) {
    try {
      const parsed = new URL(url)
      return `https://www.google.com/s2/favicons?domain=${parsed.hostname}&sz=32`
    } catch {
      return null
    }
  }
  return null
}

function getFaviconUrlDirect(url?: string, favicon?: string | null): string | null {
  if (favicon) {
    return favicon
  }
  if (url) {
    try {
      const parsed = new URL(url)
      return `${parsed.origin}/favicon.ico`
    } catch {
      return null
    }
  }
  return null
}

export function AIChatSearchSources({
  sources,
  timeRange,
  query,
  searching,
  className,
}: AIChatSearchSourcesProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const handleWheelScroll = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    const container = scrollRef.current
    if (!container) {
      return
    }

    const hasHorizontalOverflow = container.scrollWidth > container.clientWidth
    if (!hasHorizontalOverflow) {
      return
    }

    const primarilyVerticalWheel = Math.abs(event.deltaY) > Math.abs(event.deltaX)
    if (!primarilyVerticalWheel || event.deltaY === 0) {
      return
    }

    event.preventDefault()
    container.scrollBy({
      left: event.deltaY,
      behavior: 'smooth',
    })
  }, [])

  // B2: 'all' 与缺省都视为"不显示 chip"
  const showTimeChip = !!timeRange && timeRange !== 'all'
  const hasRealSources = sources.length > 0
  // 没有 sources 也没有 searching 状态时，整体不渲染（保持原行为）
  if (!hasRealSources && !searching) {
    return null
  }

  return (
    <div className={cn('mt-3 min-w-0 space-y-2', className)}>
      <div className="flex flex-wrap items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground/70">
        <Globe className="h-3 w-3" />
        <span>搜索来源</span>
        {hasRealSources && (
          <span className="text-[10px] normal-case tracking-normal text-muted-foreground/50">
            ({sources.length})
          </span>
        )}

        {/* [BEL-81.B] time range chip — 后端透传的时间范围标签 */}
        {showTimeChip && (
          <span
            data-testid="search-time-range-chip"
            className="inline-flex items-center gap-1 rounded-full border border-blue-400/20 bg-blue-500/10 px-2 py-0.5 text-[10px] font-medium tracking-normal text-blue-300"
          >
            <Clock className="size-2.5" />
            {TIME_RANGE_LABEL[timeRange as SearchTimeRange]}
          </span>
        )}

        {/* 真实搜索词（可选） */}
        {hasRealSources && query && (
          <span className="truncate text-[10px] normal-case tracking-normal text-muted-foreground/50 max-w-[160px]">
            “{query}”
          </span>
        )}
      </div>

      <div
        ref={scrollRef}
        onWheel={handleWheelScroll}
        // B3 横向 snap：x mandatory 让卡片停靠位置对齐卡片边缘
        className="w-full min-w-0 overflow-x-auto overflow-y-hidden overscroll-x-contain pb-1 touch-pan-x [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        style={{ scrollSnapType: 'x mandatory' }}
      >
        <div className="inline-flex min-w-max gap-3 pr-1">
          {/* [BEL-81.B] tool_searching 阶段渲染 1–2 张骨架卡占位，避免布局抖动 */}
          {searching && !hasRealSources && (
            <>
              <SearchSourceSkeleton index={0} />
              <SearchSourceSkeleton index={1} />
            </>
          )}

          {hasRealSources &&
            sources.map((source, index) => {
              const faviconUrl = getFaviconUrlDirect(source.url, source.favicon)
              return (
                <a
                  key={`${source.url || source.title || 'source'}-${index}`}
                  href={source.url || '#'}
                  target="_blank"
                  rel="noreferrer"
                  // B1 深色化 + B3 入场动画 + snap
                  style={{
                    animationDelay: `${index * 40}ms`,
                    scrollSnapAlign: 'start',
                  }}
                  className="group relative block w-[240px] shrink-0 rounded-2xl border border-white/[0.08] bg-white/[0.04] backdrop-blur-sm p-3 transition-[border-color,background-color,box-shadow] duration-200 hover:border-blue-400/30 hover:bg-white/[0.06] hover:shadow-[0_8px_22px_rgba(0,0,0,0.35)] animate-fade-in-up"
                >
                  <div className="flex items-start gap-2.5">
                    {faviconUrl ? (
                      <Image
                        src={faviconUrl}
                        alt=""
                        width={18}
                        height={18}
                        className="mt-0.5 h-[18px] w-[18px] shrink-0 rounded-md"
                        unoptimized
                        onError={(e) => {
                          const currentSrc = e.currentTarget.src
                          if (currentSrc.includes('google.com/s2/favicons')) {
                            e.currentTarget.style.display = 'none'
                          } else {
                            e.currentTarget.src = getFaviconUrl(source.url, source.favicon) || ''
                          }
                        }}
                      />
                    ) : (
                      <Globe className="mt-0.5 h-[18px] w-[18px] shrink-0 text-muted-foreground/60" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-2 text-[13px] font-semibold leading-5 text-foreground/95">
                        {source.title || '未命名'}
                      </p>
                      <p className="mt-1 truncate text-[11px] leading-4 text-muted-foreground/70">
                        {source.domain || '未知来源'}
                      </p>
                    </div>
                  </div>
                  {source.snippet && (
                    <p className="mt-2 line-clamp-4 break-words text-[11px] leading-5 text-muted-foreground/80">
                      {source.snippet}
                    </p>
                  )}
                </a>
              )
            })}
        </div>
      </div>
    </div>
  )
}

/** [BEL-81.B] 骨架卡 — `tool_searching → sources` 之间的占位 */
function SearchSourceSkeleton({ index }: { index: number }) {
  return (
    <div
      style={{
        animationDelay: `${index * 80}ms`,
        scrollSnapAlign: 'start',
      }}
      className="block w-[240px] shrink-0 rounded-2xl border border-white/[0.06] bg-white/[0.04] p-3 animate-pulse"
    >
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 size-[18px] shrink-0 rounded-md bg-white/[0.08]" />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="h-3 w-3/4 rounded bg-white/[0.08]" />
          <div className="h-2.5 w-1/2 rounded bg-white/[0.06]" />
        </div>
      </div>
      <div className="mt-3 space-y-1.5">
        <div className="h-2.5 w-full rounded bg-white/[0.06]" />
        <div className="h-2.5 w-5/6 rounded bg-white/[0.06]" />
        <div className="h-2.5 w-2/3 rounded bg-white/[0.06]" />
      </div>
    </div>
  )
}
