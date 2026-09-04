# P3 全局搜索（Cmd+K）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 dashboard 加一个 `Cmd+K` / `Ctrl+K` 命令面板：纯前端导航搜索（数据源是 `SIDEBAR_TOP_GROUPS`），空输入时显示最近访问 + 固定快捷入口。

**Architecture:** 零后端。两个纯函数模块（`search-pages.ts` 子串搜索、`recent-pages.ts` localStorage 最近访问）+ 一个 Dialog 命令面板组件 + 一个全局快捷键触发器，触发器挂在 dashboard layout。最近访问由 layout 监听 pathname 变化写入 localStorage。

**Tech Stack:** Next.js 14 / React / TypeScript / shadcn ui（Dialog）/ lucide-react / Vitest + Testing Library。

## Global Constraints

- Commit：中文 + Conventional Commits，scope 中文，subject 动宾短语 ≤50 字无句号。
- 数据源唯一权威：`frontend/lib/sidebar-config.ts` 的 `SIDEBAR_TOP_GROUPS`（勿硬编码页面列表）。
- 最近访问存 `localStorage` key `believeboy:recent-pages`，最多 8 条。
- 测试顺序：`pnpm lint` → `pnpm build` → `pnpm test`。失败立即修。
- 键盘可达性：`↑`/`↓` 选择、`Enter` 跳转、`Esc` 关闭（Dialog 自带 Esc）。

---

## File Structure

**Frontend（新增 4 + 改 1）：**
- Create: `frontend/components/command-palette/search-pages.ts` — 搜索纯函数
- Create: `frontend/components/command-palette/recent-pages.ts` — 最近访问读写
- Create: `frontend/components/command-palette/command-palette.tsx` — Dialog 面板 + 键盘导航
- Create: `frontend/components/command-palette/command-palette-trigger.tsx` — Cmd+K 监听 + 最近访问记录
- Modify: `frontend/app/dashboard/layout.tsx` — 挂触发器
- Test: `frontend/components/command-palette/__tests__/search-pages.test.ts`
- Test: `frontend/components/command-palette/__tests__/recent-pages.test.ts`

---

### Task 1: 搜索纯函数

**Files:**
- Create: `frontend/components/command-palette/search-pages.ts`
- Test: `frontend/components/command-palette/__tests__/search-pages.test.ts`

**Interfaces:**
- Consumes: `SIDEBAR_TOP_GROUPS` / `SidebarTopGroup` / `SidebarSubItem`（`frontend/lib/sidebar-config.ts`）
- Produces: `SearchResult` 类型；`searchPages(query) -> SearchResult[]`；`flattenAllPages() -> SearchResult[]`

- [ ] **Step 1: 写失败测试**

创建 `frontend/components/command-palette/__tests__/search-pages.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { searchPages, flattenAllPages } from '../search-pages'

describe('searchPages', () => {
  it('按标题子串匹配（大小写不敏感）', () => {
    const results = searchPages('库存')
    expect(results.length).toBeGreaterThan(0)
    expect(results.some((r) => r.title === '库存分析')).toBe(true)
  })

  it('按模块名匹配命中该组全部子项', () => {
    const results = searchPages('商品供应链')
    expect(results.length).toBeGreaterThan(1)
    expect(results.every((r) => r.groupLabel === '商品供应链')).toBe(true)
  })

  it('空查询返回空数组', () => {
    expect(searchPages('')).toEqual([])
    expect(searchPages('   ')).toEqual([])
  })

  it('无匹配返回空数组', () => {
    expect(searchPages('zzz不存在的页面zzz')).toEqual([])
  })

  it('结果携带 groupLabel 与 url', () => {
    const [first] = searchPages('库存分析')
    expect(first.url).toBe('/dashboard/supply-chain/inventory-analysis')
    expect(first.groupLabel).toBe('商品供应链')
  })
})

describe('flattenAllPages', () => {
  it('展开所有导航项', () => {
    const all = flattenAllPages()
    expect(all.length).toBeGreaterThan(40)
    expect(all.every((r) => r.url && r.title)).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && pnpm vitest run components/command-palette/__tests__/search-pages.test.ts`
Expected: FAIL（无法解析 `../search-pages`）

- [ ] **Step 3: 实现搜索函数**

创建 `frontend/components/command-palette/search-pages.ts`：

```typescript
/**
 * 命令面板导航搜索（纯函数，可单测）。
 * 数据源：sidebar-config 的 SIDEBAR_TOP_GROUPS（唯一权威）。
 */
import { SIDEBAR_TOP_GROUPS } from '@/lib/sidebar-config'

export interface SearchResult {
  title: string
  url: string
  groupLabel: string
  groupId: string
}

/** 展开全部导航项（用于最近访问匹配与快捷入口兜底）。 */
export function flattenAllPages(): SearchResult[] {
  return SIDEBAR_TOP_GROUPS.flatMap((group) =>
    group.items.map((item) => ({
      title: item.title,
      url: item.url,
      groupLabel: group.label,
      groupId: group.id,
    }))
  )
}

/**
 * 子串搜索：标题或模块名命中即返回，按模块分组顺序排列。
 * 空/纯空白查询返回 []。
 */
export function searchPages(query: string): SearchResult[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  return SIDEBAR_TOP_GROUPS.flatMap((group) => {
    const groupHit = group.label.toLowerCase().includes(q)
    return group.items
      .filter((item) => groupHit || item.title.toLowerCase().includes(q))
      .map((item) => ({
        title: item.title,
        url: item.url,
        groupLabel: group.label,
        groupId: group.id,
      }))
  })
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd frontend && pnpm vitest run components/command-palette/__tests__/search-pages.test.ts`
Expected: PASS（7 passed）

- [ ] **Step 5: Commit**

```bash
cd frontend
git add components/command-palette/search-pages.ts components/command-palette/__tests__/search-pages.test.ts
git commit -m "feat(搜索): 新增命令面板导航搜索纯函数"
```

---

### Task 2: 最近访问读写

**Files:**
- Create: `frontend/components/command-palette/recent-pages.ts`
- Test: `frontend/components/command-palette/__tests__/recent-pages.test.ts`

**Interfaces:**
- Consumes: `flattenAllPages`（Task 1）；`localStorage`
- Produces: `STORAGE_KEY`；`readRecent() -> SearchResult[]`；`recordVisit(pathname) -> void`；`QUICK_LINKS`（固定快捷入口）

- [ ] **Step 1: 写失败测试**

创建 `frontend/components/command-palette/__tests__/recent-pages.test.ts`：

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { readRecent, recordVisit, STORAGE_KEY, MAX_RECENT } from '../recent-pages'

describe('recent-pages', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('空存储返回空数组', () => {
    expect(readRecent()).toEqual([])
  })

  it('记录可识别的 pathname 并能读回', () => {
    recordVisit('/dashboard/supply-chain/inventory-analysis')
    const recent = readRecent()
    expect(recent.length).toBe(1)
    expect(recent[0].title).toBe('库存分析')
  })

  it('忽略不在导航中的 pathname', () => {
    recordVisit('/dashboard/不存在的页面')
    expect(readRecent()).toEqual([])
  })

  it('去重：重复访问同一页面只保留一条且置顶', () => {
    recordVisit('/dashboard/supply-chain/inventory-analysis')
    recordVisit('/dashboard/crm/customers')
    recordVisit('/dashboard/supply-chain/inventory-analysis')
    const recent = readRecent()
    expect(recent.length).toBe(2)
    expect(recent[0].title).toBe('库存分析')
  })

  it('截断到 MAX_RECENT', () => {
    const urls = [
      '/dashboard/supply-chain/inventory-analysis',
      '/dashboard/crm/customers',
      '/dashboard/crm/leads',
      '/dashboard/operations/daily-analysis',
      '/dashboard/finance/platform-revenue',
      '/dashboard/reports/monthly-report',
      '/dashboard/advertising/ad-data',
      '/dashboard/ai/chat',
      '/dashboard/system/alerts',
    ]
    urls.forEach((u) => recordVisit(u))
    expect(readRecent().length).toBe(MAX_RECENT)
  })

  it('损坏的 JSON 返回空数组而非抛错', () => {
    localStorage.setItem(STORAGE_KEY, '{not json')
    expect(readRecent()).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && pnpm vitest run components/command-palette/__tests__/recent-pages.test.ts`
Expected: FAIL（无法解析 `../recent-pages`）

- [ ] **Step 3: 实现读写模块**

创建 `frontend/components/command-palette/recent-pages.ts`：

```typescript
/**
 * 最近访问页面（localStorage）。
 * 只记录能在 SIDEBAR_TOP_GROUPS 中匹配到的 pathname。
 */
import { flattenAllPages, type SearchResult } from './search-pages'

export const STORAGE_KEY = 'believeboy:recent-pages'
export const MAX_RECENT = 8

/** 空输入时展示的固定快捷入口（高频页面）。 */
export const QUICK_LINKS: SearchResult[] = [
  { title: '告警中心', url: '/dashboard/system/alerts', groupLabel: '系统管理', groupId: 'system' },
  { title: '定时报告', url: '/dashboard/reports/scheduled-reports', groupLabel: '报表中心', groupId: 'reports' },
  { title: '销售数据', url: '/dashboard/operations/daily-analysis', groupLabel: '运营', groupId: 'operations' },
]

interface StoredRecent {
  url: string
}

export function readRecent(): SearchResult[] {
  if (typeof window === 'undefined') return []
  let stored: StoredRecent[]
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    stored = raw ? (JSON.parse(raw) as StoredRecent[]) : []
  } catch {
    return []
  }
  if (!Array.isArray(stored)) return []
  const all = flattenAllPages()
  const byUrl = new Map(all.map((p) => [p.url, p]))
  return stored
    .map((s) => byUrl.get(s.url))
    .filter((p): p is SearchResult => Boolean(p))
}

export function recordVisit(pathname: string): void {
  if (typeof window === 'undefined') return
  const all = flattenAllPages()
  const match = all.find((p) => p.url === pathname)
  if (!match) return
  const current = readRecent().filter((p) => p.url !== pathname)
  const next = [match, ...current].slice(0, MAX_RECENT)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next.map((p) => ({ url: p.url }))))
  } catch {
    /* 忽略配额错误 */
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd frontend && pnpm vitest run components/command-palette/__tests__/recent-pages.test.ts`
Expected: PASS（6 passed）

- [ ] **Step 5: Commit**

```bash
cd frontend
git add components/command-palette/recent-pages.ts components/command-palette/__tests__/recent-pages.test.ts
git commit -m "feat(搜索): 新增最近访问 localStorage 读写模块"
```

---

### Task 3: 命令面板 Dialog 组件

**Files:**
- Create: `frontend/components/command-palette/command-palette.tsx`

**Interfaces:**
- Consumes: `searchPages` / `SearchResult`（Task 1）、`readRecent` / `QUICK_LINKS`（Task 2）、shadcn `Dialog`、`useRouter`
- Produces: `CommandPalette({ open, onOpenChange })` 组件

- [ ] **Step 1: 实现组件**

创建 `frontend/components/command-palette/command-palette.tsx`：

```tsx
'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Search } from 'lucide-react'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { searchPages, type SearchResult } from './search-pages'
import { readRecent, QUICK_LINKS } from './recent-pages'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface Grouped {
  groupLabel: string
  items: SearchResult[]
}

function groupResults(results: SearchResult[]): Grouped[] {
  const map = new Map<string, Grouped>()
  for (const r of results) {
    const g = map.get(r.groupLabel) ?? { groupLabel: r.groupLabel, items: [] }
    g.items.push(r)
    map.set(r.groupLabel, g)
  }
  return Array.from(map.values())
}

export function CommandPalette({ open, onOpenChange }: Props) {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [recent, setRecent] = useState<SearchResult[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  // 打开时：聚焦输入框、刷新最近访问、复位状态
  useEffect(() => {
    if (open) {
      setQuery('')
      setActiveIndex(0)
      setRecent(readRecent())
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [open])

  const isSearching = query.trim().length > 0

  // 搜索模式：按模块分组的结果；空输入：最近访问 + 快捷入口
  const grouped = useMemo<Grouped[]>(() => {
    if (isSearching) return groupResults(searchPages(query))
    const combined = [...recent, ...QUICK_LINKS.filter((q) => !recent.some((r) => r.url === q.url))]
    return combined.length ? [{ groupLabel: isSearching ? '' : '最近访问与快捷入口', items: combined }] : []
  }, [isSearching, query, recent])

  // 扁平化用于键盘导航
  const flat = useMemo(() => grouped.flatMap((g) => g.items), [grouped])

  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  const go = (item: SearchResult) => {
    onOpenChange(false)
    router.push(item.url)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => Math.min(i + 1, flat.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = flat[activeIndex]
      if (item) go(item)
    }
  }

  let flatCursor = -1

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[20%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl">
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="搜索页面…"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <kbd className="rounded border px-1.5 py-0.5 text-[0.65rem] text-muted-foreground">Esc</kbd>
        </div>

        <div className="max-h-[420px] overflow-y-auto p-2">
          {flat.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              {isSearching ? '未找到匹配页面' : '暂无最近访问'}
            </div>
          ) : (
            grouped.map((g) => (
              <div key={g.groupLabel} className="mb-2">
                <div className="px-2 py-1 text-xs font-medium text-muted-foreground">{g.groupLabel}</div>
                {g.items.map((item) => {
                  flatCursor += 1
                  const index = flatCursor
                  return (
                    <button
                      key={item.url}
                      type="button"
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => go(item)}
                      className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                        index === activeIndex ? 'bg-primary/10 text-primary' : 'hover:bg-muted'
                      }`}
                    >
                      <span>{item.title}</span>
                      <span className="text-xs text-muted-foreground">{item.groupLabel}</span>
                    </button>
                  )
                })}
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: 类型检查**

Run: `cd frontend && pnpm tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
cd frontend
git add components/command-palette/command-palette.tsx
git commit -m "feat(搜索): 新增 Cmd+K 命令面板 Dialog 组件"
```

---

### Task 4: 快捷键触发器 + 挂载 layout

**Files:**
- Create: `frontend/components/command-palette/command-palette-trigger.tsx`
- Modify: `frontend/app/dashboard/layout.tsx`

**Interfaces:**
- Consumes: `CommandPalette`（Task 3）、`recordVisit`（Task 2）
- Produces: `CommandPaletteTrigger()` 组件（监听 Cmd+K/Ctrl+K + 记录最近访问）

- [ ] **Step 1: 实现触发器**

创建 `frontend/components/command-palette/command-palette-trigger.tsx`：

```tsx
'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { CommandPalette } from './command-palette'
import { recordVisit } from './recent-pages'

/**
 * 全局命令面板触发器：
 * - Cmd+K (Mac) / Ctrl+K (Win) 打开面板
 * - 路由变化时把当前页面记入最近访问
 */
export function CommandPaletteTrigger() {
  const [open, setOpen] = useState(false)
  const pathname = usePathname()

  // 记录最近访问（pathname 变化时）
  useEffect(() => {
    if (pathname) recordVisit(pathname)
  }, [pathname])

  // 全局快捷键
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  return <CommandPalette open={open} onOpenChange={setOpen} />
}
```

- [ ] **Step 2: 挂载到 layout**

编辑 `frontend/app/dashboard/layout.tsx`。在顶部 import 区加：

```tsx
import { CommandPaletteTrigger } from '@/components/command-palette/command-palette-trigger'
```

在 `return` 的 JSX 里，`<SidebarProvider>` 内层加触发器。找到：

```tsx
    <SidebarProvider>
```

在其后一行插入（若 P2 已加 `<NotificationBell />`，放在它旁边即可）：

```tsx
      <CommandPaletteTrigger />
```

- [ ] **Step 3: 类型检查 + lint**

Run: `cd frontend && pnpm tsc --noEmit && pnpm lint`
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
cd frontend
git add components/command-palette/command-palette-trigger.tsx app/dashboard/layout.tsx
git commit -m "feat(搜索): 新增 Cmd+K 触发器并挂载到 dashboard layout"
```

---

### Task 5: 全量验证

**Files:** 无新增

- [ ] **Step 1: 跑前端完整测试链**

Run: `cd frontend && pnpm lint && pnpm build && pnpm test`
Expected: lint 无错误；build 成功；test 全绿（含 search-pages 7 + recent-pages 6）

- [ ] **Step 2: 若有失败，修复后重跑并提交**

```bash
git add -A && git commit -m "fix(搜索): 修复命令面板验证发现的问题"
```

（若无需修复则跳过。）
