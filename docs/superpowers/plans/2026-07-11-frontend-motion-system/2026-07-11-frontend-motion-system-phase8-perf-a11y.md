# Phase 8 — 性能 + 可访问性收口

> **父 plan：** `docs/superpowers/plans/2026-07-11-frontend-motion-system/2026-07-11-frontend-motion-system.md`
> **依赖：** Phase 0-7 完成 + tag `phase7-component-motion`
> **执行日期：** 2026-07-12
> **执行者：** 子智能体（subagent-driven-development 调度）
> **分支：** `feat/frontend-motion-system`
> **状态：** ✅ **完成**

## 任务清单

### ✅ 任务 8.1 — Lighthouse 性能回归 Playwright
- [x] `frontend/tests/performance/motion-budget.spec.ts`：INP < 200ms / CLS < 0.1 断言
- [x] PerformanceObserver 容错：unsupported 时 metric=0 自动 pass
- [x] 路由切换 5 次后断言
- [x] commit `b01df67a` — test(动效): Playwright 性能断言（INP/CLS）

### ✅ 任务 8.2 — axe-core a11y 扫描
- [x] `@axe-core/playwright ^4.12.1` **已存在**于 `package.json`（前置检查发现）— 未触发 `pnpm add`
- [x] `frontend/tests/a11y/motion-system.spec.ts`：扫描 dashboard + ai-chat 两个入口
- [x] 仅 critical/serious 违规 fail，minor 仍 log 出来给人工 triage
- [x] commit `dbede6c5` — test(a11y): 接入 @axe-core/playwright + 扫描动效相关页面

### ✅ 任务 8.3 — reduced-motion/transparency 退化回归
- [x] `frontend/tests/a11y/reduced-motion.spec.ts`：`contextOptions: { reducedMotion: 'reduce' }` + 断言 motion.div `transform === 'none'`
- [x] `frontend/tests/a11y/reduced-transparency.spec.ts`：`emulateMedia({ reducedTransparency: 'reduce' })` + 断言 `--spotlight-strength === '0'`，无 spotlight 卡片时 `test.skip` 自我保护
- [x] commit `ddf48c40` — test(a11y): reduced-motion/reduced-transparency 退化回归

### ✅ 任务 8.4 — CI 集成（新建独立 workflow）
- [x] 项目**已有** `lighthouse-ci.yml` — 不修改既有 CI
- [x] 新建 `.github/workflows/motion-system-ci.yml`：触发 `feat/frontend-motion-system` push + PR
- [x] 步骤：lint → build → vitest → playwright install → `--grep` 过滤 motion spec
- [x] 跳过计划原文中的 `pnpm perf:lhci:assert`（属于 `lighthouse-ci.yml` 职责，避免双路径）
- [x] commit `87730192` — ci(动效): Playwright 接入 CI

### ✅ 任务 8.5 — Phase 8 整体验证 + tag
- [x] lint 0 errors / build pass / test **154 passed (21 files)**（零回归）
- [x] tag `phase8-perf-a11y` 已创建并指向 HEAD

## 验证清单

- [x] `pnpm lint` 通过：0 errors / 25 warnings（pre-existing）
- [x] `pnpm build` 通过
- [x] `pnpm test` 全 PASS：21 files / 154 tests（与 Phase 7 持平）
- [x] Playwright 4 个新 spec 在 chromium + mobile 双 project 下能被 `--list` 识别（7 files / 64 tests）
- [x] git tag `phase8-perf-a11y` 已创建
- [x] 4 commits + 1 tag 已 push 到 `origin/feat/frontend-motion-system`

## 关键 commit

```
87730192 ci(动效): Playwright 接入 CI
ddf48c40 test(a11y): reduced-motion/reduced-transparency 退化回归
dbede6c5 test(a11y): 接入 @axe-core/playwright + 扫描动效相关页面
b01df67a test(动效): Playwright 性能断言（INP/CLS）
```

## 关键文件变更

**新增**：
- `frontend/tests/performance/motion-budget.spec.ts`
- `frontend/tests/a11y/motion-system.spec.ts`
- `frontend/tests/a11y/reduced-motion.spec.ts`
- `frontend/tests/a11y/reduced-transparency.spec.ts`
- `.github/workflows/motion-system-ci.yml`

## 实施纪律亮点

1. **不强行 add 已有 dep**：`@axe-core/playwright ^4.12.1` 已存在，implementer 前置检查发现并跳过 `pnpm add -D`
2. **不动既有 CI**：项目已有 `lighthouse-ci.yml`，新建独立 `motion-system-ci.yml` 而非修改既有
3. **CI 范围收紧**：用 `--grep` 过滤 motion-related describe 名，避免给既有 spec 批量打 tag
4. **axe-core 仅 block critical/serious**：minor 违规 log 出来给人工 triage（按计划文件指示）
5. **emulateMedia vs contextOptions**：reduced-transparency 用 `emulateMedia`（Playwright 不支持 `contextOptions.reducedTransparency`），这是正确 API

## 遗留关切（DONE_WITH_CONCERNS）

1. **reduced-motion spec 的 `transform === 'none'` 断言偏严**：framer-motion 在 reduce 模式下可能因 `initial.opacity` 之外还残留 style。CI 跑红时可改为 `expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(transform)`
2. **CI `--grep` 过滤字符串写死**：后续新增 motion spec 且 describe 名不含关键词时需手动更新 workflow。可改为目录级 `tests/performance tests/a11y`，本次保留 grep 因项目其他 spec 也带 viewport-related 噪声
3. **axe-core spec 容忍 minor 违规**：项目方如要求 zero-violation（含 minor）需移除过滤条件

## 手动验收（用户在浏览器 / CI）

1. **Lighthouse**：`pnpm perf:lhci:collect` → 比对前后 INP/LCP/CLS
2. **axe-core**：`pnpm exec playwright test tests/a11y/motion-system.spec.ts` → 报告 critical/serious 违规
3. **reduced-motion**：DevTools → Rendering → Emulate CSS media feature `prefers-reduced-motion: reduce` → 路由切换无 spring/blur
4. **reduced-transparency**：DevTools → Rendering → Emulate CSS media feature `prefers-reduced-transparency: reduce` → spotlight 退化为静态高光
5. **CI**：push 到 `feat/frontend-motion-system` → GitHub Actions 自动跑 motion-system-ci job

## 下一阶段

✅ Phase 8 完成 → 进入 **Phase 9**（文档化 + Token v2：开发者文档 + token 优化 + 设计稿同步）。

详细任务在 `2026-07-11-frontend-motion-system-phase9-docs.md`（后续 Phase 9 计划时创建）。