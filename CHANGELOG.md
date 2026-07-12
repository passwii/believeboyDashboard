# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Motion design system v1** — Apple 级动效设计系统（spring 物理、玻璃/聚光、加权按下、统一页面过渡）
  - **Token 层**：CSS (`frontend/app/globals.css :root`) + JS (`frontend/lib/motion/tokens.ts`) 双侧定义，约 100 行新 token + utility 规则
  - **Primitive 层**：`PageTransition` / `MotionFade` / `MotionStagger` / `MotionStaggerItem` / `useSpotlight`
  - **Variant 层**：`page` / `fadeUp` / `stagger` / `press` 四组 framer-motion variants
  - **Utility 层**：`.u-interactive` / `.u-press` / `.u-focus` / `.u-stagger-item` 规范 utility
  - **组件层**：`<DashboardSurfaceCard>` 可选 spotlight 包装
  - **完整覆盖**：sidebar hover / 页面切换 / 各类显示反馈 / Radix popover/dialog/sheet/tooltip / 表单元素 / Skeleton/Loading
  - **质量门**：Vitest 21 files / 154 tests / Playwright 10 specs（性能断言 + @axe-core a11y 扫描 + reduced-motion/transparency 退化）
  - **CI**：`motion-system-ci.yml` workflow 独立 job

详见 [动效系统开发者指南](frontend/docs/motion-system.md)。

### Changed

- `app/dashboard/layout.tsx` — 接入 `<PageTransition>` + 拆除 `isNavigationLoading` 整页 swap，改由 PageTransition 包裹 children
- `app/dashboard/data-analysis/ad-analysis/layout.tsx` — 拆除嵌套 `<AdAnalysisPageTransition>`，children 直接交给全局 `<PageTransition>`
- `components/ui/dropdown-menu.tsx` / `tabs.tsx` / `combobox.tsx` / `calendar.tsx` / `popover.tsx` / `dialog.tsx` / `sheet.tsx` / `tooltip.tsx` / `toggle.tsx` / `checkbox.tsx` / `switch.tsx` — 接入 motion token
- `components/ui/button.tsx` — 接入 `u-press / u-focus / u-interactive`
- `components/ui/skeleton.tsx` — Skeleton/Loading 入场过渡优化
- `components/dashboard/sidebar-panel.tsx` / `sidebar-icon-rail.tsx` — Sidebar active 指示 spring + nav item hover 规范
- `components/notifications/notification-toast.tsx` — toast duration / 缓动统一引用 token
- `components/customer-service/...` — ai-chat 自定义动效 token 化
- `frontend/app/globals.css` — 新增 ~100 行 motion/z-index/spotlight token + utility + reduced 守卫
- CI：新增 `.github/workflows/motion-system-ci.yml`

### Removed

- **0 引用冗余 token 清理**（v2 token 调研建议）：
  - 5 个 `--z-*` CSS token
  - `EASE.springBack` 常量
  - `SPRING.press` 常量
  - `Z` 对象

[Unreleased]: https://github.com/passwii/believeboyDashboard/compare/main...feat/frontend-motion-system
