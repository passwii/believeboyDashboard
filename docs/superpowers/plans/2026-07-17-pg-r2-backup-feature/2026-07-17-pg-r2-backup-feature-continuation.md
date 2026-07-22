# 数据库备份功能补完 实现计划（Phase 1 收尾 + Phase 2–5 路线）

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在已有设计文档与半成品代码基础上，补完「前端一键触发 → Celery worker 跑 pgBackRest → 打 tar.gz → 经后端上传 Cloudflare R2 → 前端轮询进度 / 下载 / 恢复预览」端到端链路。

**架构：** 本计划是 [`2026-07-17-pg-r2-backup-feature.md`](./2026-07-17-pg-r2-backup-feature.md)（下称「主 plan」）的**续作 / 执行计划**，不推翻主 plan 任何 frozen 决策，只做三件事：(1) 冻结主 plan 剩余 6 条待评审决策；(2) 精确对账已写代码与主 plan 的偏差；(3) 把剩余工作拆成 TDD 小步骤。Phase 1 给出完整代码，Phase 2 给出核心函数代码，Phase 3–5 给任务清单（每个 phase 开工前再写独立 TDD 子文档，遵循 plans/README 子目录约定）。

**技术栈：** FastAPI · SQLAlchemy 2.0（`Mapped`/`mapped_column`）· Alembic · Celery（`@shared_task` + `acks_late` + 独立 `backups` 队列）· pgBackRest（`--stanza=blf`）· boto3 → Cloudflare R2（复用 `app.services.r2_service`）· Pydantic v2 · Vitest/React（前端，Phase 3）· pytest（后端）。

---

## 0. 为什么有这份续作

主 plan（2026-07-17，496 行）已把设计、风险、测试、验收写全，5/11 决策 frozen。但截至 2026-07-22 代码只推进到 **Phase 1 约 40%**，且存在两处与主 plan 不一致的实现细节（见 §1）。本续作负责把它推到可上线。

---

## 1. 现状精确对账（plan vs code，2026-07-22 核对）

| 主 plan 条目 | 代码现状 | 结论 |
| --- | --- | --- |
| §3.4 DB 加 11 字段 | `backup_record.py` 已有 `phase / triggered_by / retry_count / backup_set_name`（迁移 `20260718_214`） | ✅ 4/11 完成 |
| §3.4 其余 7 字段 `r2_key / r2_url / r2_bucket / r2_uploaded_at / r2_deleted_at / compressed_size_bytes / backup_set_path` + `idx_br_r2_key` | **均未迁移**（grep 全仓 backup_records 无这些列） | ❌ 待补（本计划任务 1–2） |
| §3.1 `enqueue_backup`（API 异步入队） | `backup_service.py:53` 已实现，写 `phase/triggered_by` + `run_backup_task.delay` | ✅ 完成 |
| §3.1 `POST /backups/trigger` 改 5ms 返回 | `endpoints/backups.py:91` **仍调旧同步 `trigger_backup`**，未接 `enqueue_backup` | ❌ 待补（任务 5） |
| §3.1/§3.2 `run_backup_task` 完整入口（行锁 + phase 短路 + 乐观锁） | `celery_tasks/backup.py:39` **仍是 stub**，只 `logger.info` 返回 `{"status":"stub"}` | ❌ 待补（任务 7） |
| §3.5 `backups` 队列路由 + `include` | `celery_app.py` 的 `include` / `task_routes` **均无 backup** | ❌ 待补（任务 6） |
| §11 配置项 `backup_soft/hard_time_limit / r2_retention_count / daily_schedule_hour` | `config.py` 只有 `backup_via_celery` | ❌ 待补（任务 4） |
| §3.3 R2 上传链路（tar.gz + upload） | 无 | ❌ Phase 2 |
| §3.8 前端轮询 / 进度条 | 无 | ❌ Phase 3 |
| §3.6 Celery Beat 03:00 + 独立 worker unit | 无 | ❌ Phase 4 |
| §3.7 R2 retention `cleanup_r2_task` | 无 | ❌ Phase 5 |

### 1.1 已发现的两处偏差（实现时按本续作修正）

- **偏差 A（R2 key 结构）**：主 plan §3.3 假设 key = `db-backups/pgbackrest/blf/{date}_{type}_{record_id}.tar.gz`。但真实 `upload_file_to_r2(settings, file_data, filename, project_slug, file_type)` 内部拼的是 `{project_slug}/{file_type}/{filename}`，且对每段调用 `_sanitize_key`（`filename` 里的 `/` 可能被清洗）。**修正 M1**：统一用 `project_slug="db-backups"`、`file_type="pgbackrest"`、`filename=f"blf_{date}_{type}_{record_id}.tar.gz"`，最终 key = `db-backups/pgbackrest/blf_{date}_{type}_{record_id}.tar.gz`（stanza 名 `blf` 进 filename 而非独立路径段，规避 sanitize 风险）。
- **偏差 B（schema 已半步）**：`schemas/backup.py:53` 的 `BackupStatusSummary` 已多出一个 `r2_storage_bytes` 字段，但 `BackupRecordItem` 尚未透出任何 R2/phase 字段。任务 3 一并补齐 `BackupRecordItem`，`r2_storage_bytes` 的填充留到 Phase 5（retention 统计）。

---

## 2. 冻结剩余 6 条决策（采纳主 plan 推荐 + 修正 M1）

> 用户已授权「续写补完并拍板剩余决策」。以下采纳主 plan 原推荐，仅 §3.3 按修正 M1 调整。如有异议在开工前提出。

| 决策 | 冻结结论 |
| --- | --- |
| §3.2 P0-2 状态机 + 幂等 | `phase` 字段（`pending → pgbackrest_running → compressing → r2_uploading → completed / failed`）+ `SELECT ... FOR UPDATE` 行锁 + 乐观锁 `UPDATE ... WHERE id AND phase=:current`（affected=0 即短路）。R2 上传前 `check_file_exists` 幂等。 |
| §3.4 P0-4 DB 字段 | 补 7 个 R2/审计字段（见任务 1–2），`idx_br_r2_key` 用**部分索引**（`WHERE r2_key IS NOT NULL`，与仓库 `20260522_133` 约定一致）。 |
| §3.5 P1-1 独立队列 | 新增 `backups` 队列，路由 key 用全名 `app.celery_tasks.backup.run_backup_task`（task 已显式 `name=`）；独立 systemd unit `-Q backups -c 1`（Phase 4）。 |
| §3.8 P1-4 前端轮询 | 3s `setInterval` 条件触发（存在 `pending/running/uploading` 才轮询），全部终态后 `clearInterval`；不引 WebSocket/SSE（Phase 3）。 |
| §3.10 P2-1 双触发源 | 不互斥，靠 §3.2 行锁 + 乐观锁兜底；`triggered_by` 区分 `manual/auto`，自动任务 `created_by=null`。 |
| §3.11 P2-2 API 端点 | 6 → 10：新增 `GET /{id}`、`GET /{id}/download-url`、`POST /{id}/restore-dry-run`、`GET /{id}/restore-command`、`DELETE /{id}`、`POST /cleanup`（Phase 2/5 分批落）。 |

---

## 3. 文件结构（剩余工作）

| 文件 | 职责 | 本计划改动 |
| --- | --- | --- |
| `backend/alembic/versions/20260722_215_add_r2_fields_to_backup_records.py` | 纯加列迁移：7 字段 + `idx_br_r2_key`，`down_revision="20260718_214"` | 新建（任务 1） |
| `backend/app/models/backup_record.py` | ORM 模型 | 加 7 字段 + 部分索引（任务 2） |
| `backend/app/schemas/backup.py` | API schema | `BackupRecordItem` 加 phase/triggered_by/retry_count/backup_set_name + 6 个 R2 字段（任务 3） |
| `backend/app/core/config.py` | 配置 | 加 4 个 backup 配置项（任务 4） |
| `backend/.env.example` | 环境变量样例 | 补 4 项 + 注释（任务 4） |
| `backend/app/api/v1/endpoints/backups.py` | API 端点 | `POST /trigger` 接 `enqueue_backup`（任务 5）；Phase 2 加 4 端点 |
| `backend/app/tasks/celery_app.py` | Celery 工厂 | `include` + `task_routes` 加 backup（任务 6） |
| `backend/app/celery_tasks/backup.py` | 备份 Celery task | stub → 完整状态机入口（任务 7）；Phase 2 加 R2 阶段 |
| `backend/app/services/backup_service.py` | pgBackRest 封装 + R2 上传 | 抽 `_run_pgbackrest_backup`（任务 7）；Phase 2 加 `_archive_to_tar_gz` / `_upload_to_r2` / `get_record_by_id` / `get_r2_download_url` |
| `backend/tests/services/test_backup_service.py` 等 | 测试 | 每任务配套 |
| `backend/deploy/systemd/believeboy-worker-backups.service` | 独立 worker unit | Phase 4 新建 |
| `frontend/app/dashboard/system/backup-management/backup-management-client.tsx` | 前端页 | Phase 3 改造 |

---

## 4. Phase 1 补完 —— 异步化承重墙收尾（完整 TDD）

> 目标：手动触发 → API 5ms 返回 `record_id` → worker 在 `backups` 队列跑完 pgBackRest → `status=completed`（**本阶段 R2 还没东西**，Phase 2 接上）。回滚开关 `BACKUP_VIA_CELERY=false` 走旧同步路径不变。

### 任务 1：alembic 迁移加 7 个 R2/审计字段

**文件：**
- 创建：`backend/alembic/versions/20260722_215_add_r2_fields_to_backup_records.py`

- [ ] **步骤 1：写迁移文件**

```python
"""Add R2 + audit fields to backup_records.

Revision ID: 20260722_215
Revises: 20260718_214
Create Date: 2026-07-22 10:00:00

Plan: docs/superpowers/plans/2026-07-17-pg-r2-backup-feature/2026-07-17-pg-r2-backup-feature-continuation.md §3.4 P0-4
补主 plan §3.4 剩余 7 字段（前 4 个已由 20260718_214 落地）。纯加列 + 1 部分索引，downgrade 可回滚。
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision: str = "20260722_215"
down_revision: str | None = "20260718_214"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.add_column("backup_records", sa.Column("r2_key", sa.String(500), nullable=True))
    op.add_column("backup_records", sa.Column("r2_url", sa.String(1000), nullable=True))
    op.add_column("backup_records", sa.Column("r2_bucket", sa.String(200), nullable=True))
    op.add_column("backup_records", sa.Column("r2_uploaded_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("backup_records", sa.Column("r2_deleted_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("backup_records", sa.Column("compressed_size_bytes", sa.BigInteger(), nullable=True))
    op.add_column("backup_records", sa.Column("backup_set_path", sa.String(500), nullable=True))
    op.create_index(
        "idx_br_r2_key",
        "backup_records",
        ["r2_key"],
        postgresql_where=sa.text("r2_key IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("idx_br_r2_key", table_name="backup_records")
    op.drop_column("backup_records", "backup_set_path")
    op.drop_column("backup_records", "compressed_size_bytes")
    op.drop_column("backup_records", "r2_deleted_at")
    op.drop_column("backup_records", "r2_uploaded_at")
    op.drop_column("backup_records", "r2_bucket")
    op.drop_column("backup_records", "r2_url")
    op.drop_column("backup_records", "r2_key")
```

- [ ] **步骤 2：升级 + 验证列存在**

运行：`cd backend && alembic upgrade head && alembic downgrade -1 && alembic upgrade head`
预期：三次均无报错；`psql` 查 `\d backup_records` 能看到 7 个新列 + `idx_br_r2_key`。

- [ ] **步骤 3：Commit**

```bash
git add backend/alembic/versions/20260722_215_add_r2_fields_to_backup_records.py
git commit -m "feat(备份): 迁移 backup_records 的 R2 与审计字段"
```

### 任务 2：ORM 模型加 7 字段 + 部分索引

**文件：**
- 修改：`backend/app/models/backup_record.py`
- 测试：`backend/tests/models/test_backup_record_r2_fields.py`

- [ ] **步骤 1：写失败测试**

```python
# backend/tests/models/test_backup_record_r2_fields.py
from app.models.backup_record import BackupRecord


def test_backup_record_has_r2_and_audit_columns():
    cols = {c.name for c in BackupRecord.__table__.columns}
    for name in (
        "r2_key", "r2_url", "r2_bucket", "r2_uploaded_at",
        "r2_deleted_at", "compressed_size_bytes", "backup_set_path",
    ):
        assert name in cols, f"missing column {name}"
    idx_names = {i.name for i in BackupRecord.__table__.indexes}
    assert "idx_br_r2_key" in idx_names
```

- [ ] **步骤 2：运行验证失败**

运行：`cd backend && pytest tests/models/test_backup_record_r2_fields.py -v`
预期：FAIL（列不存在）。

- [ ] **步骤 3：实现**

`backup_record.py` 顶部 import 追加 `from sqlalchemy import ... Text, func, text`（在现有 `from sqlalchemy import BigInteger, DateTime, Index, Integer, String, Text, func` 末尾加 `, text`）。`__table_args__` 追加索引，类体追加 7 字段：

```python
    __table_args__ = (
        Index("idx_br_status", "status"),
        Index("idx_br_created", "created_at"),
        Index("idx_br_type", "backup_type"),
        Index("idx_br_phase", "phase"),
        Index("idx_br_r2_key", "r2_key", postgresql_where=text("r2_key IS NOT NULL")),
    )
```

```python
    # Phase 2 §3.4 P0-4: R2 上传链路字段
    r2_key: Mapped[str | None] = mapped_column(String(500), nullable=True)
    r2_url: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    r2_bucket: Mapped[str | None] = mapped_column(String(200), nullable=True)
    r2_uploaded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    r2_deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    compressed_size_bytes: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    backup_set_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
```

- [ ] **步骤 4：运行验证通过**

运行：`cd backend && pytest tests/models/test_backup_record_r2_fields.py -v`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add backend/app/models/backup_record.py backend/tests/models/test_backup_record_r2_fields.py
git commit -m "feat(备份): BackupRecord 模型补 R2 与审计字段"
```

### 任务 3：schema `BackupRecordItem` 透出 phase + R2 字段

**文件：**
- 修改：`backend/app/schemas/backup.py`
- 测试：`backend/tests/schemas/test_backup_schema.py`

- [ ] **步骤 1：写失败测试**

```python
# backend/tests/schemas/test_backup_schema.py
from datetime import datetime, timezone

from app.schemas.backup import BackupRecordItem


def test_backup_record_item_exposes_phase_and_r2_fields():
    item = BackupRecordItem(
        id=1, backup_type="full", status="completed",
        started_at=datetime.now(timezone.utc), created_at=datetime.now(timezone.utc),
        phase="r2_uploading", triggered_by="auto", retry_count=1,
        backup_set_name="20260722-030000F",
        r2_key="db-backups/pgbackrest/blf_2026-07-22_full_1.tar.gz",
        r2_url="https://x/db-backups/pgbackrest/blf_2026-07-22_full_1.tar.gz",
        r2_bucket="believeboy", r2_uploaded_at=datetime.now(timezone.utc),
        compressed_size_bytes=12345,
    )
    assert item.phase == "r2_uploading"
    assert item.triggered_by == "auto"
    assert item.r2_key.endswith(".tar.gz")
    assert item.compressed_size_bytes == 12345
```

- [ ] **步骤 2：运行验证失败**

运行：`cd backend && pytest tests/schemas/test_backup_schema.py -v`
预期：FAIL（`phase` 等字段未定义，Pydantic 报 extra/missing）。

- [ ] **步骤 3：实现**

`BackupRecordItem` 在 `created_at` 之前插入：

```python
    phase: str = "pending"
    triggered_by: str = "manual"
    retry_count: int = 0
    backup_set_name: str | None = None
    r2_key: str | None = None
    r2_url: str | None = None
    r2_bucket: str | None = None
    r2_uploaded_at: datetime | None = None
    r2_deleted_at: datetime | None = None
    compressed_size_bytes: int | None = None
```

- [ ] **步骤 4：运行验证通过**

运行：`cd backend && pytest tests/schemas/test_backup_schema.py -v`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add backend/app/schemas/backup.py backend/tests/schemas/test_backup_schema.py
git commit -m "feat(备份): BackupRecordItem 透出 phase 与 R2 字段"
```

### 任务 4：配置项 + `.env.example`

**文件：**
- 修改：`backend/app/core/config.py`（`backup_via_celery` 之后）
- 修改：`backend/.env.example`
- 测试：`backend/tests/core/test_backup_config.py`

- [ ] **步骤 1：写失败测试**

```python
# backend/tests/core/test_backup_config.py
from app.core.config import Settings


def test_backup_config_defaults():
    s = Settings(_env_file=None, database_url="postgresql+psycopg://u:p@localhost:5432/x")
    assert s.backup_soft_time_limit == 5400
    assert s.backup_hard_time_limit == 7200
    assert s.backup_r2_retention_count == 7
    assert s.backup_daily_schedule_hour == 3
```

- [ ] **步骤 2：运行验证失败**

运行：`cd backend && pytest tests/core/test_backup_config.py -v`
预期：FAIL（属性不存在）。

- [ ] **步骤 3：实现**

`config.py` 在 `backup_via_celery` 字段后追加：

```python
    # Celery task 软/硬时间限制（秒）。Phase 1 跑 pgbackrest info 历史 duration 后调。
    backup_soft_time_limit: int = Field(default=5400)
    backup_hard_time_limit: int = Field(default=7200)
    # R2 保留份数，超出由 Celery Beat 04:30 周期清理（§3.7，与本地 retention-full=7 对齐）。
    backup_r2_retention_count: int = Field(default=7)
    # 自动备份小时（24h 制），Celery Beat crontab(hour=此值, minute=0)（§3.6）。
    backup_daily_schedule_hour: int = Field(default=3)
```

`.env.example` 备份段追加（注释态，与主 plan §11 一致）：

```bash
# BACKUP_SOFT_TIME_LIMIT=5400
# BACKUP_HARD_TIME_LIMIT=7200
# R2_BACKUP_RETENTION_COUNT=7
# BACKUP_DAILY_SCHEDULE_HOUR=3
```

> 注意：`backup_r2_retention_count` 对应环境变量名按仓库 `env_prefix` 约定核对（若 Settings 无 prefix，则 env 名为 `BACKUP_R2_RETENTION_COUNT`，`.env.example` 写 `R2_BACKUP_RETENTION_COUNT` 仅为可读性 —— 实现时以 `Settings.model_fields` 实际解析名为准，必要时统一为 `BACKUP_R2_RETENTION_COUNT`）。

- [ ] **步骤 4：运行验证通过**

运行：`cd backend && pytest tests/core/test_backup_config.py -v`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add backend/app/core/config.py backend/.env.example backend/tests/core/test_backup_config.py
git commit -m "feat(备份): 新增备份时间限制与 R2 保留配置项"
```

### 任务 5：`POST /backups/trigger` 接入 `enqueue_backup`（5ms 返回）

**文件：**
- 修改：`backend/app/api/v1/endpoints/backups.py:69-97`
- 测试：`backend/tests/api/test_backup_trigger_async.py`

- [ ] **步骤 1：写失败测试**

```python
# backend/tests/api/test_backup_trigger_async.py
from unittest.mock import patch

from app.api.v1.endpoints.backups import trigger_backup_endpoint
from app.models.backup_record import BackupRecord, BackupStatus
from app.schemas.backup import BackupTriggerRequest


def test_trigger_endpoint_uses_enqueue_backup_and_returns_pending(db_session):
    """POST /trigger 应走 enqueue_backup（异步入队），返回 status=pending，不阻塞。"""
    created = BackupRecord(
        id=42, backup_type="full", status=BackupStatus.PENDING.value,
        phase="pending", triggered_by="manual",
    )
    req = BackupTriggerRequest(backup_type="full")

    with patch("app.api.v1.endpoints.backups.is_pgbackrest_available", return_value=True), \
         patch("app.api.v1.endpoints.backups.is_backup_configured", return_value=(True, "ok")), \
         patch("app.api.v1.endpoints.backups.enqueue_backup", return_value=(created, "备份任务已入队")) as mock_enq, \
         patch("app.api.v1.endpoints.backups.trigger_backup") as mock_sync:
        resp = trigger_backup_endpoint(data=req, db=db_session, _=True, x_user_id="1")

    mock_enq.assert_called_once_with(db_session, "full", 1)
    mock_sync.assert_not_called()
    assert resp.id == 42
    assert resp.status == "pending"
```

- [ ] **步骤 2：运行验证失败**

运行：`cd backend && pytest tests/api/test_backup_trigger_async.py -v`
预期：FAIL（端点仍调 `trigger_backup`，`mock_sync` 被调用 / `enqueue_backup` 未被调用，且 `enqueue_backup` 尚未 import 进端点模块）。

- [ ] **步骤 3：实现**

`endpoints/backups.py` 的 import 块把 `trigger_backup` 换成（或追加）`enqueue_backup`：

```python
from app.services.backup_service import (
    enqueue_backup,
    get_backup_records,
    get_backup_status_summary,
    get_raw_backup_info,
    is_backup_configured,
    is_pgbackrest_available,
    verify_backups,
)
```

`trigger_backup_endpoint` 函数体把 `record, message = trigger_backup(db, data.backup_type, user_id)` 改为：

```python
    record, message = enqueue_backup(db, data.backup_type, user_id)
```

> `trigger_backup`（旧同步路径）函数体在 `backup_service.py` 保留不删，作为 `BACKUP_VIA_CELERY=false` 回滚兜底（`enqueue_backup` 内部已按开关分流）。

- [ ] **步骤 4：运行验证通过**

运行：`cd backend && pytest tests/api/test_backup_trigger_async.py -v`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add backend/app/api/v1/endpoints/backups.py backend/tests/api/test_backup_trigger_async.py
git commit -m "feat(备份): 触发端点接入 enqueue_backup 异步入队"
```

### 任务 6：Celery `include` + `backups` 队列路由

**文件：**
- 修改：`backend/app/tasks/celery_app.py:41-73`
- 测试：`backend/tests/tasks/test_backup_celery_route.py`

- [ ] **步骤 1：写失败测试**

```python
# backend/tests/tasks/test_backup_celery_route.py
from app.tasks import celery_app as celery_app_mod


def test_backup_task_registered_and_routed_to_backups_queue():
    fresh = celery_app_mod._build_celery_app()
    assert "app.celery_tasks.backup" in fresh.conf.include
    routes = fresh.conf.task_routes or {}
    assert routes["app.celery_tasks.backup.run_backup_task"]["queue"] == "backups"
```

- [ ] **步骤 2：运行验证失败**

运行：`cd backend && pytest tests/tasks/test_backup_celery_route.py -v`
预期：FAIL（`include` 无 backup / 路由缺失）。

- [ ] **步骤 3：实现**

`celery_app.py` 的 `include=[...]` 末尾追加 `"app.celery_tasks.backup",`；`task_routes={...}` 追加：

```python
            # 数据库备份：IO 重活，独立 `backups` 队列 + 独立 worker（-c 1，Phase 4）。
            "app.celery_tasks.backup.run_backup_task": {"queue": "backups"},
```

- [ ] **步骤 4：运行验证通过**

运行：`cd backend && pytest tests/tasks/test_backup_celery_route.py -v`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add backend/app/tasks/celery_app.py backend/tests/tasks/test_backup_celery_route.py
git commit -m "feat(备份): 注册 backup task 并路由到 backups 队列"
```

### 任务 7：`run_backup_task` 完整状态机入口（Phase 1：跑 pgBackRest，不传 R2）

**文件：**
- 修改：`backend/app/services/backup_service.py`（抽 `_run_pgbackrest_backup`）
- 修改：`backend/app/celery_tasks/backup.py`（stub → 完整入口）
- 测试：`backend/tests/tasks/test_run_backup_task.py`

> 入口六分支（主 plan §3.2）：① record 不存在 → return；② 已 `completed` → 短路 return；③ `failed` 且 `retry_count>=max` → return；④ 乐观锁推进 `pending→pgbackrest_running` affected=0（被抢占）→ return；⑤ pgbackrest 成功 → `completed`；⑥ 失败 → `failed` + `retry_count+=1`。

- [ ] **步骤 1：写失败测试**

```python
# backend/tests/tasks/test_run_backup_task.py
from unittest.mock import patch

from app.celery_tasks.backup import run_backup_task
from app.models.backup_record import BackupRecord, BackupStatus


def _mk_record(db, **kw) -> BackupRecord:
    from datetime import datetime, timezone
    rec = BackupRecord(
        backup_type=kw.get("backup_type", "full"),
        status=kw.get("status", BackupStatus.PENDING.value),
        phase=kw.get("phase", "pending"),
        triggered_by=kw.get("triggered_by", "manual"),
        retry_count=kw.get("retry_count", 0),
        started_at=datetime.now(timezone.utc),
    )
    db.add(rec)
    db.commit()
    return rec


def test_short_circuit_when_already_completed(db_session):
    rec = _mk_record(db_session, status=BackupStatus.COMPLETED.value, phase="completed")
    with patch("app.celery_tasks.backup._run_pgbackrest_backup") as mock_run:
        result = run_backup_task.apply(args=(rec.id,), throw=True).result
    mock_run.assert_not_called()
    assert result["status"] == "already_completed"


def test_success_advances_to_completed(db_session):
    rec = _mk_record(db_session)
    with patch("app.celery_tasks.backup._run_pgbackrest_backup", return_value=(0, "{}", "")), \
         patch("app.celery_tasks.backup._get_pgbackrest_info", return_value=(True, "{}", [])):
        result = run_backup_task.apply(args=(rec.id,), throw=True).result
    db_session.refresh(rec)
    assert rec.status == BackupStatus.COMPLETED.value
    assert rec.phase == "completed"
    assert result["status"] == "completed"


def test_failure_marks_failed_and_increments_retry(db_session):
    rec = _mk_record(db_session)
    with patch("app.celery_tasks.backup._run_pgbackrest_backup", return_value=(1, "", "boom")):
        run_backup_task.apply(args=(rec.id,), throw=True).result
    db_session.refresh(rec)
    assert rec.status == BackupStatus.FAILED.value
    assert rec.retry_count == 1
    assert "boom" in (rec.error_message or "")
```

- [ ] **步骤 2：运行验证失败**

运行：`cd backend && pytest tests/tasks/test_run_backup_task.py -v`
预期：FAIL（stub 返回 `{"status":"stub"}`，且 `_run_pgbackrest_backup` 不存在）。

- [ ] **步骤 3：实现 —— `backup_service.py` 抽出 worker 용 pgbackrest 执行函数**

在 `backup_service.py` 新增（从现有 `trigger_backup` 提取 args，函数体不重复）：

```python
def _run_pgbackrest_backup(backup_type: str) -> tuple[int, str, str]:
    """Worker 内执行一次 pgbackrest backup，返回 (returncode, stdout, stderr)。"""
    backup_args = [
        "backup",
        "--stanza=blf",
        f"--type={backup_type}",
        "--log-level-console=info",
        "--log-level-file=info",
        "--log-path=/var/log/pgbackrest",
    ]
    return _run_pgbackrest(backup_args, timeout=7200)
```

- [ ] **步骤 4：实现 —— `celery_tasks/backup.py` 完整入口**

替换 stub 函数体（保留装饰器；`_run_pgbackrest_backup` / `_get_pgbackrest_info` 从 service import；DB 会话用与 `run_job` 相同的 `SessionLocal`）：

```python
from __future__ import annotations

import logging
from datetime import datetime

from celery import shared_task
from sqlalchemy import select, update

from app.db.session import SessionLocal
from app.models.backup_record import BackupRecord, BackupStatus
from app.services.backup_service import _get_pgbackrest_info, _run_pgbackrest_backup

logger = logging.getLogger(__name__)

BACKUP_SOFT_TIME_LIMIT = 5400
BACKUP_HARD_TIME_LIMIT = 7200
MAX_RETRIES = 2


def _advance_phase(db, record_id: int, from_phase: str, to_phase: str) -> bool:
    """乐观锁推进 phase；affected=0 表示被别的 task 抢占，返回 False。"""
    stmt = (
        update(BackupRecord)
        .where(BackupRecord.id == record_id, BackupRecord.phase == from_phase)
        .values(phase=to_phase)
    )
    result = db.execute(stmt)
    db.commit()
    return result.rowcount == 1


@shared_task(
    name="app.celery_tasks.backup.run_backup_task",
    bind=True,
    acks_late=True,
    max_retries=MAX_RETRIES,
    default_retry_delay=60,
    soft_time_limit=BACKUP_SOFT_TIME_LIMIT,
    time_limit=BACKUP_HARD_TIME_LIMIT,
)
def run_backup_task(self, record_id: int) -> dict:
    """跑一次 pgBackRest 备份（Phase 1：不传 R2，Phase 2 接 compressing/r2_uploading）。"""
    with SessionLocal() as db:
        record = db.execute(
            select(BackupRecord).where(BackupRecord.id == record_id).with_for_update()
        ).scalar_one_or_none()

        if record is None:  # 分支 ①
            logger.warning("run_backup_task record_id=%s not found", record_id)
            return {"record_id": record_id, "status": "not_found"}

        if record.status == BackupStatus.COMPLETED.value:  # 分支 ②
            return {"record_id": record_id, "status": "already_completed"}

        if record.status == BackupStatus.FAILED.value and record.retry_count >= MAX_RETRIES:  # 分支 ③
            return {"record_id": record_id, "status": "retry_exhausted"}

        if not _advance_phase(db, record_id, "pending", "pgbackrest_running"):  # 分支 ④
            return {"record_id": record_id, "status": "preempted"}

        record.status = BackupStatus.RUNNING.value
        db.commit()

        returncode, stdout, stderr = _run_pgbackrest_backup(record.backup_type)

        if returncode == 0:  # 分支 ⑤
            record.completed_at = datetime.now()
            record.status = BackupStatus.COMPLETED.value
            record.phase = "completed"
            success, info_raw, backups = _get_pgbackrest_info()
            if success:
                record.backup_info = info_raw
            latest = backups[-1] if backups else None
            if latest:
                record.size_bytes = latest.get("size")
                record.duration_seconds = latest.get("duration")
                record.backup_set_name = (latest.get("label") or latest.get("backup", [{}])[0].get("label"))
            db.commit()
            return {"record_id": record_id, "status": "completed"}

        # 分支 ⑥ 失败
        record.status = BackupStatus.FAILED.value
        record.phase = "failed"
        record.retry_count += 1
        record.error_message = stderr or stdout
        db.commit()
        return {"record_id": record_id, "status": "failed", "error": record.error_message}
```

> 实现注意：`backup_set_name` 的 JSON 字段名以生产 `pgbackrest info --output=json` 实际结构为准，Phase 1 联调时打印一次 stdout 确认后定稿 `latest.get(...)` 的取法。

- [ ] **步骤 5：运行验证通过**

运行：`cd backend && pytest tests/tasks/test_run_backup_task.py -v`
预期：3 个用例 PASS。

- [ ] **步骤 6：跑全量后端测试 + lint**

运行：`cd backend && pytest && ruff check app tests`（按 AGENTS.md 后端测试规则）
预期：全过。

- [ ] **步骤 7：Commit**

```bash
git add backend/app/services/backup_service.py backend/app/celery_tasks/backup.py backend/tests/tasks/test_run_backup_task.py
git commit -m "feat(备份): 实装 run_backup_task 状态机入口（Phase 1 跑 pgBackRest）"
```

### Phase 1 验收（手动联调，VPS）

- [ ] 起 worker：`celery -A app.tasks.celery_app worker -Q backups -c 1 --loglevel=info`
- [ ] `POST /api/v1/backups/trigger`（带 `X-Is-Admin: true`）→ **5ms 内**返回 `{"id":N,"status":"pending"}`
- [ ] `GET /api/v1/backups/records` 看到该 record `phase` 从 `pending → pgbackrest_running → completed`，`status=completed`
- [ ] R2 此时**无对象**（Phase 2 才上传）——确认 `r2_key` 为 null
- [ ] `BACKUP_VIA_CELERY=false` 重启 API → 触发走旧同步路径，行为与改前一致（回滚演练）

---

## 5. Phase 2 —— R2 上传链路 + 详情/下载/恢复（核心函数代码）

> 目标：worker 跑完 pgBackRest 后 `compressing → r2_uploading → completed`，落 7 个 R2 字段；前端可拉详情、拿 presigned 下载链接、看恢复命令。**开工前先把本节细化为独立 TDD 子文档** `...-phase2-r2-upload.md`。

### 5.1 核心服务函数（`backup_service.py`）

```python
import shutil
import subprocess
import tarfile
import tempfile
from pathlib import Path

from app.services.r2_service import check_file_exists, generate_presigned_url, upload_file_to_r2

PG_BACKUP_BASE = Path("/var/lib/pgbackrest/backup/blf")


def _archive_to_tar_gz(set_name: str, record_id: int) -> Path:
    """把单次 backup set 目录打成 /tmp/{record_id}.tar.gz，返回路径。"""
    src = PG_BACKUP_BASE / set_name
    if not src.is_dir():
        raise FileNotFoundError(f"backup set not found: {src}")
    tar_path = Path(tempfile.gettempdir()) / f"{record_id}.tar.gz"
    with tarfile.open(tar_path, "w:gz") as tar:
        tar.add(src, arcname=set_name)
    return tar_path


def _upload_to_r2(settings, record: "BackupRecord", tar_path: Path) -> dict:
    """上传 tar.gz 到 R2（修正 M1 的 key 结构），写回 record，返回 upload 结果。"""
    date = record.started_at.strftime("%Y-%m-%d")
    filename = f"blf_{date}_{record.backup_type}_{record.id}.tar.gz"  # key=db-backups/pgbackrest/{filename}
    if record.r2_key and check_file_exists(settings, record.r2_key):
        return {"key": record.r2_key, "url": record.r2_url, "bucket": record.r2_bucket, "size": record.compressed_size_bytes}
    with tar_path.open("rb") as fh:
        result = upload_file_to_r2(settings, fh, filename=filename, project_slug="db-backups", file_type="pgbackrest")
    record.r2_key = result["key"]
    record.r2_url = result["url"]
    record.r2_bucket = result["bucket"]
    record.compressed_size_bytes = result["size"]
    return result


def get_r2_download_url(settings, record: "BackupRecord") -> str:
    if not record.r2_key:
        raise ValueError("该备份尚未上传 R2")
    return generate_presigned_url(settings, record.r2_key, expires_in=3600)
```

### 5.2 `run_backup_task` 接 R2 阶段

在任务 7 的分支 ⑤ 成功路径里，`pgbackrest` 成功后、写 `completed` 前插入：

```python
            # Phase 2: compressing → r2_uploading → completed
            from app.core.config import get_settings
            settings = get_settings()
            if settings.r2_enabled and record.backup_set_name:
                _advance_phase(db, record_id, "pgbackrest_running", "compressing")
                tar_path = _archive_to_tar_gz(record.backup_set_name, record_id)
                try:
                    _advance_phase(db, record_id, "compressing", "r2_uploading")
                    _upload_to_r2(settings, record, tar_path)
                    from datetime import datetime
                    record.r2_uploaded_at = datetime.now()
                finally:
                    tar_path.unlink(missing_ok=True)
```

### 5.3 新增 4 个 API 端点（`endpoints/backups.py`）

| 端点 | 实现要点 |
| --- | --- |
| `GET /backups/{id}` | `db.get(BackupRecord, id)` → `BackupRecordItem`（含 phase/r2_*），给前端轮询 |
| `GET /backups/{id}/download-url` | `get_r2_download_url(settings, record)` → `{"url": presigned}` |
| `GET /backups/{id}/restore-command` | 拼 `pgbackrest restore --stanza=blf --set={backup_set_name} --type=time --target={target_time} --target-action=pause` 文本返回（不执行） |
| `DELETE /backups/{id}` | `try_delete_file_from_r2(settings, record.r2_key)` + `record.r2_deleted_at=now()`（软删，行不删） |

> `POST /{id}/restore-dry-run`（真跑 `--dry-run`）与 `POST /cleanup`（手动 retention）按主 plan §3.9/§3.11，分别在 Phase 2 末 / Phase 5 落。

### 5.4 Phase 2 验收

- [ ] 手动跑一份 → R2 出现 `db-backups/pgbackrest/blf_{date}_full_{id}.tar.gz`，`r2_key/r2_url/r2_uploaded_at/compressed_size_bytes` 落库
- [ ] `wget {download-url}` 拉下 tar.gz，`tar -tzf` 看到 set 目录结构
- [ ] worker `kill -9` 在 `compressing` 阶段 → broker 重投后**不产生 R2 孤儿对象**（`check_file_exists` 幂等 + phase 短路）
- [ ] `R2_SECRET_ACCESS_KEY` 改错跑一份 → `status=failed`，`error_message` 含 `InvalidAccessKeyId`

---

## 6. Phase 3–5 路线图（每 phase 开工前写独立 TDD 子文档）

### Phase 3 —— 前端轮询 + 进度条 + 详情 UI（`...-phase3-frontend.md`）

- [ ] `backup-management-client.tsx`：存在 `pending/running/uploading` 记录时 `setInterval(loadData, 3000)`，全终态 `clearInterval`
- [ ] phase 进度条组件（`pending/pgbackrest_running/compressing/r2_uploading/completed/failed` 六态配色，主 plan §3.8）
- [ ] 记录表行展开：R2 元信息（key/bucket/大小/上传时间）+ pgBackRest metadata pretty-print
- [ ] 下载 / 恢复命令预览 / 删除 三按钮 + 二次确认（恢复干跑按钮 Phase 2 端点就绪后接）
- [ ] 前端测试顺序：`pnpm lint` → `pnpm build` → `pnpm test`（AGENTS.md 规则）

### Phase 4 —— Celery Beat 03:00 自动备份 + 独立 worker unit（`...-phase4-beat.md`）

- [ ] `celery_app.py` 加 `beat_schedule`：`daily-pg-full-backup`（`crontab(hour=settings.backup_daily_schedule_hour, minute=0)`）+ 新 task `schedule_daily_backup_task(backup_type="full", triggered_by="auto")`（thin wrapper：INSERT + `run_backup_task.delay`）
- [ ] 新建 `backend/deploy/systemd/believeboy-worker-backups.service`（`-Q backups -c 1`）
- [ ] `deployment-runbook.md` 补 Beat **单实例**约束 + worker unit 部署
- [ ] 验收：crontab 临时调到 5min 后，等出 `triggered_by='auto'` 的 record 跑完，再恢复

### Phase 5 —— R2 retention + 软删 + 监控（`...-phase5-retention.md`）

- [ ] `cleanup_r2_task`（Beat `crontab(hour=4, minute=30)`）：拉 `r2_uploaded_at IS NOT NULL AND r2_deleted_at IS NULL ORDER BY r2_uploaded_at DESC`，跳过前 `backup_r2_retention_count` 条，其余 `try_delete_file_from_r2` + 写 `r2_deleted_at`
- [ ] `BackupStatusSummary.r2_storage_bytes` 填充（偏差 B 收尾）
- [ ] 验收：塞 12 条 record 跑一次 cleanup，前 7 留、后 5 的 R2 key 消失 + `r2_deleted_at` 写

### Phase 6 —— 灰度与回滚（无代码改动，沿用主 plan §Phase 6）

- [ ] `BACKUP_VIA_CELERY=false` 回滚 = 改 env + 重启 API，零代码改动

---

## 7. 验收 / 回滚 / 文档收尾

- 主 plan §9 验收清单全部沿用，本续作不重复。
- 回滚双开关：`BACKUP_VIA_CELERY`（异步/同步）+ 旧 `trigger_backup` 函数体保留不删。
- 实现完成后：`docs/REFERENCE.md`（Background Jobs 加 `backups` 队列 + R2 retention）、`docs/deployment-runbook.md`（worker unit + Beat 约束）、本目录写 `implementation-review.md` 记录与 frozen 方案的偏差、`CHANGELOG.md` 记 `feat(备份): 数据库备份端到端链路 + R2 异步上传`。

---

## 8. 自检（writing-plans 技能要求）

- **规格覆盖度**：主 plan §3.1–§3.11 全部决策 → 任务 1–7（Phase 1）+ §5（Phase 2）+ §6（Phase 3–5）均有落点；§3.3 R2 key 偏差以修正 M1 闭环；§3.9 恢复干跑 / §3.7 retention 分别在 Phase 2 末 / Phase 5。✅
- **占位符扫描**：无「待定 / TODO / 类似任务 N」；每个代码步骤均给出可粘贴代码；两处「实现注意」明确标注需联调确认的字段（`completed_at` 写法、`backup_set_name` JSON 字段名），非占位符而是显式联调点。✅
- **类型一致性**：`enqueue_backup` / `run_backup_task` / `_run_pgbackrest_backup` / `_advance_phase` / `_archive_to_tar_gz` / `_upload_to_r2` / `get_r2_download_url` 签名在任务 5/6/7 与 §5 全程一致；迁移 `down_revision="20260718_214"` 与已确认 head 一致；路由 key 用 task 显式 `name`。✅

---

## 9. 关联引用

- 主 plan：[`2026-07-17-pg-r2-backup-feature.md`](./2026-07-17-pg-r2-backup-feature.md)
- 现状代码：`backend/app/services/backup_service.py` · `backend/app/celery_tasks/backup.py` · `backend/app/api/v1/endpoints/backups.py` · `backend/app/models/backup_record.py` · `backend/app/services/r2_service.py` · `backend/app/tasks/celery_app.py`
- 设计参考：`docs/superpowers/plans/2026-07-10-scheduled-report-to-celery.md`（幂等护栏 / 双开关回滚 / time_limit 验证流程）
- 仓库约定：`AGENTS.md` 关键约定 + `docs/superpowers/plans/README.md` 命名规则
