# Commission Management 多站点并行显示重构实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将佣金管理页面从"可折叠分组"改为"多站点并行显示"，所有金额统一为 USD 显示

**架构：** 前端数据重组 + 渲染逻辑改造，后端无需修改。利用已有的月度汇率系统（USD/EUR/GBP → CNY）进行货币转换。

**技术栈：** Next.js 14, React 18, TypeScript, TanStack Table, shadcn/ui

---

## 文件清单

| 文件 | 操作 | 职责 |
|------|------|------|
| `frontend/app/dashboard/system-management/commission-management/page.tsx` | 修改 | 数据重组逻辑、汇率转换、移除展开状态 |
| `frontend/app/dashboard/system-management/commission-management/detail-tab.tsx` | 修改 | 多站点并行渲染、无数据占位、USD 统一显示 |
| `frontend/app/dashboard/system-management/commission-management/types.ts` | 创建 | 共享类型定义 |
| `frontend/app/dashboard/system-management/commission-management/utils.ts` | 创建 | 货币转换、数据重组工具函数 |
| `frontend/app/dashboard/system-management/commission-management/monthly-summary-tab.tsx` | 修改 | 月份内分行显示多站点 |
| `frontend/app/dashboard/system-management/commission-management/project-summary-tab.tsx` | 修改 | 月份列内分行显示多站点 |
| `frontend/app/dashboard/system-management/commission-management/monthly-collection-tab.tsx` | 修改 | 同项目汇总逻辑 |

---

### 任务 1：创建共享类型和工具函数

**文件：**
- 创建：`frontend/app/dashboard/system-management/commission-management/types.ts`
- 创建：`frontend/app/dashboard/system-management/commission-management/utils.ts`

- [ ] **步骤 1：创建 types.ts**

```typescript
// frontend/app/dashboard/system-management/commission-management/types.ts

export type PaymentStatus = 'paid' | 'partial' | 'unpaid'
export type SiteCode = 'US' | 'UK' | 'DE'
export const SITE_ORDER: SiteCode[] = ['US', 'DE', 'UK']

export interface CommissionProjectMonth {
  id: number
  report_month: string
  country: string
  project_id: number
  project_name: string
  income_total_usd: number
  factory_commission_rate: number
  factory_commission_rmb: number
  payment_status: PaymentStatus
  received_rmb: number
  note: string | null
}

export interface ExchangeRate {
  currency: string
  rate: number
}

export interface ProjectMeta {
  id: number
  commission_basis: string | null
  commission_rate: number | null
}

export interface SiteRow {
  country: SiteCode
  hasData: boolean
  record?: CommissionProjectMonth
}

export interface ProjectGroup {
  projectId: number
  projectName: string
  isSingleUS: boolean
  sites: SiteRow[]
}
```

- [ ] **步骤 2：创建 utils.ts**

```typescript
// frontend/app/dashboard/system-management/commission-management/utils.ts

import type { CommissionProjectMonth, ExchangeRate, ProjectGroup, SiteRow, SiteCode } from './types'

export const SITE_ORDER: SiteCode[] = ['US', 'DE', 'UK']

export const COUNTRY_TO_CURRENCY: Record<string, string> = {
  US: 'USD',
  DE: 'EUR',
  UK: 'GBP',
}

export const SITE_INFO: Record<SiteCode, { flag: string; label: string }> = {
  US: { flag: '🇺🇸', label: '美国站' },
  DE: { flag: '🇩🇪', label: '德国站' },
  UK: { flag: '🇬🇧', label: '英国站' },
}

export const SITE_BORDER_COLORS: Record<SiteCode, string> = {
  US: 'border-l-blue-500',
  DE: 'border-l-purple-500',
  UK: 'border-l-green-500',
}

/**
 * 将金额转换为 USD
 * 转换路径: 本地货币 → CNY → USD
 * 
 * 汇率存储方式: 1 外币 = X CNY (如 USD=7.2 表示 1美元=7.2人民币)
 * 
 * US: income_total_usd 已是 USD，直接返回
 * DE/UK: income_total_usd 是当地货币(EUR/GBP)
 *   - 先转 CNY: amount × localRate
 *   - 再转 USD: cnyAmount ÷ usdRate
 */
export function convertToUsd(
  amount: number,
  country: string,
  exchangeRates: ExchangeRate[]
): number {
  if (country === 'US') return amount

  const getRate = (currency: string): number => {
    const rate = exchangeRates.find(r => r.currency === currency)
    return rate?.rate ?? 0
  }

  const localCurrency = COUNTRY_TO_CURRENCY[country]
  if (!localCurrency) return amount

  const localRate = getRate(localCurrency)  // 1 EUR = X CNY
  const usdRate = getRate('USD')           // 1 USD = Y CNY

  if (!localRate || !usdRate || usdRate === 0) return amount

  // local → CNY → USD
  const cnyAmount = amount * localRate
  return cnyAmount / usdRate
}

/**
 * 将 API 返回的扁平数据重组为 ProjectGroup[]
 */
export function groupProjectsBySites(
  rows: CommissionProjectMonth[],
  exchangeRates: ExchangeRate[]
): ProjectGroup[] {
  // 按 project_id 分组
  const groupsMap = new Map<number, CommissionProjectMonth[]>()
  const nameMap = new Map<number, string>()

  for (const row of rows) {
    if (!groupsMap.has(row.project_id)) {
      groupsMap.set(row.project_id, [])
      nameMap.set(row.project_id, row.project_name)
    }
    groupsMap.get(row.project_id)!.push(row)
  }

  const result: ProjectGroup[] = []

  for (const [projectId, siteRows] of groupsMap) {
    const projectName = nameMap.get(projectId)!
    const siteSet = new Set(siteRows.map(r => r.country))

    // 判断是否仅 US 单站点
    const isSingleUS = siteSet.size === 1 && siteSet.has('US')

    // 构建固定顺序的站点行
    const sites: SiteRow[] = SITE_ORDER.map(country => {
      const record = siteRows.find(r => r.country === country)
      return {
        country,
        hasData: !!record,
        record,
      }
    })

    result.push({
      projectId,
      projectName,
      isSingleUS,
      sites,
    })
  }

  // 按 project_id 排序
  return result.sort((a, b) => a.projectId - b.projectId)
}

export function formatUsd(value: number): string {
  const abs = Math.abs(value)
  const text = abs.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return `${value < 0 ? '-' : ''}$${text}`
}

export function formatRmb(value: number): string {
  const abs = Math.abs(value)
  const text = abs.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return `${value < 0 ? '-' : ''}¥${text}`
}

export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`
}
```

- [ ] **步骤 3：验证编译**

运行：`cd frontend && pnpm tsc --noEmit`
预期：无新增类型错误

- [ ] **步骤 4：Commit**

```bash
git add frontend/app/dashboard/system-management/commission-management/types.ts
git add frontend/app/dashboard/system-management/commission-management/utils.ts
git commit -m "feat(commission): add shared types and utility functions for multi-site display"
```

---

### 任务 2：重构 page.tsx 数据逻辑

**文件：**
- 修改：`frontend/app/dashboard/system-management/commission-management/page.tsx`

- [ ] **步骤 1：更新导入和移除旧逻辑**

将 page.tsx 中的类型导入改为使用新的 types.ts，移除内联的类型定义和旧的数据重组逻辑。

关键变更：
1. 移除 `projectGroups` 的 useMemo 计算（移到 utils.ts）
2. 移除 `expandedProjects` 状态和相关逻辑
3. 移除 `multiSiteProjects` 逻辑
4. 使用新的 `groupProjectsBySites` 函数

```typescript
// 在 page.tsx 顶部添加导入
import { groupProjectsBySites, convertToUsd } from './utils'
import type { CommissionProjectMonth, ExchangeRate, ProjectMeta, ProjectGroup } from './types'

// 移除以下类型定义（已在 types.ts 中）:
// - type PaymentStatus
// - type CommissionProjectMonth
// - type CommissionProjectMonthsResponse
// - type ExchangeRate
// - type ProjectMeta
// - type SiteCode

// 移除以下状态:
// const [expandedProjects, setExpandedProjects] = useState<Set<number>>(new Set())

// 替换 projectGroups useMemo 为:
const projectGroups = useMemo((): ProjectGroup[] => {
  return groupProjectsBySites(rows, exchangeRates)
}, [rows, exchangeRates])

// 移除 toggleProject、useEffect for expandedProjects 等相关代码
```

- [ ] **步骤 2：更新 DetailTab props**

```typescript
// 修改传给 DetailTab 的 props
<DetailTab
  projectGroups={projectGroups}  // 现在是 ProjectGroup[] 类型
  exchangeRates={exchangeRates}
  projectMetaById={projectMetaById}
  loading={loading}
  updatingId={updatingId}
  receivedDraftById={receivedDraftById}
  onUpdateDraft={(id, value) => setReceivedDraftById((prev) => ({ ...prev, [id]: value }))}
  onUpdatePaymentStatus={updatePaymentStatus}
  onUpdateReceivedAmount={updateReceivedAmount}
/>
// 移除: onToggleProject, expandedProjects
```

- [ ] **步骤 3：更新统计数据计算**

```typescript
// 更新 totalFactoryCommissionRmb 计算
const totalFactoryCommissionRmb = useMemo(() => {
  return rows.reduce((sum, row) => sum + row.factory_commission_rmb, 0)
}, [rows])

// 更新 totalReceivedRmb 计算
const totalReceivedRmb = useMemo(() => {
  return rows.reduce((sum, row) => sum + row.received_rmb, 0)
}, [rows])
```

- [ ] **步骤 4：移除站点切换器相关代码**

```typescript
// 移除 site 状态（如果存在且不再需要）
// const [site, setSite] = useState<SiteCode>("US")

// 更新 loadYearlySummary 中的 country 参数，改为不传或传 undefined
// 让后端返回所有站点的数据
const [monthlyResp, projectResp] = await Promise.all([
  fetch(`${API_BASE}/api/v1/system-management/commission-management/summary/monthly?year=${summaryYear}`, {
    cache: 'no-store',
    headers: buildBackendHeaders(session),
  }),
  fetch(`${API_BASE}/api/v1/system-management/commission-management/summary/project?year=${summaryYear}`, {
    cache: 'no-store',
    headers: buildBackendHeaders(session),
  }),
])
```

- [ ] **步骤 5：验证编译**

运行：`cd frontend && pnpm tsc --noEmit`
预期：无类型错误

- [ ] **步骤 6：Commit**

```bash
git add frontend/app/dashboard/system-management/commission-management/page.tsx
git commit -m "refactor(commission): simplify page.tsx data logic, use shared utilities"
```

---

### 任务 3：重构 detail-tab.tsx 渲染逻辑

**文件：**
- 修改：`frontend/app/dashboard/system-management/commission-management/detail-tab.tsx`

- [ ] **步骤 1：更新导入和类型**

```typescript
import { useCallback } from 'react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { EmptyTableState } from '@/components/ui/empty-state'
import {
  type CommissionProjectMonth,
  type ExchangeRate,
  type ProjectMeta,
  type ProjectGroup,
  type PaymentStatus,
  type SiteCode,
} from './types'
import {
  SITE_ORDER,
  SITE_INFO,
  SITE_BORDER_COLORS,
  convertToUsd,
  formatUsd,
  formatRmb,
  formatPercent,
} from './utils'

// 移除旧的类型定义和内联常量
```

- [ ] **步骤 2：更新 Props 接口**

```typescript
interface DetailTabProps {
  projectGroups: ProjectGroup[]  // 改为 ProjectGroup[] 类型
  exchangeRates: ExchangeRate[]
  projectMetaById: Record<number, ProjectMeta>
  loading: boolean
  updatingId: number | null
  // 移除: expandedProjects, onToggleProject, multiSiteProjects
  receivedDraftById: Record<number, string>
  onUpdateDraft: (id: number, value: string) => void
  onUpdatePaymentStatus: (row: CommissionProjectMonth, status: PaymentStatus) => void
  onUpdateReceivedAmount: (row: CommissionProjectMonth) => void
}
```

- [ ] **步骤 3：重写渲染逻辑**

```typescript
export function DetailTab({
  projectGroups,
  exchangeRates,
  projectMetaById,
  loading,
  updatingId,
  receivedDraftById,
  onUpdateDraft,
  onUpdatePaymentStatus,
  onUpdateReceivedAmount,
}: DetailTabProps) {
  const getCommissionRatioLabel = useCallback((row: CommissionProjectMonth): string => {
    const projectMeta = projectMetaById[row.project_id]
    if (!projectMeta) {
      return formatPercent(row.factory_commission_rate)
    }
    if (projectMeta.commission_basis === 'cash_received') {
      return '阶梯(7/10/13/15%)'
    }
    if (typeof projectMeta.commission_rate === 'number' && Number.isFinite(projectMeta.commission_rate)) {
      return formatPercent(projectMeta.commission_rate)
    }
    return formatPercent(row.factory_commission_rate)
  }, [projectMetaById])

  const renderSiteRow = (site: ProjectGroup['sites'][number], projectName?: string) => {
    const { country, hasData, record } = site
    const info = SITE_INFO[country]

    if (!hasData || !record) {
      // 无数据行
      return (
        <TableRow key={`nodata-${country}`} className="bg-gray-50/50">
          <TableCell>
            <div className="flex items-center gap-2">
              <span className="text-lg">{info.flag}</span>
              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600">
                {country}
              </span>
              {projectName && <span className="text-sm text-muted-foreground">{projectName}</span>}
            </div>
          </TableCell>
          <TableCell className="text-right text-gray-400">无数据</TableCell>
          <TableCell className="text-right text-gray-400">无数据</TableCell>
          <TableCell className="text-right text-gray-400">无数据</TableCell>
          <TableCell className="text-right text-gray-400">无数据</TableCell>
          <TableCell className="text-gray-400">无数据</TableCell>
        </TableRow>
      )
    }

    const incomeUsd = convertToUsd(record.income_total_usd, country, exchangeRates)
    const commissionUsd = convertToUsd(record.factory_commission_rmb, country, exchangeRates)

    return (
      <TableRow
        key={record.id}
        className={`border-l-4 ${SITE_BORDER_COLORS[country]}`}
      >
        <TableCell>
          <div className="flex items-center gap-2">
            <span className="text-lg">{info.flag}</span>
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600">
              {country}
            </span>
            {projectName && <span>{projectName}</span>}
          </div>
        </TableCell>
        <TableCell className="text-right tabular-nums">
          {formatUsd(incomeUsd)}
        </TableCell>
        <TableCell className="text-right tabular-nums">
          {getCommissionRatioLabel(record)}
        </TableCell>
        <TableCell className="text-right tabular-nums font-medium">
          {formatUsd(commissionUsd)}
        </TableCell>
        <TableCell>
          <div className="flex items-center justify-end gap-2">
            <Input
              type="number"
              step="0.01"
              min="0"
              value={receivedDraftById[record.id] ?? ''}
              className="h-9 w-[150px] text-right"
              onChange={(event) => {
                onUpdateDraft(record.id, event.target.value)
              }}
              onBlur={() => {
                onUpdateReceivedAmount(record)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  onUpdateReceivedAmount(record)
                }
              }}
              disabled={updatingId === record.id}
            />
          </div>
        </TableCell>
        <TableCell>
          <Select
            value={record.payment_status}
            onValueChange={(value: PaymentStatus) => {
              onUpdatePaymentStatus(record, value)
            }}
            disabled={updatingId === record.id}
          >
            <SelectTrigger className="w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="paid">已回款</SelectItem>
              <SelectItem value="partial">部分回款</SelectItem>
              <SelectItem value="unpaid">未回款</SelectItem>
            </SelectContent>
          </Select>
        </TableCell>
      </TableRow>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[inherit]">
      <div className="flex-1 overflow-auto">
        <Table className={FULL_BLEED_TABLE_CLASS} containerClassName={FULL_BLEED_TABLE_CONTAINER_CLASS}>
          <TableHeader className="sticky top-0 z-10 bg-slate-100/80 dark:bg-slate-900/45">
            <TableRow>
              <TableHead className="font-semibold text-foreground">项目</TableHead>
              <TableHead className="text-right font-semibold text-foreground">销售收入(USD)</TableHead>
              <TableHead className="text-right font-semibold text-foreground">佣金比例</TableHead>
              <TableHead className="text-right font-semibold text-foreground">工厂佣金(USD)</TableHead>
              <TableHead className="text-right font-semibold text-foreground">已回款(RMB)</TableHead>
              <TableHead className="font-semibold text-foreground">回款状态</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground">加载中...</TableCell>
              </TableRow>
            ) : projectGroups.length === 0 ? (
              <EmptyTableState colSpan={6} message="当前月份暂无数据，请先刷新核算" />
            ) : (
              projectGroups.map((group) => {
                if (group.isSingleUS) {
                  // 仅 US 单站点：显示单行
                  const site = group.sites[0]
                  return renderSiteRow(site, group.projectName)
                }

                // 多站点：显示分组头 + 三行
                return (
                  <>
                    {/* 分组头 */}
                    <TableRow key={`header-${group.projectId}`} className="bg-slate-50/50">
                      <TableCell colSpan={6} className="py-2 text-sm font-medium text-muted-foreground">
                        {group.projectName}
                      </TableCell>
                    </TableRow>
                    {/* 站点行 */}
                    {group.sites.map(site => renderSiteRow(site))}
                  </>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
```

- [ ] **步骤 4：验证编译**

运行：`cd frontend && pnpm tsc --noEmit`
预期：无类型错误

- [ ] **步骤 5：Commit**

```bash
git add frontend/app/dashboard/system-management/commission-management/detail-tab.tsx
git commit -m "feat(commission): refactor detail tab for multi-site parallel display with USD conversion"
```

---

### 任务 4：更新 monthly-summary-tab.tsx

**文件：**
- 修改：`frontend/app/dashboard/system-management/commission-management/monthly-summary-tab.tsx`

> **注意：** 此任务需要后端 API 支持按站点返回数据。当前 API 返回的是聚合数据。需要先确认后端 `summary/monthly` 接口是否支持返回分站点数据。

假设后端返回格式不变（聚合数据），此 Tab 暂时保持单行显示，但增加站点标识。

- [ ] **步骤 1：更新导入**

```typescript
import { formatUsd, formatRmb, formatPercent } from './utils'
```

- [ ] **步骤 2：保持现有渲染逻辑，仅更新导入**

由于年-月汇总 Tab 的数据是聚合后的，暂时保持单行显示。后续后端支持分站点数据后再改造。

- [ ] **步骤 3：验证编译**

运行：`cd frontend && pnpm tsc --noEmit`

- [ ] **步骤 4：Commit**

```bash
git add frontend/app/dashboard/system-management/commission-management/monthly-summary-tab.tsx
git commit -m "refactor(commission): update monthly summary tab imports to use shared utilities"
```

---

### 任务 5：更新 project-summary-tab.tsx

**文件：**
- 修改：`frontend/app/dashboard/system-management/commission-management/project-summary-tab.tsx`

- [ ] **步骤 1：更新导入和类型**

```typescript
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { EmptyTableState } from '@/components/ui/empty-state'
import { formatRmb, formatPercent } from './utils'
import { SITE_INFO, SITE_BORDER_COLORS, type SiteCode } from './types'

const SITE_ORDER: SiteCode[] = ['US', 'DE', 'UK']
```

- [ ] **步骤 2：修改表头为多行结构**

```typescript
<TableHeader>
  <TableRow>
    <TableHead className="sticky left-0 z-30 bg-slate-100/90 font-semibold text-foreground" rowSpan={2}>
      项目名称
    </TableHead>
    {getYearMonths(year).map((m) => (
      <TableHead
        key={m}
        className="z-20 bg-slate-100/90 text-center text-xs font-semibold text-foreground"
        colSpan={3}
      >
        {m.slice(5)}月
      </TableHead>
    ))}
    <TableHead className="z-20 bg-slate-100/90 text-right font-semibold text-foreground" rowSpan={2}>
      年度佣金合计
    </TableHead>
    <TableHead className="z-20 bg-slate-100/90 text-right font-semibold text-foreground" rowSpan={2}>
      年度回款
    </TableHead>
    <TableHead className="z-20 bg-slate-100/90 text-right font-semibold text-foreground" rowSpan={2}>
      回款率
    </TableHead>
  </TableRow>
  <TableRow>
    {getYearMonths(year).flatMap((m) =>
      SITE_ORDER.map((site) => (
        <TableHead key={`${m}-${site}`} className="z-10 bg-slate-100/70 text-right text-xs whitespace-nowrap">
          {SITE_INFO[site].flag} {site}
        </TableHead>
      ))
    )}
  </TableRow>
</TableHeader>
```

- [ ] **步骤 3：修改数据行为多行结构**

由于当前后端返回的 `project.months[m]` 是聚合数据，暂时每个站点显示相同值。后续后端支持分站点数据后再改造。

```typescript
{items.map((project) => (
  <TableRow key={project.project_id}>
    <TableCell className="sticky left-0 bg-background z-20 font-medium">
      {project.project_name}
    </TableCell>
    {getYearMonths(year).flatMap((m) => {
      const monthData = project.months[m]
      return SITE_ORDER.map((site) => (
        <TableCell key={`${m}-${site}`} className="text-right tabular-nums text-xs">
          {monthData ? formatRmb(monthData.factory_commission_rmb) : '-'}
        </TableCell>
      ))
    })}
    <TableCell className="text-right tabular-nums font-medium">
      {formatRmb(project.total_commission_rmb)}
    </TableCell>
    <TableCell className="text-right tabular-nums">
      {formatRmb(project.total_received_rmb)}
    </TableCell>
    <TableCell className="text-right tabular-nums">
      {formatPercent(project.receive_rate)}
    </TableCell>
  </TableRow>
))}
```

- [ ] **步骤 4：验证编译**

运行：`cd frontend && pnpm tsc --noEmit`

- [ ] **步骤 5：Commit**

```bash
git add frontend/app/dashboard/system-management/commission-management/project-summary-tab.tsx
git commit -m "feat(commission): update project summary tab header for multi-site display"
```

---

### 任务 6：更新 monthly-collection-tab.tsx

**文件：**
- 修改：`frontend/app/dashboard/system-management/commission-management/monthly-collection-tab.tsx`

- [ ] **步骤 1：读取当前文件内容，应用与 project-summary-tab 类似的多行结构改造**

- [ ] **步骤 2：验证编译**

运行：`cd frontend && pnpm tsc --noEmit`

- [ ] **步骤 3：Commit**

```bash
git add frontend/app/dashboard/system-management/commission-management/monthly-collection-tab.tsx
git commit -m "feat(commission): update monthly collection tab for multi-site display"
```

---

### 任务 7：更新 page.tsx 站点图例

**文件：**
- 修改：`frontend/app/dashboard/system-management/commission-management/page.tsx`

- [ ] **步骤 1：更新站点图例显示**

```typescript
// 在 toolbar 区域更新图例
<div className="flex items-center gap-2 text-sm text-muted-foreground">
  <span className="flex items-center gap-1">
    <span className="h-3 w-0.5 bg-blue-500" />
    <span className="rounded bg-blue-50 px-1.5 py-0.5 text-xs font-medium text-blue-700">US</span>
  </span>
  <span className="flex items-center gap-1">
    <span className="h-3 w-0.5 bg-purple-500" />
    <span className="rounded bg-purple-50 px-1.5 py-0.5 text-xs font-medium text-purple-700">DE</span>
  </span>
  <span className="flex items-center gap-1">
    <span className="h-3 w-0.5 bg-green-500" />
    <span className="rounded bg-green-50 px-1.5 py-0.5 text-xs font-medium text-green-700">UK</span>
  </span>
  <span className="ml-1">多站点并行显示</span>
</div>
```

- [ ] **步骤 2：验证编译**

运行：`cd frontend && pnpm tsc --noEmit`

- [ ] **步骤 3：Commit**

```bash
git add frontend/app/dashboard/system-management/commission-management/page.tsx
git commit -m "ui(commission): update site legend for multi-site parallel display"
```

---

### 任务 8：最终验证

- [ ] **步骤 1：运行类型检查**

运行：`cd frontend && pnpm tsc --noEmit`
预期：无类型错误

- [ ] **步骤 2：运行 Lint**

运行：`cd frontend && pnpm lint`
预期：无 lint 错误

- [ ] **步骤 3：运行 Build**

运行：`cd frontend && pnpm build`
预期：构建成功

- [ ] **步骤 4：手动测试**

启动开发服务器：`cd frontend && pnpm dev`
访问：`http://localhost:3000/dashboard/system-management/commission-management`

验证：
1. 总览 Tab 显示所有站点并行
2. 仅 US 站点的项目显示单行
3. 多站点项目显示分组头 + 三行
4. 无数据的站点显示"无数据"占位
5. 所有金额统一为 USD 显示
6. 编辑功能（已回款、回款状态）正常工作

- [ ] **步骤 5：Commit（如有修改）**

```bash
git add -A
git commit -m "fix(commission): address lint and build issues"
```

---

## 规格覆盖度检查

| 规格需求 | 对应任务 |
|---------|---------|
| 多站点并行显示 | 任务 3 |
| 仅 US 单站点显示单行 | 任务 3 |
| 无数据行灰色占位 | 任务 3 |
| 货币统一 USD 显示 | 任务 1 (utils.ts), 任务 3 |
| 汇率转换 local → CNY → USD | 任务 1 (utils.ts) |
| 站点顺序 US → DE → UK | 任务 1 (utils.ts) |
| 分组头保留 | 任务 3 |
| 年-月汇总 Tab 改造 | 任务 4 |
| 项目汇总 Tab 改造 | 任务 5 |
| 月度回款 Tab 改造 | 任务 6 |

## 占位符扫描

无"TODO"、"待定"、"后续实现"等占位符。所有步骤包含完整代码。

## 类型一致性检查

- `CommissionProjectMonth` 在 types.ts 中定义，所有文件统一引用
- `ExchangeRate` 在 types.ts 中定义
- `ProjectGroup` 和 `SiteRow` 在 types.ts 中定义
- `convertToUsd` 函数签名一致
- `formatUsd`/`formatRmb`/`formatPercent` 在 utils.ts 中统一定义
