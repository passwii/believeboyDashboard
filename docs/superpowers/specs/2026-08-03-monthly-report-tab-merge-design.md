# Monthly Report Tab 合并设计 — 制作报表 + 财务报表统一入口

**Date**: 2026-08-03
**Status**: Implemented
**Scope**: 纯前端改造,不涉及后端 / 数据库 / API
**Skill**: brainstorming → writing-plans → implementation

---

## 1. 目标

将两个服务于同一功能的页面统一到一个 Tab 入口「财务月报」下:

| 原页面 | 语义 | 合并后 |
|---|---|---|
| `/dashboard/reports/monthly-report` (财务月报) | 月报**制作**流程(上传 CSV/PDF → 生成 Excel) | Tab「制作报表」 |
| `/dashboard/reports/financial-data` (月度财务分析) | 月报**展示**流程(趋势图、明细表、导出) | Tab「财务报表」 |

统一后:
- 侧边栏合并为**单一「财务月报」入口**
- 通过 Tab 切换两个子页面
- 默认落在「财务报表」(display)

## 2. 现状调研结论

| 文件 | 行数 | 说明 |
|---|---|---|
| `monthly-report/page.tsx` | 5 | 纯 pass-through,渲染 `MonthlyReportClient` |
| `monthly-report/monthly-report-client.tsx` | 1249 | 自管全部状态,`useUrlParam` 同步 `?project=&country=&month=` |
| `financial-data/page.tsx` | 16 | `'use client'`,向 `FinancialDataClient` 传 6 个**全空** initial props |
| `financial-data/financial-data-client.tsx` | 2883 | 接受 SSR-friendly props,内部有 `FinancialViewTab (financial\|accounting)` 二级 tab |
| `financial-data/excel-num-fmt.ts` + test | 39+38 | 导出数字格式工具,仅被 financial-data 使用 |

**外部引用**(均已确认):
- 两个 client 各只被自己的 page.tsx import 一次,无其他页面引用
- `sidebar-config.ts` L138「财务月报」/ L152「月度财务分析」两个平级入口
- `dashboard-route-meta.ts` L2 `/reports/monthly-report` / L6 `/reports/financial-data`
- `frontend/tests/crawl/discovery.spec.ts` + `tmp-authed-discovery.spec.ts` 各含一条 `/dashboard/reports/financial-data`
- 无 `reports/layout.tsx`(Tab 外壳放 `monthly-report/` 下,不影响其他报告页)
- `@/components/ui/tabs.tsx` 存在(Radix 风格),可直接复用

## 3. 关键设计决策

### 3.1 路由结构(用户拍板:嵌套路由 + 默认 display)

```
frontend/app/dashboard/reports/monthly-report/
├── layout.tsx                  # 新增:Tab 外壳(路由驱动 Tabs + 高亮容器)
├── page.tsx                    # 改为 redirect() → ./display
├── generate/
│   ├── page.tsx                # 新增:渲染 GenerateTab
│   └── generate-client.tsx     # 新增:从原 monthly-report-client 整迁(方案 A)
├── display/
│   ├── page.tsx                # 新增:渲染 DisplayTab
│   ├── display-client.tsx      # 新增:从原 financial-data-client 整迁(方案 A)
│   ├── excel-num-fmt.ts        # 从 financial-data/ 迁移
│   └── excel-num-fmt.test.ts   # 从 financial-data/ 迁移

frontend/app/dashboard/reports/financial-data/  → 整目录删除
```

**重定向**(Next.js App Router `redirect()`,不引入 next.config redirects):
- `/monthly-report`(裸路径)→ `/monthly-report/display`(默认展示)
- `/financial-data` → `/monthly-report/display`

### 3.2 Tab = 路由段(layout.tsx)

- Tab 由路由驱动,非组件内 state → 深链 / 刷新 / 后退天然正确
- `value = pathname.endsWith('/generate') ? 'generate' : 'display'`
- `onValueChange` → `router.push('/dashboard/reports/monthly-report/' + value)`
- UI 复用 `@/components/ui/tabs`(Tabs / TabsList / TabsTrigger),children 直接渲染(不包 TabsContent——路由已决定渲染哪个子页面)
- layout 为 client component

### 3.3 组件切分粒度(用户拍板:方案 A,最小化)

| 新文件 | 来源 | 改动 |
|---|---|---|
| `generate/generate-client.tsx` | `monthly-report-client.tsx` (1249 行) | 整迁 + 重命名导出,函数体不动 |
| `display/display-client.tsx` | `financial-data-client.tsx` (2883 行) | 整迁 + 重命名导出 + **移除 6 个 initial props**(行为等价) |
| `display/excel-num-fmt.ts` + test | `financial-data/` | 同目录搬移,路径 import 微调 |

**不抽取共享纯函数**(`extractFilenameFromHeader` / `currentMonthString` / `formatMonth` 等):两页各自保留副本,重复无害;跨页通用化重构留作后续独立任务。

### 3.4 数据流与状态

- **generate**: 保留全部原有内部状态(projectName/country/reportMonth via `useUrlParam`,上传映射、轮询)。URL query `?project=&country=&month=` 继续有效。
- **display**: 保留全部原有逻辑(趋势图、明细表、导出、汇率缓存)。内部二级 tab `FinancialViewTab (financial|accounting)` 不动。
- **Tab 切换即路由导航**:两 Tab 独立 mount,互不共享状态,天然隔离。

### 3.5 display-client 的 initial props 处理

原 `page.tsx` 传全空 initial(无 SSR 数据),client 内部以 `initialProjects.length === 0` 判定并自行 fetch。因此**移除 props、改为内部空值初始化**是行为等价的最小改动。

### 3.6 Sidebar 与标题

- `sidebar-config.ts`:
  - L138 改为 `url: '/dashboard/reports/monthly-report'`,**新增** `matchPrefixes: ['/dashboard/reports/monthly-report']`(保证 generate/display 都高亮)
  - **删除** L152「月度财务分析」
- `dashboard-route-meta.ts`: 合并 L2/L6 为一条 `{ match: '/reports/monthly-report', title: '财务月报' }`,删除 L6

## 4. 测试与验证

- `frontend/tests/crawl/discovery.spec.ts` + `tmp-authed-discovery.spec.ts`: `/dashboard/reports/financial-data` 路由改为 `/dashboard/reports/monthly-report/display`
- 运行 `pnpm lint` → `pnpm build` → `pnpm test`
- 冒烟清单(手动):
  1. 侧边栏「财务月报」→ 落在 display Tab(默认)
  2. Tab 切换到 generate → URL 变 `/generate`,内容为制作流程
  3. generate 里选项目/国家/月份 → query 参数保留(刷新不丢)
  4. 老链接 `/dashboard/reports/financial-data` → 301 落到 `/monthly-report/display`
  5. 老链接 `/dashboard/reports/monthly-report` → 落到 `/monthly-report/display`
  6. 深链 `/monthly-report/generate` 直达制作流程,侧边栏「财务月报」高亮
  7. display 内部二级 tab(financial/accounting)与导出功能正常

## 5. 明确不做(后续独立任务)

- ❌ display 2883 行的内部进一步拆分子组件(独立重构任务)
- ❌ 跨页共享纯函数抽取(独立通用化任务)
- ❌ 任何后端 / API / 数据库改动
