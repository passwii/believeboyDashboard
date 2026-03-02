"""create commission_records table

Revision ID: 20260302_018
Revises: 20260302_017
Create Date: 2026-03-02 21:30:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260302_018'
down_revision: Union[str, None] = '20260302_017'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_table(inspector: sa.Inspector, table_name: str) -> bool:
    return table_name in inspector.get_table_names()


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if _has_table(inspector, 'commission_records'):
        return

    op.create_table(
        'commission_records',
        sa.Column('id', sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column('report_month', sa.String(length=7), nullable=False),
        sa.Column('project_id', sa.BigInteger(), nullable=False),
        sa.Column('project_name', sa.String(length=255), nullable=False),
        sa.Column('person_name', sa.String(length=255), nullable=False),
        sa.Column('income_category', sa.String(length=16), nullable=False),
        sa.Column('income_total_usd', sa.Numeric(18, 2), nullable=False, server_default=sa.text('0')),
        sa.Column('factory_commission_rate', sa.Numeric(8, 6), nullable=False, server_default=sa.text('0')),
        sa.Column('public_commission_ratio', sa.Numeric(8, 6), nullable=False, server_default=sa.text('0')),
        sa.Column('commission_amount_usd', sa.Numeric(18, 2), nullable=False, server_default=sa.text('0')),
        sa.Column('usd_to_rmb_rate', sa.Numeric(18, 8), nullable=False, server_default=sa.text('0')),
        sa.Column('commission_amount_rmb', sa.Numeric(18, 2), nullable=False, server_default=sa.text('0')),
        sa.Column('payment_status', sa.String(length=16), nullable=False, server_default=sa.text("'unpaid'")),
        sa.Column('payment_confirmed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('payment_confirmed_by', sa.String(length=255), nullable=True),
        sa.Column('computed_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
        sa.UniqueConstraint(
            'report_month',
            'project_id',
            'person_name',
            'income_category',
            name='commission_records_unique_month_project_person_category',
        ),
        sa.CheckConstraint("report_month LIKE '____-__'", name='ck_commission_records_report_month_format'),
        sa.CheckConstraint("income_category in ('operator', 'assistant')", name='ck_commission_records_income_category'),
        sa.CheckConstraint("payment_status in ('paid', 'unpaid')", name='ck_commission_records_payment_status'),
        sa.CheckConstraint('factory_commission_rate >= 0 and factory_commission_rate <= 1', name='ck_commission_records_factory_rate'),
        sa.CheckConstraint('public_commission_ratio >= 0 and public_commission_ratio <= 1', name='ck_commission_records_public_ratio'),
        sa.CheckConstraint('usd_to_rmb_rate >= 0', name='ck_commission_records_exchange_rate'),
    )
    op.create_index('idx_commission_records_month', 'commission_records', ['report_month'], unique=False)
    op.create_index('idx_commission_records_person_month', 'commission_records', ['person_name', 'report_month'], unique=False)
    op.create_index('ix_commission_records_project_id', 'commission_records', ['project_id'], unique=False)
    op.create_index('ix_commission_records_person_name', 'commission_records', ['person_name'], unique=False)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if _has_table(inspector, 'commission_records') is False:
        return
    op.drop_index('ix_commission_records_person_name', table_name='commission_records')
    op.drop_index('ix_commission_records_project_id', table_name='commission_records')
    op.drop_index('idx_commission_records_person_month', table_name='commission_records')
    op.drop_index('idx_commission_records_month', table_name='commission_records')
    op.drop_table('commission_records')
