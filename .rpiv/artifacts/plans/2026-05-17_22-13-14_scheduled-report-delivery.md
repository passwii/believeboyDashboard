---
date: 2026-05-17T22:13:14+0800
author: AI Assistant
commit: e47d0e2
branch: main
repository: believeboyDashboard
topic: 定时报告推送 (Scheduled Report Delivery)
tags:
  - backend
  - scheduled-task
  - email
  - ai
  - frontend
status: in-progress
parent: docs/05-scheduled-report-delivery.md
phase_count: 6
unresolved_phase_count: 6
last_updated: 2026-05-17T22:13:14+0800
last_updated_by: AI Assistant
---

# 定时报告推送功能实现计划

> 父文档：`docs/05-scheduled-report-delivery.md`
> 本计划为详细实施计划，将生成可直接复制的代码片段。

## Overview

构建定时报告推送系统，支持每日/每周/每月三种频率，通过 Resend API 发送 AI 增强的 HTML 邮件报告。项目已有 APScheduler 调度器、Resend 邮件发送、AI Insight 生成能力，本功能将复用这些基础设施。

## Requirements

- 每日报告：每天北京时间 15:00 执行
- 每周报告：每周二北京时间 10:00 执行
- 月度报告：每月 2 日后第一个星期一执行（或每月 4 日后第一个工作日）
- 用户可订阅不同频率，可选择项目范围和国家站点
- 每份报告包含 AI 摘要 + 关键指标
- 推送历史记录可查
- 支持测试邮件发送

## What We're NOT Doing

- **不实现**邮件附件（Excel/PDF 附件）推送，仅发送 HTML 正文
- **不实现**飞书/钉钉等其他推送渠道
- **不实现**报告内容的手动编辑（仅管理订阅配置）
- **不实现**用户注册/登录（复用现有 NextAuth 体系）

## Decisions

### Decision 1: 订阅与用户的关联方式
订阅表的 `user_id` 字段设为外键约束（与 AlertPreference 一致），允许 `user_id` 为 null（系统级订阅），前端调用时传入 `X-User-Id`

### Decision 2: 调度器扩展方式
不新建调度器模块，在 `app/core/scheduler.py` 中直接添加三个 job 函数，保持与现有告警任务一致的管理方式

### Decision 3: 月度报告执行时间
- APScheduler cron trigger 设置为 `day=4, hour=10`（每月 4 日）
- 代码层面判断：如果 4 日是周末（SAT=5/SUN=6），则顺延至下一周的星期一

### Decision 4: 报告数据复用
报告数据直接调用 `build_dashboard_overview()` 获取，AI 摘要调用 `ai_insight_generator` 服务

---

## Phase 1: 数据模型与数据库迁移

### Overview

创建订阅配置表和推送日志表，编写 Alembic 迁移文件。

### Changes Required

#### 1. backend/app/models/scheduled_report.py

**File**: `backend/app/models/scheduled_report.py`
**Changes**: NEW — 创建订阅配置与推送日志两张 Model

```python
"""Scheduled Report Subscription and Delivery Log Models."""

from __future__ import annotations

from datetime import datetime
from enum import Enum

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.session import Base


class ReportFrequency(str, Enum):
    DAILY = "daily"
    WEEKLY = "weekly"
    MONTHLY = "monthly"


class DeliveryStatus(str, Enum):
    PENDING = "pending"
    SENT = "sent"
    FAILED = "failed"


class ScheduledReportSubscription(Base):
    __tablename__ = "scheduled_report_subscriptions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=True
    )
    email: Mapped[str] = mapped_column(String(256), nullable=False)
    project_ids: Mapped[str] = mapped_column(String(500), nullable=False, default="*")
    country: Mapped[str] = mapped_column(String(10), nullable=False, default="US")
    frequency: Mapped[str] = mapped_column(String(20), nullable=False)
    enabled: Mapped[bool] = mapped_column(nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False,
        server_default=func.now(), onupdate=func.now()
    )

    # Relationships
    delivery_logs: Mapped[list["ScheduledReportDeliveryLog"]] = relationship(
        "ScheduledReportDeliveryLog",
        back_populates="subscription",
        cascade="all, delete-orphan",
    )

    @property
    def project_id_list(self) -> list[int]:
        if self.project_ids == "*":
            return []
        try:
            return [int(x.strip()) for x in self.project_ids.split(",") if x.strip()]
        except ValueError:
            return []


class ScheduledReportDeliveryLog(Base):
    __tablename__ = "scheduled_report_delivery_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    subscription_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("scheduled_report_subscriptions.id", ondelete="CASCADE"), nullable=False
    )
    frequency: Mapped[str] = mapped_column(String(20), nullable=False)
    report_date: Mapped[str] = mapped_column(String(20), nullable=False)
    report_month: Mapped[str | None] = mapped_column(String(10), nullable=True)
    email: Mapped[str] = mapped_column(String(256), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default=DeliveryStatus.PENDING.value)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    # Relationships
    subscription: Mapped["ScheduledReportSubscription"] = relationship(
        "ScheduledReportSubscription", back_populates="delivery_logs"
    )
```

#### 2. backend/app/models/__init__.py

**File**: `backend/app/models/__init__.py`
**Changes**: MODIFY — 在文件末尾 `__all__` 列表中添加：

```python
# Add to imports section (around line 90):
from app.models.scheduled_report import (
    ScheduledReportSubscription,
    ScheduledReportDeliveryLog,
    ReportFrequency,
    DeliveryStatus,
)

# Add to __all__ list (around line 185):
    'ScheduledReportSubscription',
    'ScheduledReportDeliveryLog',
    'ReportFrequency',
    'DeliveryStatus',
```

#### 3. backend/alembic/versions/20260517_001_add_scheduled_report_tables.py

**File**: `backend/alembic/versions/20260517_001_add_scheduled_report_tables.py`
**Changes**: NEW — Alembic 迁移文件

```python
"""Add scheduled report subscriptions and delivery logs."""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = '20260517_001'
down_revision = None  # TODO: set to latest migration hash from `alembic heads`
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'scheduled_report_subscriptions',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=True),
        sa.Column('email', sa.String(length=256), nullable=False),
        sa.Column('project_ids', sa.String(length=500), nullable=False, server_default='*'),
        sa.Column('country', sa.String(length=10), nullable=False, server_default='US'),
        sa.Column('frequency', sa.String(length=20), nullable=False),
        sa.Column('enabled', sa.Boolean(), nullable=False, server_default='true'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.func.now(), onupdate=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    )
    op.create_index('ix_scheduled_report_subs_user_id', 'scheduled_report_subscriptions', ['user_id'])
    op.create_index('ix_scheduled_report_subs_frequency', 'scheduled_report_subscriptions', ['frequency', 'enabled'])

    op.create_table(
        'scheduled_report_delivery_logs',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('subscription_id', sa.Integer(), nullable=False),
        sa.Column('frequency', sa.String(length=20), nullable=False),
        sa.Column('report_date', sa.String(length=20), nullable=False),
        sa.Column('report_month', sa.String(length=10), nullable=True),
        sa.Column('email', sa.String(length=256), nullable=False),
        sa.Column('status', sa.String(length=20), nullable=False, server_default='pending'),
        sa.Column('error_message', sa.Text(), nullable=True),
        sa.Column('sent_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.ForeignKeyConstraint(['subscription_id'], ['scheduled_report_subscriptions.id'], ondelete='CASCADE'),
    )
    op.create_index('ix_delivery_logs_subscription', 'scheduled_report_delivery_logs', ['subscription_id'])
    op.create_index('ix_delivery_logs_report_date', 'scheduled_report_delivery_logs', ['report_date'])


def downgrade() -> None:
    op.drop_table('scheduled_report_delivery_logs')
    op.drop_table('scheduled_report_subscriptions')
```

### Success Criteria

#### Automated Verification:
- [ ] `python -c "from app.models.scheduled_report import ScheduledReportSubscription, ScheduledReportDeliveryLog; print('Models OK')"` passes
- [ ] `python -c "from app.models import ScheduledReportSubscription, ScheduledReportDeliveryLog"` from __init__.py passes

#### Manual Verification:
- [ ] `alembic revision --autogenerate -m "add scheduled report tables"` 生成迁移文件
- [ ] 迁移文件语法正确：无 Python 语法错误

---

## Phase 2: API Schema 与订阅服务

### Overview

创建 Pydantic Schema 和订阅管理服务（含 CRUD 操作）。依赖 Phase 1 的 Model。

### Changes Required

#### 1. backend/app/schemas/scheduled_report.py

**File**: `backend/app/schemas/scheduled_report.py`
**Changes**: NEW — 订阅和日志的 Request/Response Schema

```python
"""Scheduled Report Pydantic Schemas."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


class SubscriptionCreate(BaseModel):
    email: str = Field(..., max_length=256, description="接收报告的邮箱地址")
    project_ids: str = Field(default="*", max_length=500, description="项目 ID 列表，逗号分隔，* 表示全部")
    country: str = Field(default="US", max_length=10)
    frequency: str = Field(..., pattern="^(daily|weekly|monthly)$")


class SubscriptionUpdate(BaseModel):
    email: Optional[str] = Field(default=None, max_length=256)
    project_ids: Optional[str] = Field(default=None, max_length=500)
    country: Optional[str] = Field(default=None, max_length=10)
    frequency: Optional[str] = Field(default=None, pattern="^(daily|weekly|monthly)$")
    enabled: Optional[bool] = None


class SubscriptionItem(BaseModel):
    id: int
    user_id: Optional[int]
    email: str
    project_ids: str
    country: str
    frequency: str
    enabled: bool
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class SubscriptionListResponse(BaseModel):
    items: list[SubscriptionItem]
    total: int


class DeliveryLogItem(BaseModel):
    id: int
    subscription_id: int
    frequency: str
    report_date: str
    report_month: Optional[str]
    email: str
    status: str
    error_message: Optional[str]
    sent_at: Optional[datetime]
    created_at: datetime

    model_config = {"from_attributes": True}


class DeliveryLogListResponse(BaseModel):
    items: list[DeliveryLogItem]
    total: int


class TestEmailRequest(BaseModel):
    email: str = Field(..., max_length=256)
    frequency: str = Field(default="daily", pattern="^(daily|weekly|monthly)$")


class TestEmailResponse(BaseModel):
    success: bool
    message: str
    resend_id: Optional[str] = None


class TriggerReportResponse(BaseModel):
    success: bool
    frequency: str
    subscriptions_affected: int
    message: str
```

#### 2. backend/app/services/scheduled_report/subscription_service.py

**File**: `backend/app/services/scheduled_report/subscription_service.py`
**Changes**: NEW — 订阅 CRUD 服务

```python
"""Subscription CRUD service for scheduled reports."""

from __future__ import annotations

import logging
from typing import Optional

from sqlalchemy import select, func
from sqlalchemy.orm import Session

from app.models import ScheduledReportSubscription, ScheduledReportDeliveryLog
from app.models.scheduled_report import DeliveryStatus
from app.schemas.scheduled_report import SubscriptionCreate, SubscriptionUpdate

logger = logging.getLogger(__name__)


def get_subscriptions_by_user(
    db: Session,
    user_id: int | None,
    frequency: str | None = None,
    enabled_only: bool = False,
) -> list[ScheduledReportSubscription]:
    """获取指定用户的所有订阅。"""
    query = select(ScheduledReportSubscription)
    if user_id is not None:
        query = query.where(ScheduledReportSubscription.user_id == user_id)
    if frequency:
        query = query.where(ScheduledReportSubscription.frequency == frequency)
    if enabled_only:
        query = query.where(ScheduledReportSubscription.enabled == True)
    query = query.order_by(ScheduledReportSubscription.created_at.desc())
    result = db.execute(query)
    return list(result.scalars().all())


def get_active_subscriptions(
    db: Session,
    frequency: str,
) -> list[ScheduledReportSubscription]:
    """获取指定频率的所有启用订阅。"""
    query = (
        select(ScheduledReportSubscription)
        .where(ScheduledReportSubscription.frequency == frequency)
        .where(ScheduledReportSubscription.enabled == True)
    )
    result = db.execute(query)
    return list(result.scalars().all())


def create_subscription(
    db: Session,
    user_id: int | None,
    data: SubscriptionCreate,
) -> ScheduledReportSubscription:
    """创建新订阅。"""
    subscription = ScheduledReportSubscription(
        user_id=user_id,
        email=data.email,
        project_ids=data.project_ids,
        country=data.country,
        frequency=data.frequency,
        enabled=True,
    )
    db.add(subscription)
    db.commit()
    db.refresh(subscription)
    logger.info(f"Created subscription id={subscription.id} for email={data.email}")
    return subscription


def update_subscription(
    db: Session,
    subscription_id: int,
    data: SubscriptionUpdate,
) -> Optional[ScheduledReportSubscription]:
    """更新订阅配置。"""
    subscription = db.get(ScheduledReportSubscription, subscription_id)
    if not subscription:
        return None
    update_data = data.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        if value is not None:
            setattr(subscription, key, value)
    db.commit()
    db.refresh(subscription)
    logger.info(f"Updated subscription id={subscription_id}")
    return subscription


def delete_subscription(
    db: Session,
    subscription_id: int,
) -> bool:
    """删除订阅。"""
    subscription = db.get(ScheduledReportSubscription, subscription_id)
    if not subscription:
        return False
    db.delete(subscription)
    db.commit()
    logger.info(f"Deleted subscription id={subscription_id}")
    return True


def get_delivery_logs(
    db: Session,
    user_id: int | None = None,
    subscription_id: int | None = None,
    status: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[ScheduledReportDeliveryLog], int]:
    """获取推送日志。"""
    query = select(ScheduledReportDeliveryLog)
    if subscription_id:
        query = query.where(ScheduledReportDeliveryLog.subscription_id == subscription_id)
    elif user_id is not None:
        sub_ids = select(ScheduledReportSubscription.id).where(
            ScheduledReportSubscription.user_id == user_id
        )
        query = query.where(ScheduledReportDeliveryLog.subscription_id.in_(sub_ids))
    if status:
        query = query.where(ScheduledReportDeliveryLog.status == status)
    count_query = select(func.count()).select_from(query.subquery())
    total = db.execute(count_query).scalar() or 0
    query = query.order_by(ScheduledReportDeliveryLog.created_at.desc())
    query = query.limit(limit).offset(offset)
    result = db.execute(query)
    return list(result.scalars().all()), total


def create_delivery_log(
    db: Session,
    subscription_id: int,
    frequency: str,
    report_date: str,
    report_month: str | None,
    email: str,
) -> ScheduledReportDeliveryLog:
    """创建推送日志记录。"""
    log = ScheduledReportDeliveryLog(
        subscription_id=subscription_id,
        frequency=frequency,
        report_date=report_date,
        report_month=report_month,
        email=email,
        status=DeliveryStatus.PENDING.value,
    )
    db.add(log)
    db.commit()
    db.refresh(log)
    return log


def mark_delivery_success(db: Session, log_id: int, resend_id: str | None = None) -> None:
    """标记推送成功。"""
    from datetime import datetime, timezone
    log = db.get(ScheduledReportDeliveryLog, log_id)
    if log:
        log.status = DeliveryStatus.SENT.value
        log.sent_at = datetime.now(timezone.utc)
        db.commit()


def mark_delivery_failed(db: Session, log_id: int, error_message: str) -> None:
    """标记推送失败。"""
    log = db.get(ScheduledReportDeliveryLog, log_id)
    if log:
        log.status = DeliveryStatus.FAILED.value
        log.error_message = error_message
        db.commit()
```

#### 3. backend/app/services/scheduled_report/__init__.py

**File**: `backend/app/services/scheduled_report/__init__.py`
**Changes**: NEW — 服务包初始化文件

```python
"""Scheduled report services package."""

from __future__ import annotations

from app.services.scheduled_report.subscription_service import (
    get_subscriptions_by_user,
    get_active_subscriptions,
    create_subscription,
    update_subscription,
    delete_subscription,
    get_delivery_logs,
    create_delivery_log,
    mark_delivery_success,
    mark_delivery_failed,
)

__all__ = [
    'get_subscriptions_by_user',
    'get_active_subscriptions',
    'create_subscription',
    'update_subscription',
    'delete_subscription',
    'get_delivery_logs',
    'create_delivery_log',
    'mark_delivery_success',
    'mark_delivery_failed',
]
```

### Success Criteria

#### Automated Verification:
- [ ] `python -c "from app.schemas.scheduled_report import SubscriptionCreate, SubscriptionItem; print('Schemas OK')"` passes
- [ ] `python -c "from app.services.scheduled_report import get_active_subscriptions; print('Service OK')"` passes

#### Manual Verification:
- [ ] Pydantic schema 验证测试：创建 invalid frequency 应报错

---

## Phase 3: 邮件发送服务（扩展 Resend）

### Overview

扩展现有 `email_service.py`，新增报告邮件发送功能，包含 HTML 邮件模板构建。依赖 Phase 1-2。

### Changes Required

#### 1. backend/app/services/scheduled_report/email_sender.py

**File**: `backend/app/services/scheduled_report/email_sender.py`
**Changes**: NEW — 报告邮件发送服务

```python
"""Scheduled report email sender using Resend."""

from __future__ import annotations

import logging
from datetime import date
from typing import Any

import resend

from app.core.config import get_settings

logger = logging.getLogger(__name__)


def _render_daily_report_html(report_data: dict[str, Any]) -> str:
    """构建每日报告 HTML 邮件。"""
    sales = report_data.get("sales", {})
    inventory = report_data.get("inventory", {})
    ads = report_data.get("ads", {})
    ai_summary = report_data.get("ai_summary", "暂无 AI 摘要")

    sales_change = sales.get("sales_change_pct", 0)
    change_color = "#22C55E" if sales_change >= 0 else "#EF4444"
    change_icon = "↑" if sales_change >= 0 else "↓"

    return f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>BelieveBoy 每日运营报告</title></head>
<body style="font-family: -apple-system, 'Segoe UI', sans-serif; background: #F3F4F6; margin: 0; padding: 20px;">
  <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #1F2937 0%, #374151 100%); padding: 24px;">
      <h1 style="margin: 0; color: white; font-size: 20px; font-weight: 600;">📊 BelieveBoy 每日运营报告</h1>
      <p style="margin: 4px 0 0; color: #9CA3AF; font-size: 13px;">{report_data.get('report_date', date.today().isoformat())} · {report_data.get('country', 'US')}</p>
    </div>
    <div style="margin: 16px; padding: 16px; background: #EFF6FF; border-radius: 8px; border-left: 4px solid #3B82F6;">
      <p style="margin: 0 0 8px; font-size: 12px; font-weight: 600; color: #1D4ED8; text-transform: uppercase;">🔍 AI 摘要</p>
      <p style="margin: 0; font-size: 14px; color: #1E3A5F; line-height: 1.6;">{ai_summary}</p>
    </div>
    <div style="padding: 0 16px 16px; display: grid; gap: 12px;">
      <div style="padding: 16px; border: 1px solid #E5E7EB; border-radius: 8px;">
        <h3 style="margin: 0 0 12px; font-size: 14px; font-weight: 600; color: #374151;">📈 销售概览</h3>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
          <div><p style="margin: 0; font-size: 11px; color: #6B7280;">今日销量</p><p style="margin: 2px 0 0; font-size: 20px; font-weight: 700; color: #111827;">{sales.get('today_order_qty', 0):,}</p></div>
          <div><p style="margin: 0; font-size: 11px; color: #6B7280;">今日销售额</p><p style="margin: 2px 0 0; font-size: 20px; font-weight: 700; color: #111827;">¥{sales.get('today_sales_amount', 0):,.2f}</p></div>
          <div><p style="margin: 0; font-size: 11px; color: #6B7280;">环比变化</p><p style="margin: 2px 0 0; font-size: 16px; font-weight: 600; color: {change_color};">{change_icon} {abs(sales_change):.1f}%</p></div>
        </div>
      </div>
      <div style="padding: 16px; border: 1px solid #E5E7EB; border-radius: 8px;">
        <h3 style="margin: 0 0 12px; font-size: 14px; font-weight: 600; color: #374151;">📦 库存状态</h3>
        <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px;">
          <div><p style="margin: 0; font-size: 11px; color: #6B7280;">SKU 总数</p><p style="margin: 2px 0 0; font-size: 18px; font-weight: 700; color: #111827;">{inventory.get('sku_count', 0):,}</p></div>
          <div><p style="margin: 0; font-size: 11px; color: #6B7280;">可用库存</p><p style="margin: 2px 0 0; font-size: 18px; font-weight: 700; color: #111827;">{inventory.get('available_qty', 0):,}</p></div>
          <div><p style="margin: 0; font-size: 11px; color: #6B7280;">缺货 SKU</p><p style="margin: 2px 0 0; font-size: 18px; font-weight: 700; color: {'#EF4444' if inventory.get('out_of_stock_count', 0) > 0 else '#111827'};">{inventory.get('out_of_stock_count', 0)}</p></div>
        </div>
      </div>
      <div style="padding: 16px; border: 1px solid #E5E7EB; border-radius: 8px;">
        <h3 style="margin: 0 0 12px; font-size: 14px; font-weight: 600; color: #374151;">💰 广告数据</h3>
        <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; text-align: center;">
          <div><p style="margin: 0; font-size: 10px; color: #6B7280;">花费</p><p style="margin: 2px 0 0; font-size: 14px; font-weight: 600;">¥{ads.get('period_spend', 0):,.2f}</p></div>
          <div><p style="margin: 0; font-size: 10px; color: #6B7280;">ROAS</p><p style="margin: 2px 0 0; font-size: 14px; font-weight: 600;">{ads.get('period_roas', 0):.2f}</p></div>
          <div><p style="margin: 0; font-size: 10px; color: #6B7280;">ACOS</p><p style="margin: 2px 0 0; font-size: 14px; font-weight: 600;">{ads.get('period_acos', 0):.1f}%</p></div>
          <div><p style="margin: 0; font-size: 10px; color: #6B7280;">CTR</p><p style="margin: 2px 0 0; font-size: 14px; font-weight: 600;">{ads.get('period_ctr', 0):.2f}%</p></div>
        </div>
      </div>
    </div>
    <div style="padding: 16px; border-top: 1px solid #E5E7EB; text-align: center;">
      <a href="{get_settings().frontend_url}/dashboard" style="display:inline-block;background:#2563EB;color:white;text-decoration:none;padding:10px 20px;border-radius:6px;font-size:13px;font-weight:500;">查看完整报告 →</a>
      <p style="margin: 12px 0 0; font-size: 11px; color: #9CA3AF;">BelieveBoy Dashboard · 定时报告推送</p>
    </div>
  </div>
</body>
</html>"""


def _render_weekly_report_html(report_data: dict[str, Any]) -> str:
    """构建每周报告 HTML 邮件。"""
    ai_summary = report_data.get("ai_summary", "暂无 AI 摘要")
    week_sales = report_data.get("week_sales", {})
    week_ads = report_data.get("week_ads", {})
    top_skus = report_data.get("top_skus", [])
    inventory_alerts = report_data.get("inventory_alerts", [])

    sku_rows = "".join(f"""<tr style="border-bottom: 1px solid #F3F4F6;">
      <td style="padding: 8px; font-size: 13px; color: #374151;">{sku.get('sku', '')}</td>
      <td style="padding: 8px; font-size: 13px; text-align: right; font-weight: 600;">{sku.get('quantity', 0):,}</td>
    </tr>""" for sku in top_skus[:5])

    alert_rows = "".join(f"""<tr style="border-bottom: 1px solid #FEF2F2;">
      <td style="padding: 8px;"><span style="display:inline-block;background:#FEE2E2;color:#DC2626;border-radius:4px;padding:2px 6px;font-size:11px;">告急</span></td>
      <td style="padding: 8px; font-size: 13px; color: #374151;">{alert.get('sku', '')}</td>
      <td style="padding: 8px; font-size: 12px; color: #DC2626;">库存 {alert.get('available_qty', 0)} 件</td>
    </tr>""" for alert in inventory_alerts[:3])

    alert_section = f"""<div style="padding: 0 16px 16px;">
      <h3 style="margin: 0 0 8px; font-size: 14px; font-weight: 600; color: #374151;">⚠️ 库存预警</h3>
      <table style="width: 100%; border-collapse: collapse; border: 1px solid #FEE2E2; border-radius: 8px; overflow: hidden;">
        <thead><tr style="background: #FEF2F2;"><th style="padding: 8px 16px; font-size: 11px; color: #991B1B;">状态</th><th style="padding: 8px 16px; font-size: 11px; color: #991B1B;">SKU</th><th style="padding: 8px 16px; font-size: 11px; color: #991B1B;">可用库存</th></tr></thead>
        <tbody>{alert_rows}</tbody>
      </table>
    </div>""" if alert_rows else ""

    return f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, 'Segoe UI', sans-serif; background: #F3F4F6; margin: 0; padding: 20px;">
  <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #1F2937 0%, #374151 100%); padding: 24px;">
      <h1 style="margin: 0; color: white; font-size: 20px; font-weight: 600;">📊 BelieveBoy 每周运营报告</h1>
      <p style="margin: 4px 0 0; color: #9CA3AF; font-size: 13px;">{report_data.get('report_date', '')} · 第 {report_data.get('week_number', '')} 周</p>
    </div>
    <div style="margin: 16px; padding: 16px; background: #EFF6FF; border-radius: 8px; border-left: 4px solid #3B82F6;">
      <p style="margin: 0 0 8px; font-size: 12px; font-weight: 600; color: #1D4ED8; text-transform: uppercase;">🔍 AI 周报</p>
      <p style="margin: 0; font-size: 14px; color: #1E3A5F; line-height: 1.6;">{ai_summary}</p>
    </div>
    <div style="padding: 0 16px 16px;">
      <div style="padding: 16px; border: 1px solid #E5E7EB; border-radius: 8px; margin-bottom: 12px;">
        <h3 style="margin: 0 0 12px; font-size: 14px; font-weight: 600;">📈 本周销售</h3>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
          <div><p style="margin: 0; font-size: 11px; color: #6B7280;">本周总销量</p><p style="margin: 2px 0 0; font-size: 24px; font-weight: 700; color: #111827;">{week_sales.get('total_qty', 0):,}</p></div>
          <div><p style="margin: 0; font-size: 11px; color: #6B7280;">本周总销售额</p><p style="margin: 2px 0 0; font-size: 24px; font-weight: 700; color: #111827;">¥{week_sales.get('total_amount', 0):,.2f}</p></div>
        </div>
      </div>
      <div style="padding: 16px; border: 1px solid #E5E7EB; border-radius: 8px;">
        <h3 style="margin: 0 0 12px; font-size: 14px; font-weight: 600;">💰 本周广告</h3>
        <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; text-align: center;">
          <div><p style="margin:0;font-size:11px;color:#6B7280;">花费</p><p style="margin:2px 0 0;font-size:14px;font-weight:600;">¥{week_ads.get('total_spend', 0):,.0f}</p></div>
          <div><p style="margin:0;font-size:11px;color:#6B7280;">广告销售</p><p style="margin:2px 0 0;font-size:14px;font-weight:600;">¥{week_ads.get('total_sales', 0):,.0f}</p></div>
          <div><p style="margin:0;font-size:11px;color:#6B7280;">ROAS</p><p style="margin:2px 0 0;font-size:14px;font-weight:600;">{week_ads.get('avg_roas', 0):.2f}</p></div>
          <div><p style="margin:0;font-size:11px;color:#6B7280;">ACOS</p><p style="margin:2px 0 0;font-size:14px;font-weight:600;">{week_ads.get('avg_acos', 0):.1f}%</p></div>
        </div>
      </div>
    </div>
    <div style="padding: 0 16px 16px;">
      <table style="width: 100%; border-collapse: collapse; border: 1px solid #E5E7EB; border-radius: 8px; overflow: hidden;">
        <thead><tr style="background: #F9FAFB;"><th style="padding: 10px 16px; font-size: 12px; color: #6B7280; text-align: left;">TOP SKU</th><th style="padding: 10px 16px; font-size: 12px; color: #6B7280; text-align: right;">销量</th></tr></thead>
        <tbody>{sku_rows}</tbody>
      </table>
    </div>
    {alert_section}
    <div style="padding: 16px; border-top: 1px solid #E5E7EB; text-align: center;">
      <a href="{get_settings().frontend_url}/dashboard" style="display:inline-block;background:#2563EB;color:white;text-decoration:none;padding:10px 20px;border-radius:6px;font-size:13px;font-weight:500;">查看完整报告 →</a>
    </div>
  </div>
</body>
</html>"""


def _render_monthly_report_html(report_data: dict[str, Any]) -> str:
    """构建每月报告 HTML 邮件。"""
    ai_summary = report_data.get("ai_summary", "暂无 AI 摘要")
    financial = report_data.get("financial_summary", {})
    projects = report_data.get("project_breakdown", [])
    commission = report_data.get("commission_summary", {})

    project_rows = "".join(f"""<tr style="border-bottom: 1px solid #F3F4F6;">
      <td style="padding: 10px 16px; font-size: 13px; color: #374151;">{p.get('name', '')}</td>
      <td style="padding: 10px 16px; font-size: 13px; text-align: right; font-weight: 600;">¥{p.get('revenue', 0):,.2f}</td>
      <td style="padding: 10px 16px; font-size: 13px; text-align: right;">{p.get('profit_margin', 0):.1f}%</td>
    </tr>""" for p in projects)

    project_section = f"""<div style="padding: 0 16px 16px;">
      <h3 style="margin: 0 0 8px; font-size: 14px; font-weight: 600;">📁 各项目表现</h3>
      <table style="width: 100%; border-collapse: collapse; border: 1px solid #E5E7EB; border-radius: 8px; overflow: hidden;">
        <thead><tr style="background: #F9FAFB;"><th style="padding: 10px 16px; font-size: 12px; color: #6B7280; text-align: left;">项目</th><th style="padding: 10px 16px; font-size: 12px; color: #6B7280; text-align: right;">收入</th><th style="padding: 10px 16px; font-size: 12px; color: #6B7280; text-align: right;">利润率</th></tr></thead>
        <tbody>{project_rows}</tbody>
      </table>
    </div>""" if project_rows else ""

    return f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, 'Segoe UI', sans-serif; background: #F3F4F6; margin: 0; padding: 20px;">
  <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #1F2937 0%, #374151 100%); padding: 24px;">
      <h1 style="margin: 0; color: white; font-size: 20px; font-weight: 600;">📊 BelieveBoy {report_data.get('report_month', '')} 月度报告</h1>
      <p style="margin: 4px 0 0; color: #9CA3AF; font-size: 13px;">月度财务汇总 · {report_data.get('country', 'US')}</p>
    </div>
    <div style="margin: 16px; padding: 16px; background: #EFF6FF; border-radius: 8px; border-left: 4px solid #3B82F6;">
      <p style="margin: 0 0 8px; font-size: 12px; font-weight: 600; color: #1D4ED8; text-transform: uppercase;">🔍 AI 月报</p>
      <p style="margin: 0; font-size: 14px; color: #1E3A5F; line-height: 1.6;">{ai_summary}</p>
    </div>
    <div style="padding: 0 16px 16px; display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px;">
      <div style="padding: 16px; border: 1px solid #E5E7EB; border-radius: 8px; text-align: center;"><p style="margin: 0; font-size: 11px; color: #6B7280;">总收入</p><p style="margin: 4px 0 0; font-size: 18px; font-weight: 700; color: #111827;">¥{financial.get('total_revenue', 0):,.2f}</p></div>
      <div style="padding: 16px; border: 1px solid #E5E7EB; border-radius: 8px; text-align: center;"><p style="margin: 0; font-size: 11px; color: #6B7280;">总成本</p><p style="margin: 4px 0 0; font-size: 18px; font-weight: 700; color: #111827;">¥{financial.get('total_cost', 0):,.2f}</p></div>
      <div style="padding: 16px; border: 1px solid #E5E7EB; border-radius: 8px; text-align: center;"><p style="margin: 0; font-size: 11px; color: #6B7280;">净利润</p><p style="margin: 4px 0 0; font-size: 18px; font-weight: 700; color: #22C55E;">¥{financial.get('net_profit', 0):,.2f}</p></div>
      <div style="padding: 16px; border: 1px solid #E5E7EB; border-radius: 8px; text-align: center;"><p style="margin: 0; font-size: 11px; color: #6B7280;">佣金合计</p><p style="margin: 4px 0 0; font-size: 18px; font-weight: 700; color: #111827;">¥{commission.get('total', 0):,.2f}</p></div>
    </div>
    {project_section}
    <div style="padding: 16px; border-top: 1px solid #E5E7EB; text-align: center;">
      <a href="{get_settings().frontend_url}/dashboard" style="display:inline-block;background:#2563EB;color:white;text-decoration:none;padding:10px 20px;border-radius:6px;font-size:13px;font-weight:500;">查看完整报告 →</a>
    </div>
  </div>
</body>
</html>"""


def send_scheduled_report_email(
    to_email: str,
    frequency: str,
    report_data: dict[str, Any],
) -> tuple[bool, str | None]:
    """发送定时报告邮件。返回 (success, resend_id)。"""
    settings = get_settings()
    if not settings.resend_api_key:
        logger.warning("RESEND_API_KEY not configured, skipping report email")
        return False, "RESEND_API_KEY not configured"

    resend.api_key = settings.resend_api_key

    if frequency == "daily":
        html = _render_daily_report_html(report_data)
        subject = f"📊 BelieveBoy 每日运营报告 · {report_data.get('report_date', '')}"
    elif frequency == "weekly":
        html = _render_weekly_report_html(report_data)
        subject = f"📊 BelieveBoy 每周运营报告 · {report_data.get('report_date', '')}"
    else:
        html = _render_monthly_report_html(report_data)
        subject = f"📊 BelieveBoy {report_data.get('report_month', '')} 月度报告"

    try:
        resp = resend.Emails.send({
            "from": f"{settings.alert_from_name} <{settings.alert_from_email}>",
            "to": [to_email],
            "subject": subject,
            "html": html,
        })
        resend_id: str | None = resp.get("id")
        logger.info(f"Scheduled report email sent to {to_email}, frequency={frequency}, resend_id={resend_id}")
        return True, resend_id
    except Exception as e:
        logger.error(f"Failed to send scheduled report email to {to_email}: {e}")
        return False, str(e)


def send_test_report_email(to_email: str, frequency: str) -> tuple[bool, str | None]:
    """发送测试报告邮件。"""
    report_date = date.today().isoformat()
    report_data = {
        "report_date": report_date,
        "report_month": report_date[:7],
        "country": "US",
        "ai_summary": "这是一封测试邮件，用于验证报告推送配置是否正确。如果收到此邮件，说明配置成功。",
        "sales": {"today_order_qty": 1234, "today_sales_amount": 45678.90, "sales_change_pct": 8.5},
        "inventory": {"sku_count": 456, "available_qty": 7890, "out_of_stock_count": 3},
        "ads": {"period_spend": 234.56, "period_roas": 3.2, "period_acos": 18.5, "period_ctr": 2.1},
        "week_sales": {"total_qty": 8765, "total_amount": 123456.78},
        "week_ads": {"total_spend": 1234.56, "total_sales": 5678.90, "avg_roas": 4.6, "avg_acos": 21.7},
        "top_skus": [
            {"sku": "SKU-A001", "quantity": 234},
            {"sku": "SKU-B002", "quantity": 189},
            {"sku": "SKU-C003", "quantity": 156},
        ],
        "inventory_alerts": [
            {"sku": "SKU-X100", "available_qty": 5},
            {"sku": "SKU-Y200", "available_qty": 3},
        ],
        "financial_summary": {"total_revenue": 1234567.89, "total_cost": 876543.21, "net_profit": 358024.68},
        "project_breakdown": [
            {"name": "项目 A", "revenue": 567890.12, "profit_margin": 28.5},
            {"name": "项目 B", "revenue": 456789.34, "profit_margin": 32.1},
        ],
        "commission_summary": {"total": 67890.12},
    }
    return send_scheduled_report_email(to_email, frequency, report_data)
```

### Success Criteria

#### Automated Verification:
- [ ] `python -c "from app.services.scheduled_report.email_sender import send_test_report_email; print('EmailSender OK')"` passes

#### Manual Verification:
- [ ] 调用 `send_test_report_email("test@example.com", "daily")` 能成功发送（需网络）
- [ ] 邮件 HTML 渲染正常：邮件客户端打开显示完整卡片式布局

---

## Plan History

- Phase 1: 数据模型与数据库迁移 — pending
- Phase 2: API Schema 与订阅服务 — pending
- Phase 3: 邮件发送服务（扩展 Resend）— pending
- Phase 4: 报告数据收集器与 AI 增强 — pending
- Phase 5: 调度器扩展与 API 端点 — pending
- Phase 6: 前端订阅管理页面 — pending