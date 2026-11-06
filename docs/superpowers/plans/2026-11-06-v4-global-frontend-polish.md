# V4 全局前端打磨实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development for disjoint domain tasks; keep shared-shell changes in the coordinating agent. Follow the approved stage order and preserve the current worktree changes.

**Goal:** 完成 V4 Dashboard 全局视觉与布局打磨，修复审查确认的问题，并保持所有路由的业务契约不变。

**Architecture:** 先处理共享 Tabs、页面过渡与状态边界，再按已迁移域修整局部布局和可读性。页面专用样式留在各自目录；只有存在真实共享契约时才改共享组件。最终按 1440×900 复核 94 个 dashboard 路由状态和独立视觉例外。

**Tech Stack:** Next.js、React、TypeScript、Tailwind CSS、CSS Modules、Vitest、Playwright。

## Global Constraints

- V4 Warm Ledger 是现行权威；不得将 V4 页面改回 V3 Terminal 视觉。
- 桌面工作窗四边使用 8px stage inset，保留 22px 圆角并填满可用视口。
- 桌面验收视口为 `1440x900`；不新增手机端、平板端或多断点适配。
- 不改变 endpoint、URL、筛选语义、排序、分页、权限、写操作、公式、导出列或文件名。
- loading、error、empty 和 zero-data 必须分别呈现；不得用假数据填充空态。
- AI Chat 是独立双主题视觉例外，不使用 Warm Ledger token；本计划不改其视觉主题。
- 文档白纸预览、Digital Display 和 Office presentation 保留各自已批准的视觉与全屏行为。
- 保留当前工作树中 14 个未提交文件的改动，并在相关阶段内审查、整合。

---

## Stage 1：共享状态、首页与 Daily Analysis

**范围：** `/dashboard` 与 `/dashboard/operations/daily-analysis`，共 2 个页面；共享 Tabs 影响所有使用 Warm variant 的路由。

**文件：**
- `frontend/components/ui/tabs.tsx`
- `frontend/components/ui/tab-motion.tsx`
- `frontend/app/dashboard/page.tsx`
- `frontend/app/dashboard/warm-ledger-home.module.css`
- `frontend/app/dashboard/operations/daily-analysis/daily-analysis-client.tsx`
- `frontend/app/dashboard/operations/daily-analysis/daily-analysis-warm.module.css`
- `frontend/components/dashboard/metric-switcher-card.tsx`
- `frontend/components/dashboard-v2/warm-ledger/charts/sales-trend-panel.tsx`
- `frontend/components/dashboard-v2/warm-ledger/orders/order-flow-card.tsx`

**交付：**
- 在 Daily Analysis 实际渲染中确认 active tab 的背景、文字和图标对比，修正颜色反转。
- 保持 Warm Tabs 为显式 variant，不改变默认与 Terminal tab 样式。
- 保留首页与 Daily Analysis 当前已有改动；检查图表、指标卡、订单流及桌面布局的一致性。
- 修正用户可见信息重复、状态色语义及图表容器尺寸问题。

**风险：** Tabs 是共享 primitive；所有类名须通过显式 Warm variant 局部生效。不得修改全局默认主题。

## Stage 2：C1–C3 运营、库存与报表

**范围：** 除 Daily Analysis 外的 9 个路由：Portfolio Overview、Inventory Analysis、Inventory Ledger、Shipping Plan、Shipment Management、SKU Info、Order Info、Product Analysis、Monthly Report Display。

**交付：**
- 为 Portfolio Overview 与 Shipping Plan 图表补足真实数据摘要。
- 将 9px/10px 的可见状态标签提升至 V4 最小字号，并检查空间与对比度。
- 按页面收敛表格、筛选、图表和长内容布局；保留导出、分页、筛选与 URL 语义。

**风险：** 涉及复杂表格与报告状态；不得压缩或隐藏业务列，也不得改变导出合同。

## Stage 3：C5 Finance 与 C6 CRM

**范围：** 14 个实际页面，Finance 4 个、CRM 10 个；另将 3 个 redirect alias 纳入最终路由矩阵。

**交付：**
- CRM Customer/SEA 表格加载时保留工具栏和表格几何，以列对齐骨架替换数据行。
- CRM Tasks 加载时保留看板布局；CRM Dashboard 错误时不把缺失数据显示为有效的零值。
- 全面检查 Finance 的页面层级、筛选、表格和状态密度。

**风险：** CRM 共用表格和加载组件；修复必须覆盖其实际消费者，且不改权限与数据行为。

## Stage 4：C8 Reports、Operations 与 Agent Center

**范围：** 26 个路由，Reports 10、Operations 14、Agent Center 2。

**交付：**
- 移除 Project Launch 的页面级 768px 两栏断点，维持桌面单一布局。
- 将 Pricing Calculation、Scheduled Reports、Workflow Template Editor 的可见 10px 标签提升至至少 11px。
- 按路由修整表单、表格、图表及加载/错误/空状态布局。

**风险：** 路由含多步流程、上传和编辑视图；只改呈现，不改流程与写入合同。

## Stage 5：C7 AI、Tools、System 与通用工具页

**范围：** 24 个 AI/Tools/System 页面路由，加 Profile、Change Password、Feature Updates、Table Showcase 4 个通用页面；另检查 `/p/[id]`、Office presentation 查询状态与独立页面例外。

**交付：**
- 先完成 AI、Tools、System 全路由的页面级审查，再实施确认的问题。
- Dashboard 公共 Suspense fallback 提供有稳定几何的可见加载表面。
- AI Chat 保持已批准的双主题独立视觉，不改 Warm Ledger token 使用或主题实现。
- 文档白纸预览、Digital Display 与 Office presentation 保持现有例外行为。

**风险：** 页面覆盖 Markdown/HTML 预览、数字大屏和投屏模式；不得把例外强制统一成 Warm 表面。

## Stage 6：C4 Advertising

**范围：** 10 个 Ad Analysis 视图、Ad Data 页面和根路由 alias。

**交付：**
- 让分析页筛选控件与 Ad Data 的 Warm 控件一致，同时保留原筛选值和行为。
- 修正七个表格视图的图标/表格布局，确保表格拥有完整可用宽度。
- 减少嵌套分析卡片；给总览图增加真实标题与图例，并按语义使用系列颜色。
- 为各路由提供匹配目标布局的 loading surface 和可见状态；区分查询失败与成功空结果。

**风险：** 广告报告状态与筛选路径复杂；保持 API、筛选、图表数值和 drill-through 行为不变。

## Stage 7：全局收尾

**范围：** 94 个 Dashboard 页面路由状态、3 个 Warm standalone 页面、首页及 Office presentation 查询例外；`1440×900`。

**交付：**
- 检查页面级横向溢出、窗口 8px 等宽外沿、22px 圆角、导航与 route header。
- 复核 active、loading、error、empty、zero-data、长文本和焦点状态。
- 依据受影响范围执行前端目标验证与全局桌面路由验收。
