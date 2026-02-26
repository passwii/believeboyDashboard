"""add operator fields to jobs and job_runs

Revision ID: 20260226_005
Revises: 20260226_004
Create Date: 2026-02-26 00:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260226_005'
down_revision: Union[str, None] = '20260226_004'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if inspector.has_table('jobs'):
        job_columns = {column['name'] for column in inspector.get_columns('jobs')}
        if 'operator' not in job_columns:
            op.add_column('jobs', sa.Column('operator', sa.String(length=255), nullable=True))

    if inspector.has_table('job_runs'):
        run_columns = {column['name'] for column in inspector.get_columns('job_runs')}
        if 'operator' not in run_columns:
            op.add_column('job_runs', sa.Column('operator', sa.String(length=255), nullable=True))

    if inspector.has_table('jobs') and inspector.has_table('job_runs'):
        op.execute(
            """
            update job_runs
            set operator = (
                select jobs.operator
                from jobs
                where jobs.id = job_runs.job_id
            )
            where operator is null
            """
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if inspector.has_table('job_runs'):
        run_columns = {column['name'] for column in inspector.get_columns('job_runs')}
        if 'operator' in run_columns:
            op.drop_column('job_runs', 'operator')

    if inspector.has_table('jobs'):
        job_columns = {column['name'] for column in inspector.get_columns('jobs')}
        if 'operator' in job_columns:
            op.drop_column('jobs', 'operator')
