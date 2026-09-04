# 调度记录 Ledger 重构 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 重构 `frontend/app/dashboard/data-analysis/scheduled-reports/ledger/page.tsx` —— 砍掉统计卡、表格按日分组、Sheet 详情重做。纯前端，不动后端 / 数据模型。

**架构：** 在 ledger page 内做三处改动 —— 工具栏去卡、表格按日分组渲染、Sheet 详情分块重排。新增一个小组件 `LedgerDayGroup` 承接分组渲染逻辑，保持 page.tsx 顶层结构清晰。

**技术栈：** Next.js 14, React 18, Tailwind CSS, shadcn/ui (Sheet/Dialog/Table/Card/Badge/Button), lucide-react, date-fns

---

## 文件结构

| 操作 | 文件 | 职责 |
|------|------|------|
| 重写 | `frontend/app/dashboard/data-analysis/scheduled-reports/ledger/page.tsx` | 主页面：精简工具栏 + 按日分组表格 + Sheet 详情重做 |
| 新建 | `frontend/app/dashboard/data-analysis/scheduled-reports/_components/LedgerDayGroup.tsx` | 单日分组：组头 + 折叠表格，7 列布局 |
| 新建 | `frontend/app/dashboard/data-analysis/scheduled-reports/_components/LedgerDetailSheet.tsx` | Sheet 详情：hero / 错误条 / 报告范围 / 双栏 / 粘底操作 |
| 不动 | `_components/LedgerResendCell.tsx` | 重发按钮逻辑保留 |
| 不动（不再 import） | `_components/LedgerSummaryCards.tsx` | 文件保留，ledger page 移除引用 |

---

### 任务 1：删除 LedgerSummaryCards 引用并精简工具栏

**文件：**
- 修改：`frontend/app/dashboard/data-analysis/scheduled-reports/ledger/page.tsx:33, 72, 284-285`

- [ ] **步骤 1：移除 LedgerSummaryCards 的 import 与状态**

在 `ledger/page.tsx` 中：

1. 删除第 33 行：`import { LedgerSummaryCards } from '../_components/LedgerSummaryCards'`
2. 删除第 72 行：`const [ledgerSummary, setLedgerSummary] = useState<LedgerSummary | null>(null)`
3. 删除第 120-122 行 setLedgerSummary 调用（fetchLedger 的 onData callback 改为只调用 `setLedgerItems(items)`）
4. 删除第 25 行 `LedgerSummary` 类型 import（仅 ledgerSummary 用到）
5. 删除第 284 行：`<LedgerSummaryCards summary={ledgerSummary} loading={ledgerLoading} />`
6. 删除第 285 行：`{ledgerError && <p className="text-sm text-destructive">{ledgerError}</p>}` （移到工具栏内合适位置或保留，看实际渲染）

- [ ] **步骤 2：保留 ledgerError 渲染**

如果删除第 285 行导致 `ledgerError` 丢失渲染，则在工具栏内合适位置补回来。简化做法：把错误信息移到一个独立段落，跟工具栏分组表格在同一 Card 内即可：

```tsx
{ledgerError && (
  <p className="mt-3 text-sm text-destructive">{ledgerError}</p>
)}
```

放在工具栏 Card 的 CardContent 内、刷新按钮下方。

- [ ] **步骤 3：收紧工具栏与下方表格的间距**

当前 `page.tsx` 顶部 `<div className="space-y-4">`，改为 `<div className="space-y-3">`。

- [ ] **步骤 4：验证页面渲染**

```bash
cd frontend && pnpm dev
```

打开 `http://localhost:3200/dashboard/data-analysis/scheduled-reports/ledger`，确认：
- 工具栏后**没有** 5 张统计卡
- 工具栏与下方表格之间间距明显收紧
- ledgerError（如有）仍可显示

- [ ] **步骤 5：Commit**

```bash
git add frontend/app/dashboard/data-analysis/scheduled-reports/ledger/page.tsx
git commit -m "refactor(scheduled-reports): remove summary cards from ledger toolbar"
```

---

### 任务 2：创建 LedgerDayGroup 组件（按日分组表格）

**文件：**
- 新建：`frontend/app/dashboard/data-analysis/scheduled-reports/_components/LedgerDayGroup.tsx`

- [ ] **步骤 1：创建 LedgerDayGroup 组件**

```tsx
// frontend/app/dashboard/data-analysis/scheduled-reports/_components/LedgerDayGroup.tsx
'use client'

import { useMemo } from 'react'
import { format } from 'date-fns'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { LedgerResendCell } from './LedgerResendCell'
import type { AIModelConfig, Frequency, LedgerItem, ResendStage, Subscription } from './types'

const FREQUENCY_LABELS: Record<Frequency, string> = {
  daily: '每日',
  weekly: '每周',
  monthly: '每月',
}

const FREQUENCY_COLORS: Record<Frequency, string> = {
  daily: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  weekly: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
  monthly: 'bg-amber-100 text-amber-800 dark:bg-amber-800 dark:text-amber-200',
}

const STATUS_LABELS: Record<string, string> = {
  sent: '成功',
  failed: '失败',
  missing: '缺失',
}

const STATUS_BADGE: Record<string, string> = {
  sent: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-300 dark:border-emerald-800',
  failed: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/30 dark:text-red-300 dark:border-red-800',
  missing: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-800',
}

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

interface LedgerDayGroupProps {
  date: string
  items: LedgerItem[]
  expanded: boolean
  onToggle: () => void
  isAnchor: boolean
  isToday: boolean
  subscriptions: Subscription[]
  modelConfig: AIModelConfig | null
  isLoadingModelConfig: boolean
  resendingStates: Record<string, ResendStage>
  onRowClick: (item: LedgerItem) => void
  onResend: (item: LedgerItem, overrideAiModel: string | null) => void
  onResendLoading: (item: LedgerItem) => void
  canTriggerResend: boolean
}

export function LedgerDayGroup({
  date,
  items,
  expanded,
  onToggle,
  isAnchor,
  isToday,
  subscriptions,
  modelConfig,
  isLoadingModelConfig,
  resendingStates,
  onRowClick,
  onResend,
  onResendLoading,
  canTriggerResend,
}: LedgerDayGroupProps) {
  const counts = useMemo(() => {
    const c = { sent: 0, failed: 0, missing: 0 }
    for (const it of items) c[it.status]++
    return c
  }, [items])

  const weekday = WEEKDAY_LABELS[new Date(date).getDay()]

  return (
    <div>
      {/* 组头 */}
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          'flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors',
          'hover:bg-muted/60',
          isAnchor ? 'bg-muted/40' : 'bg-muted/20',
          'border-b border-border/60',
        )}
      >
        <ChevronDown
          className={cn(
            'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
            !expanded && '-rotate-90',
          )}
        />
        <span className="text-sm font-medium">{date}</span>
        <span className="text-xs text-muted-foreground">· {weekday}</span>
        {isToday && (
          <Badge variant="secondary" className="bg-blue-100 text-blue-700 hover:bg-blue-100 text-[10px] px-1.5 py-0">
            今天
          </Badge>
        )}
        <span className="text-xs text-muted-foreground">{items.length} 条</span>
        <span className="ml-auto flex items-center gap-1.5 text-[11px]">
          {counts.sent > 0 && (
            <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5', STATUS_BADGE.sent)}>
              ✓ {counts.sent}
            </span>
          )}
          {counts.failed > 0 && (
            <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5', STATUS_BADGE.failed)}>
              ✗ {counts.failed}
            </span>
          )}
          {counts.missing > 0 && (
            <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5', STATUS_BADGE.missing)}>
              ⚠ {counts.missing}
            </span>
          )}
        </span>
      </button>

      {/* 折叠区：表格 */}
      {expanded && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-20">应发时间</TableHead>
              <TableHead>项目</TableHead>
              <TableHead className="w-24">国家</TableHead>
              <TableHead className="w-44">邮箱</TableHead>
              <TableHead className="w-16">频率</TableHead>
              <TableHead className="w-24">状态</TableHead>
              <TableHead className="w-28 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map(item => {
              const projectLabel =
                item.project_names?.length > 0
                  ? item.project_names.join(' · ')
                  : item.project_ids === '*'
                    ? '全部项目'
                    : item.project_ids
              const countryList = item.country
                .split(',')
                .map(c => c.trim())
                .filter(Boolean)
              const countryLabel =
                countryList.length === 0
                  ? '—'
                  : countryList.length === 1
                    ? countryList[0]
                    : `${countryList[0]} +${countryList.length - 1}`
              const sub = subscriptions.find(s => s.id === item.subscription_id)
              const fallbackModel = sub?.ai_model || modelConfig?.defaultModel || ''
              const canTrigger = canTriggerResend || item.can_resend

              return (
                <TableRow
                  key={item.ledger_key}
                  className="cursor-pointer hover:bg-accent/50 transition-colors"
                  onClick={() => onRowClick(item)}
                >
                  <TableCell className="text-sm whitespace-nowrap tabular-nums">
                    {format(new Date(item.expected_at), 'HH:mm')}
                  </TableCell>
                  <TableCell>
                    <span className="block max-w-[260px] truncate text-sm" title={projectLabel}>
                      {projectLabel}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{countryLabel}</TableCell>
                  <TableCell>
                    <span className="block max-w-[180px] truncate text-xs text-muted-foreground" title={item.email}>
                      {item.email}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge className={cn('text-[10px]', FREQUENCY_COLORS[item.frequency])}>
                      {FREQUENCY_LABELS[item.frequency]}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <span
                      className={cn(
                        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]',
                        STATUS_BADGE[item.status],
                      )}
                    >
                      {item.status === 'sent' && '✓'}
                      {item.status === 'failed' && '✗'}
                      {item.status === 'missing' && '⚠'}
                      {STATUS_LABELS[item.status]}
                    </span>
                  </TableCell>
                  <TableCell className="text-right" onClick={e => e.stopPropagation()}>
                    {canTrigger ? (
                      <LedgerResendCell
                        item={item}
                        resendingStage={resendingStates[item.ledger_key]}
                        canResend
                        modelConfig={modelConfig}
                        isLoadingModelConfig={isLoadingModelConfig}
                        fallbackModel={fallbackModel}
                        onLoading={() => onResendLoading(item)}
                        onSubmit={(overrideAiModel) => onResend(item, overrideAiModel)}
                      />
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
```

- [ ] **步骤 2：验证组件编译**

```bash
cd frontend && pnpm tsc --noEmit 2>&1 | grep -E "LedgerDayGroup" || echo "OK"
```

预期：`OK`（无 LedgerDayGroup 相关错误）。

---

### 任务 3：在 ledger page 接入分组逻辑

**文件：**
- 修改：`frontend/app/dashboard/data-analysis/scheduled-reports/ledger/page.tsx`

- [ ] **步骤 1：新增分组状态与 useMemo**

在 `LedgerPage` 函数体内，紧跟现有的 `ledgerEmail` state 之后，新增：

```tsx
// 按 expected_date 分组（后端已按 yyyy-MM-dd 返回）
const groupedByDay = useMemo(() => {
  const buckets: Record<string, LedgerItem[]> = {}
  for (const item of ledgerItems) {
    ;(buckets[item.expected_date] ??= []).push(item)
  }
  return Object.fromEntries(
    Object.entries(buckets).sort(([a], [b]) => b.localeCompare(a)),
  )
}, [ledgerItems])

// 展开状态
const [expandedDates, setExpandedDates] = useState<Set<string>>(new Set())

// 末日展开锚点（仅当 ledgerStartDate / ledgerEndDate 变化时重置）
const todayStr = format(new Date(), 'yyyy-MM-dd')
useEffect(() => {
  if (!ledgerEndDate) return
  setExpandedDates(new Set([ledgerEndDate]))
}, [ledgerStartDate, ledgerEndDate])

const toggleDate = useCallback((date: string) => {
  setExpandedDates(prev => {
    const next = new Set(prev)
    if (next.has(date)) next.delete(date)
    else next.add(date)
    return next
  })
}, [])
```

- [ ] **步骤 2：替换桌面表格区为 LedgerDayGroup 列表**

定位 page.tsx 中 `{/* 桌面端表格 */}` 注释及 `<div className="hidden md:block overflow-x-auto">` 块（约 293-383 行），整段替换为：

```tsx
<div className="hidden md:block">
  {ledgerItems.length === 0 ? (
    <div className="flex flex-col items-center gap-2 py-12 text-center">
      {ledgerLoading ? (
        <>
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          <span className="text-sm text-muted-foreground">台账加载中...</span>
        </>
      ) : (
        <>
          <RotateCcw className="h-8 w-8 text-muted-foreground/30" />
          <span className="text-sm text-muted-foreground">暂无台账记录</span>
          <span className="text-xs text-muted-foreground/60">调整筛选条件或点击「刷新台账」</span>
        </>
      )}
    </div>
  ) : (
    <div>
      {Object.entries(groupedByDay).map(([date, items]) => (
        <LedgerDayGroup
          key={date}
          date={date}
          items={items}
          expanded={expandedDates.has(date)}
          onToggle={() => toggleDate(date)}
          isAnchor={date === ledgerEndDate}
          isToday={date === todayStr}
          subscriptions={subscriptions}
          modelConfig={modelConfig}
          isLoadingModelConfig={isLoadingModelConfig}
          resendingStates={resendingStates}
          onRowClick={openDetailSheet}
          onResend={handleResendLedger}
          onResendLoading={item => setResendingStates(prev => ({ ...prev, [item.ledger_key]: 'preparing' }))}
          canTriggerResend={canTriggerResend}
        />
      ))}
    </div>
  )}
</div>
```

- [ ] **步骤 3：在文件顶部 import LedgerDayGroup**

在 `page.tsx` 顶部现有 `_components/LedgerResendCell` 的 import 之后，添加：

```tsx
import { LedgerDayGroup } from '../_components/LedgerDayGroup'
```

- [ ] **步骤 4：验证桌面端分组表格**

```bash
cd frontend && pnpm dev
```

访问 `http://localhost:3200/dashboard/data-analysis/scheduled-reports/ledger`，确认：

1. 表格按日期分组，每个日期有自己的组头
2. 默认只有「末日」（今天）那一组展开
3. 末日组有「今天」徽标 + 略深的背景色
4. 点击其他组头可展开/折叠
5. 修改日期范围时，展开锚点跟随末日重置
6. 修改频率 / 状态 / 邮箱时，展开状态保持
7. 点击表格行仍打开 Sheet（保留原行为）

- [ ] **步骤 5：Commit**

```bash
git add frontend/app/dashboard/data-analysis/scheduled-reports/ledger/page.tsx \
        frontend/app/dashboard/data-analysis/scheduled-reports/_components/LedgerDayGroup.tsx
git commit -m "feat(scheduled-reports): ledger grouped by day with collapsible rows"
```

---

### 任务 4：创建 LedgerDetailSheet 组件（Sheet 详情重做）

**文件：**
- 新建：`frontend/app/dashboard/data-analysis/scheduled-reports/_components/LedgerDetailSheet.tsx`

- [ ] **步骤 1：创建 LedgerDetailSheet 组件**

```tsx
// frontend/app/dashboard/data-analysis/scheduled-reports/_components/LedgerDetailSheet.tsx
'use client'

import { useState } from 'react'
import Image from 'next/image'
import { AlertTriangle, Copy, ExternalLink, FileText, ImageIcon } from 'lucide-react'
import { format } from 'date-fns'
import ReactMarkdown from 'react-markdown'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PortraitScreenshotDialog } from '@/components/ui/image-preview-dialog'
import { cn } from '@/lib/utils'
import { getCountryLabel } from '@/lib/country'
import { LedgerResendCell } from './LedgerResendCell'
import type { AIModelConfig, Frequency, LedgerItem, ResendStage, Subscription } from './types'

const FREQUENCY_LABELS: Record<Frequency, string> = {
  daily: '每日',
  weekly: '每周',
  monthly: '每月',
}

const STATUS_BADGE: Record<string, string> = {
  sent: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-300 dark:border-emerald-800',
  failed: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/30 dark:text-red-300 dark:border-red-800',
  missing: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-800',
}

const HERO_BG: Record<string, string> = {
  sent: 'bg-gradient-to-br from-emerald-50 to-white dark:from-emerald-950/30 dark:to-background border-emerald-200 dark:border-emerald-800',
  failed: 'bg-gradient-to-br from-red-50 to-white dark:from-red-950/30 dark:to-background border-red-200 dark:border-red-800',
  missing: 'bg-gradient-to-br from-amber-50 to-white dark:from-amber-950/30 dark:to-background border-amber-200 dark:border-amber-800',
}

const HERO_LABEL: Record<string, { text: string; color: string }> = {
  sent: { text: '✓ 发送成功', color: 'text-emerald-700 dark:text-emerald-300' },
  failed: { text: '✗ 发送失败', color: 'text-red-700 dark:text-red-300' },
  missing: { text: '⚠ 记录缺失', color: 'text-amber-700 dark:text-amber-300' },
}

const SECTION_LABEL = 'text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-2 block'

interface LedgerDetailSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  item: LedgerItem | null
  subscriptions: Subscription[]
  modelConfig: AIModelConfig | null
  isLoadingModelConfig: boolean
  resendingStage: ResendStage | undefined
  canTriggerResend: boolean
  onResend: (item: LedgerItem, overrideAiModel: string | null) => void
  onResendLoading: (item: LedgerItem) => void
  onCopy: (text: string) => void
}

export function LedgerDetailSheet({
  open,
  onOpenChange,
  item,
  subscriptions,
  modelConfig,
  isLoadingModelConfig,
  resendingStage,
  canTriggerResend,
  onResend,
  onResendLoading,
  onCopy,
}: LedgerDetailSheetProps) {
  const [previewScreenshot, setPreviewScreenshot] = useState<string | null>(null)
  const [showAllProjects, setShowAllProjects] = useState(false)

  if (!item) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent className="sm:max-w-md w-full" />
      </Sheet>
    )
  }

  const sub = subscriptions.find(s => s.id === item.subscription_id)
  const fallbackModel = sub?.ai_model || modelConfig?.defaultModel || ''
  const canTrigger = canTriggerResend || item.can_resend

  const projectNames =
    item.project_names?.length > 0
      ? item.project_names
      : item.project_ids === '*'
        ? ['全部项目']
        : item.project_ids.split(',').filter(Boolean)
  const countryList = item.country.split(',').map(c => c.trim()).filter(Boolean)
  const visibleProjects = showAllProjects ? projectNames : projectNames.slice(0, 8)
  const hiddenCount = projectNames.length - visibleProjects.length
  const actionLabel = item.status === 'failed' ? '重试' : '补发'

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          className={cn(
            'sm:max-w-md w-full p-0 flex flex-col gap-0',
            'border-l border-border/60',
          )}
        >
          {/* Hero 区（粘顶） */}
          <SheetHeader
            className={cn(
              'border-b px-5 py-4 space-y-1.5',
              HERO_BG[item.status],
            )}
          >
            <div className={cn('text-[11px] font-medium tracking-wide flex items-center gap-1.5', HERO_LABEL[item.status].color)}>
              {item.status === 'missing' && <AlertTriangle className="h-3 w-3" />}
              {HERO_LABEL[item.status].text}
            </div>
            <SheetTitle className="text-xl font-semibold tracking-tight">
              {format(new Date(item.expected_at), 'yyyy-MM-dd · HH:mm')}
            </SheetTitle>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>📨 {item.email}</span>
              <span>{FREQUENCY_LABELS[item.frequency]}</span>
              {countryList.length > 0 && <span>{countryList.map(getCountryLabel).join(' · ')}</span>}
            </div>
          </SheetHeader>

          {/* 内容区（可滚动） */}
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
            {/* 错误信息条（仅 failed） */}
            {item.status === 'failed' && item.error_message && (
              <div>
                <span className={SECTION_LABEL}>错误信息</span>
                <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 font-mono text-xs text-red-700 whitespace-pre-wrap dark:bg-red-950/30 dark:border-red-800 dark:text-red-300">
                  {item.error_message}
                </div>
              </div>
            )}

            {/* 报告范围 */}
            <div>
              <span className={SECTION_LABEL}>报告范围</span>
              <div className="flex flex-wrap gap-1.5">
                {visibleProjects.map((name, idx) => (
                  <Badge
                    key={`${name}-${idx}`}
                    variant="secondary"
                    className="bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-50 text-[11px] dark:bg-blue-950/30 dark:text-blue-300 dark:border-blue-800"
                  >
                    {name}
                  </Badge>
                ))}
                {hiddenCount > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowAllProjects(true)}
                    className="text-[11px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                  >
                    +{hiddenCount} 更多
                  </button>
                )}
                {showAllProjects && projectNames.length > 8 && (
                  <button
                    type="button"
                    onClick={() => setShowAllProjects(false)}
                    className="text-[11px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                  >
                    收起
                  </button>
                )}
              </div>
              {countryList.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {countryList.map(c => (
                    <Badge key={c} variant="outline" className="text-[11px]">
                      {getCountryLabel(c)}
                    </Badge>
                  ))}
                </div>
              )}
            </div>

            {/* 双栏：截图 + AI 文案 */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* 截图 */}
              <div>
                <span className={SECTION_LABEL}>报告截图</span>
                {item.screenshot_r2_url ? (
                  <button
                    type="button"
                    onClick={() => setPreviewScreenshot(item.screenshot_r2_url)}
                    className="group relative w-full aspect-[3/4] overflow-hidden rounded-lg border border-border/70 hover:ring-2 hover:ring-primary/50 transition-shadow"
                  >
                    <Image
                      src={item.screenshot_r2_thumb_url || item.screenshot_r2_url}
                      alt="报告截图"
                      fill
                      className="object-contain bg-muted/30"
                      unoptimized
                    />
                    <div className="absolute inset-0 bg-black/0 group-hover:bg-black/5 transition-colors flex items-center justify-center">
                      <ExternalLink className="h-5 w-5 text-white/0 group-hover:text-white/70 transition-colors" />
                    </div>
                  </button>
                ) : (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/30 rounded-lg px-3 py-6 border border-dashed border-border/50 justify-center">
                    <ImageIcon className="h-4 w-4" />
                    暂无截图
                  </div>
                )}
              </div>

              {/* AI 文案 */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className={cn(SECTION_LABEL, 'mb-0')}>AI 文案</span>
                  {item.ai_summary && (
                    <button
                      type="button"
                      onClick={() => onCopy(item.ai_summary!.replace(/^[-•·●]\s*/gm, '◉ '))}
                      className="flex items-center gap-1 text-[11px] text-blue-600 hover:underline dark:text-blue-400"
                    >
                      <Copy className="h-3 w-3" />
                      复制
                    </button>
                  )}
                </div>
                {item.ai_summary ? (
                  <div className="rounded-lg border border-border/60 bg-muted/20 overflow-hidden">
                    <div className="h-[200px] overflow-y-auto p-3 text-xs leading-relaxed
                      prose prose-xs prose-neutral dark:prose-invert max-w-none
                      [&_ul]:my-0.5 [&_p]:my-0.5 [&_strong]:font-semibold"
                    >
                      <ReactMarkdown>
                        {item.ai_summary.replace(/^[•·●]\s*/gm, '- ')}
                      </ReactMarkdown>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/30 rounded-lg px-3 py-6 border border-dashed border-border/50 justify-center h-[200px]">
                    <FileText className="h-4 w-4" />
                    暂无 AI 文案
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* 操作栏（粘底） */}
          {canTrigger && (
            <div className="sticky bottom-0 border-t border-border/60 bg-background px-5 py-3 flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                取消
              </Button>
              <LedgerResendCell
                item={item}
                resendingStage={resendingStage}
                canResend
                modelConfig={modelConfig}
                isLoadingModelConfig={isLoadingModelConfig}
                fallbackModel={fallbackModel}
                onLoading={() => onResendLoading(item)}
                onSubmit={(overrideAiModel) => {
                  onResend(item, overrideAiModel)
                  onOpenChange(false)
                }}
              />
            </div>
          )}
        </SheetContent>
      </Sheet>

      {/* 截图预览 */}
      {previewScreenshot && (
        <PortraitScreenshotDialog
          open
          onOpenChange={o => !o && setPreviewScreenshot(null)}
          src={previewScreenshot}
          alt="报告截图"
        />
      )}
    </>
  )
}
```

- [ ] **步骤 2：验证组件编译**

```bash
cd frontend && pnpm tsc --noEmit 2>&1 | grep -E "LedgerDetailSheet" || echo "OK"
```

预期：`OK`。

---

### 任务 5：在 ledger page 接入新的 Sheet 组件

**文件：**
- 修改：`frontend/app/dashboard/data-analysis/scheduled-reports/ledger/page.tsx`

- [ ] **步骤 1：移除旧的 Sheet + 截图 Dialog 代码**

定位 page.tsx 中现有的：
- `{/* ── 台账详情 Sheet ── }` 段（约 467-603 行，整个 Sheet 块）
- `{/* 截图预览弹窗 */}` 段（约 605-613 行，`PortraitScreenshotDialog` 直接渲染）
- `{/* AI 文案预览弹窗 */}` 段（约 615-641 行，旧的 AI 文案 Dialog）

**整段删除**这三段。

同时移除不再使用的 import：
- `AlertTriangle`（仍需保留，在 mobile 卡片用）—— 检查实际使用，如不再用则删除
- `FileText, ImageIcon`（移动端仍用，保留）
- `Sheet, SheetContent, SheetHeader, SheetTitle` from `@/components/ui/sheet` —— 删除
- `Dialog, DialogContent, DialogTitle` from `@/components/ui/dialog` —— 删除
- `PortraitScreenshotDialog` —— 删除（LedgerDetailSheet 内已自带）
- `Image` from `next/image` —— 检查实际使用，如不再用则删除
- `ReactMarkdown` —— 删除
- `cn` —— 检查实际使用，保留

精简后保留的 lucide imports：
```tsx
import {
  ChevronDown, Copy, ExternalLink, FileText, ImageIcon, Loader2, RotateCcw,
} from 'lucide-react'
```

`AlertTriangle` 是否还需要？检查 page.tsx —— 之前在移动端 status === 'missing' 用了 AlertTriangle icon，但简化为 `⚠` 字符后不需要。删除。

精简后保留：
```tsx
import { ChevronDown, Copy, ExternalLink, FileText, ImageIcon, Loader2, RotateCcw } from 'lucide-react'
```

- [ ] **步骤 2：移除不再使用的 state 与 computed**

删除以下不再需要的代码：

```tsx
// 不再需要
const [previewScreenshotUrl, setPreviewScreenshotUrl] = useState<string | null>(null)
const [previewSummary, setPreviewSummary] = useState<string | null>(null)

const previewCopyText = useMemo(() => {
  if (!previewSummary) return ''
  return previewSummary.replace(/^[-•·●]\s*/gm, '◉ ')
}, [previewSummary])
```

- [ ] **步骤 3：在文件顶部 import LedgerDetailSheet**

```tsx
import { LedgerDetailSheet } from '../_components/LedgerDetailSheet'
```

- [ ] **步骤 4：在 ledger page 中替换 Sheet 渲染**

在 page.tsx 中，找到 `</div>` 结束最外层 `<div className="space-y-3">` 之前，添加：

```tsx
{/* ── 台账详情 Sheet ── */}
<LedgerDetailSheet
  open={sheetOpen}
  onOpenChange={setSheetOpen}
  item={selectedItem}
  subscriptions={subscriptions}
  modelConfig={modelConfig}
  isLoadingModelConfig={isLoadingModelConfig}
  resendingStage={selectedItem ? resendingStates[selectedItem.ledger_key] : undefined}
  canTriggerResend={canTriggerResend}
  onResend={handleResendLedger}
  onResendLoading={item => setResendingStates(prev => ({ ...prev, [item.ledger_key]: 'preparing' }))}
  onCopy={text => {
    navigator.clipboard.writeText(text)
    notify({ type: 'success', title: '已复制' })
  }}
/>
```

- [ ] **步骤 5：验证 Sheet 详情**

启动 dev，访问 ledger 页面：

1. 点击**成功**行 → hero 区绿色，无错误条，双栏并排显示
2. 点击**失败**行 → hero 区红色 + 错误条（monospace 字体 + 红底）
3. 点击**缺失**行 → hero 区琥珀，无错误条
4. 报告范围：超过 8 个项目时显示 `+N 更多`，点击展开/收起
5. 截图区：点击缩略图打开 PortraitScreenshotDialog
6. AI 文案区：点击「复制」按钮，浏览器通知「已复制」
7. 操作栏：失败时显示「重试」，其它显示「补发」；粘底可见

- [ ] **步骤 6：验证移动端卡片列表不受影响**

把浏览器窗口拉到 md 以下（< 768px）：

1. 卡片列表显示，**不显示分组表格**
2. 卡片点击仍打开 Sheet（同一个 LedgerDetailSheet）
3. 移动端的缩略图 / AI 文案按钮仍能工作（这些按钮在 LedgerDetailSheet 之外保留在 page.tsx 移动端代码里 —— **保留这部分**，不动）

注：移动端仍需要 `setPreviewScreenshotUrl` / `setPreviewSummary` —— **不删除**这两个 state 的移动端使用，**只删除** Sheet 和 AI 文案 Dialog 里的相关代码。

具体做法：把第 75-76 行的 `previewScreenshotUrl` / `previewSummary` state 保留（移动端按钮还要用），第 605-641 行的 Sheet 内预览 Dialog 代码删除，移动端卡片代码（约 386-462 行）保留。

第 605-613 行的 PortraitScreenshotDialog 渲染可保留（移动端使用）。

- [ ] **步骤 7：Commit**

```bash
git add frontend/app/dashboard/data-analysis/scheduled-reports/ledger/page.tsx \
        frontend/app/dashboard/data-analysis/scheduled-reports/_components/LedgerDetailSheet.tsx
git commit -m "feat(scheduled-reports): redesign ledger detail sheet with hero + dual column"
```

---

### 任务 6：验证 + 清理

- [ ] **步骤 1：lint**

```bash
cd frontend && pnpm lint 2>&1 | tail -30
```

预期：无 error（warning 可接受）。

- [ ] **步骤 2：typecheck**

```bash
cd frontend && pnpm tsc --noEmit 2>&1 | tail -20
```

预期：exit code 0。

- [ ] **步骤 3：完整流程手工测试**

1. 加载 `/ledger` → 默认只有今天展开 ✓
2. 改日期范围 → 展开锚点跟随末日 ✓
3. 改频率 → 展开状态保持 ✓
4. 改状态 → 展开状态保持 ✓
5. 改邮箱 → 展开状态保持 ✓
6. 点行空白 → Sheet 打开 ✓
7. Sheet 内 hero / 错误条 / 范围 / 双栏 / 操作 各区域正常 ✓
8. 失败行点 Sheet → 显示错误条 ✓
9. 截图点击 → 大图 Dialog ✓
10. AI 文案复制 → 浏览器通知 ✓
11. Sheet 内点重发 → loading 状态 + 完成后刷新列表 ✓
12. 移动端卡片列表不受影响 ✓
13. LedgerSummaryCards.tsx 文件保留（不删）但 ledger page 不再 import ✓

- [ ] **步骤 4：最终 Commit（如有清理）**

```bash
git status
# 如有 lint --fix 等自动修复：
git add -u
git commit -m "chore(scheduled-reports): ledger redesign lint fixes"
```

---

## 自检

**规格覆盖度：**

| 规格要求 | 任务 |
|----------|------|
| ① 工具栏砍 5 张统计卡 | 任务 1 |
| ② 表格按日分组（7 列） | 任务 2 + 3 |
| ③ 末日默认展开 + 筛选变更重置 | 任务 3 |
| ④ Sheet 重做（hero / 错误条 / 双栏 / 粘底） | 任务 4 + 5 |
| ⑤ 纯前端，不动后端 | 所有任务仅触及 frontend/app/dashboard/data-analysis/scheduled-reports/ |
| ⑥ LedgerSummaryCards 文件保留 | 任务 1 仅移除 import |

**占位符扫描：** 无 "待定" / "TODO" / 模糊表述。每个步骤都有具体代码。

**类型一致性：**
- `LedgerDayGroup` props 与任务 3 中的使用一致
- `LedgerDetailSheet` props 与任务 5 中的使用一致
- `format` / `cn` 等工具函数 import 一次，重复文件不重复 import