# V4 Warm Ledger Light Mode 实施计划

> 对应设计：[2026-11-10-v4-light-mode-design.md](../specs/2026-11-10-v4-light-mode-design.md)
> 状态：用户已确认设计，开始实施
> 影响面：Warm Ledger token 层 → 全部 V4 页面继承；测试档位 T3（共享 token + 前端构建）

## 现状与关键结论

- Warm Ledger token 定义在 [theme.css](../../../frontend/components/dashboard-v2/warm-ledger/shell/theme.css) 的 `.warm-ledger` 块，只有暗色值，并硬编码 `color-scheme: dark`。
- V4 页面在 [dashboard layout](../../../frontend/app/dashboard/layout.tsx) 上挂载 `warm-ledger` class；所有组件通过 `var(--warm-ledger-*)` 消费 token。
- 根节点 `<html>` 由 next-themes（`attribute="class"`、`defaultTheme="system"`、`enableSystem`）写入 `light` / `dark` class，因此浅色覆盖可用 `html.light .warm-ledger` 选择器，且不需要 JS 改动。
- 抽查结论：`frontend/components/dashboard-v2/warm-ledger` 下的 tsx **没有**硬编码色值，颜色全部走 token；暗色只残留在 theme.css 的少数硬编码阴影 / 遮罩与“强调色按钮上的文字色”。

## Batch 1（本轮）目标

1. 在 `theme.css` 增加 `html.light .warm-ledger` 覆盖层，暗色块数值保持不变（像素级不变）。
2. 抽出新语义 token：`--warm-ledger-color-on-accent`、`--warm-ledger-shadow-popover`、`--warm-ledger-shadow-dialog`、`--warm-ledger-color-backdrop`，替换硬编码 `rgba(0, 0, 0, …)` 与按钮文字色。
3. Light 一般强调色改绿；Dark 保持琥珀。正向状态与一般强调拆成不同色相。
4. 新增加固测试：token 完整性、暗色不变、浅色色相分工、WCAG 对比度、无残留硬编码深色阴影。
5. 文档：更新 V4 设计规范与 foundations 规范，记录 Light Mode 扩展。

## Batch 2（已按用户确认实施）

- 新增 `--warm-ledger-color-chart-1..5` 与 `--warm-ledger-color-chart-axis`；退货原因饼图改用 token。
- 浅色 `text-muted` / `text-faint` 提升到 4.5:1；暗色文字值不变。
- 新增 `frontend/lib/warm-ledger-colors.ts`；`chart-code-block` 静态 SVG 与 `ai/insights` 的 `toPng` 背景改为按主题取色；周度分析 Tooltip 游标为模式中立墨色，保持原值。
- 新增 `frontend/lib/warm-ledger-colors.test.ts`；`warm-theme.test.ts` 增补图表色与 faint 对比断言。

## Task 1：浅色 token 覆盖层

**文件**：`frontend/components/dashboard-v2/warm-ledger/shell/theme.css`

浅色关键值（已用 WCAG 计算核对）：

| token | Light | 最小对比度 |
| --- | --- | --- |
| stage / window / sidebar / panel / panel-strong / raised / raised-hover | `#e8eae4` / `#fbfcfa` / `#f2f2ef` / `#ffffff` / `#f7f8f5` / `#f1f3ef` / `#e9ece7` | — |
| text / soft / muted / faint | `#242823` / `#4b514a` / `#616a62` / `#81877e` | 12.35 / 6.73 / 4.62 / 3.04（对 stage 最差） |
| accent / accent-strong | `#0f6b57` / `#0b5746` | 5.4 / 7.1 |
| positive / negative | `#2a7130` / `#a83c34` | 5.0 / 5.2 |
| on-accent | `#ffffff` | — |

步骤：
1. 写失败测试（Task 4 的测试文件先创建，断言 light 块存在、色相分工、对比度）。
2. 运行测试确认失败。
3. 在 `.warm-ledger` 块保留暗色值并新增语义 token；新增 `html.light .warm-ledger` 块覆盖颜色 token、highlight、shadow、scrim、backdrop、on-accent 与 `color-scheme: light`。
4. 运行测试通过。

## Task 2：替换硬编码深色用法与页面级琥珀

- theme.css 内：浮层 / 弹窗阴影、`::backdrop` 遮罩、强调按钮文字色改走语义 token；`::backdrop` 保留内联回退（该伪元素不继承自定义属性）。
- 页面 CSS Module：6 个 Warm 页面模块共 19 处琥珀描边 / 底纹字面值改为 `color-mix(in srgb, var(--warm-ledger-color-accent) N%, transparent)`，暗色合成结果与原文 `rgba(232, 179, 90, α)` 等价，浅色自动变绿。
- `frontend/components/dashboard/pricing-calculation/shop-calculation-table-warm.module.css` 的 6 处琥珀底纹 / 描边一并替换。
- 强制暗色展示页（数字大屏、投屏）改用 `frontend/lib/forced-dark.ts`：进入时移除 `light` class，退出时恢复原 class 与 `color-scheme`，避免 `html.light .warm-ledger` 覆盖强制暗色页。

## Task 3：文档

- `frontend/docs/design-spec.md` §0.4 增加 Light Mode 条目与文档指针。
- `docs/design-drafts/2026-11-01-operations-dashboard/components/foundations/spec.md` 增加“Light Mode 扩展（2026-11-10 批准）”小节与 token 表。
- 设计规范文件补“实施记录”。

## Task 4：加固测试

**新增**：`frontend/components/dashboard-v2/warm-ledger/shell/warm-theme.test.ts`

断言：
1. 暗色块全部 23 个颜色 token 与 5 个 highlight / shadow token、`focus-color`、`radius-pill` 冻结为 B0 值（accent `#e8b35a`、positive `#65cfa1`、negative `#ee8580`、panel `#2b2c2b` 等）。
2. 浅色块声明了暗色块全部 `--warm-ledger-color-*` token，且设置 `color-scheme: light`。
3. 浅色 accent 色相在 140–190、positive 在 100–140、negative 不在 60–180；即浅色强调=绿、正向=另一个绿、负向=红。
4. 浅色 text / soft / muted 对 stage、window、sidebar、panel、panel-strong、raised、raised-hover 全部 ≥ 4.5；faint ≥ 3。
5. theme.css 中除 token 定义行外不再出现 `rgba(0, 0, 0,`。
6. 主题文件不使用 `transition: all`。
7. 全部 `var(--warm-ledger-*)` 引用（app/dashboard 与 components 下的 css / tsx / ts）都能在 theme.css 中找到声明。
8. Warm 页面 CSS 模块中不再出现琥珀字面值（`rgba(232, 179, 90, …)`、`#e8b35a`、`#f3c875`）。
9. `app/layout.tsx` 仍保持 next-themes 的 `attribute="class"` / `defaultTheme="system"` / `enableSystem` 契约。
10. 两个强制暗色展示页使用 `forceDarkDocument`，不再单独 `classList.add('dark')`；helper 同时移除 `light` 并在卸载时恢复。
11. `lib/forced-dark.test.ts` 验证进入 / 退出时的 class 与 `color-scheme` 行为。

## Task 5：验证（T3）

1. `cd frontend && pnpm vitest run components/dashboard-v2/warm-ledger`
2. `cd frontend && pnpm test`（全量 235+ 文件）
3. `cd frontend && pnpm lint`
4. `cd frontend && pnpm build`
5. 可运行 dev server 时，用浏览器在 1440×900 检查 /dashboard 的 Dark / Light / System 三态与主题选择器。

## 验收标准

- Dark 渲染与当前一致（token 值未变）。
- Light 下全部 V4 页面呈现“账本纸白”表面 + 绿色强调，原生控件 `color-scheme` 为 light。
- 无残留硬编码深色阴影 / 遮罩 / 强调按钮文字色。
- 测试、lint、build 全绿；失败项按失败集对账规则处理。
