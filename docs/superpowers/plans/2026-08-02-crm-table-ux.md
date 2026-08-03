# CRM Table 可用性补强 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 给 CRM 三张表（客户/线索/公海）补上关键词搜索框、每页条数选择器、跳页、吸顶表头，并把公海表升级到与客户表一致（筛选/搜索/导出/进公海时长列/来源徽章）。

**Architecture:** 搜索框做成 `CrmTable` 的 `searchable` prop（hook 由 CrmTable 内部持有，最 DRY），用新增 `useDebounce` hook 防抖后写 URL keyword；分页脚加每页条数 select + 首末页 + 跳页输入；表头 `sticky`。公海表 mirror 客户表范式补 filterFields/searchable/导出/进公海时长列。纯前端，零后端改动（导出 scope=sea 后端已支持）。

**Tech Stack:** Next.js + React + TypeScript + Vitest + @testing-library/react。

**Spec/评审来源:** 本计划源自 2026-07-31 CRM table 评审的 P0/P1 清单（搜索框、公海表升级、每页条数、吸顶表头、跳页）。

## Global Constraints

- 前端测试顺序：`pnpm lint` → `pnpm build` → `pnpm test`（Vitest, jsdom）；必须全绿。
- **纯前端**：无后端改动、无迁移、无 VPS 部署。推 main 后前端由 Vercel 自动部署。
- Commit：中文 + Conventional Commits，scope 中文，subject 动宾短语 ≤50 字无句号。
- **只 stage 本任务点名文件**，严禁 `git add -A`（worktree 干净，但保持纪律）。
- `useCrmTable` 已内置 `keyword/setKeyword/setPageSize`（URL 状态），本计划只补 UI，不动 hook 的状态逻辑。
- 现有 `CrmTable` 测试（index.test.tsx）用真 hook + mock next/navigation；新测试沿用此范式，防抖测试用 `vi.useFakeTimers()`。

## File Structure

- `frontend/hooks/use-debounce.ts`（新）+ `frontend/hooks/use-debounce.test.ts`（新）
- `frontend/components/crm/crm-table/crm-search-input.tsx`（新）— 防抖搜索框
- `frontend/components/crm/crm-table/index.tsx`（改）— searchable prop + 吸顶表头 + 分页脚升级（每页条数/首末页/跳页）
- `frontend/components/crm/crm-table/index.test.tsx`（改）— 搜索/分页新测试
- `frontend/components/crm/customer-table.tsx`（改）— 启用 searchable
- `frontend/components/crm/lead-table.tsx`（改）— 启用 searchable
- `frontend/components/crm/sea-table.tsx`（改）— filterFields + searchable + 导出 + 进公海时长列 + 来源徽章
- `frontend/app/dashboard/crm/sea/page.tsx`（可能改）— 公海表刷新/工具栏

---

## Task 1: useDebounce hook

**Files:** Create `frontend/hooks/use-debounce.ts`、`frontend/hooks/use-debounce.test.ts`

**Interfaces:** Produces `useDebounce<T>(value: T, delay = 300): T` —— 返回 value 的防抖版本（delay 内不再变化才更新）。Task 2 的搜索框用它。

- [x] **Step 1: 写失败测试**（Create `frontend/hooks/use-debounce.test.ts`）

```ts
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { useDebounce } from './use-debounce'

describe('useDebounce', () => {
  afterEach(() => vi.useRealTimers())

  it('初始返回原值', () => {
    const { result } = renderHook(() => useDebounce('a', 300))
    expect(result.current).toBe('a')
  })

  it('delay 内不更新，delay 后更新为最新值', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ v }) => useDebounce(v, 300), {
      initialProps: { v: 'a' },
    })
    rerender({ v: 'ab' })
    rerender({ v: 'abc' })
    expect(result.current).toBe('a') // 还没到 delay
    act(() => { vi.advanceTimersByTime(300) })
    expect(result.current).toBe('abc') // 取最后一次
  })
})
```

- [x] **Step 2: 跑测试确认失败** — Run: `cd frontend && pnpm vitest run hooks/use-debounce.test.ts` → FAIL（模块不存在）

- [x] **Step 3: 实现 hook**（Create `frontend/hooks/use-debounce.ts`）

```ts
import { useEffect, useState } from 'react'

/** 返回 value 的防抖版本：value 变化后 delay ms 内不再变化才更新。 */
export function useDebounce<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return debounced
}
```

- [x] **Step 4: 跑测试通过** — Run: `cd frontend && pnpm vitest run hooks/use-debounce.test.ts` → PASS

- [x] **Step 5: Commit**

```bash
git add frontend/hooks/use-debounce.ts frontend/hooks/use-debounce.test.ts
git commit -m "feat(crm): 新增 useDebounce 防抖 hook"
```

---

## Task 2: CrmTable 升级（搜索框 + 吸顶表头 + 分页脚）

**Files:** Create `frontend/components/crm/crm-table/crm-search-input.tsx`；Modify `frontend/components/crm/crm-table/index.tsx`、`frontend/components/crm/crm-table/types.ts`、`frontend/components/crm/customer-table.tsx`、`frontend/components/crm/lead-table.tsx`、`frontend/components/crm/crm-table/index.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `useDebounce`。
- Produces:
  - `CrmSearchInput({ value, onChange, placeholder })` —— 受控防抖搜索框（内部 local text → useDebounce → 与 value 不同才 onChange；value 外部变化时同步 local text）。
  - `CrmTableProps` 新增 `searchable?: boolean`、`searchPlaceholder?: string`。
  - CrmTable 表头吸顶；分页脚含每页条数 select（20/50/100）+ 首页/末页按钮 + 跳页输入。
  - customer-table / lead-table 启用 `searchable`。

- [x] **Step 1: 写 CrmSearchInput 失败测试**（追加到 `frontend/components/crm/crm-table/index.test.tsx` 或新建 `crm-search-input.test.tsx`；下例新建）

Create `frontend/components/crm/crm-table/crm-search-input.test.tsx`：

```tsx
import { act, render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { CrmSearchInput } from './crm-search-input'

describe('CrmSearchInput', () => {
  afterEach(() => vi.useRealTimers())

  it('输入防抖后触发 onChange', () => {
    vi.useFakeTimers()
    const onChange = vi.fn()
    render(<CrmSearchInput value="" onChange={onChange} placeholder="搜索" />)
    fireEvent.change(screen.getByPlaceholderText('搜索'), { target: { value: '甲' } })
    expect(onChange).not.toHaveBeenCalledWith('甲') // 未防抖完
    act(() => { vi.advanceTimersByTime(300) })
    expect(onChange).toHaveBeenCalledWith('甲')
  })

  it('外部 value 变化同步到输入框', () => {
    const { rerender } = render(<CrmSearchInput value="" onChange={() => {}} placeholder="搜索" />)
    rerender(<CrmSearchInput value="外部" onChange={() => {}} placeholder="搜索" />)
    expect((screen.getByPlaceholderText('搜索') as HTMLInputElement).value).toBe('外部')
  })
})
```

- [x] **Step 2: 跑测试确认失败** — Run: `cd frontend && pnpm vitest run components/crm/crm-table/crm-search-input.test.tsx` → FAIL

- [x] **Step 3: 实现 CrmSearchInput**（Create `frontend/components/crm/crm-table/crm-search-input.tsx`）

```tsx
'use client'

import { useEffect, useState } from 'react'
import { Search, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { useDebounce } from '@/hooks/use-debounce'

export interface CrmSearchInputProps {
  value: string
  onChange: (next: string) => void
  placeholder?: string
}

/** 防抖搜索框：local text → useDebounce(300ms) → 与 value 不同才 onChange；value 外部变化时回填。 */
export function CrmSearchInput({ value, onChange, placeholder = '搜索…' }: CrmSearchInputProps) {
  const [text, setText] = useState(value)
  const debounced = useDebounce(text, 300)

  useEffect(() => {
    if (debounced !== value) onChange(debounced)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在防抖值变化时写回
  }, [debounced])

  useEffect(() => {
    setText(value)
  }, [value])

  return (
    <div className="relative w-56">
      <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        className="h-8 pl-7 pr-7"
        aria-label={placeholder}
      />
      {text && (
        <button
          type="button"
          aria-label="清空搜索"
          onClick={() => setText('')}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}
```

- [x] **Step 4: 跑测试通过** — Run: `cd frontend && pnpm vitest run components/crm/crm-table/crm-search-input.test.tsx` → PASS

- [x] **Step 5: types.ts 加 prop**（Modify `frontend/components/crm/crm-table/types.ts`，`CrmTableProps` 内 `filterFields?` 后追加）

```ts
  /** 是否显示关键词搜索框（写入 URL keyword，hook 已支持） */
  searchable?: boolean
  /** 搜索框占位符 */
  searchPlaceholder?: string
```

- [x] **Step 6: 改 CrmTable index.tsx**（Modify `frontend/components/crm/crm-table/index.tsx`）

6a. 顶部 import 补：

```tsx
import { CrmSearchInput } from './crm-search-input'
import { ChevronsLeft, ChevronsRight } from 'lucide-react'
```

6b. 解构 props 补 `searchable = false, searchPlaceholder`（在 `filterFields = []` 旁）。

6c. 把筛选行容器改为「搜索框 + 筛选」工具栏（替换原 `{filterFields.length > 0 && (...)}` 块）：

```tsx
      {(searchable || filterFields.length > 0) && (
        <div className="mb-2 flex flex-wrap items-center gap-3">
          {searchable && (
            <CrmSearchInput
              value={table.keyword}
              onChange={table.setKeyword}
              placeholder={searchPlaceholder}
            />
          )}
          {filterFields.map((f) => (
            <label key={f.key} className="flex items-center gap-1 text-sm">
              <span className="text-muted-foreground">{f.label}</span>
              <select
                aria-label={f.label}
                className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                value={_filterSelectValue(table.filters, f.field ?? f.key)}
                onChange={(e) => handleFilterChange(f.field ?? f.key, e.target.value)}
              >
                <option value="">全部</option>
                {(f.options ?? []).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      )}
```

6d. 表头吸顶：把 `<TableHeader>` 改为 `<TableHeader className="sticky top-0 z-10 bg-background">`。

6e. 分页脚升级（替换原 `{showPagination && (...)}` 块为下方版本；`totalPages` 已在上方计算）：

```tsx
      {table.total > 0 && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
          <div className="flex items-center gap-3">
            <span>共 {table.total} 条</span>
            <label className="flex items-center gap-1">
              每页
              <select
                aria-label="每页条数"
                value={table.pageSize}
                onChange={(e) => table.setPageSize(Number(e.target.value))}
                className="h-7 rounded-md border border-input bg-background px-1 text-sm"
              >
                {[20, 50, 100].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="sm" disabled={table.page <= 1} onClick={() => table.setPage(1)} aria-label="首页">
              <ChevronsLeft className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="sm" disabled={table.page <= 1} onClick={() => table.setPage(table.page - 1)} aria-label="上一页">
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="px-1">
              第 {table.page} / {totalPages} 页
            </span>
            <Button variant="outline" size="sm" disabled={table.page >= totalPages} onClick={() => table.setPage(table.page + 1)} aria-label="下一页">
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="sm" disabled={table.page >= totalPages} onClick={() => table.setPage(totalPages)} aria-label="末页">
              <ChevronsRight className="h-4 w-4" />
            </Button>
            {totalPages > 1 && <PageJump totalPages={totalPages} onJump={table.setPage} />}
          </div>
        </div>
      )}
```

6f. 在 `CrmTable` 函数**之前**加 `PageJump` 小组件（同文件内）：

```tsx
function PageJump({ totalPages, onJump }: { totalPages: number; onJump: (p: number) => void }) {
  const [val, setVal] = useState('')
  const commit = () => {
    const n = Number.parseInt(val, 10)
    if (Number.isFinite(n) && n >= 1 && n <= totalPages) onJump(n)
    setVal('')
  }
  return (
    <span className="ml-1 flex items-center gap-1">
      <input
        type="number"
        min={1}
        max={totalPages}
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') commit() }}
        aria-label="跳转到页码"
        className="h-7 w-14 rounded-md border border-input bg-background px-1 text-sm"
        placeholder="页码"
      />
      <Button variant="outline" size="sm" onClick={commit} disabled={!val}>
        跳
      </Button>
    </span>
  )
}
```

（`useState` 已在文件顶部 import。）

- [x] **Step 7: 启用 searchable（customer/lead）**

`frontend/components/crm/customer-table.tsx` 的 `<CrmTable<Customer>` 加 `searchable searchPlaceholder="搜索客户名 / 简称…"`。
`frontend/components/crm/lead-table.tsx` 的 `<CrmTable<Lead>` 加 `searchable searchPlaceholder="搜索联系人 / 公司…"`。

- [x] **Step 8: 加 CrmTable 搜索/分页集成测试**（追加到 `frontend/components/crm/crm-table/index.test.tsx`；沿用该文件现有 mock next/navigation + 真 hook 范式）

```tsx
  it('searchable 渲染搜索框，输入防抖后按 keyword 拉数', async () => {
    vi.useFakeTimers()
    const fetchPage = vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 })
    render(
      <CrmTable queryKey="t" fetchPage={fetchPage} columns={[{ key: 'name', title: '名' }]} rowKey="id" searchable searchPlaceholder="搜名" />
    )
    fireEvent.change(screen.getByPlaceholderText('搜名'), { target: { value: '甲' } })
    act(() => { vi.advanceTimersByTime(300) })
    await vi.waitFor(() =>
      expect(fetchPage).toHaveBeenCalledWith(expect.objectContaining({ keyword: '甲' }))
    )
    vi.useRealTimers()
  })

  it('每页条数 select 改变 pageSize', async () => {
    const fetchPage = vi.fn().mockResolvedValue({ items: [{ id: 1 }], total: 60, page: 1, pageSize: 20 })
    render(<CrmTable queryKey="t" fetchPage={fetchPage} columns={[{ key: 'name', title: '名' }]} rowKey="id" />)
    fireEvent.change(screen.getByLabelText('每页条数'), { target: { value: '50' } })
    await vi.waitFor(() =>
      expect(fetchPage).toHaveBeenCalledWith(expect.objectContaining({ pageSize: 50 }))
    )
  })
```

（若现有 index.test.tsx 顶部未 import `act`/`vi`，按需补。）

- [x] **Step 9: 跑前端门禁** — Run: `cd frontend && pnpm lint && pnpm build && pnpm vitest run components/crm/crm-table hooks/use-debounce.test.ts` → 全绿

- [x] **Step 10: Commit**

```bash
git add frontend/components/crm/crm-table/crm-search-input.tsx frontend/components/crm/crm-table/crm-search-input.test.tsx \
        frontend/components/crm/crm-table/index.tsx frontend/components/crm/crm-table/types.ts \
        frontend/components/crm/crm-table/index.test.tsx \
        frontend/components/crm/customer-table.tsx frontend/components/crm/lead-table.tsx
git commit -m "feat(crm): 表格搜索框与吸顶表头及分页增强"
```


---

## Task 3: 公海表升级（筛选 + 搜索 + 导出 + 进公海时长列 + 来源徽章）

**Files:** Modify `frontend/components/crm/sea-table.tsx`；Create `frontend/components/crm/sea-table.test.tsx`

**Interfaces:**
- Consumes: Task 2 的 `CrmTable` `searchable`/`filterFields` 能力、`CrmExportButton`、`daysSince`（`@/lib/crm/method/format`）。
- Produces: 公海表与客户表一致——快捷筛选（状态/等级/来源/对象类型/意向服务，无负责人）、搜索框、导出 CSV（scope=sea）、来源枚举徽章、「进公海时长」列（按 `updatedAt` 渲染 `N 天前`、可排序）。

> 排序说明：列 key 用 `updatedAt`，后端 `sort_by` 无驼峰转换，`getattr(CrmCustomer,'updatedAt', updated_at)` 回退到 `updated_at`——对「进公海时长」恰为正确排序。

- [x] **Step 1: 写失败测试**（Create `frontend/components/crm/sea-table.test.tsx`）

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CrmSeaTable } from './sea-table'

const listCustomers = vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 })
vi.mock('@/lib/crm/api/crm-client-provider', () => ({
  useCrmClient: () => ({
    listCustomers,
    listFollows: vi.fn().mockResolvedValue([]),
    createFollow: vi.fn(),
    claimFromSea: vi.fn(),
  }),
}))
vi.mock('@/hooks/use-crm-users', () => ({ useCrmUsers: () => [] }))
vi.mock('@/components/notifications', () => ({ useNotifications: () => ({ notify: vi.fn() }) }))
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }))

describe('CrmSeaTable', () => {
  it('渲染搜索框/导出按钮/进公海时长列，且按 scope=sea 拉数', async () => {
    render(<CrmSeaTable />)
    expect(screen.getByPlaceholderText(/搜索客户名/)).toBeTruthy()
    expect(screen.getByTestId('crm-export-csv')).toBeTruthy()
    expect(screen.getByText('进公海时长')).toBeTruthy()
    expect(screen.getByText('状态')).toBeTruthy() // 快捷筛选行
    expect(await screen.findByText(/公海客户/)).toBeTruthy()
    expect(listCustomers).toHaveBeenCalledWith(expect.objectContaining({ scope: 'sea' }))
  })
})
```

- [x] **Step 2: 跑测试确认失败** — Run: `cd frontend && pnpm vitest run components/crm/sea-table.test.tsx` → FAIL（当前 sea-table 无搜索框/导出/进公海时长列）

- [x] **Step 3: 重写 sea-table.tsx**（Modify `frontend/components/crm/sea-table.tsx` 为下方完整版）

```tsx
'use client'

import { useCallback, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import { useCrmUsers } from '@/hooks/use-crm-users'
import { useNotifications } from '@/components/notifications'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CrmTable } from './crm-table'
import type { CrmColumnDef, FilterFieldDef } from './crm-table/types'
import { CrmOverviewDrawer } from './crm-overview-drawer'
import { CUSTOMER_TYPE_OPTIONS, INTERESTED_SERVICE_OPTIONS } from '@/lib/crm/constants/options'
import { CrmExportButton } from './crm-export-button'
import { CUSTOMER_FIELD_DEFS } from '@/lib/crm/field-defs/customer'
import type { Customer } from '@/lib/crm/types'
import {
  CUSTOMER_RATING_COLORS,
  CUSTOMER_RATING_LABELS,
  CUSTOMER_SOURCE_LABELS,
  CUSTOMER_STATUS_COLORS,
  CUSTOMER_STATUS_LABELS,
} from '@/lib/crm/enums/customer.enum'
import { daysSince } from '@/lib/crm/method/format'

const columns: CrmColumnDef<Customer>[] = [
  { key: 'name', title: '客户名', sortable: true },
  {
    key: 'rating',
    title: '等级',
    format: 'enum',
    enumMap: Object.fromEntries(
      (Object.keys(CUSTOMER_RATING_LABELS) as Array<keyof typeof CUSTOMER_RATING_LABELS>).map((k) => [
        k,
        { label: CUSTOMER_RATING_LABELS[k], color: CUSTOMER_RATING_COLORS[k] },
      ])
    ),
  },
  {
    key: 'status',
    title: '状态',
    format: 'enum',
    enumMap: Object.fromEntries(
      (Object.keys(CUSTOMER_STATUS_LABELS) as Array<keyof typeof CUSTOMER_STATUS_LABELS>).map((k) => [
        k,
        { label: CUSTOMER_STATUS_LABELS[k], color: CUSTOMER_STATUS_COLORS[k] },
      ])
    ),
  },
  {
    key: 'source',
    title: '来源',
    format: 'enum',
    enumMap: Object.fromEntries(
      (Object.keys(CUSTOMER_SOURCE_LABELS) as Array<keyof typeof CUSTOMER_SOURCE_LABELS>).map((k) => [
        k,
        { label: CUSTOMER_SOURCE_LABELS[k], color: 'bg-slate-100 text-slate-700' },
      ])
    ),
  },
  { key: 'contactName', title: '联系人' },
  { key: 'contactPhone', title: '联系电话' },
  {
    key: 'updatedAt',
    title: '进公海时长',
    sortable: true,
    render: (value) => {
      const v = value as string | undefined
      if (!v) return '-'
      const days = daysSince(v)
      return Number.isFinite(days) ? `${days} 天前` : '-'
    },
  },
]

export function CrmSeaTable() {
  const client = useCrmClient()
  const { notify } = useNotifications()
  const users = useCrmUsers()
  const searchParams = useSearchParams()
  const keyword = searchParams.get('keyword') ?? ''
  const [active, setActive] = useState<Customer | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)

  // 公海快捷筛选：无负责人（公海客户均无主），其余与客户表一致。
  const seaFilterFields = useMemo<FilterFieldDef[]>(
    () => [
      { key: 'status', label: '状态', type: 'select', field: 'status', options: Object.entries(CUSTOMER_STATUS_LABELS).map(([value, label]) => ({ value, label })) },
      { key: 'rating', label: '等级', type: 'select', field: 'rating', options: Object.entries(CUSTOMER_RATING_LABELS).map(([value, label]) => ({ value, label })) },
      { key: 'source', label: '来源', type: 'select', field: 'source', options: Object.entries(CUSTOMER_SOURCE_LABELS).map(([value, label]) => ({ value, label })) },
      { key: 'customerType', label: '对象类型', type: 'select', field: 'customerType', options: [...CUSTOMER_TYPE_OPTIONS] },
      { key: 'interestedService', label: '意向服务', type: 'select', field: 'interestedService', options: [...INTERESTED_SERVICE_OPTIONS] },
    ],
    []
  )

  const fetchPage = useCallback(
    async (params: Parameters<typeof client.listCustomers>[0]) => {
      return client.listCustomers({ ...params, scope: 'sea' })
    },
    [client]
  )

  const handleRowClick = useCallback((row: Customer) => {
    setActive(row)
    setDrawerOpen(true)
  }, [])

  const handleClaim = useCallback(async () => {
    if (!active) return
    await client.claimFromSea(active.id)
    notify({ type: 'success', title: '已领取客户', message: active.name })
    setActive(null)
    setDrawerOpen(false)
  }, [active, client, notify])

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">公海客户 · 可筛选 / 搜索 / 导出，点击行领取</p>
        <CrmExportButton entity="customers" scope="sea" keyword={keyword} />
      </div>
      <CrmTable<Customer>
        queryKey="sea"
        fetchPage={fetchPage}
        columns={columns}
        filterFields={seaFilterFields}
        rowKey="id"
        emptyText="公海暂无客户"
        defaultPageSize={20}
        onRowClick={handleRowClick}
        searchable
        searchPlaceholder="搜索客户名 / 简称…"
      />
      {active && (
        <CrmOverviewDrawer<Customer>
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
          entityType="customer"
          entityId={active.id}
          data={active}
          fields={CUSTOMER_FIELD_DEFS}
          title={active.name}
          actions={
            <Button size="sm" onClick={handleClaim}>
              领取
            </Button>
          }
          headerExtra={
            <Badge variant="secondary" className={CUSTOMER_STATUS_COLORS[active.status]}>
              {CUSTOMER_STATUS_LABELS[active.status]}
            </Badge>
          }
          users={users}
          loadFollows={(et, id) => client.listFollows(et, id)}
          createFollow={(input) => client.createFollow(input)}
          onSave={async () => {
            /* 公海只读，不保存 */
          }}
        />
      )}
    </>
  )
}
```

- [x] **Step 4: 跑测试通过** — Run: `cd frontend && pnpm vitest run components/crm/sea-table.test.tsx` → PASS

- [x] **Step 5: Commit**

```bash
git add frontend/components/crm/sea-table.tsx frontend/components/crm/sea-table.test.tsx
git commit -m "feat(crm): 公海表升级筛选搜索导出与进公海时长列"
```

---

## Task 4: 全门禁验证

**Files:** 无新增（验证全部改动）

- [x] **Step 1: 前端全门禁** — Run: `cd frontend && pnpm lint && pnpm build && pnpm test`
Expected: lint 0 错（既有警告不计）/ build ✓ / test 全绿（含新增 use-debounce / crm-search-input / crm-table / sea-table 测试）

- [x] **Step 2: 若有失败，定位修复后重跑**（常见：import 漏补、测试 mock 缺方法、TS 类型转换需 `as unknown as`）

- [x] **Step 3: 确认无后端改动** — Run: `git diff --name-only origin/main..HEAD | grep '^backend/' || echo "纯前端，无需 VPS 部署"`

---

## 收尾（控制器执行）

- [x] FF 合并 `feat/crm-table-ux` → main（先确认主工作区我的文件无 WIP；本次纯前端，文件与并行 WIP 不相交）
- [x] `git push origin main`（前端由 Vercel 自动部署；无 backend/ 改动 → 不触发 VPS 部署）
- [x] 清理 worktree + 已合并本地分支

---

## Self-Review

**1. 评审 P0/P1 覆盖**：
- P0 搜索框 → Task 2（CrmTable searchable）+ customer/lead 启用 + Task 3 公海启用 ✓
- P0 公海表升级（筛选/搜索/导出/进公海时长/来源徽章）→ Task 3 ✓
- P1 每页条数 → Task 2（分页脚 select）✓
- P1 吸顶表头 → Task 2（TableHeader sticky）✓
- P1 跳页 → Task 2（首末页按钮 + PageJump 输入）✓

**2. 占位符扫描**：无 TBD/TODO；每个 code step 有完整代码。sea-table 的 enumMap 构造完整写出（非「同 Task N」）。

**3. 类型一致性**：`useDebounce`（Task 1）被 `CrmSearchInput`（Task 2）引用；`CrmTableProps.searchable/searchPlaceholder`（Task 2 types.ts）被 customer/lead/sea 表使用；`CrmSearchInput` 被 CrmTable index.tsx 引用；`daysSince`/`CrmExportButton`/枚举常量均为现有导出。`PageJump` 在 CrmTable 同文件内定义并使用。

**4. 已知预存问题（不在本次范围，记录）**：后端 `sort_by` 无驼峰→下划线转换，`lastFollowAt` 等驼峰列排序实际回退到 `updated_at`（客户表 lastFollowAt 排序亦受此影响）。「进公海时长」用 `updatedAt` 经回退恰为正确。如需彻底修复，应另起任务在排序路径加 camelCase→snake_case 转换。
