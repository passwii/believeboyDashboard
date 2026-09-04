# Phase 11 — PR 准备

> **父 plan：** `docs/superpowers/plans/2026-07-11-frontend-motion-system/2026-07-11-frontend-motion-system.md`
> **依赖：** Phase 0-10 完成 + tag `phase10-v2-cleanup`
> **执行日期：** 2026-07-12
> **执行者：** 子智能体（subagent-driven-development 调度）
> **分支：** `feat/frontend-motion-system`
> **状态：** ✅ **完成**

## 任务清单

### ✅ 任务 11.1 — PR description 草稿
- [x] `docs/superpowers/plans/2026-07-11-frontend-motion-system/2026-07-11-frontend-motion-system-pr-description.md`（218 行 / 12,417 bytes）
- [x] 47 commits 按 12 个 phase 区段全部列出，hash 与 `git log origin/feat/frontend-motion-system` 实际一致
- [x] Summary / Changes by Phase / Test Report / Tag List / Migration Notes / Manual Verification / Related Docs / Future Work 全覆盖
- [x] **未 commit**（辅助文档，不污染动效分支）

### ✅ 任务 11.2 — PR 创建命令 + CHANGELOG
- [x] `phase11-pr-prep.md` 追加"PR 创建指南"段：gh CLI 完整命令 + GitHub 网页手动选项 + 合并策略决策 + 注意事项
- [x] `CHANGELOG.md`（45 行 / Keep a Changelog 1.1.0 格式 / Semantic Versioning / Unreleased 段含 Added / Changed / Removed）
- [x] **未 commit**（辅助文档）

### ✅ 任务 11.3 — Phase 11 验证 + tag
- [x] PR description > 200 行 ✓
- [x] phase11-pr-prep.md 含 `gh pr create` 命令 ✓
- [x] CHANGELOG.md 存在 ✓
- [x] tag `phase11-pr-prep` 已创建并 push 到 remote（`28d5b901983a2972c642fdf5d00884f54d111317`）

## 远程 tag 列表（11 个）

```
v1-motion-system
phase1-motion-transition
phase2-hover-active
phase3-premium-stagger
phase5-page-transition-refactor
phase6-promotion
phase7-component-motion
phase8-perf-a11y
phase9-docs
phase10-v2-cleanup
phase11-pr-prep
```

任意 phase 可独立回滚。

## 验证清单

- [x] PR description 内容完整（218 行）
- [x] PR 创建命令可执行（gh CLI / GitHub 网页两种选项）
- [x] CHANGELOG.md 格式正确（Keep a Changelog 1.1.0）
- [x] Phase 11 辅助文档**未 commit** 到动效分支（避免污染）
- [x] git tag `phase11-pr-prep` 已创建并 push 到 remote

## 用户后续操作

### 选项 A：使用 gh CLI（推荐）

```bash
gh pr create \
  --base main \
  --head feat/frontend-motion-system \
  --title "feat(前端动效): 建立 Apple 级动效设计系统 v1" \
  --body-file docs/superpowers/plans/2026-07-11-frontend-motion-system/2026-07-11-frontend-motion-system-pr-description.md \
  --label "frontend,motion-system"
```

### 选项 B：手动 GitHub 网页

1. 打开 https://github.com/passwii/believeboyDashboard/compare/main...feat/frontend-motion-system
2. 复制粘贴 `docs/superpowers/plans/2026-07-11-frontend-motion-system/2026-07-11-frontend-motion-system-pr-description.md` 内容到 PR body
3. 设置 reviewer + label

### 合并策略建议

- **merge commit**：保留 phase tag 历史（推荐，便于未来 revert）
- **squash and merge**：简洁历史，但丢失 phase tag 关联（不推荐）

## 🎉 动效系统 v1 完全收尾

**Phase 0-11 全部完成**：

| 维度 | 数据 |
|------|------|
| **phase tag** | **11 个** + `v1-motion-system` 终态 |
| **动效 commit** | **37 个**（含 4 个 hotfix） |
| **删除的冗余 token** | 8 个（5 z-index + 3 JS 常量） |
| **vitest tests** | 154 passed (21 files) |
| **Playwright spec files** | 8 个（含性能 / a11y / reduced 退化 / ai-chat 视口回归） |
| **CI 接入** | `.github/workflows/motion-system-ci.yml` |
| **文档** | 父 plan + 11 个 phase 进度 md + motion-system.md + v2-token-recommendations + PR description + CHANGELOG |

### 完整交付清单

1. **代码**：tokens / variants / 4 个 primitive / PageTransition 双变体 + dispatcher / DashboardSurfaceCard / useSpotlight / 8 个 UI 组件接入 / Skeleton shimmer / ai-chat 动效
2. **测试**：154 vitest + 8 Playwright（含 INP/CLS 断言 + a11y 扫描 + reduced 退化）
3. **CI**：GitHub Actions 自动跑 motion-system-ci
4. **文档**：开发者指南 + 决策树 + 调试 checklist + token 对照表 + 修改纪律
5. **PR-ready**：47 commit 摘要 + gh CLI 创建命令 + CHANGELOG + 合并策略建议
6. **可回滚**：任意 phase tag 独立 `git revert`

### 用户决策项

- **何时创建 PR**：用户决定（命令已就绪，gh CLI 一行）
- **何时合并到 main**：用户决定（merge commit 推荐保留 phase tag 历史）
- **v2 token 数值微调**：用户基于真实手感决定（调研报告已就位）

### 项目级交付物（不污染动效分支，留在工作区）

- `docs/superpowers/plans/2026-07-11-frontend-motion-system/2026-07-11-frontend-motion-system-pr-description.md` — 给用户复制到 GitHub PR
- `CHANGELOG.md` — 给用户决定是否推到 main 时一起合并

按用户节奏推进。Phase 0-11 完整收尾。