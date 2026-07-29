"""新建 notifications 站内通知表

Revision ID: 224
Revises: 223
Create Date: 2026-07-29 10:02:00.741231

注：user_id 为 Integer 不带 FK，与 P1 alert_preference.user_id（迁移 122）对齐。
    user_accounts.id 是 UUID，加 FK 会类型不兼容。
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "224"
down_revision: Union[str, None] = "223"
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
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("idx_notif_user_read", "notifications", ["user_id", "read"])
    op.create_index(
        "idx_notif_user_created", "notifications", ["user_id", "created_at"]
    )
    op.create_index(op.f("ix_notifications_user_id"), "notifications", ["user_id"])


def downgrade() -> None:
    op.drop_index(op.f("ix_notifications_user_id"), table_name="notifications")
    op.drop_index("idx_notif_user_created", table_name="notifications")
    op.drop_index("idx_notif_user_read", table_name="notifications")
    op.drop_table("notifications")
