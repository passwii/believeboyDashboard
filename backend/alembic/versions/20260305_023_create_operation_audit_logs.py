"""create operation audit logs table

Revision ID: 20260305_023
Revises: 20260303_022
Create Date: 2026-03-05 13:50:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260305_023'
down_revision: Union[str, None] = '20260303_022'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_table(inspector: sa.Inspector, table_name: str) -> bool:
    return table_name in inspector.get_table_names()


def _has_index(inspector: sa.Inspector, table_name: str, index_name: str) -> bool:
    return any(idx.get('name') == index_name for idx in inspector.get_indexes(table_name))


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if _has_table(inspector, 'operation_audit_logs') is False:
        op.create_table(
            'operation_audit_logs',
            sa.Column('id', sa.BigInteger().with_variant(sa.Integer(), 'sqlite'), primary_key=True, autoincrement=True),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column('operator', sa.String(length=255), nullable=True),
            sa.Column('action', sa.String(length=128), nullable=False),
            sa.Column('target_type', sa.String(length=64), nullable=False),
            sa.Column('target_id', sa.String(length=128), nullable=True),
            sa.Column('result', sa.String(length=16), nullable=False, server_default='success'),
            sa.Column('trace_id', sa.String(length=64), nullable=True),
            sa.Column('request_method', sa.String(length=16), nullable=True),
            sa.Column('request_path', sa.String(length=255), nullable=True),
            sa.Column('ip_address', sa.String(length=64), nullable=True),
            sa.Column('user_agent', sa.String(length=512), nullable=True),
            sa.Column('before_json', sa.JSON(), nullable=True),
            sa.Column('after_json', sa.JSON(), nullable=True),
            sa.Column('error_message', sa.Text(), nullable=True),
        )

    inspector = sa.inspect(bind)
    if _has_index(inspector, 'operation_audit_logs', 'idx_operation_audit_logs_created_at') is False:
        op.create_index('idx_operation_audit_logs_created_at', 'operation_audit_logs', ['created_at'], unique=False)

    inspector = sa.inspect(bind)
    if _has_index(inspector, 'operation_audit_logs', 'idx_operation_audit_logs_operator_created_at') is False:
        op.create_index(
            'idx_operation_audit_logs_operator_created_at',
            'operation_audit_logs',
            ['operator', 'created_at'],
            unique=False,
        )

    inspector = sa.inspect(bind)
    if _has_index(inspector, 'operation_audit_logs', 'idx_operation_audit_logs_target') is False:
        op.create_index(
            'idx_operation_audit_logs_target',
            'operation_audit_logs',
            ['target_type', 'target_id'],
            unique=False,
        )

    inspector = sa.inspect(bind)
    if _has_index(inspector, 'operation_audit_logs', 'idx_operation_audit_logs_trace_id') is False:
        op.create_index('idx_operation_audit_logs_trace_id', 'operation_audit_logs', ['trace_id'], unique=False)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if _has_table(inspector, 'operation_audit_logs') is False:
        return

    if _has_index(inspector, 'operation_audit_logs', 'idx_operation_audit_logs_trace_id'):
        op.drop_index('idx_operation_audit_logs_trace_id', table_name='operation_audit_logs')

    inspector = sa.inspect(bind)
    if _has_index(inspector, 'operation_audit_logs', 'idx_operation_audit_logs_target'):
        op.drop_index('idx_operation_audit_logs_target', table_name='operation_audit_logs')

    inspector = sa.inspect(bind)
    if _has_index(inspector, 'operation_audit_logs', 'idx_operation_audit_logs_operator_created_at'):
        op.drop_index('idx_operation_audit_logs_operator_created_at', table_name='operation_audit_logs')

    inspector = sa.inspect(bind)
    if _has_index(inspector, 'operation_audit_logs', 'idx_operation_audit_logs_created_at'):
        op.drop_index('idx_operation_audit_logs_created_at', table_name='operation_audit_logs')

    op.drop_table('operation_audit_logs')
