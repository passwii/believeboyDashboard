"""add digital_employee tables

Revision ID: a5571a96e542
Revises: 20260422_101
Create Date: 2026-04-23 10:19:25.276912
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a5571a96e542'
down_revision: Union[str, None] = '20260422_101'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('digital_employees',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('name', sa.String(length=128), nullable=False),
        sa.Column('avatar_url', sa.String(length=512), nullable=True),
        sa.Column('employee_type', sa.String(length=32), nullable=False),
        sa.Column('status', sa.String(length=32), nullable=False, server_default='idle'),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('api_secret', sa.String(length=64), nullable=False, unique=True),
        sa.Column('last_heartbeat_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('is_silent_alert_threshold_minutes', sa.Integer(), nullable=False, server_default='30'),
        sa.Column('is_deleted', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('api_secret'),
    )
    op.create_index('idx_de_status', 'digital_employees', ['status'], unique=False)
    op.create_index('idx_de_type', 'digital_employees', ['employee_type'], unique=False)
    op.create_index('idx_de_last_heartbeat', 'digital_employees', ['last_heartbeat_at'], unique=False)
    op.create_index('ix_digital_employees_name', 'digital_employees', ['name'], unique=False)

    op.create_table('digital_employee_tasks',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('employee_id', sa.Integer(), nullable=False),
        sa.Column('task_id', sa.String(length=64), nullable=False, unique=True),
        sa.Column('task_name', sa.String(length=256), nullable=False),
        sa.Column('task_type', sa.String(length=64), nullable=False),
        sa.Column('status', sa.String(length=32), nullable=False, server_default='pending'),
        sa.Column('progress_percent', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('current_step', sa.String(length=256), nullable=True),
        sa.Column('started_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('ended_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('error_message', sa.Text(), nullable=True),
        sa.Column('metadata_json', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['employee_id'], ['digital_employees.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('idx_det_employee_id', 'digital_employee_tasks', ['employee_id'], unique=False)
    op.create_index('idx_det_status', 'digital_employee_tasks', ['status'], unique=False)
    op.create_index('idx_det_started_at', 'digital_employee_tasks', ['started_at'], unique=False)

    op.create_table('digital_employee_logs',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('employee_id', sa.Integer(), nullable=False),
        sa.Column('task_id', sa.Integer(), nullable=True),
        sa.Column('level', sa.String(length=16), nullable=False, server_default='info'),
        sa.Column('message', sa.Text(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['employee_id'], ['digital_employees.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['task_id'], ['digital_employee_tasks.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('idx_del_employee_id', 'digital_employee_logs', ['employee_id'], unique=False)
    op.create_index('idx_del_task_id', 'digital_employee_logs', ['task_id'], unique=False)
    op.create_index('idx_del_created_at', 'digital_employee_logs', ['created_at'], unique=False)


def downgrade() -> None:
    op.drop_table('digital_employee_logs')
    op.drop_table('digital_employee_tasks')
    op.drop_table('digital_employees')
