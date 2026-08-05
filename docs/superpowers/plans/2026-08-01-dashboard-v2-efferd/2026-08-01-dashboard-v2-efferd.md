# Dashboard V2（Efferd 密集网格）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `/dashboard/v2` 新建 Efferd 密集网格风格的 dashboard overview 实验页（真实 KPI/图表数据 + mock 占位区块），v1 页面保留并加"试试新版"互跳按钮。

**Architecture:** 自包含 `components/dashboard-v2/` 模块（全部 `v2-` 前缀组件），v2 page 复制 v1 的 daily-analysis fetch 逻辑并新增页面级项目过滤（默认"全部项目"= v1 行为）。v2 渲染在现有 `app/dashboard/layout.tsx` 内，不引入 sample 的 AppShell。Recharts 图表走 `next/dynamic` + `ssr:false` 拆包。

**Tech Stack:** Next.js 16 (App Router) / React 18 / TypeScript / Tailwind CSS 3.4 / shadcn ui / recharts 2.15 / lucide-react / Vitest + Testing Library (jsdom)

**Spec:** `docs/superpowers/specs/2026-08-01-dashboard-v2-efferd-design.md`

## Global Constraints

- 所有代码在 `frontend/` 目录内；命令在 `frontend/` 下执行（`cd frontend`）
- 不修改 v1 的任何逻辑——v1 唯一改动是 Task 8 加的"试试新版"按钮
- 组件命名全部 `v2-` 前缀（文件名 + 导出名 `V2*`），与 `components/dashboard/`（v1）隔离
- 视觉：全部 Tailwind utility classes + shadcn CSS 变量，不新增 CSS 文件，不用 `dashboard-surface`（v1 专属）
- 真实数据区块中文标签，金额 `$` 前缀（en-US locale，USD）；mock 区块保持 sample 英文原样
- Commit 规范：中文 + Conventional Commits（如 `feat(前端): 新增 v2 dashboard KPI 统计卡`），scope 中文，subject 动宾短语 ≤50 字无句号
- 测试顺序（AGENTS.md）：`pnpm lint` → `pnpm build` → `pnpm test`；失败立即修
- 测试文件与组件同目录（项目惯例，参照 `components/ui/button.test.tsx`）

---

## File Structure

| 文件 | 职责 |
|---|---|
| `components/dashboard-v2/v2-card.tsx` | 纯平卡片基座（rounded-none shadow-none） |
| `components/dashboard-v2/v2-delta.tsx` | 趋势指示器（context 架构，lucide 图标） |
| `components/dashboard-v2/v2-format.ts` | 显示格式化（日期/货币/数字/百分比，en-US） |
| `components/dashboard-v2/v2-grid.tsx` | 密集网格骨架（gap-px 发丝线） |
| `components/dashboard-v2/v2-stats.tsx` | 4 KPI 统计卡（真实数据）+ `computeStats` 纯函数 |
| `components/dashboard-v2/v2-revenue-chart.tsx` | 每日销售额渐变柱状图（真实数据） |
| `components/dashboard-v2/v2-channel-chart.tsx` | 销售额 vs 广告花费双折线（真实数据） |
| `components/dashboard-v2/v2-invoices.tsx` | 发票表格（mock） |
| `components/dashboard-v2/v2-billing.tsx` | 账单健康度（mock） |
| `components/dashboard-v2/v2-activity.tsx` | 活动流（mock） |
| `components/dashboard-v2/mock-data.ts` | mock 数据（3 个 mock 组件共用处——实际各组件自带数据则不需要此文件，见 Task 6） |
| `app/dashboard/v2/page.tsx` | v2 入口：fetch + 页面级项目过滤 + 网格编排 |
| `app/dashboard/page.tsx`（改） | 仅加"试试新版 ✨"按钮 |
| `.efferd-staging/`（仓库根目录，临时） | sample 源码暂存（必须在 frontend/ 外——其 import 引用不存在的模块，会被 tsc 扫描报错），Task 8 删除 |

---

### Task 1: 脚手架——staging 源码 + shadcn empty + v2-format + v2-card + v2-grid

**Files:**
- Create: `<仓库根>/.efferd-staging/*.tsx`（临时，必须在 frontend/ 外，Task 8 删）
- Create: `frontend/components/ui/empty.tsx`（shadcn CLI 生成）
- Create: `frontend/components/dashboard-v2/v2-format.ts`
- Create: `frontend/components/dashboard-v2/v2-card.tsx`
- Create: `frontend/components/dashboard-v2/v2-grid.tsx`

**Interfaces:**
- Produces: `V2Card`（`React.ComponentProps<typeof Card>`）、`V2Grid`（`{ children: React.ReactNode; className?: string }`）、`v2-format` 的 `formatDate / formatCompactCurrency / formatCompactNumber / formatPercent / formatChartAxisTick`

- [x] **Step 1: 下载 sample registry 并解包到 staging**

```bash
cd frontend
mkdir -p ../.efferd-staging
curl -s -o ../.efferd-staging/dashboard-2.json "https://efferd.com/r/dashboard-2.json"
python3 -c "
import json, os
d = json.load(open('../.efferd-staging/dashboard-2.json'))
for f in d.get('files', []):
    path = f.get('target', f.get('path'))
    fname = os.path.basename(path)
    open(f'../.efferd-staging/{fname}', 'w').write(f['content'])
    print(f'extracted {fname}')
"
```

> 为什么放仓库根而不是 frontend/ 内：staging 里的 sample 源码引用 `@/components/delta`、`IconPlaceholder` 等不存在的模块，若在 frontend/ 内会被 `tsc --noEmit` 扫到而报错。

Expected: 解包 9 个文件（billing-health.tsx, channel-sales-chart.tsx, dashboard-activity.tsx, dashboard-card.tsx, dashboard-invoices.tsx, dashboard.tsx, net-revenue-chart.tsx, stats.tsx, delta.tsx）

- [x] **Step 2: 安装 shadcn `empty` 组件**

billing-health.tsx 依赖 `@/components/ui/empty`（项目现有 `empty-state.tsx` 是不同组件，不能替代）。

```bash
cd frontend
npx shadcn@latest add empty --yes
```

Expected: 生成 `components/ui/empty.tsx`，导出 `Empty / EmptyContent / EmptyDescription / EmptyHeader / EmptyMedia / EmptyTitle` 等

- [x] **Step 3: 创建 v2-format.ts**

复制 efferd 的 formater 库（自包含，不动全局 `lib/`）：

```bash
cd frontend
curl -s -o /tmp/efferd-formater.json "https://efferd.com/r/formater.json"
python3 -c "
import json
d = json.load(open('/tmp/efferd-formater.json'))
open('components/dashboard-v2/v2-format.ts', 'w').write(d['files'][0]['content'])
print('wrote v2-format.ts')
"
```

Expected: `components/dashboard-v2/v2-format.ts` 包含 `DASHBOARD_LOCALE / parseIsoCalendarDate / formatDate / formatChartAxisTick / formatChartTooltipDate / formatCompactCurrency / formatFullCurrency / formatCompactNumber / formatInteger / formatPercent`

- [x] **Step 4: 创建 v2-card.tsx**

```tsx
// frontend/components/dashboard-v2/v2-card.tsx
import type * as React from 'react'

import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'

export function V2Card({ className, ...props }: React.ComponentProps<typeof Card>) {
  return <Card className={cn('rounded-none bg-background shadow-none ring-0', className)} {...props} />
}
```

- [x] **Step 5: 创建 v2-grid.tsx**

```tsx
// frontend/components/dashboard-v2/v2-grid.tsx
import type * as React from 'react'

import { cn } from '@/lib/utils'

/** Efferd 密集网格：gap-px + bg-border 发丝线分隔，lg 4 列 / md 2 列 / 移动端 1 列 */
export function V2Grid({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('grid grid-cols-1 gap-px bg-border p-px md:grid-cols-2 lg:grid-cols-4', className)}>
      {children}
    </div>
  )
}
```

- [x] **Step 6: 验证编译 + commit**

```bash
cd frontend
pnpm exec tsc --noEmit
git add components/ui/empty.tsx components/dashboard-v2/
git commit -m "feat(前端): 搭建 v2 dashboard 脚手架与格式化/卡片/网格基座"
```

Expected: tsc 无错误；commit 只含 4 个正式文件（staging 在仓库根且不提交，Task 8 删除）

---

### Task 2: v2-delta 趋势指示器 + 测试

sample 的 delta.tsx 用 `IconPlaceholder` 多图标库抽象（项目不存在），本任务替换为 lucide-react 直接引用。

**Files:**
- Create: `frontend/components/dashboard-v2/v2-delta.tsx`
- Test: `frontend/components/dashboard-v2/v2-delta.test.tsx`

**Interfaces:**
- Consumes: `@/components/ui/badge`（Badge）、`@/lib/utils`（cn）
- Produces: `Delta`（`{ value: number; variant?: 'default' | 'badge' } & React.ComponentProps<'div'>`）、`DeltaIcon`（`{ variant?: 'default' | 'trend' | 'arrow'; filled?: boolean }`）、`DeltaValue`（`{ precision?: number; suffix?: string; absolute?: boolean }`）

- [x] **Step 1: 写失败测试**

```tsx
// frontend/components/dashboard-v2/v2-delta.test.tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { Delta, DeltaIcon, DeltaValue } from './v2-delta'

describe('v2-delta', () => {
  it('渲染绝对值 + % 后缀（默认 precision=1）', () => {
    render(
      <Delta value={-3.44}>
        <DeltaValue />
      </Delta>
    )
    expect(screen.getByText('3.4%')).toBeInTheDocument()
  })

  it('正值显示 emerald 色', () => {
    const { container } = render(
      <Delta value={12.4}>
        <DeltaValue />
      </Delta>
    )
    expect(container.querySelector('[data-slot="delta"]')?.className).toContain('emerald')
  })

  it('负值显示 rose 色', () => {
    const { container } = render(
      <Delta value={-0.4}>
        <DeltaValue />
      </Delta>
    )
    expect(container.querySelector('[data-slot="delta"]')?.className).toContain('rose')
  })

  it('badge variant 正值用 emerald 背景', () => {
    const { container } = render(
      <Delta value={5} variant="badge">
        <DeltaValue />
      </Delta>
    )
    expect(container.querySelector('[data-slot="delta"]')?.className).toContain('bg-emerald-500/10')
  })

  it('DeltaValue 在 Delta 外使用抛错', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<DeltaValue />)).toThrow('must be used inside a `Delta` component')
    vi.restoreAllMocks()
  })
})
```

- [x] **Step 2: 运行测试确认失败**

Run: `cd frontend && pnpm exec vitest run components/dashboard-v2/v2-delta.test.tsx`
Expected: FAIL（模块 `./v2-delta` 不存在）

- [x] **Step 3: 实现 v2-delta.tsx**

```tsx
// frontend/components/dashboard-v2/v2-delta.tsx
'use client'

import * as React from 'react'
import { ArrowDown, ArrowUp, ChevronDown, ChevronUp, Minus, TrendingDown, TrendingUp } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

type DeltaIconVariant = 'default' | 'trend' | 'arrow'
type DeltaVariant = 'default' | 'badge'

type DeltaContextValue = { value: number }

const DeltaContext = React.createContext<DeltaContextValue | null>(null)

function useDeltaValue() {
  const context = React.useContext(DeltaContext)
  if (!context) {
    throw new Error('DeltaIcon and DeltaValue must be used inside a `Delta` component.')
  }
  return context.value
}

function Delta({
  className,
  value,
  variant = 'default',
  ...props
}: React.ComponentProps<'div'> & {
  value: number
  variant?: DeltaVariant
}) {
  return (
    <DeltaContext.Provider value={{ value }}>
      {variant === 'badge' ? (
        <Badge
          className={cn(
            'gap-1 border-none tabular-nums [&_svg]:size-4 [&_svg]:shrink-0',
            value > 0 ? 'bg-emerald-500/10 text-emerald-500' : 'bg-red-500/10 text-red-500',
            className
          )}
          data-slot="delta"
          variant="secondary"
          {...(props as React.ComponentProps<typeof Badge>)}
        />
      ) : (
        <div
          className={cn(
            'inline-flex items-center gap-1 text-muted-foreground tabular-nums',
            '[&_svg]:size-3 [&_svg]:shrink-0',
            value > 0 ? 'text-emerald-600 dark:text-emerald-400' : '',
            value < 0 ? 'text-rose-600 dark:text-rose-400' : '',
            className
          )}
          data-slot="delta"
          {...props}
        />
      )}
    </DeltaContext.Provider>
  )
}

function FilledShell({ value, children }: { value: number; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex size-3 shrink-0 items-center justify-center rounded-full',
        '[&_svg]:size-2! [&_svg]:shrink-0 [&_svg]:stroke-3! [&_svg]:text-background',
        value > 0 && 'bg-emerald-500',
        value < 0 && 'bg-red-500',
        (!value || value === 0) && 'bg-muted-foreground'
      )}
      data-slot="delta-icon"
    >
      {children}
    </span>
  )
}

function DeltaIcon({
  variant = 'default',
  filled = false,
  className,
  ...props
}: Omit<React.ComponentProps<'svg'>, 'fill'> & {
  variant?: DeltaIconVariant
  filled?: boolean
}) {
  const resolvedValue = useDeltaValue()

  const shell = (node: React.ReactElement) =>
    filled ? <FilledShell value={resolvedValue}>{node}</FilledShell> : node
  const slotProps = filled ? {} : { 'data-slot': 'delta-icon' as const }

  let Icon = Minus
  if (resolvedValue > 0) {
    Icon = variant === 'trend' ? TrendingUp : variant === 'arrow' ? ArrowUp : ChevronUp
  } else if (resolvedValue < 0) {
    Icon = variant === 'trend' ? TrendingDown : variant === 'arrow' ? ArrowDown : ChevronDown
  }

  return shell(<Icon {...slotProps} className={className} {...props} />)
}

function DeltaValue({
  className,
  precision = 1,
  suffix = '%',
  absolute = true,
  ...props
}: React.ComponentProps<'span'> & {
  precision?: number
  suffix?: string
  absolute?: boolean
}) {
  const resolvedValue = useDeltaValue()
  const formattedValue = (absolute ? Math.abs(resolvedValue) : resolvedValue).toFixed(precision)

  return (
    <span className={cn('tabular-nums', className)} data-slot="delta-value" {...props}>
      {formattedValue}
      {suffix}
    </span>
  )
}

export { Delta, DeltaIcon, DeltaValue }
```

- [x] **Step 4: 运行测试确认通过**

Run: `cd frontend && pnpm exec vitest run components/dashboard-v2/v2-delta.test.tsx`
Expected: 5 tests PASS

- [x] **Step 5: Commit**

```bash
git add components/dashboard-v2/v2-delta.tsx components/dashboard-v2/v2-delta.test.tsx
git commit -m "feat(前端): 新增 v2 dashboard 趋势指示器组件"
```

---

### Task 3: v2-stats KPI 统计卡（真实数据）+ 测试

**Files:**
- Create: `frontend/components/dashboard-v2/v2-stats.tsx`
- Test: `frontend/components/dashboard-v2/v2-stats.test.tsx`

**Interfaces:**
- Consumes: `V2Card`（Task 1）、`Delta/DeltaIcon/DeltaValue`（Task 2）、`v2-format`（Task 1）、`@/components/ui/card`、`@/components/ui/skeleton`
- Produces: `V2Stats`（`{ currentRows: V2StatRow[]; comparisonRows?: V2StatRow[]; loading?: boolean }`）、`computeStats(currentRows, comparisonRows): V2Stat[]`、类型 `V2StatRow`（`{ date; order_qty; sales_amount; ad_spend; page_views; units_ordered }` 全 number）

- [x] **Step 1: 写失败测试**

```tsx
// frontend/components/dashboard-v2/v2-stats.test.tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { computeStats, V2Stats, type V2StatRow } from './v2-stats'

const current: V2StatRow[] = [
  { date: '2026-07-30', order_qty: 10, sales_amount: 100, ad_spend: 20, page_views: 1000, units_ordered: 50 },
  { date: '2026-07-31', order_qty: 30, sales_amount: 300, ad_spend: 40, page_views: 1000, units_ordered: 50 },
]
// 上一周期：销售额 320、订单 50、广告 60、转化率 4%
const comparison: V2StatRow[] = [
  { date: '2026-07-28', order_qty: 20, sales_amount: 120, ad_spend: 30, page_views: 1000, units_ordered: 40 },
  { date: '2026-07-29', order_qty: 30, sales_amount: 200, ad_spend: 30, page_views: 1000, units_ordered: 40 },
]

describe('computeStats', () => {
  it('销售额 = 400，环比 +25%', () => {
    const stats = computeStats(current, comparison)
    expect(stats[0].label).toBe('销售额')
    expect(stats[0].value).toBe('$400')
    expect(stats[0].delta).toBeCloseTo(25, 5)
  })

  it('订单量 = 40，环比 -20%', () => {
    const stats = computeStats(current, comparison)
    expect(stats[1].label).toBe('订单量')
    expect(stats[1].delta).toBeCloseTo(-20, 5)
  })

  it('广告花费 = 60，环比 0%', () => {
    const stats = computeStats(current, comparison)
    expect(stats[2].label).toBe('广告花费')
    expect(stats[2].delta).toBe(0)
  })

  it('转化率 = 5.00%（units_ordered/page_views），环比 +25%', () => {
    const stats = computeStats(current, comparison)
    expect(stats[3].label).toBe('转化率')
    expect(stats[3].value).toBe('5.00%')
    expect(stats[3].delta).toBeCloseTo(25, 5)
  })

  it('上一周期为空时 delta 为 0', () => {
    const stats = computeStats(current, [])
    expect(stats.every((s) => s.delta === 0)).toBe(true)
  })
})

describe('V2Stats', () => {
  it('loading 时渲染 4 个骨架卡', () => {
    const { container } = render(<V2Stats currentRows={[]} loading />)
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThanOrEqual(4)
  })

  it('渲染 4 个 KPI 标签', () => {
    render(<V2Stats currentRows={current} comparisonRows={comparison} />)
    expect(screen.getByText('销售额')).toBeInTheDocument()
    expect(screen.getByText('订单量')).toBeInTheDocument()
    expect(screen.getByText('广告花费')).toBeInTheDocument()
    expect(screen.getByText('转化率')).toBeInTheDocument()
  })
})
```

- [x] **Step 2: 运行测试确认失败**

Run: `cd frontend && pnpm exec vitest run components/dashboard-v2/v2-stats.test.tsx`
Expected: FAIL（模块不存在）

- [x] **Step 3: 实现 v2-stats.tsx**

```tsx
// frontend/components/dashboard-v2/v2-stats.tsx
'use client'

import {
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'

import { V2Card } from './v2-card'
import { Delta, DeltaIcon, DeltaValue } from './v2-delta'
import { formatCompactCurrency, formatCompactNumber, formatPercent } from './v2-format'

/** 与 app/dashboard/v2/page.tsx 的 DailyAnalysisRow 保持一致的简化类型——只声明本组件用到的字段 */
export type V2StatRow = {
  date: string
  order_qty: number
  sales_amount: number
  ad_spend: number
  page_views: number
  units_ordered: number
}

export type V2Stat = { label: string; value: string; delta: number }

type SumKey = 'order_qty' | 'sales_amount' | 'ad_spend'

function sum(rows: V2StatRow[], key: SumKey): number {
  return rows.reduce((s, r) => s + r[key], 0)
}

/** 与 v1 page.tsx aggregateMetric('conversion_rate') 同口径：units_ordered / page_views，转百分比 */
function conversionRatePct(rows: V2StatRow[]): number {
  const pv = rows.reduce((s, r) => s + r.page_views, 0)
  const uo = rows.reduce((s, r) => s + r.units_ordered, 0)
  return pv > 0 ? (uo / pv) * 100 : 0
}

function pctChange(current: number, previous: number): number {
  return previous > 0 ? ((current - previous) / previous) * 100 : 0
}

export function computeStats(currentRows: V2StatRow[], comparisonRows: V2StatRow[]): V2Stat[] {
  const totalSales = sum(currentRows, 'sales_amount')
  const totalOrders = sum(currentRows, 'order_qty')
  const totalAdSpend = sum(currentRows, 'ad_spend')
  const conv = conversionRatePct(currentRows)

  return [
    {
      label: '销售额',
      value: formatCompactCurrency(totalSales),
      delta: pctChange(totalSales, sum(comparisonRows, 'sales_amount')),
    },
    {
      label: '订单量',
      value: formatCompactNumber(totalOrders),
      delta: pctChange(totalOrders, sum(comparisonRows, 'order_qty')),
    },
    {
      label: '广告花费',
      value: formatCompactCurrency(totalAdSpend),
      delta: pctChange(totalAdSpend, sum(comparisonRows, 'ad_spend')),
    },
    {
      label: '转化率',
      value: formatPercent(conv),
      delta: pctChange(conv, conversionRatePct(comparisonRows)),
    },
  ]
}

export interface V2StatsProps {
  currentRows: V2StatRow[]
  comparisonRows?: V2StatRow[]
  loading?: boolean
}

export function V2Stats({ currentRows, comparisonRows = [], loading }: V2StatsProps) {
  if (loading) {
    return (
      <>
        {Array.from({ length: 4 }).map((_, i) => (
          <V2Card key={i}>
            <CardHeader>
              <Skeleton className="h-3 w-16" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-7 w-24" />
            </CardContent>
            <CardFooter>
              <Skeleton className="h-3 w-20" />
            </CardFooter>
          </V2Card>
        ))}
      </>
    )
  }

  const stats = computeStats(currentRows, comparisonRows)

  return (
    <>
      {stats.map((s) => (
        <V2Card className="transition-colors hover:bg-muted/50" key={s.label}>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="font-normal text-xs tracking-wide">{s.label}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-row items-center gap-2">
            <p className="font-semibold text-2xl tabular-nums">{s.value}</p>
          </CardContent>
          <CardFooter className="gap-1 rounded-none bg-background text-xs">
            <Delta value={s.delta}>
              <DeltaIcon />
              <DeltaValue />
            </Delta>
            <span className="text-muted-foreground">vs 上一周期</span>
          </CardFooter>
        </V2Card>
      ))}
    </>
  )
}
```

- [x] **Step 4: 运行测试确认通过**

Run: `cd frontend && pnpm exec vitest run components/dashboard-v2/v2-stats.test.tsx`
Expected: 7 tests PASS

- [x] **Step 5: Commit**

```bash
git add components/dashboard-v2/v2-stats.tsx components/dashboard-v2/v2-stats.test.tsx
git commit -m "feat(前端): 新增 v2 dashboard KPI 统计卡"
```

---

### Task 4: v2-revenue-chart 销售额渐变柱状图（真实数据）

**Files:**
- Create: `frontend/components/dashboard-v2/v2-revenue-chart.tsx`
- Reference: `../.efferd-staging/net-revenue-chart.tsx`（sample 原版，仓库根）

**Interfaces:**
- Consumes: `V2Card`（Task 1）、`Delta/DeltaIcon/DeltaValue`（Task 2）、`@/components/ui/card`、`@/components/ui/chart`（ChartContainer/ChartTooltip/ChartTooltipContent/ChartConfig）、recharts
- Produces: `V2RevenueChart`（`{ currentRows: { date: string; sales_amount: number }[]; comparisonRows?: { date: string; sales_amount: number }[] }`）

图表组件不做单测（项目惯例——v1 的 recharts 组件均无单测，jsdom 下 recharts 渲染不可靠），由 build + 手动视觉验证覆盖。

- [x] **Step 1: 实现 v2-revenue-chart.tsx**

基于 `../.efferd-staging/net-revenue-chart.tsx` 改造：删除模块级 mock 数据，改为 props 注入；`CustomGradientBar` 原样保留；标签中文化；delta 改为周期环比（与 v2-stats 同口径，替代 sample 的首尾日对比）。

```tsx
// frontend/components/dashboard-v2/v2-revenue-chart.tsx
'use client'

import type * as React from 'react'
import { Bar, BarChart, XAxis } from 'recharts'

import {
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart'

import { V2Card } from './v2-card'
import { Delta, DeltaIcon, DeltaValue } from './v2-delta'

type RevenueRow = { date: string; sales_amount: number }

export interface V2RevenueChartProps {
  currentRows: RevenueRow[]
  comparisonRows?: RevenueRow[]
}

const chartConfig = {
  sales: {
    label: '销售额',
    color: 'var(--chart-2)',
  },
} satisfies ChartConfig

function CustomGradientBar(
  props: React.SVGProps<SVGRectElement> & {
    index?: number
    dataKey?: string | number
  }
) {
  const { fill, x = 0, y = 0, width = 0, height = 0, dataKey = 'sales', index = 0 } = props
  const gid = `v2-gradient-bar-${String(dataKey)}-${index}`

  return (
    <>
      <rect fill={`url(#${gid})`} height={height} stroke="none" width={width} x={x} y={y} />
      <rect fill={fill} height={2} stroke="none" width={width} x={x} y={y} />
      <defs>
        <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={fill} stopOpacity={0.5} />
          <stop offset="100%" stopColor={fill} stopOpacity={0} />
        </linearGradient>
      </defs>
    </>
  )
}

/** ISO 日期 → "M/D"（与 v1 page.tsx dateLabels 同口径） */
function dayLabel(isoDate: string): string {
  const [, m, d] = isoDate.split('-')
  return `${Number(m)}/${Number(d)}`
}

export function V2RevenueChart({ currentRows, comparisonRows = [] }: V2RevenueChartProps) {
  const chartRows = currentRows.map((r) => ({ day: dayLabel(r.date), sales: r.sales_amount }))
  const total = currentRows.reduce((s, r) => s + r.sales_amount, 0)
  const prevTotal = comparisonRows.reduce((s, r) => s + r.sales_amount, 0)
  const delta = prevTotal > 0 ? ((total - prevTotal) / prevTotal) * 100 : 0

  return (
    <V2Card className="gap-0 transition-colors hover:bg-muted/50 md:col-span-2">
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>销售额</CardTitle>
          <Delta value={delta} variant="badge">
            <DeltaIcon variant="trend" />
            <DeltaValue />
          </Delta>
        </div>
        <CardDescription>每日销售额（近 7 天）</CardDescription>
      </CardHeader>
      <CardContent>
        <ChartContainer className="aspect-auto h-60 w-full md:h-80" config={chartConfig}>
          <BarChart accessibilityLayer data={chartRows}>
            <XAxis
              axisLine={false}
              dataKey="day"
              interval={0}
              tickFormatter={(value) => String(value)}
              tickLine={false}
              tickMargin={10}
            />
            <ChartTooltip content={<ChartTooltipContent hideLabel />} cursor={false} />
            <Bar dataKey="sales" fill="var(--color-sales)" shape={<CustomGradientBar />} />
          </BarChart>
        </ChartContainer>
      </CardContent>
    </V2Card>
  )
}
```

- [x] **Step 2: 验证编译**

Run: `cd frontend && pnpm exec tsc --noEmit`
Expected: 无错误

- [x] **Step 3: Commit**

```bash
git add components/dashboard-v2/v2-revenue-chart.tsx
git commit -m "feat(前端): 新增 v2 dashboard 销售额渐变柱状图"
```

---

### Task 5: v2-channel-chart 销售额 vs 广告花费双折线（真实数据）

**Files:**
- Create: `frontend/components/dashboard-v2/v2-channel-chart.tsx`
- Reference: `../.efferd-staging/channel-sales-chart.tsx`（sample 原版，仓库根）

**Interfaces:**
- Consumes: `V2Card`（Task 1）、`Delta/DeltaIcon/DeltaValue`（Task 2）、`@/components/ui/card`、`@/components/ui/chart`、recharts
- Produces: `V2ChannelChart`（`{ currentRows: { date: string; sales_amount: number; ad_spend: number }[]; comparisonRows?: 同 }`）

- [x] **Step 1: 实现 v2-channel-chart.tsx**

基于 `../.efferd-staging/channel-sales-chart.tsx` 改造：删除模块级 mock 数据与 `VISIBLE_DAYS` 切片（v2 数据本身就是 7 天区间），`retail/online` 双线改为 `sales/ad_spend`，保留 sample 的 step 线型 + feGaussianBlur 发光滤镜（`useId` 防 id 冲突），delta 改为销售额周期环比。

```tsx
// frontend/components/dashboard-v2/v2-channel-chart.tsx
'use client'

import { useId } from 'react'
import { CartesianGrid, Line, LineChart, XAxis } from 'recharts'

import {
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart'

import { V2Card } from './v2-card'
import { Delta, DeltaIcon, DeltaValue } from './v2-delta'
import { formatDate } from './v2-format'

type ChannelRow = { date: string; sales_amount: number; ad_spend: number }

export interface V2ChannelChartProps {
  currentRows: ChannelRow[]
  comparisonRows?: ChannelRow[]
}

const chartConfig = {
  sales: {
    label: '销售额',
    color: 'var(--chart-1)',
  },
  ad_spend: {
    label: '广告花费',
    color: 'var(--chart-2)',
  },
} satisfies ChartConfig

export function V2ChannelChart({ currentRows, comparisonRows = [] }: V2ChannelChartProps) {
  const chartUid = useId().replace(/:/g, '')
  const idLineGlow = `v2-channel-line-glow-${chartUid}`

  const total = currentRows.reduce((s, r) => s + r.sales_amount, 0)
  const prevTotal = comparisonRows.reduce((s, r) => s + r.sales_amount, 0)
  const delta = prevTotal > 0 ? ((total - prevTotal) / prevTotal) * 100 : 0

  return (
    <V2Card className="gap-0 transition-colors hover:bg-muted/50 md:col-span-2">
      <CardHeader>
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle>销售额 vs 广告花费</CardTitle>
            <Delta value={delta} variant="badge">
              <DeltaIcon variant="trend" />
              <DeltaValue />
            </Delta>
          </div>
          <CardDescription>每日销售额与广告花费对比（近 7 天）</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <ChartContainer className="aspect-auto h-60 w-full p-0 md:h-80" config={chartConfig}>
          <LineChart
            accessibilityLayer
            data={currentRows}
            margin={{ left: 12, right: 12, top: 8 }}
          >
            <CartesianGrid className="stroke-border" vertical={false} />
            <XAxis
              axisLine={false}
              dataKey="date"
              interval={0}
              tickFormatter={(value) => formatDate(String(value), 'day-month')}
              tickLine={false}
              tickMargin={8}
            />
            <ChartTooltip content={<ChartTooltipContent hideLabel />} cursor={false} />
            <defs>
              <filter height="140%" id={idLineGlow} width="140%" x="-20%" y="-20%">
                <feGaussianBlur result="blur" stdDeviation="10" />
                <feComposite in="SourceGraphic" in2="blur" operator="over" />
              </filter>
            </defs>
            <Line
              dataKey="sales_amount"
              dot={false}
              filter={`url(#${idLineGlow})`}
              stroke="var(--color-sales)"
              strokeWidth={2}
              type="step"
            />
            <Line
              dataKey="ad_spend"
              dot={false}
              filter={`url(#${idLineGlow})`}
              stroke="var(--color-ad_spend)"
              strokeWidth={2}
              type="step"
            />
          </LineChart>
        </ChartContainer>
      </CardContent>
    </V2Card>
  )
}
```

- [x] **Step 2: 验证编译**

Run: `cd frontend && pnpm exec tsc --noEmit`
Expected: 无错误

- [x] **Step 3: Commit**

```bash
git add components/dashboard-v2/v2-channel-chart.tsx
git commit -m "feat(前端): 新增 v2 dashboard 销售/广告双折线图"
```

---

### Task 6: mock 区块——invoices / billing / activity

**Files:**
- Create: `frontend/components/dashboard-v2/v2-invoices.tsx`
- Create: `frontend/components/dashboard-v2/v2-billing.tsx`
- Create: `frontend/components/dashboard-v2/v2-activity.tsx`
- Reference: `../.efferd-staging/{dashboard-invoices,billing-health,dashboard-activity}.tsx`（仓库根）

**Interfaces:**
- Consumes: `V2Card`（Task 1）、`@/components/ui/{button,card,table,empty}`
- Produces: `V2Invoices()`、`V2Billing()`、`V2Activity()`（均无 props，内置 mock 数据）

mock 数据内置在各组件中（sample 原样），不需要独立 mock-data.ts——三个组件无共享数据。（File Structure 表中的 mock-data.ts 因此不创建。）

- [x] **Step 1: 从 staging 复制并替换引用**

三个文件做相同的机械替换，其余内容（mock 数据、表格、Empty 状态、活动流）保持 sample 原样：

```bash
cd frontend
for pair in "dashboard-invoices:v2-invoices:V2Invoices:DashboardInvoices" \
            "billing-health:v2-billing:V2Billing:BillingHealth" \
            "dashboard-activity:v2-activity:V2Activity:DashboardActivity"; do
  src="${pair%%:*}"; rest="${pair#*:}"
  file="${rest%%:*}"; rest="${rest#*:}"
  newname="${rest%%:*}"; oldname="${rest#*:}"
  sed -e "s|@/components/dashboard-card|@/components/dashboard-v2/v2-card|g" \
      -e "s|DashboardCard|V2Card|g" \
      -e "s|export function ${oldname}|export function ${newname}|g" \
      "../.efferd-staging/${src}.tsx" > "components/dashboard-v2/${file}.tsx"
  echo "created ${file}.tsx"
done
```

替换后检查点（每个文件）：
- import 变为 `import { V2Card } from "@/components/dashboard-v2/v2-card"`
- 根元素变为 `<V2Card className="...">`（invoices 保留 `relative gap-0 md:col-span-2`，billing/activity 保留 `gap-0`）
- 导出名分别为 `V2Invoices` / `V2Billing` / `V2Activity`
- `@/components/ui/button`、`@/components/ui/card`、`@/components/ui/table`、`@/components/ui/empty` 引用不变（项目均已有，empty 在 Task 1 安装）

- [x] **Step 2: 验证编译**

Run: `cd frontend && pnpm exec tsc --noEmit`
Expected: 无错误。若 `empty` 的导出名与 billing-health 引用不符（如 `EmptyContent` 缺失），按 `components/ui/empty.tsx` 实际导出名修正 billing 中的引用。

- [x] **Step 3: Commit**

```bash
git add components/dashboard-v2/v2-invoices.tsx components/dashboard-v2/v2-billing.tsx components/dashboard-v2/v2-activity.tsx
git commit -m "feat(前端): 新增 v2 dashboard mock 区块"
```

---

### Task 7: v2 页面——fetch + 页面级项目过滤 + 网格编排 + smoke 测试

**Files:**
- Create: `frontend/app/dashboard/v2/page.tsx`
- Test: `frontend/app/dashboard/v2/page.test.tsx`

**Interfaces:**
- Consumes: `V2Grid`（Task 1）、`V2Stats`（Task 3）、`LazyV2RevenueChart`/`LazyV2ChannelChart`（Task 4/5，dynamic 包装）、`V2Invoices/V2Billing/V2Activity`（Task 6）、`useManagedProjects`（`@/lib/hooks`）、`formatYMD`（`@/lib/dashboard-format`）、`useNotifications`（`@/components/notifications`）、`DashboardPageLoading`（`@/components/dashboard/dashboard-page-loading`）、`@/components/ui/{button,select,skeleton}`
- Produces: 默认导出 `DashboardV2Page`

**与 v1 的差异（实现时对照 `app/dashboard/page.tsx`）：**
- 复制：`DailyAnalysisRow` 类型（14 字段）、`US_TIMEZONE`、`getTodayInTimezone`、`addDays`、`loadData` 的竞态保护（`latestRequestRef`）、错误 notify
- 删除：all-countries fetch、projectBreakdown/country 相关 state、stockSnapshot、MotionStagger、metrics（v1 的 MetricTile 计算）
- 新增：`selectedProjectId` state（`'all'` = 全部项目 = v1 行为；否则单项目 id 字符串），`project_ids` 参数按选择拼接
- 简化：`DailyAnalysisResponse` 只声明 `summary_rows`（v2 不用 project_breakdown/detail_rows）

- [x] **Step 1: 写失败 smoke 测试**

```tsx
// frontend/app/dashboard/v2/page.test.tsx
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { name: '测试用户' } }, status: 'authenticated' }),
}))

vi.mock('@/lib/hooks/use-managed-projects', () => ({
  useManagedProjects: () => ({
    projects: [
      { id: 1, name: '项目A' },
      { id: 2, name: '项目B' },
    ],
    loading: false,
    error: null,
  }),
}))

vi.mock('@/components/notifications', () => ({
  useNotifications: () => ({ notify: vi.fn() }),
}))

vi.mock('@/components/dashboard-v2/v2-revenue-chart', () => ({
  V2RevenueChart: () => <div data-testid="v2-revenue-chart" />,
}))

vi.mock('@/components/dashboard-v2/v2-channel-chart', () => ({
  V2ChannelChart: () => <div data-testid="v2-channel-chart" />,
}))

import DashboardV2Page from './page'

const mockRows = [
  {
    date: '2026-07-31',
    order_qty: 10,
    sales_amount: 1000,
    impressions: 100,
    clicks: 50,
    cpc: 0.5,
    ad_spend: 200,
    ad_orders: 5,
    available_qty: 300,
    page_views: 800,
    units_ordered: 40,
    sessions: 600,
    ordered_sales_amount: 900,
    conversion_rate: 0.05,
  },
]

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ summary_rows: mockRows }),
      })
    )
  )
})

describe('DashboardV2Page', () => {
  it('渲染页面级项目选择器与返回旧版入口', async () => {
    render(<DashboardV2Page />)
    expect(screen.getByText('全部项目')).toBeInTheDocument()
    expect(screen.getByText('返回旧版')).toBeInTheDocument()
  })

  it('渲染 3 个 mock 区块', async () => {
    render(<DashboardV2Page />)
    expect(screen.getByText('Recent invoices')).toBeInTheDocument()
    expect(screen.getByText('Billing health')).toBeInTheDocument()
    expect(screen.getByText('Activity')).toBeInTheDocument()
  })

  it('fetch 后渲染真实数据区块（KPI + 两个图表）', async () => {
    render(<DashboardV2Page />)
    expect(await screen.findByText('销售额')).toBeInTheDocument()
    expect(screen.getByTestId('v2-revenue-chart')).toBeInTheDocument()
    expect(screen.getByTestId('v2-channel-chart')).toBeInTheDocument()
  })

  it('用选中的项目 id 请求 daily-analysis', async () => {
    render(<DashboardV2Page />)
    await screen.findByText('销售额')
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.length).toBeGreaterThan(0)
    expect(String(calls[0][0])).toContain('project_ids=1%2C2')
    expect(String(calls[0][0])).toContain('/api/backend/api/v1/daily-analysis/all')
  })
})
```

- [x] **Step 2: 运行测试确认失败**

Run: `cd frontend && pnpm exec vitest run app/dashboard/v2/page.test.tsx`
Expected: FAIL（`./page` 不存在）

- [x] **Step 3: 实现 v2/page.tsx**

```tsx
// frontend/app/dashboard/v2/page.tsx
'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from 'next-auth/react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

import { DashboardPageLoading } from '@/components/dashboard/dashboard-page-loading'
import { V2Activity } from '@/components/dashboard-v2/v2-activity'
import { V2Billing } from '@/components/dashboard-v2/v2-billing'
import { V2Grid } from '@/components/dashboard-v2/v2-grid'
import { V2Invoices } from '@/components/dashboard-v2/v2-invoices'
import { V2Stats } from '@/components/dashboard-v2/v2-stats'
import { useManagedProjects } from '@/lib/hooks/use-managed-projects'
import { formatYMD } from '@/lib/dashboard-format'
import { useNotifications } from '@/components/notifications'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'

// recharts 强依赖 window/document，必须 ssr:false 才能从首屏 bundle 拆出 ~400KB recharts 主体
const LazyV2RevenueChart = dynamic(
  () => import('@/components/dashboard-v2/v2-revenue-chart').then((m) => m.V2RevenueChart),
  {
    ssr: false,
    loading: () => (
      <div className="bg-background p-5 md:col-span-2">
        <Skeleton className="mb-2 h-5 w-24" />
        <Skeleton className="mb-4 h-3 w-40" />
        <Skeleton className="h-60 w-full md:h-80" />
      </div>
    ),
  }
)

const LazyV2ChannelChart = dynamic(
  () => import('@/components/dashboard-v2/v2-channel-chart').then((m) => m.V2ChannelChart),
  {
    ssr: false,
    loading: () => (
      <div className="bg-background p-5 md:col-span-2">
        <Skeleton className="mb-2 h-5 w-40" />
        <Skeleton className="mb-4 h-3 w-48" />
        <Skeleton className="h-60 w-full md:h-80" />
      </div>
    ),
  }
)

// 与 v1 app/dashboard/page.tsx 的 DailyAnalysisRow 保持一致
type DailyAnalysisRow = {
  date: string
  order_qty: number
  sales_amount: number
  impressions: number
  clicks: number
  cpc: number
  ad_spend: number
  ad_orders: number
  available_qty: number
  page_views: number
  units_ordered: number
  sessions: number
  ordered_sales_amount: number
  conversion_rate: number
}

type DailyAnalysisResponse = {
  summary_rows: DailyAnalysisRow[]
}

const US_TIMEZONE = 'America/Los_Angeles'

/** 页面级项目过滤选项：'all' = 全部项目（= v1 行为） */
const ALL_PROJECTS = 'all'

function getTodayInTimezone(tz: string): Date {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: tz })
  const now = new Date()
  const [y, m, d] = formatter.format(now).split('-').map(Number)
  return new Date(y!, m! - 1, d!)
}

function addDays(date: Date, amount: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + amount)
  return next
}

export default function DashboardV2Page() {
  const { status } = useSession()
  const { notify } = useNotifications()

  const today = useMemo(() => getTodayInTimezone(US_TIMEZONE), [])
  const yesterday = useMemo(() => addDays(today, -1), [today])
  const dateRange = useMemo(
    () => ({
      from: addDays(yesterday, -6),
      to: yesterday,
    }),
    [yesterday]
  )

  const { projects, loading: projectsLoading, error: projectsError } = useManagedProjects()
  const [selectedProjectId, setSelectedProjectId] = useState<string>(ALL_PROJECTS)
  const [currentRows, setCurrentRows] = useState<DailyAnalysisRow[]>([])
  const [comparisonRows, setComparisonRows] = useState<DailyAnalysisRow[]>([])
  const [dataLoading, setDataLoading] = useState(false)
  const latestRequestRef = useRef(0)

  useEffect(() => {
    if (projectsError) {
      notify({ type: 'error', title: '项目列表加载失败' })
    }
  }, [projectsError, notify])

  const loadData = useCallback(async () => {
    if (projects.length === 0) return
    const ids =
      selectedProjectId === ALL_PROJECTS
        ? projects.map((p) => String(p.id)).join(',')
        : selectedProjectId
    if (!ids) return

    const startDate = formatYMD(dateRange.from)
    const endDate = formatYMD(dateRange.to)

    const currentDayCount =
      Math.floor((dateRange.to.getTime() - dateRange.from.getTime()) / 86400000) + 1
    const prevFrom = addDays(dateRange.from, -currentDayCount)
    const prevTo = addDays(dateRange.from, -1)

    const requestId = ++latestRequestRef.current
    setDataLoading(true)

    try {
      const params = new URLSearchParams({
        project_ids: ids,
        country: 'US',
        start_date: startDate,
        end_date: endDate,
      })
      const compareParams = new URLSearchParams({
        project_ids: ids,
        country: 'US',
        start_date: formatYMD(prevFrom),
        end_date: formatYMD(prevTo),
      })

      const [response, compareResponse] = await Promise.all([
        fetch(`/api/backend/api/v1/daily-analysis/all?${params.toString()}`, {
          cache: 'no-store',
        }),
        fetch(`/api/backend/api/v1/daily-analysis/all?${compareParams.toString()}`, {
          cache: 'no-store',
        }),
      ])

      if (!response.ok) {
        const payload = await response.json().catch(() => null)
        throw new Error(payload?.detail || '销售数据加载失败')
      }

      const payload = (await response.json()) as DailyAnalysisResponse
      const comparePayload = compareResponse.ok
        ? ((await compareResponse.json()) as DailyAnalysisResponse)
        : null

      if (requestId !== latestRequestRef.current) return

      setCurrentRows(payload.summary_rows)
      setComparisonRows(comparePayload?.summary_rows ?? [])
    } catch (err) {
      if (requestId !== latestRequestRef.current) return
      notify({
        type: 'error',
        title: '数据加载失败',
        message: err instanceof Error ? err.message : '加载失败',
      })
      setCurrentRows([])
      setComparisonRows([])
    } finally {
      if (requestId !== latestRequestRef.current) return
      setDataLoading(false)
    }
  }, [projects, selectedProjectId, dateRange, notify])

  useEffect(() => {
    if (projects.length > 0) void loadData()
  }, [projects, loadData])

  if (status === 'loading') {
    return <DashboardPageLoading />
  }

  const anyLoading = dataLoading || projectsLoading
  const hasData = currentRows.length > 0

  return (
    <div className="space-y-4">
      {/* 顶部工具栏：页面级项目过滤 + 返回旧版 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Select value={selectedProjectId} onValueChange={setSelectedProjectId}>
          <SelectTrigger className="h-8 w-[180px] text-xs">
            <SelectValue placeholder="选择项目" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_PROJECTS}>全部项目</SelectItem>
            {projects.map((p) => (
              <SelectItem key={p.id} value={String(p.id)}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button asChild size="sm" variant="ghost">
          <Link href="/dashboard">
            <ArrowLeft className="mr-1 h-4 w-4" />
            返回旧版
          </Link>
        </Button>
      </div>

      <V2Grid>
        {hasData || anyLoading ? (
          <>
            <V2Stats currentRows={currentRows} comparisonRows={comparisonRows} loading={anyLoading} />
            <LazyV2RevenueChart currentRows={currentRows} comparisonRows={comparisonRows} />
            <LazyV2ChannelChart currentRows={currentRows} comparisonRows={comparisonRows} />
          </>
        ) : (
          <div className="col-span-full flex flex-col items-center justify-center gap-3 bg-background py-16 text-sm text-muted-foreground">
            <span>暂无销售数据</span>
            <Button onClick={() => void loadData()} size="sm" variant="outline">
              重试
            </Button>
          </div>
        )}
        <V2Invoices />
        <V2Billing />
        <V2Activity />
      </V2Grid>
    </div>
  )
}
```

- [x] **Step 4: 运行测试确认通过**

Run: `cd frontend && pnpm exec vitest run app/dashboard/v2/page.test.tsx`
Expected: 4 tests PASS

- [x] **Step 5: Commit**

```bash
git add app/dashboard/v2/page.tsx app/dashboard/v2/page.test.tsx
git commit -m "feat(前端): 新增 v2 dashboard 页面与项目级过滤"
```

---

### Task 8: v1"试试新版"按钮 + staging 清理 + 全量验证

**Files:**
- Modify: `frontend/app/dashboard/page.tsx`（仅加按钮，不动任何逻辑）
- Delete: `<仓库根>/.efferd-staging/`

**Interfaces:**
- Consumes: `next/link`、`lucide-react`（Sparkles）、`@/components/ui/button`

- [x] **Step 1: 在 v1 页面顶部加"试试新版"按钮**

在 `app/dashboard/page.tsx` 的 `return (` 内、第一个 `<section>` 之前插入工具栏行。v1 页面结构是 `<div className="space-y-5">` 直接包三个 section，在 section 1 前加：

```tsx
      {/* v2 实验入口——临时，实验结束后移除 */}
      <div className="flex justify-end">
        <Button asChild size="sm" variant="ghost">
          <Link href="/dashboard/v2">
            试试新版
            <Sparkles className="ml-1 h-4 w-4" />
          </Link>
        </Button>
      </div>
```

并在文件顶部 import 区补充：

```tsx
import Link from 'next/link'
import { Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
```

（检查是否已有同名 import，避免重复。）

- [x] **Step 2: 删除 staging 目录**

```bash
cd frontend
rm -rf ../.efferd-staging
```

- [x] **Step 3: 全量验证**

```bash
cd frontend
pnpm lint
pnpm build
pnpm test
```

Expected: 三步全绿。lint 若报新文件问题立即修；build 确认 `/dashboard/v2` 路由出现在输出；test 确认新增 16 个测试（delta 5 + stats 7 + page 4）与既有测试全过。

- [x] **Step 4: Commit**

```bash
git add app/dashboard/page.tsx
git commit -m "feat(前端): v1 dashboard 增加新版入口"
```

- [x] **Step 5: 手动验证清单（交用户）**

启动 `pnpm dev`，逐项确认：

- [x] `/dashboard` 右上角出现"试试新版"，点击跳转 `/dashboard/v2`
- [x] `/dashboard/v2` 顶部有项目选择器（默认"全部项目"）+ "返回旧版"按钮，点击返回 `/dashboard`
- [x] 亮色/暗色主题下：发丝线网格、纯平卡片、Delta 绿涨红跌均正常
- [x] 4 个 KPI 卡显示中文标签 + `$` 金额 + 环比 delta
- [x] 销售额柱状图（渐变柱）与双折线图渲染，tooltip 可用
- [x] 切换单个项目后 KPI/图表数据刷新；切回"全部项目"恢复
- [x] Recent invoices / Billing health / Activity 三个 mock 区块显示英文占位内容
- [x] 移动端（<768px）回退 1 列布局
- [x] 断网或后端挂掉时：真实数据区显示"暂无销售数据 + 重试"，mock 区块不受影响

---

## 风险与备注

- **efferd.com registry 可用性**：Task 1 依赖 `efferd.com/r/dashboard-2.json`。若下载失败，备选：从 21st.dev 组件页 Code 标签手动复制（URL 见 spec §来源）。
- **staging 位置**：必须在仓库根（frontend/ 外），否则 sample 源码的不存在 import 会被 `tsc --noEmit` 扫到而报错。
- **`empty` 组件导出名**：shadcn `empty` 是较新组件，若 CLI 版本过老无此组件，从 shadcn 官网手动复制 `empty.tsx` 到 `components/ui/`。
- **ProjectSelect 偏离**：spec 原写"复用 ProjectSelect"，实际该组件无"全部项目"选项且 `autoSelectFirst` 默认选中第一个项目，与"默认全部"冲突——故 Task 7 直接用 `@/components/ui/select`。功能等价，交互更符合需求。
