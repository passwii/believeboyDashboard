# Phase 4 — 验收

> **父 plan：** `docs/superpowers/plans/2026-07-11-frontend-motion-system.md`
> **依赖：** Phase 0 + Phase 1 + Phase 2 + Phase 3 完成 ✅
> **执行日期：** 2026-07-11
> **执行者：** 子智能体 + 用户本地手动验收
> **分支：** `feat/frontend-motion-system`
> **状态：** ✅ **代码层完成 + tag 已创建；本地 e2e + 手动验收待用户执行**

## 已完成的代码层验证

| 关卡 | 命令 | 结果 |
|------|------|------|
| lint | `pnpm lint` | 0 errors / 25 warnings（全部 pre-existing） |
| build | `pnpm build` | 通过（全部路由编译） |
| test | `pnpm test` | **146 passed**（20 files） |
| unit/component | vitest (jsdom) | 4 motion primitives + 2 dashboard components 全测 |

## 任务清单

### ⏳ 任务 4.1 — Playwright 回归（**用户在本地执行**）

> headless 环境启动 next dev + chromium + Playwright 成本高，由用户在本地跑。

**用户本地命令**：
```bash
cd frontend && pnpm test:ui
```

**预期**：全部通过（动画不应改变 `role` / `aria-label` / DOM 结构）。

**失败定位**：
- 若是动画导致 DOM/role 变化 → 排查 PageTransition / MotionStagger 渲染问题
- 若是真实功能问题 → 与本次动效改动无关，按既有 bug 流程处理

### ⏳ 任务 4.2 — Lighthouse 抽查（**用户在本地执行**）

> Lighthouse 需要真实运行的站点，headless 环境不便。

**用户本地命令**：
```bash
cd frontend && pnpm perf:lhci:collect
```

**人工比对**：重点比对 `/dashboard` 与 `/dashboard/data-analysis/ad-analysis/overview`：
- **INP** < 200ms（路由切换的 spring 过渡不应增加 INP）
- **LCP** 不退化（PageTransition 的 blur 8px 是元素自身 filter，不影响 LCP 元素）
- **CLS** < 0.1（容器 spring 不引入 layout shift）

### ⏳ 任务 4.3 — 手动验收 9 条（**用户在浏览器执行**）

启动开发服务器：
```bash
cd frontend && pnpm dev
# 浏览器访问 http://localhost:3200
```

逐条对照 spec §10 验收清单：

- [ ] **1. 路由切换**：在 /dashboard 内任意两路由切换，旧页 exit（scale+blur+opacity spring）→ 新页 enter（容器 + 内容 stagger）；后退/前进一致；query 切换**不重触发**过渡（避免筛选条件切换时页面抖）。
- [ ] **2. ad-analysis 子路由**：进入 `/dashboard/data-analysis/ad-analysis/overview` 与 `/dashboard/data-analysis/ad-analysis/campaigns`，切换应与其它子路由过渡**一致（无双层嵌套）**——重点回归项。
- [ ] **3. GlobalLoadingOverlay 兜底**：切换路由时顶栏 `GlobalLoadingOverlay` 进度条**仍可见**；**不再出现**整页 DashboardPageLoading 卡顿。
- [ ] **4. Sidebar**：rail hover 展开 panel 的 spring 手感（保留原 `cubic-bezier(0.22,1.18,0.36,1)`）；active 项指示 spring 过渡；hover 规范（`u-interactive` 微提亮 + translateY(-1px)）。
- [ ] **5. 按钮**：hover 提亮上浮；`:active` 加权按下回弹（`scale(0.97)` + spring）；键盘 Tab 焦点环可见（`u-focus` 2px ring）。
- [ ] **6. 卡片（包装 spotlight）**：试点 KPI 卡 hover 聚光边 + 微浮；其余 `.dashboard-surface` 卡片**无** pointermove 监听（DevTools Performance 验证 pointermove 仅在包装卡片触发）。
- [ ] **7. reduced-motion**：DevTools → Rendering → Emulate CSS media feature `prefers-reduced-motion: reduce` → 所有动画退化为瞬时、无位移无模糊无 spring。
- [ ] **8. reduced-transparency**：DevTools → Rendering → Emulate CSS media feature `prefers-reduced-transparency: reduce` → blur 关闭、spotlight 退化为静态高光（`--spotlight-strength: 0`）。
- [ ] **9. 移动端 / 粗指针**：DevTools → Device emulation → iPhone / Pixel 5 → spotlight 降级为静态高光（不挂 pointermove）。

### ✅ 任务 4.4 — 最终 tag + 交付

- [x] git tag `v1-motion-system` 已创建（msg "v1: motion system ready - Phase 0/1/2/3 validated, awaiting Phase 4 manual acceptance"）

## 验证清单（最终）

- [x] 代码层验证：lint 0 errors / build pass / test 146 passed
- [x] git tags：phase1-motion-transition / phase2-hover-active / phase3-premium-stagger / v1-motion-system
- [x] 17 个 feat/refactor/chore(动效) commit
- [ ] 用户本地 Playwright 回归（4.1）
- [ ] 用户本地 Lighthouse 抽查（4.2）
- [ ] 用户浏览器手动验收 9 条（4.3）

## 完整 commit 历史（Phase 0-3）

```
18a95d05 refactor(动效): toast/dialog 缓动统一引用 token
d6fcb8ba feat(动效): dashboard 首页标题/卡片组接入 MotionStagger
112ce34a feat(动效): dashboard 首页 KPI 卡片试点 spotlight 包装
068af806 feat(动效): 新增 DashboardSurfaceCard spotlight 包装
de98d17e feat(动效): Sidebar active 指示 spring + nav item hover 规范
c1cabcdd feat(动效): Button 接入 u-press/u-focus/u-interactive
9302a48f refactor(动效): 拆 ad-analysis 嵌套 PageTransition 包裹 防全局双层动画
f9221075 feat(动效): dashboard layout 接入 PageTransition 拆整页 loading swap
35966b7d feat(动效): 新增 PageTransition 全局路由过渡
73bacaab feat(动效): 新增 MotionStagger / MotionStaggerItem
15705cb6 feat(动效): 新增 MotionFade 原语
c9d8e737 feat(动效): 新增 useSpotlight hook + 单测
44e86173 feat(动效): 新增 framer-motion variants (page/fadeUp/stagger/press)
4c8859be feat(动效): 新增 JS 镜像 motion token + 单测
2cf6e270 refactor(动效): 收编 .hover-lift 等存量 utility 引用 token 去重
8de245cc feat(动效): 新增 .u-interactive/.u-press/.u-focus/.u-stagger-item 规范
f092150c chore(动效): 同步 globals.css motion/z-index/spotlight token 与 main 一致
```

## 收尾（用户决策）

用户决定合并与推送策略：
- 当前分支：`feat/frontend-motion-system`（未推送）
- 所有 tag 已本地创建
- 17 个动效 commit 已落地
- 推荐：本地验收通过后 `git push origin feat/frontend-motion-system` + 提 PR（按项目 AGENTS.md 流程）