# Phase 10 — v2 Token 优化实施（清理冗余）

> **父 plan：** `docs/superpowers/plans/2026-07-11-frontend-motion-system.md`
> **依赖：** Phase 9 完成 + tag `phase9-docs` + v2-token-recommendations.md 调研结论
> **执行日期：** 2026-07-12
> **执行者：** 子智能体（subagent-driven-development 调度）
> **分支：** `feat/frontend-motion-system`
> **状态：** ✅ **完成**

## 任务清单

### ✅ 任务 10.1 — 删除冗余 token
- [x] grep 确认 CSS / JS / 测试中均无 z-* / springBack / SPRING.press 引用
- [x] `frontend/app/globals.css` — 删除 `--z-nav / --z-overlay / --z-modal / --z-toast / --z-grain` 5 行
- [x] `frontend/lib/motion/tokens.ts` — 删除 `EASE.springBack` 字段 + `SPRING.press` 字段 + 整个 `Z` 对象
- [x] `frontend/lib/motion/tokens.test.ts` — 删除 `Z scale` 断言块；新增 active keys 守卫测试（保持总测试数 154）
- [x] commit `d3a96fdf` — refactor(动效): 删除 v2 调研建议的 0 引用冗余 token（Z.* / EASE.springBack / SPRING.press）

### ✅ 任务 10.2 — 更新 motion-system.md
- [x] 删除 CSS 表格 `--z-*` 行
- [x] 删除 JS 表格 `Z.* / EASE.springBack / SPRING.press` 行
- [x] 新增 Phase 10 v2 清理说明
- [x] 同步更新 v2 建议段 + 设计映射中的过期 Z-index 描述
- [x] commit `054a1282` — docs(动效): motion-system.md 反映 v2 token 清理

### ✅ 任务 10.3 — Phase 10 验证 + tag
- [x] lint 0 errors / build pass / test **154 passed (21 files)**（零回归）
- [x] tag `phase10-v2-cleanup` 已创建并指向 HEAD

## 验证清单

- [x] `pnpm lint` 通过：0 errors / 25 warnings（pre-existing）
- [x] `pnpm build` 通过
- [x] `pnpm test` 全 PASS：21 files / 154 tests
- [x] git tag `phase10-v2-cleanup` 已创建
- [x] 2 commits + 1 tag 已 push 到 `origin/feat/frontend-motion-system`

## 关键 commit

```
054a1282 docs(动效): motion-system.md 反映 v2 token 清理
d3a96fdf refactor(动效): 删除 v2 调研建议的 0 引用冗余 token（Z.* / EASE.springBack / SPRING.press）
```

## 关键变更摘要

**删除的 token**：
- CSS：5 个 `--z-*` token（nav / overlay / modal / toast / grain）
- JS：`EASE.springBack` / `SPRING.press` / 整个 `Z` 对象
- 测试：对应 `Z scale covers nav/overlay/modal/toast/grain` 断言块

**保留的 token**（Phase 9 调研建议）：
- `DURATION.fast / slow` JS 0 引用但保留（中央定义价值，与 CSS 对齐）
- `EASE.standard` JS 0 引用但保留（与 CSS 对齐）
- `STAGGER.step` JS 0 引用但保留（与 CSS 对齐）
- 所有在用的 token（DURATION.base / springPress / SPRING.page / STAGGER.childDelay）

**未动的数值**：
- spring 参数（DURATION / EASE / SPRING 数值保持原值）
- 等用户基于真实手感反馈决定是否微调

## 总览（Phase 0-10）

| 维度 | 数据 |
|------|------|
| phase tag | **10 个** + `v1-motion-system` 终态 |
| 动效 commit | **37 个**（含 4 个 hotfix） |
| 删除的冗余 token | 5 z-index + 3 JS 常量 = 8 个 |
| Vitest tests | 154 passed (21 files)（持平） |
| Playwright spec files | 8 个 |

## 接下来

✅ Phase 10 完成 → 进入 **Phase 11 — PR 准备**：

按之前推荐节奏，v2 token 清理已完成。下一步应该是：

1. **PR 准备**：汇总 Phase 0-10 改动 + 写 PR description（changelog + 测试报告 + tag 列表）
2. **新业务场景接入**：按 motion-system.md 决策树（用户业务驱动）
3. **spring 参数微调**：基于真实手感反馈（用户主观判断）

要继续 Phase 11（PR 准备）吗？还是先做其它？