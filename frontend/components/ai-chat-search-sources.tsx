'use client'

import { useCallback, useRef } from 'react'
import { Globe } from 'lucide-react'
import Image from 'next/image'

import { cn } from '@/lib/utils'

type SearchSource = {
  title?: string
  url?: string
  snippet?: string
  domain?: string
  score?: number | null
  favicon?: string | null
}

type AIChatSearchSourcesProps = {
  sources: SearchSource[]
  className?: string
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

export function AIChatSearchSources({ sources, className }: AIChatSearchSourcesProps) {
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

  if (!sources.length) {
    return null
  }

  return (
    <div className={cn('mt-3 min-w-0 space-y-2', className)}>
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground/70">
        <Globe className="h-3 w-3" />
        <span>搜索来源</span>
        <span className="text-[10px] normal-case tracking-normal text-muted-foreground/50">({sources.length})</span>
      </div>
      <div
        ref={scrollRef}
        onWheel={handleWheelScroll}
        className="w-full min-w-0 overflow-x-auto overflow-y-hidden overscroll-x-contain pb-1 touch-pan-x [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <div className="inline-flex min-w-max gap-3 pr-1">
          {sources.map((source, index) => {
            const faviconUrl = getFaviconUrlDirect(source.url, source.favicon)
            return (
              <a
                key={`${source.url || source.title || 'source'}-${index}`}
                href={source.url || '#'}
                target="_blank"
                rel="noreferrer"
                className="group relative block w-[240px] shrink-0 rounded-2xl border border-surface-outline/60 bg-gradient-to-br from-surface-panel via-surface-subtle/90 to-surface-subtle/70 p-3 shadow-[0_10px_24px_rgba(15,23,42,0.08)] dark:shadow-[0_10px_24px_rgba(0,0,0,0.3)] transition-[border-color,background-color,box-shadow] duration-200 hover:border-primary/25 hover:bg-slate-50/90 dark:hover:bg-[hsl(var(--surface-subtle)/0.8)] dark:hover:shadow-[0_14px_30px_rgba(0,0,0,0.35)]"
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
                    <p className="line-clamp-2 text-[13px] font-semibold leading-5 text-foreground/95">{source.title || '未命名'}</p>
                    <p className="mt-1 truncate text-[11px] leading-4 text-muted-foreground/70">{source.domain || '未知来源'}</p>
                  </div>
                </div>
                {source.snippet && (
                  <p className="mt-2 line-clamp-4 break-words text-[11px] leading-5 text-muted-foreground/80">{source.snippet}</p>
                )}
              </a>
            )
          })}
        </div>
      </div>
    </div>
  )
}
