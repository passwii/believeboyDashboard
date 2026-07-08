"""create uploaded_pages

Revision ID: 20260708_205
Revises: 20260707_204
Create Date: 2026-07-08

Markdown/HTML 上传渲染工具（特殊功能）的记录表：UUID 公开 id，存 R2 公开桶的引用。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20260708_205"
down_revision = "20260707_204"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "uploaded_pages",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("owner_user_id", sa.Integer(), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("source_format", sa.String(length=16), nullable=False),
        sa.Column("original_filename", sa.String(length=255), nullable=False),
        sa.Column("content_type", sa.String(length=64), nullable=False),
        sa.Column("file_size", sa.Integer(), nullable=False),
        sa.Column("r2_key", sa.String(length=512), nullable=False),
        sa.Column("public_url", sa.String(length=1024), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("r2_key", name="uq_uploaded_pages_r2_key"),
    )
    op.create_index(
        "ix_uploaded_pages_owner_created",
        "uploaded_pages",
        ["owner_user_id", "created_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_uploaded_pages_owner_created", table_name="uploaded_pages")
    op.drop_table("uploaded_pages")