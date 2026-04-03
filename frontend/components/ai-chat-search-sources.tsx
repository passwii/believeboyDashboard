'use client'

import { ExternalLink, Globe } from 'lucide-react'

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

export function AIChatSearchSources({ sources, className }: AIChatSearchSourcesProps) {
  if (!sources.length) {
    return null
  }

  return (
    <div className={cn('mt-4 space-y-2', className)}>
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
        <Globe className="h-3.5 w-3.5" />
        <span>搜索来源</span>
      </div>
      <div className="-mx-6 flex gap-2 overflow-x-auto px-6 pb-1 scrollbar-hide">
        {sources.map((source, index) => {
          const faviconUrl = getFaviconUrl(source.url, source.favicon)
          return (
            <a
              key={`${source.url || source.title || 'source'}-${index}`}
              href={source.url || '#'}
              target="_blank"
              rel="noreferrer"
              className="group relative min-w-[200px] max-w-[200px] shrink-0 rounded-xl border border-surface-outline/80 bg-surface-panel/90 p-2.5 transition hover:border-surface-outline hover:bg-surface-panel"
            >
              <div className="flex items-start gap-2">
                {faviconUrl ? (
                  <img
                    src={faviconUrl}
                    alt=""
                    className="mt-0.5 h-4 w-4 shrink-0 rounded-sm"
                    onError={(e) => {
                      e.currentTarget.style.display = 'none'
                    }}
                  />
                ) : (
                  <Globe className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-1 text-[11px] font-semibold leading-4 text-foreground">{source.title || '未命名结果'}</p>
                  <p className="mt-0.5 truncate text-[10px] leading-3 text-muted-foreground">{source.domain || source.url || '未知来源'}</p>
                </div>
                <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground transition group-hover:text-foreground" />
              </div>
              {source.snippet ? (
                <p className="mt-1.5 line-clamp-2 text-[10px] leading-3.5 text-muted-foreground">{source.snippet}</p>
              ) : null}
              {formatScore(source.score) ? (
                <span className="absolute right-1.5 top-1.5 rounded-full bg-surface-subtle px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground">
                  {formatScore(source.score)}
                </span>
              ) : null}
            </a>
          )
        })}
      </div>
    </div>
  )
}
