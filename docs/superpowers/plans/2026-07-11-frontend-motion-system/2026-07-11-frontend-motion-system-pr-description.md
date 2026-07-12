# feat(前端动效): 建立 Apple 级动效设计系统 v1

> **关联文档**：
> - [父 plan](docs/superpowers/plans/2026-07-11-frontend-motion-system/2026-07-11-frontend-motion-system.md)
> - [设计 spec](docs/superpowers/specs/2026-07-11-frontend-motion-system-design.md)
> - [开发者指南](frontend/docs/motion-system.md)
> - [10 个 phase 进度 md](docs/superpowers/plans/)

## Summary

在现有前端（Next.js 16 App Router + Tailwind v3 + shadcn/ui + framer-motion 12）上建立统一的动效设计系统，达到 Apple 级交互质感（spring 物理、玻璃/聚光、加权按下、统一页面过渡）。覆盖 sidebar hover / 页面切换 / 各类显示反馈，并形成可复用、可审查、可维护的规范。

**规模**：47 commits / 67 files changed / +4352 / -187

**质量门**：Vitest 21 files / 154 tests passed · Playwright 10 specs · 0 lint errors · build OK

## Changes by Phase

### Pre-Phase 0 — 同步 + 计划（2 commits）

- `f092150c` — `chore(动效): 同步 globals.css motion/z-index/spotlight token 与 main 一致`
- `8fd44e29` — `docs(动效): 新增前端动效系统实现计划`

### Phase 0 — 地基（token + utility + JS 镜像 + variants，4 commits）

- `8de245cc` — `feat(动效): 新增 .u-interactive/.u-press/.u-focus/.u-stagger-item 规范`
- `2cf6e270` — `refactor(动效): 收编 .hover-lift 等存量 utility 引用 token 去重`
- `4c8859be` — `feat(动效): 新增 JS 镜像 motion token + 单测`
- `44e86173` — `feat(动效): 新增 framer-motion variants (page/fadeUp/stagger/press)`

> 交付：`frontend/app/globals.css :root` 新增 `--motion-*` / `--stagger-step` / `--z-*` / `--spot-*` token；`frontend/lib/motion/{tokens,variants}.ts` 双侧镜像 + 单测。

### Phase 1 — 全局路由过渡（6 commits + 1 hotfix）— `phase1-motion-transition`

- `c9d8e737` — `feat(动效): 新增 useSpotlight hook + 单测`
- `15705cb6` — `feat(动效): 新增 MotionFade 原语`
- `73bacaab` — `feat(动效): 新增 MotionStagger / MotionStaggerItem`
- `35966b7d` — `feat(动效): 新增 PageTransition 全局路由过渡`
- `f9221075` — `feat(动效): dashboard layout 接入 PageTransition 拆整页 loading swap`
- `9302a48f` — `refactor(动效): 拆 ad-analysis 嵌套 PageTransition 包裹 防全局双层动画`

> 交付：`components/motion/{PageTransition,MotionFade,MotionStagger,useSpotlight}.{tsx,ts}`；dashboard 顶层接入；ad-analysis 拆除嵌套避免双层动画。

### Phase 2 — hover/active 标准化（4 commits）— `phase2-hover-active`

- `c1cabcdd` — `feat(动效): Button 接入 u-press/u-focus/u-interactive`
- `de98d17e` — `feat(动效): Sidebar active 指示 spring + nav item hover 规范`
- `068af806` — `feat(动效): 新增 DashboardSurfaceCard spotlight 包装`
- `112ce34a` — `feat(动效): dashboard 首页 KPI 卡片试点 spotlight 包装`

### Phase 3 — 高级触感 + 内容 stagger 推广（2 commits）— `phase3-premium-stagger`

- `d6fcb8ba` — `feat(动效): dashboard 首页标题/卡片组接入 MotionStagger`
- `18a95d05` — `refactor(动效): toast/dialog 缓动统一引用 token`

### Phase 4 — 验收（tag only）

- `v1-motion-system` tag
- 代码层：lint 0 errors / build pass / 154 tests
- 手动验收 9 条（[phase4 文档](docs/superpowers/plans/2026-07-11-frontend-motion-system/2026-07-11-frontend-motion-system-phase4.md#任务-43--手动验收-9-条)）

### Phase 5 — Hotfix 3 架构化（5 commits + 3 hotfix + 1 regression hotfix）— `phase5-page-transition-refactor`

- `268cdd4a` — `refactor(动效): PageTransition 拆 Normal/FullBleed 变体 + 路由 helper 接入`
- `e2bea8e1` — `feat(动效): 提取 isFullBleedDashboardRoute helper + 单测`
- `c8498be9` — `test(动效): page-transition 补 full-bleed/normal 路由分支断言`
- `5f6cd124` — `test(动效): layout test 补 ai-chat full-bleed 路由渲染断言`
- `05494fdb` — `test(动效): Playwright 补 ai-chat 视口高度回归`

> 交付：拆分 `NormalPageTransition` / `FullBleedPageTransition` 变体 + dispatcher；`isFullBleedDashboardRoute` helper + 单测；page-transition/layout test 补强；Playwright `ai-chat-viewport.spec.ts` 高度回归。

### Phase 6 — Phase 2/3 推广（5 commits）— `phase6-promotion`

- `79c6ce6d` — `feat(动效): dashboard row 2 数据卡 spotlight + MotionStagger`
- `fa181978` — `feat(动效): dashboard row 3 数据卡 spotlight + MotionStagger`
- `a209c948` — `feat(动效): ad-analysis 入口页接入 MotionStagger`
- `283fa872` — `refactor(动效): u-interactive 推广到 dropdown-menu/tabs/combobox/calendar`
- `d72b7853` — `docs(动效计划): 提交前端动效系统 phase5/6/7 计划文档`

### Phase 7 — 通用组件动效统一（4 commits）— `phase7-component-motion`

- `7bcf0101` — `refactor(动效): Radix popover/dialog/sheet/tooltip spring 过渡统一 token`
- `cb2103f3` — `feat(动效): 表单元素 Toggle/Checkbox/Radio/Switch 微动效统一`
- `2e8e625c` — `feat(动效): Skeleton/Loading 入场过渡优化`
- `f55a75f6` — `refactor(动效): ai-chat 自定义动效 token 化`

### Phase 8 — 性能 + 可访问性收口（4 commits）— `phase8-perf-a11y`

- `b01df67a` — `test(动效): Playwright 性能断言（INP/CLS）`
- `dbede6c5` — `test(a11y): 接入 @axe-core/playwright + 扫描动效相关页面`
- `ddf48c40` — `test(a11y): reduced-motion/reduced-transparency 退化回归`
- `87730192` — `ci(动效): Playwright 接入 CI`（`.github/workflows/motion-system-ci.yml`）

> 交付：`tests/performance/motion-budget.spec.ts`（INP < 200ms / CLS < 0.1）；`tests/a11y/{motion-system,reduced-motion,reduced-transparency}.spec.ts`；CI workflow 独立 job。

### Phase 9 — 文档化 + Token v2 调研（4 commits）— `phase9-docs`

- `f453174c` — `docs(动效): 新增 5 个 phase 进度文档 支撑 /loop 定期执行恢复上下文`
- `85c9ffd1` — `docs(动效): 新增 motion-system 开发者指南`（`frontend/docs/motion-system.md`，296 行）
- `cac8a260` — `docs(动效): tokens.ts 添加 CSS/JS 对照表与修改纪律注释`
- `81026891` — `docs(动效): v2 token 优化建议调研报告`（`docs/superpowers/plans/2026-07-11-frontend-motion-system/2026-07-11-frontend-motion-system-v2-token-recommendations.md`）

### Phase 10 — v2 Token 清理（2 commits）— `phase10-v2-cleanup`

- `d3a96fdf` — `refactor(动效): 删除 v2 调研建议的 0 引用冗余 token（Z.* / EASE.springBack / SPRING.press）`
- `054a1282` — `docs(动效): motion-system.md 反映 v2 token 清理`

### Hotfix 系列（穿插在 Phase 1-5，5 commits）

- `9253ebd3` — `fix(动效): PageTransition wrapper 兜底 h-full 修复 ai-chat 页面塌缩`（Phase 1 hotfix）
- `f9feb11f` — `fix(动效): PageTransition motion.div 兜底 h-full 修 ai-chat 动画态塌缩`（Phase 5 hotfix）
- `85465b2f` — `fix(动效): PageTransition full-bleed 路由走 absolute 修 ai-chat 塌缩`（Phase 5 hotfix）
- `8b523011` — `fix(前端动效): 恢复 PageTransition 内层高度 修复 ai-chat 塌缩`（Phase 5 hotfix）
- `46d74f48` — `fix(动效): PageTransition 变体 key=pathname 恢复路由切换动效`（Phase 5 regression hotfix，PageTransition 拆变体后路由切换动画丢失）

## Test Report

### Vitest（jsdom）

- **Test Files** 21 passed (21) / **Tests** 154 passed (154)
- 覆盖范围：
  - `lib/motion/{tokens,variants,routes}.test.ts` — token / variant / 路由 helper
  - `components/motion/{page-transition,motion-fade,motion-stagger,use-spotlight}.test.tsx` — 4 个 motion 原语
  - `app/dashboard/layout.test.tsx` — layout 集成（full-bleed 路由分支）
  - `components/dashboard/dashboard-surface-card.test.tsx` — spotlight 包装
  - `components/ui/button.test.tsx` — u-press / u-focus / u-interactive 行为

### Playwright（chromium + mobile projects，10 spec files）

**既有 5 个**：
- `tests/ai-chat/model-selector.spec.ts`
- `tests/design/{responsive,overlap,alignment,display}.spec.ts`（4 个）

**Phase 5 新增 1 个**：
- `tests/dashboard/ai-chat-viewport.spec.ts`（ai-chat 视口高度回归）

**Phase 8 新增 4 个**：
- `tests/performance/motion-budget.spec.ts`（INP < 200ms / CLS < 0.1）
- `tests/a11y/motion-system.spec.ts`（@axe-core/playwright 扫描）
- `tests/a11y/reduced-motion.spec.ts`（prefers-reduced-motion 退化）
- `tests/a11y/reduced-transparency.spec.ts`（prefers-reduced-transparency 退化）

### Lighthouse

- `pnpm perf:lhci:collect` 在本地 + CI 跑（项目既有 `frontend/.lighthouserc.json`）
- 目标：INP < 200ms / LCP 不退化 / CLS < 0.1

### Build / Lint

- `pnpm lint`: 0 errors / 25 warnings（全部 pre-existing `react-hooks/exhaustive-deps`，未由本 PR 引入）
- `pnpm build`: 成功（所有 page 编译 + Proxy middleware 注入 OK）

## Tag 列表（10 phase + v1 终态）

```
v1-motion-system
phase10-v2-cleanup
phase9-docs
phase8-perf-a11y
phase7-component-motion
phase6-promotion
phase5-page-transition-refactor
phase3-premium-stagger
phase2-hover-active
phase1-motion-transition
```

任意 phase 可独立回滚（每个 phase 独立 commit + tag，回滚指南见下文）。

## Migration Notes / Breaking Changes

- **`app/dashboard/layout.tsx` 改动**：删除 `useGlobalLoading` 调用 + `<DashboardPageLoading>` 引用。`isNavigationLoading` 整页 swap 已拆除，改由 `<PageTransition>` 包裹 children。**全局 loading 兜底仍存在**（`GlobalLoadingOverlay` 顶栏进度条 + 各路由 `loading.tsx` Suspense 兜底）。
- **`ad-analysis/layout.tsx` 改动**：拆除 `<AdAnalysisPageTransition>` 嵌套包裹，children 直接交给全局 `<PageTransition>`。原 `AdAnalysisPageTransition` 定义文件保留（已 tree-shake，可后续清理）。
- **新增 globals.css 依赖**：约 100 行新 token + utility 规则。无 `@apply` 与现有 utility 冲突（已通过 21 个 vitest + 10 个 playwright 验证）。
- **新增 client component**：`<PageTransition>` / `<MotionFade>` / `<MotionStagger>` 等均为 `'use client'`。已在 dashboard/layout.tsx 边界处理，不污染 server component。

## Manual Verification Checklist（PR review 时建议过一遍）

- [Phase 4 手动验收 9 条](docs/superpowers/plans/2026-07-11-frontend-motion-system/2026-07-11-frontend-motion-system-phase4.md#任务-43--手动验收-9-条)
- [Phase 5 ai-chat 视口验证](docs/superpowers/plans/2026-07-11-frontend-motion-system/2026-07-11-frontend-motion-system-phase5-page-transition-refactor.md#任务-55--playwright-ai-chat-视口高度回归)
- [Phase 6 row 2/3 stagger 验证](docs/superpowers/plans/2026-07-11-frontend-motion-system/2026-07-11-frontend-motion-system-phase6-promotion.md#手动验收-用户在浏览器)
- [Phase 7 UI 组件微动效验证](docs/superpowers/plans/2026-07-11-frontend-motion-system/2026-07-11-frontend-motion-system-phase7-component-motion.md#手动验收-用户在浏览器)
- [Phase 8 reduced-motion / reduced-transparency 退化](docs/superpowers/plans/2026-07-11-frontend-motion-system/2026-07-11-frontend-motion-system-phase8-perf-a11y.md#手动验收-用户在浏览器--ci)

## Related Documentation

- [父 plan](docs/superpowers/plans/2026-07-11-frontend-motion-system/2026-07-11-frontend-motion-system.md)
- [设计 spec](docs/superpowers/specs/2026-07-11-frontend-motion-system-design.md)
- [开发者指南](frontend/docs/motion-system.md)
- [v2 token 调研](docs/superpowers/plans/2026-07-11-frontend-motion-system/2026-07-11-frontend-motion-system-v2-token-recommendations.md)
- [10 个 phase 进度 md](docs/superpowers/plans/)

## Future Work（v2+）

- **spring 参数微调**：基于真实手感反馈调整 stiffness / damping / mass（已留调研报告）
- **设计稿同步**：Figma Variables 与 motion token 双向同步（已在 motion-system.md 留接口）
- **新业务场景接入**：按 motion-system.md 决策树
- **回滚指南**：每个 phase tag 独立可回滚（如发现 Phase N 引入 regression，`git revert <phase N 范围内的 commit>` 即可）

## Rollback Strategy

任意 phase 独立可回滚：

```bash
# 示例：回滚 Phase 6
git tag -l "phase6-promotion"   # 查 Phase 6 tag
git log phase6-promotion~1..phase6-promotion --oneline  # 看 Phase 6 范围
git revert <phase6-commit-sha>...   # 逐 commit revert（推荐） 或
git revert --no-commit $(git rev-list phase6-promotion~1..phase6-promotion)   # 批量 revert
git tag -d phase6-promotion   # 删旧 tag
git tag -a "phase6-promotion-fixed" -m "..."   # 重建 tag
```

不建议 `git reset --hard`，会丢失 phase tag 历史。

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
