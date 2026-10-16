"""新增客户方案（方案主表 + 版本表）

Revision ID: 283
Revises: 282

层级：crm_customers → crm_proposals → crm_proposal_versions。
文件不是独立一层——它是版本的载荷（raw_r2_key / adapted_r2_key），
因为输入约束是「单个 HTML」，一个版本恒等于一个文件。
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "283"
down_revision: str | None = "282"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "crm_proposals",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column(
            "proposal_type",
            sa.String(length=32),
            nullable=False,
            server_default="other",
        ),
        sa.Column(
            "status", sa.String(length=20), nullable=False, server_default="draft"
        ),
        sa.Column("customer_id", sa.Integer(), nullable=True),
        sa.Column("owner_id", sa.String(length=36), nullable=True),
        sa.Column(
            "current_version_no", sa.Integer(), nullable=False, server_default="0"
        ),
        sa.Column("created_by", sa.String(length=36), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["customer_id"],
            ["crm_customers.id"],
            name="fk_crm_proposals_customer",
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("idx_cp_customer", "crm_proposals", ["customer_id"])
    op.create_index("idx_cp_owner_status", "crm_proposals", ["owner_id", "status"])
    op.create_index("idx_cp_updated", "crm_proposals", ["updated_at"])

    op.create_table(
        "crm_proposal_versions",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("proposal_id", sa.Integer(), nullable=False),
        sa.Column("version_no", sa.Integer(), nullable=False),
        sa.Column("raw_r2_key", sa.String(length=512), nullable=False),
        sa.Column("adapted_r2_key", sa.String(length=512), nullable=False),
        sa.Column("adapted_sha256", sa.String(length=64), nullable=False),
        sa.Column("original_filename", sa.String(length=255), nullable=False),
        sa.Column("content_type", sa.String(length=64), nullable=False),
        sa.Column("file_size", sa.Integer(), nullable=False),
        sa.Column("change_note", sa.String(length=500), nullable=True),
        sa.Column("created_by", sa.String(length=36), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["proposal_id"],
            ["crm_proposals.id"],
            name="fk_crm_proposal_versions_proposal",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("raw_r2_key", name="uq_cpv_raw_r2_key"),
        sa.UniqueConstraint("adapted_r2_key", name="uq_cpv_adapted_r2_key"),
        sa.UniqueConstraint(
            "proposal_id", "version_no", name="uq_cpv_proposal_version"
        ),
    )
    op.create_index("idx_cpv_proposal", "crm_proposal_versions", ["proposal_id"])


def downgrade() -> None:
    op.drop_index("idx_cpv_proposal", table_name="crm_proposal_versions")
    op.drop_table("crm_proposal_versions")
    op.drop_index("idx_cp_updated", table_name="crm_proposals")
    op.drop_index("idx_cp_owner_status", table_name="crm_proposals")
    op.drop_index("idx_cp_customer", table_name="crm_proposals")
    op.drop_table("crm_proposals")
