"""Add backup_records table for tracking PostgreSQL backup history.

Revision ID: 135
Revises: 134
Create Date: 2026-05-22 14:00:00

"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSON, TIMESTAMP, BIGINT


# revision identifiers, used by Alembic.
revision: str = "135"
down_revision: str | None = "134"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.create_table(
        'backup_records',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('backup_type', sa.String(20), nullable=False),
        sa.Column('status', sa.String(20), nullable=False),
        sa.Column('started_at', TIMESTAMP(timezone=True), nullable=False),
        sa.Column('completed_at', TIMESTAMP(timezone=True), nullable=True),
        sa.Column('size_bytes', BIGINT(), nullable=True),
        sa.Column('duration_seconds', sa.Integer(), nullable=True),
        sa.Column('error_message', sa.Text(), nullable=True),
        sa.Column('backup_info', sa.Text(), nullable=True),
        sa.Column('created_by', sa.Integer(), nullable=True),
        sa.Column('created_at', TIMESTAMP(timezone=True), nullable=False, server_default=sa.text('now()')),
        sa.Index('idx_br_status', 'status'),
        sa.Index('idx_br_created', 'created_at'),
        sa.Index('idx_br_type', 'backup_type'),
    )


def downgrade() -> None:
    op.drop_table('backup_records')