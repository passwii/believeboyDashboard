# transitions.dev motion 体系全量替换（v2）

> **创建时间：** 2026-10-16
> **状态：** ✅ Phase 0-3 已实施并验证（2026-10-16）。决策 4 项全部采纳推荐值；验证证据见 §8，实施记录见 §9。
> **前置 v1：** [`2026-07-11-frontend-motion-system/`](../2026-07-11-frontend-motion-system/index.md)（自研 motion 体系，已上线）
> **v1 遗留调研：** [`2026-07-11-frontend-motion-system-v2-token-recommendations.md`](../2026-07-11-frontend-motion-system/2026-07-11-frontend-motion-system-v2-token-recommendations.md)

---

## 1. 目标

用 [transitions.dev](https://transitions.dev) 的 **motion token 尺度**整体替换 v1 自研的 `--motion-*` 体系，成为项目唯一的动效真相源。

**范围（in scope）**

- `_root.css` 的 `:root` 全量导入（239 个变量：7 档 duration + 6 档 easing + distance/scale/blur + 35 个 transition 的语义变量）
- 旧 `--motion-*` / `--stagger-step` 全部删除，消费点按 **usage 对齐** 重映射到新 token
- `lib/motion/tokens.ts` 按新尺度重写（JS 镜像）
- `docs/motion-system.md` 重写；`docs/design-spec.md` 引用同步
- `tokens.test.ts` 数值断言更新

**不在本 plan（Phase B，另开）**

- 35 个 transition snippet 逐个落地（`.t-modal` / `.t-dropdown` / `.t-toast` … 替换现有 Radix wrapper 的 ad-hoc 动效）
- `framer-motion` 路由过渡改 `page-side-by-side` snippet

---

## 2. 现状盘点（已核）

| 项 | 数量 | 位置 |
| --- | --- | --- |
| 旧 token 定义 | 7 | `frontend/app/globals.css:104-112` |
| `globals.css` 消费点 | 28 | `:root` 外，含 `.ui-overlay-motion` / `.ui-floating-motion` / `.u-*` 工具类 / keyframes |
| JS token 定义 | 5 组 | `frontend/lib/motion/tokens.ts` |
| JS 消费点 | 8 | PageTransition ×2、goal-progress-rings ×4、notification-toast ×1、tokens.test ×多 |
| 组件内 Tailwind 任意值 | 7 文件 | `sheet / switch / tabs / tooltip / select / checkbox / ai-chat-window` |
| 文档引用 | 21 | `docs/motion-system.md` ×17、`docs/design-spec.md` ×4 |
| 硬编码 easing 字面量 | 6 文件 | `tab-motion.tsx`、`metric-switcher-card.tsx`、`tailwind.config.ts`、`animation-styles.ts`、`ray-background.tsx`、`globals.css:469` |

**关键前置结论：变量名零碰撞。** 对 `_root.css` 的 239 个变量名与项目现有 201 个 CSS 变量名取交集 = 空集，导入不会静默覆盖任何现有 token。

---

## 3. 目标 token 体系

```css
/* 时长（7 档，usage 语义） */
--duration-stagger: 40ms;   /* per-item stagger */
--duration-micro: 80ms;     /* tooltip/path delay、shake 分段 */
--duration-quick: 150ms;    /* modal/dropdown close、text swap、tooltip appear */
--duration-fast: 250ms;     /* icon swap、dropdown/modal open、tabs sliding、page slide */
--duration-medium: 350ms;   /* panel close、toast close */
--duration-slow: 400ms;     /* panel open、skeleton content reveal、input clear */
--duration-very-slow: 500ms;/* emphasis、badge appear、text reveal、success check */

/* 缓动（6 档） */
--ease-smooth-out: cubic-bezier(0.22, 1, 0.36, 1);
--ease-in-out: ease-in-out;
--ease-out: ease-out;
--ease-linear: linear;
--ease-bounce: cubic-bezier(0.34, 1.36, 0.64, 1);
--ease-bounce-strong: cubic-bezier(0.34, 3.85, 0.64, 1);

/* 距离 / 缩放 / 模糊（新增词汇，v1 无对应） */
--distance-micro|small|base|medium|large = 4|6|8|12|30px
--scale-large|medium|small|tiny = 0.96|0.97|0.98|0.99
--blur-small|medium|large = 2|3|8px
```

**映射原则（来自 skill 的 `transitions refine` 规则）：按 usage 匹配，不按数值就近。** 例：`--motion-base`(240ms) 用在 overlay 打开 → 映射 `--duration-fast`(250ms)，即使数值更接近 350ms。

---

## 4. 映射表（旧 → 新）

### 4.1 基础三档 + 缓动

| 旧 token | 值 | 新 token | 值 | 依据 |
| --- | --- | --- | --- | --- |
| `--motion-fast` | 180ms | `--duration-quick` ⚠️决策1 | 150ms | hover/focus 微状态，落在 200ms 感知阈值内 |
| `--motion-base` | 240ms | 分两路：overlay/dialog open → `--duration-fast`(250ms)；内容淡入 → `--duration-slow`(400ms) ⚠️决策4 | | usage 拆分 |
| `--motion-slow` | 320ms | sheet/panel close → `--duration-medium`(350ms) | | panel close 用法 |
| `--motion-ease-out` | `0.22,1,0.36,1` | `--ease-smooth-out` | 同值 | 完全等价 |
| `--motion-ease-standard` | `0.16,1,0.3,1` | `--ease-smooth-out` ⚠️决策2 | `0.22,1,0.36,1` | 新尺度无 0.16 曲线 |
| `--motion-spring-press` | `220ms cubic-bezier(0.34,1.56,0.64,1)` | 拆为 `--duration-fast` + `--ease-bounce` ⚠️决策3 | 250ms + `0.34,1.36,0.64,1` | 复合 shorthand 无法单 token 表达 |
| `--stagger-step` | 70ms | `--duration-stagger` | 40ms | per-item stagger 用法 |

### 4.2 `globals.css` 消费点（28 处）

| 行 | 选择器 / 用法 | 旧 | 新 |
| --- | --- | --- | --- |
| 469 | `theme-mode-icon-change`（icon 切换） | `180ms cubic-bezier(.22,1,.36,1)` 字面量 | `var(--duration-quick) var(--ease-smooth-out)` |
| 500-501 | `.ui-overlay-motion`（backdrop 打开） | `--motion-base` + `--motion-ease-out` | `--duration-fast` + `--ease-smooth-out` |
| 506 | `.ui-overlay-motion[data-state=closed]` | `--motion-fast` | `--duration-quick` |
| 518-527 | `.ui-floating-motion`（Select/Popover 打开/关闭） | `280ms cubic-bezier(.34,1.56,.64,1)` / `--motion-fast` + `--motion-ease-standard` | open：`--duration-fast` + `--ease-smooth-out`；close：`--duration-quick` + `--ease-smooth-out` |
| 566 | `.sidebar-panel-reveal`（panel open） | `0.32s --motion-ease-out` | `var(--duration-slow) var(--ease-smooth-out)` |
| 650-654 | `.u-interactive` hover/focus | `--motion-fast` + `--motion-ease-out` | `--duration-quick` + `--ease-smooth-out` |
| 662 | `.u-press` 按压回弹 | `transform var(--motion-spring-press)` | `transform var(--duration-fast) var(--ease-bounce)` |
| 787 | `animation: enter …` | `--motion-base` + `--motion-ease-standard` | `--duration-medium` + `--ease-smooth-out` |
| 791 | `float 4.2s`（装饰） | `--motion-ease-standard` | `--ease-smooth-out`（时长字面量保留） |
| 795-798 / 813-816 / 832-835 / 847-850 / 949-952 / 960 / 968 | `.hover-lift` / `.conversation-item` / 按钮 hover 等微状态 | `--motion-fast` ×2 | `--duration-quick` + `--ease-smooth-out` |
| 862 | `transition: transform` | `--motion-base` + `--motion-ease-out` | `--duration-fast` + `--ease-smooth-out` |
| 989 / 995 / 1146 | `.u-stagger-item` / `.animate-fade-slide-up`（内容入场） | `--motion-base` + `--motion-ease-out` | `--duration-slow` + `--ease-smooth-out` ⚠️决策4 |
| 990 | `.u-stagger-item` delay | `--stagger-step` | `--duration-stagger` |
| 1009-1011 | 进度条 width / opacity | `--motion-base` / `--motion-fast` | `--duration-fast` / `--duration-quick` |
| 1022 | `global-loading-slide 1.15s`（循环） | `--motion-ease-standard` | `--ease-linear` |
| 1038 | `shimmer 1.5s`（循环） | `--motion-ease-standard` | `--ease-linear` |
| 1161 / 1176 | 滚动按钮 enter / exit | `0.2s --motion-ease-out` / `0.15s ease-in` | `--duration-quick` + `--ease-smooth-out` |
| 1231 / 1245 / 1250 / 1273 / 1277 | login 装饰动画 8s / 9s | `--motion-ease-standard` | `--ease-smooth-out`（时长保留） |
| 1439 | `.term-subnav` 宽度过渡 | `--subnav-duration/--subnav-ease` 默认值 | `var(--duration-fast)` + `var(--ease-smooth-out)` |

**不映射（保留字面量，标注为 no matching token usage）**：`4.2s`/`2s`/`1.5s`/`2.4s`/`1.2s`/`9s`/`8s` 等装饰循环时长、`0.8s`/`0.6s`/`1.2s`/`0.5s` chat 启动动画（`components/chat/constants/animation-styles.ts`）、`ray-background.tsx` 的 `top 0.8s`。

### 4.3 组件内 Tailwind 任意值

| 文件 | 旧 | 新 |
| --- | --- | --- |
| `components/ui/sheet.tsx` ×4 | `duration-[var(--motion-slow)]` | `duration-[var(--duration-medium)]`（panel close 350ms） |
| `components/ui/switch.tsx` | `duration-[var(--motion-fast)] ease-[var(--motion-ease-out)]` | `duration-[var(--duration-quick)] ease-[var(--ease-smooth-out)]` |
| `components/ui/switch.tsx` thumb | `[transition:transform_var(--motion-spring-press)]` | `[transition:transform_var(--duration-fast)_var(--ease-bounce)]` |
| `components/ui/tabs.tsx` base | `[transition-duration:var(--motion-fast)]` + `--motion-ease-out` | `--duration-quick` + `--ease-smooth-out` |
| `components/ui/tabs.tsx` active | `[transition-duration:var(--motion-base)]` | `[transition-duration:var(--duration-fast)]`（tabs sliding 250ms） |
| `components/ui/tooltip.tsx` | `duration-[var(--motion-fast)]` | `--duration-quick`（tooltip appear） |
| `components/ui/select.tsx` | `duration-[var(--motion-fast)] ease-[var(--motion-ease-out)]` | `--duration-quick` + `--ease-smooth-out` |
| `components/ui/checkbox.tsx` | `duration-[var(--motion-fast)] ease-[var(--motion-ease-out)]` | `--duration-quick` + `--ease-smooth-out` |
| `components/chat/ai-chat-window.tsx` ×3 | `0.35s var(--motion-ease-standard)` | `var(--duration-medium) var(--ease-smooth-out)` |
| `tailwind.config.ts` | `collapsible-down 260ms cubic-bezier(.22,1,.36,1)` | `collapsible-down var(--duration-fast) var(--ease-smooth-out)` |
| `tailwind.config.ts` | `popup-in 260ms ease-out` | `popup-in var(--duration-fast) var(--ease-smooth-out)` |
| `components/dashboard/metric-switcher-card.tsx` | `MOTION_EASE_OUT = [0.22,1,0.36,1]` 常量 | 改 import `EASE.smoothOut` |
| `components/ui/tab-motion.tsx` | `duration: 0.2` / `0.18` + `[0.22,1,0.36,1]` | `DURATION.fast` / `DURATION.quick` + `EASE.smoothOut` |
| `components/terminal/terminal-constants.ts` | `TERMINAL_SUBNAV_MOTION` 260ms / `0.16,1,0.3,1` | 260 → 250（`--duration-fast` 语义对齐）、ease → `0.22,1,0.36,1`；`fadeInMs 180 → 150`、`fadeOutMs 120 → 80`、`staggerStepMs 40`（已对齐） |

### 4.4 JS 侧 `tokens.ts` 重写

```ts
export const DURATION = {
  stagger: 0.04, micro: 0.08, quick: 0.15, fast: 0.25,
  medium: 0.35, slow: 0.4, verySlow: 0.5,
} as const

export const EASE = {
  smoothOut: [0.22, 1, 0.36, 1] as const,
  inOut: 'ease-in-out', out: 'ease-out', linear: 'linear',
  bounce: [0.34, 1.36, 0.64, 1] as const,
  bounceStrong: [0.34, 3.85, 0.64, 1] as const,
} as const

export const DISTANCE = { micro: 4, small: 6, base: 8, medium: 12, large: 30 } as const
export const SCALE = { large: 0.96, medium: 0.97, small: 0.98, tiny: 0.99 } as const
export const BLUR = { small: 2, medium: 3, large: 8 } as const

/** framer-motion spring 物理（CSS 无法表达，保留 JS-only） */
export const SPRING = { page: { type: 'spring', stiffness: 260, damping: 30, mass: 1 } } as const

/** v2 调研建议 3 已采纳：step/childDelay 合并为单档 */
export const STAGGER = { step: 0.04 } as const

export const isReducedMotionDefault = false
```

**JS 消费点重映射（8 处）**

| 位置 | 旧 | 新 |
| --- | --- | --- |
| `NormalPageTransition` / `FullBleedPageTransition` | `DURATION.base` + `EASE.out` | `DURATION.fast` + `EASE.smoothOut`（page slide 250ms） |
| `notification-toast.tsx:62` | `DURATION.springPress` + `'easeOut'` | `DURATION.medium` + `EASE.smoothOut`（toast open 350ms） |
| `goal-progress-rings.tsx:333` | `DURATION.slow` + `EASE.out` | `DURATION.slow` + `EASE.smoothOut` |
| `goal-progress-rings.tsx:356` | `DURATION.fast` + `EASE.out` | `DURATION.quick` + `EASE.smoothOut` |
| `goal-progress-rings.tsx:155 / 247` | `EASE.out` | `EASE.smoothOut`（字面量时长保留，属 donut/stroke draw） |

**破坏性变更**：`DURATION.base` / `DURATION.slow` 语义重定义（`slow` 0.32→0.4）、`STAGGER.childDelay` 删除、`EASE.out` → `EASE.smoothOut`。已核无外部（packages / 后端 / windows）消费者，仅 frontend。

---

## 5. 决策项（✅ 已按推荐值全部采纳）

> **用户确认（2026-10-16）：全部按推荐值开工。** 落地结果：
> ① hover/focus → `--duration-quick`(150ms)　② `--motion-ease-standard` → `--ease-smooth-out`
> ③ `--motion-spring-press` → `--duration-fast` + `--ease-bounce`　④ overlay/dialog 打开 → `--duration-fast`(250ms)；内容入场 → `--duration-slow`(400ms)

| # | 决策 | 推荐 | 备选 | 影响 |
| --- | --- | --- | --- | --- |
| 1 | hover/focus 微状态落哪档？（29 处消费者） | `--duration-quick` 150ms | `--duration-micro` 80ms（更快但可能显跳）；或保留项目自有 micro 档 → 破坏「整套」 | 全站 hover 手感 |
| 2 | `--motion-ease-standard`(0.16,1,0.3,1) 无对应 | 统一并入 `--ease-smooth-out` | 并入 `--ease-in-out`（更线性） | 14 处曲线微变 |
| 3 | `--motion-spring-press` 复合 shorthand | 拆 `--duration-fast` + `--ease-bounce`（220→250ms，1.56→1.36） | 拆 `--duration-quick` + `--ease-bounce`（更脆） | `.u-press` / switch thumb 回弹 |
| 4 | 内容淡入（`.animate-fade-slide-up` / overlay） | overlay open → `--duration-fast` 250ms；内容入场 → `--duration-slow` 400ms | 内容入场用 `--duration-medium` 350ms 折中 | **视觉变化最大项**：240→400ms |

---

## 6. 实施步骤

### Phase 0：变量层（`globals.css`）
1. `:root` 删除 7 个旧 token（L104-112）
2. 粘贴 `_root.css` 全量 `:root` 块（含 35 个 transition 语义变量）到 `:root` 尾部，加分隔注释标注来源与 license
3. 按 §4.2 重映射 28 处消费点
4. `pnpm lint` + 全量 `pnpm test`

### Phase 1：JS 镜像（`lib/motion/tokens.ts`）
1. 按 §4.4 重写 + 更新顶部对照表注释
2. 按 §4.4 重映射 3 个组件消费点
3. `tokens.test.ts` 数值断言更新（新增 stagger/micro/verySlow、EASE 全档、DISTANCE/SCALE/BLUR）
4. `vitest run lib/motion frontend/components/motion frontend/components/notifications`
5. `pnpm build`（TS 类型破坏面检查）

### Phase 2：组件任意值 + Tailwind config
按 §4.3 逐文件替换；`vitest run <该目录>`

### Phase 3：文档
1. `docs/motion-system.md` 重写：Token 表换新尺度、加「来源：transitions.dev _root.css」与 license 提示、§2.3 双侧同步纪律更新、删旧数值
2. `docs/design-spec.md` 2 处引用同步
3. `frontend/docs/motion-system.md` 与 `lib/motion/tokens.ts` 注释保持同源

### Phase 4：验证
- 全量 `pnpm test`（T3：共享 token，走全量 + 失败集对账）
- `pnpm lint`
- 手动核对：modal/sheet、dropdown/select、tooltip、tabs、hover 微状态、内容入场、toast、reduced-motion 降级
- `pnpm build` 交 Vercel

---

## 7. 风险

| 风险 | 等级 | 缓解 |
| --- | --- | --- |
| 决策 4 让内容入场 240→400ms，全站观感变慢 | 中 | 先在 1 个页面比对（dashboard），确认后再全量 |
| `_root.css` 含 light-theme 颜色 token（`--shimmer-base` / `--tabs-*` / `--tt-bg` / `--like-color` / `--matrix-*`）与项目暗色冲突 | 中 | Phase 0 只导入，不消费；Phase B 接入 snippet 时补 `html[data-theme='dark']` / `.dark` override |
| 变量名零碰撞已核，但 `--scale-*` / `--blur-*` / `--distance-*` 语义泛化，未来易与设计 token 混淆 | 低 | 文档标注「transitions.dev 命名空间」，新增 token 前先查 |
| 旧 `--motion-*` 若在 E2E / Playwright 断言中被引用 | 低 | 已 grep：无测试引用旧 token 名（仅 `terminal-subnav.test.tsx` 引用自有常量） |
| `TERMINAL_SUBNAV_MOTION` 是第二套 mini 体系，改它触及 BLF-825/832 行为 | 中 | 单独 commit；跑 `components/terminal` 目标集 |

---

## 8. 验证清单（DoD）— ✅ 全部通过

| # | 验证项 | 结果 |
| --- | --- | --- |
| 1 | 旧 token 残留（`--motion-*` / `--stagger-step`） | ✅ `frontend/**` 0 命中（`globals.css` 内部 0；仅 `docs/superpowers/plans/2026-07-11-*` 历史 plan 原文保留） |
| 2 | 旧 JS key 残留（`DURATION.base` / `EASE.out` / `STAGGER.childDelay` / `springPress`） | ✅ 0 命中 |
| 3 | `pnpm test` 全量 | ✅ **243 文件 / 1825 例通过，52.8s** |
| 4 | `pnpm lint` | ✅ exit 0，0 error（27 warning 为既有 `react-hooks/exhaustive-deps`，均不在本次改动文件） |
| 5 | 项目 tsc（读 `frontend/tsconfig.json`，`moduleResolution: bundler`） | ✅ 本次改动文件 **0 诊断**（全仓 57 处基线错误集中在 `lib/crm/*`、`app/dashboard/*` 等未触碰文件） |
| 6 | Tailwind CSS 编译（`npx tailwindcss -i app/globals.css`） | ✅ 编译成功（288,962 B），新 var 类均已生成（`duration-medium` 3 / `duration-quick` 14 / `duration-fast` 9 / `ease-smooth-out` 24） |
| 7 | `globals.css` 结构完整性 | ✅ 花括号 280/280 平衡；`prefers-reduced-motion` 守卫 11 处未破坏 |
| 8 | `docs/motion-system.md` / `docs/design-spec.md` / `docs/FRONTEND-DESIGN-SPEC.md` | ✅ 旧 token 名 0 残留 |

> `_root.css` 全量导入的 35 个 transition 语义变量当前**无消费点**，属 Phase B 预留；变量名与项目现有 201 个 CSS 变量零碰撞（已核）。

---

## 9. 实施记录（2026-10-16）

### 变更文件（22 个）

| 层 | 文件 | 变更 |
| --- | --- | --- |
| Token 定义 | `frontend/app/globals.css` | 旧 7 token → `_root.css` 全量 `:root`（239 变量，:root 行 104-396） |
| CSS 消费 | `frontend/app/globals.css` | 28 处按 usage 重映射（overlay / floating / `u-*` / keyframes / subnav 默认值） |
| JS 镜像 | `frontend/lib/motion/tokens.ts` | 重写为 7 档 `DURATION` + 6 档 `EASE` + `DISTANCE` / `SCALE` / `BLUR`；`STAGGER` 单档 |
| JS 镜像测试 | `frontend/lib/motion/tokens.test.ts` | 数值断言重写（7 例） |
| JS 消费 | `components/motion/{Normal,FullBleed}PageTransition.tsx` | `DURATION.base`+`EASE.out` → `DURATION.fast`+`EASE.smoothOut` |
| JS 消费 | `components/notifications/notification-toast.tsx` | `springPress`+`'easeOut'` → `DURATION.medium`+`EASE.smoothOut` |
| JS 消费 | `components/ui/goal-progress-rings.tsx` | `EASE.out` ×4 → `EASE.smoothOut`；入口时长 → `DURATION.quick` |
| JS 消费 | `components/ui/tab-motion.tsx` | 字面量 `0.2` / `0.18` / `[0.22,1,0.36,1]` → tokens |
| JS 消费 | `components/dashboard/metric-switcher-card.tsx` | 删除本地 `MOTION_EASE_OUT`，改 import `DURATION`/`EASE` |
| 组件任意值 | `components/ui/{sheet,switch,tabs,tooltip,select,checkbox}.tsx` | Radix wrapper 任意值 → 新 token（sheet close → `--duration-medium`；switch thumb → `--duration-fast`+`--ease-bounce`） |
| 组件任意值 | `components/chat/ai-chat-window.tsx`、`ray-background.tsx`、`constants/animation-styles.ts` | 0.35s → `--duration-medium`；`--motion-ease-standard/out` → `--ease-smooth-out` |
| Tailwind | `frontend/tailwind.config.ts` | `collapsible-down` / `popup-in` 260ms → `var(--duration-fast) var(--ease-smooth-out)` |
| 第二套体系 | `components/terminal/terminal-constants.ts` | `TERMINAL_SUBNAV_MOTION` 260→250ms、ease→smoothOut、fadeIn 180→150、fadeOut 120→80 |
| 文档 | `frontend/docs/motion-system.md`、`frontend/docs/design-spec.md`、`docs/FRONTEND-DESIGN-SPEC.md` | 重写 §2 token 表 + §7 v2 说明；引用改名 |

### 未映射豁免（有意保留字面量，属 "no matching token usage"）

- 装饰性循环时长：`float 4.2s/3s`、`login-domain-* 8s`、`login-grid-scan 9s`、`shimmer 2s`、`de-shimmer 2s`、`office-*` 系列
- chat 启动动画时长：`bb-fade-up 0.8s` / `bb-scale-in 0.6s` / `bb-arcs-entrance 1.2s` / `bb-chat-enter 0.5s`（仅换主曲线）
- `ray-background` 的 `top 0.8s`、`ai-chat-window` 的 `top/bottom 0.6s`
- ring/stroke-draw 时长（`1.1s` / `0.8s`）——属 donut chart 场景，Phase B 接入 `35-donut-chart` 语义变量时再处理
- `keyframes` 内的位移字面量（`translateY(8px)` 等）未改用 `--distance-*`：本 plan 范围仅覆盖 token 改名，新增的 `--distance-*` / `--scale-*` / `--blur-*` 词汇留待 Phase B 消费

## 10. 遗留发现（供后续决策，不在本次范围）

1. **`tailwind.config.ts` 的 `collapsible-down` 是死配置**：`grep -rn "animate-collapsible" frontend` 0 命中（keyframes + animation 都已定义但无消费）。本次仅同步其数值，未删除。
2. **pi-lens LSP 对本仓库的 TS 诊断不可信（环境问题，非本次改动引入）**：`lens_diagnostics(source=lsp)` 在本次改动文件上报 `Cannot find module 'vitest' / 'framer-motion' / 'lucide-react' / '@radix-ui/*'`，但：
   - 未经改动的 `lib/motion/routes.test.ts`、`components/terminal/terminal-subnav.test.tsx` 报**完全相同**的错误 → 与本次改动无关
   - `node -e "require.resolve('vitest', {paths:['…/frontend']})"` 解析成功
   - 项目 tsc（`moduleResolution: bundler`）对这些文件 **0 诊断**；用 `--moduleResolution node10` 才能复现同类错误 → LSP 未应用 `frontend/tsconfig.json`
   - `npx vitest run lib/motion/tokens.test.ts` → **7/7 通过**
   - `effective_config` 显示该文件 `0 config file(s)`，且 `typescript` 与 `deno` 两个语言服务器同时 selected（本机未安装 `deno`）
   → 结论：harness 侧 LSP 的既有状态，无法从仓库文件侧修复；**不要**为消除它而改代码（会掩盖后续真实诊断）。
3. **`--duration-very-slow`(500ms) / `--duration-micro`(80ms) / `--ease-bounce-strong` / `--distance-*` / `--scale-*` / `--blur-*` 目前无消费点**，属新尺度带来的可用词汇，Phase B 接入 snippet 时自然落地。

## 11. Phase B 进度（transitions.dev snippet 接入）

**机制适配约定（B 批统一口径）**：snippet 原版是 vanilla DOM 机制（JS 切 `.is-open` / `.is-closing` 类）。
本仓库是 Radix/React：open 即挂载、close 保留节点至动画结束（`data-state='open'|'closed'`），
enter 没有「先渲染在起点、再切类」的机会 → **enter / exit 都走 keyframe**（与仓库既有机制一致），
但**时长 / 缓动 / 缩放 / 位移 / 模糊一律读 snippet 的语义变量**（`--modal-*` / `--dropdown-*` /
`--tt-*` / `--panel-*` / `--toast-*` …），即接入的是 transitions.dev 的**调参与手感**，机制按 React 状态模型落地。
snippet 外的历史自定义（如旧 `dialog-in` 的 60% `scale(1.012)` 过冲）不保留。

| # | 面 | snippet | 状态 |
| --- | --- | --- | --- |
| B1 | dialog + alert-dialog | 06-modal | ✅ `.ui-modal-motion` + `@keyframes ui-modal-in/out`；旧 340ms ease-out / 200ms cubic-bezier(0.4,0,1,1) → `--modal-open-dur` 250ms / `--modal-close-dur` 150ms / `--modal-ease`；删 tailwind 死配置 `dialog-in` / `dialog-out` |
| B2 | select + popover + dropdown-menu | 05-menu-dropdown | ✅ `.ui-floating-motion` 改 keyframe 驱动，读 `--dropdown-open-dur` 250ms / `--dropdown-close-dur` 150ms / `--dropdown-pre-scale` 0.97 / `--dropdown-closing-scale` 0.99 / `--dropdown-ease`；原 `translate3d(0,±0.5rem)` 方向位移与 `popup-in` 过冲不保留；`dropdown-menu.tsx` 去掉 tailwind-animate 的 closed 类 |
| B3 | tooltip | 17-tooltip | ✅ `.ui-tooltip-motion` 读 `--tt-in-dur` 150ms / `--tt-out-dur` 50ms / `--tt-scale` 0.98 / `--tt-delay` 80ms（延迟只挂 show 侧）/ `--tt-in-ease` / `--tt-out-ease`。**未接入** snippet 的「整组共用气泡随指针平移（`--tt-move-*`）」机制——那套依赖 snippet 自带的绝对定位 + 宽度测量 JS，会退掉 Radix 的定位/翻面/aria |
| B4 | sheet | 07-panel-reveal | ✅ `.ui-panel-motion` 读 `--panel-open-dur` 400ms / `--panel-close-dur` 350ms / `--panel-blur` 2px / `--panel-ease`；位移方向按 `data-side` 泛化成 `translate(tx,ty)`（sheet 必须整屏位移，不用 snippet 的 `--panel-translate-y` 固定行程）；旧方向性过冲不保留。**过程中发现并修掉真 bug**：`SheetContent` 从未输出 `data-side`，方向选择器会失效 → 补 `data-side={side}` + 新增契约回归测试（`components/ui/sheet.test.tsx`） |
| B5 | toast | 22-toast | ✅ `notification-toast.tsx` 改为 snippet 规格（垂直上浮 16px + `--toast-scale` 0.97 + `--toast-blur` 2px；开启 350ms / 退场 250ms 双钟）。因该面由 framer-motion 驱动，规格经 **JS token 镜像**落地：`DURATION.medium`(=`--toast-open`)、`DURATION.fast`(=`--toast-close`)、`SCALE.medium`、`BLUR.small`、`EASE.smoothOut`；16px 行程不在共享 `--distance-*` 档位，保留字面量并注明对应 `--toast-distance`。原 `x: 40` 横向滑入改为垂直上浮 |
| B6 | skeleton | 14-skeleton-reveal | ✅ **已按方案 2 实施**：`globals.css` 新增 `.ui-skel*`（grid 同格叠放 + 交叉淡入/去模糊 + `is-resetting` 重放 + 脉冲 `--pulse-*`），新增 primitive `components/ui/skeleton-reveal.tsx`，已接入 `DeferredSection`（13 个使用点）。骨架层揭示后**保留在 DOM**（`opacity: 0` + `aria-hidden`）——这是交叉揭示的前提，也是与旧「加载完卸载骨架」模式的关键差异；`DeferredSection` 默认 fallback 由扫光底改为脉冲块。测试：新增 `skeleton-reveal.test.tsx`（3 例）+ 改写 `deferred-section.test.tsx` 两条断言 |
| B7 | tabs（`tabs.tsx` + `tab-motion.tsx`） | 16-tabs-sliding | ✅ 滑块位移由自定义 spring(stiffness 420) 改为 `--tabs-dur` 250ms + `--tabs-ease`（`DURATION.fast` + `EASE.smoothOut`）；活跃态触发器 `[transition-duration:var(--tabs-dur)]`。**未接入** snippet 的 `--tabs-*` 颜色 token（`#f1f1f1`/`#ffffff`/`#0f0f0f` 等浅色主题字面值），与本仓库 term 令牌色彩体系及暗色主题冲突——只取运动规格 |
| B8 | accordion / collapsible | 21-accordion | ✅ `accordion-down/up` 由 `0.2s ease-out` 改为 `var(--acc-expand)` / `var(--acc-collapse)` / `var(--acc-ease)`；chevron 由 `duration-200` 改为 `--acc-chevron` + `--acc-ease`。机制保留 Radix 的 height keyframe（`--radix-accordion-content-height`，同样无需 JS 量高，与 snippet 的 `grid-template-rows 0fr↔1fr` 等价），rotate-180 与 snippet 的 `scaleY(-1)` 对对称 chevron 等价；`collapsible-down/up` 同步对齐 |

**B1–B8 验证**：`pnpm test` **243 文件 / 1826 例**通过（1825 + B4 新增的 `data-side` 契约测试）；`pnpm lint` exit 0；
Tailwind 编译产物确认 `.ui-modal-motion` / `.ui-floating-motion` / `.ui-tooltip-motion` / `.ui-panel-motion` 均按
`var(--modal-* / --dropdown-* / --tt-* / --panel-*)` 生成，且旧 `dialog-in/dialog-out`、`popup-in`、`tooltip-in`、
`sheet-in-from-*` 在产物中归零。

**新增测试（B4）**：`components/ui/sheet.test.tsx` 断言 `ui-panel-motion` + `data-side="right"` 同时存在——
这是 CSS 方向选择器的前提，缺任一即退化成「只淡入不位移」。

**范围外（暂不接入）**：`fade-in-up`(360ms)、`switch-snap`(280ms)、`shimmer`、thinking / reasoning / streaming 系列——
当前无对应 UI 面或属自研 authoured moment，后续按需接入。

### B6 实施记录（方案 2：真做两图层交叉揭示）

**用户 2026-10-16 决策：不保守，按方案 2 推进。**

1. **CSS 基座**（`globals.css`，`@layer utilities`）：`.ui-skel` / `.ui-skel-skeleton` / `.ui-skel-content` /
   `.ui-skel.is-revealed` / `.ui-skel.is-resetting` / `.ui-skel-skeleton.is-pulsing > *` + `@keyframes ui-skel-pulse`，
   全部读 snippet 语义变量（`--pulse-dur` 1000ms / `--pulse-count` 1 / `--pulse-min` 0.5 / `--reveal-dur` 400ms /
   `--reveal-blur` 2px / `--reveal-ease`），含 required 的 reduced-motion 守卫。
2. **机制适配（必要偏差）**：snippet 用 `position: absolute; inset: 0` 两层叠放，要求调用方自带确定高度槽位；
   React 侧给不出，直接包会塌成 0 高。故改为 **grid 同格叠放**（`grid-area: 1/1`，容器高度取两层较高者）——
   运动规格不变，仅换叠放实现。
3. **React primitive**：`components/ui/skeleton-reveal.tsx`（`loading` / `skeleton` / `children`），
   输出 `.ui-skel` + `is-revealed` + `data-state` + `aria-busy`，骨架层恒定 `aria-hidden`。
4. **接入面**：`components/dashboard/deferred-section.tsx`（`DeferredSection` 共 13 个使用点，全在 ad-analysis 懒挂载场景）。
   默认 fallback 由 `<Skeleton>`（扫光底）改为脉冲块；**惰挂载语义保持不变**（未进视口仍不渲染子组件）。
5. **测试**：新增 `components/ui/skeleton-reveal.test.tsx`（3 例：loading 态 / revealed 态 / 两层契约）；
   改写 `components/dashboard/deferred-section.test.tsx` 两条断言（骨架标记 `.ui-skel-skeleton` + `data-state`；
   「移除骨架」→「骨架层转入已揭示态且不卸载」）。

**未动的部分**：`.u-skeleton-shimmer`（扫光）保留给**纯占位**骨架（无内容可揭示的面，如 `page-skeletons` /
`table-skeleton` / `ad-data-explorer` 等），其余 6 个断言 `.u-skeleton-shimmer` 的测试文件因此**不受影响、无需改动**。
若后续要把这些面也升级为两图层揭示，机制已就位（`SkeletonReveal` 可直接包）。

**B6 验证**：目标测试 2 文件 / 6 例通过；全量 `pnpm test` **244 文件 / 1829 例通过**；`pnpm lint` exit 0；
`npx tsc --noEmit` 对新增/改动文件 0 诊断；Tailwind 产物含 `filter: blur(var(--reveal-blur))`、
`animation: ui-skel-pulse var(--pulse-dur) ease-in-out var(--pulse-count)`、`--reveal-dur`（6 处）。

---

## 12. 迁移完成总结（2026-10-16）

**范围**：Phase 0-3（token 体系全量替换）+ Phase B（8 个 UI 面接入 snippet，7 个完成 + B6 已按方案 2 补齐）。

**净变化（对外可见的手感差异，均为有意为之）**

| 项 | 旧 | 新 |
| --- | --- | --- |
| hover / focus 微状态 | 180ms | `--duration-quick` 150ms |
| modal 开 / 关 | 340ms ease-out / 200ms cubic-bezier(0.4,0,1,1) + `scale(1.012)` 过冲 | 250ms / 150ms `--ease-smooth-out`，纯 scale（无过冲） |
| dropdown 关 | 280ms spring 曲线 + 方向位移 | 150ms smooth-out + `scale(0.99)`（纯 origin 缩放） |
| tooltip 开 | 160ms ease-out + spring 过冲 | 150ms ease-out + 80ms appear-delay + `scale(0.98)` |
| sheet 开 / 关 | 400ms ease-out + 方向性过冲 | 400ms / 350ms smooth-out + 2px 交叉模糊（无过冲） |
| toast 进 / 出 | 横向滑入 40px + `scale(0.95)` | 垂直上浮 16px + `scale(0.97)` + 2px 模糊（350ms / 250ms） |
| tabs 滑块 | spring(stiffness 420) | 250ms smooth-out tween |
| accordion 开 / 合 | 200ms ease-out | 250ms smooth-out |
| skeleton | 扫光 1.5s linear | 脉冲 1000ms（1 次，`--pulse-min` 0.5）+ 400ms 交叉模糊揭示 |
| 内容淡入 | 240ms | 400ms（`--duration-slow`） |
| stagger 步长 | 70ms | 40ms |
| 按压回弹 | 220ms cubic-bezier(0.34,1.56,0.64,1) | 250ms + `--ease-bounce`(0.34,1.36,0.64,1) |

**最终验证**：`pnpm test` **244 文件 / 1829 例通过** · `pnpm lint` exit 0 · `npx tsc --noEmit` 改动文件 0 诊断 ·
Tailwind 编译通过且所有 `.ui-*` 类按语义变量生成 · 旧 token（`--motion-*` / `--stagger-step`）在产品代码中 0 残留。

---

## 13. 验收记录（2026-10-16）

### 已验证

| 类别 | 内容 | 结论 |
| --- | --- | --- |
| 技术门禁 | `pnpm test` 244 文件 / 1829 例；`pnpm lint` exit 0；`npx tsc --noEmit` 对改动文件 0 诊断；Tailwind 编译通过 | ✅ |
| 运行时 · 骨架揭示 | `/dashboard/advertising/ad-analysis/placements`：2 个 `.ui-skel` 均 `data-state=revealed`，内容层 `opacity:1` / `blur(0px)` / 有文本，骨架层 `opacity:0`，脉冲解析为 `ui-skel-pulse` 1000ms | ✅ 高风险项通过（内容未被藏住） |
| 运行时 · sheet | 客户详情抽屉：`.ui-panel-motion` + `data-side=right` + `ui-panel-in` 0.4s，旧 `animate-sheet-in-*` 已不在 | ✅ 同时证实 `data-side` 修复在运行时生效 |
| 运行时 · dropdown | 项目下拉：`.ui-floating-motion` + `ui-dropdown-in` 0.25s | ✅ |
| 契约级 · modal | `.ui-modal-motion`：`ui-modal-in` 250ms / `ui-modal-out` 150ms | ✅（未做运行时点击触发） |
| 契约级 · tooltip | `ui-tooltip-in` 150ms + 80ms delay / `ui-tooltip-out` 50ms | ✅（未做运行时 hover 触发） |
| 契约级 · tabs | 滑块 `layout: { duration: DURATION.fast, ease: EASE.smoothOut }`（tween，spring 已移除） | ✅（手感未人眼验） |
| 契约级 · accordion | `accordion-down var(--acc-expand) var(--acc-ease)` 250ms | ✅（未做运行时展开触发） |

### 未验证（需人眼，本次未完成）

1. **手感验收**：modal / tooltip / toast / tabs / accordion 五处的实际观感（尤其 tooltip 移开 50ms 瞬收、tabs 从弹簧改 tween、toast 横向→垂直上浮）。
2. **reduced-motion 降级**：开系统「减少动态效果」后应全部瞬显（代码守卫已加，未实机验证）。
3. **深浅主题各一遍**：`.ui-*` 动效类与主题无关，但未实际对比。

### 环境备注

- 验收用的本地环境是临时搭的：`frontend/.env.local`（取自主 checkout）、`backend/.env`（取自 `wasteful-pig` worktree）、后端用 `wasteful-pig` 的 venv 跑本 worktree 的代码；三者均 gitignored。
- 期间发现前端 `BACKEND_API_KEY`（4 字符占位）与后端 `API_KEY`（48 字符）不一致导致 `Invalid API key`，已在本地 `.env.local` 对齐。
- 临时验收账号 `motion-acceptance@believeboy.com` **已删除**（本地 `BLF` 恢复原状，仍 5 个账号）。需要复现时按 §13 上述步骤重建即可（bcrypt via `app.core.passwords.hash_password`，rounds=10）。
