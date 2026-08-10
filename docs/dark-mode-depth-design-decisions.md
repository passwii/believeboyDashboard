# 暗黑模式层次规范设计决策记录（Raycast Depth & Elevation）

> **BLF-573（Stage 7-1）** · 2026-08-10 · 前端工程师 Seth
> **输入**：Raycast 官方设计参考 `https://stylepilot.zaowusou.com/design-md/raycast/DESIGN.md`（47 节，本仓库已抓取学习）
> **产出**：本文（设计决策记录）+ `docs/FRONTEND-DESIGN-SPEC.md §9`（权威规范）+ `frontend/app/globals.css`（token 落地）
> **原则**：不 100% 照搬，取其「组件与层次处理精髓」；文档与实际代码一致（每个条目指向真实代码位置）。

---

## 1. Raycast 精髓提炼（从 DESIGN.md 学到什么）

| # | 精髓 | 出处 | 一句话 |
|---|---|---|---|
| 1 | 背景蓝调近黑 | DESIGN.md §1/§7 | `#07080a`，禁止纯黑 `#000`——冷蓝底是 Raycast 区别于通用暗黑主题的关键 |
| 2 | **成对阴影** | §6 Depth & Elevation | 阴影永远成对（外阴影 + inset 配对），6 级：Level 0 Void → Level 5 Floating；**层次感靠结构不靠颜色** |
| 3 | 双环围合 | §6 Level 2 Ring | `rgb(27,28,30) 0 0 0 1px` 外 + `rgb(7,8,10) 0 0 0 1px` inset = 卡片围合 |
| 4 | macOS 原生按压 | §6 Level 3 Button | 白顶内高光（`rgba(255,255,255,0.05) inset`）+ 白 1px 外环 + 深底内嵌（`rgba(0,0,0,0.2) inset`） |
| 5 | 浮层重深度 | §6 Level 5 Floating | `rgba(0,0,0,0.5) 2px 外环` + `rgba(255,255,255,0.19) 14px 辉光` |
| 6 | 边框高光 | §2/§4 | 卡片 1px `rgba(255,255,255,0.06)` 内描边；hover 用**边框透明度提升**（0.6 过渡），不换色 |
| 7 | 输入聚焦 | §4 Inputs | 聚焦边框变亮 + 蓝辉光环 `hsla(202,100%,67%,0.15)` |
| 8 | 圆角阶梯 | §5 Border Radius | 2-3px 微元素 / 6px 按钮徽章 / 8px 输入 / 12px 标准卡 / 16-20px 大卡 / 86px+ pill |
| 9 | 毛玻璃边界 | §1/§4 | 浮层半透明 + blur（macOS 窗口质感），不铺满 |
| 10 | 材质分层 | §2 Surface | 卡片 `#101111`，白边框 0.06-0.1 透明度 |
| 11 | 排版 | §3 | Inter，正文**正字距 +0.2px**（暗底更透气）、body 用 500 而非 400 防发虚 |

---

## 2. 现状差距审计（证据，origin/main）

| 项 | Raycast 目标 | 现状 | 差距结论 |
|---|---|---|---|
| 阴影体系 | 成对（外+内）6 级 | `--shadow-soft/raised/overlay` 单层外阴影（globals.css:76-78 / 176-178） | **核心差距**：无 inset 配对 |
| 按钮按压 | 白顶内高光 + 深底内嵌 | `bg-primary` / `outline` 纯色（button.tsx:12-14） | 无按压层次 |
| 输入聚焦 | 边框变亮 + 蓝光环 | 标准 `ring-2`（input.tsx:7） | 无玻璃蓝辉光 |
| 卡片边框 | 白 0.06 内描边 + 双环 | `dashboard-surface` 已有顶部内高光（globals.css:456-460） | 有雏形，已 token 化升级 |
| 毛玻璃 | 浮层半透明 + blur | `dashboard-glass` 存在（globals.css:499-510）但仅浮层用 | 遵守 508 约束，不铺开 |
| 背景 | `#07080a` 蓝调近黑 | `--background: 225 12% 9%`（globals.css:118） | 已接近，微调非本次范围 |
| 圆角阶梯 | 6/8/12/16/20/86 | `--radius-xs~xl` 0.375-1rem（globals.css:70-75） | 接近，按用途映射 |

**⚠️ 高 DPI 历史约束**（globals.css:462-475 明确记载）：曾给所有 `dashboard-surface` 加 `backdrop-filter: blur(14px)`，因 5K/4K/Retina 高 DPI 下 1px 边框与 12px 表头被糊掉、且 92 处共用影响面太大而移除。**毛玻璃只用于浮层与关键玻璃位，不铺满卡片**。本次 token 落地遵守该约束。

---

## 3. 设计决策（采纳 / 改编 / 不采纳）

### 3.1 采纳：成对阴影 token（Level 0-5）

**决策**：新增 `--shadow-level-1..5`，每条是「外阴影 + inset 配对」的完整 shadow 列表（与 Raycast 同构：单 CSS 变量承载多层阴影）。保留 `--shadow-soft/raised/overlay` 作兼容别名，存量消费方零改动。

**映射**（dark 侧重）：

| Level | token | 用途 | 结构（对应代码） |
|---|---|---|---|
| 0 Void | — | 页面画布 `--background` | 无阴影 |
| 1 Subtle | `--shadow-level-1` | 内联微元素 / chip | 微小外下落 + 极淡内高光 |
| 2 Ring | `--shadow-level-2` | **标准卡片**（`.dashboard-surface`） | 顶内高光 + 全周长内描边 + soft 下落 = 双环围合 |
| 3 Button | `--shadow-level-3` | 按钮 / 按压态（macOS 原生按压） | 白顶内高光 + 白 1px 外环 + 深底内嵌 |
| 4 Key | `--shadow-level-4` | 键帽 / 命令面板条目 | 5 层阴影栈 + inset 按压 |
| 5 Floating | `--shadow-level-5` | 浮层 / 玻璃面板（`.dashboard-glass`） | 2px 深环 + 白辉光 + overlay 下落 + 玻璃边 |

**已落地消费**：`.dark .dashboard-surface` / `.dark .dashboard-panel` / `.dark .dashboard-toolbar` → `var(--shadow-level-2)`；`.dark .dashboard-glass` → `var(--shadow-level-5)`（globals.css:456-460 / 490-493 / 592-594 / 505-510）。

**影响面**：`.dashboard-surface` 92 处共用，但 dark 下的新旧 box-shadow 值逐层一致（0.08/0.04 inset + soft 下落），渲染不变，纯 token 化重构。

### 3.2 采纳：`--glass-edge-highlight` + `--focus-glow`

- `--glass-edge-highlight: 0.08`：顶内高光强度，`--shadow-level-2/5` 内部引用（`hsl(220 30% 100% / var(--glass-edge-highlight))`），调强度一处生效。
- `--focus-glow`：light `hsla(214,89%,43%,0.12)` / dark `hsla(202,100%,67%,0.15)`（Raycast 蓝辉光原文）。
- 配套 `.u-focus-glow` 工具类（globals.css:545-550）：focus-visible 时 1px ring + 4px 蓝辉光，供 Stage 7-2 迁移 input/textarea 聚焦态（替代现硬环 `ring-2`）。

### 3.3 采纳：圆角按用途映射（不推翻既有 token）

在 `--radius-xs(0.375rem)/sm(0.5rem)/md(0.625rem)/lg(0.75rem)/xl(1rem)` 上做用途映射：微元素 `xs` / 按钮·徽章·输入框 `md` / 标准卡 `lg` / 大卡·浮层 `xl` / pill `rounded-full`。详见 §9.6。

### 3.4 改编：hover 透明度过渡

Raycast 用 opacity 0.6 过渡；本项目按钮已带 `u-press` / `u-interactive`（transform + box-shadow 过渡，globals.css:517-534）。卡片 hover 走 `hover-lift`（translateY + raised，globals.css:633-643）。保留现有动效语言，不照搬 opacity 0.6（避免与既有动效体系冲突）。

### 3.5 不采纳（理由）

| 项 | 理由 |
|---|---|
| Raycast Red `#FF6363` 品牌色 | 本项目品牌蓝体系已定（BLF-494），红色仅 `--destructive` 语义用 |
| 键盘键帽 `--shadow-level-4` 立即铺开 | 项目暂无快捷键展示组件，仅备 token，待业务需要时启用 |
| body 字重 500 / 正字距 +0.2px 全站改 | 排版调整影响面大（全站文字），超出 token 体系范围，留待专项 |
| 背景微调 `#07080a` | 现 `225 12% 9%` 已接近，视觉差异不可辨，不冒回归风险 |
| 给所有卡片加 blur | **高 DPI 历史教训，明确禁止**（globals.css:462-475） |

---

## 4. 验证结论

- `pnpm lint`：0 error
- `pnpm build`：通过
- 相关 vitest：全绿（button.test / motion tokens 等，无 CSS token 断言受影响）
- 兼容性：`--shadow-soft/raised/overlay` 未删除，存量消费（24+ 处 tsx + tailwind.config.ts 映射）零改动

---

## 5. 后续（Stage 7-2 待铺开清单）

| 项 | 现状 | 迁移目标 | 涉及文件 |
|---|---|---|---|
| dialog / popover / select / command 浮层阴影 | 字面量 `dark:shadow-[0_24px_48px_-28px_rgba(0,0,0,0.82)]` | `--shadow-level-5` | `components/ui/dialog.tsx:41` / `popover.tsx:26` / `select.tsx:75` |
| input / textarea 聚焦 | `focus-visible:ring-2` 硬环 | `.u-focus-glow`（`--focus-glow`） | `components/ui/input.tsx:7` / `textarea.tsx` |
| button 按压 | `u-press` scale 0.97 | 叠加 `--shadow-level-3` inset | `components/ui/button.tsx` + `u-press` |
| 卡片 hover | `hover-lift`（raised 单层） | raised + L2 内描边配对 | `globals.css` `.hover-lift` |

> 执行者变更后先读本文 §3 + FRONTEND-DESIGN-SPEC §9，再动手；所有改动必须同时满足「文档 ↔ 代码一致」。
