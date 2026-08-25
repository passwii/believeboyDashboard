'use client'

import { useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/ui/page-header'
import { getChangelogSnapshot, ReleaseVersion } from '@/lib/server/changelog'
import { cn } from '@/lib/utils'
import { ArrowUpRight, Blocks, ChevronDown, Layers3, Waypoints } from 'lucide-react'

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
        className="flex w-full items-center gap-2 text-sm font-medium text-foreground transition-colors hover:text-primary"
      >
        <Waypoints className="h-4 w-4 text-primary" />
        <span>原始 log 线索</span>
        <Badge variant="secondary" className="ml-1 rounded-full px-1.5 py-0.5 text-[0.65rem]">
          {logs.length}
        </Badge>
        <ChevronDown
          className={cn(
            'ml-auto h-4 w-4 text-muted-foreground transition-transform duration-200',
            isExpanded && 'rotate-180'
          )}
        />
      </button>
      <div
        className={cn(
          'overflow-hidden rounded-xl border border-dashed border-border/70 bg-[hsl(var(--surface-soft)/0.8)] transition-all duration-300',
          isExpanded ? 'max-h-[500px] opacity-100' : 'max-h-0 opacity-0'
        )}
      >
        <ul className="space-y-2 p-4 text-sm leading-6 text-muted-foreground">
          {logs.map((log) => (
            <li key={log} className="flex gap-2">
              <span className="mt-[0.72rem] h-1.5 w-1.5 shrink-0 rounded-full bg-primary/70" />
              <span className="break-all font-mono text-[0.8rem]">{log}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

const releaseAccents = [
  'from-sky-500/18 via-cyan-500/10 to-transparent',
  'from-indigo-500/18 via-sky-500/10 to-transparent',
  'from-violet-500/18 via-indigo-500/10 to-transparent',
  'from-amber-500/18 via-orange-500/10 to-transparent',
  'from-emerald-500/18 via-cyan-500/10 to-transparent',
  'from-fuchsia-500/16 via-sky-500/10 to-transparent',
]

export default function ChangelogPage() {
  const snapshot = getChangelogSnapshot()
  const { releases } = snapshot
  const releasesDesc = [...releases].reverse()

  return (
    <div className="space-y-6 md:space-y-7">
      {/* ── 页面头部：标题 + 描述（BLF-505：收口为 PageHeader 原语 §8.1） ── */}
      <PageHeader
        title="更新日志"
        description="记录 Dashboard 各版本的关键能力建设与原始变更线索。"
      />

      <div className="grid gap-6 lg:grid-cols-[16.5rem_minmax(0,1fr)]">
        <aside className="space-y-4 lg:sticky lg:top-24 lg:self-start">
          <Card className="dashboard-surface">
            <CardContent className="space-y-4 p-4">
              <div className="space-y-1">
                <div className="text-[0.72rem] uppercase tracking-[0.16em] text-muted-foreground">
                  版本导航
                </div>
                <p className="text-sm leading-6 text-muted-foreground">
                  按大版本查看关键能力建设与原始变更线索。
                </p>
              </div>
              <nav className="space-y-2" aria-label="Changelog release navigation">
                {releasesDesc.map((release) => (
                  <a
                    key={release.version}
                    href={`#${release.version.toLowerCase()}`}
                    className="group flex cursor-pointer items-center justify-between rounded-lg border border-border/70 bg-[hsl(var(--surface-soft)/0.85)] px-3 py-3 transition-colors duration-200 hover:border-primary/35 hover:bg-primary/5"
                  >
                    <div className="min-w-0">
                      <div className="font-mono text-sm font-semibold text-foreground">
                        {release.version}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {formatDateRange(release)}
                      </div>
                    </div>
                    <ArrowUpRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-foreground" />
                  </a>
                ))}
              </nav>
            </CardContent>
          </Card>
        </aside>

        <div className="space-y-5">
          {releasesDesc.map((release, index) => (
            <section
              key={release.version}
              id={release.version.toLowerCase()}
              className="scroll-mt-24"
            >
              <Card className="dashboard-surface relative overflow-hidden">
                <div
                  className={cn(
                    'pointer-events-none absolute inset-0 bg-gradient-to-br opacity-100',
                    releaseAccents[index % releaseAccents.length]
                  )}
                />
                <div className="relative z-10 space-y-6 p-5 md:p-7">
                  <div className="flex flex-col gap-4 border-b border-border/70 pb-5 dark:border-border/80 md:flex-row md:items-start md:justify-between">
                    <div className="space-y-4">
                      <div className="space-y-2">
                        <div className="flex flex-wrap items-center gap-3">
                          <h3 className="text-2xl font-semibold tracking-tight">
                            {release.version}
                          </h3>
                          <span className="text-sm text-muted-foreground">{release.codename}</span>
                          <span className="text-sm text-muted-foreground">
                            {formatDateRange(release)}
                          </span>
                        </div>
                        <p className="max-w-4xl text-sm leading-6 text-muted-foreground md:text-[0.95rem]">
                          {release.summary}
                        </p>
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-3 sm:max-w-[24rem] sm:self-stretch">
                      <div className="rounded-lg border border-border/70 bg-[hsl(var(--surface-soft)/0.85)] px-3 py-3 text-center">
                        <div className="text-[0.68rem] uppercase tracking-[0.16em] text-muted-foreground">
                          模块
                        </div>
                        <div className="mt-2 text-lg font-semibold">{release.focus.length}</div>
                      </div>
                      <div className="rounded-lg border border-border/70 bg-[hsl(var(--surface-soft)/0.85)] px-3 py-3 text-center">
                        <div className="text-[0.68rem] uppercase tracking-[0.16em] text-muted-foreground">
                          亮点
                        </div>
                        <div className="mt-2 text-lg font-semibold">
                          {release.highlights.length}
                        </div>
                      </div>
                      <div className="rounded-lg border border-border/70 bg-[hsl(var(--surface-soft)/0.85)] px-3 py-3 text-center">
                        <div className="text-[0.68rem] uppercase tracking-[0.16em] text-muted-foreground">
                          线索
                        </div>
                        <div className="mt-2 text-lg font-semibold">
                          {release.sourceLogs.length}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {release.focus.map((item) => (
                      <span
                        key={item}
                        className="rounded-full border border-border/70 bg-[hsl(var(--surface-soft)/0.8)] px-3 py-1 text-[0.72rem] text-foreground/85"
                      >
                        {item}
                      </span>
                    ))}
                  </div>

                  <div className="grid gap-3 lg:grid-cols-2">
                    {release.highlights.map((highlight) => (
                      <article
                        key={`${release.version}-${highlight.title}`}
                        className="rounded-xl border border-border/70 bg-[hsl(var(--surface-soft)/0.85)] p-4 transition-colors duration-200 hover:border-primary/30"
                      >
                        <div className="flex items-start gap-3">
                          <div className="mt-0.5 rounded-lg border border-primary/15 bg-primary/10 p-2 text-primary dark:border-primary/20 dark:bg-primary/12">
                            <Layers3 className="h-4 w-4" />
                          </div>
                          <div className="min-w-0 space-y-2">
                            <div className="space-y-1">
                              <div className="text-[0.72rem] uppercase tracking-[0.14em] text-muted-foreground">
                                {highlight.area}
                              </div>
                              <h4 className="text-base font-semibold tracking-tight text-foreground">
                                {highlight.title}
                              </h4>
                            </div>
                            <p className="text-sm leading-6 text-muted-foreground">
                              {highlight.detail}
                            </p>
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>

                  <div className="grid gap-4 border-t border-border/70 pt-5 dark:border-border/80 lg:grid-cols-[minmax(0,0.82fr)_minmax(17rem,0.55fr)]">
                    <SourceLogsSection logs={release.sourceLogs} />

                    <div className="space-y-3">
                      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                        <Blocks className="h-4 w-4 text-primary" />
                        版本定位
                      </div>
                      <div className="rounded-xl border border-border/70 bg-[hsl(var(--surface-soft)/0.85)] p-4">
                        <p className="text-sm leading-6 text-muted-foreground">
                          {release.version} 主要聚焦{' '}
                          <span className="font-medium text-foreground">
                            {release.focus.slice(0, 2).join('、')}
                          </span>
                          ，并向{' '}
                          <span className="font-medium text-foreground">
                            {release.focus.slice(2).join('、') || '相关体验优化'}
                          </span>{' '}
                          延展，代表这一阶段最完整的一次能力打包。
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </Card>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
