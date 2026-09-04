"""create user presence table

Revision ID: 20260330_077
Revises: 20260327_076
Create Date: 2026-03-30 13:20:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260330_077"
down_revision: Union[str, None] = "20260327_076"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return

    op.create_table(
        "user_presence",
        sa.Column("user_id", sa.Text(), primary_key=True),
        sa.Column("display_name", sa.Text(), nullable=False),
        sa.Column("email", sa.Text(), nullable=True),
        sa.Column("avatar_url", sa.Text(), nullable=True),
        sa.Column("current_path", sa.String(length=255), nullable=False),
        sa.Column("current_page_title", sa.String(length=255), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )
    op.create_index("idx_user_presence_last_seen_at", "user_presence", ["last_seen_at"])
    op.create_index("idx_user_presence_current_path", "user_presence", ["current_path"])


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return

    op.drop_index("idx_user_presence_current_path", table_name="user_presence")
    op.drop_index("idx_user_presence_last_seen_at", table_name="user_presence")
    op.drop_table("user_presence")
