# P2 通知中心 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建一套服务端通知系统：`notifications` 表 + CRUD API + 告警 dispatcher 写站内通知的钩子 + 前端铃铛/面板（30s 轮询未读数）。

**Architecture:** 新建 `Notification` 模型（Integer 主键）与 5 个 `/api/v1/notifications/*` 端点。改造 `dispatch_batch`：对 `in_app_enabled=True` 的用户，发邮件之外同时写一条 `type="alert"` 的 Notification 行（补上从未使用的 `in_app_enabled` 缺口）。前端新增 `useServerNotifications` hook（30s 轮询 unread-count，面板打开拉列表）+ 浮动铃铛 Popover，挂在 dashboard layout。与现有 toast 系统（`NotificationsProvider`）职责分离、共存。

**Tech Stack:** Python 3.11 / SQLAlchemy 2.0 / Alembic / FastAPI / pytest；Next.js 14 / React / TypeScript / shadcn ui（Popover, Badge, Button）/ Vitest + Testing Library。

## Global Constraints

- 主键统一 `Integer`（对齐 `alert_rule.py` 风格），勿用 `BigInteger`。
- Alembic 迁移命名：文件名 `YYYYMMDD_NNN_description.py`，revision id 用纯数字短 ID。本计划迁移：`revision="223"`，`down_revision="222"`。**建前先 `git fetch origin && git rebase origin/main` 再 `alembic heads` 确认单 head**（多 worktree 防撞）。
- Commit：中文 + Conventional Commits，scope 中文，subject 动宾短语 ≤50 字无句号。
- 前端取数走代理 `fetch('/api/backend/api/v1/<path>')`，不带手动 auth header。
- 用户识别：通知端点通过 `X-User-Id` header（代理从 session 注入），与现有 alerts preferences 一致。
- 测试顺序：前端 `pnpm lint` → `pnpm build` → `pnpm test`；后端 `cd backend && pytest`。

---

## File Structure

**Backend（新增 4 + 改 3）：**
- Create: `backend/app/models/notification.py` — `Notification` 模型
- Create: `backend/alembic/versions/20260729_223_notifications.py` — 建表迁移
- Create: `backend/app/schemas/notification.py` — Pydantic schemas
- Create: `backend/app/api/v1/endpoints/notifications.py` — 5 个端点
- Modify: `backend/app/models/__init__.py` — 注册 `Notification`
- Modify: `backend/app/api/v1/router.py` — 挂 `notifications_router`
- Modify: `backend/app/services/alert/dispatcher.py` — `dispatch_batch` 写站内通知
- Test: `backend/tests/api/test_notifications_api.py`
- Test: `backend/tests/services/alert/test_dispatcher_in_app.py`

**Frontend（新增 4 + 改 1）：**
- Create: `frontend/lib/notifications-api.ts` — 通知 API 客户端 + 类型
- Create: `frontend/components/notifications/use-server-notifications.ts` — 轮询 hook
- Create: `frontend/components/notifications/notification-bell.tsx` — 铃铛 + Popover + 面板 + 单条
- Modify: `frontend/app/dashboard/layout.tsx` — 挂铃铛
- Test: `frontend/lib/__tests__/notifications-api.test.ts`

---

### Task 1: Notification 模型 + 迁移 + 注册

**Files:**
- Create: `backend/app/models/notification.py`
- Create: `backend/alembic/versions/20260729_223_notifications.py`
- Modify: `backend/app/models/__init__.py`

**Interfaces:**
- Produces: `app.models.notification.Notification`（字段：`id, user_id, type, title, message, data, read, read_at, created_at`）

- [ ] **Step 1: 同步 main 并确认单 head**

Run:
```bash
cd backend
git fetch origin && git rebase origin/main
alembic heads
```
Expected: 只输出一个 head（应为 `222 (head)`）。若多 head，先按 AGENTS.md 跑 `alembic merge heads`。

- [ ] **Step 2: 写模型**

创建 `backend/app/models/notification.py`：

```python
"""站内通知模型。

告警事件、系统消息等统一写入此表，前端铃铛轮询消费。
type 字段预留扩展：V1 仅 "alert" | "system"，后续可加 "crm_follow_up" / "replenishment"。
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSON
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class Notification(Base):
    __tablename__ = "notifications"
    __table_args__ = (
        Index("idx_notif_user_read", "user_id", "read"),
        Index("idx_notif_user_created", "user_id", "created_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("user_accounts.id", ondelete="CASCADE"), nullable=False, index=True
    )
    type: Mapped[str] = mapped_column(String(32), nullable=False)
    title: Mapped[str] = mapped_column(String(256), nullable=False)
    message: Mapped[str | None] = mapped_column(Text, nullable=True)
    data: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    read: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
```

- [ ] **Step 3: 注册到 models/__init__.py**

编辑 `backend/app/models/__init__.py`。在 `from app.models.notification_subscription import NotificationSubscription` 那行之后加：

```python
from app.models.notification import Notification
```

在 `__all__` 列表里 `'NotificationSubscription',` 之后加：

```python
    'Notification',
```

- [ ] **Step 4: 生成迁移文件**

Run:
```bash
cd backend
alembic revision --rev-id 223 -m "新建 notifications 站内通知表"
```
Expected: 生成 `alembic/versions/20260729_223_*.py`（若日期前缀不同，重命名为 `20260729_223_notifications.py`）。

- [ ] **Step 5: 填迁移内容**

把生成的迁移文件 `upgrade()` / `downgrade()` 改为：

```python
"""新建 notifications 站内通知表

Revision ID: 223
Revises: 222
Create Date: 2026-07-29
"""
from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "223"
down_revision: Union[str, None] = "222"
branch_labels: Union[str, None] = None
depends_on: Union[str, None] = None


def upgrade() -> None:
    op.create_table(
        "notifications",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("type", sa.String(length=32), nullable=False),
        sa.Column("title", sa.String(length=256), nullable=False),
        sa.Column("message", sa.Text(), nullable=True),
        sa.Column("data", sa.JSON(), nullable=True),
        sa.Column("read", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["user_accounts.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("idx_notif_user_read", "notifications", ["user_id", "read"])
    op.create_index("idx_notif_user_created", "notifications", ["user_id", "created_at"])
    op.create_index(op.f("ix_notifications_user_id"), "notifications", ["user_id"])


def downgrade() -> None:
    op.drop_index(op.f("ix_notifications_user_id"), table_name="notifications")
    op.drop_index("idx_notif_user_created", table_name="notifications")
    op.drop_index("idx_notif_user_read", table_name="notifications")
    op.drop_table("notifications")
```

（确认生成的文件里 `revision`/`down_revision` 与上面一致；`sa.JSON()` 在 PostgreSQL 上落到 json 列。）

- [ ] **Step 6: 应用迁移并验证**

Run:
```bash
cd backend
alembic upgrade head
python -c "from app.models import Notification; print(Notification.__tablename__)"
```
Expected: 迁移成功；打印 `notifications`

- [ ] **Step 7: Commit**

```bash
cd backend
git add app/models/notification.py app/models/__init__.py alembic/versions/20260729_223_*
git commit -m "feat(通知): 新增 Notification 模型与建表迁移 223"
```

---

### Task 2: Notification schemas

**Files:**
- Create: `backend/app/schemas/notification.py`

**Interfaces:**
- Produces: `NotificationItem` / `NotificationListResponse` / `UnreadCountResponse`

- [ ] **Step 1: 写 schemas**

创建 `backend/app/schemas/notification.py`：

```python
from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel


class NotificationItem(BaseModel):
    id: int
    user_id: int
    type: str
    title: str
    message: Optional[str] = None
    data: Optional[dict] = None
    read: bool
    read_at: Optional[datetime] = None
    created_at: datetime

    model_config = {"from_attributes": True}


class NotificationListResponse(BaseModel):
    items: list[NotificationItem]
    total: int
    page: int
    page_size: int


class UnreadCountResponse(BaseModel):
    count: int
```

- [ ] **Step 2: 验证可导入**

Run: `cd backend && python -c "from app.schemas.notification import NotificationItem, NotificationListResponse, UnreadCountResponse; print('ok')"`
Expected: `ok`

- [ ] **Step 3: Commit**

```bash
cd backend
git add app/schemas/notification.py
git commit -m "feat(通知): 新增通知 Pydantic schemas"
```

---

### Task 3: Notification API 端点 + 路由注册

**Files:**
- Create: `backend/app/api/v1/endpoints/notifications.py`
- Modify: `backend/app/api/v1/router.py`

**Interfaces:**
- Consumes: `app.models.Notification`（Task 1）、`app.schemas.notification.*`（Task 2）、`get_read_db_session` / `get_primary_db_session` / `protected`（均来自 `app.api.deps`，与 alerts.py 同款）
- Produces: 端点 `GET /notifications`、`GET /notifications/unread-count`、`POST /notifications/{id}/read`、`POST /notifications/read-all`、`DELETE /notifications/{id}`

- [ ] **Step 1: 写端点**

创建 `backend/app/api/v1/endpoints/notifications.py`：

```python
"""站内通知端点。

用户识别走 X-User-Id header（代理从 session 注入），与 alerts preferences 一致。
"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from sqlalchemy.orm import Session

from app.api.deps import get_primary_db_session, get_read_db_session, protected
from app.models.notification import Notification
from app.schemas.notification import (
    NotificationItem,
    NotificationListResponse,
    UnreadCountResponse,
)

router = APIRouter(prefix="/notifications", tags=["notifications"], dependencies=[Depends(protected)])


def _require_user_id(x_user_id: str | None) -> int:
    if not x_user_id:
        raise HTTPException(status_code=401, detail="X-User-Id required")
    try:
        return int(x_user_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid X-User-Id")


@router.get("", response_model=NotificationListResponse)
def list_notifications(
    type: str | None = Query(default=None),
    read: bool | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_read_db_session),
    x_user_id: str | None = Header(default=None, alias="X-User-Id"),
) -> NotificationListResponse:
    user_id = _require_user_id(x_user_id)
    q = db.query(Notification).filter(Notification.user_id == user_id)
    if type:
        q = q.filter(Notification.type == type)
    if read is not None:
        q = q.filter(Notification.read == read)
    total = q.count()
    offset = (page - 1) * page_size
    items = q.order_by(Notification.created_at.desc()).offset(offset).limit(page_size).all()
    return NotificationListResponse(items=items, total=total, page=page, page_size=page_size)


@router.get("/unread-count", response_model=UnreadCountResponse)
def unread_count(
    db: Session = Depends(get_read_db_session),
    x_user_id: str | None = Header(default=None, alias="X-User-Id"),
) -> UnreadCountResponse:
    user_id = _require_user_id(x_user_id)
    count = (
        db.query(Notification)
        .filter(Notification.user_id == user_id, Notification.read == False)  # noqa: E712
        .count()
    )
    return UnreadCountResponse(count=count)


@router.post("/{notification_id}/read", response_model=NotificationItem)
def mark_read(
    notification_id: int,
    db: Session = Depends(get_primary_db_session),
    x_user_id: str | None = Header(default=None, alias="X-User-Id"),
) -> Notification:
    user_id = _require_user_id(x_user_id)
    notif = (
        db.query(Notification)
        .filter(Notification.id == notification_id, Notification.user_id == user_id)
        .first()
    )
    if not notif:
        raise HTTPException(status_code=404, detail="Notification not found")
    notif.read = True
    notif.read_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(notif)
    return notif


@router.post("/read-all", response_model=UnreadCountResponse)
def mark_all_read(
    db: Session = Depends(get_primary_db_session),
    x_user_id: str | None = Header(default=None, alias="X-User-Id"),
) -> UnreadCountResponse:
    user_id = _require_user_id(x_user_id)
    updated = (
        db.query(Notification)
        .filter(Notification.user_id == user_id, Notification.read == False)  # noqa: E712
        .update({Notification.read: True, Notification.read_at: datetime.now(timezone.utc)}, synchronize_session=False)
    )
    db.commit()
    return UnreadCountResponse(count=updated)


@router.delete("/{notification_id}", status_code=204)
def delete_notification(
    notification_id: int,
    db: Session = Depends(get_primary_db_session),
    x_user_id: str | None = Header(default=None, alias="X-User-Id"),
) -> None:
    user_id = _require_user_id(x_user_id)
    notif = (
        db.query(Notification)
        .filter(Notification.id == notification_id, Notification.user_id == user_id)
        .first()
    )
    if not notif:
        raise HTTPException(status_code=404, detail="Notification not found")
    db.delete(notif)
    db.commit()
```

> 导入路径已核对 `alerts.py:10`：四个依赖（`get_primary_db_session` / `get_read_db_session` / `get_request_operator` / `protected`）均来自 `app.api.deps`。本端点只用前三个里的两个 session 依赖 + `protected`，用户识别走 `X-User-Id` header，故未引入 `get_request_operator`（避免未使用导入）。

- [ ] **Step 2: 注册路由**

编辑 `backend/app/api/v1/router.py`。在 `from app.api.v1.endpoints.crm import router as crm_router` 那行后加：

```python
from app.api.v1.endpoints.notifications import router as notifications_router
```

在文件末尾 `api_router.include_router(crm_router)` 后加：

```python
api_router.include_router(notifications_router)
```

- [ ] **Step 3: 验证路由挂载**

Run: `cd backend && python -c "from app.main import app; print([r.path for r in app.routes if 'notifications' in r.path])"`
Expected: 列出 `/api/v1/notifications`、`/api/v1/notifications/unread-count`、`/api/v1/notifications/{notification_id}/read`、`/api/v1/notifications/read-all`、`/api/v1/notifications/{notification_id}`

- [ ] **Step 4: Commit**

```bash
cd backend
git add app/api/v1/endpoints/notifications.py app/api/v1/router.py
git commit -m "feat(通知): 新增通知 CRUD 与未读数端点并挂路由"
```

---

### Task 4: Dispatcher 写站内通知钩子

**Files:**
- Modify: `backend/app/services/alert/dispatcher.py`（`dispatch_batch`）
- Test: `backend/tests/services/alert/test_dispatcher_in_app.py`

**Interfaces:**
- Consumes: `app.models.Notification`（Task 1）、`AlertPreference.in_app_enabled`、`AlertEvent`
- Produces: `dispatch_batch` 对 `in_app_enabled=True` 的用户额外写 Notification 行

- [ ] **Step 1: 写失败测试**

创建 `backend/tests/services/alert/test_dispatcher_in_app.py`：

```python
"""dispatch_batch 站内通知钩子测试。

验证 in_app_enabled=True 的用户会收到 Notification 行，False 则不写。
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest


def _make_event(eid=1, project_id=3, severity="critical", message="销售额下降 -12%"):
    e = MagicMock()
    e.id = eid
    e.project_id = project_id
    e.severity = severity
    e.message = message
    return e


def _make_pref(in_app_enabled=True, email_enabled=False, min_severity="warning"):
    p = MagicMock()
    p.in_app_enabled = in_app_enabled
    p.email_enabled = email_enabled
    p.min_severity = min_severity
    p.quiet_hours_start = None
    p.quiet_hours_end = None
    return p


def test_dispatch_batch_writes_in_app_notification():
    from app.services.alert import dispatcher

    event = _make_event()
    db = MagicMock()

    with (
        patch.object(dispatcher, "_get_notification_recipients", return_value=[{"id": 7}]),
        patch.object(dispatcher, "_get_user_by_id", return_value={"id": 7, "email": None}),
        patch.object(dispatcher, "_get_preference", return_value=_make_pref(in_app_enabled=True)),
        patch.object(dispatcher, "send_alert_email") as mock_mail,
        patch.object(dispatcher, "Notification") as mock_notif_cls,
    ):
        dispatcher.dispatch_batch(db, [event])

    # in_app 写入：Notification 被构造且 db.add 被调用
    assert mock_notif_cls.called
    kwargs = mock_notif_cls.call_args.kwargs
    assert kwargs["user_id"] == 7
    assert kwargs["type"] == "alert"
    assert kwargs["data"]["alert_event_id"] == 1
    db.add.assert_called()
    # email_enabled=False，不发邮件
    mock_mail.assert_not_called()


def test_dispatch_batch_skips_in_app_when_disabled():
    from app.services.alert import dispatcher

    event = _make_event()
    db = MagicMock()

    with (
        patch.object(dispatcher, "_get_notification_recipients", return_value=[{"id": 7}]),
        patch.object(dispatcher, "_get_user_by_id", return_value={"id": 7, "email": None}),
        patch.object(dispatcher, "_get_preference", return_value=_make_pref(in_app_enabled=False)),
        patch.object(dispatcher, "Notification") as mock_notif_cls,
    ):
        dispatcher.dispatch_batch(db, [event])

    mock_notif_cls.assert_not_called()
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && pytest tests/services/alert/test_dispatcher_in_app.py -v`
Expected: FAIL（`dispatcher.Notification` 不存在 / 未写入）

- [ ] **Step 3: 改造 dispatch_batch**

编辑 `backend/app/services/alert/dispatcher.py`。在文件顶部 import 区加：

```python
from app.models.notification import Notification
```

把 `dispatch_batch` 函数（当前第 47-70 行）整体替换为：

```python
def dispatch_batch(db: Session, events: list[AlertEvent]) -> None:
    """Dispatch multiple events in batch, grouped by user.

    对 in_app_enabled=True 的用户额外写一条站内 Notification（补上此前
    in_app_enabled 字段从未被使用的缺口）。
    """
    from collections import defaultdict
    by_user: dict[int, list[AlertEvent]] = defaultdict(list)

    for event in events:
        users = _get_notification_recipients(db, event.project_id)
        for user in users:
            by_user[user["id"]].append(event)

    for user_id, user_events in by_user.items():
        user_row = _get_user_by_id(db, user_id)
        pref = _get_preference(db, user_id) or _create_default_preference(db, user_id)

        filtered = [e for e in user_events if _meets_severity_threshold(e.severity, pref.min_severity)]
        filtered = [e for e in filtered if not _in_quiet_hours(pref)]
        if not filtered:
            continue

        # 站内通知
        if pref.in_app_enabled:
            for evt in filtered:
                db.add(Notification(
                    user_id=user_id,
                    type="alert",
                    title=evt.message,
                    data={
                        "alert_event_id": evt.id,
                        "project_id": evt.project_id,
                        "severity": evt.severity,
                        "link": "/dashboard/system/alerts",
                    },
                ))

        # 邮件
        if pref.email_enabled and user_row and user_row.get("email"):
            send_alert_email(user_row["email"], filtered)

    db.commit()
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && pytest tests/services/alert/test_dispatcher_in_app.py -v`
Expected: PASS（2 passed）

- [ ] **Step 5: Commit**

```bash
cd backend
git add app/services/alert/dispatcher.py tests/services/alert/test_dispatcher_in_app.py
git commit -m "feat(通知): 告警分发为站内开启用户写入 Notification"
```

---

### Task 5: 通知 API 集成测试

**Files:**
- Create: `backend/tests/api/test_notifications_api.py`

**Interfaces:**
- Consumes: 通知端点（Task 3）、`Notification` 模型（Task 1）
- Produces: 覆盖列表/未读数/已读/全部已读/删除/鉴权的集成测试

- [ ] **Step 1: 写测试**

创建 `backend/tests/api/test_notifications_api.py`：

```python
"""通知 API 集成测试。

走 TestClient + 真实 DB（无 TEST_DATABASE_URL 则 skip，继承根 conftest 的 db_session 保护）。
每个测试前清空 notifications 表。
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.core.config import get_settings


def _headers(user_id: str) -> dict[str, str]:
    """protected 依赖需要 X-API-Key；端点用 X-User-Id 识别用户。"""
    return {"X-API-Key": get_settings().api_key, "X-User-Id": user_id}


@pytest.fixture
def client() -> TestClient:
    from app.main import app
    return TestClient(app)


@pytest.fixture(autouse=True)
def _clean_notifications(db_session):
    from app.db.session import SessionLocal
    s = SessionLocal()
    try:
        s.execute(text("truncate notifications restart identity cascade"))
        s.commit()
    finally:
        s.close()
    yield


def _seed(user_id: int, n: int, read: bool = False) -> None:
    from app.db.session import SessionLocal
    from app.models.notification import Notification
    s = SessionLocal()
    try:
        for i in range(n):
            s.add(Notification(user_id=user_id, type="alert", title=f"n{i}", read=read))
        s.commit()
    finally:
        s.close()


def test_unread_count_requires_user_id(client):
    # 带 API key 过 protected，但缺 X-User-Id → 端点自身返回 401
    res = client.get(
        "/api/v1/notifications/unread-count",
        headers={"X-API-Key": get_settings().api_key},
    )
    assert res.status_code == 401


def test_unread_count(client):
    _seed(7, 3, read=False)
    _seed(7, 2, read=True)
    res = client.get("/api/v1/notifications/unread-count", headers=_headers("7"))
    assert res.status_code == 200
    assert res.json()["count"] == 3


def test_list_paginates_and_filters(client):
    _seed(7, 5)
    res = client.get("/api/v1/notifications?page=1&page_size=2", headers=_headers("7"))
    body = res.json()
    assert res.status_code == 200
    assert body["total"] == 5
    assert len(body["items"]) == 2

    res_read = client.get("/api/v1/notifications?read=true", headers=_headers("7"))
    assert res_read.json()["total"] == 0


def test_mark_read_then_all(client):
    _seed(7, 3)
    listing = client.get("/api/v1/notifications", headers=_headers("7")).json()
    first_id = listing["items"][0]["id"]

    one = client.post(f"/api/v1/notifications/{first_id}/read", headers=_headers("7"))
    assert one.status_code == 200
    assert one.json()["read"] is True

    allres = client.post("/api/v1/notifications/read-all", headers=_headers("7"))
    assert allres.status_code == 200
    assert client.get("/api/v1/notifications/unread-count", headers=_headers("7")).json()["count"] == 0


def test_delete_and_isolation(client):
    _seed(7, 1)
    _seed(8, 1)  # 别的用户
    listing = client.get("/api/v1/notifications", headers=_headers("7")).json()
    assert listing["total"] == 1  # 只看到自己的
    nid = listing["items"][0]["id"]

    dele = client.delete(f"/api/v1/notifications/{nid}", headers=_headers("7"))
    assert dele.status_code == 204
    assert client.get("/api/v1/notifications", headers=_headers("7")).json()["total"] == 0
```

> 鉴权说明：`protected` 依赖 `require_api_key`，故每个请求必须带 `X-API-Key: settings.api_key`；端点用 `X-User-Id` 识别用户（`_headers` 已封装两者）。`test_unread_count_requires_user_id` 故意只带 API key 不带 X-User-Id，验证端点自身的 401。

- [ ] **Step 2: 跑测试**

Run: `cd backend && pytest tests/api/test_notifications_api.py -v`
Expected: PASS（5 passed）

- [ ] **Step 3: Commit**

```bash
cd backend
git add tests/api/test_notifications_api.py
git commit -m "test(通知): 新增通知 API 集成测试"
```

---

### Task 6: 前端通知 API 客户端

**Files:**
- Create: `frontend/lib/notifications-api.ts`
- Test: `frontend/lib/__tests__/notifications-api.test.ts`

**Interfaces:**
- Produces: 类型 `ServerNotification` / `NotificationListResponse`；函数 `fetchUnreadCount()` / `fetchNotifications(params)` / `markNotificationRead(id)` / `markAllNotificationsRead()` / `deleteNotification(id)`

- [ ] **Step 1: 写失败测试**

创建 `frontend/lib/__tests__/notifications-api.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { buildNotificationsQuery, type NotificationQuery } from '../notifications-api'

describe('buildNotificationsQuery', () => {
  it('拼出 type/read/分页', () => {
    const q: NotificationQuery = { type: 'alert', read: false, page: 2, page_size: 10 }
    const qs = buildNotificationsQuery(q)
    expect(qs).toContain('type=alert')
    expect(qs).toContain('read=false')
    expect(qs).toContain('page=2')
    expect(qs).toContain('page_size=10')
  })

  it('省略 undefined 字段', () => {
    const qs = buildNotificationsQuery({ page: 1, page_size: 20 })
    expect(qs).not.toContain('type')
    expect(qs).not.toContain('read')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && pnpm vitest run lib/__tests__/notifications-api.test.ts`
Expected: FAIL（无法解析 `../notifications-api`）

- [ ] **Step 3: 实现客户端**

创建 `frontend/lib/notifications-api.ts`：

```typescript
/**
 * 站内通知 API 客户端。
 * 走代理 /api/backend/api/v1/notifications/*，代理注入 X-User-Id。
 */

const BASE = '/api/backend/api/v1/notifications'

export interface ServerNotification {
  id: number
  user_id: number
  type: string
  title: string
  message: string | null
  data: { alert_event_id?: number; project_id?: number; severity?: string; link?: string } | null
  read: boolean
  read_at: string | null
  created_at: string
}

export interface NotificationListResponse {
  items: ServerNotification[]
  total: number
  page: number
  page_size: number
}

export interface NotificationQuery {
  type?: string
  read?: boolean
  page: number
  page_size: number
}

export function buildNotificationsQuery(q: NotificationQuery): string {
  const sp = new URLSearchParams()
  if (q.type) sp.set('type', q.type)
  if (q.read != null) sp.set('read', String(q.read))
  sp.set('page', String(q.page))
  sp.set('page_size', String(q.page_size))
  return sp.toString()
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`Notifications API ${res.status}: ${await res.text()}`)
  return res.json() as Promise<T>
}

export async function fetchUnreadCount(): Promise<number> {
  const res = await fetch(`${BASE}/unread-count`)
  const data = await jsonOrThrow<{ count: number }>(res)
  return data.count
}

export async function fetchNotifications(
  params: NotificationQuery
): Promise<NotificationListResponse> {
  const res = await fetch(`${BASE}?${buildNotificationsQuery(params)}`)
  return jsonOrThrow<NotificationListResponse>(res)
}

export async function markNotificationRead(id: number): Promise<void> {
  const res = await fetch(`${BASE}/${id}/read`, { method: 'POST' })
  if (!res.ok) throw new Error(`mark read ${res.status}`)
}

export async function markAllNotificationsRead(): Promise<void> {
  const res = await fetch(`${BASE}/read-all`, { method: 'POST' })
  if (!res.ok) throw new Error(`read-all ${res.status}`)
}

export async function deleteNotification(id: number): Promise<void> {
  const res = await fetch(`${BASE}/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`delete ${res.status}`)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd frontend && pnpm vitest run lib/__tests__/notifications-api.test.ts`
Expected: PASS（2 passed）

- [ ] **Step 5: Commit**

```bash
cd frontend
git add lib/notifications-api.ts lib/__tests__/notifications-api.test.ts
git commit -m "feat(通知): 新增前端通知 API 客户端与类型"
```

---

### Task 7: 轮询 hook

**Files:**
- Create: `frontend/components/notifications/use-server-notifications.ts`

**Interfaces:**
- Consumes: `fetchUnreadCount` / `fetchNotifications` / `markNotificationRead` / `markAllNotificationsRead`（Task 6）
- Produces: `useServerNotifications()` → `{ unreadCount, items, loading, open, setOpen, refresh, markRead, markAllRead }`

- [ ] **Step 1: 实现 hook**

创建 `frontend/components/notifications/use-server-notifications.ts`：

```tsx
'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchNotifications,
  fetchUnreadCount,
  markAllNotificationsRead,
  markNotificationRead,
  type ServerNotification,
} from '@/lib/notifications-api'

const POLL_MS = 30_000
const PAGE_SIZE = 20

export function useServerNotifications() {
  const [unreadCount, setUnreadCount] = useState(0)
  const [items, setItems] = useState<ServerNotification[]>([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const pollCount = useCallback(async () => {
    if (typeof document !== 'undefined' && document.hidden) return
    try {
      setUnreadCount(await fetchUnreadCount())
    } catch {
      /* 静默：轮询失败不打扰用户 */
    }
  }, [])

  // 挂载后启动 30s 轮询；卸载清理
  useEffect(() => {
    void pollCount()
    timerRef.current = setInterval(pollCount, POLL_MS)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [pollCount])

  const loadList = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetchNotifications({ page: 1, page_size: PAGE_SIZE })
      setItems(res.items)
    } catch {
      /* 静默 */
    } finally {
      setLoading(false)
    }
  }, [])

  // 面板打开时立即拉一次列表
  useEffect(() => {
    if (open) void loadList()
  }, [open, loadList])

  const markRead = useCallback(async (id: number) => {
    // 乐观更新
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)))
    setUnreadCount((c) => Math.max(0, c - 1))
    try {
      await markNotificationRead(id)
    } catch {
      void pollCount()
    }
  }, [pollCount])

  const markAllRead = useCallback(async () => {
    setItems((prev) => prev.map((n) => ({ ...n, read: true })))
    setUnreadCount(0)
    try {
      await markAllNotificationsRead()
    } catch {
      void pollCount()
    }
  }, [pollCount])

  return { unreadCount, items, loading, open, setOpen, refresh: loadList, markRead, markAllRead }
}
```

- [ ] **Step 2: 类型检查**

Run: `cd frontend && pnpm tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
cd frontend
git add components/notifications/use-server-notifications.ts
git commit -m "feat(通知): 新增服务端通知轮询 hook"
```

---

### Task 8: 铃铛 + 面板组件

**Files:**
- Create: `frontend/components/notifications/notification-bell.tsx`

**Interfaces:**
- Consumes: `useServerNotifications`（Task 7）、`ServerNotification`（Task 6）、shadcn `Popover`
- Produces: `NotificationBell()` 组件（浮动铃铛 + 未读徽标 + Popover 面板）

- [ ] **Step 1: 实现组件**

创建 `frontend/components/notifications/notification-bell.tsx`：

```tsx
'use client'

import { useRouter } from 'next/navigation'
import { Bell, CheckCheck } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useServerNotifications } from './use-server-notifications'
import type { ServerNotification } from '@/lib/notifications-api'

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diff / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  return `${Math.floor(hr / 24)} 天前`
}

function NotificationRow({
  n,
  onClick,
}: {
  n: ServerNotification
  onClick: (n: ServerNotification) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onClick(n)}
      className={`flex w-full items-start gap-2 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-muted ${
        n.read ? 'opacity-70' : 'bg-primary/5'
      }`}
    >
      {!n.read && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" />}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{n.title}</div>
        {n.message && <div className="truncate text-xs text-muted-foreground">{n.message}</div>}
        <div className="mt-0.5 text-xs text-muted-foreground">{timeAgo(n.created_at)}</div>
      </div>
    </button>
  )
}

export function NotificationBell() {
  const router = useRouter()
  const { unreadCount, items, loading, open, setOpen, markRead, markAllRead } =
    useServerNotifications()

  const handleClick = (n: ServerNotification) => {
    if (!n.read) void markRead(n.id)
    const link = n.data?.link
    setOpen(false)
    if (link) router.push(link)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="通知"
          className="fixed right-4 top-3 z-50 flex h-10 w-10 items-center justify-center rounded-xl border border-border/65 bg-[hsl(var(--surface-overlay)/0.85)] shadow-md backdrop-blur transition-colors hover:bg-muted"
        >
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <Badge className="absolute -right-1 -top-1 h-5 min-w-5 px-1 text-[0.65rem]">
              {unreadCount > 99 ? '99+' : unreadCount}
            </Badge>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[360px] p-0">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <span className="text-sm font-semibold">通知</span>
          <Button size="sm" variant="ghost" onClick={() => void markAllRead()} disabled={unreadCount === 0}>
            <CheckCheck className="mr-1 h-3.5 w-3.5" /> 全部已读
          </Button>
        </div>
        <div className="max-h-[420px] overflow-y-auto p-2">
          {loading ? (
            <div className="py-8 text-center text-sm text-muted-foreground">加载中…</div>
          ) : items.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">暂无通知</div>
          ) : (
            <div className="space-y-1">
              {items.map((n) => (
                <NotificationRow key={n.id} n={n} onClick={handleClick} />
              ))}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
```

- [ ] **Step 2: 类型检查**

Run: `cd frontend && pnpm tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
cd frontend
git add components/notifications/notification-bell.tsx
git commit -m "feat(通知): 新增浮动铃铛与通知面板组件"
```

---

### Task 9: 挂载铃铛到 layout + 全量验证

**Files:**
- Modify: `frontend/app/dashboard/layout.tsx`

**Interfaces:**
- Consumes: `NotificationBell`（Task 8）
- Produces: 铃铛在所有 dashboard 页面右上角可见

- [ ] **Step 1: 挂载铃铛**

编辑 `frontend/app/dashboard/layout.tsx`。在顶部 import 区加：

```tsx
import { NotificationBell } from '@/components/notifications/notification-bell'
```

在 `return` 的 JSX 里，`<SidebarProvider>` 内层、与主内容 div 同级处加铃铛。找到：

```tsx
    <SidebarProvider>
      <div className="flex h-screen w-full overflow-hidden bg-[hsl(var(--surface-low))]">
```

改为：

```tsx
    <SidebarProvider>
      <NotificationBell />
      <div className="flex h-screen w-full overflow-hidden bg-[hsl(var(--surface-low))]">
```

- [ ] **Step 2: 跑前端完整测试链**

Run: `cd frontend && pnpm lint && pnpm build && pnpm test`
Expected: lint 无错误；build 成功；test 全绿

- [ ] **Step 3: 跑后端测试**

Run: `cd backend && pytest tests/api/test_notifications_api.py tests/services/alert/test_dispatcher_in_app.py -v`
Expected: 全绿

- [ ] **Step 4: 若有失败，修复后重跑并提交**

```bash
git add -A && git commit -m "fix(通知): 修复通知中心验证发现的问题"
```

（若无需修复则跳过。）
