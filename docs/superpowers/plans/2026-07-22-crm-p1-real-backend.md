# CRM P1 · 真实后端 + 身份 + 数据模型 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把 CRM 从 Mock 演示变为销售团队真实可用的工具——5 个实体（customer/contact/lead/opportunity/follow）落 Postgres，FastAPI 提供 CRUD + scope + 公海 + 转化，前端 `http-crm-client.ts` 对接真实后端，`NEXT_PUBLIC_CRM_API_MODE=http` 下全流程操作真实数据。

**架构：** 后端遵循现有约定（SQLAlchemy 2.0 `Mapped` 模型 + Alembic 迁移 + `app/api/v1/endpoints/crm.py` 薄路由 + `app/services/crm/` 业务层 + Pydantic v2 schema），身份读 `X-User-Id`（`get_request_user_id`），`owner_id` 指向 `user_accounts.id`。前端复用 P0 的 `CrmClient` 接口，仅实现 `http-crm-client.ts`（经 `/api/backend/[...path]` 代理，代理注入鉴权头，客户端只发 `Content-Type`），做 int↔string、snake↔camel 映射。Contact 拆分（P1-D1）：`crm_contacts` 为唯一事实源，客户列表/详情用 LEFT JOIN 计算 `primary_contact_*`，**前端 `Customer` 类型不变**。

**技术栈：** FastAPI 0.139 / SQLAlchemy 2.0 / Alembic 1.14 / Postgres（测试用专用 test DB）/ pytest + TestClient / Next.js 代理 / openapi-typescript / Vitest + Playwright

**上游规格：** [`docs/CRM-BASIC-PLAN.md`](../../CRM-BASIC-PLAN.md) §4（P1）。本计划覆盖 P1a-P1d 全部退出标准。

---

## 0. 前置约定（每个工作者开工前必读）

### 0.1 路径与前缀

- 后端路由定义路径以 `/crm/...` 开头（如 `/crm/customers`）；`api_router` 在 `app/main.py` 挂载于 `/api/v1`，故完整路径 `/api/v1/crm/customers`。**任务 1 第一步须验证此前缀**（读 `app/main.py` 的 `include_router(..., prefix=...)`）。
- 前端经 Next 代理访问：`fetch('/api/backend/v1/crm/customers')` → 代理规范化为 `http://<backend>/api/v1/crm/customers`，并由 `buildBackendProxyHeaders(session, ...)` 注入 `X-API-Key`/`X-User-Id`/`X-Operator`/`X-Is-Admin`/`X-Role-Type` 等。**`http-crm-client.ts` 只需设 `Content-Type`，绝不手动带鉴权头。**

### 0.2 身份与权限（遵循现有 deps，不发明）

- `from app.api.deps import protected, get_read_db_session, get_primary_db_session, get_request_user_id, get_request_is_admin, get_request_operator`
- 路由级鉴权：`router = APIRouter(dependencies=[Depends(protected)])`（校验 `X-API-Key`）。
- 当前用户 id：`user_id: str | None = Depends(get_request_user_id)` → 转 `int`（见任务 3 的 `_current_user_id` 辅助）。
- `owner_id` / `created_by` 存 `int`（`user_accounts.id`）。

### 0.3 测试基建（已存在，直接用）

- `backend/tests/conftest.py` 提供：`db_session`（事务回滚）、`settings`、种子账号 `test_admin/test_operator/test_businessdev`、鉴权头夹具 `admin_headers/operator_headers/businessdev_headers`（含 `X-API-Key`/`X-User-Id`/`X-Is-Admin`/`X-Role-Type`）。
- 依赖 `backend/.env.test` 的 `TEST_DATABASE_URL`；未配置则 DB 测试 skip。首次准备：`cd backend && python scripts/setup_test_db.py`（建库 + 迁移 + 种子账号）。
- **隔离注意**：`TestClient` 端点调用走独立 session 并 commit，`db_session` 的回滚清不掉。故 CRM 集成测试用 autouse 夹具 `TRUNCATE ... RESTART IDENTITY CASCADE`（独立 committing session）清表（见任务 7）。
- 集成测试用 `from fastapi.testclient import TestClient; from app.main import app`；`client = TestClient(app)`；请求带 `headers=admin_headers`。

### 0.4 模型 / 迁移 / Schema 风格（照抄现有）

- 模型：`Mapped`/`mapped_column`，`Base` 来自 `app.db.session`，`str`-enum 类，`__table_args__` 放 `Index`，时间戳 `server_default=func.now()`，`updated_at` 加 `onupdate=func.now()`，软删除 `is_deleted: Mapped[bool]`。
- 迁移：`op.create_table(...)`，主键 `sa.Column('id', sa.BigInteger().with_variant(sa.Integer, 'sqlite'), primary_key=True, autoincrement=True)`，`sa.DateTime(timezone=True), server_default=sa.func.now()`，`op.create_index(...)`，`upgrade` 用 `inspector.has_table` 幂等守卫，revision id 形如 `'20260722_300'`。
- Schema：Pydantic v2，`model_config = {"from_attributes": True}`，列表响应 `{items: list[...], total: int, page: int, page_size: int}`（snake_case 输出；前端映射成 camelCase）。

### 0.5 前后端字段映射（http-client 的核心职责）

| 维度 | 后端 | 前端 `Customer` 等 | 映射 |
|---|---|---|---|
| 主键 | `id: int` | `id: string` | `String(dto.id)` 出；入站 `Number(id)` |
| owner | `owner_id: int \| None` | `ownerId: string \| null` | `dto.owner_id != null ? String(dto.owner_id) : null` |
| 命名 | snake_case | camelCase | 逐字段映射（不整体转换，避免漏字段） |
| 时间 | ISO `datetime` | ISO `string` | 直接透传（`datetime.isoformat()` ↔ string） |

### 0.6 Commit 约定

中文 + Conventional Commits：`feat(crm): ...` / `test(crm): ...` / `chore(crm): ...`，subject ≤50 字无句号。每个任务末尾一次 commit。

---

## 1. 文件结构

### 后端（创建）

| 文件 | 职责 |
|---|---|
| `backend/app/models/crm.py` | 5 个模型：`CrmCustomer`/`CrmContact`/`CrmLead`/`CrmOpportunity`/`CrmFollow` + str-enum |
| `backend/alembic/versions/20260722_300_add_crm_tables.py` | 建 5 张表 + 索引 |
| `backend/app/schemas/crm.py` | Pydantic：各实体 `*Item`/`*Create`/`*Update`/`*ListResponse` + `CrmUserItem` |
| `backend/app/services/crm/__init__.py` | 包标记 |
| `backend/app/services/crm/customer_service.py` | customer CRUD + scope 过滤 + 批量转移/移公海 + 领取 + primary_contact join |
| `backend/app/services/crm/contact_service.py` | contact CRUD + primary 切换 |
| `backend/app/services/crm/lead_service.py` | lead CRUD + `convert_lead`（事务内建客户 + 标记 converted） |
| `backend/app/services/crm/opportunity_service.py` | opportunity CRUD |
| `backend/app/services/crm/follow_service.py` | follow 列表/创建 + 回写实体 `last_follow_at` |
| `backend/app/services/crm/user_service.py` | `list_crm_users`（查 `user_accounts` 活跃用户，供 crm-user-select） |
| `backend/app/services/crm/permissions.py` | 操作级权限（P1d） |
| `backend/app/api/v1/endpoints/crm.py` | 全部 CRM 路由（薄壳，调 service） |
| `backend/app/scripts/seed_crm.py` | dev 环境灌演示数据 |
| `backend/tests/api/crm/{__init__,conftest}.py` + `test_*.py` | 集成测试（清表夹具 + 各实体） |
| `backend/tests/services/crm/test_convert_lead.py` | convert_lead 纯 service 单测 |

### 后端（修改）

| 文件 | 改动 |
|---|---|
| `backend/app/models/__init__.py` | 导出 5 个 CRM 模型（Alembic autogenerate 需导入） |
| `backend/app/api/v1/router.py` | `include_router(crm_router)` |

### 前端（创建）

| 文件 | 职责 |
|---|---|
| `frontend/lib/crm/api/dto-mappers.ts` | snake→camel / int→string 纯函数映射 + 反向 input 映射 |
| `frontend/lib/crm/api/dto-mappers.test.ts` | 映射纯函数单测 |
| `frontend/components/crm/crm-contact-list/{index.tsx,contact-form.tsx,index.test.tsx}` | 详情 Drawer 联系人子列表（多联系人，additive） |

### 前端（修改）

| 文件 | 改动 |
|---|---|
| `frontend/lib/crm/api/http-crm-client.ts` | 从 `throw NotImplemented` 桩改为完整 `implements CrmClient`，经 `/api/backend/v1/crm/...` |
| `frontend/lib/crm/api/crm-client.ts` | `CrmClient` 接口补 `listContacts`/`createContact`/`updateContact`/`deleteContact` |
| `frontend/lib/crm/types/customer.ts` | 新增 `Contact`/`ContactInput` 类型（`Customer` 本体**不动**） |
| `frontend/lib/crm/api/mock-crm-client.ts` | 补 contact 4 方法（保持接口完整 + 单测） |
| `frontend/components/crm/crm-overview-drawer/index.tsx` | 详情 tab 接入 `CrmContactList`（客户实体时） |
| `frontend/types/api-generated/{openapi.json,api.d.ts}` | `gen:api-types` 重新生成（含 CRM 端点） |

---

## P1a · 纵向打通一片（customer + contact + 身份 + http-client）

> **退出标准**：`NEXT_PUBLIC_CRM_API_MODE=http` 下，客户列表/详情/新建/编辑/删除 + 联系人增删改 + 批量转移/移公海/领取，全部操作真实 Postgres；前后端类型 `gen:api-types:check` 绿。

### 任务 1：核对挂载前缀 + 建 CRM 模型与迁移

**文件：**
- 创建：`backend/app/models/crm.py`
- 创建：`backend/alembic/versions/20260722_300_add_crm_tables.py`
- 修改：`backend/app/models/__init__.py`

- [ ] **步骤 1：验证 `/api/v1` 挂载前缀**

读 `backend/app/main.py`，确认 `app.include_router(api_router, prefix="/api/v1", ...)`。记录实际前缀；若非 `/api/v1`，本计划所有 `/api/v1/crm/...` 路径按实际前缀替换。

- [ ] **步骤 2：编写模型 `backend/app/models/crm.py`**

```python
"""CRM domain models (customer / contact / lead / opportunity / follow)."""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class CrmCustomerStatus(str):
    ACTIVE = "active"
    LOST = "lost"
    SIGNED = "signed"
    ON_HOLD = "on_hold"


class CrmCustomerRating(str):
    A = "A"
    B = "B"
    C = "C"
    D = "D"


class CrmCustomerSource(str):
    REFERRAL = "referral"
    EXHIBITION = "exhibition"
    ONLINE_AD = "online_ad"
    COLD_CALL = "cold_call"
    OTHER = "other"


class CrmLeadStatus(str):
    NEW = "new"
    CONTACTING = "contacting"
    QUALIFIED = "qualified"
    CONVERTED = "converted"
    DISCARDED = "discarded"


class CrmLeadIntent(str):
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


class CrmOpportunityStage(str):
    LEAD_IN = "lead_in"
    QUALIFIED = "qualified"
    PROPOSAL = "proposal"
    NEGOTIATION = "negotiation"
    WON = "won"
    LOST = "lost"


class CrmFollowType(str):
    PHONE = "phone"
    VISIT = "visit"
    WECHAT = "wechat"
    EMAIL = "email"
    NOTE = "note"


class CrmFollowEntityType(str):
    CUSTOMER = "customer"
    LEAD = "lead"
    OPPORTUNITY = "opportunity"


class CrmCustomer(Base):
    __tablename__ = "crm_customers"
    __table_args__ = (
        Index("idx_cc_owner", "owner_id"),
        Index("idx_cc_status_rating", "status", "rating"),
        Index("idx_cc_last_follow", "last_follow_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    short_name: Mapped[str | None] = mapped_column(String(100))
    industry: Mapped[str | None] = mapped_column(String(100))
    rating: Mapped[str] = mapped_column(String(2), nullable=False, default=CrmCustomerRating.C)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default=CrmCustomerStatus.ACTIVE)
    source: Mapped[str | None] = mapped_column(String(30))
    owner_id: Mapped[int | None] = mapped_column(Integer)  # null = 在公海
    address: Mapped[str | None] = mapped_column(Text)
    website: Mapped[str | None] = mapped_column(String(300))
    annual_revenue: Mapped[float | None] = mapped_column(Numeric(16, 2))
    employee_count: Mapped[int | None] = mapped_column(Integer)
    remark: Mapped[str | None] = mapped_column(Text)
    last_follow_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[int | None] = mapped_column(Integer)
    is_deleted: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class CrmContact(Base):
    __tablename__ = "crm_contacts"
    __table_args__ = (Index("idx_ctc_customer", "customer_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    customer_id: Mapped[int] = mapped_column(
        ForeignKey("crm_customers.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    phone: Mapped[str | None] = mapped_column(String(50))
    email: Mapped[str | None] = mapped_column(String(200))
    title: Mapped[str | None] = mapped_column(String(100))  # 职务
    is_primary: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    remark: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class CrmLead(Base):
    __tablename__ = "crm_leads"
    __table_args__ = (
        Index("idx_cl_owner", "owner_id"),
        Index("idx_cl_status_intent", "status", "intent"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)  # 联系人名
    company: Mapped[str | None] = mapped_column(String(200))
    phone: Mapped[str | None] = mapped_column(String(50))
    email: Mapped[str | None] = mapped_column(String(200))
    wechat: Mapped[str | None] = mapped_column(String(100))
    source: Mapped[str | None] = mapped_column(String(30))
    status: Mapped[str] = mapped_column(String(20), nullable=False, default=CrmLeadStatus.NEW)
    intent: Mapped[str] = mapped_column(String(10), nullable=False, default=CrmLeadIntent.MEDIUM)
    owner_id: Mapped[int | None] = mapped_column(Integer)  # null = 在线索池
    expected_amount: Mapped[float | None] = mapped_column(Numeric(16, 2))
    expected_close_date: Mapped[str | None] = mapped_column(String(10))  # YYYY-MM-DD
    remark: Mapped[str | None] = mapped_column(Text)
    converted_to_customer_id: Mapped[int | None] = mapped_column(Integer)
    converted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[int | None] = mapped_column(Integer)
    is_deleted: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class CrmOpportunity(Base):
    __tablename__ = "crm_opportunities"
    __table_args__ = (
        Index("idx_co_customer", "customer_id"),
        Index("idx_co_owner_stage", "owner_id", "stage"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    customer_id: Mapped[int] = mapped_column(
        ForeignKey("crm_customers.id", ondelete="SET NULL"), nullable=True
    )
    amount: Mapped[float] = mapped_column(Numeric(16, 2), nullable=False, default=0)
    stage: Mapped[str] = mapped_column(String(20), nullable=False, default=CrmOpportunityStage.LEAD_IN)
    owner_id: Mapped[int | None] = mapped_column(Integer)
    expected_close_date: Mapped[str | None] = mapped_column(String(10))
    probability: Mapped[int | None] = mapped_column(Integer)  # 0-100
    linked_project_id: Mapped[int | None] = mapped_column(Integer)  # L3 挂接点（commission project，P5+）
    remark: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[int | None] = mapped_column(Integer)
    is_deleted: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class CrmFollow(Base):
    __tablename__ = "crm_follows"
    __table_args__ = (
        Index("idx_cf_entity", "entity_type", "entity_id"),
        Index("idx_cf_next", "next_follow_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    entity_type: Mapped[str] = mapped_column(String(20), nullable=False)
    entity_id: Mapped[int] = mapped_column(Integer, nullable=False)
    type: Mapped[str] = mapped_column(String(20), nullable=False, default=CrmFollowType.NOTE)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    next_follow_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
```

- [ ] **步骤 3：在 `backend/app/models/__init__.py` 导出模型**

在文件末尾追加（保持现有 import 风格）：

```python
from app.models.crm import (  # noqa: F401,E402
    CrmContact,
    CrmCustomer,
    CrmFollow,
    CrmLead,
    CrmOpportunity,
)
```

- [ ] **步骤 4：编写迁移 `backend/alembic/versions/20260722_300_add_crm_tables.py`**

```python
"""add crm tables (customer/contact/lead/opportunity/follow)

Revision ID: 20260722_300
Revises: 20260718_214_add_phase_fields_to_backup_records
Create Date: 2026-07-22 00:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260722_300"
down_revision: Union[str, None] = "20260718_214_add_phase_fields_to_backup_records"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _pk() -> sa.Column:
    return sa.Column(
        "id",
        sa.BigInteger().with_variant(sa.Integer, "sqlite"),
        primary_key=True,
        autoincrement=True,
    )


def _timestamps() -> list[sa.Column]:
    return [
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    ]


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not inspector.has_table("crm_customers"):
        op.create_table(
            "crm_customers",
            _pk(),
            sa.Column("name", sa.String(200), nullable=False),
            sa.Column("short_name", sa.String(100), nullable=True),
            sa.Column("industry", sa.String(100), nullable=True),
            sa.Column("rating", sa.String(2), nullable=False, server_default="C"),
            sa.Column("status", sa.String(20), nullable=False, server_default="active"),
            sa.Column("source", sa.String(30), nullable=True),
            sa.Column("owner_id", sa.Integer(), nullable=True),
            sa.Column("address", sa.Text(), nullable=True),
            sa.Column("website", sa.String(300), nullable=True),
            sa.Column("annual_revenue", sa.Numeric(16, 2), nullable=True),
            sa.Column("employee_count", sa.Integer(), nullable=True),
            sa.Column("remark", sa.Text(), nullable=True),
            sa.Column("last_follow_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("created_by", sa.Integer(), nullable=True),
            sa.Column("is_deleted", sa.Boolean(), nullable=False, server_default=sa.false()),
            *_timestamps(),
        )
        op.create_index("idx_cc_owner", "crm_customers", ["owner_id"])
        op.create_index("idx_cc_status_rating", "crm_customers", ["status", "rating"])
        op.create_index("idx_cc_last_follow", "crm_customers", ["last_follow_at"])

    if not inspector.has_table("crm_contacts"):
        op.create_table(
            "crm_contacts",
            _pk(),
            sa.Column("customer_id", sa.Integer(), sa.ForeignKey("crm_customers.id", ondelete="CASCADE"), nullable=False),
            sa.Column("name", sa.String(100), nullable=False),
            sa.Column("phone", sa.String(50), nullable=True),
            sa.Column("email", sa.String(200), nullable=True),
            sa.Column("title", sa.String(100), nullable=True),
            sa.Column("is_primary", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("remark", sa.Text(), nullable=True),
            *_timestamps(),
        )
        op.create_index("idx_ctc_customer", "crm_contacts", ["customer_id"])

    if not inspector.has_table("crm_leads"):
        op.create_table(
            "crm_leads",
            _pk(),
            sa.Column("name", sa.String(100), nullable=False),
            sa.Column("company", sa.String(200), nullable=True),
            sa.Column("phone", sa.String(50), nullable=True),
            sa.Column("email", sa.String(200), nullable=True),
            sa.Column("wechat", sa.String(100), nullable=True),
            sa.Column("source", sa.String(30), nullable=True),
            sa.Column("status", sa.String(20), nullable=False, server_default="new"),
            sa.Column("intent", sa.String(10), nullable=False, server_default="medium"),
            sa.Column("owner_id", sa.Integer(), nullable=True),
            sa.Column("expected_amount", sa.Numeric(16, 2), nullable=True),
            sa.Column("expected_close_date", sa.String(10), nullable=True),
            sa.Column("remark", sa.Text(), nullable=True),
            sa.Column("converted_to_customer_id", sa.Integer(), nullable=True),
            sa.Column("converted_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("created_by", sa.Integer(), nullable=True),
            sa.Column("is_deleted", sa.Boolean(), nullable=False, server_default=sa.false()),
            *_timestamps(),
        )
        op.create_index("idx_cl_owner", "crm_leads", ["owner_id"])
        op.create_index("idx_cl_status_intent", "crm_leads", ["status", "intent"])

    if not inspector.has_table("crm_opportunities"):
        op.create_table(
            "crm_opportunities",
            _pk(),
            sa.Column("name", sa.String(200), nullable=False),
            sa.Column("customer_id", sa.Integer(), sa.ForeignKey("crm_customers.id", ondelete="SET NULL"), nullable=True),
            sa.Column("amount", sa.Numeric(16, 2), nullable=False, server_default="0"),
            sa.Column("stage", sa.String(20), nullable=False, server_default="lead_in"),
            sa.Column("owner_id", sa.Integer(), nullable=True),
            sa.Column("expected_close_date", sa.String(10), nullable=True),
            sa.Column("probability", sa.Integer(), nullable=True),
            sa.Column("linked_project_id", sa.Integer(), nullable=True),
            sa.Column("remark", sa.Text(), nullable=True),
            sa.Column("created_by", sa.Integer(), nullable=True),
            sa.Column("is_deleted", sa.Boolean(), nullable=False, server_default=sa.false()),
            *_timestamps(),
        )
        op.create_index("idx_co_customer", "crm_opportunities", ["customer_id"])
        op.create_index("idx_co_owner_stage", "crm_opportunities", ["owner_id", "stage"])

    if not inspector.has_table("crm_follows"):
        op.create_table(
            "crm_follows",
            _pk(),
            sa.Column("entity_type", sa.String(20), nullable=False),
            sa.Column("entity_id", sa.Integer(), nullable=False),
            sa.Column("type", sa.String(20), nullable=False, server_default="note"),
            sa.Column("content", sa.Text(), nullable=False),
            sa.Column("next_follow_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("created_by", sa.Integer(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )
        op.create_index("idx_cf_entity", "crm_follows", ["entity_type", "entity_id"])
        op.create_index("idx_cf_next", "crm_follows", ["next_follow_at"])


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    for table in ("crm_follows", "crm_opportunities", "crm_leads", "crm_contacts", "crm_customers"):
        if inspector.has_table(table):
            op.drop_table(table)
```

> **注意**：`down_revision` 须指向当前最新 head。运行 `cd backend && alembic heads` 确认；若 head 不是 `20260718_214_...`，把 `down_revision` 改为实际 head 的 revision id。

- [ ] **步骤 5：在测试库应用迁移并验证**

运行：`cd backend && alembic upgrade head`（针对 `TEST_DATABASE_URL`，确认 `.env.test` 已加载或临时 `export`）
预期：5 张 `crm_*` 表创建成功，无报错。

- [ ] **步骤 6：Commit**

```bash
git add backend/app/models/crm.py backend/app/models/__init__.py backend/alembic/versions/20260722_300_add_crm_tables.py
git commit -m "feat(crm): 新增 CRM 五实体模型与迁移"
```

### 任务 2：CRM Schema（Pydantic v2）

**文件：**
- 创建：`backend/app/schemas/crm.py`

- [ ] **步骤 1：编写 schema**

```python
"""CRM API schemas (Pydantic v2)."""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

Scope = Literal["mine", "all", "sea"]


# ---------- Customer ----------
class CustomerCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    short_name: str | None = None
    industry: str | None = None
    rating: str = "C"
    status: str = "active"
    source: str | None = None
    owner_id: int | None = None
    address: str | None = None
    website: str | None = None
    annual_revenue: float | None = None
    employee_count: int | None = None
    remark: str | None = None


class CustomerUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    short_name: str | None = None
    industry: str | None = None
    rating: str | None = None
    status: str | None = None
    source: str | None = None
    owner_id: int | None = None
    address: str | None = None
    website: str | None = None
    annual_revenue: float | None = None
    employee_count: int | None = None
    remark: str | None = None


class CustomerItem(BaseModel):
    id: int
    name: str
    short_name: str | None = None
    industry: str | None = None
    rating: str
    status: str
    source: str | None = None
    owner_id: int | None = None
    owner_name: str | None = None
    # 来自 primary contact 的 join 计算字段（前端 Customer.contactName/Phone/Email 映射自这里）
    contact_name: str | None = None
    contact_phone: str | None = None
    contact_email: str | None = None
    address: str | None = None
    website: str | None = None
    annual_revenue: float | None = None
    employee_count: int | None = None
    remark: str | None = None
    last_follow_at: datetime | None = None
    created_by: int | None = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class CustomerListResponse(BaseModel):
    items: list[CustomerItem]
    total: int
    page: int
    page_size: int


# ---------- Contact ----------
class ContactCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    phone: str | None = None
    email: str | None = None
    title: str | None = None
    is_primary: bool = False
    remark: str | None = None


class ContactUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    phone: str | None = None
    email: str | None = None
    title: str | None = None
    is_primary: bool | None = None
    remark: str | None = None


class ContactItem(BaseModel):
    id: int
    customer_id: int
    name: str
    phone: str | None = None
    email: str | None = None
    title: str | None = None
    is_primary: bool
    remark: str | None = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


# ---------- Lead ----------
class LeadCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    company: str | None = None
    phone: str | None = None
    email: str | None = None
    wechat: str | None = None
    source: str | None = None
    status: str = "new"
    intent: str = "medium"
    owner_id: int | None = None
    expected_amount: float | None = None
    expected_close_date: str | None = None
    remark: str | None = None


class LeadUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    company: str | None = None
    phone: str | None = None
    email: str | None = None
    wechat: str | None = None
    source: str | None = None
    status: str | None = None
    intent: str | None = None
    owner_id: int | None = None
    expected_amount: float | None = None
    expected_close_date: str | None = None
    remark: str | None = None


class LeadItem(BaseModel):
    id: int
    name: str
    company: str | None = None
    phone: str | None = None
    email: str | None = None
    wechat: str | None = None
    source: str | None = None
    status: str
    intent: str
    owner_id: int | None = None
    owner_name: str | None = None
    expected_amount: float | None = None
    expected_close_date: str | None = None
    remark: str | None = None
    converted_to_customer_id: int | None = None
    converted_at: datetime | None = None
    created_by: int | None = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class LeadListResponse(BaseModel):
    items: list[LeadItem]
    total: int
    page: int
    page_size: int


class ConvertLeadRequest(BaseModel):
    # 可选：转化时覆盖客户字段；缺省用线索字段推断
    name: str | None = None
    rating: str | None = None
    source: str | None = None
    remark: str | None = None


class ConvertLeadResponse(BaseModel):
    lead: LeadItem
    customer: CustomerItem


# ---------- Opportunity ----------
class OpportunityCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    customer_id: int | None = None
    amount: float = 0
    stage: str = "lead_in"
    owner_id: int | None = None
    expected_close_date: str | None = None
    probability: int | None = Field(default=None, ge=0, le=100)
    remark: str | None = None


class OpportunityUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    customer_id: int | None = None
    amount: float | None = None
    stage: str | None = None
    owner_id: int | None = None
    expected_close_date: str | None = None
    probability: int | None = Field(default=None, ge=0, le=100)
    remark: str | None = None


class OpportunityItem(BaseModel):
    id: int
    name: str
    customer_id: int | None = None
    customer_name: str | None = None
    amount: float
    stage: str
    owner_id: int | None = None
    owner_name: str | None = None
    expected_close_date: str | None = None
    probability: int | None = None
    linked_project_id: int | None = None
    remark: str | None = None
    created_by: int | None = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class OpportunityListResponse(BaseModel):
    items: list[OpportunityItem]
    total: int
    page: int
    page_size: int


# ---------- Follow ----------
class FollowCreate(BaseModel):
    entity_type: Literal["customer", "lead", "opportunity"]
    entity_id: int
    type: str = "note"
    content: str = Field(min_length=1)
    next_follow_at: datetime | None = None


class FollowItem(BaseModel):
    id: int
    entity_type: str
    entity_id: int
    type: str
    content: str
    next_follow_at: datetime | None = None
    created_by: int | None = None
    created_by_name: str | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


# ---------- User (crm-user-select 数据源) ----------
class CrmUserItem(BaseModel):
    id: int
    name: str
    email: str
    role_type: str | None = None
    is_active: bool = True


# ---------- 批量操作 ----------
class BatchTransferRequest(BaseModel):
    ids: list[int] = Field(min_length=1)
    to_owner_id: int


class BatchIdsRequest(BaseModel):
    ids: list[int] = Field(min_length=1)
```

- [ ] **步骤 2：验证 schema 可导入**

运行：`cd backend && python -c "import app.schemas.crm as m; print(len(m.CustomerItem.model_fields))"`
预期：打印 CustomerItem 字段数（约 22），无 ImportError。

- [ ] **步骤 3：Commit**

```bash
git add backend/app/schemas/crm.py
git commit -m "feat(crm): 新增 CRM Pydantic schema"
```

---

### 任务 3：customer_service（CRUD + scope + 批量 + 公海 + primary contact join）

**文件：**
- 创建：`backend/app/services/crm/__init__.py`（空文件）
- 创建：`backend/app/services/crm/customer_service.py`

- [ ] **步骤 1：编写 service**

```python
"""Customer domain service: CRUD + scope filter + batch + sea + primary contact join."""
from __future__ import annotations

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.models.crm import CrmContact, CrmCustomer
from app.schemas.crm import CustomerCreate, CustomerUpdate


def _current_user_id(user_id: str | None) -> int | None:
    if user_id is None:
        return None
    try:
        return int(user_id.strip())
    except (ValueError, TypeError):
        return None


def _owner_name_map(db: Session, owner_ids: set[int]) -> dict[int, str]:
    """批量查 user_accounts.name，避免 N+1。"""
    from sqlalchemy import text

    if not owner_ids:
        return {}
    rows = db.execute(
        text("select id, name from public.user_accounts where id = any(:ids)"),
        {"ids": list(owner_ids)},
    ).all()
    return {int(r[0]): r[1] for r in rows}


def _primary_contact_map(db: Session, customer_ids: list[int]) -> dict[int, CrmContact]:
    """每个客户的主联系人（is_primary=true，无主则取最早一条）。"""
    if not customer_ids:
        return {}
    rows = (
        db.execute(
            select(CrmContact)
            .where(CrmContact.customer_id.in_(customer_ids))
            .order_by(CrmContact.customer_id, CrmContact.is_primary.desc(), CrmContact.id)
        )
        .scalars()
        .all()
    )
    result: dict[int, CrmContact] = {}
    for c in rows:
        result.setdefault(c.customer_id, c)  # 第一条即主联系人（已按 is_primary desc 排序）
    return result


def _to_item(db: Session, cust: CrmCustomer, owner_names: dict[int, str], primary: CrmContact | None):
    from app.schemas.crm import CustomerItem

    return CustomerItem(
        id=cust.id,
        name=cust.name,
        short_name=cust.short_name,
        industry=cust.industry,
        rating=cust.rating,
        status=cust.status,
        source=cust.source,
        owner_id=cust.owner_id,
        owner_name=owner_names.get(cust.owner_id) if cust.owner_id else None,
        contact_name=primary.name if primary else None,
        contact_phone=primary.phone if primary else None,
        contact_email=primary.email if primary else None,
        address=cust.address,
        website=cust.website,
        annual_revenue=float(cust.annual_revenue) if cust.annual_revenue is not None else None,
        employee_count=cust.employee_count,
        remark=cust.remark,
        last_follow_at=cust.last_follow_at,
        created_by=cust.created_by,
        created_at=cust.created_at,
        updated_at=cust.updated_at,
    )


def list_customers(
    db: Session,
    *,
    user_id: str | None,
    scope: str = "all",
    keyword: str | None = None,
    page: int = 1,
    page_size: int = 20,
    sort_by: str = "updated_at",
    sort_order: str = "desc",
) -> tuple[list, int]:
    cur = _current_user_id(user_id)
    stmt = select(CrmCustomer).where(CrmCustomer.is_deleted.is_(False))

    if scope == "mine" and cur is not None:
        stmt = stmt.where(CrmCustomer.owner_id == cur)
    elif scope == "sea":
        stmt = stmt.where(CrmCustomer.owner_id.is_(None))
    # scope == "all": 不加 owner 过滤（P4 引入部门粒度后按角色收紧）

    if keyword:
        like = f"%{keyword}%"
        stmt = stmt.where(or_(CrmCustomer.name.ilike(like), CrmCustomer.short_name.ilike(like)))

    total = db.execute(select(func.count()).select_from(stmt.subquery())).scalar_one()

    sort_col = getattr(CrmCustomer, sort_by, CrmCustomer.updated_at)
    stmt = stmt.order_by(sort_col.desc() if sort_order == "desc" else sort_col.asc())
    stmt = stmt.offset((page - 1) * page_size).limit(page_size)
    rows = db.execute(stmt).scalars().all()

    owner_names = _owner_name_map(db, {r.owner_id for r in rows if r.owner_id})
    primary_map = _primary_contact_map(db, [r.id for r in rows])
    items = [_to_item(db, r, owner_names, primary_map.get(r.id)) for r in rows]
    return items, int(total)


def get_customer(db: Session, customer_id: int):
    cust = db.execute(
        select(CrmCustomer).where(CrmCustomer.id == customer_id, CrmCustomer.is_deleted.is_(False))
    ).scalar_one_or_none()
    if cust is None:
        return None
    owner_names = _owner_name_map(db, {cust.owner_id} if cust.owner_id else set())
    primary = _primary_contact_map(db, [cust.id]).get(cust.id)
    return _to_item(db, cust, owner_names, primary)


def create_customer(db: Session, payload: CustomerCreate, *, user_id: str | None):
    cur = _current_user_id(user_id)
    cust = CrmCustomer(**payload.model_dump(exclude_unset=True), created_by=cur)
    if cust.owner_id is None and cur is not None:
        cust.owner_id = cur  # 默认归创建人
    db.add(cust)
    db.commit()
    db.refresh(cust)
    return get_customer(db, cust.id)


def update_customer(db: Session, customer_id: int, payload: CustomerUpdate):
    cust = db.execute(
        select(CrmCustomer).where(CrmCustomer.id == customer_id, CrmCustomer.is_deleted.is_(False))
    ).scalar_one_or_none()
    if cust is None:
        return None
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(cust, key, value)
    db.commit()
    db.refresh(cust)
    return get_customer(db, cust.id)


def delete_customer(db: Session, customer_id: int) -> bool:
    cust = db.execute(
        select(CrmCustomer).where(CrmCustomer.id == customer_id, CrmCustomer.is_deleted.is_(False))
    ).scalar_one_or_none()
    if cust is None:
        return False
    cust.is_deleted = True
    db.commit()
    return True


def batch_transfer(db: Session, ids: list[int], to_owner_id: int) -> int:
    rows = db.execute(
        select(CrmCustomer).where(CrmCustomer.id.in_(ids), CrmCustomer.is_deleted.is_(False))
    ).scalars().all()
    for cust in rows:
        cust.owner_id = to_owner_id
    db.commit()
    return len(rows)


def batch_move_to_sea(db: Session, ids: list[int]) -> int:
    rows = db.execute(
        select(CrmCustomer).where(CrmCustomer.id.in_(ids), CrmCustomer.is_deleted.is_(False))
    ).scalars().all()
    for cust in rows:
        cust.owner_id = None
    db.commit()
    return len(rows)


def claim_from_sea(db: Session, customer_id: int, *, user_id: str | None):
    cur = _current_user_id(user_id)
    if cur is None:
        return None
    cust = db.execute(
        select(CrmCustomer).where(
            CrmCustomer.id == customer_id,
            CrmCustomer.is_deleted.is_(False),
            CrmCustomer.owner_id.is_(None),
        )
    ).scalar_one_or_none()
    if cust is None:
        return None  # 不在公海或不存在
    cust.owner_id = cur
    db.commit()
    db.refresh(cust)
    return get_customer(db, cust.id)
```

- [ ] **步骤 2：验证可导入**

运行：`cd backend && python -c "import app.services.crm.customer_service as s; print(callable(s.list_customers))"`
预期：`True`。

- [ ] **步骤 3：Commit**

```bash
git add backend/app/services/crm/__init__.py backend/app/services/crm/customer_service.py
git commit -m "feat(crm): 客户 service（CRUD/scope/批量/公海）"
```

---

### 任务 4：contact_service（CRUD + primary 切换）

**文件：**
- 创建：`backend/app/services/crm/contact_service.py`

- [ ] **步骤 1：编写 service**

```python
"""Contact service: CRUD under a customer + single-primary enforcement."""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.crm import CrmContact, CrmCustomer
from app.schemas.crm import ContactCreate, ContactUpdate


def _customer_exists(db: Session, customer_id: int) -> bool:
    return (
        db.execute(
            select(CrmCustomer.id).where(
                CrmCustomer.id == customer_id, CrmCustomer.is_deleted.is_(False)
            )
        ).scalar_one_or_none()
        is not None
    )


def list_contacts(db: Session, customer_id: int) -> list[CrmContact]:
    return (
        db.execute(
            select(CrmContact)
            .where(CrmContact.customer_id == customer_id)
            .order_by(CrmContact.is_primary.desc(), CrmContact.id)
        )
        .scalars()
        .all()
    )


def _enforce_single_primary(db: Session, customer_id: int, keep_id: int) -> None:
    """把同客户下其他联系人的 is_primary 置 False。"""
    others = db.execute(
        select(CrmContact).where(
            CrmContact.customer_id == customer_id,
            CrmContact.id != keep_id,
            CrmContact.is_primary.is_(True),
        )
    ).scalars().all()
    for c in others:
        c.is_primary = False


def create_contact(db: Session, customer_id: int, payload: ContactCreate) -> CrmContact | None:
    if not _customer_exists(db, customer_id):
        return None
    contact = CrmContact(customer_id=customer_id, **payload.model_dump(exclude_unset=True))
    db.add(contact)
    db.flush()  # 拿 id
    if contact.is_primary:
        _enforce_single_primary(db, customer_id, contact.id)
    else:
        # 客户首个联系人自动成为主联系人
        existing = db.execute(
            select(CrmContact).where(CrmContact.customer_id == customer_id, CrmContact.id != contact.id)
        ).scalars().all()
        if not existing:
            contact.is_primary = True
    db.commit()
    db.refresh(contact)
    return contact


def update_contact(db: Session, contact_id: int, payload: ContactUpdate) -> CrmContact | None:
    contact = db.execute(select(CrmContact).where(CrmContact.id == contact_id)).scalar_one_or_none()
    if contact is None:
        return None
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(contact, key, value)
    db.flush()
    if contact.is_primary:
        _enforce_single_primary(db, contact.customer_id, contact.id)
    db.commit()
    db.refresh(contact)
    return contact


def delete_contact(db: Session, contact_id: int) -> bool:
    contact = db.execute(select(CrmContact).where(CrmContact.id == contact_id)).scalar_one_or_none()
    if contact is None:
        return False
    customer_id = contact.customer_id
    was_primary = contact.is_primary
    db.delete(contact)
    db.flush()
    if was_primary:
        remaining = db.execute(
            select(CrmContact).where(CrmContact.customer_id == customer_id).order_by(CrmContact.id)
        ).scalars().all()
        if remaining:
            remaining[0].is_primary = True
    db.commit()
    return True
```

- [ ] **步骤 2：验证可导入**

运行：`cd backend && python -c "import app.services.crm.contact_service as s; print(callable(s.create_contact))"`
预期：`True`。

- [ ] **步骤 3：Commit**

```bash
git add backend/app/services/crm/contact_service.py
git commit -m "feat(crm): 联系人 service（CRUD/主联系人唯一）"
```

---

### 任务 5：user_service（crm-user-select 数据源）

**文件：**
- 创建：`backend/app/services/crm/user_service.py`

- [ ] **步骤 1：编写 service**

```python
"""CRM user source: active user_accounts for crm-user-select."""
from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.schemas.crm import CrmUserItem


def list_crm_users(db: Session) -> list[CrmUserItem]:
    rows = db.execute(
        text(
            """
            select id, name, email, role_type, is_active
            from public.user_accounts
            where is_active = true
            order by name
            """
        )
    ).mappings().all()
    return [
        CrmUserItem(
            id=int(r["id"]),
            name=r["name"],
            email=r["email"],
            role_type=r.get("role_type"),
            is_active=bool(r["is_active"]),
        )
        for r in rows
    ]


def get_crm_user(db: Session, user_id: int) -> CrmUserItem | None:
    row = db.execute(
        text(
            """
            select id, name, email, role_type, is_active
            from public.user_accounts
            where id = :id
            limit 1
            """
        ),
        {"id": user_id},
    ).mappings().first()
    if row is None:
        return None
    return CrmUserItem(
        id=int(row["id"]),
        name=row["name"],
        email=row["email"],
        role_type=row.get("role_type"),
        is_active=bool(row["is_active"]),
    )
```

- [ ] **步骤 2：Commit**

```bash
git add backend/app/services/crm/user_service.py
git commit -m "feat(crm): 用户 service（crm-user-select 数据源）"
```

### 任务 6：CRM 路由（customer + contact + user 部分）

**文件：**
- 创建：`backend/app/api/v1/endpoints/crm.py`
- 修改：`backend/app/api/v1/router.py`

- [ ] **步骤 1：编写路由（本任务只含 customer/contact/user，lead/opportunity/follow 在 P1b/P1c 追加）**

```python
"""CRM API endpoints."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.api.deps import get_primary_db_session, get_read_db_session, get_request_user_id, protected
from app.schemas.crm import (
    BatchIdsRequest,
    BatchTransferRequest,
    ContactCreate,
    ContactItem,
    ContactUpdate,
    CustomerCreate,
    CustomerItem,
    CustomerListResponse,
    CustomerUpdate,
    CrmUserItem,
)
from app.services.crm import contact_service, customer_service, user_service

router = APIRouter(prefix="/crm", tags=["crm"], dependencies=[Depends(protected)])


# ---------- Customer ----------
@router.get("/customers", response_model=CustomerListResponse)
def list_customers(
    scope: str = Query("all"),
    keyword: str | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    sort_by: str = "updated_at",
    sort_order: str = "desc",
    db: Session = Depends(get_read_db_session),
    user_id: str | None = Depends(get_request_user_id),
):
    items, total = customer_service.list_customers(
        db, user_id=user_id, scope=scope, keyword=keyword,
        page=page, page_size=page_size, sort_by=sort_by, sort_order=sort_order,
    )
    return CustomerListResponse(items=items, total=total, page=page, page_size=page_size)


@router.post("/customers", response_model=CustomerItem, status_code=status.HTTP_201_CREATED)
def create_customer(
    payload: CustomerCreate,
    db: Session = Depends(get_primary_db_session),
    user_id: str | None = Depends(get_request_user_id),
):
    return customer_service.create_customer(db, payload, user_id=user_id)


@router.get("/customers/{customer_id}", response_model=CustomerItem)
def get_customer(customer_id: int, db: Session = Depends(get_read_db_session)):
    item = customer_service.get_customer(db, customer_id)
    if item is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Customer not found")
    return item


@router.patch("/customers/{customer_id}", response_model=CustomerItem)
def update_customer(
    customer_id: int,
    payload: CustomerUpdate,
    db: Session = Depends(get_primary_db_session),
):
    item = customer_service.update_customer(db, customer_id, payload)
    if item is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Customer not found")
    return item


@router.delete("/customers/{customer_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_customer(customer_id: int, db: Session = Depends(get_primary_db_session)):
    if not customer_service.delete_customer(db, customer_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Customer not found")


@router.post("/customers/batch-transfer", status_code=status.HTTP_204_NO_CONTENT)
def batch_transfer(payload: BatchTransferRequest, db: Session = Depends(get_primary_db_session)):
    customer_service.batch_transfer(db, payload.ids, payload.to_owner_id)


@router.post("/customers/batch-move-sea", status_code=status.HTTP_204_NO_CONTENT)
def batch_move_to_sea(payload: BatchIdsRequest, db: Session = Depends(get_primary_db_session)):
    customer_service.batch_move_to_sea(db, payload.ids)


@router.post("/customers/{customer_id}/claim", response_model=CustomerItem)
def claim_from_sea(
    customer_id: int,
    db: Session = Depends(get_primary_db_session),
    user_id: str | None = Depends(get_request_user_id),
):
    item = customer_service.claim_from_sea(db, customer_id, user_id=user_id)
    if item is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Customer not in sea")
    return item


# ---------- Contact ----------
@router.get("/customers/{customer_id}/contacts", response_model=list[ContactItem])
def list_contacts(customer_id: int, db: Session = Depends(get_read_db_session)):
    return contact_service.list_contacts(db, customer_id)


@router.post("/customers/{customer_id}/contacts", response_model=ContactItem, status_code=status.HTTP_201_CREATED)
def create_contact(
    customer_id: int,
    payload: ContactCreate,
    db: Session = Depends(get_primary_db_session),
):
    contact = contact_service.create_contact(db, customer_id, payload)
    if contact is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Customer not found")
    return contact


@router.patch("/contacts/{contact_id}", response_model=ContactItem)
def update_contact(contact_id: int, payload: ContactUpdate, db: Session = Depends(get_primary_db_session)):
    contact = contact_service.update_contact(db, contact_id, payload)
    if contact is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Contact not found")
    return contact


@router.delete("/contacts/{contact_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_contact(contact_id: int, db: Session = Depends(get_primary_db_session)):
    if not contact_service.delete_contact(db, contact_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Contact not found")


# ---------- User ----------
@router.get("/users", response_model=list[CrmUserItem])
def list_users(db: Session = Depends(get_read_db_session)):
    return user_service.list_crm_users(db)


@router.get("/users/{user_id}", response_model=CrmUserItem)
def get_user(user_id: int, db: Session = Depends(get_read_db_session)):
    item = user_service.get_crm_user(db, user_id)
    if item is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    return item
```

- [ ] **步骤 2：在 `router.py` 注册**

在 `backend/app/api/v1/router.py` 的 import 区追加：

```python
from app.api.v1.endpoints.crm import router as crm_router
```

在 `api_router.include_router(...)` 序列末尾追加：

```python
api_router.include_router(crm_router)
```

- [ ] **步骤 3：验证路由注册**

运行：`cd backend && python -c "from app.main import app; print([r.path for r in app.routes if '/crm/' in r.path][:6])"`
预期：打印含 `/api/v1/crm/customers` 等路径的列表。

- [ ] **步骤 4：Commit**

```bash
git add backend/app/api/v1/endpoints/crm.py backend/app/api/v1/router.py
git commit -m "feat(crm): 客户/联系人/用户 API 路由"
```

---

### 任务 7：CRM 集成测试基建（conftest + 清表夹具）

**文件：**
- 创建：`backend/tests/api/crm/__init__.py`（空文件）
- 创建：`backend/tests/api/crm/conftest.py`

- [ ] **步骤 1：编写 conftest**

```python
"""CRM integration-test fixtures: TestClient + per-test table truncation.

TestClient endpoint calls commit on their own session, so the root
``db_session`` rollback fixture does NOT clean them. We TRUNCATE the CRM
tables (with a committing session) before each test for isolation.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

CRM_TABLES = "crm_follows, crm_opportunities, crm_leads, crm_contacts, crm_customers"


@pytest.fixture
def client():
    from app.main import app

    return TestClient(app)


@pytest.fixture(autouse=True)
def _clean_crm():
    from app.db.session import SessionLocal

    session = SessionLocal()
    try:
        session.execute(text(f"TRUNCATE {CRM_TABLES} RESTART IDENTITY CASCADE"))
        session.commit()
    finally:
        session.close()
    yield
```

- [ ] **步骤 2：验证夹具可加载（写一个最小冒烟测试）**

创建 `backend/tests/api/crm/test_smoke.py`：

```python
def test_crm_users_endpoint(client, admin_headers):
    r = client.get("/api/v1/crm/users", headers=admin_headers)
    assert r.status_code == 200, r.text
    assert isinstance(r.json(), list)
```

运行：`cd backend && pytest tests/api/crm/test_smoke.py -v`
预期：PASS（若 `TEST_DATABASE_URL` 未配置则 SKIP——先跑 `python scripts/setup_test_db.py`）。

- [ ] **步骤 3：Commit**

```bash
git add backend/tests/api/crm/__init__.py backend/tests/api/crm/conftest.py backend/tests/api/crm/test_smoke.py
git commit -m "test(crm): 集成测试基建（TestClient/清表夹具）"
```

---

### 任务 8：customer 端点集成测试

**文件：**
- 创建：`backend/tests/api/crm/test_customers.py`

- [ ] **步骤 1：编写测试**

```python
"""Customer endpoint integration tests."""


def _create(client, headers, name="测试客户", **extra):
    body = {"name": name, "rating": "A", "status": "active", "source": "referral", **extra}
    r = client.post("/api/v1/crm/customers", json=body, headers=headers)
    assert r.status_code == 201, r.text
    return r.json()


def test_create_then_get(client, admin_headers):
    created = _create(client, admin_headers, name="甲公司")
    assert created["name"] == "甲公司"
    assert created["owner_id"] is not None  # 默认归创建人（admin）

    r = client.get(f"/api/v1/crm/customers/{created['id']}", headers=admin_headers)
    assert r.status_code == 200
    assert r.json()["id"] == created["id"]


def test_create_requires_name(client, admin_headers):
    r = client.post("/api/v1/crm/customers", json={"name": ""}, headers=admin_headers)
    assert r.status_code == 422


def test_list_pagination_and_keyword(client, admin_headers):
    for i in range(5):
        _create(client, admin_headers, name=f"客户{i}")
    r = client.get("/api/v1/crm/customers?page=1&page_size=2", headers=admin_headers)
    body = r.json()
    assert body["total"] == 5
    assert len(body["items"]) == 2
    assert body["page"] == 1 and body["page_size"] == 2

    r2 = client.get("/api/v1/crm/customers?keyword=客户3", headers=admin_headers)
    assert r2.json()["total"] == 1


def test_update_and_soft_delete(client, admin_headers):
    created = _create(client, admin_headers)
    r = client.patch(
        f"/api/v1/crm/customers/{created['id']}",
        json={"rating": "B", "status": "signed"},
        headers=admin_headers,
    )
    assert r.status_code == 200
    assert r.json()["rating"] == "B"

    d = client.delete(f"/api/v1/crm/customers/{created['id']}", headers=admin_headers)
    assert d.status_code == 204
    g = client.get(f"/api/v1/crm/customers/{created['id']}", headers=admin_headers)
    assert g.status_code == 404  # 软删除后不可见


def test_requires_api_key(client):
    r = client.get("/api/v1/crm/customers")  # 无 X-API-Key
    assert r.status_code in (401, 403)
```

- [ ] **步骤 2：运行测试验证通过**

运行：`cd backend && pytest tests/api/crm/test_customers.py -v`
预期：全 PASS（service 已在任务 3 实现）。若有 FAIL，按报错修 `customer_service.py`（如 owner 默认值、软删除过滤）。

- [ ] **步骤 3：Commit**

```bash
git add backend/tests/api/crm/test_customers.py
git commit -m "test(crm): 客户端点集成测试"
```

### 任务 9：contact 端点 + primary 同步测试

**文件：**
- 创建：`backend/tests/api/crm/test_contacts.py`

- [ ] **步骤 1：编写测试**

```python
"""Contact endpoint tests: CRUD + single-primary + primary join into customer."""


def _mk_customer(client, headers, name="甲"):
    r = client.post("/api/v1/crm/customers", json={"name": name}, headers=headers)
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _mk_contact(client, headers, cid, name="张三", **extra):
    r = client.post(
        f"/api/v1/crm/customers/{cid}/contacts",
        json={"name": name, "phone": "13800000000", **extra},
        headers=headers,
    )
    assert r.status_code == 201, r.text
    return r.json()


def test_first_contact_becomes_primary(client, admin_headers):
    cid = _mk_customer(client, admin_headers)
    c1 = _mk_contact(client, admin_headers, cid, name="张三")
    assert c1["is_primary"] is True


def test_primary_join_appears_on_customer(client, admin_headers):
    cid = _mk_customer(client, admin_headers)
    _mk_contact(client, admin_headers, cid, name="李四", phone="13911112222", email="li@x.com")
    r = client.get(f"/api/v1/crm/customers/{cid}", headers=admin_headers)
    body = r.json()
    assert body["contact_name"] == "李四"
    assert body["contact_phone"] == "13911112222"
    assert body["contact_email"] == "li@x.com"


def test_setting_new_primary_unset_others(client, admin_headers):
    cid = _mk_customer(client, admin_headers)
    _mk_contact(client, admin_headers, cid, name="张三")
    c2 = _mk_contact(client, admin_headers, cid, name="王五", is_primary=True)
    contacts = client.get(f"/api/v1/crm/customers/{cid}/contacts", headers=admin_headers).json()
    primaries = [c for c in contacts if c["is_primary"]]
    assert len(primaries) == 1
    assert primaries[0]["id"] == c2["id"]


def test_delete_primary_promotes_next(client, admin_headers):
    cid = _mk_customer(client, admin_headers)
    c1 = _mk_contact(client, admin_headers, cid, name="张三")
    _mk_contact(client, admin_headers, cid, name="王五")
    d = client.delete(f"/api/v1/crm/contacts/{c1['id']}", headers=admin_headers)
    assert d.status_code == 204
    contacts = client.get(f"/api/v1/crm/customers/{cid}/contacts", headers=admin_headers).json()
    assert len(contacts) == 1
    assert contacts[0]["is_primary"] is True
```

- [ ] **步骤 2：运行测试**

运行：`cd backend && pytest tests/api/crm/test_contacts.py -v`
预期：全 PASS。

- [ ] **步骤 3：Commit**

```bash
git add backend/tests/api/crm/test_contacts.py
git commit -m "test(crm): 联系人端点与主联系人同步测试"
```

---

### 任务 10：scope + 公海 + 权限测试

**文件：**
- 创建：`backend/tests/api/crm/test_scope_and_sea.py`

- [ ] **步骤 1：编写测试**

```python
"""Scope (mine/all/sea) + sea claim/move + batch transfer tests."""


def _mk(client, headers, name, owner_id=None):
    body = {"name": name}
    if owner_id is not None:
        body["owner_id"] = owner_id
    r = client.post("/api/v1/crm/customers", json=body, headers=headers)
    assert r.status_code == 201, r.text
    return r.json()


def test_scope_mine_only_own(client, admin_headers, operator_headers):
    _mk(client, admin_headers, "管理员的客户")                # owner=admin
    _mk(client, operator_headers, "运营的自己的客户")          # owner=operator
    _mk(client, operator_headers, "无主客户", owner_id=None)   # 公海

    mine = client.get("/api/v1/crm/customers?scope=mine", headers=operator_headers).json()
    assert mine["total"] == 1
    assert mine["items"][0]["name"] == "运营的自己的客户"

    all_ = client.get("/api/v1/crm/customers?scope=all", headers=operator_headers).json()
    assert all_["total"] == 3


def test_scope_sea_only_ownerless(client, admin_headers):
    _mk(client, admin_headers, "有主")
    _mk(client, admin_headers, "无主", owner_id=None)
    sea = client.get("/api/v1/crm/customers?scope=sea", headers=admin_headers).json()
    assert sea["total"] == 1
    assert sea["items"][0]["owner_id"] is None


def test_move_to_sea_then_claim(client, admin_headers, operator_headers, test_operator):
    cust = _mk(client, admin_headers, "待移公海")
    assert cust["owner_id"] is not None

    mv = client.post("/api/v1/crm/customers/batch-move-sea", json={"ids": [cust["id"]]}, headers=admin_headers)
    assert mv.status_code == 204
    assert client.get(f"/api/v1/crm/customers/{cust['id']}", headers=admin_headers).json()["owner_id"] is None

    claim = client.post(f"/api/v1/crm/customers/{cust['id']}/claim", headers=operator_headers)
    assert claim.status_code == 200
    assert claim.json()["owner_id"] == int(test_operator["id"])

    again = client.post(f"/api/v1/crm/customers/{cust['id']}/claim", headers=operator_headers)
    assert again.status_code == 409  # 已不在公海


def test_batch_transfer(client, admin_headers, test_businessdev):
    c1 = _mk(client, admin_headers, "客户A")
    c2 = _mk(client, admin_headers, "客户B")
    r = client.post(
        "/api/v1/crm/customers/batch-transfer",
        json={"ids": [c1["id"], c2["id"]], "to_owner_id": int(test_businessdev["id"])},
        headers=admin_headers,
    )
    assert r.status_code == 204
    got = client.get(f"/api/v1/crm/customers/{c1['id']}", headers=admin_headers).json()
    assert got["owner_id"] == int(test_businessdev["id"])
```

- [ ] **步骤 2：运行测试**

运行：`cd backend && pytest tests/api/crm/test_scope_and_sea.py -v`
预期：全 PASS。

- [ ] **步骤 3：Commit**

```bash
git add backend/tests/api/crm/test_scope_and_sea.py
git commit -m "test(crm): scope/公海领取/批量转移测试"
```

---

### 任务 11：前端 DTO 映射纯函数（snake→camel / int→string）

**文件：**
- 创建：`frontend/lib/crm/api/dto-mappers.ts`
- 创建：`frontend/lib/crm/api/dto-mappers.test.ts`

- [ ] **步骤 1：编写失败测试 `dto-mappers.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { mapCustomer, mapCustomerInput, mapPaginated } from './dto-mappers'

describe('mapCustomer', () => {
  it('把 snake_case + int id 映射为 camelCase + string id', () => {
    const dto = {
      id: 7,
      name: '甲',
      rating: 'A',
      status: 'active',
      source: 'referral',
      owner_id: 3,
      owner_name: '张三',
      contact_name: '李四',
      contact_phone: '138',
      contact_email: 'li@x.com',
      annual_revenue: 1000,
      employee_count: 50,
      last_follow_at: '2026-07-01T00:00:00+00:00',
      created_by: 1,
      created_at: '2026-07-01T00:00:00+00:00',
      updated_at: '2026-07-02T00:00:00+00:00',
    }
    const c = mapCustomer(dto as never)
    expect(c.id).toBe('7')
    expect(c.ownerId).toBe('3')
    expect(c.contactName).toBe('李四')
    expect(c.annualRevenue).toBe(1000)
    expect(c.createdBy).toBe('1')
  })

  it('owner_id=null → ownerId=null', () => {
    const c = mapCustomer({ id: 1, name: 'x', rating: 'C', status: 'active', owner_id: null, created_by: null, created_at: '', updated_at: '' } as never)
    expect(c.ownerId).toBeNull()
  })
})

describe('mapCustomerInput', () => {
  it('把前端 camelCase 输入转后端 snake_case（ownerId string→int）', () => {
    const input = mapCustomerInput({ name: '甲', rating: 'A', status: 'active', source: 'referral', ownerId: '5' } as never)
    expect(input.owner_id).toBe(5)
    expect(input.name).toBe('甲')
  })
})

describe('mapPaginated', () => {
  it('映射 page_size → pageSize 并逐项映射 items', () => {
    const p = mapPaginated({ items: [{ id: 1, name: 'a', rating: 'C', status: 'active', owner_id: null, created_by: null, created_at: '', updated_at: '' }], total: 1, page: 1, page_size: 20 } as never, mapCustomer)
    expect(p.pageSize).toBe(20)
    expect(p.items[0].id).toBe('1')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd frontend && pnpm vitest run lib/crm/api/dto-mappers.test.ts`
预期：FAIL（`./dto-mappers` 不存在）。

- [ ] **步骤 3：编写实现 `dto-mappers.ts`**

```ts
import type { Customer, CustomerInput, Lead, Opportunity, Follow, User } from '@/lib/crm/types'
import type { Paginated } from './crm-client'

type AnyRecord = Record<string, unknown>

function strId(v: unknown): string {
  return v == null ? '' : String(v)
}
function nullableStrId(v: unknown): string | null {
  return v == null ? null : String(v)
}
function numId(v: unknown): number | undefined {
  if (v == null || v === '') return undefined
  const n = Number(v)
  return Number.isNaN(n) ? undefined : n
}

export function mapCustomer(dto: AnyRecord): Customer {
  return {
    id: strId(dto.id),
    name: dto.name as string,
    shortName: (dto.short_name as string) ?? undefined,
    industry: (dto.industry as string) ?? undefined,
    rating: dto.rating as Customer['rating'],
    status: dto.status as Customer['status'],
    source: (dto.source as Customer['source']) ?? 'other',
    ownerId: nullableStrId(dto.owner_id),
    ownerName: (dto.owner_name as string) ?? undefined,
    contactName: (dto.contact_name as string) ?? undefined,
    contactPhone: (dto.contact_phone as string) ?? undefined,
    contactEmail: (dto.contact_email as string) ?? undefined,
    address: (dto.address as string) ?? undefined,
    website: (dto.website as string) ?? undefined,
    annualRevenue: (dto.annual_revenue as number) ?? undefined,
    employeeCount: (dto.employee_count as number) ?? undefined,
    remark: (dto.remark as string) ?? undefined,
    createdAt: strId(dto.created_at),
    updatedAt: strId(dto.updated_at),
    createdBy: strId(dto.created_by),
    lastFollowAt: (dto.last_follow_at as string) ?? undefined,
  }
}

export function mapCustomerInput(input: CustomerInput): AnyRecord {
  return {
    name: input.name,
    short_name: input.shortName,
    industry: input.industry,
    rating: input.rating,
    status: input.status,
    source: input.source,
    owner_id: numId(input.ownerId),
    address: input.address,
    website: input.website,
    annual_revenue: input.annualRevenue,
    employee_count: input.employeeCount,
    remark: input.remark,
  }
}

export function mapLead(dto: AnyRecord): Lead {
  return {
    id: strId(dto.id),
    name: dto.name as string,
    company: (dto.company as string) ?? undefined,
    phone: (dto.phone as string) ?? undefined,
    email: (dto.email as string) ?? undefined,
    wechat: (dto.wechat as string) ?? undefined,
    source: (dto.source as Lead['source']) ?? 'other',
    status: dto.status as Lead['status'],
    intent: dto.intent as Lead['intent'],
    ownerId: nullableStrId(dto.owner_id),
    ownerName: (dto.owner_name as string) ?? undefined,
    expectedAmount: (dto.expected_amount as number) ?? undefined,
    expectedCloseDate: (dto.expected_close_date as string) ?? undefined,
    remark: (dto.remark as string) ?? undefined,
    createdAt: strId(dto.created_at),
    updatedAt: strId(dto.updated_at),
    convertedToCustomerId: nullableStrId(dto.converted_to_customer_id) ?? undefined,
    convertedAt: (dto.converted_at as string) ?? undefined,
  }
}

export function mapOpportunity(dto: AnyRecord): Opportunity {
  return {
    id: strId(dto.id),
    name: dto.name as string,
    customerId: strId(dto.customer_id),
    customerName: (dto.customer_name as string) ?? undefined,
    amount: dto.amount as number,
    stage: dto.stage as Opportunity['stage'],
    ownerId: nullableStrId(dto.owner_id) ?? '',
    ownerName: (dto.owner_name as string) ?? undefined,
    expectedCloseDate: (dto.expected_close_date as string) ?? undefined,
    probability: (dto.probability as number) ?? undefined,
    remark: (dto.remark as string) ?? undefined,
    createdAt: strId(dto.created_at),
    updatedAt: strId(dto.updated_at),
  }
}

export function mapFollow(dto: AnyRecord): Follow {
  return {
    id: strId(dto.id),
    entityType: dto.entity_type as Follow['entityType'],
    entityId: strId(dto.entity_id),
    type: dto.type as Follow['type'],
    content: dto.content as string,
    nextFollowAt: (dto.next_follow_at as string) ?? undefined,
    createdBy: strId(dto.created_by),
    createdByName: (dto.created_by_name as string) ?? undefined,
    createdAt: strId(dto.created_at),
  }
}

export function mapUser(dto: AnyRecord): User {
  return {
    id: strId(dto.id),
    name: dto.name as string,
    email: dto.email as string,
    roleType: (dto.role_type as User['roleType']) ?? 'operator',
    isActive: (dto.is_active as boolean) ?? true,
  }
}

export function mapPaginated<T>(dto: AnyRecord, mapper: (r: AnyRecord) => T): Paginated<T> {
  return {
    items: ((dto.items as AnyRecord[]) ?? []).map(mapper),
    total: dto.total as number,
    page: dto.page as number,
    pageSize: dto.page_size as number,
  }
}
```

> **注意**：`mapLead`/`mapOpportunity`/`mapFollow`/`mapUser` 引用的字段名须与 `frontend/lib/crm/types/` 实际定义一致；若字段名有出入（如 `Lead.ownerId` 可空性、`Opportunity.ownerId` 是否为 `string`），按实际类型微调。任务 12 的 `tsc` 会暴露任何不一致。

- [ ] **步骤 4：运行测试验证通过**

运行：`cd frontend && pnpm vitest run lib/crm/api/dto-mappers.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add frontend/lib/crm/api/dto-mappers.ts frontend/lib/crm/api/dto-mappers.test.ts
git commit -m "feat(crm): 前后端 DTO 映射纯函数"
```

### 任务 12：http-crm-client（customer/contact/user 部分）

**文件：**
- 修改：`frontend/lib/crm/api/http-crm-client.ts`

- [ ] **步骤 1：实现 customer/contact/user 方法（lead/opportunity/follow 在 P1b/P1c 补）**

把 `http-crm-client.ts` 整体替换为：

```ts
import type { CrmClient, ListParams, Paginated } from './crm-client'
import type {
  Customer,
  CustomerInput,
  Lead,
  LeadInput,
  Opportunity,
  OpportunityInput,
  Follow,
  FollowInput,
  FollowEntityType,
  User,
} from '@/lib/crm/types'
import { normalizeErrorMessage } from '@/lib/error-utils'
import {
  mapCustomer,
  mapCustomerInput,
  mapFollow,
  mapLead,
  mapOpportunity,
  mapPaginated,
  mapUser,
} from './dto-mappers'

const BASE = '/api/backend/v1/crm'
type AnyRecord = Record<string, unknown>

function qs(params: ListParams): string {
  const sp = new URLSearchParams()
  if (params.keyword) sp.set('keyword', params.keyword)
  if (params.scope) sp.set('scope', params.scope)
  if (params.page) sp.set('page', String(params.page))
  if (params.pageSize) sp.set('page_size', String(params.pageSize))
  if (params.sortBy) sp.set('sort_by', params.sortBy)
  if (params.sortOrder) sp.set('sort_order', params.sortOrder)
  // filters: MVP 阶段服务端 predicate 已实现，http 模式暂不传复杂 filters（P2 高级筛选再接）
  const s = sp.toString()
  return s ? `?${s}` : ''
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    cache: 'no-store',
  })
  if (response.status === 204) return undefined as T
  const body = (await response.json().catch(() => ({}))) as AnyRecord & { message?: string }
  if (!response.ok) {
    throw new Error(normalizeErrorMessage(body.message, '请求失败'))
  }
  return body as unknown as T
}

export class HttpCrmClient implements CrmClient {
  // ---------- Customer ----------
  async listCustomers(params: ListParams): Promise<Paginated<Customer>> {
    return mapPaginated(await request<AnyRecord>(`/customers${qs(params)}`), mapCustomer)
  }
  async getCustomer(id: string): Promise<Customer> {
    return mapCustomer(await request<AnyRecord>(`/customers/${id}`))
  }
  async createCustomer(input: CustomerInput): Promise<Customer> {
    return mapCustomer(
      await request<AnyRecord>(`/customers`, { method: 'POST', body: JSON.stringify(mapCustomerInput(input)) })
    )
  }
  async updateCustomer(id: string, input: Partial<CustomerInput>): Promise<Customer> {
    return mapCustomer(
      await request<AnyRecord>(`/customers/${id}`, { method: 'PATCH', body: JSON.stringify(mapCustomerInput(input as CustomerInput)) })
    )
  }
  async deleteCustomer(id: string): Promise<void> {
    await request<void>(`/customers/${id}`, { method: 'DELETE' })
  }
  async batchTransferCustomers(ids: string[], toOwnerId: string): Promise<void> {
    await request<void>(`/customers/batch-transfer`, {
      method: 'POST',
      body: JSON.stringify({ ids: ids.map(Number), to_owner_id: Number(toOwnerId) }),
    })
  }
  async batchMoveToSea(ids: string[]): Promise<void> {
    await request<void>(`/customers/batch-move-sea`, { method: 'POST', body: JSON.stringify({ ids: ids.map(Number) }) })
  }
  async claimFromSea(id: string): Promise<Customer> {
    return mapCustomer(await request<AnyRecord>(`/customers/${id}/claim`, { method: 'POST' }))
  }

  // ---------- Lead / Opportunity / Follow（P1b/P1c 实现，先占位明确错误） ----------
  listLeads = () => Promise.reject(new Error('listLeads: P1b 实现')) as never
  getLead = () => Promise.reject(new Error('getLead: P1b 实现')) as never
  createLead = () => Promise.reject(new Error('createLead: P1b 实现')) as never
  updateLead = () => Promise.reject(new Error('updateLead: P1b 实现')) as never
  convertLead = () => Promise.reject(new Error('convertLead: P1b 实现')) as never
  listOpportunities = () => Promise.reject(new Error('listOpportunities: P1c 实现')) as never
  getOpportunity = () => Promise.reject(new Error('getOpportunity: P1c 实现')) as never
  createOpportunity = () => Promise.reject(new Error('createOpportunity: P1c 实现')) as never
  updateOpportunity = () => Promise.reject(new Error('updateOpportunity: P1c 实现')) as never
  listFollows = () => Promise.reject(new Error('listFollows: P1b 实现')) as never
  createFollow = () => Promise.reject(new Error('createFollow: P1b 实现')) as never

  // ---------- User ----------
  async listUsers(): Promise<User[]> {
    return (await request<AnyRecord[]>(`/users`)).map(mapUser)
  }
  async getUser(id: string): Promise<User> {
    return mapUser(await request<AnyRecord>(`/users/${id}`))
  }
}
```

> **说明**：lead/opportunity/follow 方法在本任务用 `Promise.reject` 明确占位（不是同步 `throw`，避免构造即崩），P1b/P1c 任务里替换为真实实现。这保证 P1a 结束时 `HttpCrmClient` 已 `implements CrmClient` 且 customer 全链路可用。
> **Contact 方法**：`CrmClient` 接口本任务尚未含 contact 方法；任务 13 补接口 + Mock + http 实现。

- [ ] **步骤 2：类型检查**

运行：`cd frontend && pnpm tsc --noEmit`
预期：无 `http-crm-client.ts` / `dto-mappers.ts` 相关报错（若有 `Lead`/`Opportunity` 字段名不符，按 `lib/crm/types` 实际定义修 mapper）。

- [ ] **步骤 3：Commit**

```bash
git add frontend/lib/crm/api/http-crm-client.ts
git commit -m "feat(crm): http 客户端（客户/用户）"
```

---

### 任务 13：CrmClient 接口补 Contact + http/Mock 实现 + 详情接入

**文件：**
- 修改：`frontend/lib/crm/types/customer.ts`（新增 `Contact`/`ContactInput`）
- 修改：`frontend/lib/crm/api/crm-client.ts`（接口补 4 个 contact 方法）
- 修改：`frontend/lib/crm/api/http-crm-client.ts`（实现 contact 4 方法）
- 修改：`frontend/lib/crm/api/mock-crm-client.ts`（Mock 实现 contact 4 方法）
- 创建：`frontend/components/crm/crm-contact-list/{index.tsx,contact-form.tsx,index.test.tsx}`
- 修改：`frontend/components/crm/crm-overview-drawer/index.tsx`（客户详情 tab 接入）

- [ ] **步骤 1：在 `types/customer.ts` 末尾追加 Contact 类型**

```ts
export interface Contact {
  id: string
  customerId: string
  name: string
  phone?: string
  email?: string
  title?: string
  isPrimary: boolean
  remark?: string
  createdAt: string
  updatedAt: string
}

export type ContactInput = Omit<Contact, 'id' | 'customerId' | 'createdAt' | 'updatedAt'>
```

- [ ] **步骤 2：在 `crm-client.ts` 的 `CrmClient` 接口追加 contact 方法 + import**

import 区补 `Contact, ContactInput`；接口内（Customer 段之后）追加：

```ts
  listContacts(customerId: string): Promise<Contact[]>
  createContact(customerId: string, input: ContactInput): Promise<Contact>
  updateContact(id: string, input: Partial<ContactInput>): Promise<Contact>
  deleteContact(id: string): Promise<void>
```

- [ ] **步骤 3：在 `dto-mappers.ts` 追加 `mapContact` / `mapContactInput`**

```ts
import type { Contact, ContactInput } from '@/lib/crm/types'

export function mapContact(dto: AnyRecord): Contact {
  return {
    id: strId(dto.id),
    customerId: strId(dto.customer_id),
    name: dto.name as string,
    phone: (dto.phone as string) ?? undefined,
    email: (dto.email as string) ?? undefined,
    title: (dto.title as string) ?? undefined,
    isPrimary: (dto.is_primary as boolean) ?? false,
    remark: (dto.remark as string) ?? undefined,
    createdAt: strId(dto.created_at),
    updatedAt: strId(dto.updated_at),
  }
}

export function mapContactInput(input: ContactInput): AnyRecord {
  return {
    name: input.name,
    phone: input.phone,
    email: input.email,
    title: input.title,
    is_primary: input.isPrimary,
    remark: input.remark,
  }
}
```

- [ ] **步骤 4：在 `http-crm-client.ts` 实现 contact 4 方法**

import 区补 `mapContact, mapContactInput` 与类型 `Contact, ContactInput`；类内 Customer 段后追加：

```ts
  // ---------- Contact ----------
  async listContacts(customerId: string): Promise<Contact[]> {
    return (await request<AnyRecord[]>(`/customers/${customerId}/contacts`)).map(mapContact)
  }
  async createContact(customerId: string, input: ContactInput): Promise<Contact> {
    return mapContact(
      await request<AnyRecord>(`/customers/${customerId}/contacts`, { method: 'POST', body: JSON.stringify(mapContactInput(input)) })
    )
  }
  async updateContact(id: string, input: Partial<ContactInput>): Promise<Contact> {
    return mapContact(
      await request<AnyRecord>(`/contacts/${id}`, { method: 'PATCH', body: JSON.stringify(mapContactInput(input as ContactInput)) })
    )
  }
  async deleteContact(id: string): Promise<void> {
    await request<void>(`/contacts/${id}`, { method: 'DELETE' })
  }
```

- [ ] **步骤 5：在 `mock-crm-client.ts` 实现 contact 4 方法**

参照现有 Mock 风格（内存数组 + 延迟）实现 `listContacts/createContact/updateContact/deleteContact`，保持 `MockCrmClient implements CrmClient` 完整。新增内存存储 `private contacts: Contact[] = []`，`createContact` 时若 `isPrimary` 则把同客户其他联系人 `isPrimary=false`（与后端 primary 唯一语义一致）。

- [ ] **步骤 6：编写 `crm-contact-list/index.tsx`（联系人子列表 + 新建/编辑/删除/设主）**

组件接收 `customerId: string`，用 `useCrmClient()` 调 `listContacts/createContact/updateContact/deleteContact`；列表展示 name/phone/email/title + 「主」徽章；操作：新建（弹 `contact-form.tsx` Sheet）、编辑、删除、设为主联系人。`contact-form.tsx` 用 react-hook-form + zod（schema：name 必填、email 格式），风格参照现有 `crm-lead-form`。

- [ ] **步骤 7：编写冒烟测试 `crm-contact-list/index.test.tsx`**

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
// 用 MockCrmClient 的 Provider 包裹，断言空态文案与「新建联系人」按钮可见
// （具体断言按组件实际文案；参照 crm-follow-timeline/index.test.tsx 的 Provider 包裹方式）
```

> 测试须用 `CrmClientProvider`（mock 模式）包裹；断言「新建联系人」按钮渲染、空态展示。运行 `pnpm vitest run components/crm/crm-contact-list`。

- [ ] **步骤 8：在 `crm-overview-drawer` 客户详情 tab 接入 `CrmContactList`**

在客户实体的「详情」tab 字段区下方渲染 `<CrmContactList customerId={entityId} />`（仅 `entityType==='customer'` 时）。

- [ ] **步骤 9：类型检查 + 单测 + lint**

运行：`cd frontend && pnpm tsc --noEmit && pnpm vitest run lib/crm components/crm/crm-contact-list && pnpm lint`
预期：绿。

- [ ] **步骤 10：Commit**

```bash
git add frontend/lib/crm/types/customer.ts frontend/lib/crm/api/crm-client.ts frontend/lib/crm/api/dto-mappers.ts frontend/lib/crm/api/http-crm-client.ts frontend/lib/crm/api/mock-crm-client.ts frontend/components/crm/crm-contact-list frontend/components/crm/crm-overview-drawer/index.tsx
git commit -m "feat(crm): 多联系人子列表（接口/http/Mock/详情接入）"
```

---

### 任务 14：P1a 端到端验证（http 模式跑通客户全链路）

- [ ] **步骤 1：后端起服务 + 前端切 http**

后端：`cd backend && ./run_api.sh`（或现有启动方式）。
前端：在 `frontend/.env.local` 设 `NEXT_PUBLIC_CRM_API_MODE=http`，重启 `pnpm dev`。

- [ ] **步骤 2：手动验证客户全链路**

打开 `/dashboard/crm/customers`：新建客户 → 列表出现 → 行点击拉详情 → 编辑保存 → 新建/编辑/删除联系人 + 设主 → 批量移公海 → 切公海页领取。
预期：全程操作真实 Postgres（刷新不丢；`psql` 查 `crm_customers`/`crm_contacts` 有数据；客户详情 `contact_name` 随主联系人变化）。

- [ ] **步骤 3：跑前端既有单测 + lint**

运行：`cd frontend && pnpm lint && pnpm test`
预期：全绿。（`pnpm build` 的 `gen:api-types:check` 在 P1d 任务 26 重新生成 openapi 后再跑；P1a 先确认 lint + test 绿。）

- [ ] **步骤 4：还原 env 并记录**

把 `.env.local` 的 `NEXT_PUBLIC_CRM_API_MODE` 还原（`.env.local` 通常 gitignore，不提交）。PR 描述注明切换方式。

```bash
git commit --allow-empty -m "chore(crm): P1a 客户全链路 http 模式验证通过"
```

**P1a 退出检查**：客户/联系人/用户全链路在 http 模式跑通；`dto-mappers` 单测绿；后端 customer/contact/scope/sea 集成测试绿；`HttpCrmClient implements CrmClient`（contact 已接通，lead/opportunity/follow 占位）。

---

## P1b · lead + follow

> **退出标准**：线索 CRUD + 转客户事务闭环 + 跟进创建回写 `last_follow_at`，全部真实后端；http-client lead/follow 方法接通。

### 任务 15：lead_service（CRUD + convert 事务）

**文件：**
- 创建：`backend/app/services/crm/lead_service.py`

- [ ] **步骤 1：编写 service**

```python
"""Lead service: CRUD + convert_lead (transactional customer creation)."""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.models.crm import CrmContact, CrmCustomer, CrmLead
from app.schemas.crm import ConvertLeadRequest, LeadCreate, LeadUpdate
from app.services.crm.customer_service import _current_user_id, _owner_name_map, get_customer


def _to_item(db: Session, lead: CrmLead, owner_names: dict[int, str]):
    from app.schemas.crm import LeadItem

    return LeadItem(
        id=lead.id,
        name=lead.name,
        company=lead.company,
        phone=lead.phone,
        email=lead.email,
        wechat=lead.wechat,
        source=lead.source,
        status=lead.status,
        intent=lead.intent,
        owner_id=lead.owner_id,
        owner_name=owner_names.get(lead.owner_id) if lead.owner_id else None,
        expected_amount=float(lead.expected_amount) if lead.expected_amount is not None else None,
        expected_close_date=lead.expected_close_date,
        remark=lead.remark,
        converted_to_customer_id=lead.converted_to_customer_id,
        converted_at=lead.converted_at,
        created_by=lead.created_by,
        created_at=lead.created_at,
        updated_at=lead.updated_at,
    )


def list_leads(db: Session, *, user_id: str | None, scope: str = "all", keyword: str | None = None,
               page: int = 1, page_size: int = 20, sort_by: str = "updated_at", sort_order: str = "desc"):
    cur = _current_user_id(user_id)
    stmt = select(CrmLead).where(CrmLead.is_deleted.is_(False))
    if scope == "mine" and cur is not None:
        stmt = stmt.where(CrmLead.owner_id == cur)
    elif scope == "sea":
        stmt = stmt.where(CrmLead.owner_id.is_(None))
    if keyword:
        like = f"%{keyword}%"
        stmt = stmt.where(or_(CrmLead.name.ilike(like), CrmLead.company.ilike(like)))
    total = db.execute(select(func.count()).select_from(stmt.subquery())).scalar_one()
    sort_col = getattr(CrmLead, sort_by, CrmLead.updated_at)
    stmt = stmt.order_by(sort_col.desc() if sort_order == "desc" else sort_col.asc()).offset((page - 1) * page_size).limit(page_size)
    rows = db.execute(stmt).scalars().all()
    owner_names = _owner_name_map(db, {r.owner_id for r in rows if r.owner_id})
    return [_to_item(db, r, owner_names) for r in rows], int(total)


def get_lead(db: Session, lead_id: int):
    lead = db.execute(select(CrmLead).where(CrmLead.id == lead_id, CrmLead.is_deleted.is_(False))).scalar_one_or_none()
    if lead is None:
        return None
    owner_names = _owner_name_map(db, {lead.owner_id} if lead.owner_id else set())
    return _to_item(db, lead, owner_names)


def create_lead(db: Session, payload: LeadCreate, *, user_id: str | None):
    cur = _current_user_id(user_id)
    lead = CrmLead(**payload.model_dump(exclude_unset=True), created_by=cur)
    if lead.owner_id is None and cur is not None:
        lead.owner_id = cur
    db.add(lead)
    db.commit()
    db.refresh(lead)
    return get_lead(db, lead.id)


def update_lead(db: Session, lead_id: int, payload: LeadUpdate):
    lead = db.execute(select(CrmLead).where(CrmLead.id == lead_id, CrmLead.is_deleted.is_(False))).scalar_one_or_none()
    if lead is None:
        return None
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(lead, key, value)
    db.commit()
    db.refresh(lead)
    return get_lead(db, lead.id)


def convert_lead(db: Session, lead_id: int, payload: ConvertLeadRequest | None, *, user_id: str | None):
    """事务内：建客户（含主联系人）+ 标记线索 converted。任一失败整体回滚。"""
    cur = _current_user_id(user_id)
    lead = db.execute(select(CrmLead).where(CrmLead.id == lead_id, CrmLead.is_deleted.is_(False))).scalar_one_or_none()
    if lead is None:
        return None
    if lead.status == "converted":
        return None  # 已转化，幂等拒绝

    overrides = payload.model_dump(exclude_unset=True) if payload else {}
    try:
        customer = CrmCustomer(
            name=overrides.get("name") or lead.company or lead.name,
            rating=overrides.get("rating") or "C",
            status="active",
            source=overrides.get("source") or lead.source,
            owner_id=cur,
            remark=overrides.get("remark") or lead.remark,
            created_by=cur,
        )
        db.add(customer)
        db.flush()  # 拿 customer.id

        if lead.name:  # 线索联系人 → 客户主联系人
            db.add(CrmContact(
                customer_id=customer.id,
                name=lead.name,
                phone=lead.phone,
                email=lead.email,
                is_primary=True,
            ))

        lead.status = "converted"
        lead.converted_to_customer_id = customer.id
        lead.converted_at = datetime.now(timezone.utc)
        db.commit()
    except Exception:
        db.rollback()
        raise

    db.refresh(lead)
    return get_lead(db, lead.id), get_customer(db, customer.id)
```

- [ ] **步骤 2：验证可导入**

运行：`cd backend && python -c "import app.services.crm.lead_service as s; print(callable(s.convert_lead))"`
预期：`True`。

- [ ] **步骤 3：Commit**

```bash
git add backend/app/services/crm/lead_service.py
git commit -m "feat(crm): 线索 service（CRUD/转客户事务）"
```

---

### 任务 16：follow_service（创建 + 回写 last_follow_at）

**文件：**
- 创建：`backend/app/services/crm/follow_service.py`

- [ ] **步骤 1：编写 service**

```python
"""Follow service: list/create + write back entity.last_follow_at."""
from __future__ import annotations

from sqlalchemy import func as sa_func
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.crm import CrmCustomer, CrmFollow, CrmLead
from app.schemas.crm import FollowCreate, FollowItem
from app.services.crm.customer_service import _current_user_id, _owner_name_map

_ENTITY_MODEL = {"customer": CrmCustomer, "lead": CrmLead}  # opportunity 无 last_follow_at


def _to_item(r: CrmFollow, names: dict[int, str]) -> FollowItem:
    return FollowItem(
        id=r.id,
        entity_type=r.entity_type,
        entity_id=r.entity_id,
        type=r.type,
        content=r.content,
        next_follow_at=r.next_follow_at,
        created_by=r.created_by,
        created_by_name=names.get(r.created_by) if r.created_by else None,
        created_at=r.created_at,
    )


def list_follows(db: Session, entity_type: str, entity_id: int) -> list[FollowItem]:
    rows = (
        db.execute(
            select(CrmFollow)
            .where(CrmFollow.entity_type == entity_type, CrmFollow.entity_id == entity_id)
            .order_by(CrmFollow.created_at.desc())
        )
        .scalars()
        .all()
    )
    names = _owner_name_map(db, {r.created_by for r in rows if r.created_by})
    return [_to_item(r, names) for r in rows]


def create_follow(db: Session, payload: FollowCreate, *, user_id: str | None) -> FollowItem:
    cur = _current_user_id(user_id)
    follow = CrmFollow(
        entity_type=payload.entity_type,
        entity_id=payload.entity_id,
        type=payload.type,
        content=payload.content,
        next_follow_at=payload.next_follow_at,
        created_by=cur,
    )
    db.add(follow)

    model = _ENTITY_MODEL.get(payload.entity_type)
    if model is not None:  # 回写实体 last_follow_at（P3 公海回收/待跟进依赖）
        entity = db.execute(select(model).where(model.id == payload.entity_id)).scalar_one_or_none()
        if entity is not None:
            entity.last_follow_at = sa_func.now()

    db.commit()
    db.refresh(follow)
    names = _owner_name_map(db, {follow.created_by} if follow.created_by else set())
    return _to_item(follow, names)
```

- [ ] **步骤 2：Commit**

```bash
git add backend/app/services/crm/follow_service.py
git commit -m "feat(crm): 跟进 service（创建/回写 last_follow_at）"
```

---

### 任务 17：lead + follow 路由

**文件：**
- 修改：`backend/app/api/v1/endpoints/crm.py`

- [ ] **步骤 1：在 `crm.py` 追加 import 与路由**

import 区追加：

```python
from app.schemas.crm import (
    ConvertLeadRequest,
    ConvertLeadResponse,
    FollowCreate,
    FollowItem,
    LeadCreate,
    LeadItem,
    LeadListResponse,
    LeadUpdate,
)
from app.services.crm import follow_service, lead_service
```

文件末尾追加路由：

```python
# ---------- Lead ----------
@router.get("/leads", response_model=LeadListResponse)
def list_leads(
    scope: str = Query("all"),
    keyword: str | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    sort_by: str = "updated_at",
    sort_order: str = "desc",
    db: Session = Depends(get_read_db_session),
    user_id: str | None = Depends(get_request_user_id),
):
    items, total = lead_service.list_leads(
        db, user_id=user_id, scope=scope, keyword=keyword,
        page=page, page_size=page_size, sort_by=sort_by, sort_order=sort_order,
    )
    return LeadListResponse(items=items, total=total, page=page, page_size=page_size)


@router.post("/leads", response_model=LeadItem, status_code=status.HTTP_201_CREATED)
def create_lead(payload: LeadCreate, db: Session = Depends(get_primary_db_session), user_id: str | None = Depends(get_request_user_id)):
    return lead_service.create_lead(db, payload, user_id=user_id)


@router.get("/leads/{lead_id}", response_model=LeadItem)
def get_lead(lead_id: int, db: Session = Depends(get_read_db_session)):
    item = lead_service.get_lead(db, lead_id)
    if item is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Lead not found")
    return item


@router.patch("/leads/{lead_id}", response_model=LeadItem)
def update_lead(lead_id: int, payload: LeadUpdate, db: Session = Depends(get_primary_db_session)):
    item = lead_service.update_lead(db, lead_id, payload)
    if item is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Lead not found")
    return item


@router.post("/leads/{lead_id}/convert", response_model=ConvertLeadResponse)
def convert_lead(lead_id: int, payload: ConvertLeadRequest | None = None, db: Session = Depends(get_primary_db_session), user_id: str | None = Depends(get_request_user_id)):
    result = lead_service.convert_lead(db, lead_id, payload, user_id=user_id)
    if result is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Lead not convertible")
    lead_item, customer_item = result
    return ConvertLeadResponse(lead=lead_item, customer=customer_item)


# ---------- Follow ----------
@router.get("/follows", response_model=list[FollowItem])
def list_follows(entity_type: str = Query(...), entity_id: int = Query(...), db: Session = Depends(get_read_db_session)):
    return follow_service.list_follows(db, entity_type, entity_id)


@router.post("/follows", response_model=FollowItem, status_code=status.HTTP_201_CREATED)
def create_follow(payload: FollowCreate, db: Session = Depends(get_primary_db_session), user_id: str | None = Depends(get_request_user_id)):
    return follow_service.create_follow(db, payload, user_id=user_id)
```

- [ ] **步骤 2：验证路由**

运行：`cd backend && python -c "from app.main import app; print([r.path for r in app.routes if '/crm/leads' in r.path or '/crm/follows' in r.path])"`
预期：含 `/api/v1/crm/leads`、`/api/v1/crm/leads/{lead_id}/convert`、`/api/v1/crm/follows`。

- [ ] **步骤 3：Commit**

```bash
git add backend/app/api/v1/endpoints/crm.py
git commit -m "feat(crm): 线索/跟进 API 路由"
```

### 任务 18：convert_lead service 单测（事务边界）

**文件：**
- 创建：`backend/tests/services/crm/__init__.py`（空）
- 创建：`backend/tests/services/crm/test_convert_lead.py`

- [ ] **步骤 1：编写测试**

```python
"""convert_lead transactional behavior (uses real test DB session)."""
from app.models.crm import CrmContact, CrmCustomer, CrmLead
from app.schemas.crm import ConvertLeadRequest
from app.services.crm.lead_service import convert_lead


def test_convert_creates_customer_and_marks_lead(db_session):
    lead = CrmLead(name="王联系人", company="乙公司", phone="138", source="referral", owner_id=1, created_by=1)
    db_session.add(lead)
    db_session.commit()
    db_session.refresh(lead)

    result = convert_lead(db_session, lead.id, ConvertLeadRequest(rating="A"), user_id="1")
    assert result is not None
    lead_item, customer_item = result
    assert lead_item.status == "converted"
    assert customer_item.name == "乙公司"            # 默认用 company 作客户名
    assert customer_item.rating == "A"                # override 生效
    assert customer_item.contact_name == "王联系人"   # 线索联系人 → 主联系人

    assert convert_lead(db_session, lead.id, None, user_id="1") is None  # 重复转化 → 幂等拒绝

    # 清理
    db_session.query(CrmContact).filter(CrmContact.customer_id == int(customer_item.id)).delete()
    db_session.query(CrmCustomer).filter(CrmCustomer.id == int(customer_item.id)).delete()
    db_session.query(CrmLead).filter(CrmLead.id == lead.id).delete()
    db_session.commit()


def test_convert_missing_lead_returns_none(db_session):
    assert convert_lead(db_session, 999999, None, user_id="1") is None
```

- [ ] **步骤 2：运行测试**

运行：`cd backend && pytest tests/services/crm/test_convert_lead.py -v`
预期：PASS。

- [ ] **步骤 3：Commit**

```bash
git add backend/tests/services/crm/__init__.py backend/tests/services/crm/test_convert_lead.py
git commit -m "test(crm): 转客户事务单测"
```

---

### 任务 19：lead + follow 端点集成测试

**文件：**
- 创建：`backend/tests/api/crm/test_leads.py`
- 创建：`backend/tests/api/crm/test_follows.py`

- [ ] **步骤 1：编写 `test_leads.py`**

```python
def _mk_lead(client, headers, name="线索A", company="公司A"):
    r = client.post("/api/v1/crm/leads", json={"name": name, "company": company, "source": "referral", "intent": "high"}, headers=headers)
    assert r.status_code == 201, r.text
    return r.json()


def test_lead_crud(client, admin_headers):
    lead = _mk_lead(client, admin_headers)
    assert client.get(f"/api/v1/crm/leads/{lead['id']}", headers=admin_headers).json()["name"] == "线索A"
    upd = client.patch(f"/api/v1/crm/leads/{lead['id']}", json={"status": "contacting"}, headers=admin_headers)
    assert upd.json()["status"] == "contacting"


def test_convert_lead_endpoint(client, admin_headers):
    lead = _mk_lead(client, admin_headers, name="联系人X", company="丁公司")
    r = client.post(f"/api/v1/crm/leads/{lead['id']}/convert", json={"rating": "B"}, headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["lead"]["status"] == "converted"
    assert body["customer"]["name"] == "丁公司"
    assert body["customer"]["contact_name"] == "联系人X"

    again = client.post(f"/api/v1/crm/leads/{lead['id']}/convert", json={}, headers=admin_headers)
    assert again.status_code == 409  # 重复转化
```

- [ ] **步骤 2：编写 `test_follows.py`**

```python
def _mk_customer(client, headers, name="甲"):
    return client.post("/api/v1/crm/customers", json={"name": name}, headers=headers).json()


def test_create_follow_writes_back_last_follow_at(client, admin_headers):
    cust = _mk_customer(client, admin_headers)
    assert cust["last_follow_at"] is None

    r = client.post("/api/v1/crm/follows", json={"entity_type": "customer", "entity_id": cust["id"], "type": "phone", "content": "首次电话"}, headers=admin_headers)
    assert r.status_code == 201, r.text

    refreshed = client.get(f"/api/v1/crm/customers/{cust['id']}", headers=admin_headers).json()
    assert refreshed["last_follow_at"] is not None  # 回写生效


def test_list_follows_ordered_desc(client, admin_headers):
    cust = _mk_customer(client, admin_headers)
    client.post("/api/v1/crm/follows", json={"entity_type": "customer", "entity_id": cust["id"], "type": "note", "content": "第一条"}, headers=admin_headers)
    client.post("/api/v1/crm/follows", json={"entity_type": "customer", "entity_id": cust["id"], "type": "note", "content": "第二条"}, headers=admin_headers)
    follows = client.get(f"/api/v1/crm/follows?entity_type=customer&entity_id={cust['id']}", headers=admin_headers).json()
    assert len(follows) == 2
    assert follows[0]["content"] == "第二条"  # 倒序
```

- [ ] **步骤 3：运行测试**

运行：`cd backend && pytest tests/api/crm/test_leads.py tests/api/crm/test_follows.py -v`
预期：全 PASS。

- [ ] **步骤 4：Commit**

```bash
git add backend/tests/api/crm/test_leads.py backend/tests/api/crm/test_follows.py
git commit -m "test(crm): 线索/跟进端点集成测试"
```

---

### 任务 20：http-client 接通 lead + follow

**文件：**
- 修改：`frontend/lib/crm/api/dto-mappers.ts`（补 `mapLeadInput` / `mapFollowInput`）
- 修改：`frontend/lib/crm/api/http-crm-client.ts`

- [ ] **步骤 1：在 `dto-mappers.ts` 追加 input 映射**

```ts
export function mapLeadInput(input: LeadInput): AnyRecord {
  return {
    name: input.name,
    company: input.company,
    phone: input.phone,
    email: input.email,
    wechat: input.wechat,
    source: input.source,
    status: input.status,
    intent: input.intent,
    owner_id: numId(input.ownerId),
    expected_amount: input.expectedAmount,
    expected_close_date: input.expectedCloseDate,
    remark: input.remark,
  }
}

export function mapFollowInput(input: FollowInput): AnyRecord {
  return {
    entity_type: input.entityType,
    entity_id: Number(input.entityId),
    type: input.type,
    content: input.content,
    next_follow_at: input.nextFollowAt ?? null,
  }
}
```

> `LeadInput`/`FollowInput` 字段名以 `lib/crm/types` 实际定义为准；`tsc` 会校验。

- [ ] **步骤 2：替换 http-client 的 lead/follow 占位为真实实现**

import 区补 `mapLeadInput, mapFollowInput`；把对应 `Promise.reject` 占位替换为：

```ts
  // ---------- Lead ----------
  async listLeads(params: ListParams): Promise<Paginated<Lead>> {
    return mapPaginated(await request<AnyRecord>(`/leads${qs(params)}`), mapLead)
  }
  async getLead(id: string): Promise<Lead> {
    return mapLead(await request<AnyRecord>(`/leads/${id}`))
  }
  async createLead(input: LeadInput): Promise<Lead> {
    return mapLead(await request<AnyRecord>(`/leads`, { method: 'POST', body: JSON.stringify(mapLeadInput(input)) }))
  }
  async updateLead(id: string, input: Partial<LeadInput>): Promise<Lead> {
    return mapLead(await request<AnyRecord>(`/leads/${id}`, { method: 'PATCH', body: JSON.stringify(mapLeadInput(input as LeadInput)) }))
  }
  async convertLead(id: string, customerInput?: Partial<CustomerInput>): Promise<{ lead: Lead; customer: Customer }> {
    const body = customerInput ? mapCustomerInput(customerInput as CustomerInput) : {}
    const dto = await request<AnyRecord>(`/leads/${id}/convert`, { method: 'POST', body: JSON.stringify(body) })
    return { lead: mapLead(dto.lead as AnyRecord), customer: mapCustomer(dto.customer as AnyRecord) }
  }

  // ---------- Follow ----------
  async listFollows(entityType: FollowEntityType, entityId: string): Promise<Follow[]> {
    const dto = await request<AnyRecord[]>(`/follows?entity_type=${entityType}&entity_id=${entityId}`)
    return dto.map(mapFollow)
  }
  async createFollow(input: FollowInput): Promise<Follow> {
    return mapFollow(await request<AnyRecord>(`/follows`, { method: 'POST', body: JSON.stringify(mapFollowInput(input)) }))
  }
```

- [ ] **步骤 3：类型检查 + 单测**

运行：`cd frontend && pnpm tsc --noEmit && pnpm vitest run lib/crm/api/dto-mappers.test.ts`
预期：绿。

- [ ] **步骤 4：Commit**

```bash
git add frontend/lib/crm/api/http-crm-client.ts frontend/lib/crm/api/dto-mappers.ts
git commit -m "feat(crm): http 客户端接通线索/跟进"
```

**P1b 退出检查**：线索 CRUD + 转客户 + 跟进创建（回写 last_follow_at）真实后端跑通；convert 事务单测 + 端点集成测试绿；http-client lead/follow 接通。

---

## P1c · opportunity + 前端四页面接通

> **退出标准**：商机 CRUD 真实后端；客户/线索/商机/公海四个前端页面在 http 模式下接通真实数据。

### 任务 21：opportunity_service + 路由

**文件：**
- 创建：`backend/app/services/crm/opportunity_service.py`
- 修改：`backend/app/api/v1/endpoints/crm.py`

- [ ] **步骤 1：编写 service**

```python
"""Opportunity service: CRUD + customer/owner name join."""
from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.crm import CrmCustomer, CrmOpportunity
from app.schemas.crm import OpportunityCreate, OpportunityItem, OpportunityUpdate
from app.services.crm.customer_service import _current_user_id, _owner_name_map


def _customer_name_map(db: Session, ids: set[int]) -> dict[int, str]:
    if not ids:
        return {}
    rows = db.execute(select(CrmCustomer.id, CrmCustomer.name).where(CrmCustomer.id.in_(ids))).all()
    return {int(r[0]): r[1] for r in rows}


def _to_item(opp: CrmOpportunity, owner_names: dict[int, str], cust_names: dict[int, str]) -> OpportunityItem:
    return OpportunityItem(
        id=opp.id,
        name=opp.name,
        customer_id=opp.customer_id,
        customer_name=cust_names.get(opp.customer_id) if opp.customer_id else None,
        amount=float(opp.amount),
        stage=opp.stage,
        owner_id=opp.owner_id,
        owner_name=owner_names.get(opp.owner_id) if opp.owner_id else None,
        expected_close_date=opp.expected_close_date,
        probability=opp.probability,
        linked_project_id=opp.linked_project_id,
        remark=opp.remark,
        created_by=opp.created_by,
        created_at=opp.created_at,
        updated_at=opp.updated_at,
    )


def list_opportunities(db: Session, *, user_id: str | None, scope: str = "all", keyword: str | None = None,
                       page: int = 1, page_size: int = 20, sort_by: str = "updated_at", sort_order: str = "desc"):
    cur = _current_user_id(user_id)
    stmt = select(CrmOpportunity).where(CrmOpportunity.is_deleted.is_(False))
    if scope == "mine" and cur is not None:
        stmt = stmt.where(CrmOpportunity.owner_id == cur)
    if keyword:
        stmt = stmt.where(CrmOpportunity.name.ilike(f"%{keyword}%"))
    total = db.execute(select(func.count()).select_from(stmt.subquery())).scalar_one()
    sort_col = getattr(CrmOpportunity, sort_by, CrmOpportunity.updated_at)
    stmt = stmt.order_by(sort_col.desc() if sort_order == "desc" else sort_col.asc()).offset((page - 1) * page_size).limit(page_size)
    rows = db.execute(stmt).scalars().all()
    owner_names = _owner_name_map(db, {r.owner_id for r in rows if r.owner_id})
    cust_names = _customer_name_map(db, {r.customer_id for r in rows if r.customer_id})
    return [_to_item(r, owner_names, cust_names) for r in rows], int(total)


def get_opportunity(db: Session, opp_id: int):
    opp = db.execute(select(CrmOpportunity).where(CrmOpportunity.id == opp_id, CrmOpportunity.is_deleted.is_(False))).scalar_one_or_none()
    if opp is None:
        return None
    owner_names = _owner_name_map(db, {opp.owner_id} if opp.owner_id else set())
    cust_names = _customer_name_map(db, {opp.customer_id} if opp.customer_id else set())
    return _to_item(opp, owner_names, cust_names)


def create_opportunity(db: Session, payload: OpportunityCreate, *, user_id: str | None):
    cur = _current_user_id(user_id)
    opp = CrmOpportunity(**payload.model_dump(exclude_unset=True), created_by=cur)
    if opp.owner_id is None and cur is not None:
        opp.owner_id = cur
    db.add(opp)
    db.commit()
    db.refresh(opp)
    return get_opportunity(db, opp.id)


def update_opportunity(db: Session, opp_id: int, payload: OpportunityUpdate):
    opp = db.execute(select(CrmOpportunity).where(CrmOpportunity.id == opp_id, CrmOpportunity.is_deleted.is_(False))).scalar_one_or_none()
    if opp is None:
        return None
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(opp, key, value)
    db.commit()
    db.refresh(opp)
    return get_opportunity(db, opp.id)
```

- [ ] **步骤 2：在 `crm.py` 追加 opportunity 路由**

import 追加：

```python
from app.schemas.crm import (
    OpportunityCreate,
    OpportunityItem,
    OpportunityListResponse,
    OpportunityUpdate,
)
from app.services.crm import opportunity_service
```

路由追加：

```python
# ---------- Opportunity ----------
@router.get("/opportunities", response_model=OpportunityListResponse)
def list_opportunities(
    scope: str = Query("all"),
    keyword: str | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    sort_by: str = "updated_at",
    sort_order: str = "desc",
    db: Session = Depends(get_read_db_session),
    user_id: str | None = Depends(get_request_user_id),
):
    items, total = opportunity_service.list_opportunities(
        db, user_id=user_id, scope=scope, keyword=keyword,
        page=page, page_size=page_size, sort_by=sort_by, sort_order=sort_order,
    )
    return OpportunityListResponse(items=items, total=total, page=page, page_size=page_size)


@router.post("/opportunities", response_model=OpportunityItem, status_code=status.HTTP_201_CREATED)
def create_opportunity(payload: OpportunityCreate, db: Session = Depends(get_primary_db_session), user_id: str | None = Depends(get_request_user_id)):
    return opportunity_service.create_opportunity(db, payload, user_id=user_id)


@router.get("/opportunities/{opp_id}", response_model=OpportunityItem)
def get_opportunity(opp_id: int, db: Session = Depends(get_read_db_session)):
    item = opportunity_service.get_opportunity(db, opp_id)
    if item is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Opportunity not found")
    return item


@router.patch("/opportunities/{opp_id}", response_model=OpportunityItem)
def update_opportunity(opp_id: int, payload: OpportunityUpdate, db: Session = Depends(get_primary_db_session)):
    item = opportunity_service.update_opportunity(db, opp_id, payload)
    if item is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Opportunity not found")
    return item
```

- [ ] **步骤 3：Commit**

```bash
git add backend/app/services/crm/opportunity_service.py backend/app/api/v1/endpoints/crm.py
git commit -m "feat(crm): 商机 service 与 API 路由"
```

---

### 任务 22：opportunity 端点集成测试

**文件：**
- 创建：`backend/tests/api/crm/test_opportunities.py`

- [ ] **步骤 1：编写测试**

```python
def _mk_customer(client, headers, name="甲"):
    return client.post("/api/v1/crm/customers", json={"name": name}, headers=headers).json()


def test_opportunity_crud_with_customer_name(client, admin_headers):
    cust = _mk_customer(client, admin_headers, name="戊公司")
    r = client.post("/api/v1/crm/opportunities", json={"name": "大单", "customer_id": cust["id"], "amount": 50000, "stage": "proposal", "probability": 60}, headers=admin_headers)
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["customer_name"] == "戊公司"
    assert body["amount"] == 50000

    upd = client.patch(f"/api/v1/crm/opportunities/{body['id']}", json={"stage": "won", "probability": 100}, headers=admin_headers)
    assert upd.json()["stage"] == "won"


def test_opportunity_scope_mine(client, admin_headers, operator_headers):
    cust = _mk_customer(client, admin_headers)
    client.post("/api/v1/crm/opportunities", json={"name": "管理员的商机", "customer_id": cust["id"], "amount": 1}, headers=admin_headers)
    client.post("/api/v1/crm/opportunities", json={"name": "运营的商机", "customer_id": cust["id"], "amount": 2}, headers=operator_headers)
    mine = client.get("/api/v1/crm/opportunities?scope=mine", headers=operator_headers).json()
    assert mine["total"] == 1
    assert mine["items"][0]["name"] == "运营的商机"
```

- [ ] **步骤 2：运行测试**

运行：`cd backend && pytest tests/api/crm/test_opportunities.py -v`
预期：PASS。

- [ ] **步骤 3：Commit**

```bash
git add backend/tests/api/crm/test_opportunities.py
git commit -m "test(crm): 商机端点集成测试"
```

---

### 任务 23：http-client 接通 opportunity + 前端四页面 http 验证

**文件：**
- 修改：`frontend/lib/crm/api/dto-mappers.ts`（补 `mapOpportunityInput`）
- 修改：`frontend/lib/crm/api/http-crm-client.ts`

- [ ] **步骤 1：`dto-mappers.ts` 追加 `mapOpportunityInput`**

```ts
export function mapOpportunityInput(input: OpportunityInput): AnyRecord {
  return {
    name: input.name,
    customer_id: numId(input.customerId),
    amount: input.amount,
    stage: input.stage,
    owner_id: numId(input.ownerId),
    expected_close_date: input.expectedCloseDate,
    probability: input.probability,
    remark: input.remark,
  }
}
```

- [ ] **步骤 2：替换 http-client 的 opportunity 占位**

import 区补 `mapOpportunityInput`；替换占位为：

```ts
  // ---------- Opportunity ----------
  async listOpportunities(params: ListParams): Promise<Paginated<Opportunity>> {
    return mapPaginated(await request<AnyRecord>(`/opportunities${qs(params)}`), mapOpportunity)
  }
  async getOpportunity(id: string): Promise<Opportunity> {
    return mapOpportunity(await request<AnyRecord>(`/opportunities/${id}`))
  }
  async createOpportunity(input: OpportunityInput): Promise<Opportunity> {
    return mapOpportunity(await request<AnyRecord>(`/opportunities`, { method: 'POST', body: JSON.stringify(mapOpportunityInput(input)) }))
  }
  async updateOpportunity(id: string, input: Partial<OpportunityInput>): Promise<Opportunity> {
    return mapOpportunity(await request<AnyRecord>(`/opportunities/${id}`, { method: 'PATCH', body: JSON.stringify(mapOpportunityInput(input as OpportunityInput)) }))
  }
```

- [ ] **步骤 3：类型检查**

运行：`cd frontend && pnpm tsc --noEmit`
预期：绿（`HttpCrmClient` 现已完整 `implements CrmClient`，无 `Promise.reject` 占位残留）。

- [ ] **步骤 4：http 模式手动验证四页面**

`NEXT_PUBLIC_CRM_API_MODE=http` + 起后端，逐页验证：客户（含联系人）/ 线索（含转客户）/ 商机（含新建编辑）/ 公海（移入 + 领取）。
预期：四页全链路操作真实数据。

- [ ] **步骤 5：Commit**

```bash
git add frontend/lib/crm/api/http-crm-client.ts frontend/lib/crm/api/dto-mappers.ts
git commit -m "feat(crm): http 客户端接通商机，四页面 http 验证"
```

**P1c 退出检查**：商机 CRUD 真实后端；客户/线索/商机/公海四页面 http 模式全链路通；`HttpCrmClient` 完整实现 `CrmClient`。

---

## P1d · 硬化（权限下沉 + 操作日志 + 类型同步 + E2E + 冷启动）

> **退出标准**：操作级权限后端校验；关键 mutation 写操作日志；`gen:api-types:check` 绿；4 条 Playwright E2E 在 http 模式过；冷启动 CSV 可用。

### 任务 24：操作级权限下沉后端

**文件：**
- 创建：`backend/app/services/crm/permissions.py`
- 修改：`backend/app/api/v1/endpoints/crm.py`（写操作加校验）
- 创建：`backend/tests/api/crm/test_permissions.py`

- [ ] **步骤 1：编写权限辅助 `permissions.py`**

```python
"""CRM operation-level permissions (backend authoritative; frontend keeps UX-only checks)."""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.crm import CrmCustomer


def can_edit_customer(db: Session, customer_id: int, *, user_id: str | None, is_admin: bool) -> bool:
    if is_admin:
        return True
    if user_id is None:
        return False
    try:
        uid = int(user_id)
    except (ValueError, TypeError):
        return False
    cust = db.execute(select(CrmCustomer).where(CrmCustomer.id == customer_id)).scalar_one_or_none()
    return cust is not None and cust.owner_id == uid


def can_delete_customer(is_admin: bool) -> bool:
    return is_admin  # MVP：仅 admin 可删
```

- [ ] **步骤 2：编写失败测试 `test_permissions.py`**

```python
def _mk(client, headers, name):
    return client.post("/api/v1/crm/customers", json={"name": name}, headers=headers).json()


def test_operator_cannot_edit_others_customer(client, admin_headers, operator_headers):
    cust = _mk(client, admin_headers, "管理员的客户")  # owner=admin
    r = client.patch(f"/api/v1/crm/customers/{cust['id']}", json={"rating": "D"}, headers=operator_headers)
    assert r.status_code == 403


def test_operator_can_edit_own_customer(client, operator_headers):
    cust = _mk(client, operator_headers, "运营自己的客户")  # owner=operator
    r = client.patch(f"/api/v1/crm/customers/{cust['id']}", json={"rating": "B"}, headers=operator_headers)
    assert r.status_code == 200


def test_only_admin_can_delete(client, admin_headers, operator_headers):
    cust = _mk(client, operator_headers, "运营的客户")
    forbidden = client.delete(f"/api/v1/crm/customers/{cust['id']}", headers=operator_headers)
    assert forbidden.status_code == 403
    ok = client.delete(f"/api/v1/crm/customers/{cust['id']}", headers=admin_headers)
    assert ok.status_code == 204
```

- [ ] **步骤 3：运行测试验证失败**

运行：`cd backend && pytest tests/api/crm/test_permissions.py -v`
预期：FAIL（端点尚未做权限校验，operator 能改他人客户）。

- [ ] **步骤 4：在 `crm.py` 写操作加校验**

import 追加：

```python
from app.api.deps import get_request_is_admin
from app.services.crm import permissions
```

修改 `update_customer`：

```python
@router.patch("/customers/{customer_id}", response_model=CustomerItem)
def update_customer(
    customer_id: int,
    payload: CustomerUpdate,
    db: Session = Depends(get_primary_db_session),
    user_id: str | None = Depends(get_request_user_id),
    is_admin: bool = Depends(get_request_is_admin),
):
    if not permissions.can_edit_customer(db, customer_id, user_id=user_id, is_admin=is_admin):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="No permission")
    item = customer_service.update_customer(db, customer_id, payload)
    if item is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Customer not found")
    return item
```

修改 `delete_customer`：

```python
@router.delete("/customers/{customer_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_customer(
    customer_id: int,
    db: Session = Depends(get_primary_db_session),
    is_admin: bool = Depends(get_request_is_admin),
):
    if not permissions.can_delete_customer(is_admin):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="No permission")
    if not customer_service.delete_customer(db, customer_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Customer not found")
```

- [ ] **步骤 5：运行测试验证通过**

运行：`cd backend && pytest tests/api/crm/test_permissions.py -v`
预期：全 PASS。

- [ ] **步骤 6：Commit**

```bash
git add backend/app/services/crm/permissions.py backend/app/api/v1/endpoints/crm.py backend/tests/api/crm/test_permissions.py
git commit -m "feat(crm): 操作级权限下沉后端"
```

---

### 任务 25：关键 mutation 写操作日志（复用 operation_audit_log）

**文件：**
- 修改：`backend/app/services/crm/customer_service.py`（转移/移公海/领取写日志）
- 修改：`backend/app/services/crm/lead_service.py`（转化写日志）
- 创建：`backend/tests/api/crm/test_audit_log.py`

> **前置**：先读 `backend/app/models/operation_audit_log.py` 确认字段（entity_type/action/operator/详情等），按其实际列名写入。下方代码以常见列 `entity_type/entity_id/action/operator_id/detail` 为例，**须按实际模型调整**。

- [ ] **步骤 1：编写日志辅助（放 `customer_service.py` 顶部或新建 `audit.py`）**

```python
def _write_audit(db: Session, *, entity_type: str, entity_id: int, action: str, operator_id: int | None, detail: str | None = None) -> None:
    """复用现有 operation_audit_log 基建；按其模型实际字段调整。失败不阻断主流程。"""
    try:
        from app.models.operation_audit_log import OperationAuditLog  # 按实际类名/字段调整

        db.add(OperationAuditLog(
            entity_type=entity_type,
            entity_id=entity_id,
            action=action,
            operator_id=operator_id,
            detail=detail,
        ))
    except Exception:
        pass  # 审计失败不阻断业务
```

- [ ] **步骤 2：在 `batch_transfer` / `batch_move_to_sea` / `claim_from_sea` 提交前调用 `_write_audit`**

例如 `claim_from_sea` 在 `cust.owner_id = cur` 后、`db.commit()` 前：

```python
    _write_audit(db, entity_type="customer", entity_id=cust.id, action="claim_from_sea", operator_id=cur)
```

`batch_transfer`（每条）：`action="transfer"`，detail 记 `to_owner_id`；`batch_move_to_sea`：`action="move_to_sea"`。`lead_service.convert_lead` 在 commit 前：`_write_audit(db, entity_type="lead", entity_id=lead.id, action="convert", operator_id=cur, detail=f"customer_id={customer.id}")`（需把 `_write_audit` 提到共享模块或在 lead_service 复制一份）。

- [ ] **步骤 3：编写测试 `test_audit_log.py`**

```python
from sqlalchemy import text


def test_claim_writes_audit_log(client, admin_headers, operator_headers):
    cust = client.post("/api/v1/crm/customers", json={"name": "审计客户"}, headers=admin_headers).json()
    client.post("/api/v1/crm/customers/batch-move-sea", json={"ids": [cust["id"]]}, headers=admin_headers)
    client.post(f"/api/v1/crm/customers/{cust['id']}/claim", headers=operator_headers)

    # 直接查 operation_audit_log（按实际表名/列名调整）
    from app.db.session import SessionLocal
    s = SessionLocal()
    try:
        rows = s.execute(text("select action from operation_audit_log where entity_type='customer' and entity_id=:id"), {"id": cust["id"]}).all()
        actions = {r[0] for r in rows}
        assert "move_to_sea" in actions
        assert "claim_from_sea" in actions
    finally:
        s.close()
```

- [ ] **步骤 4：运行测试**

运行：`cd backend && pytest tests/api/crm/test_audit_log.py -v`
预期：PASS（若 `operation_audit_log` 列名不符，按实际模型修 `_write_audit` 与查询）。

- [ ] **步骤 5：Commit**

```bash
git add backend/app/services/crm/customer_service.py backend/app/services/crm/lead_service.py backend/tests/api/crm/test_audit_log.py
git commit -m "feat(crm): 关键操作写入审计日志"
```

---

### 任务 26：重新生成 OpenAPI 类型（gen:api-types）

**文件：**
- 修改：`frontend/types/api-generated/openapi.json`
- 修改：`frontend/types/api-generated/api.d.ts`

- [ ] **步骤 1：后端导出 OpenAPI JSON**

运行：`cd backend && make openapi-export`（或 `python -m scripts.openapi_export --out ../frontend/types/api-generated/openapi.json`，按 `backend/Makefile` 实际 target）
预期：`frontend/types/api-generated/openapi.json` 含 `/api/v1/crm/*` 路径。

- [ ] **步骤 2：前端生成 TS 类型**

运行：`cd frontend && pnpm gen:api-types`
预期：`types/api-generated/api.d.ts` 重新生成，含 CRM schema（`CustomerItem`/`LeadItem` 等）。

- [ ] **步骤 3：验证 build 的 check 通过**

运行：`cd frontend && pnpm gen:api-types:check && pnpm build`
预期：check 绿（类型已同步）；build 成功。

- [ ] **步骤 4：Commit**

```bash
git add frontend/types/api-generated/openapi.json frontend/types/api-generated/api.d.ts
git commit -m "chore(crm): 重新生成 OpenAPI 类型（含 CRM 端点）"
```

### 任务 27：Playwright E2E 切真实后端模式

**文件：**
- 修改：`frontend/tests/crm/*.spec.ts`（或 `playwright.config.ts` 的环境变量）
- 修改：`frontend/playwright.config.ts`（http 模式 webServer/env，如需）

> MVP 已有 4 条 CRM E2E（`customer-lifecycle` / `lead-to-customer` / `sea-flow` / `crm-mobile`）跑在 Mock 模式。本任务让它们在 http 模式（真实后端 + 测试库）也能跑，作为 P1 的端到端验收。

- [ ] **步骤 1：确认 E2E 跑 http 模式的环境注入方式**

读 `frontend/playwright.config.ts` 与现有 CRM spec 的登录态 setup。确定如何给 E2E 的 Next 进程注入 `NEXT_PUBLIC_CRM_API_MODE=http` 并指向测试后端（通常 `webServer.env` 或 `.env.test`）。

- [ ] **步骤 2：让 E2E 使用独立测试数据（避免与手动数据冲突）**

E2E 创建的客户/线索用唯一前缀（如 `E2E-${Date.now()}`）；或在 E2E global-setup 里 TRUNCATE crm 测试表（指向测试库，**绝不指向 prod**）。

- [ ] **步骤 3：在 http 模式跑 4 条 E2E**

运行：`cd frontend && NEXT_PUBLIC_CRM_API_MODE=http pnpm playwright test tests/crm/`（按项目实际 e2e 命令）
预期：`customer-lifecycle` / `lead-to-customer` / `sea-flow` / `crm-mobile` 全过（操作真实测试库）。

- [ ] **步骤 4：保留 Mock 模式 E2E 作 CI 快路径**

确认默认（mock）`pnpm test:e2e` 仍绿（不依赖后端），http 模式作为 P1 验收的额外路径（可在 CI 单独 job 跑）。

- [ ] **步骤 5：Commit**

```bash
git add frontend/tests/crm frontend/playwright.config.ts
git commit -m "test(crm): E2E 支持真实后端模式"
```

---

### 任务 28：冷启动种子脚本 + 最小 CSV 导入

**文件：**
- 创建：`backend/app/scripts/seed_crm.py`

> L3 已定 Customer 独立、无遗留数据迁移。冷启动两条路：dev 种子（演示）+ 最小 CSV 导入（首批真实数据）。完整导入导出推 P4。

- [ ] **步骤 1：编写 dev 种子脚本 `seed_crm.py`**

```python
"""Seed CRM demo data into the DEV database (never run against prod).

Usage: cd backend && python -m app.scripts.seed_crm
Idempotent-ish: skips if crm_customers already has rows.
"""
from __future__ import annotations

import random

from app.db.session import SessionLocal
from app.models.crm import CrmContact, CrmCustomer, CrmFollow, CrmLead, CrmOpportunity

RATINGS = ["A", "B", "C", "D"]
SOURCES = ["referral", "exhibition", "online_ad", "cold_call", "other"]
STAGES = ["lead_in", "qualified", "proposal", "negotiation", "won"]


def main() -> None:
    db = SessionLocal()
    try:
        if db.query(CrmCustomer).count() > 0:
            print("crm_customers 已有数据，跳过种子（避免重复）。")
            return
        rng = random.Random(42)  # 确定性
        owner_pool = [1, 2, 3, 4]  # 假设 user_accounts 已有这些 id；按实际调整
        for i in range(60):
            owner = rng.choice(owner_pool + [None])  # 部分进公海
            cust = CrmCustomer(
                name=f"种子客户{i:03d}",
                rating=rng.choice(RATINGS),
                status="active",
                source=rng.choice(SOURCES),
                owner_id=owner,
                created_by=owner or 1,
            )
            db.add(cust)
            db.flush()
            db.add(CrmContact(customer_id=cust.id, name=f"联系人{i}", phone=f"138{rng.randint(10000000, 99999999)}", is_primary=True))
            if rng.random() < 0.6:
                db.add(CrmFollow(entity_type="customer", entity_id=cust.id, type="phone", content="种子跟进", created_by=owner or 1))
        for i in range(30):
            db.add(CrmLead(name=f"线索{i:03d}", company=f"线索公司{i}", source=rng.choice(SOURCES), intent=rng.choice(["high", "medium", "low"]), owner_id=rng.choice(owner_pool + [None]), created_by=1))
        db.commit()
        # 商机关联到已建客户
        cust_ids = [c.id for c in db.query(CrmCustomer.id).limit(15).all()]
        for i in range(20):
            db.add(CrmOpportunity(name=f"商机{i:03d}", customer_id=rng.choice(cust_ids), amount=rng.randint(1, 100) * 1000, stage=rng.choice(STAGES), owner_id=rng.choice(owner_pool), created_by=1))
        db.commit()
        print("CRM 种子数据写入完成：60 客户 / 30 线索 / 20 商机。")
    finally:
        db.close()


if __name__ == "__main__":
    main()
```

> **CSV 导入（最小版）**：若首批需灌真实客户，提供一个一次性脚本 `import_customers_csv.py`（读 CSV 列 `name,rating,status,source,owner_id` → 批量 `CrmCustomer`）。因属一次性运维脚本，本计划不展开完整代码；按需编写，跑前在测试库验证列映射。

- [ ] **步骤 2：在 dev 库验证种子**

运行：`cd backend && python -m app.scripts.seed_crm`（指向 dev 库）
预期：打印写入完成；前端 mock→http 切换后列表有 60 条客户。

- [ ] **步骤 3：Commit**

```bash
git add backend/app/scripts/seed_crm.py
git commit -m "feat(crm): dev 种子脚本（冷启动演示数据）"
```

**P1d 退出检查（即 P1 总退出）**：
- [ ] 操作级权限后端校验（operator 不能改/删他人客户）
- [ ] 关键 mutation（转移/移公海/领取/转化）写 `operation_audit_log`
- [ ] `pnpm gen:api-types:check` + `pnpm build` 绿（前后端类型同步）
- [ ] 4 条 Playwright E2E 在 http 模式过；mock 模式 E2E 仍绿
- [ ] `cd backend && pytest tests/api/crm tests/services/crm` 全绿
- [ ] `cd frontend && pnpm lint && pnpm test` 全绿
- [ ] `git deploy` 命中 backend/ 触发 VPS 部署成功（`alembic upgrade head` + 重启 + 健康检查）
- [ ] dev 种子可灌入；冷启动路径明确

---

## 2. 计划自检（writing-plans 规格对照）

**规格覆盖度**（对照 `CRM-BASIC-PLAN.md` §4 P1 退出标准）：

| P1 退出标准 | 覆盖任务 |
|---|---|
| http 模式五实体全流程操作真实数据 | 任务 1-23（P1a-P1c）+ 任务 14/23 手动验证 |
| scope=mine/all 按角色生效 | 任务 3（service）+ 任务 10（测试） |
| 操作级权限后端校验 | 任务 24 |
| `gen:api-types:check` 绿 | 任务 26 |
| 后端 pytest 覆盖 service | 任务 8/9/10/18/19/22/24/25 |
| 前端单测继续绿（Mock 夹具） | 任务 11/13（dto-mappers + contact）+ 既有 Mock 单测 |
| 4 条 E2E 真实后端跑通 | 任务 27 |
| `git deploy` 部署成功 | P1d 退出检查（迁移独立成文件，任务 1） |
| Contact 拆分（P1-D1） | 任务 1（crm_contacts）+ 任务 4（service）+ 任务 13（前端子列表） |
| owner_id 复用 user_accounts（P1-D2） | 任务 3（`_owner_name_map` 查 user_accounts）+ 任务 5 |
| 操作日志复用 operation_audit_log（P1-D3） | 任务 25 |
| 冷启动 CSV/种子（P1-D4） | 任务 28 |
| E2E 独立测试库（P1-D5） | 任务 7（TRUNCATE 夹具）+ 任务 27 |

**占位符扫描**：lead/opportunity/follow 在 P1a 任务 12 用 `Promise.reject` 是**有意的分阶段占位**（P1b/P1c 立即替换），非缺陷；P1 结束时 `HttpCrmClient` 无占位残留（任务 23 步骤 3 验证）。`_write_audit` 的 `operation_audit_log` 列名标注「按实际模型调整」是**诚实的前置核对项**（任务 25 步骤 0 要求先读模型），非待定。

**类型一致性**：`CustomerItem.contact_name/phone/email`（任务 2）↔ `mapCustomer`（任务 11）↔ 前端 `Customer.contactName/Phone/Email`（既有类型）一致；`Paginated.page_size`（后端）↔ `mapPaginated.pageSize`（任务 11）一致；`owner_id: int`（后端）↔ `ownerId: string`（前端，`nullableStrId`）一致。`convert_lead` 返回 `(LeadItem, CustomerItem)` 元组（任务 15）↔ 路由 `ConvertLeadResponse(lead=, customer=)`（任务 17）↔ http-client `{lead, customer}`（任务 20）一致。

**已知执行期需核对项**（非计划缺陷，列出供执行者首日确认）：
1. `app/main.py` 的 `api_router` 挂载前缀（任务 1 步骤 1）。
2. 迁移 `down_revision` 指向当前 alembic head（任务 1 步骤 4 注）。
3. `operation_audit_log` 模型实际字段（任务 25 前置）。
4. `user_accounts` 已有用户 id 池（种子脚本任务 28 的 `owner_pool` 按实际调整）。
5. `Lead`/`Opportunity`/`Follow`/`User` 前端类型字段名与 mapper 的精确匹配（`tsc` 校验，任务 12/20/23）。

---

## 3. 执行交接

**计划已完成并保存到 `docs/superpowers/plans/2026-07-22-crm-p1-real-backend.md`。两种执行方式：**

**1. 子代理驱动（推荐）** — 每个任务调度一个新的子代理，任务间进行审查，快速迭代。P1a-P1d 顺序执行，每个 sub-phase 退出检查作为审查关卡。

**2. 内联执行** — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点（建议以 P1a/P1b/P1c/P1d 四个退出检查为检查点）。

> **执行前置**：建议在专用 worktree/分支执行（如 `feat/crm-p1-real-backend`），首日先跑 `cd backend && python scripts/setup_test_db.py` 备好测试库，并核对 §2「已知执行期需核对项」5 条。

**选哪种方式？**

