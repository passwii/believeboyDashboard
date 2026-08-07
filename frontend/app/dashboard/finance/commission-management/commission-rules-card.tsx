'use client'

import { Card } from '@/components/ui/card'

const PROJECT_COMMISSION_RULES = [
  {
    code: 'Rule 01',
    title: '销售额佣金计算',
    tag: '按销售额',
    description: '按销售额提成',
  },
  {
    code: 'Rule 02',
    title: '回款佣金核算',
    tag: '按回款率',
    description: '按回款提成',
    tiers: ['40% - 50% -> 7%', '50% - 60% -> 10%', '60% - 70% -> 13%', '70% 以上 -> 15%'],
  },
] as const

export function CommissionRulesCard() {
  return (
    <Card className="shrink-0 overflow-hidden border-border/80 bg-[linear-gradient(145deg,rgba(248,250,252,0.96),rgba(255,255,255,0.98)),radial-gradient(circle_at_top_right,rgba(245,158,11,0.12),transparent_32%),radial-gradient(circle_at_bottom_left,rgba(14,165,233,0.1),transparent_26%)] shadow-[0_20px_45px_-30px_rgba(15,23,42,0.28)] dark:border-border/80 dark:bg-[linear-gradient(180deg,hsl(var(--surface-panel)),hsl(var(--surface-soft)))] dark:shadow-[0_24px_50px_-30px_rgba(0,0,0,0.45)]">
      <div className="grid gap-4 p-5 xl:grid-cols-[0.92fr_1.45fr]">
        <aside className="relative overflow-hidden rounded-[28px] border border-slate-200/80 bg-[linear-gradient(180deg,rgba(14,165,233,0.08),rgba(255,255,255,0.92)),radial-gradient(circle_at_top_left,rgba(14,165,233,0.14),transparent_36%)] p-5 shadow-[0_18px_34px_-28px_rgba(15,23,42,0.45)] dark:border-border/80 dark:bg-[linear-gradient(180deg,hsl(var(--surface-soft)),hsl(var(--surface-panel)))] dark:shadow-none">
          <div className="space-y-4">
            <div className="space-y-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-sky-700/80 dark:text-sky-300/80">
                Project Commission
              </p>
              <h3 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-foreground">
                工厂佣金结算备注
              </h3>
              <p className="text-sm leading-6 text-slate-600 dark:text-muted-foreground/80">
                这里展示的是项目与工厂之间的佣金结算口径。当前先引用现有两类规则作为说明，后续你可以继续补充更多结算规则。
              </p>
            </div>

            <div className="rounded-2xl border border-white/80 bg-white/85 p-4 dark:border-border/80 dark:bg-[hsl(var(--surface-panel))]">
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400 dark:text-muted-foreground/70">
                Rule Index
              </p>
              <div className="mt-3 space-y-2">
                {PROJECT_COMMISSION_RULES.map((item) => (
                  <div
                    key={item.code}
                    className="flex items-center justify-between rounded-2xl bg-[hsl(var(--surface-soft))] px-3 py-2.5"
                  >
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400 dark:text-muted-foreground/70">
                        {item.code}
                      </p>
                      <p className="mt-1 text-sm font-semibold text-slate-900 dark:text-foreground">
                        {item.title}
                      </p>
                    </div>
                    <span className="rounded-full border border-sky-200/80 bg-sky-50 px-2.5 py-1 text-xs font-medium text-sky-700 dark:border-sky-500/20 dark:bg-sky-500/12 dark:text-sky-300">
                      {item.tag}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-2xl border border-dashed border-slate-300 bg-white/72 p-4 text-sm leading-6 text-slate-600 dark:border-border/70 dark:bg-[hsl(var(--surface-soft))] dark:text-muted-foreground/80">
              当前区域作为结算手册占位。
              <span className="font-medium text-slate-800 dark:text-foreground">
                {' '}
                未来新增规则{' '}
              </span>
              可以继续沿用右侧卡片结构补充。
            </div>
          </div>
        </aside>

        <div className="space-y-3">
          {PROJECT_COMMISSION_RULES.map((item) => (
            <article
              key={item.title}
              className="group relative overflow-hidden rounded-[28px] border border-white/85 bg-[linear-gradient(135deg,rgba(255,255,255,0.96),rgba(248,250,252,0.9))] p-5 shadow-[0_20px_40px_-30px_rgba(15,23,42,0.42)] transition-colors duration-200 hover:border-sky-200/80 dark:border-border/80 dark:bg-[hsl(var(--surface-panel))] dark:hover:border-sky-500/25"
            >
              <div className="absolute inset-y-5 left-0 w-1 rounded-full bg-gradient-to-b from-sky-500 via-cyan-400 to-emerald-400" />
              <div className="pl-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400 dark:text-muted-foreground/70">
                      {item.code}
                    </p>
                    <h4 className="text-base font-semibold text-slate-900 dark:text-foreground">
                      {item.title}
                    </h4>
                  </div>
                  <span className="rounded-full border border-[hsl(var(--border))] bg-[hsl(var(--surface-soft))] px-3 py-1 text-xs font-medium text-slate-600 dark:border-slate-500/20 dark:bg-slate-500/12 dark:text-slate-200">
                    {item.tag}
                  </span>
                </div>

                <div className="mt-4 grid gap-3 md:grid-cols-[0.9fr_1.5fr]">
                  <div className="rounded-2xl bg-slate-950/[0.035] p-4 dark:bg-[hsl(var(--surface-soft))]">
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400 dark:text-muted-foreground/70">
                      适用口径
                    </p>
                    <p className="mt-2 text-sm font-medium leading-6 text-slate-700 dark:text-foreground/90">
                      {item.tag === '按销售额'
                        ? '按月销售收入与项目佣金点数核算'
                        : '按回款率阶梯自动核算项目佣金'}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-slate-100 bg-white/82 p-4 dark:border-border/80 dark:bg-[hsl(var(--surface-soft))]">
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400 dark:text-muted-foreground/70">
                      规则说明
                    </p>
                    <p className="mt-2 text-sm leading-7 text-slate-600 dark:text-muted-foreground/80">
                      {item.description}
                    </p>
                    {'tiers' in item ? (
                      <div className="mt-4 grid gap-2 sm:grid-cols-2">
                        {item.tiers.map((tier) => (
                          <div
                            key={tier}
                            className="rounded-xl border border-emerald-100 bg-emerald-50/70 px-3 py-2 text-sm font-medium text-emerald-800 dark:border-emerald-500/20 dark:bg-emerald-500/12 dark:text-emerald-300"
                          >
                            {tier}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            </article>
          ))}
        </div>
      </div>
    </Card>
  )
}
