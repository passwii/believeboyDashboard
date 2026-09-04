# Phase 9 — 文档化 + Token v2

> **父 plan：** `docs/superpowers/plans/2026-07-11-frontend-motion-system/2026-07-11-frontend-motion-system.md`
> **依赖：** Phase 0-8 完成 + tag `phase8-perf-a11y`
> **执行日期：** 2026-07-12
> **执行者：** 子智能体（subagent-driven-development 调度）
> **分支：** `feat/frontend-motion-system`
> **状态：** ✅ **完成**

## 任务清单

### ✅ 任务 9.1 — motion-system.md 开发者指南
- [x] `frontend/docs/motion-system.md`（299 行）
- [x] 7 大节：概览 / Token 系统（CSS/JS 对照 + 修改纪律）/ 组件决策树 / Full-bleed 路由 / 无障碍退化 / 调试 checklist / 设计稿同步
- [x] commit `85c9ffd1` — docs(动效): 新增 motion-system 开发者指南

### ✅ 任务 9.2 — tokens.ts 注释增强
- [x] 文件顶部加全局对照表注释（CSS/JS 一一对应 + 单位转换说明 + 修改纪律）
- [x] 每个常量加 1-2 行用途注释
- [x] `frontend/lib/motion/tokens.ts`（+35 行注释）
- [x] commit `cac8a260` — docs(动效): tokens.ts 添加 CSS/JS 对照表与修改纪律注释

### ✅ 任务 9.3 — v2 token 优化建议调研报告
- [x] `docs/superpowers/plans/2026-07-11-frontend-motion-system/2026-07-11-frontend-motion-system-v2-token-recommendations.md`（185 行）
- [x] 调研数字真实（grep 结果直接填入）
- [x] 关键发现：
  - **Z.\* 五档全部双重未用**（CSS 与 JS 都 0 引用）— Phase 0 定义但未迁移
  - **EASE.springBack 双重未用**
  - **SPRING.press 双重未用**
  - **DURATION.fast / DURATION.slow / EASE.standard / STAGGER.step** JS 0 引用但 CSS 多处用 — 错位（仅 CSS 用）
- [x] commit `81026891` — docs(动效): v2 token 优化建议调研报告

### ✅ 任务 9.4 — Phase 9 整体验证 + tag
- [x] lint 0 errors / build pass / test **154 passed (21 files)**（零回归）
- [x] tag `phase9-docs` 已创建并指向 HEAD

## 验证清单

- [x] `pnpm lint` 通过：0 errors / 25 warnings（pre-existing）
- [x] `pnpm build` 通过
- [x] `pnpm test` 全 PASS：21 files / 154 tests
- [x] git tag `phase9-docs` 已创建
- [x] 3 commits + 1 tag 已 push 到 `origin/feat/frontend-motion-system`

## 关键 commit

```
81026891 docs(动效): v2 token 优化建议调研报告
cac8a260 docs(动效): tokens.ts 添加 CSS/JS 对照表与修改纪律注释
85c9ffd1 docs(动效): 新增 motion-system 开发者指南
```

## v1 token 使用密度（关键发现）

| Token | JS 引用 | CSS 引用 | 状态 |
|-------|---------|----------|------|
| `DURATION.fast` | 0 | 29 | ⚠️ JS/CSS 错位（仅 CSS 用） |
| `DURATION.base` | 4 | 8 | ✅ 对齐 |
| `DURATION.slow` | 0 | 4 | ⚠️ JS/CSS 错位（仅 CSS 用） |
| `DURATION.springPress` | 1 | 2 | ✅ 对齐 |
| `EASE.out` | 4 | 36 | ✅ 对齐 |
| `EASE.standard` | 0 | 14 | ⚠️ JS/CSS 错位（仅 CSS 用） |
| `EASE.springBack` | 0 | 0 | 🗑️ 双重未用 |
| `SPRING.page` | 3 | 0 | ✅ 仅 JS（设计如此） |
| `SPRING.press` | 0 | 0 | 🗑️ 双重未用 |
| `STAGGER.step` | 0 | 1 | ⚠️ JS/CSS 错位（仅 CSS 用） |
| `STAGGER.childDelay` | 2 | 0 | ✅ 仅 JS（设计如此） |
| `Z.nav / overlay / modal / toast / grain` | 0 | 0 | 🗑️ 全部双重未用 |

**Phase 10+ 决策项**（用户审阅 v2 报告后决定）：
- 删除 `EASE.springBack` / `SPRING.press` / `Z.*`（0 引用）
- JS 侧保留 `DURATION.fast/slow`、`EASE.standard`、`STAGGER.step` 作为 mirror（即便 0 引用，仍是有价值的中央定义）
- 决定哪些是"v2 优化"、哪些是"v1 延续"

## 关键文件

**新增**：
- `frontend/docs/motion-system.md`（299 行）
- `docs/superpowers/plans/2026-07-11-frontend-motion-system/2026-07-11-frontend-motion-system-v2-token-recommendations.md`（185 行）

**修改**：
- `frontend/lib/motion/tokens.ts`（+35 行注释）

## 总览（Phase 0-9 完整交付）

| 维度 | 数据 |
|------|------|
| phase tag | **9 个**（phase1-9，phase4 嵌入 v1）+ `v1-motion-system` |
| 动效 commit | **35 个**（含 4 个 hotfix） |
| Playwright spec files | 8 个 |
| Vitest tests | 154 passed (21 files) |
| 文档 | 9 个 phase 进度 md + motion-system.md + v2-token-recommendations.md + 父 plan |
| 关键文件 | tokens.ts / variants.ts / 4 个 primitive / DashboardSurfaceCard / PageTransition 变体 / global CSS utility |

## 🎉 v2-motion-system 阶段全面交付

动效系统从代码资产沉淀为**组织资产**：

- **代码层**：32 个动效组件 / hook / 变体，154 tests pass
- **测试层**：Vitest 单元 + Playwright e2e（4 spec 含性能 / a11y / reduced 退化）
- **CI 层**：`.github/workflows/motion-system-ci.yml` 自动跑回归
- **文档层**：motion-system.md 开发者指南 + 9 个 phase 进度 md + v2 token 调研
- **Tag 体系**：9 个 phase tag + v1-motion-system 终态 tag，**任意 phase 可回滚**

## 用户决策项（v2 token 优化）

见 `docs/superpowers/plans/2026-07-11-frontend-motion-system/2026-07-11-frontend-motion-system-v2-token-recommendations.md`。建议：

- **立即清理**：`EASE.springBack` / `SPRING.press` / `Z.*`（5 个 token）0 引用可删除
- **保留 mirror**：`DURATION.fast / slow` / `EASE.standard` / `STAGGER.step` JS 侧 0 引用但仍有 mirror 价值（中央定义）
- **可选**：基于 Phase 0-8 实际手感微调 spring stiffness/damping（如 SPRING.page damping 30 → 26 更"死"）

## 接下来

动效系统 v1 已交付 + 文档化 + 调研完成。后续可选方向：

1. **采纳 v2 调研建议**：清理冗余 token + 微调参数
2. **PR 准备**：用户决定合并到 main / 提 PR 策略
3. **新需求驱动**：业务推动新增动效场景（如数据可视化图表入场、列表排序动画）

按项目节奏推进。Phase 0-9 完整收尾。