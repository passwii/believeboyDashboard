# Phase 5 — Hotfix 3 架构化 + 测试覆盖

> **父 plan：** `docs/superpowers/plans/2026-07-11-frontend-motion-system/2026-07-11-frontend-motion-system.md`
> **依赖：** Phase 0-4 完成 + 3 次 hotfix（9253ebd3 / f9feb11f / 85465b2f）
> **执行日期：** 2026-07-12
> **执行者：** 子智能体（subagent-driven-development 调度）
> **分支：** `feat/frontend-motion-system`
> **状态：** ✅ **完成**

## 背景与动机（解决 hotfix 3 架构债）

hotfix 3（`85465b2f`）解决了 ai-chat 塌缩，但用了硬编码 `pathname === '/dashboard/ai-chat'` 字符串判断。架构债：

- 未来新增 full-bleed 页面需再次改 PageTransition
- 路由判断与组件渲染耦合
- 现有 test 未覆盖 full-bleed 路径
- Playwright 没有 ai-chat 视口高度回归

Phase 5 把 hotfix 3 临时方案升级为可维护架构。

## 任务清单

### ✅ 任务 5.1 — 提取 full-bleed 路由 helper + 单测（TDD）
- [x] `frontend/lib/motion/routes.ts`：导出 `isFullBleedDashboardRoute(pathname)` 纯函数
- [x] `FULL_BLEED_DASHBOARD_ROUTES = ['/dashboard/ai-chat'] as const` 数组化便于扩展
- [x] `routes.test.ts` 5 用例全过（ai-chat true / dashboard 根 false / ad-analysis false / 空字符串 false / ai-chat-v2 不误伤）
- [x] commit `e2bea8e1` — feat(动效): 提取 isFullBleedDashboardRoute helper + 单测

### ✅ 任务 5.2 — 拆分 PageTransition 变体（Normal + FullBleed）
- [x] `NormalPageTransition.tsx`：wrapper `h-full w-full` + motion.div `will-change-transform h-full w-full`
- [x] `FullBleedPageTransition.tsx`：wrapper `!absolute inset-0` + motion.div `will-change-transform h-full w-full`（用户/linter 已确认 h-full 保留）
- [x] `PageTransition.tsx` 改为 dispatcher（8 行）：`const Component = isFullBleedDashboardRoute(pathname) ? FullBleedPageTransition : NormalPageTransition`
- [x] 外部 `import { PageTransition } from '@/components/motion/PageTransition'` 调用方式**不变**
- [x] 两变体的 `reduce` / `reduceTransparency` / `useEffect` / spring 各自保留（结构对称）
- [x] commit `268cdd4a` — refactor(动效): PageTransition 拆 Normal/FullBleed 变体 + 路由 helper 接入

### ✅ 任务 5.3 — page-transition.test.tsx 补强
- [x] 新增 full-bleed 路由断言：wrapper 含 `!absolute` + `inset-0`
- [x] 新增 normal 路由断言：wrapper 含 `h-full` + `w-full`
- [x] commit `c8498be9` — test(动效): page-transition 补 full-bleed/normal 路由分支断言

### ✅ 任务 5.4 — dashboard/layout.test.tsx 补 full-bleed 路径
- [x] 把 `mockPathname` 改 module 级 mutable
- [x] 新增 ai-chat 路径渲染不抛错断言
- [x] commit `5f6cd124` — test(动效): layout test 补 ai-chat full-bleed 路由渲染断言

### ✅ 任务 5.5 — Playwright ai-chat 视口高度回归
- [x] `frontend/components/chat/ai-chat-window.tsx` 根 div 加 `data-testid="ai-chat-window"`
- [x] `frontend/tests/dashboard/ai-chat-viewport.spec.ts`：断言 AIChatWindow boundingBox height ≥ viewport height × 0.8 且 width ≥ viewport width × 0.8
- [x] Playwright `--list` 能在 chromium + mobile 两 project 下识别该 spec
- [x] commit `05494fdb` — test(动效): Playwright 补 ai-chat 视口高度回归

### ✅ 任务 5.6 — Phase 5 整体验证 + tag
- [x] lint 0 errors / build pass / test **154 passed (21 files)**（从 146 → 154，新增 8 个）
- [x] tag `phase5-page-transition-refactor` 已创建并指向 HEAD

## 验证清单

- [x] `pnpm lint` 通过：0 errors / 25 warnings（pre-existing）
- [x] `pnpm build` 通过
- [x] `pnpm test` 全 PASS：21 files / 154 tests
- [x] Playwright spec 文件语法正确，能被 `--list` 识别
- [x] git tag `phase5-page-transition-refactor` 已创建并指向 HEAD
- [x] 5 commits + 1 tag 已 push 到 `origin/feat/frontend-motion-system`

## 关键 commit

```
05494fdb test(动效): Playwright 补 ai-chat 视口高度回归
5f6cd124 test(动效): layout test 补 ai-chat full-bleed 路由渲染断言
c8498be9 test(动效): page-transition 补 full-bleed/normal 路由分支断言
268cdd4a refactor(动效): PageTransition 拆 Normal/FullBleed 变体 + 路由 helper 接入
e2bea8e1 feat(动效): 提取 isFullBleedDashboardRoute helper + 单测
```

## 关键文件变更

**新建**：
- `frontend/lib/motion/routes.ts`（25 行，纯函数 helper）
- `frontend/lib/motion/routes.test.ts`（5 个用例）
- `frontend/components/motion/NormalPageTransition.tsx`
- `frontend/components/motion/FullBleedPageTransition.tsx`
- `frontend/tests/dashboard/ai-chat-viewport.spec.ts`

**修改**：
- `frontend/components/motion/PageTransition.tsx`（改为 8 行 dispatcher）
- `frontend/components/motion/page-transition.test.tsx`（+2 分支断言）
- `frontend/app/dashboard/layout.test.tsx`（+1 full-bleed 断言）
- `frontend/components/chat/ai-chat-window.tsx`（+1 `data-testid`）

## 关键架构成果

1. **路由判断纯函数化**：`isFullBleedDashboardRoute(pathname)` 无 React 依赖，可独立测试 + 复用
2. **变体分离**：NormalPageTransition / FullBleedPageTransition 语义清晰，dispatcher 自动选
3. **向后兼容**：外部 `import { PageTransition }` 不变
4. **扩展性**：未来新增 full-bleed 页面只需在 `FULL_BLEED_DASHBOARD_ROUTES` 数组加字符串
5. **回归保护**：
   - 单元测试：routes + page-transition + layout 全覆盖
   - E2E 测试：Playwright 视口高度回归（CI 跑）

## 已知 caveat

- Playwright spec 文件本身语法 OK，但实际运行需要 `./tests/.auth/user.json` 登录态（CI setup 流程）。本地可手动跑。

## 下一阶段

✅ Phase 5 完成 → 进入 **Phase 6**（Phase 2/3 推广：spotlight + stagger + u-* 扩散到全站高频表面）。

详细任务在 `2026-07-11-frontend-motion-system-phase6-promotion.md`（后续 Phase 6 计划时创建）。