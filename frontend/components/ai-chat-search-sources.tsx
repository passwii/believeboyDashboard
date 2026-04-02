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
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-slate-400">
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
              className="group relative min-w-[200px] max-w-[200px] shrink-0 rounded-xl border border-slate-200 bg-white/90 p-2.5 transition hover:border-slate-300 hover:bg-white"
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
                  <Globe className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-1 text-[11px] font-semibold leading-4 text-slate-900">{source.title || '未命名结果'}</p>
                  <p className="mt-0.5 truncate text-[10px] leading-3 text-slate-500">{source.domain || source.url || '未知来源'}</p>
                </div>
                <ExternalLink className="h-3 w-3 shrink-0 text-slate-400 transition group-hover:text-slate-700" />
              </div>
              {source.snippet ? (
                <p className="mt-1.5 line-clamp-2 text-[10px] leading-3.5 text-slate-600">{source.snippet}</p>
              ) : null}
              {formatScore(source.score) ? (
                <span className="absolute right-1.5 top-1.5 rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-medium text-slate-600">
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
