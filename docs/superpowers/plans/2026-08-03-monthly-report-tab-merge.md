# 月度财务报表 Tab 合并 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将「财务月报」(制作报表) 与「月度财务分析」(财务报表) 合并到单一 `/dashboard/reports/monthly-report` 路由下,通过 generate/display 两个路由段 Tab 切换,默认落在 display。

**Architecture:** 纯前端路由重构。新建 `monthly-report/layout.tsx` 做路由驱动 Tab 外壳(usePathname + useRouter + 现有 `@/components/ui/tabs`),两个子路由段 `generate/` 与 `display/` 各持独立 client 组件(整迁原文件,方案 A 最小改动),旧路由 `/financial-data` 与裸 `/monthly-report` 用 Next.js `redirect()` 归一。

**Tech Stack:** Next.js App Router (`redirect()`, client layout), React 19, Radix Tabs (`@/components/ui/tabs`), lucide-react。**零后端改动。**

## Global Constraints

- **零后端改动**: 不 touch `backend/`、无 API 签名变化、无数据库迁移。
- **方案 A 最小改动**: 两个 client 文件整迁,不做内部子组件拆分、不抽取跨页共享纯函数。
- **Tab = 路由段**: `generate` / `display` 是 URL 的一部分,不是组件内 state;默认 display。
- **重定向**: 裸 `/monthly-report` 与旧 `/financial-data` 均 `redirect()` 到 `/monthly-report/display`。
- **display-client 行为等价**: 移除 6 个 `initial*` props(原 page.tsx 传的全是空值),内部改为空值自管;死代码分支(SSR 预填)一并删除。
- **commit 规范**: 中文 + Conventional Commits(如 `feat(月报): ...` / `chore(月报): ...`),≤50 字。
- 每 Task 结束跑 `pnpm lint`(仅当有 TS 改动)与相关测试,最终跑完整验证。

---

## 文件结构总览

```
frontend/app/dashboard/reports/monthly-report/
├── layout.tsx                    # 新增:路由驱动 Tab 外壳(client)
├── page.tsx                      # 修改:redirect() → ./display
├── generate/
│   ├── page.tsx                  # 新增:渲染 GenerateTab
│   └── generate-client.tsx       # 新增:原 monthly-report-client.tsx 整迁 + 重命名导出
├── display/
│   ├── page.tsx                  # 新增:渲染 DisplayTab
│   ├── display-client.tsx        # 新增:原 financial-data-client.tsx 整迁 + 重命名导出 + 移除 props
│   ├── excel-num-fmt.ts          # 迁移自 financial-data/
│   └── excel-num-fmt.test.ts     # 迁移自 financial-data/

frontend/app/dashboard/reports/financial-data/  → 整目录删除

frontend/lib/sidebar-config.ts        # 修改:合并侧边栏入口 + matchPrefixes
frontend/lib/dashboard-route-meta.ts  # 修改:合并标题条目
frontend/tests/crawl/discovery.spec.ts        # 修改:financial-data 路由
frontend/tests/crawl/tmp-authed-discovery.spec.ts  # 修改:financial-data 路由
```

---

### Task 1: 建实施分支

**Files:** 无(纯 git 操作)

**Interfaces:**
- Produces: 独立分支 `feat/monthly-report-tab-merge`,基线为当前 main

- [ ] **Step 1: 确认基线并创建分支**

当前在 `feat/shop-calc-append-only`,与任务无关。切回 main 拉最新,再开新分支:

```bash
cd /Users/damon/DamonProjects/believeboyDashboard
git stash list
git fetch origin
git checkout main
git pull --ff-only origin main
git checkout -b feat/monthly-report-tab-merge
```

说明:若当前分支有未提交改动(如 `backend/` 下的 M 文件),不要动它们;切分支前确认 `git status` 干净或改动属于别的分支。本任务只改 `frontend/` 与 `docs/`,与当前分支的后端改动无冲突。

- [ ] **Step 2: 验证分支**

```bash
git branch --show-current   # 期望: feat/monthly-report-tab-merge
codegraph status .          # 期望: Index is up to date(若 stale 则 codegraph sync .)
```

- [ ] **Step 3: Commit**

```bash
git commit --allow-empty -m "chore(月报): 建立月度报表 Tab 合并实施分支"
```

---

### Task 2: 迁移 generate Tab(制作报表)

**Files:**
- Create: `frontend/app/dashboard/reports/monthly-report/generate/generate-client.tsx`
- Create: `frontend/app/dashboard/reports/monthly-report/generate/page.tsx`
- Modify: 删除原 `frontend/app/dashboard/reports/monthly-report/monthly-report-client.tsx`

**Interfaces:**
- Consumes: 无(原文件自包含)
- Produces: `GenerateTab`(默认导出,无 props)由 `generate/page.tsx` 渲染

- [ ] **Step 1: 创建 generate/ 目录并迁移 client**

```bash
mkdir -p frontend/app/dashboard/reports/monthly-report/generate
git mv frontend/app/dashboard/reports/monthly-report/monthly-report-client.tsx \
        frontend/app/dashboard/reports/monthly-report/generate/generate-client.tsx
```

- [ ] **Step 2: 重命名导出**

编辑 `generate-client.tsx`(原 monthly-report-client.tsx):

```tsx
// 原: export default function MonthlyReportClient() {
// 改: export default function GenerateTab() {
```

仅改这一行函数名与 export 行。**函数体、类型、import、JSX 一律不动。**

- [ ] **Step 3: 创建 generate/page.tsx**

```tsx
import GenerateTab from './generate-client'

export default function GeneratePage() {
  return <GenerateTab />
}
```

- [ ] **Step 4: 验证编译**

```bash
cd frontend && pnpm lint --filter ./ 2>/dev/null || pnpm lint
```

若 lint 脚本不支持 filter,直接 `pnpm lint`(见项目 package.json)。期望:无 TS 错误。

- [ ] **Step 5: Commit**

```bash
git add frontend/app/dashboard/reports/monthly-report/generate
git commit -m "feat(月报): 拆分制作报表为 generate Tab 子页面"
```

---

### Task 3: 迁移 display Tab(财务报表)含 props 清理

**Files:**
- Create: `frontend/app/dashboard/reports/monthly-report/display/display-client.tsx`
- Create: `frontend/app/dashboard/reports/monthly-report/display/page.tsx`
- Move: `financial-data/excel-num-fmt.ts` → `display/excel-num-fmt.ts`
- Move: `financial-data/excel-num-fmt.test.ts` → `display/excel-num-fmt.test.ts`

**Interfaces:**
- Consumes: 原 `financial-data/financial-data-client.tsx`(2883 行)与 `excel-num-fmt.*`
- Produces: `DisplayTab`(默认导出,无 props)由 `display/page.tsx` 渲染

- [ ] **Step 1: 创建 display/ 并迁移文件**

```bash
mkdir -p frontend/app/dashboard/reports/monthly-report/display
git mv frontend/app/dashboard/reports/financial-data/financial-data-client.tsx \
        frontend/app/dashboard/reports/monthly-report/display/display-client.tsx
git mv frontend/app/dashboard/reports/financial-data/excel-num-fmt.ts \
        frontend/app/dashboard/reports/monthly-report/display/excel-num-fmt.ts
git mv frontend/app/dashboard/reports/financial-data/excel-num-fmt.test.ts \
        frontend/app/dashboard/reports/monthly-report/display/excel-num-fmt.test.ts
```

- [ ] **Step 2: 修正 excel-num-fmt import 路径**

`display-client.tsx` 内原 import 是 `./excel-num-fmt`(相对),迁移后仍是同一目录相对路径,**无需改动**。用 `grep -n "excel-num-fmt" display-client.tsx` 确认 import 仍是 `'./excel-num-fmt'`。

- [ ] **Step 3: 重命名导出 + 移除 props**

在 `display-client.tsx` 中:

```tsx
// 1) 导出名
// 原: export default function FinancialDataClient({
//      initialProjects, initialProjectId, initialStartMonth, initialEndMonth,
//      initialData, initialExchangeRateByMonth,
//    }: FinancialDataClientProps) {
// 改: export default function DisplayTab() {
```

```tsx
// 2) 删除 FinancialDataClientProps type(原 731-738 行附近):
//    整个 type 块删除
```

```tsx
// 3) 内部初始化改为空值:
const [projects, setProjects] = useState<ProjectOption[]>([])   // 原 initialProjects
const [projectsLoading, setProjectsLoading] = useState(true)     // 原 initialProjects.length === 0
const [projectId, setProjectId] = useUrlParam<string>('project', '')  // 原 initialProjectId
const [startMonth, setStartMonth] = useUrlParam<string>('fromMonth', '')  // 原 initialStartMonth
const [endMonth, setEndMonth] = useUrlParam<string>('toMonth', '')        // 原 initialEndMonth
const [data, setData] = useState<FinancialSeriesResponse | null>(null)    // 原 initialData
const [exchangeRateByMonth, setExchangeRateByMonth] = useState<Record<string, number>>({})  // 原 initialExchangeRateByMonth
```

- [ ] **Step 4: 删除 SSR 预填死代码**

删除以下(原 830-840、1136-1158、1169-1192 区域的 initial* 分支):

```tsx
// a) 原:
//   const skipInitialSeriesLoadRef = useRef(Boolean(initialData))
//   → 删除整行

// b) 原 834-840 的 effect:
//   useEffect(() => {
//     if (initialStartMonth && initialEndMonth) return
//     const defaults = getBrowserDefaultMonthRange()
//     if (!startMonth) setStartMonth(defaults.startMonth)
//     if (!endMonth) setEndMonth(defaults.endMonth)
//   }, [initialEndMonth, initialStartMonth, startMonth, endMonth])
//   → 改为(去掉 initial 守卫,保留默认月份逻辑):
useEffect(() => {
  const defaults = getBrowserDefaultMonthRange()
  if (!startMonth) setStartMonth(defaults.startMonth)
  if (!endMonth) setEndMonth(defaults.endMonth)
}, [startMonth, endMonth])

// c) 原 1136-1158 的 effect(initialData cache 写入) → 整个删除

// d) 原 1169-1192 的 effect 中 shouldSkipInitialLoad 相关:
//   → 整个 effect 改为:
useEffect(() => {
  if (!projectId || projectsLoading) return
  void loadFinancialSeries()
}, [endMonth, loadFinancialSeries, projectId, projectsLoading, startMonth])
```

⚠️ **关键注意**: `loadFinancialSeries` 在组件体内 `useCallback` 定义,其依赖数组必须保持与原一致(除 initial* 外)。改完检查 `display-client.tsx` 中不再出现 `initial` 字样(函数体内),否则 lint/类型会报未定义。

- [ ] **Step 5: 创建 display/page.tsx**

```tsx
import DisplayTab from './display-client'

export default function DisplayPage() {
  return <DisplayTab />
}
```

- [ ] **Step 6: 删除 financial-data 残留目录**

```bash
rm -rf frontend/app/dashboard/reports/financial-data
```

(原目录除已 git mv 的 4 个文件外无其他文件;若 `rm` 报非空,`ls` 确认后删除残留。)

- [ ] **Step 7: 验证编译 + 单测**

```bash
cd frontend
pnpm lint
pnpm test 2>&1 | tail -30   # 期望 excel-num-fmt.test.ts 仍在跑且通过
```

- [ ] **Step 8: Commit**

```bash
git add -A frontend/app/dashboard/reports/monthly-report/display frontend/app/dashboard/reports/financial-data
git commit -m "feat(月报): 拆分财务报表为 display Tab 子页面并清理 SSR props"
```

---

### Task 4: 建 Tab 外壳 layout + 根路由重定向

**Files:**
- Create: `frontend/app/dashboard/reports/monthly-report/layout.tsx`
- Modify: `frontend/app/dashboard/reports/monthly-report/page.tsx`

**Interfaces:**
- Consumes: `@/components/ui/tabs`(Tabs/TabsList/TabsTrigger), lucide-react 图标
- Produces: `MonthlyReportLayout` 默认导出,渲染 Tab 栏 + children;根 page 重定向

- [ ] **Step 1: 写 layout.tsx**

```tsx
'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { FileBarChart, LayoutDashboard } from 'lucide-react'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'

const TAB_ITEMS = [
  { value: 'display', label: '财务报表', icon: LayoutDashboard },
  { value: 'generate', label: '制作报表', icon: FileBarChart },
] as const

export default function MonthlyReportLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const pathname = usePathname()
  const activeTab = pathname.endsWith('/generate') ? 'generate' : 'display'

  return (
    <div className="min-w-0 w-full space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            财务月报
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            月度财务报表的生成与查看
          </p>
        </div>
        <Tabs value={activeTab}>
          <TabsList className="grid w-full max-w-sm grid-cols-2">
            {TAB_ITEMS.map(({ value, label, icon: Icon }) => (
              <TabsTrigger key={value} value={value} asChild>
                <Link
                  href={`/dashboard/reports/monthly-report/${value}`}
                  className="flex items-center gap-1.5"
                >
                  <Icon className="h-4 w-4" />
                  {label}
                </Link>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
      {children}
    </div>
  )
}
```

说明:
- **Tab = 链接**(用 `asChild` + `Link`),而非 `onValueChange`——因为 Tab 就是路由,链接是语义正确的做法,且保留中键/新标签打开。
- 不需要 `TabsContent`:子路由 `generate/page.tsx` / `display/page.tsx` 已渲染在 `children`。
- `activeTab` 由 pathname 派生,任何未匹配路径(如未来新段)默认 display。

- [ ] **Step 2: 改根 page.tsx 为重定向**

```tsx
import { redirect } from 'next/navigation'

export default function MonthlyReportPage() {
  redirect('/dashboard/reports/monthly-report/display')
}
```

- [ ] **Step 3: 验证编译**

```bash
cd frontend && pnpm lint
```

期望:无 TS 错误(`React.ReactNode` 需 `import type { ReactNode } from 'react'` 或全局可用;若 lint 报未定义,补 `import type { ReactNode } from 'react'` 并改用 `ReactNode`)。

- [ ] **Step 4: Commit**

```bash
git add frontend/app/dashboard/reports/monthly-report/layout.tsx frontend/app/dashboard/reports/monthly-report/page.tsx
git commit -m "feat(月报): 新增 generate/display Tab 外壳并将根路由重定向到展示页"
```

---

### Task 5: 旧路由重定向 /financial-data

**Files:**
- Create: `frontend/app/dashboard/reports/financial-data/page.tsx`(原目录已删,重新创建为纯重定向 stub)

**Interfaces:**
- Produces: 旧 `/dashboard/reports/financial-data` → 307 重定向到 `/dashboard/reports/monthly-report/display`

- [ ] **Step 1: 重建 financial-data/page.tsx 为重定向**

```tsx
import { redirect } from 'next/navigation'

export default function FinancialDataRedirectPage() {
  redirect('/dashboard/reports/monthly-report/display')
}
```

> 说明:目录 `financial-data/` 在 Task 3 已删除,但为了让旧 URL 不 404,需重建该目录并放一个重定向 page。若担心目录名混淆,可改用 `frontend/app/dashboard/reports/financial-data/page.tsx` 相同路径重建(推荐,保持 URL 不变)。

- [ ] **Step 2: 验证编译**

```bash
cd frontend && pnpm lint
```

- [ ] **Step 3: Commit**

```bash
git add frontend/app/dashboard/reports/financial-data/page.tsx
git commit -m "feat(月报): 旧财务分析路由重定向到财务报表 Tab"
```

---

### Task 6: 侧边栏合并 + 页面标题

**Files:**
- Modify: `frontend/lib/sidebar-config.ts`(L138、L152)
- Modify: `frontend/lib/dashboard-route-meta.ts`(L2、L6)

**Interfaces:**
- Consumes: 现有 `SIDEBAR_TOP_GROUPS` 结构、`DASHBOARD_PAGE_TITLES` 结构
- Produces: 单一「财务月报」侧边栏项(带 matchPrefixes 高亮),标题统一「财务月报」

- [ ] **Step 1: 合并 sidebar 入口**

`frontend/lib/sidebar-config.ts` L138:

```ts
// 原:
{ title: '财务月报', url: '/dashboard/reports/monthly-report', icon: IconMap.FileBarChart },
// 改:
{
  title: '财务月报',
  url: '/dashboard/reports/monthly-report',
  matchPrefixes: ['/dashboard/reports/monthly-report'],
  icon: IconMap.FileBarChart,
},
```

删除 L152(整个 `月度财务分析` 项):

```ts
// 删除:
{ title: '月度财务分析', url: '/dashboard/reports/financial-data', icon: IconMap.DollarSign },
```

- [ ] **Step 2: 合并标题条目**

`frontend/lib/dashboard-route-meta.ts`:

```ts
// L2 原: { match: '/reports/monthly-report', title: '财务月报' },
// 保留不变(已覆盖 generate/display 因 pathname.includes(match) 前缀匹配)

// 删除 L6: { match: '/reports/financial-data', title: '月度财务分析' },
```

⚠️ 注意: `getDashboardPageTitle` 用 `pathname.includes(match)`,所以 `/reports/monthly-report` 一条已覆盖 `/generate` 与 `/display` 两个子路径,无需新增条目。

- [ ] **Step 3: 验证**

```bash
cd frontend && pnpm lint
```

手动确认 `isLinkActive` 逻辑:`/dashboard/reports/monthly-report/generate` 会因 `matchPrefixes` 命中而高亮。

- [ ] **Step 4: Commit**

```bash
git add frontend/lib/sidebar-config.ts frontend/lib/dashboard-route-meta.ts
git commit -m "feat(月报): 侧边栏合并为单一财务月报入口并统一页面标题"
```

---

### Task 7: 更新 crawl 测试路由

**Files:**
- Modify: `frontend/tests/crawl/discovery.spec.ts`(L75)
- Modify: `frontend/tests/crawl/tmp-authed-discovery.spec.ts`(L75)

**Interfaces:**
- Consumes: 现有 crawl 测试数组结构
- Produces: 测试遍历的新路由集合,包含新 Tab 地址,移除旧 financial-data

- [ ] **Step 1: 替换路由项**

两个文件各自的数组里:

```ts
// 原: '/dashboard/reports/financial-data',
// 改: '/dashboard/reports/monthly-report/display',
```

保留 `'/dashboard/reports/monthly-report'`(裸路径也会被 crawl,验证重定向后可达 display)。

- [ ] **Step 2: 验证**

```bash
cd frontend && pnpm test 2>&1 | tail -30
```

crawl 测试通常是 E2E(可能需要真实浏览器),若测试框架跳过或需凭证,确认该文件不在 `pnpm test` 默认集合内即可;若在,则运行并确保不因新路由失败。

- [ ] **Step 3: Commit**

```bash
git add frontend/tests/crawl/discovery.spec.ts frontend/tests/crawl/tmp-authed-discovery.spec.ts
git commit -m "test(月报): crawl 路由集合更新为新 Tab 地址"
```

---

### Task 8: 完整验证 + 收尾

**Files:** 无新文件

**Interfaces:**
- Consumes: 前面全部任务产物
- Produces: 验证通过的最终状态

- [ ] **Step 1: 完整前端验证**

```bash
cd frontend
pnpm lint
pnpm build
pnpm test
```

期望:全部通过。若 build 报路由相关错误(如 redirect 在 server component 外的用法),按 Next.js App Router 约定修正。

- [ ] **Step 2: 手工冒烟清单(交用户)**

对照 spec §4 的 7 项清单:
1. 侧边栏「财务月报」→ 落在 display Tab
2. Tab 切换 generate → URL 变 `/generate`,内容为制作流程
3. generate 里 query 参数(`project/country/month`)刷新不丢
4. `/dashboard/reports/financial-data` → 落到 `/monthly-report/display`
5. `/dashboard/reports/monthly-report` → 落到 `/monthly-report/display`
6. 深链 `/monthly-report/generate` 直达制作,侧边栏高亮
7. display 内部二级 tab(financial/accounting)与导出正常

本地 `pnpm dev` 起服务逐条验证。

- [ ] **Step 3: 全仓测试(确认零后端回归)**

```bash
cd /Users/damon/DamonProjects/believeboyDashboard
cd backend && pytest 2>&1 | tail -10
```

期望:后端测试全绿(本次无后端改动,应无回归)。

- [ ] **Step 4: 更新设计文档状态**

编辑 `docs/superpowers/specs/2026-08-03-monthly-report-tab-merge-design.md`:
- `**Status**: Design (awaiting user approval)` → `**Status**: Implemented`

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-08-03-monthly-report-tab-merge-design.md
git commit -m "docs(月报): 设计文档标记为已实现"
```

---

## Self-Review 记录

- **Spec 覆盖**: 路由结构 → Task 2/3/4;重定向 → Task 4/5;Tab 外壳 → Task 4;sidebar/标题 → Task 6;crawl 测试 → Task 7;验证 → Task 8。✅
- **无占位符**: 每步含真实代码/命令。✅
- **类型一致性**: `GenerateTab` / `DisplayTab` 命名在 Task 2/3 与各自 page 一致;`layout.tsx` 用 `TabsTrigger asChild + Link` 全程一致。✅
- **风险点已标注**: display props 移除后 `loadFinancialSeries` 依赖数组、`getBrowserDefaultMonthRange` 保留逻辑、excel-num-fmt 相对 import 不变。✅
