import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { getChangelogSnapshot, ReleaseStatus, ReleaseVersion } from '@/lib/server/changelog'
import { cn } from '@/lib/utils'
import {
  ArrowUpRight,
  Blocks,
  Layers3,
  Waypoints,
} from 'lucide-react'

function formatDateLabel(dateValue: string): string {
  const date = new Date(`${dateValue}T00:00:00`)
  if (Number.isNaN(date.getTime())) return dateValue

  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
  }).format(date)
}

function formatFullDate(dateValue: string): string {
  const date = new Date(`${dateValue}T00:00:00`)
  if (Number.isNaN(date.getTime())) return dateValue

  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(date)
}

function formatDateRange(release: ReleaseVersion): string {
  if (release.status === 'current') {
    return `${formatDateLabel(release.startDate)} - 至今`
  }

  return `${formatDateLabel(release.startDate)} - ${formatDateLabel(release.endDate)}`
}

function statusLabel(status: ReleaseStatus): string {
  if (status === 'current') return '当前版本'
  if (status === 'stable') return '稳定版本'
  return '历史版本'
}

function statusStyle(status: ReleaseStatus): string {
  if (status === 'current') {
    return 'border-emerald-500/30 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300'
  }
  if (status === 'stable') {
    return 'border-cyan-500/30 bg-cyan-500/12 text-cyan-700 dark:text-cyan-300'
  }
  return 'border-border/70 bg-background/80 text-muted-foreground dark:border-border/90 dark:bg-[hsl(var(--surface-soft)/0.88)]'
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
  const { releases, currentRelease, stats } = snapshot
  const releasesDesc = [...releases].reverse()

  return (
    <div className="space-y-6 md:space-y-7">
      <section className="dashboard-surface relative overflow-hidden px-5 py-5 md:px-7 md:py-7 dark:border-border/80 dark:bg-[hsl(var(--surface-panel))]">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(59,130,246,0.20),transparent_28%),radial-gradient(circle_at_85%_18%,rgba(249,115,22,0.16),transparent_22%),linear-gradient(135deg,rgba(255,255,255,0.02),transparent_58%)] dark:bg-[radial-gradient(circle_at_top_left,rgba(96,165,250,0.22),transparent_26%),radial-gradient(circle_at_82%_20%,rgba(249,115,22,0.16),transparent_20%),linear-gradient(135deg,rgba(255,255,255,0.04),transparent_58%)]" />
        <div className="relative z-10 space-y-5">
          <div className="space-y-5">
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">版本更新日志</h2>
                <span className="font-mono text-sm font-semibold text-primary">{currentRelease.version}</span>
              </div>
              <p className="max-w-3xl text-sm leading-6 text-muted-foreground md:text-base">
                聚焦系统在不同阶段完成的核心业务能力升级，方便快速查看每个版本带来的模块变化和使用价值。
              </p>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-2xl border border-border/70 bg-background/78 px-4 py-4 dark:border-border/90 dark:bg-[hsl(var(--surface-soft)/0.84)]">
                <div className="text-[0.72rem] uppercase tracking-[0.16em] text-muted-foreground">当前版本</div>
                <div className="mt-2 flex items-center gap-3">
                  <span className="font-mono text-xl font-semibold text-foreground">{currentRelease.version}</span>
                  <span className="text-sm text-muted-foreground">{currentRelease.codename}</span>
                </div>
              </div>
              <div className="rounded-2xl border border-border/70 bg-background/78 px-4 py-4 dark:border-border/90 dark:bg-[hsl(var(--surface-soft)/0.84)]">
                <div className="text-[0.72rem] uppercase tracking-[0.16em] text-muted-foreground">版本阶段</div>
                <div className="mt-2 text-sm leading-6 text-foreground">{formatDateRange(currentRelease)}</div>
              </div>
              <div className="rounded-2xl border border-border/70 bg-background/78 px-4 py-4 dark:border-border/90 dark:bg-[hsl(var(--surface-soft)/0.84)]">
                <div className="text-[0.72rem] uppercase tracking-[0.16em] text-muted-foreground">当前重点</div>
                <div className="mt-2 text-sm leading-6 text-foreground">{currentRelease.focus.slice(0, 3).join('、')}</div>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Card className="border-border/70 bg-background/78 shadow-none dark:border-border/90 dark:bg-[hsl(var(--surface-soft)/0.84)]">
                <CardContent className="p-4">
                  <div className="text-[0.72rem] uppercase tracking-[0.16em] text-muted-foreground">当前版本</div>
                  <div className="mt-2 text-2xl font-semibold tracking-tight">{currentRelease.version}</div>
                  <div className="mt-1 text-sm text-muted-foreground">{currentRelease.codename}</div>
                </CardContent>
              </Card>
              <Card className="border-border/70 bg-background/78 shadow-none dark:border-border/90 dark:bg-[hsl(var(--surface-soft)/0.84)]">
                <CardContent className="p-4">
                  <div className="text-[0.72rem] uppercase tracking-[0.16em] text-muted-foreground">大版本数</div>
                  <div className="mt-2 text-2xl font-semibold tracking-tight">{stats.versionCount}</div>
                  <div className="mt-1 text-sm text-muted-foreground">从 V1 归档到 V6</div>
                </CardContent>
              </Card>
              <Card className="border-border/70 bg-background/78 shadow-none dark:border-border/90 dark:bg-[hsl(var(--surface-soft)/0.84)]">
                <CardContent className="p-4">
                  <div className="text-[0.72rem] uppercase tracking-[0.16em] text-muted-foreground">模块覆盖</div>
                  <div className="mt-2 text-2xl font-semibold tracking-tight">{stats.moduleCount}</div>
                  <div className="mt-1 text-sm text-muted-foreground">按业务模块重新聚合</div>
                </CardContent>
              </Card>
              <Card className="border-border/70 bg-background/78 shadow-none dark:border-border/90 dark:bg-[hsl(var(--surface-soft)/0.84)]">
                <CardContent className="p-4">
                  <div className="text-[0.72rem] uppercase tracking-[0.16em] text-muted-foreground">历史线索</div>
                  <div className="mt-2 text-2xl font-semibold tracking-tight">{stats.logCount}</div>
                  <div className="mt-1 text-sm text-muted-foreground">来自已整理开发 log</div>
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      </section>

      <div className="grid gap-6 xl:grid-cols-[16.5rem_minmax(0,1fr)]">
        <aside className="space-y-4 xl:sticky xl:top-24 xl:self-start">
          <Card className="dark:border-border/80 dark:bg-[hsl(var(--surface-panel))]">
            <CardContent className="space-y-4 p-4">
              <div className="space-y-1">
                <div className="text-[0.72rem] uppercase tracking-[0.16em] text-muted-foreground">版本导航</div>
                <p className="text-sm leading-6 text-muted-foreground">按大版本查看关键能力建设与原始变更线索。</p>
              </div>
              <nav className="space-y-2" aria-label="Changelog release navigation">
                {releasesDesc.map((release) => (
                  <a
                    key={release.version}
                    href={`#${release.version.toLowerCase()}`}
                    className="group flex cursor-pointer items-center justify-between rounded-2xl border border-border/70 bg-background/72 px-3 py-3 transition-colors duration-200 hover:border-primary/35 hover:bg-primary/5 dark:border-border/90 dark:bg-[hsl(var(--surface-soft)/0.8)] dark:hover:border-primary/30 dark:hover:bg-primary/10"
                  >
                    <div className="min-w-0">
                      <div className="font-mono text-sm font-semibold text-foreground">{release.version}</div>
                      <div className="truncate text-xs text-muted-foreground">{formatDateRange(release)}</div>
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
            <section key={release.version} id={release.version.toLowerCase()} className="scroll-mt-24">
              <Card className="relative overflow-hidden dark:border-border/80 dark:bg-[hsl(var(--surface-panel))]">
                <div className={cn('pointer-events-none absolute inset-0 bg-gradient-to-br opacity-100', releaseAccents[index % releaseAccents.length])} />
                <div className="relative z-10 space-y-6 p-5 md:p-7">
                  <div className="flex flex-col gap-4 border-b border-border/70 pb-5 dark:border-border/80 md:flex-row md:items-start md:justify-between">
                    <div className="space-y-4">
                      <div className="space-y-2">
                        <div className="flex flex-wrap items-center gap-3">
                          <h3 className="text-2xl font-semibold tracking-tight">{release.version}</h3>
                          <span className="text-sm text-muted-foreground">{release.codename}</span>
                          <span className="text-sm text-muted-foreground">{formatDateRange(release)}</span>
                        </div>
                        <p className="max-w-4xl text-sm leading-6 text-muted-foreground md:text-[0.95rem]">{release.summary}</p>
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-3 sm:max-w-[24rem] sm:self-stretch">
                      <div className="rounded-2xl border border-border/70 bg-background/78 px-3 py-3 text-center dark:border-border/90 dark:bg-[hsl(var(--surface-soft)/0.84)]">
                        <div className="text-[0.68rem] uppercase tracking-[0.16em] text-muted-foreground">模块</div>
                        <div className="mt-2 text-lg font-semibold">{release.focus.length}</div>
                      </div>
                      <div className="rounded-2xl border border-border/70 bg-background/78 px-3 py-3 text-center dark:border-border/90 dark:bg-[hsl(var(--surface-soft)/0.84)]">
                        <div className="text-[0.68rem] uppercase tracking-[0.16em] text-muted-foreground">亮点</div>
                        <div className="mt-2 text-lg font-semibold">{release.highlights.length}</div>
                      </div>
                      <div className="rounded-2xl border border-border/70 bg-background/78 px-3 py-3 text-center dark:border-border/90 dark:bg-[hsl(var(--surface-soft)/0.84)]">
                        <div className="text-[0.68rem] uppercase tracking-[0.16em] text-muted-foreground">线索</div>
                        <div className="mt-2 text-lg font-semibold">{release.sourceLogs.length}</div>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {release.focus.map((item) => (
                      <span
                        key={item}
                        className="rounded-full border border-border/70 bg-background/70 px-3 py-1 text-[0.72rem] text-foreground/85 dark:border-border/90 dark:bg-[hsl(var(--surface-soft)/0.78)]"
                      >
                        {item}
                      </span>
                    ))}
                  </div>

                  <div className="grid gap-3 xl:grid-cols-2">
                    {release.highlights.map((highlight) => (
                      <article
                        key={`${release.version}-${highlight.title}`}
                        className="rounded-[1.35rem] border border-border/70 bg-background/78 p-4 transition-colors duration-200 hover:border-primary/30 dark:border-border/90 dark:bg-[hsl(var(--surface-soft)/0.84)] dark:hover:border-primary/30"
                      >
                        <div className="flex items-start gap-3">
                          <div className="mt-0.5 rounded-2xl border border-primary/15 bg-primary/10 p-2 text-primary dark:border-primary/20 dark:bg-primary/12">
                            <Layers3 className="h-4 w-4" />
                          </div>
                          <div className="min-w-0 space-y-2">
                            <div className="space-y-1">
                              <div className="text-[0.72rem] uppercase tracking-[0.14em] text-muted-foreground">{highlight.area}</div>
                              <h4 className="text-base font-semibold tracking-tight text-foreground">{highlight.title}</h4>
                            </div>
                            <p className="text-sm leading-6 text-muted-foreground">{highlight.detail}</p>
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>

                  <div className="grid gap-4 border-t border-border/70 pt-5 dark:border-border/80 lg:grid-cols-[minmax(0,0.82fr)_minmax(17rem,0.55fr)]">
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                        <Waypoints className="h-4 w-4 text-primary" />
                        原始 log 线索
                      </div>
                      <div className="rounded-3xl border border-dashed border-border/70 bg-background/56 p-4 dark:border-border/90 dark:bg-[hsl(var(--surface-panel)/0.52)]">
                        <ul className="space-y-2 text-sm leading-6 text-muted-foreground">
                          {release.sourceLogs.map((log) => (
                            <li key={`${release.version}-${log}`} className="flex gap-2">
                              <span className="mt-[0.72rem] h-1.5 w-1.5 shrink-0 rounded-full bg-primary/70" />
                              <span>{log}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>

                    <div className="space-y-3">
                      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                        <Blocks className="h-4 w-4 text-primary" />
                        版本定位
                      </div>
                      <div className="rounded-3xl border border-border/70 bg-background/72 p-4 dark:border-border/90 dark:bg-[hsl(var(--surface-soft)/0.8)]">
                        <p className="text-sm leading-6 text-muted-foreground">
                          {release.version}
                          {' '}
                          主要聚焦
                          {' '}
                          <span className="font-medium text-foreground">{release.focus.slice(0, 2).join('、')}</span>
                          ，并向
                          {' '}
                          <span className="font-medium text-foreground">{release.focus.slice(2).join('、') || '相关体验优化'}</span>
                          {' '}
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
