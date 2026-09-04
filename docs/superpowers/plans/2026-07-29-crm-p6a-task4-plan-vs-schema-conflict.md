# P6a Task 4 — Plan vs Schema vs Design Spec 冲突（待用户拍板）

**日期**：2026-07-29
**关联**：`docs/superpowers/plans/2026-07-29-crm-p6a-value-tier.md` Task 4

## TL;DR

Task 4 的 6 个测试里有 **3 个的断言与 DB schema 不兼容**（断言 `rating is None`，但 `crm_customers.rating` 是 NOT NULL DEFAULT 'C'）。
设计 spec 与 plan 实现代码都正确（"partial → rating 保持原值不动"），但 plan 测试写错了。
**修复方向有 2 个，需用户拍板**（已停手，未改测试 / 未 commit Task 4）。

## 三方冲突

| 来源 | 立场 |
|---|---|
| **设计 spec** §3.2 line 57 | "任一为空 → rating 保持原值不动" |
| **设计 spec** §3.3 line 62 | "老客户 4 维为 NULL，rating 保留原值" |
| **Plan 代码** Step 3 | 与 spec 一致（不动 rating on partial） |
| **Plan 测试** | 断言 `cust.rating is None`（与前 3 方冲突） |
| **DB schema**（Task 1 migration 后） | `rating VARCHAR(2) NOT NULL DEFAULT 'C'` |

## 失败测试详情（已跑过，3 红 13 绿）

| 测试 | 失败原因 |
|---|---|
| `test_update_scores_full_set_recomputes` | 断言 `old is None`，实为 `old == "C"`（DB default） |
| `test_update_scores_partial_keeps_rating` | 断言 `cust.rating is None`，实为 `cust.rating == "C"`（未触动） |
| `test_update_scores_commit_false_no_autocommit` | SessionLocal 读 committed data → `"C"`（fixture commit 的 default），未 `None` |

实现已按 plan 写完，13 测试通过：
- `compute_rating` × 10 ✓
- `update_scores` 3 测试通过：`test_update_scores_legacy_rating_overwritten` / `test_update_scores_invalid_grade_raises` / `test_update_scores_customer_not_found`

## 两条修复路径（请用户选）

### 选项 A — 修测试断言以匹配现状（最小改动）
把 3 个红测试的 `is None` 改成 `== "C"`（或 `== old_rating`）。优点：
- 不动 schema、不加 migration
- 与设计 spec 完全一致
- 立即可绿，Task 4 可推进

但 `test_update_scores_commit_false_no_autocommit` 的 `is None` 断言本身没意义（commit=False 时 rating 不会从 None 变过来）——需重写该测试断言为"rating 仍是旧值（`== "C"`）"或"score 列变更未持久化（仍是 NULL）"。

### 选项 B — 加 migration 让 rating 可空（最干净，但超 Task 4 范围）
新 migration：把 `rating` 改成 `nullable=True, default=None`。然后模型也改 `Mapped[str | None]`。优点：
- 与 plan 测试 1:1 对应（`old is None` / `cust.rating is None`）
- 设计更灵活（"未评"是合法状态）

缺点：
- Task 4 引入新 migration，超出 plan 范围（plan 只说 update_scores）
- 既有依赖 rating NOT NULL 的代码（如某些前端 fallback）需要 grep 检查

## 我的推荐

**选 A**。理由：
1. 设计 spec 已明确"rating 保留原值"——这是权威意图
2. Plan 测试的 `is None` 写法是 plan 作者笔误（与自己的实现代码矛盾）
3. 选 B 会让 Task 4 范围膨胀（加 migration + model 改 + 回归检查）
4. TDD 验证环节的标准动作就是"发现测试断言错就修测试"，符合"严格 TDD"精神

## 当前状态

- 已实现 `update_scores`（per plan 代码 + 设计 spec）
- 13 测试绿、3 测试红
- **未 commit Task 4**（等用户拍板）
- WIP 未污染：`git diff --stat` 只显示我的 2 文件 + 1 个前端文件（别人）

## 等待指令

请告诉 Damon：
- **(A)** 改测试断言 → 我立即完成 Task 4 并 commit
- **(B)** 加 migration 让 rating 可空 → 我先扩 plan / 加 1 个 migration，再回 Task 4
- **(C)** 暂停 / 其他方案