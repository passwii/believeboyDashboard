"""客诉中心三张表 complaint_runs / shop_checks / complaints（BLF-981）

Revision ID: 263
Revises: 262
Create Date: 2026-09-05 01:44:12.721176
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '263'
down_revision: Union[str, None] = '262'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── complaint_runs ──────────────────────────────────────────────
    op.create_table(
        'complaint_runs',
        sa.Column('id', sa.BigInteger().with_variant(sa.Integer(), 'sqlite'), primary_key=True, autoincrement=True),
        sa.Column('run_date', sa.Date(), nullable=False),
        sa.Column('trigger', sa.String(length=16), nullable=False, server_default='autopilot'),
        sa.Column('shops_total', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('shops_checked', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('shops_failed', sa.JSON(), nullable=False, server_default='[]'),
        sa.Column('summary', sa.JSON(), nullable=False, server_default='{}'),
        sa.Column('agent_id', sa.String(length=64), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now(), onupdate=sa.func.now()),
    )
    op.create_unique_constraint('uq_complaint_runs_run_date', 'complaint_runs', ['run_date'])
    op.create_index('idx_complaint_runs_run_date', 'complaint_runs', ['run_date'])

    # ── shop_checks ─────────────────────────────────────────────────
    op.create_table(
        'shop_checks',
        sa.Column('id', sa.BigInteger().with_variant(sa.Integer(), 'sqlite'), primary_key=True, autoincrement=True),
        sa.Column('run_id', sa.BigInteger(), nullable=False),
        sa.Column('shop_id', sa.String(length=64), nullable=False),
        sa.Column('shop_name', sa.String(length=128), nullable=False),
        sa.Column('site', sa.String(length=2), nullable=False, server_default='US'),
        sa.Column('seller_identity', sa.String(length=128), nullable=True),
        sa.Column('check_status', sa.String(length=16), nullable=False, server_default='ok'),
        sa.Column('error_message', sa.Text(), nullable=True),
        sa.Column('metrics', sa.JSON(), nullable=False, server_default='{}'),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now(), onupdate=sa.func.now()),
    )
    op.create_foreign_key('fk_shop_checks_run_id', 'shop_checks', 'complaint_runs', ['run_id'], ['id'], ondelete='CASCADE')
    op.create_unique_constraint('uq_shop_checks_run_shop', 'shop_checks', ['run_id', 'shop_id'])
    op.create_index('idx_shop_checks_run_id', 'shop_checks', ['run_id'])
    op.create_index('idx_shop_checks_shop_id', 'shop_checks', ['shop_id'])

    # ── complaints ──────────────────────────────────────────────────
    op.create_table(
        'complaints',
        sa.Column('id', sa.BigInteger().with_variant(sa.Integer(), 'sqlite'), primary_key=True, autoincrement=True),
        sa.Column('run_id', sa.BigInteger(), nullable=False),
        sa.Column('shop_id', sa.String(length=64), nullable=False),
        sa.Column('shop_name', sa.String(length=128), nullable=False),
        sa.Column('site', sa.String(length=2), nullable=False, server_default='US'),
        sa.Column('buyer_name', sa.String(length=255), nullable=False),
        sa.Column('message_date', sa.Date(), nullable=False),
        sa.Column('subject', sa.String(length=512), nullable=False),
        sa.Column('message_body', sa.Text(), nullable=False),
        sa.Column('triage', sa.JSON(), nullable=False, server_default='{}'),
        sa.Column('category', sa.String(length=16), nullable=False, server_default='no_order_info'),
        sa.Column('has_order', sa.Boolean(), nullable=False, server_default='0'),
        sa.Column('order_info', sa.JSON(), nullable=True),
        sa.Column('sla', sa.JSON(), nullable=True),
        sa.Column('status', sa.String(length=16), nullable=False, server_default='pending'),
        sa.Column('draft_path', sa.Text(), nullable=True),
        sa.Column('reply_sent_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('handler_note', sa.Text(), nullable=True),
        sa.Column('status_history', sa.JSON(), nullable=False, server_default='[]'),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now(), onupdate=sa.func.now()),
    )
    op.create_foreign_key('fk_complaints_run_id', 'complaints', 'complaint_runs', ['run_id'], ['id'], ondelete='CASCADE')
    op.create_index('idx_complaints_run_id', 'complaints', ['run_id'])
    op.create_index('idx_complaints_shop_id', 'complaints', ['shop_id'])
    op.create_index('idx_complaints_status', 'complaints', ['status'])
    op.create_index('idx_complaints_category', 'complaints', ['category'])
    op.create_index('idx_complaints_message_date', 'complaints', ['message_date'])

    # 自然键幂等：有订单用 (shop_id, buyer_name, message_date)；
    # 无订单用 (shop_id, buyer_name, message_date, subject)。
    # 部分唯一索引区分 has_order，对齐 repo 既有模式（BLF-210）。
    op.create_index(
        'uq_complaints_with_order',
        'complaints',
        ['shop_id', 'buyer_name', 'message_date'],
        unique=True,
        postgresql_where=sa.text('has_order = true'),
        sqlite_where=sa.text('has_order = 1'),
    )
    op.create_index(
        'uq_complaints_no_order',
        'complaints',
        ['shop_id', 'buyer_name', 'message_date', 'subject'],
        unique=True,
        postgresql_where=sa.text('has_order = false'),
        sqlite_where=sa.text('has_order = 0'),
    )


def downgrade() -> None:
    op.drop_index('uq_complaints_no_order', table_name='complaints')
    op.drop_index('uq_complaints_with_order', table_name='complaints')
    op.drop_index('idx_complaints_message_date', table_name='complaints')
    op.drop_index('idx_complaints_category', table_name='complaints')
    op.drop_index('idx_complaints_status', table_name='complaints')
    op.drop_index('idx_complaints_shop_id', table_name='complaints')
    op.drop_index('idx_complaints_run_id', table_name='complaints')
    op.drop_constraint('fk_complaints_run_id', 'complaints', type_='foreignkey')
    op.drop_table('complaints')

    op.drop_index('idx_shop_checks_shop_id', table_name='shop_checks')
    op.drop_index('idx_shop_checks_run_id', table_name='shop_checks')
    op.drop_constraint('uq_shop_checks_run_shop', 'shop_checks', type_='unique')
    op.drop_constraint('fk_shop_checks_run_id', 'shop_checks', type_='foreignkey')
    op.drop_table('shop_checks')

    op.drop_index('idx_complaint_runs_run_date', table_name='complaint_runs')
    op.drop_constraint('uq_complaint_runs_run_date', 'complaint_runs', type_='unique')
    op.drop_table('complaint_runs')
