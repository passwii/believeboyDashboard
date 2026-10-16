# 阶段 B1：数据模型与迁移

> 父计划：[阶段 B 总览](./2026-10-16-amazon-review-tracking-phase-b.md) · 设计：[B 规格](../../specs/2026-10-16-amazon-review-tracking-phase-b-design.md) §2
> 前置：无（本册最先做）。产出新表 5 张 + 迁移 `282` + 内部目标同步。

**Files（本册涉及）：**
- Modify: `backend/app/models/amazon_review_tracking.py`（追加 5 个模型）
- Modify: `backend/app/models/__init__.py`（注册）
- Create: `backend/alembic/versions/20261016_282_amazon_review_targets.py`
- Modify: `backend/app/services/amazon_review_tracking_service.py`（目标同步）
- Test: `backend/tests/services/test_amazon_review_targets_model.py`（新建）
- Test: `backend/tests/services/test_amazon_review_tracking_service.py`（追加目标同步用例）

---

## Task 1：5 张表模型 + 迁移 `282`

- [ ] **步骤 1：写失败测试（模型元数据与约束）**

创建 `backend/tests/services/test_amazon_review_targets_model.py`：

```python
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.models import Project, SkuRecord
from app.models.amazon_review_tracking import (
    AmazonReviewCrawlRun,
    AmazonReviewExternalLink,
    AmazonReviewRatingSnapshot,
    AmazonReviewReview,
    AmazonReviewTarget,
)
from app.services.amazon_review_tracking_service import create_group


@pytest.fixture
def internal_target(db_session):
    project = db_session.execute(select(Project).where(Project.is_active.is_(True)).limit(1)).scalar_one()
    sku = SkuRecord(
        project_id=project.id, project_name=project.project_name,
        sku=f"target-model-{uuid.uuid4().hex[:8]}", asin=f"B0{uuid.uuid4().hex[:8].upper()}",
        country="US", fob_unit_cost=0, sort_order=910000, is_active=True,
    )
    db_session.add(sku)
    db_session.flush()
    group = create_group(db_session, project_id=project.id, marketplace="US", name=f"G-{uuid.uuid4().hex[:6]}",
        member_ids=[sku.id], representative_id=sku.id)
    db_session.flush()
    target = AmazonReviewTarget(kind="internal_group", group_id=group.id, project_id=project.id,
                                marketplace="US", asin=sku.asin, is_active=True)
    db_session.add(target)
    db_session.flush()
    return target


def test_internal_target_shape_and_unique_group(db_session, internal_target):
    assert internal_target.kind == "internal_group"
    assert internal_target.group_id is not None and internal_target.project_id is not None
    assert internal_target.marketplace == "US" and internal_target.asin is not None
    other = AmazonReviewTarget(
        kind="internal_group", group_id=internal_target.group_id,
        project_id=internal_target.project_id, marketplace="US", asin="B0DUP",
    )
    db_session.add(other)
    with pytest.raises(IntegrityError):
        db_session.flush()
    db_session.rollback()


def test_external_target_requires_asin_and_unique_marketplace_asin(db_session):
    t1 = AmazonReviewTarget(kind="external_asin", marketplace="US", asin="B0EXT00001", is_active=True)
    db_session.add(t1)
    db_session.flush()
    dup = AmazonReviewTarget(kind="external_asin", marketplace="US", asin="B0EXT00001", is_active=True)
    db_session.add(dup)
    with pytest.raises(IntegrityError):
        db_session.flush()
    db_session.rollback()


def test_snapshot_unique_per_target_and_capture_date(db_session, internal_target):
    from datetime import date, datetime, timezone

    snap = AmazonReviewRatingSnapshot(
        target_id=internal_target.id, capture_date=date(2026, 10, 16),
        captured_at=datetime.now(timezone.utc), average_rating=2.6, rating_count=7,
        capture_status="success", star_count_quality="estimated",
    )
    db_session.add(snap)
    db_session.flush()
    dup = AmazonReviewRatingSnapshot(
        target_id=internal_target.id, capture_date=date(2026, 10, 16),
        captured_at=datetime.now(timezone.utc), capture_status="partial",
    )
    db_session.add(dup)
    with pytest.raises(IntegrityError):
        db_session.flush()
    db_session.rollback()


def test_review_and_run_and_link_uniqueness(db_session, internal_target):
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc)
    db_session.add(AmazonReviewReview(
        target_id=internal_target.id, review_key="R1", id_confidence="original",
        first_seen_at=now, last_seen_at=now,
    ))
    db_session.flush()
    db_session.add(AmazonReviewReview(
        target_id=internal_target.id, review_key="R1", id_confidence="original",
        first_seen_at=now, last_seen_at=now,
    ))
    with pytest.raises(IntegrityError):
        db_session.flush()
    db_session.rollback()
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd backend && pytest tests/services/test_amazon_review_targets_model.py -q`
预期：FAIL——`ImportError: cannot import name 'AmazonReviewTarget'`。

- [ ] **步骤 3：实现模型**

修改 `backend/app/models/amazon_review_tracking.py`：顶部改为 `from datetime import date, datetime`，sqlalchemy 导入补充 `CheckConstraint, Date, JSON, Numeric`，并新增 `from decimal import Decimal`；末尾追加 5 个模型：

```python
class AmazonReviewTarget(Base):
    __tablename__ = "amazon_review_targets"
    __table_args__ = (
        CheckConstraint("kind IN ('internal_group', 'external_asin')", name="ck_amazon_review_targets_kind"),
        CheckConstraint(
            "(kind = 'internal_group' AND group_id IS NOT NULL AND project_id IS NOT NULL) OR "
            "(kind = 'external_asin' AND group_id IS NULL AND project_id IS NULL AND asin IS NOT NULL)",
            name="ck_amazon_review_targets_shape",
        ),
        UniqueConstraint("group_id", name="uq_amazon_review_targets_group"),
        Index("idx_amazon_review_targets_kind_active", "kind", "is_active"),
        Index(
            "uq_amazon_review_targets_external_key", "marketplace", "asin",
            unique=True,
            postgresql_where=text("kind = 'external_asin'"),
            sqlite_where=text("kind = 'external_asin'"),
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    group_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("amazon_review_groups.id", ondelete="RESTRICT"), nullable=True
    )
    project_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("projects.id", ondelete="RESTRICT"), nullable=True
    )
    marketplace: Mapped[str] = mapped_column(String(2), nullable=False)
    asin: Mapped[str | None] = mapped_column(String(20), nullable=True)
    display_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class AmazonReviewRatingSnapshot(Base):
    __tablename__ = "amazon_review_rating_snapshots"
    __table_args__ = (
        UniqueConstraint("target_id", "capture_date", name="uq_amazon_review_rating_snapshots_target_date"),
        Index("idx_amazon_review_rating_snapshots_target_date", "target_id", "capture_date"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    target_id: Mapped[int] = mapped_column(Integer, ForeignKey("amazon_review_targets.id", ondelete="RESTRICT"), nullable=False)
    capture_date: Mapped[date] = mapped_column(Date, nullable=False)
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    average_rating: Mapped[Decimal | None] = mapped_column(Numeric(3, 2), nullable=True)
    rating_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    review_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    star_1_percentage: Mapped[Decimal | None] = mapped_column(Numeric(5, 2), nullable=True)
    star_2_percentage: Mapped[Decimal | None] = mapped_column(Numeric(5, 2), nullable=True)
    star_3_percentage: Mapped[Decimal | None] = mapped_column(Numeric(5, 2), nullable=True)
    star_4_percentage: Mapped[Decimal | None] = mapped_column(Numeric(5, 2), nullable=True)
    star_5_percentage: Mapped[Decimal | None] = mapped_column(Numeric(5, 2), nullable=True)
    star_1_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    star_2_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    star_3_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    star_4_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    star_5_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    star_count_quality: Mapped[str] = mapped_column(String(12), nullable=False, server_default="unavailable")
    capture_status: Mapped[str] = mapped_column(String(16), nullable=False)
    source: Mapped[str | None] = mapped_column(String(64), nullable=True)
    raw_payload: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class AmazonReviewReview(Base):
    __tablename__ = "amazon_review_reviews"
    __table_args__ = (
        UniqueConstraint("target_id", "review_key", name="uq_amazon_review_reviews_target_key"),
        Index("idx_amazon_review_reviews_target_visibility", "target_id", "visibility_status"),
        Index("idx_amazon_review_reviews_target_date", "target_id", "review_date"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    target_id: Mapped[int] = mapped_column(Integer, ForeignKey("amazon_review_targets.id", ondelete="RESTRICT"), nullable=False)
    review_key: Mapped[str] = mapped_column(String(255), nullable=False)
    id_confidence: Mapped[str] = mapped_column(String(16), nullable=False)
    reviewer_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    reviewer_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    rating: Mapped[int | None] = mapped_column(Integer, nullable=True)
    title: Mapped[str | None] = mapped_column(String(512), nullable=True)
    body: Mapped[str | None] = mapped_column(Text, nullable=True)
    review_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    verified_purchase: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    helpful_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    first_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    visibility_status: Mapped[str] = mapped_column(String(20), nullable=False, server_default="visible")
    missing_streak: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    raw_payload: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class AmazonReviewCrawlRun(Base):
    __tablename__ = "amazon_review_crawl_runs"
    __table_args__ = (
        UniqueConstraint("target_id", "idempotency_key", name="uq_amazon_review_crawl_runs_target_idem"),
        Index("idx_amazon_review_crawl_runs_target_started", "target_id", "started_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    target_id: Mapped[int] = mapped_column(Integer, ForeignKey("amazon_review_targets.id", ondelete="RESTRICT"), nullable=False)
    idempotency_key: Mapped[str | None] = mapped_column(String(128), nullable=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    is_complete_list: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    reviews_seen: Mapped[int | None] = mapped_column(Integer, nullable=True)
    ratings_captured: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    asin_scraped: Mapped[str | None] = mapped_column(String(20), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class AmazonReviewExternalLink(Base):
    __tablename__ = "amazon_review_external_links"
    __table_args__ = (
        UniqueConstraint("target_id", "shop_id", name="uq_amazon_review_external_links_target_shop"),
        Index("idx_amazon_review_external_links_target_active", "target_id", "is_active"),
        Index("idx_amazon_review_external_links_shop", "shop_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    target_id: Mapped[int] = mapped_column(Integer, ForeignKey("amazon_review_targets.id", ondelete="RESTRICT"), nullable=False)
    shop_id: Mapped[int] = mapped_column(Integer, ForeignKey("project_shops.id", ondelete="RESTRICT"), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")
    added_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    removed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
```

修改 `backend/app/models/__init__.py`：从 `app.models.amazon_review_tracking` 一并导入 5 个新类，并加入 `__all__`：

```python
from app.models.amazon_review_tracking import (
    AmazonReviewGroup,
    AmazonReviewGroupMember,
    AmazonReviewTarget,
    AmazonReviewRatingSnapshot,
    AmazonReviewReview,
    AmazonReviewCrawlRun,
    AmazonReviewExternalLink,
)
```

- [ ] **步骤 4：运行测试确认通过**

运行：`cd backend && pytest tests/services/test_amazon_review_targets_model.py -q`
预期：PASS（若步骤 1 的 `internal_target` 依赖 Task 2 的目标同步，会 FAIL → 先完成 Task 2 再回跑本步；两个任务可合并 commit）。

- [ ] **步骤 5：写迁移 `282`**

创建 `backend/alembic/versions/20261016_282_amazon_review_targets.py`：

```python
"""新增 Amazon 评论追踪目标、评分快照、评论、运行记录与外部关联表

Revision ID: 282
Revises: 281
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "282"
down_revision: Union[str, None] = "281"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "amazon_review_targets",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("kind", sa.String(length=20), nullable=False),
        sa.Column("group_id", sa.Integer(), nullable=True),
        sa.Column("project_id", sa.BigInteger(), nullable=True),
        sa.Column("marketplace", sa.String(length=2), nullable=False),
        sa.Column("asin", sa.String(length=20), nullable=True),
        sa.Column("display_name", sa.String(length=255), nullable=True),
        sa.Column("is_active", sa.Boolean(), server_default=sa.true(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("kind IN ('internal_group', 'external_asin')", name="ck_amazon_review_targets_kind"),
        sa.CheckConstraint(
            "(kind = 'internal_group' AND group_id IS NOT NULL AND project_id IS NOT NULL) OR "
            "(kind = 'external_asin' AND group_id IS NULL AND project_id IS NULL AND asin IS NOT NULL)",
            name="ck_amazon_review_targets_shape",
        ),
        sa.ForeignKeyConstraint(["group_id"], ["amazon_review_groups.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("group_id", name="uq_amazon_review_targets_group"),
    )
    op.create_index("idx_amazon_review_targets_kind_active", "amazon_review_targets", ["kind", "is_active"])
    op.create_index(
        "uq_amazon_review_targets_external_key", "amazon_review_targets", ["marketplace", "asin"],
        unique=True, postgresql_where=sa.text("kind = 'external_asin'"),
        sqlite_where=sa.text("kind = 'external_asin'"),
    )
    op.execute(
        """
        INSERT INTO amazon_review_targets
            (kind, group_id, project_id, marketplace, asin, display_name, is_active, created_at, updated_at)
        SELECT 'internal_group', g.id, g.project_id, g.marketplace, pc.asin, g.name, g.is_active, now(), now()
        FROM amazon_review_groups g
        LEFT JOIN product_costs pc ON pc.id = g.representative_sku_record_id
        WHERE NOT EXISTS (SELECT 1 FROM amazon_review_targets t WHERE t.group_id = g.id)
        """
    )
    op.create_table(
        "amazon_review_rating_snapshots",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("target_id", sa.Integer(), nullable=False),
        sa.Column("capture_date", sa.Date(), nullable=False),
        sa.Column("captured_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("average_rating", sa.Numeric(precision=3, scale=2), nullable=True),
        sa.Column("rating_count", sa.Integer(), nullable=True),
        sa.Column("review_count", sa.Integer(), nullable=True),
        sa.Column("star_1_percentage", sa.Numeric(precision=5, scale=2), nullable=True),
        sa.Column("star_2_percentage", sa.Numeric(precision=5, scale=2), nullable=True),
        sa.Column("star_3_percentage", sa.Numeric(precision=5, scale=2), nullable=True),
        sa.Column("star_4_percentage", sa.Numeric(precision=5, scale=2), nullable=True),
        sa.Column("star_5_percentage", sa.Numeric(precision=5, scale=2), nullable=True),
        sa.Column("star_1_count", sa.Integer(), nullable=True),
        sa.Column("star_2_count", sa.Integer(), nullable=True),
        sa.Column("star_3_count", sa.Integer(), nullable=True),
        sa.Column("star_4_count", sa.Integer(), nullable=True),
        sa.Column("star_5_count", sa.Integer(), nullable=True),
        sa.Column("star_count_quality", sa.String(length=12), server_default="unavailable", nullable=False),
        sa.Column("capture_status", sa.String(length=16), nullable=False),
        sa.Column("source", sa.String(length=64), nullable=True),
        sa.Column("raw_payload", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["target_id"], ["amazon_review_targets.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("target_id", "capture_date", name="uq_amazon_review_rating_snapshots_target_date"),
    )
    op.create_index("idx_amazon_review_rating_snapshots_target_date", "amazon_review_rating_snapshots", ["target_id", "capture_date"])
    op.create_table(
        "amazon_review_reviews",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("target_id", sa.Integer(), nullable=False),
        sa.Column("review_key", sa.String(length=255), nullable=False),
        sa.Column("id_confidence", sa.String(length=16), nullable=False),
        sa.Column("reviewer_id", sa.String(length=128), nullable=True),
        sa.Column("reviewer_name", sa.String(length=255), nullable=True),
        sa.Column("rating", sa.Integer(), nullable=True),
        sa.Column("title", sa.String(length=512), nullable=True),
        sa.Column("body", sa.Text(), nullable=True),
        sa.Column("review_date", sa.Date(), nullable=True),
        sa.Column("verified_purchase", sa.Boolean(), nullable=True),
        sa.Column("helpful_count", sa.Integer(), nullable=True),
        sa.Column("first_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("visibility_status", sa.String(length=20), server_default="visible", nullable=False),
        sa.Column("missing_streak", sa.Integer(), server_default="0", nullable=False),
        sa.Column("raw_payload", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["target_id"], ["amazon_review_targets.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("target_id", "review_key", name="uq_amazon_review_reviews_target_key"),
    )
    op.create_index("idx_amazon_review_reviews_target_visibility", "amazon_review_reviews", ["target_id", "visibility_status"])
    op.create_index("idx_amazon_review_reviews_target_date", "amazon_review_reviews", ["target_id", "review_date"])
    op.create_table(
        "amazon_review_crawl_runs",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("target_id", sa.Integer(), nullable=False),
        sa.Column("idempotency_key", sa.String(length=128), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("is_complete_list", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("reviews_seen", sa.Integer(), nullable=True),
        sa.Column("ratings_captured", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("asin_scraped", sa.String(length=20), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["target_id"], ["amazon_review_targets.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("target_id", "idempotency_key", name="uq_amazon_review_crawl_runs_target_idem"),
    )
    op.create_index("idx_amazon_review_crawl_runs_target_started", "amazon_review_crawl_runs", ["target_id", "started_at"])
    op.create_table(
        "amazon_review_external_links",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("target_id", sa.Integer(), nullable=False),
        sa.Column("shop_id", sa.Integer(), nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default=sa.true(), nullable=False),
        sa.Column("added_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("removed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["target_id"], ["amazon_review_targets.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["shop_id"], ["project_shops.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("target_id", "shop_id", name="uq_amazon_review_external_links_target_shop"),
    )
    op.create_index("idx_amazon_review_external_links_target_active", "amazon_review_external_links", ["target_id", "is_active"])
    op.create_index("idx_amazon_review_external_links_shop", "amazon_review_external_links", ["shop_id"])


def downgrade() -> None:
    op.drop_index("idx_amazon_review_external_links_shop", table_name="amazon_review_external_links")
    op.drop_index("idx_amazon_review_external_links_target_active", table_name="amazon_review_external_links")
    op.drop_table("amazon_review_external_links")
    op.drop_index("idx_amazon_review_crawl_runs_target_started", table_name="amazon_review_crawl_runs")
    op.drop_table("amazon_review_crawl_runs")
    op.drop_index("idx_amazon_review_reviews_target_date", table_name="amazon_review_reviews")
    op.drop_index("idx_amazon_review_reviews_target_visibility", table_name="amazon_review_reviews")
    op.drop_table("amazon_review_reviews")
    op.drop_index("idx_amazon_review_rating_snapshots_target_date", table_name="amazon_review_rating_snapshots")
    op.drop_table("amazon_review_rating_snapshots")
    op.drop_index("uq_amazon_review_targets_external_key", table_name="amazon_review_targets")
    op.drop_index("idx_amazon_review_targets_kind_active", table_name="amazon_review_targets")
    op.drop_table("amazon_review_targets")
```

- [ ] **步骤 6：迁移检查 + 往返**

```bash
cd backend && python scripts/check_alembic.py
```
预期：`✓ Alembic 迁移图检查通过（单 head、命名合规、无重复 / 孤儿）`。

```bash
cd backend
export TEST_DATABASE_URL='postgresql+psycopg://damon@/BLF_test?host=/tmp'
VENV=/Users/damon/DamonProjects/believeboyDashboard/backend/.venv/bin/python
$VENV -m alembic upgrade head
$VENV -m alembic downgrade -1
$VENV -m alembic upgrade head
```
预期：`BLF_test` 上 upgrade/downgrade 往返成功（downgrade 删除 5 张表；不触碰 `BLF`）。

> 步骤 4 依赖 Task 2 的目标同步已实现；若先只完成 Task 1，请先完成 Task 2 再回跑步骤 4，二者可合并 commit。

- [ ] **步骤 7：commit**

```bash
git add backend/app/models/amazon_review_tracking.py backend/app/models/__init__.py \
        backend/alembic/versions/20261016_282_amazon_review_targets.py \
        backend/tests/services/test_amazon_review_targets_model.py
git commit -m "feat(评论追踪): 新增评论追踪目标与快照数据模型"
```

---

## Task 2：内部目标与阶段 A 组同步

- [ ] **步骤 1：写失败测试（追加到既服务测试文件）**

在 `backend/tests/services/test_amazon_review_tracking_service.py` 末尾追加：

```python
def test_group_lifecycle_syncs_internal_target(db_session, data):
    from app.models.amazon_review_tracking import AmazonReviewTarget

    project, (one, two, _) = data
    group = create_group(db_session, project_id=project.id, marketplace="US", name="Sync",
        member_ids=[one.id, two.id], representative_id=one.id)
    db_session.flush()
    target = db_session.execute(
        select(AmazonReviewTarget).where(AmazonReviewTarget.group_id == group.id)
    ).scalar_one()
    assert target.kind == "internal_group" and target.is_active is True
    assert target.project_id == project.id and target.marketplace == "US"
    assert target.asin == one.asin

    set_representative(db_session, group_id=group.id, sku_record_id=two.id)
    db_session.flush()
    db_session.refresh(target)
    assert target.asin == two.asin

    deactivate_group(db_session, group_id=group.id)
    db_session.flush()
    db_session.refresh(target)
    assert target.is_active is False


def test_group_rename_syncs_target_display_name(db_session, data):
    from app.models.amazon_review_tracking import AmazonReviewTarget
    from app.services.amazon_review_tracking_service import update_group_name

    project, (one, _, _) = data
    group = create_group(db_session, project_id=project.id, marketplace="US", name="Before",
        member_ids=[one.id], representative_id=one.id)
    db_session.flush()
    update_group_name(db_session, group_id=group.id, name="After")
    db_session.flush()
    target = db_session.execute(
        select(AmazonReviewTarget).where(AmazonReviewTarget.group_id == group.id)
    ).scalar_one()
    assert target.display_name == "After"
```

- [ ] **步骤 2：运行确认失败**

运行：`cd backend && pytest tests/services/test_amazon_review_tracking_service.py -q -k "sync or rename"`
预期：FAIL——`sqlalchemy.exc.NoResultFound`（无 target 行）。

- [ ] **步骤 3：实现同步**

在 `backend/app/services/amazon_review_tracking_service.py`：

- **导入新模型**：`from app.models.amazon_review_tracking import AmazonReviewGroup, AmazonReviewGroupMember, AmazonReviewTarget`。
- **新增 helper**：

```python
def _sync_internal_target(db: Session, group: AmazonReviewGroup, *, representative_asin: str | None) -> AmazonReviewTarget:
    target = db.execute(
        select(AmazonReviewTarget).where(AmazonReviewTarget.group_id == group.id)
    ).scalar_one_or_none()
    if target is None:
        target = AmazonReviewTarget(
            kind="internal_group", group_id=group.id, project_id=group.project_id,
            marketplace=group.marketplace, asin=representative_asin,
            display_name=group.name, is_active=group.is_active,
        )
        db.add(target)
    else:
        target.asin = representative_asin
        target.display_name = group.name
        target.is_active = group.is_active
    db.flush()
    return target
```

- **`create_group`**：末尾（`return group` 前）加：

```python
    representative = db.get(SkuRecord, representative_id)
    _sync_internal_target(db, group, representative_asin=representative.asin if representative else None)
```

- **`set_representative`**：末尾（`return group` 前）加：

```python
    _sync_internal_target(db, group, representative_asin=sku.asin)
```

- **`update_group_name`**：末尾（`return group` 前）加：

```python
    _sync_internal_target(db, group, representative_asin=(db.get(SkuRecord, group.representative_sku_record_id).asin if group.representative_sku_record_id else None))
```

- **`deactivate_group`**：末尾（`return group` 前）加：

```python
    _sync_internal_target(db, group, representative_asin=(db.get(SkuRecord, group.representative_sku_record_id).asin if group.representative_sku_record_id else None))
```

> 回填既有组由迁移 `282` 的 `INSERT ... SELECT` 完成（Task 1 步骤 5）。

- [ ] **步骤 4：运行确认通过**

运行：`cd backend && pytest tests/services/test_amazon_review_tracking_service.py tests/services/test_amazon_review_targets_model.py -q`
预期：全部 PASS。

- [ ] **步骤 5：commit**

```bash
git add backend/app/services/amazon_review_tracking_service.py backend/tests/services/test_amazon_review_tracking_service.py
git commit -m "feat(评论追踪): 组生命周期同步内部评论目标"
```
