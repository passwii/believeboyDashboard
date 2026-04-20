"""Add password_changed_at to user_accounts.

Revision ID: 20260419_097
Revises: 20260416_096
Create Date: 2026-04-19 00:00:00.000000
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260419_097"
down_revision = "20260416_096"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Add column with a server-side default of now() for new rows
    op.add_column(
        "user_accounts",
        sa.Column(
            "password_changed_at",
            sa.TIMESTAMP(timezone=True),
            nullable=True,
            server_default=sa.text("now()"),
            comment="Set to NOW() whenever the user changes their password.",
        ),
    )
    # Backfill existing users so all existing sessions remain valid
    op.execute(
        "UPDATE public.user_accounts "
        "SET password_changed_at = created_at "
        "WHERE password_changed_at IS NULL"
    )
    # Make non-nullable after backfill
    op.alter_column("user_accounts", "password_changed_at", nullable=False)


def downgrade() -> None:
    op.drop_column("user_accounts", "password_changed_at")
