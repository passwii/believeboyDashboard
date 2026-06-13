"""add schema comment to job_runs log_excerpt

Revision ID: 162
Revises: 161
Create Date: 2026-06-14 00:00:00.000000
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = '162'
down_revision: Union[str, None] = '161'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


LOG_EXCERPT_COMMENT = (
    'JSON progress payload emitted by run_job: '
    '{"stage": "...", "progress": 0-100, "message": "...", "task_id": "..."}'
)


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == 'postgresql':
        op.alter_column(
            'job_runs',
            'log_excerpt',
            existing_type=sa.Text(),
            comment=LOG_EXCERPT_COMMENT,
        )


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == 'postgresql':
        op.alter_column('job_runs', 'log_excerpt', existing_type=sa.Text(), comment=None)
