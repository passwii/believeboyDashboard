# Amazon 评论追踪阶段 B 实施计划（总览）

> **面向 AI 代理的工作者：** 必需子技能：使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务实现。分册内步骤用复选框（`- [ ]`）跟踪进度。
> **分册：** [B1 数据模型与迁移](./2026-10-16-amazon-review-tracking-phase-b1-data-model.md) · [B2 采集写入服务](./2026-10-16-amazon-review-tracking-phase-b2-ingestion-service.md) · [B3 运营 API 与整合](./2026-10-16-amazon-review-tracking-phase-b3-ops-api.md)

**目标：** 落地阶段 B 后端——5 张新表 + 迁移 `282`，采集结果写入服务（幂等 / 同日快照 upsert / 完整列表两连缺失判定），以及运营查询与外部竞品关联 API。

**架构：** 新建 `amazon_review_targets` 作为快照 / Review / 运行记录的**唯一挂载点**（`kind=internal_group|external_asin`）；内部目标与阶段 A 组 1:1 并在组服务中同步，外部目标按 `(marketplace, asin)` 唯一。解析与写入规则集中在服务层（阶段 D 的 Agent 接口复用），运营 API 只做薄封装。

**技术栈：** Python 3、FastAPI、Pydantic v2、SQLAlchemy 2、Alembic、PostgreSQL、pytest。

**设计来源：** [`../../specs/2026-10-16-amazon-review-tracking-phase-b-design.md`](../../specs/2026-10-16-amazon-review-tracking-phase-b-design.md)（下称「B 规格」）。

---

## 覆盖映射（规格 → 任务）

| 规格章节 | 覆盖任务 |
| --- | --- |
| §2.1 `targets` | B1 Task 1 |
| §2.2 `rating_snapshots` | B1 Task 1 |
| §2.3 `reviews` | B1 Task 1 |
| §2.4 `crawl_runs` | B1 Task 1 |
| §2.5 `external_links` | B1 Task 1 |
| §5 内部目标同步 | B1 Task 2 |
| §4 写入服务行为 | B2 Task 3 |
| §5 运营查询 API | B3 Task 4 |
| §5 外部竞品关联 API | B3 Task 5 |
| §3 口径约束 / §6 权限 / §7 合规 | 贯穿（B1 schema、B2 服务、B3 权限） |
| 迁移 `282` | B1 Task 1 |

---

## 前置条件

- [ ] **同步 main 取单链**：`git fetch origin && git merge-base --is-ancestor 3d7b7b84 origin/main && ls backend/alembic/versions | grep -E '^2026' | sort | tail -3`，确认本分支 head 仍为 `281`（`origin/main` 当前为 `280`）。若 main 已推进到 ≥281，先 rebase 再重新分配 rev-id。
- [ ] **环境**：使用主仓 venv `/Users/damon/DamonProjects/believeboyDashboard/backend/.venv/bin/python`（Python 3.14.8 / pytest 8.3.4 / pytest-asyncio 1.3.0）。`TEST_DATABASE_URL` 指向 `BLF_test`，**用 Python 解析** `backend/.env.test`（勿用 `source`，见 [失败集对账文档](./task-5-failure-reconciliation.md) §环境与方法）。
- [ ] **T3 判定**：本次改动含**迁移 + model + 共享服务** → 收尾必须跑后端**全量一次**并按失败集规则对账（复用 B3 Task 6 的对账流程；基线失败集已存档）。

## 全局约束

- 迁移文件 `YYYYMMDD_NNN_description.py`，rev-id 纯数字，本条为 `282`。
- 新表主键 `Integer`；引用 `projects.id` / `product_costs.id` / `project_shops.id` 的外键列按被引用列实际类型用 `BigInteger().with_variant(Integer, "sqlite")`。
- 关系变更**不迁移历史**；快照/Review 一经写入不跨目标搬移。
- 查询接口用 `get_read_db_session`，写接口用 `get_primary_db_session`；写操作 `append_operation_audit_log` + 异常整体 `rollback`。
- 业务日期归到固定 `Asia/Shanghai`；`captured_at` 存真实带时区时刻。
- 空值语义：缺采/失败一律 `NULL` + 状态列，禁止写 0。
- 禁止 `pytest -n auto`。
- 每个任务结束单独 commit，中文 Conventional Commits。

## 执行方式

分册顺序：**B1 → B2 → B3**。B1 必须先落（其余依赖新表）。B2 不依赖 B3，B3 依赖 B1+B2。
