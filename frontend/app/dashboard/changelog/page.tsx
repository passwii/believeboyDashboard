import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ChangelogEntry, ChangelogType, getChangelogEntries } from '@/lib/server/changelog'
import { cn } from '@/lib/utils'
import { CalendarDays, GitBranch, GitCommitHorizontal } from 'lucide-react'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type ChangelogDay = {
  date: string
  entries: ChangelogEntry[]
}

function formatDateLabel(dateValue: string): string {
  const date = new Date(`${dateValue}T00:00:00`)
  if (Number.isNaN(date.getTime())) return dateValue

  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }).format(date)
}

function typeLabel(type: ChangelogType): string {
  if (type === 'feature') return '功能'
  if (type === 'fix') return '修复'
  if (type === 'docs') return '文档'
  if (type === 'chore') return '维护'
  if (type === 'merge') return '合并'
  return '更新'
}

function typeStyle(type: ChangelogType): string {
  if (type === 'feature') return 'border-cyan-500/35 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300'
  if (type === 'fix') return 'border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300'
  if (type === 'docs') return 'border-violet-500/35 bg-violet-500/10 text-violet-700 dark:text-violet-300'
  if (type === 'chore') return 'border-slate-500/35 bg-slate-500/10 text-slate-700 dark:text-slate-300'
  if (type === 'merge') return 'border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
  return 'border-border/70 bg-muted/40 text-muted-foreground'
}

function groupByDate(entries: ChangelogEntry[]): ChangelogDay[] {
  const dayMap = new Map<string, ChangelogEntry[]>()

  for (const entry of entries) {
    const bucket = dayMap.get(entry.date)
    if (bucket) {
      bucket.push(entry)
      continue
    }
    dayMap.set(entry.date, [entry])
  }

  return Array.from(dayMap.entries()).map(([date, dayEntries]) => ({
    date,
    entries: dayEntries,
  }))
}

export default function ChangelogPage() {
  const { entries, error } = getChangelogEntries(160)
  const groupedEntries = groupByDate(entries)

  return (
    <div className="space-y-6 md:space-y-7">
      <section className="dashboard-surface animate-enter px-5 py-5 md:px-7 md:py-7 dark:border-border/80 dark:bg-[hsl(var(--surface-panel))]">
        <div className="relative z-10 space-y-4">
          <Badge variant="secondary" className="inline-flex h-7 items-center gap-1 rounded-full px-3 text-[11px] font-medium uppercase tracking-[0.14em]">
            <GitBranch className="h-3.5 w-3.5" />
            Git History
          </Badge>
          <div className="space-y-2">
            <h2 className="text-xl font-semibold tracking-tight md:text-2xl">更新日志</h2>
            <p className="max-w-3xl text-sm leading-6 text-muted-foreground md:text-base">
              自动读取仓库提交记录，按日期整理每次更新内容。页面数据会随着新的 Git 提交自动更新。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1.5 rounded-md border border-border/70 bg-background/80 px-2.5 py-1.5">
              <GitCommitHorizontal className="h-3.5 w-3.5" />
              共 {entries.length} 次提交
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-md border border-border/70 bg-background/80 px-2.5 py-1.5">
              <CalendarDays className="h-3.5 w-3.5" />
              覆盖 {groupedEntries.length} 天
            </span>
          </div>
        </div>
      </section>

      {error ? (
        <Card className="border-destructive/40 bg-destructive/5 dark:border-destructive/30 dark:bg-destructive/12">
          <CardContent className="p-4 text-sm text-destructive">{error}</CardContent>
        </Card>
      ) : null}

      {groupedEntries.map((day) => (
        <Card key={day.date} className="dashboard-surface animate-enter dark:border-border/80 dark:bg-[hsl(var(--surface-panel))]">
          <CardHeader className="relative z-10 gap-2 md:flex-row md:items-center md:justify-between">
            <div>
              <CardTitle className="text-lg md:text-xl">{formatDateLabel(day.date)}</CardTitle>
              <CardDescription>{day.entries.length} 次提交更新</CardDescription>
            </div>
            <Badge variant="outline" className="w-fit tabular-nums">
              {day.date}
            </Badge>
          </CardHeader>
          <CardContent className="relative z-10 space-y-3">
            {day.entries.map((entry) => (
              <article
                key={entry.hash}
                className="rounded-xl border border-border/70 bg-background/75 p-3 transition-colors hover:border-primary/35 dark:border-border/80 dark:bg-[hsl(var(--surface-soft))] dark:hover:border-primary/30"
              >
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge variant="outline" className="font-mono">
                    {entry.shortHash}
                  </Badge>
                  <Badge variant="outline" className={cn('font-medium', typeStyle(entry.type))}>
                    {typeLabel(entry.type)}
                  </Badge>
                </div>
                <p className="mt-2 text-sm leading-6 text-foreground md:text-[15px]">{entry.subject}</p>
              </article>
            ))}
          </CardContent>
        </Card>
      ))}

      {!error && groupedEntries.length === 0 ? (
        <Card className="dark:border-border/80 dark:bg-[hsl(var(--surface-panel))]">
          <CardContent className="p-5 text-sm text-muted-foreground">暂未读取到提交记录。</CardContent>
        </Card>
      ) : null}
    </div>
  )
}
