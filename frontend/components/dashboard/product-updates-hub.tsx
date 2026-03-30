'use client'

import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, ChevronDown, Clock3, MessageSquareText, PanelsTopLeft, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { ProductUpdate, getProductUpdatesSnapshot, markAllProductUpdatesSeen } from '@/lib/product-updates'

function formatDate(dateValue: string) {
  const date = new Date(`${dateValue}T00:00:00`)
  if (Number.isNaN(date.getTime())) return dateValue

  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(date)
}

const toneStyles: Record<ProductUpdate['tone'], string> = {
  workflow: 'from-cyan-500/18 via-sky-500/10 to-transparent',
  performance: 'from-amber-500/18 via-orange-500/12 to-transparent',
  insight: 'from-emerald-500/18 via-teal-500/10 to-transparent',
}

export function ProductUpdatesHub() {
  const snapshot = useMemo(() => getProductUpdatesSnapshot(), [])
  const [openUpdateId, setOpenUpdateId] = useState(snapshot.featuredUpdate.id)

  useEffect(() => {
    markAllProductUpdatesSeen()
  }, [])

  return (
    <div className="space-y-6 md:space-y-7">
      <section className="dashboard-surface relative overflow-hidden px-5 py-5 md:px-7 md:py-7 dark:border-border/80 dark:bg-[hsl(var(--surface-panel))]">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(14,116,144,0.22),transparent_28%),radial-gradient(circle_at_85%_15%,rgba(251,191,36,0.18),transparent_24%),linear-gradient(135deg,rgba(255,255,255,0.03),transparent_58%)]" />
        <div className="relative z-10 grid gap-6 xl:grid-cols-[minmax(0,1.05fr)_22rem]">
          <div className="space-y-5">
            <div className="space-y-3">
              <div className="inline-flex items-center gap-2 rounded-full border border-primary/18 bg-primary/10 px-3 py-1 text-[0.72rem] font-semibold uppercase tracking-[0.2em] text-primary">
                <Sparkles className="h-3.5 w-3.5" />
                面向用户的功能更新
              </div>
              <div className="space-y-2">
                <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">把更新做成可读、可看、可回访的产品入口</h2>
                <p className="max-w-3xl text-sm leading-6 text-muted-foreground md:text-base">
                  这里不再展示开发者版本 log，而是把每一次真正影响使用体验的变化翻译成用户看得懂的说明、细节和预览。
                </p>
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-3">
              <Card className="border-border/70 bg-background/78 shadow-none dark:border-border/90 dark:bg-[hsl(var(--surface-soft)/0.84)]">
                <CardContent className="p-4">
                  <div className="text-[0.72rem] uppercase tracking-[0.16em] text-muted-foreground">最近上新</div>
                  <div className="mt-2 text-lg font-semibold tracking-tight">{snapshot.latestUpdate.title}</div>
                  <div className="mt-1 text-sm text-muted-foreground">{formatDate(snapshot.latestUpdate.publishedAt)}</div>
                </CardContent>
              </Card>
              <Card className="border-border/70 bg-background/78 shadow-none dark:border-border/90 dark:bg-[hsl(var(--surface-soft)/0.84)]">
                <CardContent className="p-4">
                  <div className="text-[0.72rem] uppercase tracking-[0.16em] text-muted-foreground">功能条目</div>
                  <div className="mt-2 text-2xl font-semibold tracking-tight">{snapshot.stats.total}</div>
                  <div className="mt-1 text-sm text-muted-foreground">只收录用户真正感知得到的变化</div>
                </CardContent>
              </Card>
              <Card className="border-border/70 bg-background/78 shadow-none dark:border-border/90 dark:bg-[hsl(var(--surface-soft)/0.84)]">
                <CardContent className="p-4">
                  <div className="text-[0.72rem] uppercase tracking-[0.16em] text-muted-foreground">推荐阅读</div>
                  <div className="mt-2 text-2xl font-semibold tracking-tight">{snapshot.stats.featuredCount}</div>
                  <div className="mt-1 text-sm text-muted-foreground">右上角入口会优先提示最新一条</div>
                </CardContent>
              </Card>
            </div>
          </div>

          <aside className="rounded-[1.8rem] border border-border/70 bg-background/78 p-5 dark:border-border/90 dark:bg-[hsl(var(--surface-soft)/0.82)]">
            <div className="space-y-4">
              <div className="space-y-2">
                <div className="text-[0.72rem] uppercase tracking-[0.16em] text-muted-foreground">为什么单独做这个入口</div>
                <p className="text-sm leading-6 text-muted-foreground">
                  开发日志记录的是版本建设过程，产品更新中心讲的是“这次你能直接感受到什么变化”。两者语气、目标和阅读场景都不同。
                </p>
              </div>
              <div className="space-y-3">
                {[
                  '右上角用轻量提示告诉用户有新内容，而不是每次都打断。',
                  '支持入口保留页面入口，方便用户回头查具体变化。',
                  '每条更新都能展开细节、场景说明和视觉预览。',
                ].map((item) => (
                  <div key={item} className="flex items-start gap-3 rounded-[1rem] border border-border/70 bg-background/80 px-4 py-3 dark:border-border/90 dark:bg-background/10">
                    <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-primary" />
                    <p className="text-sm leading-6 text-muted-foreground">{item}</p>
                  </div>
                ))}
              </div>
            </div>
          </aside>
        </div>
      </section>

      <div className="grid gap-6 xl:grid-cols-[17rem_minmax(0,1fr)]">
        <aside className="space-y-4 xl:sticky xl:top-24 xl:self-start">
          <Card className="dark:border-border/80 dark:bg-[hsl(var(--surface-panel))]">
            <CardContent className="space-y-4 p-4">
              <div className="space-y-1">
                <div className="text-[0.72rem] uppercase tracking-[0.16em] text-muted-foreground">更新导航</div>
                <p className="text-sm leading-6 text-muted-foreground">按功能更新查看你最近能直接用到的新变化。</p>
              </div>
              <nav className="space-y-2">
                {snapshot.updates.map((update) => {
                  const active = openUpdateId === update.id

                  return (
                    <button
                      key={update.id}
                      type="button"
                      onClick={() => setOpenUpdateId(update.id)}
                      className={cn(
                        'flex w-full items-start justify-between rounded-2xl border px-3 py-3 text-left transition-colors duration-200',
                        active
                          ? 'border-primary/28 bg-primary/8'
                          : 'border-border/70 bg-background/72 hover:border-primary/20 hover:bg-primary/5 dark:border-border/90 dark:bg-[hsl(var(--surface-soft)/0.8)]',
                      )}
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-foreground">{update.title}</div>
                        <div className="mt-1 text-xs text-muted-foreground">{formatDate(update.publishedAt)}</div>
                      </div>
                      <ArrowRight className={cn('mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform', active && 'translate-x-0.5 text-foreground')} />
                    </button>
                  )
                })}
              </nav>
            </CardContent>
          </Card>
        </aside>

        <div className="space-y-5">
          {snapshot.updates.map((update) => {
            const expanded = openUpdateId === update.id

            return (
              <section key={update.id} id={update.id} className="scroll-mt-24">
                <Card className="relative overflow-hidden dark:border-border/80 dark:bg-[hsl(var(--surface-panel))]">
                  <div className={cn('pointer-events-none absolute inset-0 bg-gradient-to-br', toneStyles[update.tone])} />
                  <div className="relative z-10 space-y-6 p-5 md:p-7">
                    <div className="flex flex-col gap-4 border-b border-border/70 pb-5 dark:border-border/80 md:flex-row md:items-start md:justify-between">
                      <div className="space-y-4">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="outline" className="rounded-full border-primary/24 bg-primary/8 text-primary dark:border-primary/22 dark:bg-primary/10">
                            {update.label}
                          </Badge>
                          <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
                            <Clock3 className="h-4 w-4" />
                            {formatDate(update.publishedAt)}
                          </span>
                        </div>
                        <div className="space-y-2">
                          <h3 className="text-2xl font-semibold tracking-tight">{update.title}</h3>
                          <p className="max-w-4xl text-sm leading-6 text-muted-foreground md:text-[0.95rem]">{update.summary}</p>
                        </div>
                      </div>

                      <Button
                        type="button"
                        variant="outline"
                        className="rounded-xl"
                        onClick={() => setOpenUpdateId(expanded ? '' : update.id)}
                      >
                        {expanded ? '收起详情' : '展开详情'}
                        <ChevronDown className={cn('h-4 w-4 transition-transform', expanded && 'rotate-180')} />
                      </Button>
                    </div>

                    <div className="rounded-[1.5rem] border border-border/70 bg-background/78 p-4 dark:border-border/90 dark:bg-[hsl(var(--surface-soft)/0.78)]">
                      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                        <MessageSquareText className="h-4 w-4 text-primary" />
                        这次更新想解决什么
                      </div>
                      <p className="mt-3 text-sm leading-6 text-muted-foreground">{update.narrative}</p>
                    </div>

                    <div className="grid gap-3 xl:grid-cols-3">
                      {update.audienceValue.map((item) => (
                        <article
                          key={`${update.id}-${item}`}
                          className="rounded-[1.35rem] border border-border/70 bg-background/78 p-4 dark:border-border/90 dark:bg-[hsl(var(--surface-soft)/0.84)]"
                        >
                          <div className="flex items-start gap-3">
                            <div className="mt-0.5 rounded-2xl border border-primary/15 bg-primary/10 p-2 text-primary">
                              <Sparkles className="h-4 w-4" />
                            </div>
                            <p className="text-sm leading-6 text-muted-foreground">{item}</p>
                          </div>
                        </article>
                      ))}
                    </div>

                    {expanded ? (
                      <div className="grid gap-5 border-t border-border/70 pt-5 dark:border-border/80">
                        <div className="grid gap-4 xl:grid-cols-2">
                          {update.sections.map((section) => (
                            <article
                              key={`${update.id}-${section.title}`}
                              className="rounded-[1.5rem] border border-border/70 bg-background/78 p-5 dark:border-border/90 dark:bg-[hsl(var(--surface-soft)/0.84)]"
                            >
                              <h4 className="text-base font-semibold tracking-tight text-foreground">{section.title}</h4>
                              <p className="mt-3 text-sm leading-6 text-muted-foreground">{section.body}</p>
                              {section.bullets?.length ? (
                                <div className="mt-4 space-y-2">
                                  {section.bullets.map((bullet) => (
                                    <div key={bullet} className="flex gap-2 text-sm leading-6 text-muted-foreground">
                                      <span className="mt-[0.72rem] h-1.5 w-1.5 shrink-0 rounded-full bg-primary/70" />
                                      <span>{bullet}</span>
                                    </div>
                                  ))}
                                </div>
                              ) : null}
                            </article>
                          ))}
                        </div>

                        <div className="space-y-3">
                          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                            <PanelsTopLeft className="h-4 w-4 text-primary" />
                            更新预览
                          </div>
                          <div className="grid gap-4 xl:grid-cols-3">
                            {update.previews.map((preview, index) => (
                              <article
                                key={`${update.id}-${preview.title}`}
                                className="overflow-hidden rounded-[1.6rem] border border-border/70 bg-background/82 dark:border-border/90 dark:bg-[hsl(var(--surface-soft)/0.84)]"
                              >
                                <div className="border-b border-border/70 px-4 py-4 dark:border-border/80">
                                  <div className="text-[0.72rem] uppercase tracking-[0.16em] text-muted-foreground">{preview.eyebrow}</div>
                                  <h4 className="mt-2 text-base font-semibold tracking-tight text-foreground">{preview.title}</h4>
                                </div>
                                <div className="space-y-4 p-4">
                                  <div className="rounded-[1.3rem] border border-border/70 bg-[linear-gradient(160deg,rgba(14,116,144,0.14),rgba(255,255,255,0.95)_42%,rgba(251,191,36,0.14))] p-4 dark:border-border/90 dark:bg-[linear-gradient(160deg,rgba(14,116,144,0.18),rgba(15,23,42,0.88)_42%,rgba(251,191,36,0.18))]">
                                    <div className="flex items-center gap-2">
                                      <span className="h-2.5 w-2.5 rounded-full bg-rose-400" />
                                      <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
                                      <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
                                    </div>
                                    <div className="mt-4 space-y-3">
                                      <div className="h-3.5 w-2/3 rounded-full bg-foreground/12" />
                                      <div className="grid grid-cols-2 gap-2">
                                        <div className="rounded-xl border border-white/40 bg-white/70 p-3 dark:border-white/10 dark:bg-white/5">
                                          <div className="h-3 w-16 rounded-full bg-foreground/12" />
                                          <div className="mt-3 h-16 rounded-xl bg-foreground/8" />
                                        </div>
                                        <div className="rounded-xl border border-white/40 bg-white/70 p-3 dark:border-white/10 dark:bg-white/5">
                                          <div className="h-3 w-12 rounded-full bg-foreground/12" />
                                          <div className={cn('mt-3 h-16 rounded-xl', index % 2 === 0 ? 'bg-cyan-500/18' : 'bg-amber-500/18')} />
                                        </div>
                                      </div>
                                      <div className="h-10 rounded-2xl bg-foreground/8" />
                                    </div>
                                  </div>

                                  <p className="text-sm leading-6 text-muted-foreground">{preview.caption}</p>
                                  <div className="flex flex-wrap gap-2">
                                    {preview.chips.map((chip) => (
                                      <span
                                        key={chip}
                                        className="rounded-full border border-border/70 bg-background/75 px-3 py-1 text-[0.72rem] text-foreground/85 dark:border-border/90 dark:bg-background/10"
                                      >
                                        {chip}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              </article>
                            ))}
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </div>
                </Card>
              </section>
            )
          })}

          <section id="support" className="scroll-mt-24">
            <Card className="dark:border-border/80 dark:bg-[hsl(var(--surface-panel))]">
              <CardContent className="grid gap-4 p-5 md:grid-cols-[minmax(0,1fr)_15rem] md:items-center md:p-6">
                <div className="space-y-2">
                  <div className="text-[0.72rem] uppercase tracking-[0.16em] text-muted-foreground">支持入口</div>
                  <h3 className="text-xl font-semibold tracking-tight">如果用户看到了更新，但还不知道怎么用</h3>
                  <p className="text-sm leading-6 text-muted-foreground">
                    这里已经预留成支持区的说明位。后面可以继续加 FAQ、操作视频、图文指引，右上角帮助按钮会直接跳到这里。
                  </p>
                </div>
                <div className="rounded-[1.5rem] border border-border/70 bg-background/82 p-4 text-sm leading-6 text-muted-foreground dark:border-border/90 dark:bg-[hsl(var(--surface-soft)/0.8)]">
                  推荐做法：把“发生了什么”放在更新条目里，把“怎么用”放在这个支持区，避免一条更新写得过长。
                </div>
              </CardContent>
            </Card>
          </section>
        </div>
      </div>
    </div>
  )
}
