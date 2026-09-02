# 图例系统化设计（非纯黑、组件化、跨页复用）— BLF-942

> **状态：** ✅ **Stage 1 完成**（2026-09-02）
> **分支：** `agent/seth/fc69e09996c6`
> **关联：** [BLF-942](https://github.com/passwii/believeboyDashboard/issues/942) · 前置 [BLF-911](./2026-09-02-chart-legend-system.md)（ChartCard 壳 + 图表包装器已收口）

## 背景与问题

BLF-911 已把首页图表收口到统一体系：

- `components/charts/chart-card.tsx` — ChartCard 壳（surface 面板风，非 terminal 黑底）
- `components/charts/cards.tsx` — Line/Bar/Area/Composed/PieChartCard 图表本体包装器
- `components/charts/primitives.tsx` — ChartContainer / 色板 / 默认轴 / tooltip
- `docs/chart-unification-spec.md` — 统一规范

但**图例仍是短板**：所有图表包装器都用 shadcn 默认 `ChartLegendContent`：

- swatch 固定 8px 圆角方块，**不与系列几何对齐**（area 该用圆点、line 该用短线、bar 该用方块、dashed 该用虚线）
- 纯文本 + 方块，dark 模式（`--card` L16% 炭黑）下观感偏 terminal 黑底，不够系统化
- 无对齐/换行/尺寸控制，跨页无法复用统一观感

用户诉求（BLF-942）：①系统化 + 不要纯黑；②分 Stage 组件化；③跨页面复用。

## 方案：三层图例体系

```
components/charts/legend.tsx   ← 新增：LegendSwatch + LegendItem + ChartLegend（纯视觉，可独立测试）
components/charts/cards.tsx    ← 增强：5 个包装器自动推断 swatch 变体，替换默认 ChartLegendContent
页面/其他图表                   ← 复用：默认获得统一图例，零/极少调用方改动
```

### 关键设计：swatch 变体按系列几何自动推断

recharts legend payload 的 `item.type` 携带系列类型（`line` / `bar` / `area` / `pie`），
卡片内据此推断 swatch 形态；line 若有 `strokeDasharray` → `dashed`。调用方零改动即获得
"图例与图形一致"的系统化观感。必要时通过 `legend` 覆盖。

| 系列几何 | swatch 变体 | 渲染 |
| --- | --- | --- |
| area / pie / 单点 | `dot` | 8px 圆点 `rounded-full` |
| line | `line` | 16×3 短线 `rounded-full` |
| line + strokeDasharray | `dashed` | 16×3 虚线（渐变/重复线） |
| bar | `bar` | 10×8 圆角方块 `rounded-[3px]` |

图例视觉基线：

- 颜色一律 `var(--color-<key>)`（由 ChartContainer 注入 `--chart-N` 令牌）→ light/dark 双主题自适应，**无纯黑**
- 字号 `text-xs`，文字 `text-muted-foreground`，hover 文字提亮 + 底色 `bg-muted/50`
- 间距 `gap-x-3 gap-y-1`，支持 `flex-wrap` 换行
- 对齐 `center | start | end`，垂直位 `top | bottom` 沿用现有约定

## Stage 划分

| Stage | 主题 | 内容 | 状态 |
| --- | --- | --- | --- |
| **Stage 1** | 图例视觉系统化 | `legend.tsx` 组件 + cards.tsx 自动推断 swatch 接入 + 首页 3 图（revenue/channel/traffic）统一 + 单测 + 规范更新 | ✅ 本 PR |
| Stage 2 | 交互 toggle + 手写 ChartContainer 页 | 点击图例隐藏/显示系列；portfolio 等手写 `<ChartLegendContent>` 页面切统一图例 | 待排期 |
| Stage 3 | 全站 rollout + 验收 | reports / monthly-report / ad-analysis 等更多页面接入；spec 全量更新；验收基线跑通 | 待排期 |

## Stage 1 实现清单

1. **新增 `frontend/components/charts/legend.tsx`**
   - `LegendSwatch({ variant, color, size })` — dot/line/dashed/bar 四种形态
   - `LegendItem({ label, color, variant, active, onClick })` — 单个图例项（hover 微交互）
   - `LegendRow({ items, align, verticalAlign, size })` — 容器（wrap + 对齐 + 垂直留白）
   - `type LegendSwatchVariant`
2. **增强 `frontend/components/charts/cards.tsx`**
   - 新增 `LegendBridge`（接收 recharts Legend payload → `LegendRow` items）
   - 5 个包装器（Line/Bar/Area/Composed/Pie）默认图例改为 `LegendBridge`，swatch 变体按系列几何自动推断
   - 每个 series spec 支持可选 `legend?: { variant?: LegendSwatchVariant; label?: string }` 覆盖
3. **首页验证**：revenue（bar+line）、channel（line+dashed）、traffic（bar+line）图例自动对齐
4. **新增 `frontend/components/charts/legend.test.tsx`**（16 例 vitest 单测）
5. **更新 `docs/chart-unification-spec.md` §1.2 图例**
6. **更新 `frontend/components/charts/index.ts`** barrel 导出 legend

## 交付记录（2026-09-02）

- 新增 `frontend/components/charts/legend.tsx`（LegendSwatch/LegendItem/LegendRow + legend.test.tsx 16 例）
- `cards.tsx` 5 个包装器全部切到 LegendBridge（含 series spec `legend` 覆盖字段）
- 首页 revenue/channel/traffic 图例随包装器自动升级
- 验证：`pnpm lint` 0 errors；`next build` ✓；charts+dashboard-v2 97 例全绿；全量 1226 passed（3 例 project-goals 存量 flaky 同 origin/main 基线）

## 验证

- `pnpm lint` + `pnpm build` + `pnpm test`（重点 legend.test.tsx 与既有 chart-card.test.tsx）
- 首页手动验证：light/dark 双主题下图例 swatch 形态正确、非纯黑、间距统一

## 后续 Stage 排期（不在本 PR）

- **Stage 2 交互 toggle + 手写 ChartContainer 页**：点击图例隐藏/显示系列（需卡片级受控 state）；
  `portfolio-trend-chart.tsx`、`portfolio-pie-chart.tsx` 切到统一图例（`LegendRow`）。
- **Stage 3 全站 rollout**：`research-analysis/page.tsx`（3 处手写 `ChartLegendContent`）等更多页面接入；
  spec 全量更新；验收基线跑通。
