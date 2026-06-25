# Dashboard 首页重设计规格

## 背景

当前首页布局平铺直叙，缺乏视觉层次和数据故事性。metric cards 四卡片同构火柴盒式，SKU 表打断叙事流线，状态卡片和告警各自堆叠。需要重设计为「数据海报风」—— 大胆数字 + 对比色调，第一时间抓住视线。

## 核心叙事

**"一切都在掌控中"** — 全局概览，一屏看完。运营人员打开首页应立即感受到：关键指标健康？出了什么问题？趋势如何？

## 视觉风格

数据海报风（Vercel/Twitter 数据卡片式冲击力）：
- 大字号数字 + 色彩状态指示
- 毛玻璃卡片 `.dashboard-surface` 风格
- Space Grotesk（数字/标题）+ Manrope（UI 文本）
- 语义色：secondary=正面, destructive=负面, amber=警告, muted=中性

## 布局设计

### 桌面端 (xl+, ≥1280px)

```
┌───────────┬───────────────────────────────────┐
│  Toolbar  │   日期 · 刷新按钮                  │
├─────┬─────┼───────────────────────────────────┤
│销售额│订单量│                                   │
│$52.8k│1.2k │      销售趋势图                     │
│▲+12%│▼-2% │      (右侧 60%)                    │
│spark │spark│                                   │
├─────┼─────┤                                   │
│广告比│增长  │                                   │
│18.5%│+12% │                                   │
│▲ 优 │spark│                                   │
└─────┴─────┼───────────────────────────────────┘
├────────────┴───────────────────────────────────┤
│  系统状态面板 (全宽)                              │
│  🚛 发货 │ 🔄 退货 │ 📊 广告效果 │ ⚠ 告警计数  │
│  ⚠ 告警事件列表 (最近2-3条)                       │
└────────────────────────────────────────────────┘
```

### 平板端 (lg, ≥1024px)

- 指标磁贴 4 列横排（每个等宽，占 25%）
- 销售趋势图全宽
- 系统状态面板全宽

### 手机端 (<768px)

- 每个指标磁贴全宽单列堆叠
- 销售趋势图全宽
- 系统状态面板全宽

## 组件详细设计

### 1. Toolbar（顶栏）

位置：页面最顶部，flex between 布局。

- **左侧**：视图切换 `ViewModeToggle`（今日销售概况 / 每周销售概况）
- **中间**：日期范围文字（如 "2026-06-04" 或 "06/01 — 06/07"），居中，小字 muted
- **右侧**：全局刷新按钮

样式：`h-12`，底部 border `border-border/50`，`backdrop-blur-sm`。

### 2. Metric Tiles（指标磁贴）

4 个磁贴，桌面端 2×2 网格占左侧 40%，平板/手机视响应式变化。

**主次逻辑**：
1. **销售额** — 最强视觉权重，sparkline 用品牌色 `hsl(var(--secondary))`
2. **订单量** — 次强，sparkline 用 `hsl(var(--chart-2))`
3. **广告成本比** — 数字 + 语义色（≤20% 绿/20-40% 灰/>40% 红）
4. **增长指数** — 最轻，只有百分数字 + 趋势箭头

**每个磁贴内部结构**：
```
┌──────────────────┐
│  小标签 (kicker)   │  text-xs font-medium text-muted-foreground
│                   │
│  $52.8k           │  Space Grotesk, clamp(2rem, 3.2vw, 3rem), font-bold
│                   │     line-height: 1.1, letter-spacing: -0.02em
│  ▲ +12.3%         │  变化率，语义色
│                   │     ▲ = text-secondary, ▼ = text-destructive, — = text-muted
│                   │
│  ╱╲╱╲╱╲           │  sparkline (28px 高)
│                   │     渐变填充 + 线条
│  vs 昨日           │  对比基准，text-[10px] text-muted-foreground
└──────────────────┘
```

**卡片风格**：
- `backdrop-blur-sm bg-background/70`
- `border border-border/50 rounded-xl`
- `hover: hover-lift` 上浮 1px + border 更明显
- `animate-enter` 入场动画

**空状态**：磁贴骨架屏，保持位置。

**变化率颜色语义**：
- `changeType === 'up'` → `text-secondary`（绿色 = 正面增长）
- `changeType === 'down'` → `text-destructive`（红色 = 负面下降）
- `changeType === 'neutral'` → `text-muted-foreground`（灰色 = 无变化）

**广告成本比特殊逻辑**：
- ACOS ≤ 20%: 整体背景淡绿 `bg-secondary/5`，标签显示"优秀"
- ACOS 20-40%: 整体背景淡黄 `bg-amber-500/5`，标签显示"正常"
- ACOS > 40%: 整体背景淡红 `bg-destructive/5`，标签显示"偏高"

### 3. Sales Chart（销售趋势图）

占据右侧 60%（桌面端），全宽（平板/手机）。

**升级要点**：

1. **标题区** — 粗体 "销售概览" + 副标题日期范围 + 刷新按钮
2. **内嵌数据条** — 图表卡片顶部嵌入两个小磁贴（区间总销售额 + 总订单量 + vs 上周期变化率）
3. **柱状图** — 圆角增大 `radius=[8,8,0,0]`，当前周期用 `var(--color-sales_amount)`，上周期用 `rgba(148,163,184,0.22)`
4. **折线** — 保持当前样式，上加粗 `strokeWidth=3`
5. **网格** — 只保留水平线，去掉竖线
6. **背景** — `bg-[hsl(var(--surface-soft))]/82` 带微透明度
7. **Legend** — 圆点标记 + 当前周期，虚线 + 上周期
8. **空状态** — 友好图标 + 引导文字

### 4. System Status Panel（系统状态面板）

合并原 `DashboardStatusCards`（发货/退货/广告效果）+ `DashboardAlertWidget`（告警）。

**上方：4 列指标摘要**

```
┌───────────┬───────────┬───────────┬───────────┐
│  🚛 发货   │  🔄 退货   │  📊 广告   │  ⚠ 告警   │
│  3 批在途  │  2.1%     │  ROAS 5.4 │  3 条活跃  │
│  120 件   │  主因:尺寸  │  ACOS 18% │  🔴1 🟡2  │
└───────────┴───────────┴───────────┴───────────┘
```

- 每格用极淡背景色区分：发货 `secondary/5`、退货 `amber/5`、广告 `chart-1/5`、告警 `destructive/5`
- 数字保持正常色，只有告警用语义色

**下方：最近 2-3 条告警事件**

每条一行：`● 严重度圆点 | 消息 | 偏差百分比 | 相对时间 | 严重度 badge`

**无告警时**：
告警格显示 ✅ + "系统正常"。下方事件列表隐藏。

### 5. 移除的组件

- `SkuSalesDetailTable` — 从首页移除，在相应子页面提供完整版本

### 6. 工厂模式（Factory Dashboard）

> **2026-06-24 更新**：工厂（`factory`）角色已下线，`FactoryDashboard` 组件
> 及其在首页的 `roleType === 'factory'` 分支已删除；该组件文件
> `frontend/components/dashboard/factory-dashboard.tsx` 也已移除。
> 历史决策可参考本节原始描述。

## 数据流

保持现有 `useDashboardOverview` hook 不变。指标数据由来 `buildMetricProps()` 转换，图表数据由 `DashboardSalesChart` 内部 fetch。系统状态面板合并现有 `DashboardStatusCards` 和 `DashboardAlertWidget` 的数据源。

## 组件拆分

| 新组件 | 来源 |
|--------|------|
| `DashboardToolbar` | 新建，整合 ViewModeToggle + 日期 + 刷新 |
| `DashboardMetricTiles` | 重写 `MetricCards`，改为磁贴布局 |
| `DashboardMetricTile` | 单个指标磁贴（新组件） |
| `DashboardSalesChart` | 保持，升级样式 |
| `DashboardSystemStatus` | 新建，合并 StatusCards + AlertWidget |

## 文件变更

| 操作 | 文件 |
|------|------|
| 重写 | `frontend/app/dashboard/page.tsx` — 新布局 |
| 重写 | `frontend/components/dashboard/metric-cards.tsx` → `metric-tiles.tsx` |
| 新建 | `frontend/components/dashboard/dashboard-toolbar.tsx` |
| 新建 | `frontend/components/dashboard/dashboard-system-status.tsx` |
| 修改 | `frontend/components/dashboard/dashboard-sales-chart.tsx` — 样式升级 |
| 废弃 | `frontend/components/dashboard/dashboard-status-cards.tsx` — 合并到 system-status |
| 废弃 | `frontend/components/dashboard/dashboard-alert-widget.tsx` — 合并到 system-status |
| 不变 | `frontend/components/dashboard/sku-sales-detail-table.tsx` — 保留组件但从首页移除引用 |

## 不在范围内

- 后端 API 变更
- 新增数据字段
- 工厂模式（FactoryDashboard）变更
- 暗色模式独立设计（自动适配现有 CSS 变量）