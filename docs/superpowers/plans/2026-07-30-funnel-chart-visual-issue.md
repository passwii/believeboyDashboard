# P6a Task 3 续 — FunnelChart 视觉效果问题诊断

**日期**：2026-07-30
**状态**：已部署（commit 5ba2a280），但用户报"效果非常差，和预期差别很大"

## Phase 1 证据收集

### 环境侦察
- ✅ 项目装的是 `framer-motion@12.38.0`（顶层 export 有 `motion` / `useSpring` / `useTransform`）
- ✅ 用户代码里的 `motion/react` 被我换成 `framer-motion`（零新依赖）
- ✅ `tailwind.config.ts` 完整，`--chart-1` 等 token 都在 globals.css 里
- ⚠️ dev server (Next.js 16.2.4 Turbopack) 在本地跑过多次验证，curl 探测**返回 SSR HTML 里没有 `<svg>` 标签** —— 这是关键线索

### 已分析的潜在根因（按可能性排序）

#### 假设 A：SSR 渲染空白，CS 才出（高可能）
- 组件用 `useState({w:0, h:0})` 起步，靠 `useEffect` + `ResizeObserver` 测量后才渲染 SVG
- SSR 时 `W=0, H=0`，条件渲染 `{W > 0 && H > 0 && (...segments...)}` 整体不渲染
- 用户看到：dashboard 首屏时漏斗区是**空 Card**，约 200-500ms 后 segments 才弹进来
- **"效果非常差"** 很可能匹配：卡片内起初空白 → 然后突然出现 → 视觉很跳

#### 假设 B：grid 灰带 + 3 层 opacity 叠加显得脏（中可能）
- 用户的 `grid` 开启后，背景有 i%2===0 的灰带（`var(--color-muted)`），在 Card 浅色背景上看起来是横纹
- 3 层（layers=3）每层不同 opacity（0.18→0.83），叠加后整体偏暗
- 漏斗颜色由 `stage.gradient` 第 0 stop 决定（`firstStop.color`），即 gradient 起点颜色

#### 假设 C：entrance animation 一直循环（低可能）
- `useSpring(0)` → setTimeout 设 1，spring 一次性动画到 1
- 多次 re-render 时 setTimeout 重新调度，理论上看起来只播一次
- 但 motion 的 `key` 是 stage.label，data 变化（stats 更新）时**会重新触发入场动画**

#### 假设 D：与 CardContent 容器尺寸相关（中可能）
- CardContent 默认没有固定高度
- FunnelChart 自己用 `aspectRatio: 2.2/1` 算高度
- 但 `w-full max-w-3xl` + CardContent 的 padding，可能让实际 W 小于预期

## Phase 2 用户反馈缺失

无法精确判断用户看到的具体问题：
- 是"完全空白"？
- 是"形状错（不缩进）"？
- 是"颜色难看"？
- 是"动画卡顿"？
- 是"标签重叠/不可读"？

本机没有可用的浏览器/playwright（daemon 启动失败），无法实际截图验证。

## Phase 3 决策点

### 推荐方案（按工程性价比）

**方案 X — 简化 dashboard 用法（不动 FunnelChart 组件）** ⭐ 推荐
- dashboard 调用 FunnelChart 时：去掉 `grid`、把 `layers` 降为 1 或 2
- 接受 SSR 空白（用户刷新后短暂空白），等 JS 跑完出漏斗
- 优点：零代码改动到 FunnelChart 组件，立即见效
- 缺点：依旧有 SSR 空白闪现问题

**方案 Y — 把 FunnelChart 改成 SSR-friendly**
- 加 fallback 尺寸（如 `min-h-[300px]`，给一个默认 segW/segH 计算）
- 让 SSR 也能渲染静态 SVG
- 优点：首屏就有漏斗，无空白闪现
- 缺点：组件改动较大（~30 行）

**方案 Z — dashboard 完全不用 FunnelChart，自己撸个简单版**
- 纯 SVG，1 个 path per segment，无 grid 无 layers 无动画
- 用 SSR 直出
- 优点：完全可控，干净
- 缺点：复用性差（FunnelChart 沉没成本）

## 等待指令

请告诉 Damon：
- **(X)** 简化用法（推荐，1 行改动）
- **(Y)** 改 FunnelChart SSR-friendly（中等改动）
- **(Z)** 自己撸简单版
- **(F)** 先给我截图/描述一下"非常差"具体是什么样（让我先精准定位）

如果选 F，请描述：
- 大致什么样子（方块？梯形？空白？颜色？文字？）
- 是首次进入就这样，还是 hover 才这样？
- 截图链接/位置？