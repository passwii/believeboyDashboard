"""add schema comment to job_runs log_excerpt

Revision ID: 164
Revises: 163
Create Date: 2026-06-14 00:00:00.000000

Note: revision was originally '162' (matching the same numeric ID as
`20260614_162_add_ai_conversation_user_id.py`), which produced a
branched alembic graph (two heads with the same ID). Renamed to '164'
and down_revision repointed to '163' (the next migration in the
correct chain, which itself follows '162' ai_conversations) to keep the
migration chain a single linear path as required by CLAUDE.md.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = '164'
down_revision: Union[str, None] = '163'
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
