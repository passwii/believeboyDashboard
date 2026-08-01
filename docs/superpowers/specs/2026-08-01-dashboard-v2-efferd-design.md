# Dashboard Overview V2 设计文档（Efferd 密集网格实验）

> 日期：2026-08-01
> 状态：待实施
> 来源：21st.dev [Efferd Dashboard 2](https://21st.dev/community/components/efferd/efferd-dashboard-2)（by Shaban Haider），shadcn registry `efferd.com/r/dashboard-2.json`

## 1. 背景与目标

当前 dashboard overview（v1，`app/dashboard/page.tsx`）使用自定义 `DataCard`/`dashboard-surface` 卡片体系。用户希望评估 Efferd Dashboard 2 的瑞士/brutalist 密集网格设计语言是否更适合，采用**临时实验**方式：新建 v2 页面，v1 保留并可互跳。

**目标**：快速验证新设计语言，零回归风险，实验失败可整体删除。

## 2. 关键决策（已与用户确认）

| # | 决策 | 选择 |
|---|------|------|
| D1 | 数据策略 | **混合**：KPI + 图表接真实数据；invoices/billing/activity 用 mock |
| D2 | V1/V2 切换 | **路由分离 + 互跳按钮**：`/dashboard`（v1）↔ `/dashboard/v2` |
| D3 | 项目选择器 | **保留** ProjectSelect，放 v2 页面顶部 |
| D4 | 实现方案 | **自包含 v2 模块**：不动 v1 逻辑，fetch 复制而非抽取 |
| D5 | AppShell | **不引入**——v2 渲染在现有 `app/dashboard/layout.tsx` 内 |

## 3. 文件结构

```
frontend/
├── app/dashboard/
│   ├── page.tsx                    # v1，仅加"试试新版"按钮
│   └── v2/
│       └── page.tsx                # v2 入口（数据获取 + 网格编排）
├── components/dashboard-v2/
│   ├── v2-grid.tsx                 # 密集网格骨架（gap-px bg-border 发丝线）
│   ├── v2-card.tsx                 # 纯平卡片（rounded-none shadow-none ring-0）
│   ├── v2-delta.tsx                # 趋势指示器（绿涨红跌，context 架构）
│   ├── v2-stats.tsx                # 4 KPI 统计卡（真实数据）
│   ├── v2-revenue-chart.tsx        # 每日销售额渐变柱状图（真实数据）
│   ├── v2-channel-chart.tsx        # 销售额 vs 广告花费双折线（真实数据）
│   ├── v2-invoices.tsx             # 发票表格（mock，保持 sample 英文原样）
│   ├── v2-billing.tsx              # 账单健康度（mock）
│   ├── v2-activity.tsx             # 活动流（mock）
│   └── mock-data.ts                # 3 个 mock 模块共用数据
```

- 所有 v2 组件带 `v2-` 前缀，与 `components/dashboard/`（v1）完全隔离
- 实验失败删除 `components/dashboard-v2/` + `app/dashboard/v2/` + v1 页面按钮即可

## 4. 内容映射

| Sample 区块 | V2 内容 | 数据源 |
|---|---|---|
| 4 KPI 统计卡 | 销售额 / 订单量 / 广告花费 / 转化率 | ✅ 真实：`currentRows` 汇总，delta 对比 `comparisonRows` |
| Net Revenue 渐变柱状图 | 每日销售额柱状图（保留 sample 渐变柱风格） | ✅ 真实：`currentRows[].sales_amount` |
| Channel Sales 折线图 | 销售额 vs 广告花费双折线 | ✅ 真实：`sales_amount` + `ad_spend` |
| Invoices 表格 | 保持 sample 原样（客户/状态/金额） | 🔶 mock |
| Billing Health | 保持 sample 原样 | 🔶 mock |
| Activity Feed | 保持 sample 原样 | 🔶 mock |

**页面顶部工具栏**：ProjectSelect（复用 v1 组件）+ 日期区间（沿用 v1 默认近 30 天逻辑）+ "返回旧版"按钮。

**标签语言**：真实数据区块用中文标签（销售额/订单量/广告花费/转化率），金额 `$` 前缀（美元结算）。Mock 区块保持 sample 英文原样——视觉上即可区分占位内容。

**后续接真实数据路径**（不在本次范围）：Invoices → Top 项目表格；Activity → 告警事件流（AlertWidget 已有 API）。

## 5. 数据流

```
v2/page.tsx (client component)
├── useManagedProjects()          ← 复用 lib/hooks（非 v1 专属）
├── ProjectSelect                 ← 复用 components/dashboard/console/project-select
├── fetch daily-analysis API      ← 复制 v1 page 的 fetch 逻辑（同端点、同参数）
│   ├── currentRows (近30天)
│   └── comparisonRows (上一周期)
├── v2-stats        ← currentRows 汇总 + comparisonRows 算 delta
├── v2-revenue-chart ← dynamic import, ssr:false
├── v2-channel-chart ← dynamic import, ssr:false
└── v2-invoices / v2-billing / v2-activity ← mock-data.ts，无 fetch
```

- **Fetch 复制而非抽取**：v2 page 写独立 fetch（同 API），不动 v1 page.tsx。实验期间两处独立演进，v2 转正后再统一
- **Recharts 拆包**：`next/dynamic` + `ssr: false` + flat 风格 Skeleton loading（沿用 v1 性能策略，recharts 主体 ~400KB）
- **Loading 态**：真实数据区块显示 Skeleton（`animate-pulse` 灰色块，匹配纯平风格）；mock 区块无 loading 直接渲染
- **错误处理**：fetch 失败时真实数据区块显示空态提示（一行文字 + 重试按钮），不阻塞 mock 区块

## 6. 视觉规范

**Efferd 设计语言（忠实复刻 sample）：**
- 网格：`gap-px bg-border` 发丝线分隔，lg 4 列 / md 2 列 / 移动端 1 列
- 卡片：`rounded-none shadow-none ring-0 bg-background`——纯平、无圆角、无阴影
- 数字：`tabular-nums font-semibold text-2xl`；标签：`text-xs tracking-wide text-muted-foreground`
- Delta：绿涨（emerald）红跌（red），带趋势箭头图标

**主题适配：**
- 全部用 shadcn CSS 变量（`bg-background`、`text-foreground`、`border` 等）→ 现有 `theme-provider` 暗色模式自动生效
- 图表颜色走 `ChartContainer` + `--chart-1~5` 变量，与 v1 图表主题一致

**交互细节：**
- 卡片 hover：`bg-muted/50` 微变色过渡（sample 无，纯平风格下极轻反馈）
- 图表：recharts 内置入场动画 + `ChartTooltip`（sample 原有，保留）
- Invoices 表格行 hover 高亮（sample 原有）
- 不做滚动动画/视差——dashboard 是工具页
- 不加 v2 专属 CSS 文件——全部 Tailwind utility classes

## 7. V1/V2 互跳

- v1 `page.tsx` 顶部工具栏右侧：`<Link href="/dashboard/v2">` "试试新版 ✨"（ghost 样式）
- v2 页面顶部工具栏同位置："返回旧版"（ghost 样式）
- 纯 `next/link`，无状态管理、无 cookie 记忆（临时实验不做偏好持久化）
- Sidebar 不动——v2 只通过按钮进入

## 8. 测试

**单测（Vitest + Testing Library）：**
- `v2-stats`：汇总计算 + delta 百分比正确性
- `v2-delta`：涨/跌/零 三态渲染 + 颜色
- `v2/page`：smoke test（mock fetch，断言 6 区块 + ProjectSelect 渲染）
- Mock 区块（invoices/billing/activity）不做单测——静态内容，视觉验证即可

**验证顺序**（AGENTS.md）：`pnpm lint` → `pnpm build` → `pnpm test`

**手动验证清单：**
- [ ] 亮/暗两主题视觉正常
- [ ] ProjectSelect 切换项目后真实数据区块刷新
- [ ] v1 → v2 → v1 互跳正常
- [ ] 移动端回退 1 列布局
- [ ] fetch 失败时空态 + 重试按钮可用

## 9. 不做的事（YAGNI）

- 不引入 sample 的 AppShell（sidebar/header/breadcrumb）
- 不抽取共享数据层（v2 转正后再做）
- 不做偏好持久化（cookie/localStorage 记住版本选择）
- 不改全局字体/配色
- 不给 mock 区块接真实数据（后续迭代）
