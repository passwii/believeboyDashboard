# Phase 0 — 地基（motion/z-index/spotlight token + JS 镜像 + framer-motion variants）

> **父 plan：** `docs/superpowers/plans/2026-07-11-frontend-motion-system.md`
> **执行日期：** 2026-07-11
> **执行者：** 子智能体（subagent-driven-development 调度）
> **分支：** `feat/frontend-motion-system`
> **状态：** ✅ **完成**

## 当前调研摘要（来自前置 Explore agent）

- `globals.css`（932 行）：
  - `--motion-*` / `--z-*` / `--spot-*` / `--stagger-step` 已存在（line 79–99，commit `f092150c`）
  - 现有 `@media (prefers-reduced-motion: reduce)` 4 处（line 309/376/869/928）
  - 现有 `@media (prefers-reduced-transparency: reduce)` 仅 1 处（line 473，仅 sidebar）
- `frontend/lib/motion/` 与 `frontend/components/motion/` 目录不存在（已创建）
- 测试命令：`pnpm test` = `vitest run`；`pnpm test:watch` = `vitest`

## 任务清单

### ✅ 任务 0.1（已被用户手动完成 — token 已在 f092150c）
- [x] `:root` 块尾部追加 `--motion-spring-press` / `--stagger-step` / `--z-*` / `--spot-*`
- [x] commit `f092150c` — chore(动效): 同步 globals.css motion/z-index/spotlight token 与 main 一致

### ✅ 任务 0.2 — globals.css 新增 `.u-*` 规范 utility + reduced 守卫
- [x] 在 `@layer components` 追加 `.u-interactive` / `.u-press` / `.u-focus`（实测 line 477–501）
- [x] 在 `@layer utilities` 追加 `.u-stagger-item`（实测 line 726）
- [x] 在 `@media (prefers-reduced-motion: reduce)` 末尾追加 `.u-*` 退化块（line 936–945）
- [x] 在 `@layer components` 闭合后追加独立 `@media (prefers-reduced-transparency: reduce)` 块（line 571–576）
- [x] grep `.u-(interactive|press|focus|stagger-item)` 命中 4 个类定义 + 5 行 reduced-motion 守卫
- [x] `pnpm build` 通过
- [x] commit `8de245cc` — feat(动效): 新增 .u-interactive/.u-press/.u-focus/.u-stagger-item 规范

> **疑虑记录**：实现者中途误删 `@layer components` 闭合括号，后修复。Spec reviewer 独立验证所有 `@layer` 配对正确（325/569、578/764、951/970 三对），最终结构对称无残留。

### ✅ 任务 0.3 — 收编存量 utility 引用 token
- [x] `.hover-lift`（原 line 538–555）合并两段重复定义为单段（实测现 line 587 + line 594 :hover）
- [x] `.send-btn` / `.action-btn` / `.web-search-toggle` / `.panel-toggle` / `.settings-panel` / `.prompt-textarea` / `.message-content` / `.conversation-item` 已是 token，保持不变
- [x] `grep -c "transition:"` 计数 = 15（12 处正面 + 3 处 reduced-motion 重置），未上升
- [x] `pnpm build` 通过
- [x] commit `2cf6e270` — refactor(动效): 收编 .hover-lift 等存量 utility 引用 token 去重

### ✅ 任务 0.4 — JS 镜像常量 `lib/motion/tokens.ts`
- [x] TDD：`tokens.test.ts` 6 个 it() 块断言 DURATION / EASE / SPRING / STAGGER / Z / isReducedMotionDefault
- [x] 确认 FAIL（modulenot found）
- [x] 实现 `tokens.ts`（EASE 用 `as [number, number, number, number]`、SPRING 用 `as const`、注释强调与 globals.css 一一对应）
- [x] 确认 PASS（132 tests）
- [x] commit `4c8859be` — feat(动效): 新增 JS 镜像 motion token + 单测

> **额外字段**（非 spec 强制但保留）：`EASE.springBack`、`SPRING.press`、`STAGGER.childDelay` 是 spec 之外的扩展，token 注释已声明"改这里必须同步改 globals.css"，未造成 lint/test/build 失败。

### ✅ 任务 0.5 — framer-motion variants `lib/motion/variants.ts`
- [x] TDD：`variants.test.ts` 6 个 it() 块断言 pageTransitionContainer / fadeUp / staggerContainer / staggerItem / pressTap
- [x] 确认 FAIL → 实现 → 1 test FAIL（`staggerItem` animate 深比较）→ 调整为顶层 transition → PASS
- [x] commit `44e86173` — feat(动效): 新增 framer-motion variants (page/fadeUp/stagger/press)

> **`as Variants` cast 合理**：framer-motion 12 类型不允许顶层 transition，但运行时支持。3 个函数（pageTransitionContainer / fadeUp / staggerItem）使用 cast + line 8-11 注释说明。staggerContainer / pressTap 严格符合 `Variants` 类型，无需 cast。

## 验证清单

- [x] `pnpm lint` 通过：0 errors / 25 warnings（全部 pre-existing react-hooks/exhaustive-deps）
- [x] `pnpm build` 通过：仅 1 个 pre-existing NFT warning（与 Phase 0 无关）
- [x] `pnpm test` 全 PASS：13 files / 132 tests / 9.08s
- [x] git log 最近 4 个 commit 全部包含 type=feat/refactor/chore(动效): 前缀
- [x] grep 审计：`.u-*` 在 globals.css 中能匹配到 4 个新类 + 5 行 reduced-motion 守卫
- [x] `@layer` 闭合括号配对正确（3 对 layer：325/569、578/764、951/970）

## 关键 commit

```
44e86173 feat(动效): 新增 framer-motion variants (page/fadeUp/stagger/press)
4c8859be feat(动效): 新增 JS 镜像 motion token + 单测
2cf6e270 refactor(动效): 收编 .hover-lift 等存量 utility 引用 token 去重
8de245cc feat(动效): 新增 .u-interactive/.u-press/.u-focus/.u-stagger-item 规范
```

## 关键文件路径

- 修改：`frontend/app/globals.css`
- 新建：`frontend/lib/motion/tokens.ts` + `tokens.test.ts`
- 新建：`frontend/lib/motion/variants.ts` + `variants.test.ts`

## 下一阶段

✅ Phase 0 完成 → 进入 **Phase 1**（全局路由过渡 + 两项结构修正）。

详细任务在 `docs/superpowers/plans/2026-07-11-frontend-motion-system-phase1.md`。