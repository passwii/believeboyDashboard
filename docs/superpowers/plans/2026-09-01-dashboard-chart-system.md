# Dashboard 首页图表系统化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Dashboard 首页图表区从 terminal 黑底风重构为 surface 面板风（非纯黑、圆角、成对阴影、留白间距），并以统一 `ChartCard` 壳组件组件化，为跨页面复用铺路。

**Architecture:** 三层收口——视觉令牌层（V2Card/V2Grid 对齐 `--surface-*`/`--shadow-level-*`）→ 壳层（新增 `ChartCard`，统一图标/标题/Delta/描述/操作区/页脚/加载/空态）→ 图表本体层（现有 `charts/cards.tsx` 不动）。6 个 v2 图表收敛到 ChartCard，KPI/TopProjects 对齐新容器，最后跨页推广。

**Tech Stack:** Next.js 14 (app router) · React 18 · recharts · Tailwind CSS 3 · shadcn/ui · Vitest + @testing-library/react

## Global Constraints

- **前端测试顺序**：`cd frontend && pnpm lint && pnpm build && pnpm test`，每 Task 结束必须全绿。
- **不修改**：`charts/cards.tsx`、`charts/primitives.tsx`、`ui/chart.tsx`、`ui/card.tsx`（图表本体与卡片基座保持不动；`ui/card` 基座是 term 风，`ChartCard` 自主渲染不依赖它）。
- **保留导出名**：`V2Card` / `V2Grid` 文件名与导出名不变（影响面最小），仅内部换令牌。
- **无硬编码 hex**：图表颜色走 `--chart-N` / `var(--color-*)`；禁止 `#2563eb` 等字面量（BLF-495 验收基线）。
- **骨架与正式卡同构**（BLF-504 教训）：ChartCard 加载骨架高度与正式图一致。
- **commit**：author email 必须 `jr.way123@gmail.com`，中文 Conventional Commits + `Closes BLF-XXX` 相关引用。
- **影响面**（已 CodeGraph/grep 确认）：`V2Card` 消费者 8 文件；`V2Grid` 仅 `page.tsx`；`charts/*` 消费者含 portfolio(2)+monthly-report+digital-display，**不得破坏**。

---

## Stage 0：令牌基座

### Task 0.1: V2Card 改 surface 圆角卡

**Files:**
- Modify: `frontend/components/dashboard-v2/v2-card.tsx`
- Test: `frontend/components/dashboard-v2/v2-card.test.tsx`

**Interfaces:**
- Consumes: `Card` from `@/components/ui/card`（term 基座，需覆盖）、`cn` from `@/lib/utils`（twMerge，后者胜）
- Produces: `V2Card`（props 不变：`React.ComponentProps<typeof Card>`）

- [ ] **Step 1: 改写测试断言**

`frontend/components/dashboard-v2/v2-card.test.tsx` 全文替换为：

```tsx
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { V2Card } from './v2-card'

describe('V2Card', () => {
  it('surface 面板风：圆角 + 边框 + 卡片背景 + 阴影令牌', () => {
    const { container } = render(<V2Card>content</V2Card>)
    const card = container.firstElementChild as HTMLElement
    expect(card).toBeTruthy()
    // 从 terminal 直角（rounded-none border-0）改为 surface 圆角卡（BLF-911 收口）
    expect(card.className).toContain('rounded-lg')
    expect(card.className).toContain('bg-card')
    expect(card.className).toContain('shadow-soft')
    expect(card.className).not.toContain('rounded-none')
    expect(card.className).not.toContain('border-0')
  })

  it('保留自定义 className 追加能力', () => {
    const { container } = render(<V2Card className="md:col-span-2">content</V2Card>)
    expect(container.firstElementChild?.className).toContain('md:col-span-2')
    expect(container.firstElementChild?.className).toContain('rounded-lg')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd frontend && npx vitest run components/dashboard-v2/v2-card.test.tsx`
Expected: FAIL（当前断言 `border-0`/`rounded-none` 与新断言不符）

- [ ] **Step 3: 改写 V2Card**

`frontend/components/dashboard-v2/v2-card.tsx` 全文替换为：

```tsx
import type * as React from 'react'

import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'

/**
 * BLF-911 收口：Dashboard 首页卡片从 terminal 黑底（rounded-none + border-0 +
 * bg-term-panel）改为 surface 面板风——圆角 + 边框 + 卡片背景 + 成对阴影。
 * light 走 shadow-soft，dark 走 shadow-level-2（Raycast 式成对阴影，BLF-573）。
 * 保留导出名与 props 签名，消费者零改动；仅视觉令牌变更。
 */
export function V2Card({ className, ...props }: React.ComponentProps<typeof Card>) {
  return (
    <Card
      className={cn(
        'rounded-lg border-border bg-card text-card-foreground shadow-soft',
        'dark:border-border/70 dark:shadow-level-2',
        className
      )}
      {...props}
    />
  )
}
```

> 说明：`Card` 基座 `TERM_PANEL_SURFACE` 的 `rounded-none`/`border-0` 无（基座是 `border`），twMerge 使后写 `rounded-lg`/`bg-card`/`text-card-foreground`/`shadow-soft` 胜出；`border-border` 覆盖基座 `border-term-border`。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd frontend && npx vitest run components/dashboard-v2/v2-card.test.tsx`
Expected: PASS

- [ ] **Step 5: 全量前端测试**

Run: `cd frontend && pnpm lint && pnpm build && pnpm test`
Expected: 全绿（无其它文件依赖 V2Card 的 `border-0` 断言）

- [ ] **Step 6: Commit**

```bash
git add frontend/components/dashboard-v2/v2-card.tsx frontend/components/dashboard-v2/v2-card.test.tsx
git commit -m "refactor(dashboard): V2Card 对齐 surface 面板风圆角卡（BLF-911）"
```

### Task 0.2: V2Grid 改留白间距

**Files:**
- Modify: `frontend/components/dashboard-v2/v2-grid.tsx`

**Interfaces:**
- Consumes: `cn` from `@/lib/utils`
- Produces: `V2Grid`（children/className props 不变）

- [ ] **Step 1: 改写 V2Grid**

`frontend/components/dashboard-v2/v2-grid.tsx` 全文替换为：

```tsx
import type * as React from 'react'

import { cn } from '@/lib/utils'

/** 卡片网格（BLF-911 收口）：发丝线分隔（gap-px + bg）→ 留白间距。
 * 保留 grid-cols-2 / lg:grid-cols-4 与 col-span 语义，仅改间距。
 * 移动端 gap-3，md+ 放大到 gap-4（布局密度不变，视觉从"面板拼接"变"卡片阵列"）。
 */
export function V2Grid({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('grid grid-cols-2 gap-3 md:gap-4 lg:grid-cols-4', className)}>
      {children}
    </div>
  )
}
```

- [ ] **Step 2: 验证**

Run: `cd frontend && pnpm lint && pnpm build`
Expected: 通过（V2Grid 无独立测试文件，视觉回归由 Stage 2 图表迁移后统一确认）

- [ ] **Step 3: Commit**

```bash
git add frontend/components/dashboard-v2/v2-grid.tsx
git commit -m "refactor(dashboard): V2Grid 发丝线网格改留白间距（BLF-911）"
```

---

## Stage 1：ChartCard 壳组件

### Task 1.1: 新增 ChartCard 组件

**Files:**
- Create: `frontend/components/charts/chart-card.tsx`
- Create: `frontend/components/charts/chart-card.test.tsx`
- Modify: `frontend/components/charts/index.ts`

**Interfaces:**
- Consumes: `cn`、`Delta`/`DeltaIcon`/`DeltaValue` from `@/components/ui/delta`、`Skeleton` from `@/components/ui/skeleton`
- Produces: `ChartCard`（下方完整 props）—— 供 Stage 2/3 各图表消费，Stage 4 跨页复用

```tsx
export interface ChartCardDelta {
  value: number
  variant?: 'default' | 'badge'
}

export interface ChartCardProps {
  icon?: React.ReactNode
  title: React.ReactNode
  description?: React.ReactNode
  delta?: ChartCardDelta
  actions?: React.ReactNode
  footer?: React.ReactNode
  className?: string
  loading?: boolean
  empty?: boolean
  emptyText?: string
  heightClass?: string
  children: React.ReactNode
}

export function ChartCard(props: ChartCardProps): React.ReactElement
```

- [ ] **Step 1: 写失败测试**

`frontend/components/charts/chart-card.test.tsx`：

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TrendingUp } from 'lucide-react'

import { ChartCard } from './chart-card'

describe('ChartCard', () => {
  it('渲染表头：icon + 标题 + 描述 + delta 徽章', () => {
    render(
      <ChartCard
        icon={<TrendingUp data-testid="icon" />}
        title="销售额"
        description="近 7 天"
        delta={{ value: 12.5 }}
      >
        <div>图表内容</div>
      </ChartCard>
    )
    expect(screen.getByText('销售额')).toBeInTheDocument()
    expect(screen.getByText('近 7 天')).toBeInTheDocument()
    expect(screen.getByTestId('icon')).toBeInTheDocument()
    // delta 徽章：+12.5%
    expect(screen.getByText('12.5%')).toBeInTheDocument()
    expect(screen.getByText('图表内容')).toBeInTheDocument()
  })

  it('渲染 actions 与 footer 插槽', () => {
    render(
      <ChartCard title="项目排行" actions={<button>销售额</button>} footer={<span>共 6 项</span>}>
        <div>内容</div>
      </ChartCard>
    )
    expect(screen.getByRole('button', { name: '销售额' })).toBeInTheDocument()
    expect(screen.getByText('共 6 项')).toBeInTheDocument()
  })

  it('loading 时渲染骨架而非内容', () => {
    render(
      <ChartCard title="库存" loading>
        <div>不应出现</div>
      </ChartCard>
    )
    expect(screen.queryByText('不应出现')).not.toBeInTheDocument()
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull()
  })

  it('empty 时渲染空态文案', () => {
    render(
      <ChartCard title="国家" empty emptyText="暂无国家数据">
        <div>不应出现</div>
      </ChartCard>
    )
    expect(screen.getByText('暂无国家数据')).toBeInTheDocument()
    expect(screen.queryByText('不应出现')).not.toBeInTheDocument()
  })

  it('className 透传（col-span 等布局）', () => {
    const { container } = render(<ChartCard title="测试" className="col-span-2"><div /></ChartCard>)
    expect(container.firstElementChild?.className).toContain('col-span-2')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd frontend && npx vitest run components/charts/chart-card.test.tsx`
Expected: FAIL（`Cannot find module './chart-card'`）

- [ ] **Step 3: 实现 ChartCard**

`frontend/components/charts/chart-card.tsx`：

```tsx
'use client'

import * as React from 'react'

import { Delta, DeltaIcon, DeltaValue } from '@/components/ui/delta'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

/**
 * 统一图表卡壳（BLF-911 收口）：图标徽章 + 标题 + Delta + 描述 + 操作区 +
 * 页脚 + 加载骨架 + 空态占位，全部收敛到一处，供全站图表卡复用。
 *
 * 与 `charts/cards.tsx` 的 `*ChartCard`（纯图表本体）区分：本组件是「卡 + 表头 + 状态」，
 * 图表本体仍由 LineChartCard / BarChartCard / … 负责，作为 children 传入。
 *
 * 视觉：surface 面板风（rounded-lg + border + bg-card + 成对阴影），
 * 非 terminal 黑底。不依赖 ui/card（其基座为 term 风），自主渲染。
 */
export interface ChartCardDelta {
  value: number
  variant?: 'default' | 'badge'
}

export interface ChartCardProps {
  /** 表头左侧图标徽章内容（lucide 图标组件实例，size-4 由内部统一） */
  icon?: React.ReactNode
  /** 卡片标题 */
  title: React.ReactNode
  /** 副标题描述 */
  description?: React.ReactNode
  /** 涨跌徽章（复用 ui/delta） */
  delta?: ChartCardDelta
  /** 表头右侧操作区（如 TopProjects 排序 tab） */
  actions?: React.ReactNode
  /** 页脚（CardFooter 区） */
  footer?: React.ReactNode
  /** 透传容器 className（col-span 等布局类） */
  className?: string
  /** 数据加载中 → 图表区渲染骨架（高度同 heightClass） */
  loading?: boolean
  /** 数据为空 → 图表区渲染空态占位 */
  empty?: boolean
  /** 空态文案，默认「暂无数据」 */
  emptyText?: string
  /** 图表区高度类（加载骨架 / 空态占位共用），默认与 charts defaultChartContainerClass 一致 */
  heightClass?: string
  /** 图表本体（LineChartCard / BarChartCard / …） */
  children: React.ReactNode
}

export function ChartCard({
  icon,
  title,
  description,
  delta,
  actions,
  footer,
  className,
  loading = false,
  empty = false,
  emptyText = '暂无数据',
  heightClass = 'aspect-auto h-52 w-full md:h-64',
  children,
}: ChartCardProps) {
  const showSkeleton = loading && !empty
  const showEmpty = empty && !loading

  return (
    <div
      className={cn(
        'flex flex-col gap-0 overflow-hidden rounded-lg border border-border bg-card text-card-foreground',
        'shadow-soft dark:border-border/70 dark:shadow-level-2',
        className
      )}
    >
      {(title != null || description != null || delta != null || actions != null) && (
        <div className="flex flex-col gap-2 p-5 pb-2">
          <div className="flex flex-wrap items-center gap-2">
            {icon != null && (
              <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-blue-100 text-blue-600 dark:bg-[hsl(var(--surface-subtle))] dark:text-muted-foreground">
                {icon}
              </span>
            )}
            <h3 className="text-base font-semibold leading-none tracking-tight text-foreground">
              {title}
            </h3>
            {delta != null && (
              <Delta value={delta.value} variant={delta.variant ?? 'badge'}>
                <DeltaIcon variant="trend" />
                <DeltaValue />
              </Delta>
            )}
            {actions != null && <div className="ml-auto flex items-center gap-2">{actions}</div>}
          </div>
          {description != null && <p className="text-xs text-muted-foreground">{description}</p>}
        </div>
      )}

      <div className="p-5 pt-2">
        {showSkeleton ? (
          <div className={cn(heightClass, 'w-full')} aria-busy="true" role="status">
            <Skeleton className="h-full w-full" />
          </div>
        ) : showEmpty ? (
          <div className={cn(heightClass, 'flex w-full items-center justify-center text-sm text-muted-foreground')}>
            <span>{emptyText}</span>
          </div>
        ) : (
          children
        )}
      </div>

      {footer != null && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-border/60 px-5 py-3">
          {footer}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: barrel 导出**

`frontend/components/charts/index.ts` 追加导出：

```ts
export * from './chart-card'
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd frontend && npx vitest run components/charts/chart-card.test.tsx`
Expected: PASS

- [ ] **Step 6: 全量前端测试**

Run: `cd frontend && pnpm lint && pnpm build && pnpm test`
Expected: 全绿

- [ ] **Step 7: Commit**

```bash
git add frontend/components/charts/chart-card.tsx frontend/components/charts/chart-card.test.tsx frontend/components/charts/index.ts
git commit -m "feat(charts): 新增统一 ChartCard 壳组件（图标/标题/Delta/操作区/页脚/加载/空态）"
```

---

## Stage 2：6 个图表迁移到 ChartCard

> 每个迁移任务模式相同：删掉手写 `V2Card + CardHeader/Title/Description + icon 徽章 + CardContent`，改为 `<ChartCard>` 消费。空态/加载态统一交给 ChartCard。图表本体配置不变。

### Task 2.1: v2-revenue-chart 迁移

**Files:**
- Modify: `frontend/components/dashboard-v2/v2-revenue-chart.tsx`

**Interfaces:**
- Consumes: `ChartCard` from `@/components/charts`（Task 1.1）、`ComposedChartCard`/`buildChartConfig`、`formatCompactCurrency`
- Produces: `V2RevenueChart`（props 增加可选 `loading?: boolean`，页面传 `anyLoading`）

- [ ] **Step 1: 迁移组件**

`frontend/components/dashboard-v2/v2-revenue-chart.tsx` 全文替换为：

```tsx
'use client'

import { TrendingUp } from 'lucide-react'

import { ChartCard, ComposedChartCard, buildChartConfig } from '@/components/charts'
import { formatCompactCurrency } from './v2-format'

type RevenueRow = { date: string; sales_amount: number; units_ordered: number }

export interface V2RevenueChartProps {
  currentRows: RevenueRow[]
  comparisonRows?: RevenueRow[]
  loading?: boolean
}

const chartConfig = buildChartConfig(
  ['sales', 'volume'],
  { sales: '销售额', volume: '销量' }
)

/** ISO 日期 → "M/D" */
function dayLabel(isoDate: string): string {
  const [, m, d] = isoDate.split('-')
  return `${Number(m)}/${Number(d)}`
}

export function V2RevenueChart({
  currentRows,
  comparisonRows = [],
  loading = false,
}: V2RevenueChartProps) {
  // 销售额（左轴柱） + 销量（右轴折线）—— 复合图增强数据观察性
  const chartRows = currentRows.map((r) => ({
    day: dayLabel(r.date),
    sales: r.sales_amount,
    volume: r.units_ordered ?? 0,
  }))
  const total = currentRows.reduce((s, r) => s + r.sales_amount, 0)
  const prevTotal = comparisonRows.reduce((s, r) => s + r.sales_amount, 0)
  const delta = prevTotal > 0 ? ((total - prevTotal) / prevTotal) * 100 : 0
  const hasData = chartRows.length > 0

  return (
    <ChartCard
      icon={<TrendingUp className="size-4" />}
      title="销售额"
      description="每日销售额与销量（近 7 天）"
      delta={{ value: delta, variant: 'badge' }}
      loading={loading && !hasData}
      empty={!hasData}
      emptyText="暂无销售数据"
      className="col-span-2"
    >
      <ComposedChartCard
        data={chartRows}
        xKey="day"
        config={chartConfig}
        dualAxis
        yTickFormatter={formatCompactCurrency}
        series={[
          { kind: 'bar', dataKey: 'sales', name: '销售额', yAxisId: 'left' },
          { kind: 'line', dataKey: 'volume', name: '销量', yAxisId: 'right' },
        ]}
      />
    </ChartCard>
  )
}
```

> 删除原文件未使用的 `CustomGradientBar`（死代码）与 `CardHeader/Title/Description/Content`、`V2Card`、`Delta*` 导入。

- [ ] **Step 2: 验证**

Run: `cd frontend && pnpm lint && pnpm build`
Expected: 通过

- [ ] **Step 3: Commit**

```bash
git add frontend/components/dashboard-v2/v2-revenue-chart.tsx
git commit -m "refactor(dashboard): v2-revenue-chart 收敛到 ChartCard 壳（BLF-911）"
```

### Task 2.2: v2-channel-chart 迁移

**Files:**
- Modify: `frontend/components/dashboard-v2/v2-channel-chart.tsx`

**Interfaces:**
- Consumes: `ChartCard`、`LineChartCard`/`buildChartConfig`、`formatCompactCurrency`/`formatDate`
- Produces: `V2ChannelChart`（props 增加可选 `loading?: boolean`）

- [ ] **Step 1: 迁移组件**

`frontend/components/dashboard-v2/v2-channel-chart.tsx` 全文替换为：

```tsx
'use client'

import { BarChart3 } from 'lucide-react'

import { ChartCard, LineChartCard, buildChartConfig } from '@/components/charts'
import { formatCompactCurrency, formatDate } from './v2-format'

type ChannelRow = { date: string; sales_amount: number; ad_spend: number }

export interface V2ChannelChartProps {
  currentRows: ChannelRow[]
  comparisonRows?: ChannelRow[]
  loading?: boolean
}

const chartConfig = buildChartConfig(
  ['sales_amount', 'ad_spend'],
  { sales_amount: '销售额', ad_spend: '广告花费' }
)

export function V2ChannelChart({
  currentRows,
  comparisonRows = [],
  loading = false,
}: V2ChannelChartProps) {
  const total = currentRows.reduce((s, r) => s + r.sales_amount, 0)
  const prevTotal = comparisonRows.reduce((s, r) => s + r.sales_amount, 0)
  const delta = prevTotal > 0 ? ((total - prevTotal) / prevTotal) * 100 : 0

  const data = currentRows.map((r) => ({
    day: formatDate(r.date, 'day-month'),
    sales_amount: r.sales_amount,
    ad_spend: r.ad_spend,
  }))
  const hasData = data.length > 0

  return (
    <ChartCard
      icon={<BarChart3 className="size-4" />}
      title="销售额 vs 广告花费"
      description="每日销售额与广告花费对比（近 7 天，双轴）"
      delta={{ value: delta, variant: 'badge' }}
      loading={loading && !hasData}
      empty={!hasData}
      emptyText="暂无销售数据"
      className="col-span-2"
    >
      <LineChartCard
        data={data}
        xKey="day"
        config={chartConfig}
        dualAxis
        yTickFormatter={formatCompactCurrency}
        rightYFormatter={formatCompactCurrency}
        series={[
          { dataKey: 'sales_amount', name: '销售额', yAxisId: 'left' },
          {
            dataKey: 'ad_spend',
            name: '广告花费',
            yAxisId: 'right',
            lineProps: { strokeDasharray: '6 4', strokeWidth: 2 },
          },
        ]}
      />
    </ChartCard>
  )
}
```

- [ ] **Step 2: 验证**

Run: `cd frontend && pnpm lint && pnpm build`
Expected: 通过

- [ ] **Step 3: Commit**

```bash
git add frontend/components/dashboard-v2/v2-channel-chart.tsx
git commit -m "refactor(dashboard): v2-channel-chart 收敛到 ChartCard 壳（BLF-911）"
```

### Task 2.3: v2-project-chart 迁移

**Files:**
- Modify: `frontend/components/dashboard-v2/v2-project-chart.tsx`

**Interfaces:**
- Consumes: `ChartCard`、`BarChartCard`/`buildChartConfig`、`computeTopProjects`/types from `./v2-top-projects`
- Produces: `V2ProjectChart`（props 不变）

- [ ] **Step 1: 迁移组件**

`frontend/components/dashboard-v2/v2-project-chart.tsx` 全文替换为：

```tsx
'use client'

import { Store } from 'lucide-react'

import { BarChartCard, ChartCard, buildChartConfig } from '@/components/charts'

import {
  computeTopProjects,
  type V2ProjectBreakdownEntry,
  type V2ProjectOption,
} from './v2-top-projects'

export interface V2ProjectChartProps {
  projectBreakdown: Record<number, V2ProjectBreakdownEntry>
  projects: V2ProjectOption[]
  loading?: boolean
}

const chartConfig = buildChartConfig(['sales'], { sales: '销售额' })

/** 项目名过长截断（与表格一致） */
function truncateName(name: string, max = 10): string {
  return name.length > max ? `${name.slice(0, max)}…` : name
}

export function V2ProjectChart({ projectBreakdown, projects, loading }: V2ProjectChartProps) {
  const rows = computeTopProjects(projectBreakdown, undefined, projects, 'sales')
    .slice(0, 5)
    .map((r) => ({ name: truncateName(r.projectName), sales: r.totalSales }))
  const hasData = rows.length > 0

  return (
    <ChartCard
      icon={<Store className="size-4" />}
      title="项目销售额对比"
      description="近 7 天各项目销售额 Top 5"
      loading={loading && !hasData}
      empty={!hasData}
      emptyText="暂无项目数据"
      className="col-span-2"
    >
      <BarChartCard
        data={rows}
        xKey="name"
        series={[{ dataKey: 'sales' }]}
        config={chartConfig}
        yTickFormatter={(v) => `$${Number(v) / 1000}k`}
        showLegend={false}
      />
    </ChartCard>
  )
}
```

> 原 `Skeleton` 手写加载态由 ChartCard 接管。

- [ ] **Step 2: 验证**

Run: `cd frontend && pnpm lint && pnpm build`
Expected: 通过

- [ ] **Step 3: Commit**

```bash
git add frontend/components/dashboard-v2/v2-project-chart.tsx
git commit -m "refactor(dashboard): v2-project-chart 收敛到 ChartCard 壳（BLF-911）"
```

### Task 2.4: v2-country-chart 迁移

**Files:**
- Modify: `frontend/components/dashboard-v2/v2-country-chart.tsx`

**Interfaces:**
- Consumes: `ChartCard`、`BarChartCard`/`buildChartConfig`、`getCountryLabel`、`computeCountryTotals`
- Produces: `V2CountryChart`（props 不变）

- [ ] **Step 1: 迁移组件**

`frontend/components/dashboard-v2/v2-country-chart.tsx` 全文替换为：

```tsx
'use client'

import { Globe2 } from 'lucide-react'

import { BarChartCard, ChartCard, buildChartConfig } from '@/components/charts'
import { getCountryLabel } from '@/lib/country'

export interface V2CountryRow {
  date: string
  sales_amount: number
}

/** 后端 /all-countries 的 country_breakdown 简化形状 */
export interface V2CountryBreakdownEntry {
  summary_rows: V2CountryRow[]
}

export interface V2CountryAggRow {
  code: string
  label: string
  totalSales: number
}

const MAX_COUNTRIES = 6

/** 汇总 country_breakdown 按销售额排序取 Top N（纯函数，供测试） */
export function computeCountryTotals(
  countryRowsByCode: Record<string, V2CountryBreakdownEntry>
): V2CountryAggRow[] {
  const rows: V2CountryAggRow[] = []
  for (const code of Object.keys(countryRowsByCode)) {
    const summaryRows = countryRowsByCode[code]?.summary_rows
    if (!Array.isArray(summaryRows) || summaryRows.length === 0) continue
    const totalSales = summaryRows.reduce((s, r) => s + (r.sales_amount ?? 0), 0)
    rows.push({ code, label: getCountryLabel(code), totalSales })
  }
  return rows.sort((a, b) => b.totalSales - a.totalSales).slice(0, MAX_COUNTRIES)
}

export interface V2CountryChartProps {
  countryRowsByCode: Record<string, V2CountryBreakdownEntry>
  /** 代表项目名（用于描述文案） */
  representativeProjectName?: string | null
  loading?: boolean
}

const chartConfig = buildChartConfig(['sales'], { sales: '销售额' })

export function V2CountryChart({
  countryRowsByCode,
  representativeProjectName,
  loading,
}: V2CountryChartProps) {
  const rows = computeCountryTotals(countryRowsByCode).map((r) => ({
    name: r.label,
    sales: r.totalSales,
  }))
  const hasData = rows.length > 0

  return (
    <ChartCard
      icon={<Globe2 className="size-4" />}
      title="跨国家销售额"
      description={
        representativeProjectName
          ? `${representativeProjectName} · 各站点销售额分布`
          : '各站点销售额分布'
      }
      loading={loading && !hasData}
      empty={!hasData}
      emptyText="暂无国家数据"
      className="col-span-2"
    >
      <BarChartCard
        data={rows}
        xKey="name"
        series={[{ dataKey: 'sales', barProps: { radius: [0, 2, 2, 0] } }]}
        config={chartConfig}
        layout="horizontal"
        xTickFormatter={(value) => `$${Number(value) / 1000}k`}
        showLegend={false}
      />
    </ChartCard>
  )
}
```

> 原 `Skeleton` 手写加载态由 ChartCard 接管。

- [ ] **Step 2: 验证**

Run: `cd frontend && pnpm lint && pnpm build`
Expected: 通过

- [ ] **Step 3: Commit**

```bash
git add frontend/components/dashboard-v2/v2-country-chart.tsx
git commit -m "refactor(dashboard): v2-country-chart 收敛到 ChartCard 壳（BLF-911）"
```

### Task 2.5: v2-stock-chart 迁移

**Files:**
- Modify: `frontend/components/dashboard-v2/v2-stock-chart.tsx`

**Interfaces:**
- Consumes: `ChartCard`、`AreaChartCard`/`buildChartConfig`、`fmtNumPrecise`、`computeStockTrend`
- Produces: `V2StockChart`（props 不变）

- [ ] **Step 1: 迁移组件**

`frontend/components/dashboard-v2/v2-stock-chart.tsx` 全文替换为：

```tsx
'use client'

import { Boxes } from 'lucide-react'

import { AreaChartCard, ChartCard, buildChartConfig } from '@/components/charts'
import { fmtNumPrecise } from '@/lib/dashboard-format'

export interface V2StockRow {
  date: string
  available_qty: number
}

export interface V2StockTrend {
  /** 图表行：{ day, qty } */
  rows: { day: string; qty: number }[]
  /** 区间末库存快照 */
  current: number
  /** 上一周期末快照 */
  prev: number
  /** 环比 %（prev>0 时计算，否则 0） */
  delta: number
}

/** 由 summary_rows 计算库存趋势（纯函数，供测试） */
export function computeStockTrend(
  currentRows: V2StockRow[],
  comparisonRows: V2StockRow[] = []
): V2StockTrend {
  const rows = currentRows.map((r) => {
    const [, m, d] = r.date.split('-')
    return { day: `${Number(m)}/${Number(d)}`, qty: r.available_qty ?? 0 }
  })
  const current = rows.length > 0 ? rows[rows.length - 1].qty : 0
  const prev =
    comparisonRows.length > 0 ? (comparisonRows[comparisonRows.length - 1].available_qty ?? 0) : 0
  const delta = prev > 0 ? ((current - prev) / prev) * 100 : 0
  return { rows, current, prev, delta }
}

export interface V2StockChartProps {
  currentRows: V2StockRow[]
  comparisonRows?: V2StockRow[]
  loading?: boolean
}

const chartConfig = buildChartConfig(['qty'], { qty: '可用库存' })

export function V2StockChart({ currentRows, comparisonRows = [], loading }: V2StockChartProps) {
  const { rows, current, delta } = computeStockTrend(currentRows, comparisonRows)
  const hasData = rows.length > 0

  return (
    <ChartCard
      icon={<Boxes className="size-4" />}
      title="库存水位"
      description="可用库存每日变化（近 7 天）"
      delta={{ value: delta, variant: 'badge' }}
      loading={loading && !hasData}
      empty={!hasData}
      emptyText="暂无库存数据"
      className="col-span-2"
      actions={
        <div className="flex items-baseline gap-1.5">
          <span className="text-2xl font-semibold tabular-nums">{fmtNumPrecise(current)}</span>
          <span className="text-xs text-muted-foreground">件 · 区间末快照</span>
        </div>
      }
    >
      <AreaChartCard
        data={rows}
        xKey="day"
        series={[{ dataKey: 'qty' }]}
        config={chartConfig}
        gradient
      />
    </ChartCard>
  )
}
```

> 原「区间末快照」大数字由 header 底部移到 `actions`（表头右侧，避免与图表区拥挤），数据语义不变。

- [ ] **Step 2: 验证**

Run: `cd frontend && pnpm lint && pnpm build`
Expected: 通过

- [ ] **Step 3: Commit**

```bash
git add frontend/components/dashboard-v2/v2-stock-chart.tsx
git commit -m "refactor(dashboard): v2-stock-chart 收敛到 ChartCard 壳（BLF-911）"
```

### Task 2.6: v2-traffic-chart 迁移

**Files:**
- Modify: `frontend/components/dashboard-v2/v2-traffic-chart.tsx`

**Interfaces:**
- Consumes: `ChartCard`、`ComposedChartCard`/`buildChartConfig`、`fmtNumPrecise`、`computeTrafficStats`
- Produces: `V2TrafficChart`（props 不变）

- [ ] **Step 1: 迁移组件**

`frontend/components/dashboard-v2/v2-traffic-chart.tsx` 全文替换为：

```tsx
'use client'

import { Activity } from 'lucide-react'

import { ChartCard, ComposedChartCard, buildChartConfig } from '@/components/charts'
import { fmtNumPrecise } from '@/lib/dashboard-format'

export interface V2TrafficRow {
  date: string
  page_views: number
  units_ordered: number
  sessions: number
}

export interface V2TrafficStats {
  totalPageViews: number
  totalSessions: number
  totalUnitsOrdered: number
  /** units_ordered / page_views × 100 */
  conversionRatePct: number
}

/** 汇总流量指标（纯函数，供测试） */
export function computeTrafficStats(rows: V2TrafficRow[]): V2TrafficStats {
  let totalPageViews = 0
  let totalSessions = 0
  let totalUnitsOrdered = 0
  for (const r of rows) {
    totalPageViews += r.page_views ?? 0
    totalSessions += r.sessions ?? 0
    totalUnitsOrdered += r.units_ordered ?? 0
  }
  const conversionRatePct = totalPageViews > 0 ? (totalUnitsOrdered / totalPageViews) * 100 : 0
  return { totalPageViews, totalSessions, totalUnitsOrdered, conversionRatePct }
}

export interface V2TrafficChartProps {
  currentRows: V2TrafficRow[]
  loading?: boolean
}

const chartConfig = buildChartConfig(
  ['page_views', 'conversion_rate'],
  { page_views: '浏览量', conversion_rate: '转化率' }
)

/** ISO 日期 → "M/D" */
function dayLabel(isoDate: string): string {
  const [, m, d] = isoDate.split('-')
  return `${Number(m)}/${Number(d)}`
}

export function V2TrafficChart({ currentRows, loading }: V2TrafficChartProps) {
  const rows = currentRows.map((r) => {
    const pv = r.page_views ?? 0
    return {
      day: dayLabel(r.date),
      page_views: pv,
      conversion_rate: pv > 0 ? ((r.units_ordered ?? 0) / pv) * 100 : 0,
    }
  })
  const stats = computeTrafficStats(currentRows)
  const hasData = rows.length > 0

  return (
    <ChartCard
      icon={<Activity className="size-4" />}
      title="流量与转化"
      description="浏览量趋势与转化率（近 7 天）"
      loading={loading && !hasData}
      empty={!hasData}
      emptyText="暂无流量数据"
      className="col-span-2"
      footer={
        <>
          <span className="text-xs text-muted-foreground">
            总浏览量{' '}
            <b className="ml-1 tabular-nums text-blue-700 dark:text-foreground">
              {fmtNumPrecise(stats.totalPageViews)}
            </b>
          </span>
          <span className="text-xs text-muted-foreground">
            访客数{' '}
            <b className="ml-1 tabular-nums text-blue-700 dark:text-foreground">
              {fmtNumPrecise(stats.totalSessions)}
            </b>
          </span>
          <span className="text-xs text-muted-foreground">
            转化订单{' '}
            <b className="ml-1 tabular-nums text-blue-700 dark:text-foreground">
              {fmtNumPrecise(stats.totalUnitsOrdered)}
            </b>
          </span>
          <span className="text-xs text-muted-foreground">
            平均转化率{' '}
            <b className="ml-1 tabular-nums text-blue-700 dark:text-foreground">
              {stats.conversionRatePct.toFixed(2)}%
            </b>
          </span>
        </>
      }
    >
      <ComposedChartCard
        data={rows}
        xKey="day"
        config={chartConfig}
        dualAxis
        rightYFormatter={(v) => `${v}%`}
        series={[
          { kind: 'bar', dataKey: 'page_views', name: '浏览量', yAxisId: 'left' },
          {
            kind: 'line',
            dataKey: 'conversion_rate',
            name: '转化率',
            yAxisId: 'right',
          },
        ]}
      />
    </ChartCard>
  )
}
```

> 原 `CardFooter` 手写页脚移入 ChartCard `footer` 插槽。

- [ ] **Step 2: 验证**

Run: `cd frontend && pnpm lint && pnpm build`
Expected: 通过

- [ ] **Step 3: Commit**

```bash
git add frontend/components/dashboard-v2/v2-traffic-chart.tsx
git commit -m "refactor(dashboard): v2-traffic-chart 收敛到 ChartCard 壳（BLF-911）"
```

### Task 2.7: 页面补 loading 传递 + 空态/骨架对齐

**Files:**
- Modify: `frontend/app/dashboard/page.tsx`

**Interfaces:**
- Consumes: `V2RevenueChart`/`V2ChannelChart` 新增的 `loading` prop（Task 2.1/2.2）
- Produces: 页面数据流不变，仅 props 补全

- [ ] **Step 1: 补 loading 传递**

`frontend/app/dashboard/page.tsx` 中两处调用：

```tsx
{/* 原 */}
<V2RevenueChart currentRows={currentRows} comparisonRows={comparisonRows} />
{/* 改 */}
<V2RevenueChart currentRows={currentRows} comparisonRows={comparisonRows} loading={anyLoading} />

{/* 原 */}
<V2ChannelChart currentRows={currentRows} comparisonRows={comparisonRows} />
{/* 改 */}
<V2ChannelChart currentRows={currentRows} comparisonRows={comparisonRows} loading={anyLoading} />
```

- [ ] **Step 2: 页面级空态卡对齐新容器**

`page.tsx` 中「暂无销售数据」空态卡当前用 `V2Card className="col-span-full gap-0"`，其内部 `border-term-border`/`text-term-muted`/`hover:text-term-text` 改为 surface 色（保留行为，仅换令牌）：

```tsx
<V2Card className="col-span-full gap-0">
  <div className="flex flex-col items-center justify-center gap-3 py-16 text-sm text-muted-foreground">
    <span>暂无销售数据</span>
    <button
      type="button"
      onClick={() => void loadData()}
      className="border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
    >
      重试
    </button>
  </div>
</V2Card>
```

- [ ] **Step 3: 验证**

Run: `cd frontend && pnpm lint && pnpm build && pnpm test`
Expected: 全绿

- [ ] **Step 4: Commit**

```bash
git add frontend/app/dashboard/page.tsx
git commit -m "refactor(dashboard): 首页补图表 loading 传递并对齐空态卡令牌（BLF-911）"
```

---

## Stage 3：周边组件对齐

### Task 3.1: V2Stats 对齐新容器

**Files:**
- Modify: `frontend/components/dashboard-v2/v2-stats.tsx`

**Interfaces:**
- Consumes: `V2Card`（Task 0.1 已改 surface）、`ui/delta`
- Produces: `V2Stats`（props 不变）；`computeStats` 纯函数不动

- [ ] **Step 1: 迁移容器样式**

`frontend/components/dashboard-v2/v2-stats.tsx` 中两处：

```tsx
{/* 原 KPI 卡 */}
<V2Card className="transition-colors hover:bg-term-raised" key={s.label}>
  <CardHeader className="flex flex-row items-center justify-between px-4 pb-0 pt-3 md:px-4">
    <CardTitle className="text-xs font-normal tracking-wide text-term-muted">{s.label}</CardTitle>
    …
  </CardHeader>
  <CardContent className="flex flex-row items-center gap-2 px-4 pb-3 md:px-4">
    <p className="font-mono text-xl font-semibold tabular-nums text-term-text">{s.value}</p>
  </CardContent>
</V2Card>

{/* 改为 */}
<V2Card className="transition-colors hover:bg-surface-subtle" key={s.label}>
  <CardHeader className="flex flex-row items-center justify-between px-4 pb-0 pt-3 md:px-4">
    <CardTitle className="text-xs font-normal tracking-wide text-muted-foreground">{s.label}</CardTitle>
    …
  </CardHeader>
  <CardContent className="flex flex-row items-center gap-2 px-4 pb-3 md:px-4">
    {/* 保留 tabular-nums 数据感；去掉 font-mono（视觉更系统，对齐 ChartCard 数字语言） */}
    <p className="text-xl font-semibold tabular-nums text-foreground">{s.value}</p>
  </CardContent>
</V2Card>
```

- [ ] **Step 2: 验证（含既有测试）**

Run: `cd frontend && pnpm lint && pnpm build && pnpm test`
Expected: 全绿（v2-stats.test.tsx 只断言 label/骨架类 `.u-skeleton-shimmer`，不受影响）

- [ ] **Step 3: Commit**

```bash
git add frontend/components/dashboard-v2/v2-stats.tsx
git commit -m "refactor(dashboard): V2Stats 对齐 surface 卡片与数字语言（BLF-911）"
```

### Task 3.2: V2TopProjects 对齐新容器

**Files:**
- Modify: `frontend/components/dashboard-v2/v2-top-projects.tsx`

**Interfaces:**
- Consumes: `ChartCard`（Task 1.1，用 `actions` 放排序 tab）、`V2Card` 不再需要
- Produces: `V2TopProjects`（props 不变）；`computeTopProjects` 纯函数不动

- [ ] **Step 1: 迁移到 ChartCard 壳**

`frontend/components/dashboard-v2/v2-top-projects.tsx` 的 JSX 部分（保持数据计算不变）改为：

```tsx
  return (
    <ChartCard
      title="项目排行"
      description="各项目销售额与广告花费对比（近 7 天）"
      className="col-span-2 lg:col-span-4"
      actions={
        <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
          {(
            [
              { key: 'sales' as const, label: '销售额' },
              { key: 'ad_spend' as const, label: '广告花费' },
            ]
          ).map((tab) => (
            <button
              className={cn(
                'rounded px-2 py-1 text-xs transition-colors',
                sortKey === tab.key
                  ? 'bg-blue-100 font-medium text-blue-700 dark:bg-[hsl(var(--surface-subtle))] dark:text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              key={tab.key}
              onClick={() => setSortKey(tab.key)}
              type="button"
            >
              {tab.label}
            </button>
          ))}
        </div>
      }
      loading={loading && rows.length === 0}
      empty={rows.length === 0}
      emptyText="暂无项目数据"
    >
      {rows.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="ps-6">项目</TableHead>
              <TableHead className="text-right">销售额</TableHead>
              <TableHead className="text-right">广告花费</TableHead>
              <TableHead className="text-right">订单量</TableHead>
              <TableHead className="pe-6 text-right">环比</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow className="h-12" key={row.projectId}>
                <TableCell className="max-w-40 truncate ps-6 font-medium">
                  {row.projectName}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {fmtMoneyPrecise(row.totalSales)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {fmtMoneyPrecise(row.totalAdSpend)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {fmtNumPrecise(row.totalOrders)}
                </TableCell>
                <TableCell className="pe-6 text-right">
                  {renderChangeIndicator(row.change)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </ChartCard>
  )
```

- 删除 `V2Card`、`CardHeader`/`CardTitle`/`CardDescription`/`CardContent` 导入与手写壳；`Table*` 保留。
- 原 `Skeleton` 加载态由 ChartCard `loading` 接管；原 `Store` 空态 icon 由空态文案取代。
- 注意：`rows.length > 0` 时不再需要外层 `CardContent px-0`，Table 直接作为 ChartCard children（ChartCard 自带 `p-5 pt-2` 内边距，若想表格通栏可给 ChartCard 传 `className` 调整，首期保持默认）。

- [ ] **Step 2: 验证（含既有测试）**

Run: `cd frontend && pnpm lint && pnpm build && pnpm test`
Expected: 全绿（v2-top-projects.test.tsx 断言 `computeTopProjects` 纯函数与表格列，需人工确认未断言 CardHeader 结构；若有结构断言则同步更新）

- [ ] **Step 3: Commit**

```bash
git add frontend/components/dashboard-v2/v2-top-projects.tsx
git commit -m "refactor(dashboard): V2TopProjects 收敛到 ChartCard 壳（BLF-911）"
```

---

## Stage 4：跨页推广 + 文档收口

### Task 4.1: portfolio-trend-chart 复用 ChartCard

**Files:**
- Modify: `frontend/components/dashboard/portfolio/portfolio-trend-chart.tsx`

**Interfaces:**
- Consumes: `ChartCard`（Task 1.1）、现有 `LineChartCard`/`buildChartConfig`（charts 层）
- Produces: 复用验证——证明 ChartCard 不绑定 v2 数据形状

- [ ] **Step 1: 读现状并替换手写壳**

Read: `frontend/components/dashboard/portfolio/portfolio-trend-chart.tsx`
将其手写 `dashboard-surface`/`CardHeader`/`CardTitle`/`CardDescription`/`CardContent` 壳替换为：

```tsx
<ChartCard
  icon={/* 原图标或省略 */}
  title={/* 原标题 */}
  description={/* 原描述 */}
  /* delta 原组件若有则保留，无则省略 */
>
  {/* 原 LineChartCard 配置不变 */}
</ChartCard>
```

- [ ] **Step 2: 验证**

Run: `cd frontend && pnpm lint && pnpm build && pnpm test`
Expected: 全绿（portfolio 相关测试若断言 Card 结构需同步更新）

- [ ] **Step 3: Commit**

```bash
git add frontend/components/dashboard/portfolio/portfolio-trend-chart.tsx
git commit -m "refactor(portfolio): portfolio-trend-chart 复用 ChartCard 壳验证跨页复用（BLF-911）"
```

### Task 4.2: 更新 chart-unification-spec 移除 v2 豁免

**Files:**
- Modify: `docs/chart-unification-spec.md`

- [ ] **Step 1: 更新豁免表**

在 §3 豁免表中将 dashboard-v2 行改为已收口说明（从「豁免」改为「已收口，随 v2 重构移除」），并新增一行说明 ChartCard 为统一图表卡壳：

```markdown
| 位置 | 内容 | 豁免原因 |
| --- | --- | --- |
| ~~`components/dashboard-v2/v2-*.tsx`（6 个）~~ | ~~蓝色单色独立体系~~ | **已收口（BLF-911）**：V2Card/V2Grid 对齐 surface 体系，6 图表与 TopProjects 统一到 `components/charts/chart-card.tsx`（ChartCard）壳，色板改走 `--chart-N` / surface 令牌 |
```

- [ ] **Step 2: 补充 ChartCard 规范**

在 §1 增加小节：

```markdown
### 1.6 图表卡壳（ChartCard，BLF-911）

- 所有带表头的图表卡（标题/描述/Delta/操作区/页脚/加载/空态）一律用
  `components/charts/chart-card.tsx` 的 `ChartCard`，禁止手写 `CardHeader + CardTitle +
  CardDescription + CardContent` 模板。
- 图表本体仍用 §1.1-1.5 的 `ChartContainer` / `ChartXxxCard`，作为 `ChartCard` children 传入。
- 视觉：surface 面板风（rounded-lg + border + bg-card + shadow-soft/dark:shadow-level-2），
  非 terminal 黑底；数字保留 `tabular-nums` 数据感。
```

- [ ] **Step 3: Commit**

```bash
git add docs/chart-unification-spec.md
git commit -m "docs(charts): 更新统一规范移除 v2 豁免并登记 ChartCard（BLF-911）"
```

---

## 自检清单（收尾）

- [ ] 无 `border-term-*` / `bg-term-*` / `text-term-*` 残留在 `dashboard-v2/` 图表与卡片（grep 验证）
- [ ] 无裸 `<Legend`、无 `tick={{ fill: '#…' }}` 硬编码 hex（BLF-495 验收基线）
- [ ] `cd frontend && pnpm lint && pnpm build && pnpm test` 全绿
- [ ] 首页 light + dark 双主题手动过：6 图表 + KPI + TopProjects + 空态 + 加载骨架视觉一致
- [ ] 每个 commit author email = `jr.way123@gmail.com`
