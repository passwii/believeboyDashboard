# `components/brand` · BLF-1553 草稿组件

> 草稿阶段：三个文件都不接管既有 `components/login/brand-mark.tsx`，也不改 `app/icon.svg`。
> 方向确认后再决定是否把 A 提升为正式 `BrandMark`。

## 文件

| 文件 | 作用 |
| --- | --- |
| `believeboy-marks.ts` | 三个方向的 path 常量 + `believeboyMarkSvg()`（给玻璃组件用的 SVG 字符串） |
| `believeboy-mark.tsx` | `BelieveboyMark`（静态 SVG）、`BelieveboyLockup`（mark + 字标） |
| `believeboy-glass-reveal.tsx` | `BelieveboyGlassReveal`，封装上游 `GlassIconReveal`，提供 `wing-cut` / `prism` / `bare` 三档预置 |

## `BelieveboyGlassReveal` 接口

| Prop | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `variant` | `'wing-cut' \| 'prism' \| 'bare'` | `'wing-cut'` | 动效变体 |
| `mark` | `'wing' \| 'ledger' \| 'seam'` | `'wing'` | 用哪个 mark |
| `tone` | `'light' \| 'dark'` | `'light'` | 明暗预置（同时决定背景与玻璃色） |
| `background` | `string` | 预置值 | 覆盖画布底色（hex）。必须与所在表面一致，否则边缘会露色 |
| `tuning` | `Partial<GlassTuning>` | – | 覆盖预置的光学参数 |
| `label` | `string` | `'Believeboy'` | 可访问名称 |
| 其余 | `GlassIconRevealProps` 去掉 logo / 颜色 / 收束相关项 | – | `loop` / `hold` / `speed` / `time` / `className` / `onClick` 等透传 |

## 数据与状态

- **不接收任何业务数据**：只需一个方向枚举 + 明暗预设，没有 API、没有服务端状态。
- **不引入全局状态**：动效状态全部在上游引擎内部的 `requestAnimationFrame` 循环里，组件只持有 `wrapRef` 与 `engineRef`。
- 唯一的外部交互是点击重播（上游把 `onClick` 绑定到 `engine.replay()`）。草稿页另用 `key` 强制重挂来实现「换变体即重播」。
- **不要在渲染里内联传 `tuning` 字面量之外的大对象**：上游已经把 `tuning` / `logoOffset` 用 JSON 归一，
  但 `BelieveboyGlassReveal` 内部又做了一次 `JSON.stringify(tuning)` memo，两层都依赖「值不变」这个前提。

## 资产

- **不需要图片**：mark 是纯 SVG path，`logo` prop 走上游的 SVG → data URL 路径，不拉外部资源。
- **不需要图标库**：没有用 `lucide-react`，因为品牌符号不应该来自通用图标集。
- 没有使用 Unsplash 或任何远程图片；草稿页里的颜色都是品牌色，不含渐变图。

## 响应式

- 组件本身是「填满容器」的正方形画布：上游按 `min(tileSize, min(cw, ch) / 1.75)` 取 tile 尺寸，
  所以容器必须是**有明确高度**的块，否则会在 0 高度里缩没。
- 草稿页在 `900px` 以下把方向卡改成单列、动效舞台从 460 降到 380。
- 上游自带 `IntersectionObserver`（离屏暂停）与 `ResizeObserver`（尺寸变化重绘），不需要额外适配。
- **本组件不做手机端专门布局**：符合 `design-spec.md` §0.4.2 的桌面范围约定。若要进手机端，
  需要单独决定 tile 尺寸与点击重播的触控反馈。

## WebGL2 回退

- 上游在没有 WebGL2 时自动退化：`startEngine` 返回 null → `fallback` state → 用 CSS `mask-image` 渲染静态 mark。
- 该回退也在 `prefers-reduced-motion` 之外独立工作：reduced-motion 时上游会停在「玻璃还在」的一帧，而不是走回退。
- 草稿页在 SwiftShader 下的 Chromium 实测：1 个 canvas、0 个 console error。

## 合适的使用位置

| 位置 | 建议 | 原因 |
| --- | --- | --- |
| 登录页页顶 | 用 `wing-cut`，但要重新评估它与 `Auth` 表单的抢注意力 | 现有登录页是 V3/独立视觉区，动效会让页顶变成视觉主角 |
| 品牌落地页 / 关于页 | ✓ 最合适 | 用户会停下来看完整段动效 |
| Warm Ledger 侧栏 | ✗ | 侧栏是工作区导航，动效每秒重播会干扰 |
| favicon / PWA | ✗ | 静态图标，不需要动效 |
| 空状态 / 首次进入 | 可选 | 只在首次会话播放一次，需要 `loop={false}` |

## 接入事实核对（任务里要求回答的部分）

### 项目是否已经是 shadcn 结构

是。`frontend/components.json` 已经存在并指向：

| 键 | 值 |
| --- | --- |
| `tailwind.config` | `tailwind.config.ts` |
| `tailwind.css` | `app/globals.css` |
| `aliases.components` | `@/components` |
| `aliases.ui` | `@/components/ui` |
| `aliases.utils` | `@/lib/utils` |
| `rsc` / `tsx` | `true` / `true` |

所以 **`@/components/ui` 就是项目默认的 shadcn 组件目录**，不需要解释「为什么新建这个目录」——
`components/ui/` 下已有 50+ 个组件（`button.tsx`、`dialog.tsx`、`data-card.tsx` …）。
组件按原样落在 `components/ui/liquid-glass-logo-reveal.tsx`，导入路径 `@/components/ui/liquid-glass-logo-reveal`
与 `demo` 的写法一致，无需改别名、无需新建 `src/` 目录。

Tailwind（3.4）与 TypeScript（5.7，`strict: true`，`moduleResolution: "bundler"`）都在 `package.json` 里，
因此**不需要**执行 `shadcn init`、装 Tailwind 或配 `tsconfig`。

### 依赖与路径别名

- 组件只依赖 `react` + `@/lib/utils` 的 `cn`（`clsx` + `tailwind-merge`，已装）。
- **没有第三方动画库**：没有 `requestAnimationFrame` 之外的调度器，没有 gsap / framer-motion / three.js。
- `@/lib/utils` 与 `@/components/ui` 两个别名都在 `tsconfig.json` 的 `paths` 与 `components.json` 的 `aliases` 里，
  与 `vitest.config.ts` 的 `@` 别名一致。

### 对上游源文件做了哪些改动（4 处，均为接入所需）

上游附件 `liquid-glass-logo-reveal.tsx` 是一个「单文件 demo」，直接落进仓库会有两个真实问题：

1. **`GlassIconReveal` / `GlassIconRevealProps` / `GlassTuning` 没有 `export`** —— 上游只导出
   `GlassReveal21st`（一个写死 21st.dev 标记的包装）。不导出就无法把 Believeboy 的 mark 喂进去。→ 改为 `export`。
2. **`startEngine` 的参数类型是 `React.RefObject<T>`** —— 本仓库是 React 18 + `@types/react 18.3`，
   该类型是**只读**的（`current` 不可写），而 `live.current = …` 每帧都在写。上游是按 React 19 类型写的。
   `tsc --noEmit` 在这里报 3 个 `Property 'settings' does not exist on type … | null`。→ 改为 `React.MutableRefObject<T>`。

其余（着色器、SDF、弹簧时间线、WebGL2 引擎、reduced-motion 处理、WebGL2 回退）**一行未改**。
这两处改动也用 `git diff` 可核对：只有 `interface` → `export interface`、`function` → `export function`、
`RefObject` → `MutableRefObject`。

### 组件接收的 props（已在上面表格列出，这里按任务问法再答一遍）

1. **数据 props**：没有业务数据。只有 `logo`（SVG 标记字符串或图片 URL）、明暗与颜色、尺寸/缩放、
   `loop` / `hold` / `speed` / `time`、`tuning`、`label`。
2. **状态管理**：不需要外部状态。引擎内部持有 `time` / `playing` / `pauseLeft` / `outro`，
   React 侧只有 `fallback`（WebGL2 缺失）与 `engineRef`。草稿页的「换变体」用 React `key` 强制重挂，
   不需要 store。
3. **额外资产**：不需要图片；mark 是纯 SVG path。没有用 Unsplash（不缺位图），也没有用 `lucide-react`
   （品牌符号不应来自通用图标集）。
4. **响应式**：组件填满容器，按 `min(tileSize, min(cw, ch) / 1.75)` 缩放；容器必须有明确高度。
   上游自带 `ResizeObserver`（尺寸变化重绘）与 `IntersectionObserver`（离屏暂停）。
   本组件不做手机端专门适配，符合 `design-spec.md` §0.4.2 的桌面范围。
5. **最合适的位置**：品牌落地页 / 关于页；登录页页顶需重新评估注意力分配；**不适合**侧栏、favicon、PWA 图标。

### WebGL2 回退与 reduced-motion（实测）

| 场景 | 行为 |
| --- | --- |
| 有 WebGL2 | 完整玻璃动效（SwiftShader 下实测 1 canvas / 0 console error） |
| 无 WebGL2 | `startEngine` 返回 null → `fallback` state → CSS `mask-image` 静态 mark |
| `prefers-reduced-motion: reduce` | 停在 `time = 1.4s` 的一帧（玻璃还在），不播放循环 |
| 离屏 / 切换标签页 | `IntersectionObserver` / `document.hidden` 暂停 `requestAnimationFrame` |

### 草稿 HTML 的构建方式

`frontend/artifacts/blf-1553/`：

| 文件 | 作用 |
| --- | --- |
| `believeboy-logo-draft.html` | **交付物**：单文件、离线可开、无网络请求（字体已 base64 内嵌） |
| `draft/entry.tsx`、`draft/draft.css`、`draft/index.html` | 草稿页源码（可重新构建） |
| `draft/dist/draft.js` | Vite 打包的真实组件（`BelieveboyGlassReveal` + `BelieveboyMark`） |
| `vite-draft.mjs` | 构建脚本：`node artifacts/blf-1553/vite-draft.mjs` |
| `make-standalone.mjs` | 合成单文件：`node artifacts/blf-1553/make-standalone.mjs` |

草稿页**没有**用 mock 或静态图伪造动效 —— 它跑的就是仓库里的真实组件，只是把 Tailwind 依赖的
定位类（`relative` / `isolate` / `overflow-hidden`）在 `draft.css` 里补齐，因为独立单页不加载 Tailwind。
