"""add digital_employee_playback

Revision ID: 790a004efd39
Revises: 20260718_214
Create Date: 2026-07-22 11:46:39.012945
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa



# revision identifiers, used by Alembic.
revision: str = '790a004efd39'
down_revision: Union[str, None] = '20260718_214'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "digital_employee_playback",
        sa.Column("employee_id", sa.Integer(), sa.ForeignKey("digital_employees.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("virtual_index", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("current_task_id", sa.String(length=64), nullable=True),
        sa.Column("virtual_progress", sa.Float(), nullable=False, server_default="0"),
        sa.Column("display_started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("display_duration_s", sa.Float(), nullable=False, server_default="0"),
        sa.Column("pause_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("pace", sa.Float(), nullable=False, server_default="1"),
        sa.Column("busy_level", sa.String(length=16), nullable=False, server_default="IDLE"),
        sa.Column("last_advanced_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("digital_employee_playback")
