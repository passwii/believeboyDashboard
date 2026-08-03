# BEL-419 统一懒加载与骨架屏 计划

**目标**：全局 review 前端页面，统一路由级懒加载（loading.tsx / Suspense）与骨架屏效果，降低后台数据库加载压力。

## 现状审计（2026-08-04）

- 80 个 dashboard 页面；48 个 client component；34 个 useEffect mount 即拉数。
- 仅 14 个 loading.tsx，且 13 个复用 `DashboardPageLoading` —— 该骨架是按**首页布局**定制的（metric tiles + charts + alert widgets），用在 CRM/reports/operations 等页面时与真实布局完全不符。
- **完全缺失**的 section：advertising(12 页)、finance(5)、supply-chain(7)、system(8/9)。
- 已有可复用原语：`ui/skeleton.tsx`（shimmer div）、`ui/table-skeleton.tsx`（TableSkeletonRows）、`lib/client-cache.ts` + `lib/project-client-cache.ts`（projects 端点已有 2min 客户端缓存）。

## 方案

1. **新建统一骨架模块** `components/dashboard/page-skeletons.tsx`（server-renderable，纯 Skeleton 组合）：
   - 原子：`PageHeaderSkeleton` / `FilterBarSkeleton(count)` / `KpiCardsSkeleton(count)` / `DataTableSkeleton(columns,rows)` / `ChartPanelSkeleton`
   - 组合：`TablePageLoading`（表格页通用）/ `AnalyticsPageLoading`（分析页：KPI+图表+表格）/ `SimplePageLoading`(卡片/hub 页)
   - 全部带 `data-testid` 供测试。
2. **补齐 loading.tsx**（新增，无冲突）：
   - `advertising/loading.tsx` → AnalyticsPageLoading
   - `advertising/ad-analysis/loading.tsx` → AnalyticsPageLoading（10 个子页的更近边界）
   - `finance/loading.tsx` → TablePageLoading
   - `supply-chain/loading.tsx` → TablePageLoading
   - `system/loading.tsx` → TablePageLoading
3. **纠正误用**（编辑现有 loading.tsx，均非 WIP 文件）：
   - `crm/loading.tsx` → TablePageLoading
   - `reports/loading.tsx` → TablePageLoading
   - `operations/loading.tsx` → AnalyticsPageLoading
   - `ai/loading.tsx` → SimplePageLoading
4. **保留**：`dashboard/loading.tsx`（DashboardPageLoading 与首页布局匹配）、profile/change-password/feature-updates/tools/ai-chat/ai-insights/ai-digital-employees/system-changelog 各自的细粒度骨架。
5. **测试**：`page-skeletons.test.tsx`（Vitest + Testing Library）。
6. **门槛**：`pnpm lint` → `pnpm build` → `pnpm test`。

## DB 压力结论（写入交付评论）

- 路由级骨架本身不减少 API 调用；真实 DB 压力来自 34 个 mount-fetch 页面。
- 已存在缓解：projects 端点 client-cache（2min TTL）、charts 已 dynamic(ssr:false) 拆包。
- 后续建议（按页推进，不属本次改动面）：页内 tab 懒加载（inventory-ledger 已有先行）、把更多共享端点纳入 client-cache。

## 不做

- 不动 WIP 文件（inventory-ledger/monthly-report page.tsx、sidebar-config 等）。
- 不引入 SWR/react-query（大改，另开 issue）。
