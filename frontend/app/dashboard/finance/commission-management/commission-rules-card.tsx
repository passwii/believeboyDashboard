'use client'

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
    <section className="dashboard-surface p-5">
      <div className="grid gap-4 xl:grid-cols-[0.92fr_1.45fr]">
        {/* 左侧：结算规则索引 */}
        <aside className="rounded-xl border border-border/70 bg-[hsl(var(--surface-soft))] p-5">
          <div className="space-y-4">
            <div className="space-y-2">
              <p className="dashboard-kicker">Project Commission</p>
              <h3 className="text-lg font-semibold tracking-tight text-foreground">
                工厂佣金结算备注
              </h3>
              <p className="text-sm leading-6 text-muted-foreground">
                这里展示的是项目与工厂之间的佣金结算口径。当前先引用现有两类规则作为说明，后续你可以继续补充更多结算规则。
              </p>
            </div>

            <div className="rounded-lg border border-border/70 bg-[hsl(var(--surface-panel))] p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground/70">
                Rule Index
              </p>
              <div className="mt-3 space-y-2">
                {PROJECT_COMMISSION_RULES.map((item) => (
                  <div
                    key={item.code}
                    className="flex items-center justify-between rounded-lg bg-[hsl(var(--surface-subtle))] px-3 py-2.5"
                  >
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground/70">
                        {item.code}
                      </p>
                      <p className="mt-1 text-sm font-semibold text-foreground">{item.title}</p>
                    </div>
                    <span className="rounded-full border border-[hsl(var(--primary)/0.3)] bg-[hsl(var(--primary)/0.1)] px-2.5 py-1 text-xs font-medium text-[hsl(var(--primary))]">
                      {item.tag}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-lg border border-dashed border-border/70 bg-[hsl(var(--surface-subtle))] p-4 text-sm leading-6 text-muted-foreground">
              当前区域作为结算手册占位。
              <span className="font-medium text-foreground"> 未来新增规则 </span>
              可以继续沿用右侧卡片结构补充。
            </div>
          </div>
        </aside>

        {/* 右侧：规则详情 */}
        <div className="space-y-3">
          {PROJECT_COMMISSION_RULES.map((item) => (
            <article
              key={item.title}
              className="group relative overflow-hidden rounded-xl border border-border/70 bg-[hsl(var(--surface-panel))] p-5 transition-colors duration-200 hover:border-[hsl(var(--primary)/0.35)]"
            >
              <div className="absolute inset-y-5 left-0 w-1 rounded-full bg-gradient-to-b from-[hsl(var(--primary))] via-[hsl(var(--chart-6))] to-[hsl(var(--data-positive))]" />
              <div className="pl-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground/70">
                      {item.code}
                    </p>
                    <h4 className="text-base font-semibold text-foreground">{item.title}</h4>
                  </div>
                  <span className="rounded-full border border-border bg-[hsl(var(--surface-soft))] px-3 py-1 text-xs font-medium text-muted-foreground">
                    {item.tag}
                  </span>
                </div>

                <div className="mt-4 grid gap-3 md:grid-cols-[0.9fr_1.5fr]">
                  <div className="rounded-lg bg-[hsl(var(--surface-subtle))] p-4">
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground/70">
                      适用口径
                    </p>
                    <p className="mt-2 text-sm font-medium leading-6 text-foreground/90">
                      {item.tag === '按销售额'
                        ? '按月销售收入与项目佣金点数核算'
                        : '按回款率阶梯自动核算项目佣金'}
                    </p>
                  </div>
                  <div className="rounded-lg border border-border/70 bg-[hsl(var(--surface-subtle))] p-4">
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground/70">
                      规则说明
                    </p>
                    <p className="mt-2 text-sm leading-7 text-muted-foreground">{item.description}</p>
                    {'tiers' in item ? (
                      <div className="mt-4 grid gap-2 sm:grid-cols-2">
                        {item.tiers.map((tier) => (
                          <div
                            key={tier}
                            className="rounded-lg border border-[hsl(var(--data-positive)/0.25)] bg-[hsl(var(--data-positive)/0.1)] px-3 py-2 text-sm font-medium text-[hsl(var(--data-positive))]"
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
    </section>
  )
}
