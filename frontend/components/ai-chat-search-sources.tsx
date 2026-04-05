'use client'

import { ExternalLink, Globe } from 'lucide-react'
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

function formatScore(score?: number | null) {
  if (typeof score !== 'number' || Number.isNaN(score)) {
    return ''
  }
  return `${Math.round(score * 100)}%`
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
  if (!sources.length) {
    return null
  }

  return (
    <div className={cn('mt-3 space-y-2', className)}>
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground/70">
        <Globe className="h-3 w-3" />
        <span>搜索来源</span>
        <span className="text-[10px] normal-case tracking-normal text-muted-foreground/50">({sources.length})</span>
      </div>
      <div className="w-full overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="flex gap-2">
          {sources.map((source, index) => {
            const faviconUrl = getFaviconUrlDirect(source.url, source.favicon)
            return (
              <a
                key={`${source.url || source.title || 'source'}-${index}`}
                href={source.url || '#'}
                target="_blank"
                rel="noreferrer"
                className="group relative shrink-0 rounded-lg border border-surface-outline/60 bg-surface-subtle/80 p-2 transition-colors hover:bg-surface-panel/90 hover:border-surface-outline/80 min-w-[160px] max-w-[160px]"
              >
                <div className="flex items-start gap-1.5">
                  {faviconUrl ? (
                    <Image
                      src={faviconUrl}
                      alt=""
                      width={14}
                      height={14}
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded-sm"
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
                    <Globe className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[10px] font-medium leading-3.5 text-foreground/90">{source.title || '未命名'}</p>
                    <p className="truncate text-[9px] leading-3 text-muted-foreground/60">{source.domain || '未知来源'}</p>
                  </div>
                </div>
                {source.snippet && (
                  <p className="mt-1 line-clamp-2 text-[9px] leading-3 text-muted-foreground/70">{source.snippet}</p>
                )}
              </a>
            )
          })}
        </div>
      </div>
    </div>
  )
}
