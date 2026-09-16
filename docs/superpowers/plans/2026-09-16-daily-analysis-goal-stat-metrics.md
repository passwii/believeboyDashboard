# Daily Analysis Goal Stats Metrics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将日报分析目标磁贴改为同时展示 `进度`、`月度`、`速度` 三个独立指标，并让项目目标管理页复用同一速度口径。

**Architecture:** 在 `goal-progress-rings.tsx` 增加纯函数 `achievementPaceRatio`，由 Stats 和目标管理页共同消费。`GoalProgressStat` 负责紧凑三行展示；页面层只负责构造 `GoalRingItem[]`。

**Tech Stack:** Next.js App Router、React、TypeScript、Vitest、Testing Library、Tailwind CSS。

## Global Constraints

- 前端测试顺序：`pnpm lint` -> `pnpm build` -> `pnpm test`。
- Commit 使用中文 Conventional Commits，subject 动宾短语不超过 50 字且无句号。
- 保持现有 Stats 磁贴最小高度 `min-h-[112px]` 和整卡跳转行为。
- 不新增后端字段或接口。
- 三个指标必须使用现有数据完整可计算。

---

### Task 1: 增加达成速度纯函数

**Files:**
- Modify: `frontend/components/ui/goal-progress-rings.tsx`
- Test: `frontend/components/ui/goal-progress-rings.test.tsx`

**Interfaces:**
- Consumes: `achievedAmount`, `targetAmount`, `todayDay`, `daysInMonth`
- Produces: `achievementPaceRatio(achievedAmount: number, targetAmount: number, todayDay: number, daysInMonth: number): number | null`

- [ ] **Step 1: Write the failing tests**

在 `frontend/components/ui/goal-progress-rings.test.tsx` 的 import 中加入 `achievementPaceRatio`，并在 `projectedMonthlyRate` 测试前增加：

```tsx
describe('achievementPaceRatio（达成速度）', () => {
  it('当前日均高于剩余所需日均时返回超额比例', () => {
    expect(achievementPaceRatio(400, 1000, 10, 30)).toBeCloseTo(4 / 3)
  })

  it('当前日均低于剩余所需日均时返回实际比例', () => {
    expect(achievementPaceRatio(175, 1000, 10, 30)).toBeCloseTo(0.5)
  })

  it('当前日均高于剩余所需日均时保留超额比例', () => {
    expect(achievementPaceRatio(500, 1000, 10, 30)).toBeCloseTo(2)
  })

  it('已经完成目标时返回 100%', () => {
    expect(achievementPaceRatio(1100, 1000, 10, 30)).toBe(1)
  })

  it('没有剩余天数且尚未达标时返回 0', () => {
    expect(achievementPaceRatio(900, 1000, 30, 30)).toBe(0)
  })

  it('缺少有效目标或日期时返回 null', () => {
    expect(achievementPaceRatio(100, 0, 10, 30)).toBeNull()
    expect(achievementPaceRatio(100, 1000, 0, 30)).toBeNull()
    expect(achievementPaceRatio(100, 1000, 10, 0)).toBeNull()
    expect(achievementPaceRatio(Number.NaN, 1000, 10, 30)).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd frontend && pnpm exec vitest run components/ui/goal-progress-rings.test.tsx
```

Expected: FAIL because `achievementPaceRatio` is not exported.

- [ ] **Step 3: Implement the pure function**

在 `frontend/components/ui/goal-progress-rings.tsx` 的 `projectedMonthlyRate` 前增加：

```tsx
/**
 * 达成速度：当前日均销售额相对剩余所需日均销售额的比值。
 * 1 表示按当前节奏可在月末刚好达标；大于 1 表示有余量，小于 1 表示需要提速。
 */
export function achievementPaceRatio(
  achievedAmount: number,
  targetAmount: number,
  todayDay: number,
  daysInMonth: number
): number | null {
  if (
    !Number.isFinite(achievedAmount) ||
    !Number.isFinite(targetAmount) ||
    !Number.isFinite(todayDay) ||
    !Number.isFinite(daysInMonth) ||
    targetAmount <= 0 ||
    todayDay <= 0 ||
    daysInMonth <= 0
  ) {
    return null
  }

  if (achievedAmount >= targetAmount) return 1

  const remainingDays = daysInMonth - todayDay
  if (remainingDays <= 0) return 0

  const currentDaily = achievedAmount / todayDay
  const requiredDaily = (targetAmount - achievedAmount) / remainingDays
  if (requiredDaily <= 0) return 1

  return Math.max(0, currentDaily / requiredDaily)
}
```

- [ ] **Step 4: Run the focused test**

Run:

```bash
cd frontend && pnpm exec vitest run components/ui/goal-progress-rings.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/components/ui/goal-progress-rings.tsx frontend/components/ui/goal-progress-rings.test.tsx
git commit -m "feat(日报分析): 增加目标达成速度口径"
```

---

### Task 2: 改造 Stats 目标磁贴为三行指标

**Files:**
- Modify: `frontend/components/ui/goal-progress-rings.tsx`
- Modify: `frontend/components/ui/goal-progress-rings.test.tsx`
- Modify: `frontend/app/dashboard/operations/daily-analysis/daily-analysis-client.tsx`

**Interfaces:**
- Consumes: `GoalRingItem[]`，其中每项提供 `label`、可选 `shortLabel`、`display`、`value`、`color`
- Produces: `GoalProgressStat` 右侧三行紧凑指标；不再接收独立的 `value` prop

- [ ] **Step 1: Write the failing component tests**

将 `ITEMS` 的第三项改为：

```tsx
  {
    key: 'pace_ratio',
    label: '达成速度',
    value: 1.25,
    display: '125.0%',
    caption: '当前日均 / 剩余所需日均',
    note: '≥100% 表示按当前节奏可追平目标',
    color: 'hsl(var(--chart-3))',
  },
```

同步将本文件中现有的 `预估月度完成率` 断言改为 `达成速度`，并把 `GoalProgressStat` 测试改为：

```tsx
describe('GoalProgressStat（daily-analysis stats 目标入口）', () => {
  it('展示三个百分比、简称并链接到目标管理页', () => {
    const items = [
      { ...ITEMS[0], shortLabel: '进度' },
      { ...ITEMS[1], shortLabel: '月度' },
      { ...ITEMS[2], shortLabel: '速度', display: '105.0%' },
    ]

    render(<GoalProgressStat href="/dashboard/operations/project-goals?project=7&country=US" items={items} />)

    const link = screen.getByRole('link', { name: '查看目标管理' })
    expect(link).toHaveAttribute('href', '/dashboard/operations/project-goals?project=7&country=US')
    expect(screen.getByText('目标进度')).toBeInTheDocument()
    expect(screen.getByText('进度')).toBeInTheDocument()
    expect(screen.getByText('86.3%')).toBeInTheDocument()
    expect(screen.getByText('月度')).toBeInTheDocument()
    expect(screen.getByText('40.0%')).toBeInTheDocument()
    expect(screen.getByText('速度')).toBeInTheDocument()
    expect(screen.getByText('125.0%')).toBeInTheDocument()
    expect(link.querySelectorAll('svg')).toHaveLength(3)
  })

  it('加载中保留入口并显示加载状态', () => {
    render(<GoalProgressStat href="/dashboard/operations/project-goals" items={[]} loading />)

    expect(screen.getByRole('link', { name: '查看目标管理' })).toBeInTheDocument()
    expect(screen.getByText('加载中')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd frontend && pnpm exec vitest run components/ui/goal-progress-rings.test.tsx
```

Expected: FAIL because the component still renders one `value` and does not render `进度`、`月度`、`速度`。

- [ ] **Step 3: Implement the compact three-row stat**

在 `GoalRingItem` 增加可选字段：

```tsx
  /** Stats 紧凑磁贴使用的简称，如「进度」「月度」「速度」。 */
  shortLabel?: string
```

将 `GoalProgressStatProps` 的 `value: string` 删除，并将右侧内容替换为：

```tsx
      <div className="min-w-0 flex-1">
        <div className="mb-2 flex items-center justify-between gap-1.5">
          <span className="truncate font-mono text-[11px] uppercase tracking-wider text-term-muted">
            目标进度
          </span>
          <span
            className="text-term-faint transition-transform group-hover:translate-x-0.5"
            aria-hidden="true"
          >
            →
          </span>
        </div>
        {loading ? (
          <div className="font-mono text-[11px] leading-4 text-term-faint">加载中</div>
        ) : ringItems.length > 0 ? (
          <div className="space-y-0.5">
            {ringItems.map((item) => (
              <div key={item.key} className="flex min-w-0 items-center justify-between gap-2">
                <span
                  className="flex min-w-0 items-center gap-1.5 truncate font-mono text-[10px] leading-3 text-term-faint"
                  title={item.label}
                >
                  <span
                    aria-hidden="true"
                    className="size-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: item.color }}
                  />
                  <span className="truncate">{item.shortLabel ?? item.label}</span>
                </span>
                <span className="shrink-0 font-mono text-[11px] leading-3 tabular-nums text-term-text">
                  {item.display}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="font-mono text-[11px] leading-4 text-term-faint">未设置目标</div>
        )}
        <div className="mt-1 truncate font-mono text-[10px] leading-3 text-term-faint">
          {items.length > 0 ? '点击查看目标管理' : '查看目标设置'}
        </div>
      </div>
```

更新 `daily-analysis-client.tsx`：

- 从 `goal-progress-rings` import `achievementPaceRatio`，移除 `projectedMonthlyRate`。
- 删除 `goalStatValue`。
- 将 `goalRingItems` 改为：

```tsx
  const goalRingItems = useMemo<GoalRingItem[]>(() => {
    if (!goalProgress || goalProgress.target_amount <= 0) return []

    const paceRatio = achievementPaceRatio(
      goalProgress.achieved_amount,
      goalProgress.target_amount,
      goalProgress.today_day,
      goalProgress.days_in_month
    )
    const money = (value: number) =>
      `${goalProgress.currency}${value.toLocaleString('zh-CN', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`

    return [
      {
        key: 'pace',
        label: '截止今日完成率',
        shortLabel: '进度',
        value: goalProgress.completion_vs_daily,
        display: `${(goalProgress.completion_vs_daily * 100).toFixed(1)}%`,
        caption: `已完成 ${money(goalProgress.achieved_amount)} / 应完成 ${money(
          (goalProgress.target_amount * goalProgress.today_day) / goalProgress.days_in_month
        )}`,
        color: 'hsl(var(--chart-1))',
      },
      {
        key: 'monthly',
        label: '实际月度完成率',
        shortLabel: '月度',
        value: goalProgress.completion_vs_monthly,
        display: `${(goalProgress.completion_vs_monthly * 100).toFixed(1)}%`,
        caption: `已完成 ${money(goalProgress.achieved_amount)} / 目标 ${money(goalProgress.target_amount)}`,
        color: 'hsl(var(--chart-2))',
      },
      {
        key: 'pace_ratio',
        label: '达成速度',
        shortLabel: '速度',
        value: paceRatio ?? 0,
        display:
          paceRatio === null
            ? '--'
            : goalProgress.achieved_amount >= goalProgress.target_amount
              ? '已达标'
              : `${(paceRatio * 100).toFixed(1)}%`,
        caption: '当前日均 / 剩余所需日均',
        color: 'hsl(var(--chart-3))',
      },
    ]
  }, [goalProgress])
```

- 从 `<GoalProgressStat>` 调用中删除 `value={goalStatValue}`。

- [ ] **Step 4: Run focused tests**

Run:

```bash
cd frontend && pnpm exec vitest run components/ui/goal-progress-rings.test.tsx app/dashboard/operations/daily-analysis/daily-analysis-client.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/components/ui/goal-progress-rings.tsx frontend/components/ui/goal-progress-rings.test.tsx frontend/app/dashboard/operations/daily-analysis/daily-analysis-client.tsx
git commit -m "feat(日报分析): 目标磁贴展示三项进度"
```

---

### Task 3: 统一项目目标管理页的第三项指标

**Files:**
- Modify: `frontend/app/dashboard/operations/project-goals/page.tsx`
- Modify: `frontend/app/dashboard/operations/project-goals/page.test.tsx`
- Modify: `frontend/components/ui/goal-progress-rings.tsx`
- Modify: `frontend/components/ui/goal-progress-rings.test.tsx`

**Interfaces:**
- Consumes: `achievementPaceRatio(achievedAmount, targetAmount, todayDay, daysInMonth)`
- Produces: 目标管理页第三环使用 `达成速度`

- [ ] **Step 1: Update failing page assertions**

将 `frontend/app/dashboard/operations/project-goals/page.test.tsx` 中的：

```tsx
    expect(screen.getByText('预估月度完成率')).toBeInTheDocument()
```

改为：

```tsx
    expect(screen.getByText('达成速度')).toBeInTheDocument()
```

- [ ] **Step 2: Run page tests to verify they fail**

Run:

```bash
cd frontend && pnpm exec vitest run app/dashboard/operations/project-goals/page.test.tsx
```

Expected: FAIL because the page still renders `预估月度完成率`.

- [ ] **Step 3: Update the page to use the new metric**

在 `frontend/app/dashboard/operations/project-goals/page.tsx`：

- 将 import 改为 `GoalProgressRings, achievementPaceRatio`。
- 删除 `projectedMonthlyRate` import。
- 在 `currentMonthProgress` 定义后增加：

```tsx
  const currentMonthPaceRatio = currentMonthProgress
    ? achievementPaceRatio(
        currentMonthProgress.achieved_amount,
        currentMonthProgress.target_amount,
        currentMonthProgress.today_day,
        currentMonthProgress.days_in_month
      )
    : null
```

- 将第三项替换为：

```tsx
                      {
                        key: 'pace_ratio',
                        label: '达成速度',
                        value: currentMonthPaceRatio ?? 0,
                        display:
                          currentMonthProgress.target_amount <= 0
                            ? '未设置'
                            : currentMonthProgress.achieved_amount >=
                                currentMonthProgress.target_amount
                            ? '已达标'
                            : formatPercent(currentMonthPaceRatio ?? 0),
                        caption:
                          currentMonthProgress.target_amount > 0
                            ? '当前日均 / 剩余所需日均'
                            : '未设置本月目标',
                        note:
                          currentMonthProgress.target_amount > 0 &&
                          currentMonthProgress.today_day > 0
                            ? '≥100% 表示按当前节奏可追平目标'
                            : '前往「目标管理」设置月度目标',
                        color: 'hsl(var(--chart-3))',
                      },
```

确认全仓库不再引用 `projectedMonthlyRate` 后，删除该函数及其测试：

```bash
rg -n "projectedMonthlyRate" frontend --glob '!**/node_modules/**'
```

Expected: 无输出。

- [ ] **Step 4: Run focused target-page tests**

Run:

```bash
cd frontend && pnpm exec vitest run app/dashboard/operations/project-goals/page.test.tsx components/ui/goal-progress-rings.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/dashboard/operations/project-goals/page.tsx frontend/app/dashboard/operations/project-goals/page.test.tsx frontend/components/ui/goal-progress-rings.tsx frontend/components/ui/goal-progress-rings.test.tsx
git commit -m "fix(目标管理): 统一三环达成速度口径"
```

---

### Task 4: 完整验证与独立审查

**Files:**
- Modify: none

**Interfaces:**
- Consumes: Tasks 1-3 的全部改动
- Produces: 可合并的验证证据

- [ ] **Step 1: Run focused tests**

Run:

```bash
cd frontend && pnpm exec vitest run components/ui/goal-progress-rings.test.tsx app/dashboard/operations/daily-analysis/daily-analysis-client.test.tsx app/dashboard/operations/project-goals/page.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run lint**

Run:

```bash
cd frontend && pnpm lint
```

Expected: 0 errors；只允许输出仓库既有 warning。

- [ ] **Step 3: Run production build**

Run:

```bash
cd frontend && pnpm build
```

Expected: PASS，包括 TypeScript 检查和静态页面生成。

- [ ] **Step 4: Request independent review**

使用独立 reviewer subagent 检查 `origin/main..HEAD`：

- 三个指标口径是否独立且可理解。
- 速度公式和边界条件是否正确。
- 小屏布局是否仍能容纳三行。
- 测试是否验证真实行为。

- [ ] **Step 5: Address review findings and re-run affected tests**

只修复审查中确认的问题，然后重复对应 focused test。

- [ ] **Step 6: Commit final fixes**

```bash
git add frontend docs
git commit -m "test(日报分析): 补齐目标指标验证"
```
