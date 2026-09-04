"""create jobs and job_runs tables

Revision ID: 20260224_001
Revises:
Create Date: 2026-02-24 00:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = '20260224_001'
down_revision: Union[str, None] = '20260224_000'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    now_default = sa.text('CURRENT_TIMESTAMP') if bind.dialect.name == 'sqlite' else sa.text('now()')
    jobstatus_enum = postgresql.ENUM('pending', 'running', 'success', 'failed', name='jobstatus', create_type=False)
    if bind.dialect.name == 'postgresql':
        # Keep migration idempotent for databases where enum type already exists.
        postgresql.ENUM('pending', 'running', 'success', 'failed', name='jobstatus').create(bind, checkfirst=True)

    if not inspector.has_table('jobs'):
        op.create_table(
            'jobs',
            sa.Column('id', sa.Integer(), nullable=False),
            sa.Column('job_type', sa.String(length=128), nullable=False),
            sa.Column('status', jobstatus_enum, nullable=False),
            sa.Column('payload_json', sa.JSON(), nullable=False),
            sa.Column('created_at', sa.DateTime(timezone=True), server_default=now_default, nullable=False),
            sa.Column('updated_at', sa.DateTime(timezone=True), server_default=now_default, nullable=False),
            sa.PrimaryKeyConstraint('id'),
        )
    op.execute('create index if not exists ix_jobs_job_type on jobs (job_type)')
    op.execute('create index if not exists ix_jobs_status on jobs (status)')

    if not inspector.has_table('job_runs'):
        op.create_table(
            'job_runs',
            sa.Column('id', sa.Integer(), nullable=False),
            sa.Column('job_id', sa.Integer(), nullable=False),
            sa.Column('started_at', sa.DateTime(timezone=True), server_default=now_default, nullable=False),
            sa.Column('finished_at', sa.DateTime(timezone=True), nullable=True),
            sa.Column('log_excerpt', sa.Text(), nullable=True),
            sa.Column('error_message', sa.Text(), nullable=True),
            sa.Column('result_path', sa.String(length=1024), nullable=True),
            sa.ForeignKeyConstraint(['job_id'], ['jobs.id'], ondelete='CASCADE'),
            sa.PrimaryKeyConstraint('id'),
        )
    op.execute('create index if not exists ix_job_runs_job_id on job_runs (job_id)')


def downgrade() -> None:
    op.execute('drop index if exists ix_job_runs_job_id')
    op.execute('drop table if exists job_runs')
    op.execute('drop index if exists ix_jobs_status')
    op.execute('drop index if exists ix_jobs_job_type')
    op.execute('drop table if exists jobs')
    op.execute('drop type if exists jobstatus')
