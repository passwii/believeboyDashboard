# Dashboard 首页新订单流面板 — 系统性规划（BLF-926）

> **Goal:** 在 Dashboard 首页（`/dashboard`）右侧新增「订单流」可折叠面板，重点展示**待处理 pending 订单**，整体遵循 Terminal 设计体系（BLF-809/BLF-887），分 Stage 落地，每 Stage 独立可交付、可回滚。

**Architecture:** 页面级右侧面板（`app/dashboard/page.tsx` 布局内 flex 行），桌面（lg+）显示、默认折叠为窄条、点击展开 320px 面板；折叠状态持久化 localStorage。数据源**全部复用既有后端端点**，**本规划零后端改动**（Stage 2 复用 `order-info/overview`，Stage 3 如需订单级 pending 专用端点再拉 Damon）。

**Tech Stack:** Next.js 15 (App Router) + React 19 hooks + Vitest + Testing Library；后端 FastAPI（只读消费）。

## 现状盘点（2026-08-31，基于 origin/main 2b3aecf6）

### 首页（`frontend/app/dashboard/page.tsx`，DashboardV2Page）
- 布局：`flex flex-col gap-2` → headerSlotPortal → `V2Grid`（lg 4 列发丝线网格）→ `TermPanel`「近 14 天明细」。
- 已加载数据：`currentRows`（DailyAnalysisRow，含 `pending_order_qty`）、`projectBreakdown`（按项目 summary_rows）、`projects`（manage 项目列表）。
- 语义：`pending_order_qty` = 该日待发货件数（后端 `daily/sales.py:72` 桶内累加）。

### 既有可复用数据源
| 数据 | 端点 | 说明 |
|------|------|------|
| Pending 件数（区间） | 首页已加载 `currentRows` | 零额外请求 |
| 项目 pending 分解 | 首页已加载 `projectBreakdown` | 零额外请求 |
| 今日出单流 | `GET /api/backend/api/v1/order-info/live-stream?limit=10` | BLF-839，30s 轮询 hook `useLiveStream` 已存在 |
| 订单级 pending 列表 | `GET /api/backend/api/v1/order-info/overview?order_statuses=Pending&...` | BLF-157，支持状态/项目/国家/日期筛选 |
| 全局快报 Pending | `useDailyBrief`（footer ticker） | BLF-816/920，今日 pending 全局汇总 |

### 交互基线
- Right Inspector（360px，⌘B 开关）已存在，含「Live Stream · 今日出单」区块——与本次面板数据同源，但 Inspector 是全局外壳级，本次面板是**首页级**、聚焦 pending、独立折叠状态。
- 折叠状态持久化范式：`useTerminalLayout`（localStorage flag）——本次面板沿用。

### 既有契约（必须遵守）
1. Terminal 面板：1px `border-term-border`、零圆角、零阴影、标题条 h-10、内容锁 4/8px（BLF-809 §1）。
2. 数值 `font-mono tabular-nums`；中文标签不 mono；微语义色 `term-pos/warn/neg/muted`。
3. 移动端 `<lg` 隐藏右侧面板（与 Inspector `hidden lg:flex` 一致）；面板不占移动端首屏。
4. 测试模式：hook 全 mock（`vi.mock`），纯函数逻辑单测。
5. CodeGraph 契约（BEL-93）：改公共组件/hook 前跑 `codegraph callers/impact`，PR 写明影响面。

## 方案设计

### 布局（BLF-926 Stage 1 落地）
```
<div class="flex flex-col gap-2">
  {headerSlotPortal}
  <div class="flex items-stretch gap-px">          ← 主区 + 右侧面板
    <div class="flex min-w-0 flex-1 flex-col gap-2"> ← 主区（原 V2Grid + TermPanel）
      <V2Grid>…</V2Grid>
      <TermPanel title="近 14 天明细">…</TermPanel>
    </div>
    <V2OrderFlowPanel …/>                          ← 新组件（hidden lg:flex）
  </div>
</div>
```

### 组件：`frontend/components/dashboard-v2/v2-order-flow-panel.tsx`
- **折叠态（默认）**：`w-11` 窄条，竖排「订单流」文字 + Pending 计数徽标（`border-term-warn/60` 琥珀色，>99 显示 99+）；点击展开。
- **展开态**：`w-[320px]` 面板：
  - 头部：标题「订单流 · 待处理」+ Pending 徽标 + 收起（X）按钮；
  - 摘要：最新 pending 件数（`currentRows` 最后一天 `pending_order_qty`，大号琥珀 mono 数字）；
  - 待处理项目：按各项目最新 pending 排序取 Top 5（`projectBreakdown`）；
  - 今日出单：复用 `useLiveStream(open)`（仅展开时轮询），空态显示「同步中」骨架；
  - 底部：链接「查看完整订单信息」→ `/dashboard/reports/order-info`。
- **状态持久化**：`localStorage['bb.dashboard.order-flow-open']`（默认折叠 = 无键/`'0'`）。
- **数据展示范围**：当前所选项目范围（与首页 project 筛选联动——Stage 1 直接吃首页已选定的 `currentRows/projectBreakdown`）。

## Stage 拆分

### Stage 1（本期，已实现）— 可折叠面板骨架 + 零请求复用
- [x] `V2OrderFlowPanel` 组件：折叠窄条 / 展开 320px 面板 / localStorage 持久化。
- [x] 接入 `app/dashboard/page.tsx`：主区 flex-1 + 右侧面板。
- [x] pending 件数 + 项目 Top5 分解（复用首页已加载数据，零额外请求）。
- [x] 今日出单流（`useLiveStream`，仅展开时轮询）。
- [x] 单测：`v2-order-flow-panel.test.tsx`（15 用例）+ 首页测试补面板断言。
- 验收：桌面 lg+ 右侧窄条→点击展开→查看 pending/项目/出单；刷新记忆展开态；移动端不出现。

### Stage 2（后续）— 订单级 pending 列表
- [ ] 面板展开时调 `order-info/overview?order_statuses=Pending`（复用首页项目/日期范围），渲染订单级列表（SKU/金额/国家/时间）。
- [ ] 状态 pill（`getOrderStatusLabel` + `statusTone` 语义色，复用 `order-status.ts`）。
- [ ] 行点击 → 跳转 `/dashboard/reports/order-info` 预填 Pending 筛选。
- [ ] 分页 / 加载更多（复用 `TermTable` Pattern A 高密度表）。
- 风险：大表全扫耗时（order-info 页 BEL-422 教训），需项目 autoselect + 日期窗口限定。

### Stage 3（后续）— 实时刷新 + 操作闭环 + 移动端
- [ ] pending 计数轮询（30s，页面可见时）+ 展开/收起时立即刷新。
- [ ] 操作闭环：标记处理（`order-info` PATCH，对齐 OrderEditDialog 权限）、清空 pending。
- [ ] 移动端：折叠为底部条或 Sheet 抽屉（对齐 `terminal-shell.tsx` 移动端抽屉范式）。
- [ ] 若需「仅 pending 订单的轻量聚合端点」→ 拉 Damon 后端配合（不在本规划默认范围）。

## 测试计划
- 单元：`v2-order-flow-panel.test.tsx`（折叠/展开/徽标/项目分解/出单流/边界）。
- 集成：首页 `page.test.tsx` 断言面板存在。
- 手工：桌面浏览器（lg）验证折叠→展开→刷新记忆→移动端隐藏。

## CodeGraph 影响面
- 改动：新增 `v2-order-flow-panel.tsx`（新组件，无既有调用方）；`app/dashboard/page.tsx` 仅布局包裹（`callers` 无公共符号改动）。
- `useLiveStream`：复用不改，仅在面板展开时新增一个调用实例（与 Inspector 并行轮询，Stage 3 可考虑共享 context）。
- 结论：公共符号零修改，影响面=首页渲染树新增一个右侧面板。
