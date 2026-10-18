'use client'

import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { getChangelogSnapshot, ReleaseVersion } from '@/lib/server/changelog'
import { cn } from '@/lib/utils'
import { ArrowUpRight, ChevronDown, Waypoints } from 'lucide-react'
import { TermPanel } from '@/components/terminal/term-panel'

function formatDateLabel(dateValue: string): string {
  const date = new Date(`${dateValue}T00:00:00`)
  if (Number.isNaN(date.getTime())) return dateValue

  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
  }).format(date)
}

function formatDateRange(release: ReleaseVersion): string {
  if (!release.endDate || release.status === 'current') {
    return `${formatDateLabel(release.startDate)} - 至今`
  }

  return `${formatDateLabel(release.startDate)} - ${formatDateLabel(release.endDate)}`
}

function SourceLogsSection({ logs }: { logs: string[] }) {
  const [isExpanded, setIsExpanded] = useState(false)

  if (logs.length === 0) return null

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center gap-2 font-mono text-xs text-term-muted transition-colors hover:text-term-text"
      >
        <Waypoints className="h-4 w-4 text-term-accent" strokeWidth={1.75} />
        <span>原始 log 线索</span>
        <Badge variant="secondary" className="ml-1 rounded-none border-term-border bg-term-bg font-mono text-[10px] text-term-faint">
          {logs.length}
        </Badge>
        <ChevronDown
          className={cn(
            'ml-auto h-4 w-4 text-term-faint transition-transform duration-[var(--duration-fast)]',
            isExpanded && 'rotate-180'
          )}
          strokeWidth={1.75}
        />
      </button>
      <div
        className={cn(
          'overflow-hidden rounded-none border border-dashed border-term-border bg-term-bg transition-all duration-[var(--duration-fast)]',
          isExpanded ? 'max-h-[500px] opacity-100' : 'max-h-0 opacity-0'
        )}
      >
        <ul className="space-y-2 p-4">
          {logs.map((log) => (
            <li key={log} className="flex gap-2">
              <span className="mt-[0.72rem] h-1.5 w-1.5 shrink-0 rounded-none bg-term-accent" />
              <span className="break-all font-mono text-[0.8rem] text-term-muted">{log}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

export default function ChangelogPage() {
  const snapshot = getChangelogSnapshot()
  const { releases } = snapshot
  const releasesDesc = [...releases].reverse()

  return (
    // BLF-838：渐变彩卡 → 终端面板；页面标题由面包屑承载
    <div className="flex min-w-0 flex-col gap-3">
      <div className="grid gap-3 lg:grid-cols-[16.5rem_minmax(0,1fr)] lg:items-start">
        <aside className="lg:sticky lg:top-0 lg:self-start">
          <TermPanel title="版本导航" className="flex flex-col overflow-hidden lg:max-h-[calc(100dvh-6.5rem)]" bodyClassName="overflow-y-auto p-3 term-scroll">
            <p className="mb-3 font-sans text-xs leading-5 text-term-faint">
              按大版本查看关键能力建设与原始变更线索。
            </p>
            <nav className="space-y-1.5" aria-label="Changelog release navigation">
              {releasesDesc.map((release) => (
                <a
                  key={release.version}
                  href={`#${release.version.toLowerCase()}`}
                  className="group flex cursor-pointer items-center justify-between rounded-none border border-term-border bg-term-bg px-2 py-2 transition-colors hover:border-term-border-strong hover:bg-term-hover"
                >
                  <div className="min-w-0">
                    <div className="font-mono text-sm font-semibold tabular-nums text-term-text">
                      {release.version}
                    </div>
                    <div className="truncate font-mono text-[11px] tabular-nums text-term-faint">
                      {formatDateRange(release)}
                    </div>
                  </div>
                  <ArrowUpRight
                    className="h-4 w-4 shrink-0 text-term-faint transition-transform duration-[var(--duration-quick)] group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-term-text"
                    strokeWidth={1.75}
                  />
                </a>
              ))}
            </nav>
          </TermPanel>
        </aside>

        <div className="min-w-0 space-y-3">
          {releasesDesc.map((release) => (
            <section
              key={release.version}
              id={release.version.toLowerCase()}
              className="scroll-mt-2"
            >
              <TermPanel bodyClassName="p-4">
                <div className="flex flex-col gap-3 border-b border-term-border pb-4 md:flex-row md:items-start md:justify-between">
                  <div className="min-w-0 space-y-2">
                    <div className="flex flex-wrap items-center gap-3">
                      <h3 className="font-mono text-lg font-semibold tabular-nums tracking-tight text-term-text">
                        {release.version}
                      </h3>
                      <span className="text-sm text-term-muted">{release.codename}</span>
                      <span className="font-mono text-xs tabular-nums text-term-faint">
                        {formatDateRange(release)}
                      </span>
                    </div>
                    <p className="max-w-4xl text-sm leading-6 text-term-muted">{release.summary}</p>
                  </div>
                  <div className="grid grid-cols-3 gap-2 sm:max-w-[24rem] sm:self-stretch">
                    <div className="rounded-none border border-term-border bg-term-bg px-2 py-2 text-center">
                      <div className="font-mono text-[11px] uppercase tracking-wider text-term-faint">模块</div>
                      <div className="mt-1 font-mono text-base font-semibold tabular-nums text-term-text">{release.focus.length}</div>
                    </div>
                    <div className="rounded-none border border-term-border bg-term-bg px-2 py-2 text-center">
                      <div className="font-mono text-[11px] uppercase tracking-wider text-term-faint">亮点</div>
                      <div className="mt-1 font-mono text-base font-semibold tabular-nums text-term-text">{release.highlights.length}</div>
                    </div>
                    <div className="rounded-none border border-term-border bg-term-bg px-2 py-2 text-center">
                      <div className="font-mono text-[11px] uppercase tracking-wider text-term-faint">线索</div>
                      <div className="mt-1 font-mono text-base font-semibold tabular-nums text-term-text">{release.sourceLogs.length}</div>
                    </div>
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap gap-1.5">
                  {release.focus.map((item) => (
                    <span
                      key={item}
                      className="rounded-none border border-term-border bg-term-bg px-2 py-0.5 font-mono text-[11px] text-term-muted"
                    >
                      {item}
                    </span>
                  ))}
                </div>

                <div className="mt-4 grid gap-2 lg:grid-cols-2">
                  {release.highlights.map((highlight) => (
                    <article
                      key={`${release.version}-${highlight.title}`}
                      className="group rounded-none border border-term-border bg-term-bg p-3 transition-colors hover:border-term-border-strong"
                    >
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5 rounded-none border border-term-border bg-term-raised p-1.5 text-term-accent">
                          {/* icon 由原 Layers3 改为统一 term 边框块 */}
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className="h-4 w-4" aria-hidden>
                            <path d="M12 2 2 7l10 5 10-5-10-5Z" strokeLinecap="round" strokeLinejoin="round" />
                            <path d="m2 17 10 5 10-5" strokeLinecap="round" strokeLinejoin="round" />
                            <path d="m2 12 10 5 10-5" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </div>
                        <div className="min-w-0 space-y-1.5">
                          <div className="space-y-0.5">
                            <div className="font-mono text-[11px] uppercase tracking-wider text-term-faint">
                              {highlight.area}
                            </div>
                            <h4 className="text-sm font-semibold text-term-text">{highlight.title}</h4>
                          </div>
                          <p className="text-sm leading-6 text-term-muted">{highlight.detail}</p>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>

                <div className="mt-4 grid gap-4 border-t border-term-border pt-4 lg:grid-cols-[minmax(0,0.82fr)_minmax(17rem,0.55fr)]">
                  <SourceLogsSection logs={release.sourceLogs} />

                  <div className="space-y-2">
                    <div className="flex items-center gap-2 font-mono text-xs text-term-muted">
                      版本定位
                    </div>
                    <div className="rounded-none border border-term-border bg-term-bg p-3">
                      <p className="text-sm leading-6 text-term-muted">
                        {release.version} 主要聚焦{' '}
                        <span className="font-medium text-term-text">
                          {release.focus.slice(0, 2).join('、')}
                        </span>
                        ，并向{' '}
                        <span className="font-medium text-term-text">
                          {release.focus.slice(2).join('、') || '相关体验优化'}
                        </span>{' '}
                        延展，代表这一阶段最完整的一次能力打包。
                      </p>
                    </div>
                  </div>
                </div>
              </TermPanel>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
