# CRM P4 · 审计日志 + 高级筛选（实用档）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 CRM 补两块硬化能力——①操作审计日志（记录谁对客户/线索/联系人做了什么，管理员可在抽屉和独立页面可视化查询）；②高级筛选实用档（后端筛选引擎 + 表头常用字段快捷筛选）。

**Architecture:**
- **审计日志（Phase A）**：新建 `crm_audit_logs` 表 + `audit_service`（记录/查询/变更摘要）。在 CRM 各**写端点的 endpoint 层**（身份 `user_id`/`is_admin` 所在处）调用 `record_log` 留痕，`update` 端点用「改前 vs patch」算中文变更摘要。查询端点 `GET /crm/audit-logs`（仅管理员）+ 前端抽屉「操作记录」tab + 管理员审计页。
- **高级筛选（Phase B）**：新建 `filter_engine`，把前端已定义的 `FilterCondition`（`{field,op,value}` + and/or 嵌套）翻译成 SQLAlchemy where，**列白名单**防注入。`list_customers`/`list_leads` 接 `filters` 查询参数。前端 `CrmTable` 增 `filterFields` 快捷筛选行，`http-crm-client` 把 filters 序列化入站。

**Tech Stack:** FastAPI + SQLAlchemy 2.0 + Pydantic v2 + Alembic（后端）；Next.js + React + TanStack Query + shadcn/ui（前端）；Vitest + pytest（TDD）。

## Global Constraints

- **迁移命名**：文件名 `YYYYMMDD_NNN_description.py`，revision id 用纯数字短 ID，`NNN` 从最新递增（**当前 head=219，本 plan 用 220**）；`down_revision="219"`。建前 `git fetch origin && git rebase origin/main` 取单链、`alembic heads` 确认单 head；迁移随 feature 分支同批合 main。**严禁裸跑 `alembic revision -m`**。主键统一 `Integer`。
- **权限**：新端点接入 `app/services/crm/permissions.py`（`require_admin` / `require_owner_or_admin` / `resolve_scope` / `filter_owned_ids`）。
- **TDD**：每个任务先写失败测试 → 跑确认失败 → 最小实现 → 跑确认通过 → 提交。
- **测试 DB**：共享 `BLF_test`（持久化、CRM 测试用 `truncate ... restart identity cascade`）。**并行 subagent 不得跑 DB 测试**（会互冲），DB 测试由主 agent 串行跑；subagent 只跑 lint/build/非 DB 单测/`pnpm test`。
- **Commit**：中文 Conventional Commits（feat/fix/test/chore…），scope 中文，subject 动宾短语 ≤50 字无句号。
- **工作流**：默认 main 开发，最多 main+1 分支，**绝不 rebase main**，合并用 `merge --no-ff`。
- **后端测试命令**：`cd backend && .venv/bin/python -m pytest <path> -q`。
- **前端门禁顺序**：`pnpm lint` → `pnpm build` → `pnpm test`。
- **身份来源**：`get_request_user_id`（X-Operator/X-User-Name header，UUID 字符串）、`get_request_is_admin`（X-Is-Admin）。`actor_name` 查询时从 `public.user_accounts` 解析（不快照，名字保持最新）。
- **Phase A 与 Phase B 相互独立**，可分别执行、分别上线。

---

## File Structure

### Phase A · 审计日志

| 文件 | 责任 | 操作 |
|---|---|---|
| `backend/app/models/crm.py` | 追加 `CrmAuditLog` 模型 | Modify |
| `backend/alembic/versions/20260725_220_crm_audit_log.py` | 建 `crm_audit_logs` 表 + 索引 | Create |
| `backend/app/schemas/crm.py` | 追加 `AuditLogItem` / `AuditLogListResponse` | Modify |
| `backend/app/services/crm/audit_service.py` | `record_log` / `list_audit_logs` / `summarize_update` + 字段中文标签表 | Create |
| `backend/app/api/v1/endpoints/crm.py` | 各写端点调用 `record_log`；新增 `GET /audit-logs` | Modify |
| `backend/tests/services/crm/test_audit_service.py` | service 单测 | Create |
| `backend/tests/api/crm/test_audit_api.py` | 端点集成测试（记录+查询+权限墙） | Create |
| `frontend/lib/crm/types/audit.ts` | `AuditLog` 类型 | Create |
| `frontend/lib/crm/api/crm-client.ts` | `CrmClient` 接口加 `listAuditLogs` | Modify |
| `frontend/lib/crm/api/http-crm-client.ts` | `listAuditLogs` 实现 | Modify |
| `frontend/lib/crm/api/mock-crm-client.ts` | `listAuditLogs` mock | Modify |
| `frontend/components/crm/crm-audit-timeline/index.tsx` | 审计时间线组件（抽屉 tab + 页面复用） | Create |
| `frontend/components/crm/crm-overview-drawer/index.tsx` | 加「操作记录」tab | Modify |
| `frontend/app/dashboard/crm/audit/page.tsx` | 管理员审计日志页 | Create |
| `frontend/lib/sidebar-config.ts` | CRM 组加「操作日志」入口（admin） | Modify |

### Phase B · 高级筛选（实用档）

| 文件 | 责任 | 操作 |
|---|---|---|
| `backend/app/services/crm/filter_engine.py` | `apply_filters`：FilterCondition → SQLAlchemy where（列白名单） | Create |
| `backend/app/services/crm/customer_service.py` | `list_customers` 接 `filters` 参数 | Modify |
| `backend/app/services/crm/lead_service.py` | `list_leads` 接 `filters` 参数 | Modify |
| `backend/app/api/v1/endpoints/crm.py` | list 端点加 `filters` 查询参数 + 解析 + 400 处理 | Modify |
| `backend/tests/services/crm/test_filter_engine.py` | 引擎单测（各 op + 白名单拒绝 + and/or） | Create |
| `backend/tests/api/crm/test_filter_api.py` | 端点集成测试（筛选生效 + 非法字段 400） | Create |
| `frontend/lib/crm/api/http-crm-client.ts` | `buildListQuery` 序列化 `filters` 入站 | Modify |
| `frontend/components/crm/crm-table/index.tsx` | 增 `filterFields` prop + 快捷筛选行 + filters 状态 | Modify |
| `frontend/components/crm/crm-table/types.ts` | `CrmTableProps` 加 `filterFields` | Modify |
| `frontend/components/crm/customer-table.tsx` | 定义客户 `filterFields` 并传入 | Modify |
| `frontend/components/crm/lead-table.tsx` | 定义线索 `filterFields` 并传入 | Modify |
| `frontend/components/crm/crm-table/crm-table-filters.test.tsx` | 筛选行组件测试 | Create |

---

# Phase A · 审计日志

## Task A1: CrmAuditLog 模型 + 迁移 220

**Files:**
- Modify: `backend/app/models/crm.py`（文件末尾追加模型）
- Create: `backend/alembic/versions/20260725_220_crm_audit_log.py`

**Interfaces:**
- Produces: `CrmAuditLog`（`id:int PK`, `entity_type:str`, `entity_id:int`, `action:str`, `actor_id:str|None`, `summary:str|None`, `created_at:datetime`）；表 `crm_audit_logs`，索引 `idx_cal_entity(entity_type,entity_id)` / `idx_cal_actor(actor_id)` / `idx_cal_created(created_at)`。

- [ ] **Step 1: 建迁移前先同步 main 取单链**

```bash
cd /Users/damon/DamonProjects/believeboyDashboard
git fetch origin
cd backend && .venv/bin/python -m alembic heads   # 确认只有一个 head=219
```
Expected: 输出单行 `219 (head)`。若多 head 先 `alembic merge heads --rev-id 220 -m "merge ..."`（本 plan 预期单 head）。

- [ ] **Step 2: 追加模型到 `app/models/crm.py` 末尾**

```python
class CrmAuditLog(Base):
    """CRM 操作审计日志（P4）：记录谁对实体做了什么。actor_id=null 表示系统操作。"""
    __tablename__ = "crm_audit_logs"
    __table_args__ = (
        Index("idx_cal_entity", "entity_type", "entity_id"),
        Index("idx_cal_actor", "actor_id"),
        Index("idx_cal_created", "created_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    entity_type: Mapped[str] = mapped_column(String(20), nullable=False)  # customer/lead/contact
    entity_id: Mapped[int] = mapped_column(Integer, nullable=False)
    action: Mapped[str] = mapped_column(String(30), nullable=False)  # create/update/delete/transfer/move_sea/claim/convert/set_primary
    actor_id: Mapped[str | None] = mapped_column(String(36))  # user_accounts.id UUID；null=系统
    summary: Mapped[str | None] = mapped_column(Text)  # 中文变更摘要
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
```

- [ ] **Step 3: 生成迁移文件（纯数字 rev-id 220）**

```bash
cd backend && .venv/bin/python -m alembic revision --rev-id 220 -m "crm 操作审计日志表"
```
Expected: 生成 `alembic/versions/20260725_220_crm_audit_log.py`（若日期前缀不符，手动改文件名为 `20260725_220_crm_audit_log.py`）。

- [ ] **Step 4: 编辑迁移 upgrade/downgrade**

```python
"""crm 操作审计日志表

Revision ID: 220
Revises: 219
"""
from alembic import op
import sqlalchemy as sa

revision = "220"
down_revision = "219"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "crm_audit_logs",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("entity_type", sa.String(length=20), nullable=False),
        sa.Column("entity_id", sa.Integer(), nullable=False),
        sa.Column("action", sa.String(length=30), nullable=False),
        sa.Column("actor_id", sa.String(length=36), nullable=True),
        sa.Column("summary", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("idx_cal_entity", "crm_audit_logs", ["entity_type", "entity_id"])
    op.create_index("idx_cal_actor", "crm_audit_logs", ["actor_id"])
    op.create_index("idx_cal_created", "crm_audit_logs", ["created_at"])


def downgrade() -> None:
    op.drop_index("idx_cal_created", table_name="crm_audit_logs")
    op.drop_index("idx_cal_actor", table_name="crm_audit_logs")
    op.drop_index("idx_cal_entity", table_name="crm_audit_logs")
    op.drop_table("crm_audit_logs")
```

- [ ] **Step 5: 应用迁移到 dev 库 + 同步测试库 + 验证**

> 本仓库 alembic 走 **dev 库**（`alembic/env.py` 用 `settings.database_url`）；测试库 `BLF_test` 不跑 alembic 链，而是用 `scripts/setup_test_db.py` 把 **dev 库 schema pg_dump 克隆过去**（`--clean --if-exists` 幂等）。故新表进测试库需两步：先 `alembic upgrade head`（dev），再 `setup_test_db.py`（同步到 BLF_test）。

```bash
cd backend
# 1) dev 库应用迁移
.venv/bin/python -m alembic upgrade head
# 2) 把 dev schema 克隆进测试库 BLF_test（需 pg_dump/psql 可用、.env.test 已配 TEST_DATABASE_URL）
.venv/bin/python scripts/setup_test_db.py
# 3) 验证 BLF_test 有 crm_audit_logs
.venv/bin/python -c "
import os
for l in open('.env.test'):
    if '=' in l and not l.strip().startswith('#'):
        k,v=l.strip().split('=',1); os.environ.setdefault(k,v)
from sqlalchemy import text
from app.db.session import SessionLocal
s=SessionLocal()
print(s.execute(text('select count(*) from crm_audit_logs')).scalar_one())
s.close()
"
```
Expected: 第 3 步打印 `0`（BLF_test 已有表，空）。若 `setup_test_db.py` 因环境不可用失败，退化为直接对 BLF_test 执行迁移文件里的 `upgrade()` DDL（建表+3索引）。

- [ ] **Step 6: Commit**

```bash
git add backend/app/models/crm.py backend/alembic/versions/20260725_220_crm_audit_log.py
git commit -m "feat(crm): 审计日志表 crm_audit_logs + 迁移220"
```

---

## Task A2: audit_service（记录/查询/变更摘要）

**Files:**
- Create: `backend/app/services/crm/audit_service.py`
- Create: `backend/tests/services/crm/test_audit_service.py`
- Modify: `backend/app/schemas/crm.py`（追加 `AuditLogItem` / `AuditLogListResponse`）

**Interfaces:**
- Consumes: `CrmAuditLog`（Task A1）。
- Produces:
  - `record_log(db, *, entity_type: str, entity_id: int, action: str, actor_id: str | None, summary: str = "") -> CrmAuditLog`（add + commit + refresh）
  - `list_audit_logs(db, *, entity_type=None, entity_id=None, actor_id=None, action=None, page=1, page_size=20) -> tuple[list[AuditLogItem], int]`（created_at desc，actor_name 从 user_accounts 解析）
  - `summarize_update(before: dict, patch: dict, labels: dict[str, str]) -> str`（只列变化字段，格式 `字段: 旧→新; ...`；无变化返回 `""`）
  - `CUSTOMER_FIELD_LABELS` / `LEAD_FIELD_LABELS`：字段名→中文标签 dict
  - schema `AuditLogItem(id, entity_type, entity_id, action, actor_id, actor_name, summary, created_at)`、`AuditLogListResponse(items, total, page, page_size)`

- [ ] **Step 1: 追加 schema 到 `app/schemas/crm.py` 末尾**

```python
# ---------- Audit Log (P4) ----------
class AuditLogItem(BaseModel):
    id: int
    entity_type: str
    entity_id: int
    action: str
    actor_id: str | None = None
    actor_name: str | None = None
    summary: str | None = None
    created_at: datetime


class AuditLogListResponse(BaseModel):
    items: list[AuditLogItem]
    total: int
    page: int
    page_size: int
```

- [ ] **Step 2: 写失败测试 `tests/services/crm/test_audit_service.py`**

```python
"""audit_service TDD tests — 审计日志记录/查询/变更摘要（P4）。"""
from __future__ import annotations

import pytest
from sqlalchemy import text

from app.services.crm.audit_service import (
    CUSTOMER_FIELD_LABELS,
    list_audit_logs,
    record_log,
    summarize_update,
)

ALICE = "11111111-1111-1111-1111-111111111111"


@pytest.fixture(autouse=True)
def _clean(db_session):
    from app.db.session import SessionLocal

    s = SessionLocal()
    try:
        s.execute(text("truncate crm_audit_logs restart identity cascade"))
        s.commit()
    finally:
        s.close()
    yield


def test_record_log_persists(db_session):
    log = record_log(db_session, entity_type="customer", entity_id=1, action="create", actor_id=ALICE, summary="新建客户")
    assert log.id is not None
    row = db_session.execute(
        text("select entity_type, entity_id, action, actor_id, summary from crm_audit_logs")
    ).one()
    assert row == ("customer", 1, "create", ALICE, "新建客户")


def test_list_audit_logs_filter_by_entity_and_order(db_session):
    record_log(db_session, entity_type="customer", entity_id=1, action="create", actor_id=ALICE)
    record_log(db_session, entity_type="customer", entity_id=1, action="update", actor_id=ALICE, summary="评级: B→A")
    record_log(db_session, entity_type="lead", entity_id=2, action="create", actor_id=ALICE)
    items, total = list_audit_logs(db_session, entity_type="customer", entity_id=1)
    assert total == 2
    assert [i.action for i in items] == ["update", "create"]  # created_at desc


def test_list_audit_logs_filter_by_action_and_actor(db_session):
    record_log(db_session, entity_type="customer", entity_id=1, action="transfer", actor_id=ALICE)
    record_log(db_session, entity_type="customer", entity_id=1, action="create", actor_id=None)
    _, total = list_audit_logs(db_session, action="transfer")
    assert total == 1
    _, total2 = list_audit_logs(db_session, actor_id=ALICE)
    assert total2 == 1


def test_summarize_update_only_changed_fields():
    before = {"rating": "B", "status": "active", "name": "客户A"}
    summary = summarize_update(before, {"rating": "A", "status": "active"}, CUSTOMER_FIELD_LABELS)
    assert "等级" in summary and "B→A" in summary
    assert "状态" not in summary  # 未变化不列
    assert "客户名" not in summary  # patch 里没有


def test_summarize_update_no_change_returns_empty():
    assert summarize_update({"rating": "B"}, {"rating": "B"}, CUSTOMER_FIELD_LABELS) == ""


def test_summarize_update_handles_none_and_missing_label():
    summary = summarize_update({"owner_id": None, "source": "referral"}, {"owner_id": "u1", "source": None}, CUSTOMER_FIELD_LABELS)
    assert "负责人" in summary
    assert "source" in summary or "来源" in summary
```

- [ ] **Step 3: 跑测试确认失败**

```bash
cd backend && .venv/bin/python -m pytest tests/services/crm/test_audit_service.py -q
```
Expected: FAIL（`ModuleNotFoundError: audit_service`）。

- [ ] **Step 4: 实现 `app/services/crm/audit_service.py`**

```python
"""CRM 操作审计日志服务（P4）：记录/查询/变更摘要。

在写端点（endpoint 层，身份所在）调用 record_log 留痕；
update 端点用 summarize_update(改前, patch) 算中文摘要。
actor_name 查询时从 public.user_accounts 解析（不快照）。
"""
from __future__ import annotations

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app.models.crm import CrmAuditLog
from app.schemas.crm import AuditLogItem

# 字段名 → 中文标签（摘要用；未收录字段回退原始字段名）
CUSTOMER_FIELD_LABELS: dict[str, str] = {
    "name": "客户名", "short_name": "简称", "industry": "行业",
    "customer_type": "对象类型", "interested_service": "意向服务",
    "rating": "等级", "status": "状态", "source": "来源", "owner_id": "负责人",
    "address": "地址", "website": "网站", "annual_revenue": "年营收",
    "employee_count": "员工数", "remark": "备注",
}

LEAD_FIELD_LABELS: dict[str, str] = {
    "name": "联系人名", "company": "公司", "phone": "电话", "email": "邮箱",
    "wechat": "微信", "source": "来源", "customer_type": "对象类型",
    "interested_service": "意向服务", "status": "状态", "intent": "意向度",
    "owner_id": "负责人", "expected_amount": "预期金额",
    "expected_close_date": "预期成交日", "remark": "备注",
}


def record_log(db: Session, *, entity_type: str, entity_id: int, action: str, actor_id: str | None, summary: str = "") -> CrmAuditLog:
    """记录一条审计日志（add + commit + refresh）。"""
    log = CrmAuditLog(entity_type=entity_type, entity_id=entity_id, action=action, actor_id=actor_id, summary=summary or None)
    db.add(log)
    db.commit()
    db.refresh(log)
    return log


def _actor_name_map(db: Session, actor_ids: set[str]) -> dict[str, str]:
    if not actor_ids:
        return {}
    rows = db.execute(
        text("select id, name from public.user_accounts where id = any(:ids)"),
        {"ids": list(actor_ids)},
    ).all()
    return {str(r[0]): r[1] for r in rows}


def list_audit_logs(db: Session, *, entity_type: str | None = None, entity_id: int | None = None, actor_id: str | None = None, action: str | None = None, page: int = 1, page_size: int = 20) -> tuple[list[AuditLogItem], int]:
    """按条件查审计日志（created_at desc + id desc 兜底），actor_name 实时解析。"""
    stmt = select(CrmAuditLog)
    if entity_type is not None:
        stmt = stmt.where(CrmAuditLog.entity_type == entity_type)
    if entity_id is not None:
        stmt = stmt.where(CrmAuditLog.entity_id == entity_id)
    if actor_id is not None:
        stmt = stmt.where(CrmAuditLog.actor_id == actor_id)
    if action is not None:
        stmt = stmt.where(CrmAuditLog.action == action)

    total = db.execute(select(func.count()).select_from(stmt.subquery())).scalar_one()
    stmt = stmt.order_by(CrmAuditLog.created_at.desc(), CrmAuditLog.id.desc()).offset((page - 1) * page_size).limit(page_size)
    rows = db.execute(stmt).scalars().all()
    names = _actor_name_map(db, {r.actor_id for r in rows if r.actor_id})
    items = [
        AuditLogItem(id=r.id, entity_type=r.entity_type, entity_id=r.entity_id, action=r.action, actor_id=r.actor_id, actor_name=names.get(r.actor_id) if r.actor_id else None, summary=r.summary, created_at=r.created_at)
        for r in rows
    ]
    return items, int(total)


def summarize_update(before: dict, patch: dict, labels: dict[str, str]) -> str:
    """比较改前值与 patch，只列变化字段，格式「字段: 旧→新; ...」。无变化返回空串。"""
    parts: list[str] = []
    for key, new in patch.items():
        old = before.get(key)
        if old == new:
            continue
        label = labels.get(key, key)
        parts.append(f"{label}: {_fmt(old)}→{_fmt(new)}")
    return "; ".join(parts)


def _fmt(value) -> str:
    if value is None or value == "":
        return "空"
    return str(value)
```

- [ ] **Step 5: 跑测试确认通过**

```bash
cd backend && .venv/bin/python -m pytest tests/services/crm/test_audit_service.py -q
```
Expected: PASS（6 passed）。

- [ ] **Step 6: Commit**

```bash
git add backend/app/services/crm/audit_service.py backend/app/schemas/crm.py backend/tests/services/crm/test_audit_service.py
git commit -m "feat(crm): 审计日志服务 record_log/list/变更摘要"
```

---

## Task A3: 写端点接入审计记录 + 查询端点

**Files:**
- Modify: `backend/app/api/v1/endpoints/crm.py`（各写端点 + 新增 `GET /audit-logs`）
- Create: `backend/tests/api/crm/test_audit_api.py`

**Interfaces:**
- Consumes: `audit_service.record_log` / `summarize_update` / `CUSTOMER_FIELD_LABELS` / `LEAD_FIELD_LABELS`（Task A2）。
- Produces: 每个写操作成功后落一条审计日志。action 约定：`create`/`update`/`delete`/`transfer`/`move_sea`/`claim`/`convert`/`set_primary`。`GET /crm/audit-logs`（仅管理员，`require_admin`）。

**说明：** `record_log` 自带 commit，在 service 写函数返回后调用即可。`update` 端点已有 `existing`，用 `existing.model_dump()` 作 before。`batch_transfer`（客户/线索）当前**只有 `is_admin` 无 `user_id`**，需补 `user_id: str | None = Depends(get_request_user_id)`。

- [ ] **Step 1: 写失败测试 `tests/api/crm/test_audit_api.py`**

```python
"""审计日志端点集成测试（P4）：写操作留痕 + 查询 + 权限墙。"""
from __future__ import annotations

import pytest
from sqlalchemy import text

ADMIN = "11111111-1111-1111-1111-111111111111"


@pytest.fixture(autouse=True)
def _clean(db_session):
    from app.db.session import SessionLocal

    s = SessionLocal()
    try:
        s.execute(text("truncate crm_audit_logs, crm_follows, crm_opportunities, crm_contacts, crm_leads, crm_customers restart identity cascade"))
        s.commit()
    finally:
        s.close()
    yield


def _h():
    return {"X-Operator": ADMIN, "X-Is-Admin": "true"}


def test_create_customer_writes_audit(client):
    cid = client.post("/api/v1/crm/customers", json={"name": "客户A"}, headers=_h()).json()["id"]
    logs = client.get("/api/v1/crm/audit-logs", params={"entity_type": "customer", "entity_id": cid}, headers=_h()).json()
    assert logs["total"] == 1 and logs["items"][0]["action"] == "create"


def test_update_customer_writes_change_summary(client):
    cid = client.post("/api/v1/crm/customers", json={"name": "客户A", "rating": "B"}, headers=_h()).json()["id"]
    client.patch(f"/api/v1/crm/customers/{cid}", json={"rating": "A"}, headers=_h())
    logs = client.get("/api/v1/crm/audit-logs", params={"entity_type": "customer", "entity_id": cid, "action": "update"}, headers=_h()).json()
    assert logs["total"] == 1
    assert "等级" in logs["items"][0]["summary"] and "B→A" in logs["items"][0]["summary"]


def test_batch_transfer_writes_audit_per_id(client):
    c1 = client.post("/api/v1/crm/customers", json={"name": "C1"}, headers=_h()).json()["id"]
    c2 = client.post("/api/v1/crm/customers", json={"name": "C2"}, headers=_h()).json()["id"]
    resp = client.post("/api/v1/crm/customers/batch-transfer", json={"ids": [c1, c2], "to_owner_id": ADMIN}, headers=_h())
    assert resp.status_code == 204
    logs = client.get("/api/v1/crm/audit-logs", params={"action": "transfer"}, headers=_h()).json()
    assert logs["total"] == 2


def test_audit_logs_requires_admin(client):
    resp = client.get("/api/v1/crm/audit-logs", headers={"X-Operator": ADMIN, "X-Is-Admin": "false"})
    assert resp.status_code == 403
```

> `client` fixture 复用现有 CRM api 测试的 TestClient（看 `backend/tests/api/crm/test_export_api.py` 顶部如何引入）。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd backend && .venv/bin/python -m pytest tests/api/crm/test_audit_api.py -q
```
Expected: FAIL（`/audit-logs` 404 / 无审计记录）。

- [ ] **Step 3: `crm.py` import 区加审计服务 + schema**

```python
from app.services.crm import audit_service
from app.services.crm.audit_service import CUSTOMER_FIELD_LABELS, LEAD_FIELD_LABELS
# schema import 区加 AuditLogListResponse
```

- [ ] **Step 4: 客户写端点接入**

`create_customer`：
```python
    item = customer_service.create_customer(db, payload, user_id=user_id)
    audit_service.record_log(db, entity_type="customer", entity_id=item.id, action="create", actor_id=user_id, summary="新建客户")
    return item
```
`update_customer`（已有 `existing`）：
```python
    require_owner_or_admin(existing.owner_id, user_id, is_admin)
    before = existing.model_dump()
    item = customer_service.update_customer(db, customer_id, payload)
    summary = audit_service.summarize_update(before, payload.model_dump(exclude_unset=True), CUSTOMER_FIELD_LABELS)
    audit_service.record_log(db, entity_type="customer", entity_id=customer_id, action="update", actor_id=user_id, summary=summary)
    return item
```
`delete_customer`：在 `customer_service.delete_customer(...)` 后
```python
    audit_service.record_log(db, entity_type="customer", entity_id=customer_id, action="delete", actor_id=user_id, summary=f"删除客户 {existing.name}")
```
`batch_transfer`（**补 `user_id` 参数**）：
```python
def batch_transfer(payload: BatchTransferRequest, db=Depends(get_primary_db_session), user_id: str | None = Depends(get_request_user_id), is_admin: bool = Depends(get_request_is_admin)):
    require_admin(is_admin)
    customer_service.batch_transfer(db, payload.ids, payload.to_owner_id)
    for cid in payload.ids:
        audit_service.record_log(db, entity_type="customer", entity_id=cid, action="transfer", actor_id=user_id, summary="指派负责人")
```
`batch_move_to_sea`：在 `customer_service.batch_move_to_sea(db, ids)` 后
```python
    for cid in ids:
        audit_service.record_log(db, entity_type="customer", entity_id=cid, action="move_sea", actor_id=user_id, summary="释放至公海")
```
`claim_from_sea`：在 `item` 非 None 后
```python
    audit_service.record_log(db, entity_type="customer", entity_id=item.id, action="claim", actor_id=user_id, summary="从公海领取")
```

- [ ] **Step 5: 联系人写端点接入**

`create_contact`（**补 `user_id` 参数**）成功后：
```python
    audit_service.record_log(db, entity_type="contact", entity_id=contact.id, action="create", actor_id=user_id, summary=f"新增联系人 {contact.name}")
```
`update_contact` / `delete_contact` 同理记 `update`/`delete`（entity_type="contact"）。设主联系人端点记 `set_primary`。

- [ ] **Step 6: 线索写端点接入**（entity_type="lead"，标签用 `LEAD_FIELD_LABELS`）

- `create_lead` → `create`
- `update_lead`（已有 existing）→ `update` + `summarize_update(before, patch, LEAD_FIELD_LABELS)`
- `leads/batch-transfer`（补 user_id）→ 逐 id `transfer`
- `leads/batch-move-pool` → 逐 id `move_sea`（summary「释放至线索池」）
- `leads/{id}/claim` → `claim`
- `leads/{id}/convert` → `convert`（summary「线索转化为客户」，entity_id=lead.id）

- [ ] **Step 7: 新增 `GET /audit-logs`（仅管理员，放在 `/{id}` 类路由前）**

```python
@router.get("/audit-logs", response_model=AuditLogListResponse)
def list_audit_logs(
    entity_type: str | None = Query(None),
    entity_id: int | None = Query(None),
    actor_id: str | None = Query(None),
    action: str | None = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_read_db_session),
    is_admin: bool = Depends(get_request_is_admin),
):
    """审计日志查询（仅管理员）。"""
    require_admin(is_admin)
    items, total = audit_service.list_audit_logs(db, entity_type=entity_type, entity_id=entity_id, actor_id=actor_id, action=action, page=page, page_size=page_size)
    return AuditLogListResponse(items=items, total=total, page=page, page_size=page_size)
```

- [ ] **Step 8: 跑端点 + 全 CRM 测试**

```bash
cd backend && .venv/bin/python -m pytest tests/api/crm/test_audit_api.py tests/services/crm/ tests/api/crm/ -q
```
Expected: PASS（无回归）。

- [ ] **Step 9: Commit**

```bash
git add backend/app/api/v1/endpoints/crm.py backend/tests/api/crm/test_audit_api.py
git commit -m "feat(crm): 写操作接入审计记录 + 审计查询端点"
```

---

## Task A4: 前端审计类型 + client 三件套

**Files:**
- Create: `frontend/lib/crm/types/audit.ts`
- Modify: `frontend/lib/crm/types/index.ts`、`frontend/lib/crm/api/crm-client.ts`、`frontend/lib/crm/api/http-crm-client.ts`、`frontend/lib/crm/api/mock-crm-client.ts`、`frontend/lib/crm/api/dto-mappers.ts`

**Interfaces:**
- Consumes: `GET /crm/audit-logs`（Task A3）。
- Produces: `AuditLog` 类型；`CrmClient.listAuditLogs(params): Promise<Paginated<AuditLog>>`。

- [ ] **Step 1: 建 `frontend/lib/crm/types/audit.ts`**

```typescript
export type AuditAction =
  | 'create' | 'update' | 'delete' | 'transfer'
  | 'move_sea' | 'claim' | 'convert' | 'set_primary'

export interface AuditLog {
  id: string
  entityType: 'customer' | 'lead' | 'contact'
  entityId: string
  action: AuditAction
  actorId: string | null
  actorName: string | null
  summary: string | null
  createdAt: string
}

export interface AuditLogQuery {
  entityType?: string
  entityId?: string
  actorId?: string
  action?: string
  page?: number
  pageSize?: number
}

export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  create: '新建', update: '编辑', delete: '删除', transfer: '指派负责人',
  move_sea: '释放公海', claim: '领取', convert: '转化', set_primary: '设主联系人',
}
```

- [ ] **Step 2: `types/index.ts` 追加 `export * from './audit'`**

- [ ] **Step 3: `crm-client.ts` 接口加 `listAuditLogs(params: AuditLogQuery): Promise<Paginated<AuditLog>>`**（import `AuditLog, AuditLogQuery`）

- [ ] **Step 4: `http-crm-client.ts` 实现**

```typescript
  async listAuditLogs(params: AuditLogQuery): Promise<Paginated<AuditLog>> {
    const qs = new URLSearchParams()
    if (params.entityType) qs.set('entity_type', params.entityType)
    if (params.entityId) qs.set('entity_id', params.entityId)
    if (params.actorId) qs.set('actor_id', params.actorId)
    if (params.action) qs.set('action', params.action)
    qs.set('page', String(params.page ?? 1))
    qs.set('page_size', String(params.pageSize ?? 20))
    const dto = await request<AuditLogListDto>(`/audit-logs?${qs.toString()}`)
    return { items: dto.items.map(mapAuditLog), total: dto.total, page: dto.page, pageSize: dto.page_size }
  }
```
配套 `AuditLogListDto` + `mapAuditLog`（snake→camel，id/entity_id 转 string，放 `dto-mappers.ts`，参照现有 mapper）。

- [ ] **Step 5: `mock-crm-client.ts` 加 mock + `MockState.audits: AuditLog[]`**

```typescript
  async listAuditLogs(params: AuditLogQuery): Promise<Paginated<AuditLog>> {
    const all = this.state.audits ?? []
    const filtered = all.filter((a) =>
      (!params.entityType || a.entityType === params.entityType) &&
      (!params.entityId || a.entityId === params.entityId) &&
      (!params.action || a.action === params.action))
    const page = params.page ?? 1, pageSize = params.pageSize ?? 20
    return { items: filtered.slice((page - 1) * pageSize, page * pageSize), total: filtered.length, page, pageSize }
  }
```
**注意**：`loadState()` 的空状态 return 里补 `audits: []`（否则 build 报 MockState 缺字段——P2c 修 contacts 的教训）。

- [ ] **Step 6: 前端门禁**

```bash
cd frontend && pnpm lint && pnpm build && pnpm test
```
Expected: lint 0 错 / build ✓ / test 通过。

- [ ] **Step 7: Commit**

```bash
git add frontend/lib/crm/types/audit.ts frontend/lib/crm/types/index.ts frontend/lib/crm/api/crm-client.ts frontend/lib/crm/api/http-crm-client.ts frontend/lib/crm/api/mock-crm-client.ts frontend/lib/crm/api/dto-mappers.ts
git commit -m "feat(crm): 审计日志前端类型 + client 三件套"
```

---

## Task A5: 前端审计可视化（抽屉 tab + 管理员页 + sidebar）

**Files:**
- Create: `frontend/components/crm/crm-audit-timeline/index.tsx`
- Modify: `frontend/components/crm/crm-overview-drawer/index.tsx`（加「操作记录」tab）
- Create: `frontend/app/dashboard/crm/audit/page.tsx`
- Modify: `frontend/lib/sidebar-config.ts`（CRM 组加入口，admin 可见）

**Interfaces:**
- Consumes: `client.listAuditLogs`（Task A4）、`AUDIT_ACTION_LABELS`。
- Produces: `CrmAuditTimeline`（props `entityType`, `entityId`）；管理员审计页（全量 + 按对象/操作筛选 + 分页）。

- [ ] **Step 1: 建 `crm-audit-timeline/index.tsx`**

```tsx
'use client'

import { useQuery } from '@tanstack/react-query'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import { AUDIT_ACTION_LABELS } from '@/lib/crm/types'
import type { AuditLog } from '@/lib/crm/types'

interface Props {
  entityType: 'customer' | 'lead' | 'contact'
  entityId: string
}

export function CrmAuditTimeline({ entityType, entityId }: Props) {
  const client = useCrmClient()
  const { data, isLoading } = useQuery({
    queryKey: ['crm-audit', entityType, entityId],
    queryFn: () => client.listAuditLogs({ entityType, entityId, pageSize: 50 }),
  })

  if (isLoading) return <p className="py-6 text-center text-sm text-muted-foreground">加载中…</p>
  const items = data?.items ?? []
  if (items.length === 0) return <p className="py-6 text-center text-sm text-muted-foreground">暂无操作记录</p>

  return (
    <ol className="space-y-3 py-2">
      {items.map((log: AuditLog) => (
        <li key={log.id} className="flex gap-3 text-sm">
          <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-slate-300" />
          <div className="min-w-0">
            <p className="font-medium">
              {AUDIT_ACTION_LABELS[log.action] ?? log.action}
              <span className="ml-2 text-xs text-muted-foreground">
                {log.actorName ?? '系统'} · {new Date(log.createdAt).toLocaleString('zh-CN')}
              </span>
            </p>
            {log.summary && <p className="text-muted-foreground">{log.summary}</p>}
          </div>
        </li>
      ))}
    </ol>
  )
}
```

- [ ] **Step 2: 抽屉加「操作记录」tab**

`crm-overview-drawer/index.tsx` 的 `TabsList`（line ~108）加 trigger，`grid-cols` +1：
```tsx
<TabsTrigger value="audit">操作记录</TabsTrigger>
```
加 `TabsContent`：
```tsx
<TabsContent value="audit" className="mt-0">
  <CrmAuditTimeline entityType={entityType} entityId={entityId} />
</TabsContent>
```
import `CrmAuditTimeline`。

- [ ] **Step 3: 建管理员审计页 `app/dashboard/crm/audit/page.tsx`**

```tsx
'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import { AUDIT_ACTION_LABELS } from '@/lib/crm/types'
import type { AuditAction } from '@/lib/crm/types'

const ENTITY_LABELS: Record<string, string> = { customer: '客户', lead: '线索', contact: '联系人' }

export default function CrmAuditPage() {
  const client = useCrmClient()
  const [entityType, setEntityType] = useState('')
  const [action, setAction] = useState('')
  const [page, setPage] = useState(1)

  const { data, isLoading } = useQuery({
    queryKey: ['crm-audit-all', entityType, action, page],
    queryFn: () => client.listAuditLogs({ entityType: entityType || undefined, action: action || undefined, page, pageSize: 30 }),
  })

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      <h1 className="text-lg font-semibold">操作日志</h1>
      <div className="flex gap-2">
        <select className="rounded border px-2 py-1 text-sm" value={entityType} onChange={(e) => { setEntityType(e.target.value); setPage(1) }}>
          <option value="">全部对象</option>
          {Object.entries(ENTITY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select className="rounded border px-2 py-1 text-sm" value={action} onChange={(e) => { setAction(e.target.value); setPage(1) }}>
          <option value="">全部操作</option>
          {Object.entries(AUDIT_ACTION_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">加载中…</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground">
            <tr><th className="py-2">时间</th><th>对象</th><th>操作</th><th>操作人</th><th>变更</th></tr>
          </thead>
          <tbody>
            {(data?.items ?? []).map((log) => (
              <tr key={log.id} className="border-t">
                <td className="py-2 whitespace-nowrap">{new Date(log.createdAt).toLocaleString('zh-CN')}</td>
                <td>{ENTITY_LABELS[log.entityType]} #{log.entityId}</td>
                <td>{AUDIT_ACTION_LABELS[log.action as AuditAction] ?? log.action}</td>
                <td>{log.actorName ?? '系统'}</td>
                <td className="text-muted-foreground">{log.summary ?? '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="flex items-center gap-2 text-sm">
        <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="rounded border px-2 py-1 disabled:opacity-40">上一页</button>
        <span>第 {page} 页 / 共 {Math.ceil((data?.total ?? 0) / 30) || 1} 页</span>
        <button disabled={(data?.items.length ?? 0) < 30} onClick={() => setPage((p) => p + 1)} className="rounded border px-2 py-1 disabled:opacity-40">下一页</button>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: sidebar 加入口**

> 注意：`sidebar-config.ts` 的 roles/groupRoles 过滤**已移除**（CRM 组全员可见，line ~52 有说明）。故入口对所有人显示，**管理员权限由 API 层 `require_admin` 兜底**（非管理员访问页面时 `listAuditLogs` 返回 403，页面需优雅展示「无权限」）。

`frontend/lib/sidebar-config.ts` CRM 组 `items` 数组加一项（用现有 `{title,url,icon,matchPrefixes}` 结构，**不要写 roles**）：
```typescript
{
  title: '操作日志',
  url: '/dashboard/crm/audit',
  icon: IconMap.History,
  matchPrefixes: ['/dashboard/crm/audit'],
},
```
（`IconMap.History` 若无则选现有 lucide 图标如 `IconMap.FileText`。）

并在 `audit/page.tsx` 处理 403：`useQuery` 的 `error` 状态（或 `isError`）渲染「无权限查看操作日志（仅管理员）」，避免非管理员看到报错。

- [ ] **Step 5: 前端门禁**

```bash
cd frontend && pnpm lint && pnpm build && pnpm test
```
Expected: 全过。

- [ ] **Step 6: Commit**

```bash
git add frontend/components/crm/crm-audit-timeline/ frontend/components/crm/crm-overview-drawer/index.tsx frontend/app/dashboard/crm/audit/page.tsx frontend/lib/sidebar-config.ts
git commit -m "feat(crm): 审计日志可视化（抽屉tab+管理员页+入口）"
```

---

# Phase B · 高级筛选（实用档）

## Task B1: filter_engine（FilterCondition → SQLAlchemy where）

**Files:**
- Create: `backend/app/services/crm/filter_engine.py`
- Create: `backend/tests/services/crm/test_filter_engine.py`

**Interfaces:**
- Produces:
  - `apply_filters(stmt, model, filters: list[dict], allowed: dict[str, str])`：把 FilterCondition 列表（`{field,op,value}` 或 `{and:[...]}`/`{or:[...]}`）翻译成 SQLAlchemy 条件并 `stmt.where(...)`。**`allowed` 是前端字段名→模型属性名白名单**，非白名单字段抛 `ValueError`（防注入）。
  - 支持 op：`eq`/`neq`/`contains`(ilike)/`gt`/`lt`/`between`(value=[lo,hi])/`in`(value=list)/`is_null`/`is_not_null`。未知 op 抛 `ValueError`。
  - `CUSTOMER_FILTER_FIELDS` / `LEAD_FILTER_FIELDS`：白名单 dict。

- [ ] **Step 1: 写失败测试 `tests/services/crm/test_filter_engine.py`**

```python
"""filter_engine TDD tests — FilterCondition → SQLAlchemy where（列白名单防注入）。"""
from __future__ import annotations

import pytest
from sqlalchemy import select

from app.models.crm import CrmCustomer
from app.services.crm.filter_engine import CUSTOMER_FILTER_FIELDS, apply_filters


def _sql(filters):
    stmt = apply_filters(select(CrmCustomer), CrmCustomer, filters, CUSTOMER_FILTER_FIELDS)
    return str(stmt.compile(compile_kwargs={"literal_binds": True}))


def test_eq():
    assert "active" in _sql([{"field": "status", "op": "eq", "value": "active"}])


def test_in():
    assert "IN" in _sql([{"field": "rating", "op": "in", "value": ["A", "B"]}]).upper()


def test_contains_uses_ilike():
    sql = _sql([{"field": "industry", "op": "contains", "value": "电子"}]).upper()
    assert "ILIKE" in sql or "LOWER" in sql


def test_between():
    assert "BETWEEN" in _sql([{"field": "employeeCount", "op": "between", "value": [10, 100]}]).upper()


def test_is_null():
    assert "IS NULL" in _sql([{"field": "ownerId", "op": "is_null", "value": None}]).upper()


def test_or_nesting():
    sql = _sql([{"or": [
        {"field": "status", "op": "eq", "value": "active"},
        {"field": "rating", "op": "eq", "value": "A"},
    ]}]).upper()
    assert " OR " in sql


def test_unknown_field_rejected():
    with pytest.raises(ValueError):
        _sql([{"field": "name; DROP TABLE", "op": "eq", "value": "x"}])


def test_unknown_op_rejected():
    with pytest.raises(ValueError):
        _sql([{"field": "status", "op": "like_evil", "value": "x"}])
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd backend && .venv/bin/python -m pytest tests/services/crm/test_filter_engine.py -q
```
Expected: FAIL（`ModuleNotFoundError`）。

- [ ] **Step 3: 实现 `app/services/crm/filter_engine.py`**

```python
"""CRM 高级筛选引擎（P4 实用档）：FilterCondition → SQLAlchemy where。

安全核心：列白名单（allowed）。前端字段名必须先映射到模型真实属性名，
非白名单字段/未知运算符一律 ValueError（端点转 400），杜绝 SQL 注入。
"""
from __future__ import annotations

from sqlalchemy import and_, or_

# 前端字段名 → 模型属性名（白名单）。只有列出的字段可筛选。
CUSTOMER_FILTER_FIELDS: dict[str, str] = {
    "status": "status", "rating": "rating", "customerType": "customer_type",
    "interestedService": "interested_service", "source": "source",
    "ownerId": "owner_id", "industry": "industry",
    "employeeCount": "employee_count", "annualRevenue": "annual_revenue",
}

LEAD_FILTER_FIELDS: dict[str, str] = {
    "status": "status", "intent": "intent", "customerType": "customer_type",
    "interestedService": "interested_service", "source": "source", "ownerId": "owner_id",
}

_OPS = {"eq", "neq", "contains", "gt", "lt", "between", "in", "is_null", "is_not_null"}


def apply_filters(stmt, model, filters: list[dict], allowed: dict[str, str]):
    """把 FilterCondition 列表应用到 stmt（追加 where）。filters 为空直接返回。"""
    if not filters:
        return stmt
    return stmt.where(and_(*[_parse_condition(model, f, allowed) for f in filters]))


def _parse_condition(model, cond: dict, allowed: dict[str, str]):
    if "and" in cond:
        return and_(*[_parse_condition(model, c, allowed) for c in cond["and"]])
    if "or" in cond:
        return or_(*[_parse_condition(model, c, allowed) for c in cond["or"]])

    field, op, value = cond.get("field"), cond.get("op"), cond.get("value")
    if op not in _OPS:
        raise ValueError(f"不支持的运算符: {op}")
    attr_name = allowed.get(field)
    if attr_name is None:
        raise ValueError(f"不支持的筛选字段: {field}")
    col = getattr(model, attr_name)

    if op == "eq":
        return col == value
    if op == "neq":
        return col != value
    if op == "contains":
        return col.ilike(f"%{value}%")
    if op == "gt":
        return col > value
    if op == "lt":
        return col < value
    if op == "between":
        lo, hi = value
        return col.between(lo, hi)
    if op == "in":
        return col.in_(list(value))
    if op == "is_null":
        return col.is_(None)
    if op == "is_not_null":
        return col.is_not(None)
    raise ValueError(f"不支持的运算符: {op}")  # pragma: no cover
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd backend && .venv/bin/python -m pytest tests/services/crm/test_filter_engine.py -q
```
Expected: PASS（8 passed）。

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/crm/filter_engine.py backend/tests/services/crm/test_filter_engine.py
git commit -m "feat(crm): 高级筛选引擎 FilterCondition→where（白名单防注入）"
```

---

## Task B2: list 端点接 filters

**Files:**
- Modify: `backend/app/services/crm/customer_service.py`（`list_customers` 加 `filters`）
- Modify: `backend/app/services/crm/lead_service.py`（`list_leads` 加 `filters`）
- Modify: `backend/app/api/v1/endpoints/crm.py`（list 端点加 `filters` 查询参数 + 解析 + 400）
- Create: `backend/tests/api/crm/test_filter_api.py`

**Interfaces:**
- Consumes: `filter_engine.apply_filters` / `CUSTOMER_FILTER_FIELDS` / `LEAD_FILTER_FIELDS`（Task B1）。
- Produces: `list_customers(..., filters: list[dict] | None = None)`、`list_leads(..., filters: list[dict] | None = None)`；端点 `GET /crm/customers?filters=<json>` / `GET /crm/leads?filters=<json>`，非法字段/运算符 → HTTP 400。

- [ ] **Step 1: 写失败测试 `tests/api/crm/test_filter_api.py`**

```python
"""高级筛选端点集成测试（P4）：筛选生效 + 非法字段 400。"""
from __future__ import annotations

import json

import pytest
from sqlalchemy import text

ADMIN = "11111111-1111-1111-1111-111111111111"


@pytest.fixture(autouse=True)
def _clean(db_session):
    from app.db.session import SessionLocal

    s = SessionLocal()
    try:
        s.execute(text("truncate crm_follows, crm_contacts, crm_leads, crm_customers restart identity cascade"))
        s.commit()
    finally:
        s.close()
    yield


def _h():
    return {"X-Operator": ADMIN, "X-Is-Admin": "true"}


def test_filter_customers_by_status(client):
    client.post("/api/v1/crm/customers", json={"name": "C1", "status": "active"}, headers=_h())
    client.post("/api/v1/crm/customers", json={"name": "C2", "status": "lost"}, headers=_h())
    filters = json.dumps([{"field": "status", "op": "eq", "value": "lost"}])
    body = client.get("/api/v1/crm/customers", params={"filters": filters}, headers=_h()).json()
    assert body["total"] == 1 and body["items"][0]["name"] == "C2"


def test_filter_customers_by_rating_in(client):
    client.post("/api/v1/crm/customers", json={"name": "C1", "rating": "A"}, headers=_h())
    client.post("/api/v1/crm/customers", json={"name": "C2", "rating": "C"}, headers=_h())
    filters = json.dumps([{"field": "rating", "op": "in", "value": ["A", "B"]}])
    body = client.get("/api/v1/crm/customers", params={"filters": filters}, headers=_h()).json()
    assert body["total"] == 1 and body["items"][0]["name"] == "C1"


def test_filter_illegal_field_returns_400(client):
    filters = json.dumps([{"field": "evil_field", "op": "eq", "value": "x"}])
    assert client.get("/api/v1/crm/customers", params={"filters": filters}, headers=_h()).status_code == 400


def test_filter_leads_by_intent(client):
    client.post("/api/v1/crm/leads", json={"name": "L1", "intent": "high"}, headers=_h())
    client.post("/api/v1/crm/leads", json={"name": "L2", "intent": "low"}, headers=_h())
    filters = json.dumps([{"field": "intent", "op": "eq", "value": "high"}])
    body = client.get("/api/v1/crm/leads", params={"filters": filters}, headers=_h()).json()
    assert body["total"] == 1 and body["items"][0]["name"] == "L1"
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd backend && .venv/bin/python -m pytest tests/api/crm/test_filter_api.py -q
```
Expected: FAIL（filters 被忽略 / 400 未实现）。

- [ ] **Step 3: `customer_service.list_customers` 加 filters**

签名加 `filters: list[dict] | None = None`，在 keyword 过滤之后、`total` count 之前：
```python
    if filters:
        from app.services.crm.filter_engine import CUSTOMER_FILTER_FIELDS, apply_filters
        stmt = apply_filters(stmt, CrmCustomer, filters, CUSTOMER_FILTER_FIELDS)
```

- [ ] **Step 4: `lead_service.list_leads` 同样加 filters（用 `LEAD_FILTER_FIELDS` + `CrmLead`）**

- [ ] **Step 5: list 端点加 `filters` 查询参数 + 解析 + 400**

`list_customers` 端点（line ~70）签名加 `filters: str | None = Query(None)`，调用 service 前解析：
```python
    parsed_filters = None
    if filters:
        import json
        from fastapi import HTTPException
        try:
            parsed_filters = json.loads(filters)
        except json.JSONDecodeError:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="filters 非法 JSON")
    try:
        items, total = customer_service.list_customers(db, user_id=user_id, scope=resolve_scope(scope, is_admin), keyword=keyword, page=page, page_size=page_size, filters=parsed_filters)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
```
`list_leads` 端点同样处理。

- [ ] **Step 6: 跑端点 + 全 CRM 测试**

```bash
cd backend && .venv/bin/python -m pytest tests/api/crm/test_filter_api.py tests/services/crm/ tests/api/crm/ -q
```
Expected: PASS（无回归）。

- [ ] **Step 7: Commit**

```bash
git add backend/app/services/crm/customer_service.py backend/app/services/crm/lead_service.py backend/app/api/v1/endpoints/crm.py backend/tests/api/crm/test_filter_api.py
git commit -m "feat(crm): list 端点接高级筛选 filters + 400 处理"
```

---

## Task B3: 前端 filters 入站 + CrmTable 快捷筛选行

**Files:**
- Modify: `frontend/lib/crm/api/http-crm-client.ts`（`buildListQuery` 序列化 filters）
- Modify: `frontend/components/crm/crm-table/types.ts`（`CrmTableProps` 加 `filterFields`）
- Modify: `frontend/components/crm/crm-table/index.tsx`（快捷筛选行 + filters 状态）
- Create: `frontend/components/crm/crm-table/crm-table-filters.test.tsx`

**Interfaces:**
- Consumes: 后端 `filters` 查询参数（Task B2）；现有 `FilterFieldDef`（`crm-table/types.ts` 已定义：`{key,label,type,options?,field?}`）、`FilterCondition`。
- Produces: `CrmTable` 接受 `filterFields?: FilterFieldDef[]`，渲染快捷筛选行；选中项转 `FilterCondition`（select→`{field,op:'eq',value}`，multiselect→`{field,op:'in',value:[...]}`）注入 `fetchPage` 的 `ListParams.filters`；筛选变更重置到第 1 页。

- [ ] **Step 1: `http-crm-client.ts` `buildListQuery` 序列化 filters**

把第 75 行附近的注释「filters 后端暂不支持，不入站」改为实际序列化：
```typescript
  if (params.filters && params.filters.length > 0) {
    qs.set('filters', JSON.stringify(params.filters))
  }
```

- [ ] **Step 2: `crm-table/types.ts` `CrmTableProps` 加字段**

```typescript
  /** 表头快捷筛选字段定义（P4 实用档）；不传则不渲染筛选行 */
  filterFields?: FilterFieldDef[]
```

- [ ] **Step 3: 写组件测试 `crm-table-filters.test.tsx`**

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CrmTable } from './index'
import type { FilterFieldDef } from './types'

const fields: FilterFieldDef[] = [
  { key: 'status', label: '状态', type: 'select', field: 'status', options: [
    { label: '活跃', value: 'active' }, { label: '流失', value: 'lost' },
  ] },
]

const fetchPage = vi.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 20 }))

describe('CrmTable 快捷筛选', () => {
  it('选择筛选项后以 filters 调用 fetchPage', async () => {
    render(<CrmTable queryKey="t" fetchPage={fetchPage} columns={[]} rowKey="id" filterFields={fields} />)
    fireEvent.change(screen.getByLabelText('状态'), { target: { value: 'active' } })
    await vi.waitFor(() => {
      const last = fetchPage.mock.calls.at(-1)?.[0]
      expect(last?.filters).toEqual([{ field: 'status', op: 'eq', value: 'active' }])
    })
  })
})
```

- [ ] **Step 4: 跑测试确认失败**

```bash
cd frontend && pnpm test crm-table-filters
```
Expected: FAIL（筛选行未渲染 / fetchPage 未带 filters）。

- [ ] **Step 5: `crm-table/index.tsx` 实现快捷筛选行**

在组件内加 filters 状态 + 筛选行 UI（渲染在表格上方），并把 filters 注入 fetchPage：
```tsx
  const [filters, setFilters] = useState<FilterCondition[]>([])

  const filterFields = props.filterFields ?? []
  const handleFilterChange = (field: string, value: string) => {
    setFilters((prev) => {
      const rest = prev.filter((f) => !('field' in f) || f.field !== field)
      if (!value) return rest
      return [...rest, { field, op: 'eq', value }]
    })
    // 触发回到第 1 页（用现有 setPage/refresh 机制）
  }
```
fetchPage 调用处把 `filters` 并入 params：`fetchPage({ ...params, filters })`。
筛选行 JSX：
```tsx
  {filterFields.length > 0 && (
    <div className="mb-2 flex flex-wrap gap-2">
      {filterFields.map((f) => (
        <label key={f.key} className="flex items-center gap-1 text-sm">
          <span className="text-muted-foreground">{f.label}</span>
          <select
            aria-label={f.label}
            className="rounded border px-2 py-1"
            defaultValue=""
            onChange={(e) => handleFilterChange(f.field ?? f.key, e.target.value)}
          >
            <option value="">全部</option>
            {(f.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
      ))}
    </div>
  )}
```
import `FilterCondition`（types.ts 已 re-export）。

- [ ] **Step 6: 跑组件测试确认通过**

```bash
cd frontend && pnpm test crm-table-filters
```
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add frontend/lib/crm/api/http-crm-client.ts frontend/components/crm/crm-table/
git commit -m "feat(crm): CrmTable 快捷筛选行 + filters 入站"
```

---

## Task B4: 客户/线索表接入快捷筛选

**Files:**
- Modify: `frontend/components/crm/customer-table.tsx`（定义客户 `filterFields` 传入）
- Modify: `frontend/components/crm/lead-table.tsx`（定义线索 `filterFields` 传入）

**Interfaces:**
- Consumes: `CrmTable.filterFields`（Task B3）、各字段枚举 label（`@/lib/crm/enums/customer.enum` 等）、`useCrmUsers`（负责人筛选用）。
- Produces: 客户表筛选：状态/等级/对象类型/意向服务/负责人；线索表筛选：状态/意向度/对象类型/意向服务/负责人。

- [ ] **Step 1: `customer-table.tsx` 定义 filterFields 并传入 CrmTable**

```tsx
import { CUSTOMER_STATUS_LABELS, CUSTOMER_RATING_LABELS } from '@/lib/crm/enums/customer.enum'

// 组件内（users 来自 useCrmUsers）：
const customerFilterFields = [
  { key: 'status', label: '状态', type: 'select', field: 'status',
    options: Object.entries(CUSTOMER_STATUS_LABELS).map(([value, label]) => ({ value, label })) },
  { key: 'rating', label: '等级', type: 'select', field: 'rating',
    options: Object.entries(CUSTOMER_RATING_LABELS).map(([value, label]) => ({ value, label })) },
  { key: 'customerType', label: '对象类型', type: 'select', field: 'customerType',
    options: ['工厂', '贸易商', '同行', '其他'].map((v) => ({ value: v, label: v })) },
  { key: 'interestedService', label: '意向服务', type: 'select', field: 'interestedService',
    options: ['代运营', 'AI运营', '运营服务', '其他'].map((v) => ({ value: v, label: v })) },
  { key: 'ownerId', label: '负责人', type: 'select', field: 'ownerId',
    options: users.map((u) => ({ value: u.id, label: u.name })) },
] as const
```
`<CrmTable ... filterFields={customerFilterFields as FilterFieldDef[]} />`。
（对象类型/意向服务的可选值若已有枚举常量，优先复用枚举而非硬编码。）

- [ ] **Step 2: `lead-table.tsx` 定义线索 filterFields（状态/意向度/对象类型/意向服务/负责人）并传入**

参照客户表写法，字段用线索枚举（`status`/`intent` 等）。

- [ ] **Step 3: 前端门禁**

```bash
cd frontend && pnpm lint && pnpm build && pnpm test
```
Expected: 全过。

- [ ] **Step 4: Commit**

```bash
git add frontend/components/crm/customer-table.tsx frontend/components/crm/lead-table.tsx
git commit -m "feat(crm): 客户/线索表接入快捷筛选"
```

---

# 验证与部署

## Task V1: 全量门禁 + 合并 + 部署

- [ ] **Step 1: 后端全量测试（主 agent 串行跑，含两 phase 的 DB 测试）**

```bash
cd backend && .venv/bin/python -m pytest -q --ignore=tests/stress_test
```
Expected: 除另一 agent WIP 正在修的既有失败外，CRM 相关全绿。确认新增 `test_audit_service`/`test_audit_api`/`test_filter_engine`/`test_filter_api` 全过。

- [ ] **Step 2: 前端门禁**

```bash
cd frontend && pnpm lint && pnpm build && pnpm test
```
Expected: lint 0 错 / build ✓ / test 通过。

- [ ] **Step 3: 迁移上 prod 前确认单链**

```bash
cd backend && .venv/bin/python -m alembic heads   # 确认 220 单 head
```

- [ ] **Step 4: 合并进 main（--no-ff）+ 部署**

```bash
cd /Users/damon/DamonProjects/believeboyDashboard
git checkout main && git merge --no-ff <feature-branch> -m "Merge branch '<feature-branch>' into main

P4 审计日志 + 高级筛选（实用档）"
git deploy   # 后端改动 → VPS pull + alembic upgrade head(220) + restart + 健康检查；前端 Vercel 自动部署
```

- [ ] **Step 5: 线上冒烟**

```bash
# 审计：建一个客户后查审计日志
curl -s "https://<host>/api/v1/crm/audit-logs?action=create" -H "X-Operator: <admin-uuid>" -H "X-Is-Admin: true" | head
# 筛选：按状态筛客户
curl -s "https://<host>/api/v1/crm/customers?filters=%5B%7B%22field%22%3A%22status%22%2C%22op%22%3A%22eq%22%2C%22value%22%3A%22active%22%7D%5D" -H "X-Is-Admin: true" | head
```
Expected: 审计返回记录；筛选返回过滤后列表。前端验证：客户详情抽屉「操作记录」tab 有内容；客户/线索表头筛选下拉生效；管理员侧栏「操作日志」页可查。

---

## Self-Review 结论

- **Spec 覆盖**：F7 审计日志（记录 A1-A3 + 可视化 A4-A5）✅；F8 高级筛选实用档（引擎 B1 + 端点 B2 + 前端 B3-B4）✅。F9 权限细化按用户决定**砍掉**；F10 E2E **本次不做**。
- **占位符扫描**：无 TBD/TODO；各 step 含实际代码。
- **类型一致性**：`record_log`/`list_audit_logs`/`summarize_update`/`apply_filters`/`CUSTOMER_FILTER_FIELDS`/`LEAD_FILTER_FIELDS`/`AuditLog`/`listAuditLogs`/`filterFields` 在各 task 间签名一致。
- **已知注意点**：①A3 `batch_transfer`（客户/线索）需补 `user_id` 参数才能记操作人；②A4 mock 的 `MockState` 必须补 `audits: []` 否则 build 报错（P2c 教训）；③B3 `CrmTable` 筛选变更要重置到第 1 页；④迁移 220 建前必须 rebase origin/main 取单链、随分支同批合 main。
