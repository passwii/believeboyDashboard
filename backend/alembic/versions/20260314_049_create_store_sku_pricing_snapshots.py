"""create store sku pricing snapshots table

店铺 SKU 核算快照表，用于存储店铺维度 SKU 的核算结果。
用户核算后可落库保存，下次打开时直接读取快照，避免重复计算。

"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = '20260314_049'
down_revision = '20260313_048'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'store_sku_pricing_snapshots',
        sa.Column('id', sa.BigInteger().with_variant(sa.Integer, 'sqlite'), primary_key=True, autoincrement=True),
        sa.Column('project_id', sa.Integer(), nullable=False, index=True),
        sa.Column('project_name', sa.String(255), nullable=False),
        sa.Column('sku', sa.String(128), nullable=False),
        sa.Column('asin', sa.String(64), nullable=True),
        sa.Column('country', sa.String(32), nullable=True),
        # 核算类型：profit_calc(利润核算) 或 profit_reverse(利润倒算)
        sa.Column('calculation_type', sa.String(32), nullable=False, server_default='profit_calc'),
        # 尺寸信息
        sa.Column('package_length_cm', sa.Numeric(18, 4), nullable=False),
        sa.Column('package_width_cm', sa.Numeric(18, 4), nullable=False),
        sa.Column('package_height_cm', sa.Numeric(18, 4), nullable=False),
        sa.Column('weight_kg', sa.Numeric(18, 4), nullable=False),
        # 成本信息
        sa.Column('fob_product_cost_rmb', sa.Numeric(18, 2), nullable=False),
        sa.Column('first_leg_cost_rmb', sa.Numeric(18, 2), nullable=False),
        sa.Column('ddp_cost_rmb', sa.Numeric(18, 2), nullable=False),
        sa.Column('ddp_cost_usd', sa.Numeric(18, 2), nullable=False),
        # 销售参数
        sa.Column('sale_price_usd', sa.Numeric(18, 2), nullable=False),
        sa.Column('target_profit_rate', sa.Numeric(8, 6), nullable=True),  # 仅用于倒算
        sa.Column('advertising_rate', sa.Numeric(8, 6), nullable=False, server_default='0.120000'),
        sa.Column('return_loss_rate', sa.Numeric(8, 6), nullable=False, server_default='0.040000'),
        sa.Column('storage_months', sa.Numeric(8, 2), nullable=False, server_default='1.00'),
        sa.Column('inbound_placement_mode', sa.String(32), nullable=False, server_default='single_destination'),
        # 汇率
        sa.Column('usd_to_rmb_rate', sa.Numeric(18, 8), nullable=False),
        sa.Column('usd_to_rmb_rate_source', sa.String(64), nullable=False),
        # 尺寸等级和售价带
        sa.Column('size_tier', sa.String(32), nullable=False, index=True),
        sa.Column('size_tier_label', sa.String(64), nullable=False),
        sa.Column('price_band', sa.String(32), nullable=False),
        sa.Column('price_band_label', sa.String(64), nullable=False),
        # 尺寸详情
        sa.Column('longest_side_in', sa.Numeric(18, 4), nullable=False),
        sa.Column('middle_side_in', sa.Numeric(18, 4), nullable=False),
        sa.Column('shortest_side_in', sa.Numeric(18, 4), nullable=False),
        sa.Column('length_plus_girth_in', sa.Numeric(18, 4), nullable=False),
        sa.Column('volume_cubic_in', sa.Numeric(18, 4), nullable=False),
        sa.Column('volume_cubic_ft', sa.Numeric(18, 6), nullable=False),
        # 重量详情
        sa.Column('product_weight_lb', sa.Numeric(18, 4), nullable=False),
        sa.Column('product_weight_oz', sa.Numeric(18, 4), nullable=False),
        sa.Column('dimensional_weight_lb', sa.Numeric(18, 4), nullable=False),
        sa.Column('chargeable_weight_lb', sa.Numeric(18, 4), nullable=False),
        sa.Column('chargeable_weight_oz', sa.Numeric(18, 4), nullable=False),
        sa.Column('chargeable_weight_rule', sa.String(64), nullable=False),
        # 费用规则标签
        sa.Column('fulfillment_fee_rule_label', sa.String(128), nullable=False),
        sa.Column('inbound_config_fee_rule_label', sa.String(128), nullable=False),
        sa.Column('storage_fee_rule_label', sa.String(128), nullable=False),
        # 费用详情
        sa.Column('referral_fee_usd', sa.Numeric(18, 2), nullable=False),
        sa.Column('advertising_fee_usd', sa.Numeric(18, 2), nullable=False),
        sa.Column('return_loss_usd', sa.Numeric(18, 2), nullable=False),
        sa.Column('fba_fulfillment_fee_usd', sa.Numeric(18, 2), nullable=False),
        sa.Column('inbound_config_fee_usd', sa.Numeric(18, 2), nullable=False),
        sa.Column('storage_fee_usd', sa.Numeric(18, 2), nullable=False),
        sa.Column('total_fee_usd', sa.Numeric(18, 2), nullable=False),
        # 利润详情
        sa.Column('payout_usd', sa.Numeric(18, 2), nullable=False),
        sa.Column('profit_usd', sa.Numeric(18, 2), nullable=False),
        sa.Column('profit_rate', sa.Numeric(8, 6), nullable=False),
        # 警告信息
        sa.Column('warnings_json', postgresql.JSON(astext_type=sa.Text()), nullable=True),
        # 备注
        sa.Column('notes', sa.Text(), nullable=True),
        # 操作人
        sa.Column('created_by', sa.String(255), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now(), onupdate=sa.func.now()),
        # 唯一约束：每个项目+SKU+核算类型只有一条最新记录
        sa.UniqueConstraint('project_id', 'sku', 'calculation_type', name='uq_store_sku_pricing_snapshots_project_sku_type'),
    )
    
    # 创建索引
    op.create_index('idx_store_sku_pricing_snapshots_project_sku', 'store_sku_pricing_snapshots', ['project_id', 'sku'])
    op.create_index('idx_store_sku_pricing_snapshots_project', 'store_sku_pricing_snapshots', ['project_id'])


def downgrade() -> None:
    op.drop_index('idx_store_sku_pricing_snapshots_project', table_name='store_sku_pricing_snapshots')
    op.drop_index('idx_store_sku_pricing_snapshots_project_sku', table_name='store_sku_pricing_snapshots')
    op.drop_table('store_sku_pricing_snapshots')
