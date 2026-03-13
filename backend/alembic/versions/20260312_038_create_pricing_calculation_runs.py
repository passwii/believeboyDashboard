"""create pricing calculation runs

Revision ID: 20260312_038
Revises: 20260311_037
Create Date: 2026-03-12 16:45:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260312_038'
down_revision: Union[str, None] = '20260311_037'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    now_default = sa.text('CURRENT_TIMESTAMP') if bind.dialect.name == 'sqlite' else sa.func.now()
    if 'pricing_calculation_runs' in inspector.get_table_names():
        return

    op.create_table(
        'pricing_calculation_runs',
        sa.Column('id', sa.BigInteger().with_variant(sa.Integer(), 'sqlite'), primary_key=True, autoincrement=True),
        sa.Column('product_name', sa.String(length=255), nullable=False),
        sa.Column('package_length_cm', sa.Numeric(18, 4), nullable=False),
        sa.Column('package_width_cm', sa.Numeric(18, 4), nullable=False),
        sa.Column('package_height_cm', sa.Numeric(18, 4), nullable=False),
        sa.Column('weight_kg', sa.Numeric(18, 4), nullable=False),
        sa.Column('fob_product_cost_rmb', sa.Numeric(18, 2), nullable=False),
        sa.Column('first_leg_cost_rmb', sa.Numeric(18, 2), nullable=False),
        sa.Column('ddp_cost_rmb', sa.Numeric(18, 2), nullable=False),
        sa.Column('ddp_cost_usd', sa.Numeric(18, 2), nullable=False),
        sa.Column('sale_price_usd', sa.Numeric(18, 2), nullable=False),
        sa.Column('commission_rate', sa.Numeric(8, 6), nullable=False, server_default='0.150000'),
        sa.Column('advertising_rate', sa.Numeric(8, 6), nullable=False, server_default='0.120000'),
        sa.Column('return_loss_rate', sa.Numeric(8, 6), nullable=False, server_default='0.040000'),
        sa.Column('storage_months', sa.Numeric(8, 2), nullable=False, server_default='1.00'),
        sa.Column('inbound_placement_mode', sa.String(length=32), nullable=False, server_default='single_destination'),
        sa.Column('usd_to_rmb_rate', sa.Numeric(18, 8), nullable=False),
        sa.Column('usd_to_rmb_rate_source', sa.String(length=64), nullable=False),
        sa.Column('size_tier', sa.String(length=32), nullable=False),
        sa.Column('size_tier_label', sa.String(length=64), nullable=False),
        sa.Column('price_band', sa.String(length=32), nullable=False),
        sa.Column('price_band_label', sa.String(length=64), nullable=False),
        sa.Column('longest_side_in', sa.Numeric(18, 4), nullable=False),
        sa.Column('middle_side_in', sa.Numeric(18, 4), nullable=False),
        sa.Column('shortest_side_in', sa.Numeric(18, 4), nullable=False),
        sa.Column('length_plus_girth_in', sa.Numeric(18, 4), nullable=False),
        sa.Column('volume_cubic_in', sa.Numeric(18, 4), nullable=False),
        sa.Column('volume_cubic_ft', sa.Numeric(18, 6), nullable=False),
        sa.Column('product_weight_lb', sa.Numeric(18, 4), nullable=False),
        sa.Column('product_weight_oz', sa.Numeric(18, 4), nullable=False),
        sa.Column('dimensional_weight_lb', sa.Numeric(18, 4), nullable=False),
        sa.Column('chargeable_weight_lb', sa.Numeric(18, 4), nullable=False),
        sa.Column('chargeable_weight_oz', sa.Numeric(18, 4), nullable=False),
        sa.Column('chargeable_weight_rule', sa.String(length=64), nullable=False),
        sa.Column('fulfillment_fee_rule_label', sa.String(length=128), nullable=False),
        sa.Column('inbound_config_fee_rule_label', sa.String(length=128), nullable=False),
        sa.Column('storage_fee_rule_label', sa.String(length=128), nullable=False),
        sa.Column('referral_fee_usd', sa.Numeric(18, 2), nullable=False),
        sa.Column('advertising_fee_usd', sa.Numeric(18, 2), nullable=False),
        sa.Column('return_loss_usd', sa.Numeric(18, 2), nullable=False),
        sa.Column('fba_fulfillment_fee_usd', sa.Numeric(18, 2), nullable=False),
        sa.Column('inbound_config_fee_usd', sa.Numeric(18, 2), nullable=False),
        sa.Column('storage_fee_usd', sa.Numeric(18, 2), nullable=False),
        sa.Column('total_fee_usd', sa.Numeric(18, 2), nullable=False),
        sa.Column('payout_usd', sa.Numeric(18, 2), nullable=False),
        sa.Column('profit_usd', sa.Numeric(18, 2), nullable=False),
        sa.Column('profit_rate', sa.Numeric(8, 6), nullable=False),
        sa.Column('warnings_json', sa.JSON(), nullable=True),
        sa.Column('notes', sa.Text(), nullable=True),
        sa.Column('created_by', sa.String(length=255), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=now_default),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=now_default),
    )
    op.create_index('idx_pricing_calculation_runs_product_name', 'pricing_calculation_runs', ['product_name'], unique=False)
    op.create_index('idx_pricing_calculation_runs_size_tier', 'pricing_calculation_runs', ['size_tier'], unique=False)
    op.create_index('idx_pricing_calculation_runs_created_at', 'pricing_calculation_runs', ['created_at'], unique=False)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if 'pricing_calculation_runs' not in inspector.get_table_names():
        return

    if 'idx_pricing_calculation_runs_created_at' in {index['name'] for index in inspector.get_indexes('pricing_calculation_runs')}:
        op.drop_index('idx_pricing_calculation_runs_created_at', table_name='pricing_calculation_runs')
    if 'idx_pricing_calculation_runs_size_tier' in {index['name'] for index in inspector.get_indexes('pricing_calculation_runs')}:
        op.drop_index('idx_pricing_calculation_runs_size_tier', table_name='pricing_calculation_runs')
    if 'idx_pricing_calculation_runs_product_name' in {index['name'] for index in inspector.get_indexes('pricing_calculation_runs')}:
        op.drop_index('idx_pricing_calculation_runs_product_name', table_name='pricing_calculation_runs')
    op.drop_table('pricing_calculation_runs')
