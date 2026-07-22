"""add crm tables (customer/contact/lead/opportunity/follow)

Revision ID: 215
Revises: 20260718_214
Create Date: 2026-07-22 00:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "215"
down_revision: Union[str, None] = "20260718_214"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _pk() -> sa.Column:
    # 与模型 (app/models/crm.py) 及屋风 (alert_rule.py) 保持一致：Integer 主键。
    # 勿用 BigInteger —— 会与模型 id: Mapped[int] = mapped_column(Integer) 及 Integer 外键不一致。
    return sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True)


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
