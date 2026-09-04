# Geist 设计体系 · 阶段 A（设计令牌层）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。
>
> **本计划只动「设计令牌层」（CSS 变量 + Tailwind 配置 + 字体），不触及任何组件的业务逻辑。** 这是研究结论（issue BEL-327）中收益最高、风险最低的一步：全站字体与 elevation 系统立刻统一，组件文件无需改逻辑。

**目标：** 把 Vercel/Geist 的设计令牌体系落地到 `believeboyDashboard` 前端的设计令牌层——引入 Geist 式字阶、切换为 Geist 字体、把现有 elevation 表面收敛为 Geist 式「按角色分型」的 Materials 令牌、并为颜色体系补齐语义化别名，使后续 B/C/D 阶段有统一地基。

**架构：** 全部变更集中在三处令牌源：`frontend/tailwind.config.ts`（字阶 + 字体族）、`frontend/app/globals.css`（`:root` / `.dark` 下的颜色/字体/Materials CSS 变量与工具类）、`frontend/app/layout.tsx`（字体加载切换）。现有 `.dashboard-surface` / `.dashboard-panel` / `.dashboard-glass` / `.dashboard-toolbar` 保留为「语义别名」指向新令牌，故 92 处消费者无需改动即可受益。ad-hoc `text-*` 尺寸的机械替换是**可选子任务**，可延后。

**技术栈：** Next.js 16 App Router、React 18、Tailwind CSS、shadcn/ui（Radix）、`geist`（Vercel 官方字体包，基于 `next/font`）。

**参考文档：**
- 研究结论：issue BEL-327 评论（Vercel Design / Geist 体系拆解 + 现状对照 + 优先级）
- Geist 参考：https://vercel.com/geist/typography 、/geist/colors 、/geist/materials 、/design/guidelines
- 令牌源文件：`frontend/tailwind.config.ts` 、`frontend/app/globals.css` 、`frontend/app/layout.tsx`
- 现有设计 spec 范例：`docs/superpowers/specs/2026-06-03-theme-toggle-relocation-design.md`

---

## 背景与范围

**阶段 A 包含（本计划）：**
- A1 字阶（Typography Scale）：Geist 对齐的 Tailwind `fontSize` 令牌
- A2 字体切换：Manrope + Space Grotesk → Geist Sans + Geist Mono
- A3 Materials / elevation 令牌：把现有 surface 工具类收敛为 Geist 式「按角色分型」令牌
- A4 颜色语义化别名：为现有 `--surface-*` 阶梯补齐 Geist 语义命名

**阶段 A 不含（留待 B/C/D）：** 组件 API 一致性收敛、缺口组件补件（StatusDot/Banner/Note/…）、WIG 交互规范落地、文案体系、图表可访问性。

**开放决策（review 时拍板，计划内已给默认值）：**
1. **display 字体**：默认 `--font-display` 也用 Geist Sans（全站统一）。若想保留 Space Grotesk 做标题差异化，review 时改 A2 步骤 2 的 `--font-display` 取值即可。
2. **P3 广色域**：默认**不引入** P3（`@media (color-gamut: p3)` 覆盖），因当前调色板在 sRGB 已足够且 P3 会扩大测试面。如需，作为 A4 可选追加。
3. **品牌色**：保持现有品牌蓝（hue 214）作为 accent，不改 Vercel 黑白极简。

---

## 文件结构

| 文件 | 变更 |
|------|------|
| `frontend/package.json` | `dependencies` 增加 `geist`（字体包） |
| `frontend/tailwind.config.ts` | `extend.fontFamily`（mono + sans 指向变量）、`extend.fontSize`（Geist 字阶） |
| `frontend/app/globals.css` | `:root` / `.dark` 新增 `--font-geist-mono` 引用、`--material-*` 变量与 `.material-*` 工具类；为 `--surface-*` 补语义别名；保留 `.dashboard-*` 为别名 |
| `frontend/app/layout.tsx` | 字体加载由 `next/font/google`（Manrope + Space Grotesk）改为 `geist/font/sans` + `geist/font/mono` |

**保留不动：** 所有 `components/ui/*`、`components/dashboard/*`、页面文件——本阶段不改组件逻辑，仅通过令牌层生效。

---

## 任务 0：安装 `geist` 字体包

**文件：**
- 修改：`frontend/package.json`

- [ ] **步骤 1：在 frontend 安装 geist**

  运行：
  ```bash
  cd frontend && pnpm add geist
  ```
  预期：`package.json` 的 `dependencies` 出现 `"geist": "^1.3.1"`（或最新 1.x），`pnpm-lock.yaml` 更新，无 peer 冲突（`geist` 依赖 `next` ≥13.2，当前 Next 16 满足）。

- [ ] **步骤 2：确认 import 路径**

  运行：
  ```bash
  cd frontend && node -e "console.log(require('geist/package.json').exports)"
  ```
  预期：输出含 `./font/sans` 与 `./font/mono` 两个子路径（即 `import { GeistSans } from 'geist/font/sans'` 可用）。若后续任务 2 编译报「Cannot find module 'geist/font/sans'」，回到此步确认版本与导出。

- [ ] **步骤 3：Commit**

  ```bash
  git add frontend/package.json frontend/pnpm-lock.yaml
  git commit -m "$(cat <<'EOF'
  chore(ui): 安装 geist 字体包（阶段 A 前置）

  引入 Vercel 官方 Geist Sans/Mono，供设计令牌层切换字体使用。
  EOF
  )"
  ```

---

## 任务 1：引入 Geist 对齐字阶（Tailwind `fontSize`）

**文件：**
- 修改：`frontend/tailwind.config.ts`

- [ ] **步骤 1：在 `extend` 中新增 `fontFamily` 与 `fontSize`**

  定位 `tailwind.config.ts` 第 31 行 `extend: {`，在 `colors` / `borderRadius` 之后（即 `extend` 对象内，`}` 闭合前）插入：

  ```ts
  fontFamily: {
    sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
    display: ['var(--font-display)', 'var(--font-sans)', 'ui-sans-serif', 'sans-serif'],
    mono: ['var(--font-geist-mono)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
  },
  fontSize: {
    // ── Display（hero / 大数字；保留现有 dashboard-display 语义）──
    'display': ['clamp(2.15rem, 3vw, 2.75rem)', { lineHeight: '0.96', letterSpacing: '-0.05em', fontWeight: '700' }],

    // ── Headings（页面/区块标题）──
    'heading-32': ['2rem',     { lineHeight: '1.15', letterSpacing: '-0.02em',  fontWeight: '600' }],
    'heading-24': ['1.5rem',   { lineHeight: '1.2',  letterSpacing: '-0.015em', fontWeight: '600' }],
    'heading-20': ['1.25rem',  { lineHeight: '1.25', letterSpacing: '-0.01em',  fontWeight: '600' }],
    'heading-16': ['1rem',     { lineHeight: '1.35', letterSpacing: '-0.005em', fontWeight: '600' }],
    'heading-14': ['0.875rem', { lineHeight: '1.4',  letterSpacing: '0',        fontWeight: '600' }],

    // ── Labels（单行，常与图标并列）──
    'label-16': ['1rem',     { lineHeight: '1.4', letterSpacing: '0',     fontWeight: '500' }],
    'label-14': ['0.875rem', { lineHeight: '1.4', letterSpacing: '0',     fontWeight: '500' }],
    'label-13': ['0.8125rem',{ lineHeight: '1.4', letterSpacing: '0',     fontWeight: '500' }],
    'label-12': ['0.75rem',  { lineHeight: '1.4', letterSpacing: '0.04em', fontWeight: '600' }], // CAPS 三级文字

    // ── Copy（多行正文）──
    'copy-16': ['1rem',     { lineHeight: '1.6', letterSpacing: '0', fontWeight: '400' }],
    'copy-14': ['0.875rem', { lineHeight: '1.6', letterSpacing: '0', fontWeight: '400' }],
    'copy-13': ['0.8125rem',{ lineHeight: '1.55',letterSpacing: '0', fontWeight: '400' }],
    'copy-12': ['0.75rem',  { lineHeight: '1.5', letterSpacing: '0', fontWeight: '400' }], // 密集表单元格（Geist 默认最小 13，此处为看板扩展）

    // ── Button（仅组件内按钮文字）──
    'button-16': ['1rem',     { lineHeight: '1', letterSpacing: '0', fontWeight: '500' }],
    'button-14': ['0.875rem', { lineHeight: '1', letterSpacing: '0', fontWeight: '500' }],
    'button-12': ['0.75rem',  { lineHeight: '1', letterSpacing: '0', fontWeight: '500' }],
  },
  ```

  > 单位说明：全部用 `rem`，继承现有 `html { font-size: 17px }` 的响应式缩放（≤1440→16px、≤1180→15px 等），与现状一致。`text-base`/`text-sm` 仍可用（Tailwind 默认保留），新旧并存无冲突。

- [ ] **步骤 2：确认 Tailwind 编译通过**

  运行：
  ```bash
  cd frontend && pnpm exec tailwindcss --help >/dev/null 2>&1; npx tsc --noEmit -p tsconfig.json 2>&1 | head
  ```
  预期：无 TypeScript 报错（配置为纯对象字面量，类型安全）。

- [ ] **步骤 3（可选，可延后）：扫描 ad-hoc 尺寸以渐进迁移**

  运行（仅统计，不修改）：
  ```bash
  cd frontend && grep -rEn "text-(xs|sm|base|lg|xl|2xl|\[[0-9]+px\])" app components --include="*.tsx" | wc -l
  ```
  预期：返回一个计数（当前约数百处）。**本步骤不自动替换**——机械把 `text-sm`(14.875px) 映射到 `text-copy-14` 虽等宽，但 `text-xs`(12.75px)→`copy-12`(12px) 有视觉漂移，故建议在 B 阶段按组件逐文件、配合视觉校验有意迁移。review 时若希望本阶段一并机械替换，再追加一个 codemod 任务。

- [ ] **步骤 4：Commit**

  ```bash
  git add frontend/tailwind.config.ts
  git commit -m "$(cat <<'EOF'
  feat(tokens): 引入 Geist 对齐字阶（heading/label/copy/button）

  在 tailwind.config.ts 定义系统字阶令牌，全站后续可统一引用，
  散用 text-* 尺寸的迁移留待 B 阶段逐组件进行。
  EOF
  )"
  ```

---

## 任务 2：字体切换为 Geist Sans / Mono

**文件：**
- 修改：`frontend/app/layout.tsx`
- 修改：`frontend/app/globals.css`（`--font-sans` / `--font-display` / `--font-mono`）

- [ ] **步骤 1：替换 layout.tsx 顶部字体加载**

  将 `frontend/app/layout.tsx` 第 4 行与第 13-26 行替换为：

  ```tsx
  import { GeistSans } from 'geist/font/sans'
  import { GeistMono } from 'geist/font/mono'
  ```

  并删除原 `manrope` / `spaceGrotesk` 两个 `next/font/google` 变量定义（原第 13-26 行整段）。

- [ ] **步骤 2：更新 body className 使用 Geist 变量**

  将第 35 行：
  ```tsx
  <body className={`${manrope.variable} ${spaceGrotesk.variable} min-h-screen antialiased`}>
  ```
  改为：
  ```tsx
  <body className={`${GeistSans.variable} ${GeistMono.variable} min-h-screen antialiased`}>
  ```

  > `GeistSans.variable` / `GeistMono.variable` 由包自动注入 CSS 变量名 `--font-geist-sans` / `--font-geist-mono`，无需在 `next.config` 额外配置。

- [ ] **步骤 3：在 globals.css 把 `--font-sans` / `--font-display` / `--font-mono` 指向 Geist**

  在 `app/globals.css` 的 `:root {`（第 18 行）**开头**补充字体变量定义（放在现有 `--background` 之前）：

  ```css
  :root {
    /* 字体：切换为 Geist（Sans 正文/标题，Mono 用于数字/代码） */
    --font-sans: var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif;
    --font-display: var(--font-geist-sans), var(--font-geist-mono), ui-sans-serif, system-ui, sans-serif; /* 开放决策①：保留 Space Grotesk 差异化则改回 */
    --font-mono: var(--font-geist-mono), ui-monospace, SFMono-Regular, monospace;
    /* 以下为原 :root 内容，保持不变 ↓ */
    --background: 210 28% 97%;
    ...
  ```

  > 现有 `body { font-family: var(--font-sans), sans-serif; }` 与 `h1..h4 { font-family: var(--font-display), ... }` 已引用这些变量，因此**无需改动 body/heading 规则**即生效。

- [ ] **步骤 4：确认无残留旧字体引用**

  运行：
  ```bash
  cd frontend && grep -rn "Manrope\|Space_Grotesk\|--font-manrope\|--font-space-grotesk" app/ components/ 2>/dev/null
  ```
  预期：无输出（彻底切到 Geist）。

- [ ] **步骤 5：Commit**

  ```bash
  git add frontend/app/layout.tsx frontend/app/globals.css
  git commit -m "$(cat <<'EOF'
  feat(tokens): 字体切换为 Geist Sans/Mono

  移除 Manrope + Space Grotesk，改用 Vercel 官方 Geist；
  数字/代码场景可用 font-mono + tabular-nums 对齐。
  EOF
  )"
  ```

---

## 任务 3：Materials / elevation 令牌（按角色分型）

**文件：**
- 修改：`frontend/app/globals.css`

> Geist 的 Materials 思想是「每个表面预设内建 圆角 + 填充 + 描边 + 阴影，且按 elevation 角色分型」：`base/small/medium/large`（页面内抬升）+ `tooltip/menu/modal/fullscreen`（浮层）。本任务把现有 `.dashboard-surface/.dashboard-panel/.dashboard-glass` 收敛为这套令牌，**旧类名保留为别名**，消费者零改动。

- [ ] **步骤 1：在 `:root` 定义 Material 变量**

  在 `app/globals.css` 第 92 行 `--stagger-step: 70ms;` 之后、`}` 闭合之前插入（沿用现有 `--surface-*` / `--border` / `--shadow-*` 取值，仅做「角色化」归并）：

  ```css
    /* ── Materials（Geist 式按 elevation 角色分型）──────────────────────
     * 每个 Material = 圆角 + 填充 + 描边 + 阴影 的内建组合。
     * 页面内抬升：base < small < medium < large
     * 浮层：tooltip < menu < modal < fullscreen */
    --material-base-radius: var(--radius-lg);
    --material-base-fill: hsl(var(--surface-panel));
    --material-base-stroke: hsl(var(--border) / 0.72);
    --material-base-shadow: var(--shadow-soft);

    --material-small-radius: var(--radius-lg);
    --material-small-fill: hsl(var(--surface-soft));
    --material-small-stroke: hsl(var(--border) / 0.7);
    --material-small-shadow: var(--shadow-soft);

    --material-medium-radius: var(--radius-lg);
    --material-medium-fill: hsl(var(--surface-overlay) / 0.92);
    --material-medium-stroke: hsl(var(--border) / 0.66);
    --material-medium-shadow: var(--shadow-raised);

    --material-large-radius: var(--radius-xl);
    --material-large-fill: hsl(var(--surface-overlay) / 0.96);
    --material-large-stroke: hsl(var(--border) / 0.6);
    --material-large-shadow: var(--shadow-overlay);

    --material-tooltip-radius: var(--radius-sm);
    --material-tooltip-fill: hsl(var(--surface-overlay) / 0.98);
    --material-tooltip-stroke: hsl(var(--border) / 0.5);
    --material-tooltip-shadow: var(--shadow-soft);

    --material-menu-radius: var(--radius-lg);
    --material-menu-fill: hsl(var(--surface-overlay) / 0.98);
    --material-menu-stroke: hsl(var(--border) / 0.55);
    --material-menu-shadow: var(--shadow-raised);

    --material-modal-radius: var(--radius-lg);
    --material-modal-fill: hsl(var(--surface-overlay) / 0.98);
    --material-modal-stroke: hsl(var(--border) / 0.5);
    --material-modal-shadow: var(--shadow-overlay);

    --material-fullscreen-radius: var(--radius-xl);
    --material-fullscreen-fill: hsl(var(--surface-overlay));
    --material-fullscreen-stroke: hsl(var(--border) / 0.5);
    --material-fullscreen-shadow: var(--shadow-overlay);
  ```

- [ ] **步骤 2：在 `.dark` 中镜像 Material 变量**

  在 `app/globals.css` 的 `.dark {`（第 95 行起）对应位置（在 `--stagger-step` 之后）插入相同键名、但取值对齐暗色玻璃体系：

  ```css
    /* Materials（暗色：玻璃边 + 更高不透明度保证可读）*/
    --material-base-radius: var(--radius-lg);
    --material-base-fill: hsl(var(--surface-panel));
    --material-base-stroke: hsl(var(--border) / 0.55);
    --material-base-shadow: var(--shadow-soft);

    --material-small-radius: var(--radius-lg);
    --material-small-fill: hsl(var(--surface-soft));
    --material-small-stroke: hsl(var(--border) / 0.6);
    --material-small-shadow: var(--shadow-soft);

    --material-medium-radius: var(--radius-lg);
    --material-medium-fill: hsl(var(--surface-overlay) / 0.9);
    --material-medium-stroke: hsl(var(--border) / 0.6);
    --material-medium-shadow: var(--shadow-raised);

    --material-large-radius: var(--radius-xl);
    --material-large-fill: hsl(var(--surface-overlay) / 0.94);
    --material-large-stroke: hsl(var(--border) / 0.6);
    --material-large-shadow: var(--shadow-overlay);

    --material-tooltip-radius: var(--radius-sm);
    --material-tooltip-fill: hsl(var(--surface-overlay) / 0.96);
    --material-tooltip-stroke: hsl(var(--border) / 0.5);
    --material-tooltip-shadow: var(--shadow-soft);

    --material-menu-radius: var(--radius-lg);
    --material-menu-fill: hsl(var(--surface-overlay) / 0.96);
    --material-menu-stroke: hsl(var(--border) / 0.55);
    --material-menu-shadow: var(--shadow-raised);

    --material-modal-radius: var(--radius-lg);
    --material-modal-fill: hsl(var(--surface-overlay) / 0.98);
    --material-modal-stroke: hsl(var(--border) / 0.5);
    --material-modal-shadow: var(--shadow-overlay);

    --material-fullscreen-radius: var(--radius-xl);
    --material-fullscreen-fill: hsl(var(--surface-overlay));
    --material-fullscreen-stroke: hsl(var(--border) / 0.5);
    --material-fullscreen-shadow: var(--shadow-overlay);
  ```

- [ ] **步骤 3：新增 `.material-*` 工具类**

  在 `@layer components {`（第 318 行）内、`.dashboard-surface` 定义之前插入：

  ```css
    /* ── Geist Materials 工具类（按 elevation 角色分型）────────────────── */
    .material-base {
      border-radius: var(--material-base-radius);
      background: var(--material-base-fill);
      border: 1px solid var(--material-base-stroke);
      box-shadow: var(--material-base-shadow);
    }
    .material-small {
      border-radius: var(--material-small-radius);
      background: var(--material-small-fill);
      border: 1px solid var(--material-small-stroke);
      box-shadow: var(--material-small-shadow);
    }
    .material-medium {
      border-radius: var(--material-medium-radius);
      background: var(--material-medium-fill);
      border: 1px solid var(--material-medium-stroke);
      box-shadow: var(--material-medium-shadow);
    }
    .material-large {
      border-radius: var(--material-large-radius);
      background: var(--material-large-fill);
      border: 1px solid var(--material-large-stroke);
      box-shadow: var(--material-large-shadow);
    }
    .material-tooltip { border-radius: var(--material-tooltip-radius); background: var(--material-tooltip-fill); border: 1px solid var(--material-tooltip-stroke); box-shadow: var(--material-tooltip-shadow); }
    .material-menu    { border-radius: var(--material-menu-radius);    background: var(--material-menu-fill);    border: 1px solid var(--material-menu-stroke);    box-shadow: var(--material-menu-shadow); }
    .material-modal   { border-radius: var(--material-modal-radius);   background: var(--material-modal-fill);   border: 1px solid var(--material-modal-stroke);   box-shadow: var(--material-modal-shadow); }
    .material-fullscreen { border-radius: var(--material-fullscreen-radius); background: var(--material-fullscreen-fill); border: 1px solid var(--material-fullscreen-stroke); box-shadow: var(--material-fullscreen-shadow); }
  ```

- [ ] **步骤 4：把旧 `.dashboard-*` 改为语义别名（零行为变更）**

  在 `.dashboard-surface` 等定义**之后**追加别名注释块（不删原定义，仅说明映射，便于未来 B 阶段迁移）：

  ```css
    /* 语义别名（阶段 A 仅注释，不改写消费者）：
     * .dashboard-surface → .material-base
     * .dashboard-panel    → .material-small
     * .dashboard-glass    → .material-large（浮层玻璃）
     * .dashboard-toolbar  → .material-medium
     * B 阶段将逐步把组件 className 从 .dashboard-* 切到 .material-*。 */
  ```

  > 阶段 A **不改写**任何 `.dashboard-*` 的内部实现，确保其视觉输出与现状完全一致；新 `.material-*` 类供 B/C/D 阶段的新组件直接使用。

- [ ] **步骤 5：Commit**

  ```bash
  git add frontend/app/globals.css
  git commit -m "$(cat <<'EOF'
  feat(tokens): 新增 Geist 式 Materials elevation 令牌

  在 :root/.dark 定义 material-base..fullscreen 变量与 .material-* 工具类，
  旧 .dashboard-* 保留为语义别名，消费者零改动。
  EOF
  )"
  ```

---

## 任务 4：颜色语义化别名

**文件：**
- 修改：`frontend/app/globals.css`

> Geist 把颜色按语义分工：组件底（1-3：default/hover/active）、边框（4-6）、文字（9-10）。现有 `--surface-*` 阶梯更细，本任务为其补一层「Geist 语义别名」，使后续消费可读、可对齐 P3。

- [ ] **步骤 1：在 `:root` 补语义别名（指向现有值）**

  在任务 3 的 Material 变量之后插入：

  ```css
    /* ── 颜色语义别名（对齐 Geist：组件底/边框/文字）──────────────────
     * 仅做命名映射，不改变任何取值；未来可在此层评估 P3（开放决策②）。 */
    --bg-component: hsl(var(--surface-panel));
    --bg-component-hover: hsl(var(--surface-soft));
    --bg-component-active: hsl(var(--surface-subtle));
    --border-default: hsl(var(--border) / 0.72);
    --border-hover: hsl(var(--border) / 0.85);
    --border-active: hsl(var(--border));
    --text-primary: hsl(var(--foreground));
    --text-secondary: hsl(var(--muted-foreground));
  ```

- [ ] **步骤 2：在 `.dark` 镜像同名别名**

  在 `.dark` 的 Material 变量之后插入相同键名（取值沿用暗色 `--surface-*` / `--border` / `--foreground` / `--muted-foreground`，逻辑同上，不再重复列出字面量）。

- [ ] **步骤 3：确认别名引用解析**

  运行：
  ```bash
  cd frontend && grep -n "bg-component\|border-default\|text-primary" app/globals.css | head
  ```
  预期：能看到刚才定义的三处别名（证明写入成功；此时尚无消费者，属正常）。

- [ ] **步骤 4：Commit**

  ```bash
  git add frontend/app/globals.css
  git commit -m "$(cat <<'EOF'
  feat(tokens): 为颜色体系补 Geist 语义别名

  新增 --bg-component*/--border-*/--text-* 别名映射现有 --surface-* 阶梯，
  不改任何取值，为 B/C/D 阶段消费与 P3 评估打地基。
  EOF
  )"
  ```

---

## 任务 5：构建 / Lint / 视觉验证

- [ ] **步骤 1：前端生产构建**

  运行：
  ```bash
  cd frontend && pnpm build
  ```
  预期：构建成功，无 TypeScript / 编译错误。（`geist/font/*` 必须在 `app/` 下被导入，已满足。）

  若失败：
  - `Cannot find module 'geist/font/sans'` → 回到任务 0 步骤 2 确认版本/导出
  - `--font-geist-sans is not defined` → 确认 `layout.tsx` body 用了 `GeistSans.variable`
  - 字体 fallback 闪烁 → `display: 'swap'` 已内置，正常

- [ ] **步骤 2：Lint**

  运行：
  ```bash
  cd frontend && pnpm lint
  ```
  预期：相较 main 无新增 warning/error（无未使用 import；`manrope`/`spaceGrotesk` 已删干净）。

- [ ] **步骤 3：视觉回归（人工 / 截图对比）**

  启动 `pnpm dev`，对照现状截图检查：
  - 全站字体已从 Manrope 变为 Geist Sans（标题/正文更几何、字怀更紧）
  - 数字/代码处（如有 `font-mono`）变为 Geist Mono 等宽
  - 卡片/面板/玻璃浮层视觉与切换前一致（Material 变量取值与旧 `.dashboard-*` 等价）
  - 明暗双主题下玻璃边、阴影分离仍可读

- [ ] **步骤 4：无回归 grep**

  运行：
  ```bash
  cd frontend && grep -rn "Manrope\|Space_Grotesk" app/ components/ 2>/dev/null && echo "FOUND_OLD_FONT" || echo "OK_NO_OLD_FONT"
  ```
  预期：输出 `OK_NO_OLD_FONT`。

---

## 任务 6：Commit 收尾 + PR 描述

- [ ] **步骤 1：确认 working tree 仅含本计划文件**

  运行：
  ```bash
  git status --short
  ```
  预期：仅 `frontend/package.json`、`pnpm-lock.yaml`、`tailwind.config.ts`、`app/globals.css`、`app/layout.tsx` 及本计划文档（`docs/superpowers/plans/...`）改动。

- [ ] **步骤 2：写 PR 描述（供 review）**

  新建 `docs/superpowers/plans/2026-07-16-geist-phase-a-design-tokens/2026-07-16-geist-phase-a-design-tokens-pr-description.md`，内容含：变更摘要、4 个开放决策、验证步骤、对 92 处消费者的零影响说明。

- [ ] **步骤 3：Commit 计划文档**

  ```bash
  git add docs/superpowers/plans/2026-07-16-geist-phase-a-design-tokens/
  git commit -m "docs(plans): 新增 Geist 阶段 A（设计令牌层）实现计划"
  ```

  > 按 AGENTS.md push 规则：本计划与令牌变更均不命中 `backend/`，pre-push hook 自动跳过 VPS 部署；前端经 Vercel 自动部署，review 通过后再 push。

---

## 自检报告

**1. 规格覆盖度（对照研究结论的 Phase A 范围）：**
- 字阶 → 任务 1（Geist 对齐 `fontSize`）
- 字体对齐 Geist → 任务 2（`geist` 包 + layout/globals 切换）
- Materials/elevation 按角色分型 → 任务 3（`--material-*` + `.material-*`）
- 颜色命名对齐 → 任务 4（`--bg-component*` / `--border-*` / `--text-*` 别名）
- 验证 → 任务 5（build/lint/视觉/grep）
- 全部 4 项 + 验证均有对应任务，无遗漏。

**2. 占位符扫描：** 无「TODO / 待定 / 类似任务 N / 补充细节」。每步均含命令与预期输出；任务 1 步骤 3 为「可选扫描」已明确标注可延后，非占位。

**3. 类型一致性：**
- `GeistSans.variable` / `GeistMono.variable` 由包提供，任务 0 步骤 2 已验证导出路径，任务 2 步骤 1-2 引用一致。
- `--font-geist-sans` / `--font-geist-mono` 为 `geist` 包固定注入名，任务 2 步骤 3 与任务 1 `fontFamily.mono` 引用一致。
- `--material-*` / `--bg-component*` 在 `:root` 与 `.dark` 同键同名，任务 3/4 步骤 1-2 成对出现。
- `.dashboard-*` 在任务 3 步骤 4 仅作别名注释，未改写内部实现，消费者零影响（与研究结论「不碰组件逻辑」一致）。

**4. 风险备注：** 任务 1 步骤 3 的 ad-hoc `text-*` 机械替换已显式排除在本阶段外（视觉漂移风险），改由 B 阶段逐组件有意迁移。
