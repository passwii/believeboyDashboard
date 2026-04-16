"""Create store_accounting table for US/EU store forward calculation

This table consolidates all store accounting (店铺测算) for both US and EU
stations. Only forward calculation (profit_calc / eu_accounting) is stored —
no reverse calculation.

Migration strategy:
1. Create new store_accounting table with full schema
2. Migrate existing data from store_sku_pricing_snapshots
   (WHERE calculation_type IN ('profit_calc', 'eu_accounting'))
3. Keep old table intact for backwards compatibility

Unique constraint: (project_id, sku, country) — each store SKU gets one
forward-accounting record per country (US/DE/UK).

Revision ID: 20260414_094
Revises: 20260414_093
Create Date: 2026-04-14 00:00:00.000000
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = '20260414_094'
down_revision: str | None = '20260414_093'
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    """
    创建 store_accounting 表，并从 store_sku_pricing_snapshots 迁移历史数据。
    """
    # 1. 创建新表
    op.create_table(
        'store_accounting',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        # 项目信息
        sa.Column('project_id', sa.BigInteger(), nullable=False),
        sa.Column('project_name', sa.String(length=255), nullable=False),
        sa.Column('sku', sa.String(length=128), nullable=False),
        sa.Column('asin', sa.String(length=64), nullable=True),
        # 国家站点 + 核算类型
        sa.Column('country', sa.String(length=10), nullable=False, server_default='US'),
        sa.Column('accounting_type', sa.String(length=32), nullable=False, server_default='profit_calc'),
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
        sa.Column('advertising_rate', sa.Numeric(8, 6), nullable=False, server_default='0.120000'),
        sa.Column('return_loss_rate', sa.Numeric(8, 6), nullable=False, server_default='0.040000'),
        sa.Column('storage_months', sa.Numeric(8, 2), nullable=False, server_default='1.00'),
        sa.Column('inbound_placement_mode', sa.String(length=32), nullable=False, server_default='single_destination'),
        # 汇率
        sa.Column('usd_to_rmb_rate', sa.Numeric(18, 8), nullable=False),
        sa.Column('usd_to_rmb_rate_source', sa.String(length=64), nullable=False),
        # 尺寸等级和售价带
        sa.Column('size_tier', sa.String(length=32), nullable=False),
        sa.Column('size_tier_label', sa.String(length=64), nullable=False),
        sa.Column('price_band', sa.String(length=32), nullable=False),
        sa.Column('price_band_label', sa.String(length=64), nullable=False),
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
        sa.Column('chargeable_weight_rule', sa.String(length=64), nullable=False),
        # 费用规则标签
        sa.Column('fulfillment_fee_rule_label', sa.String(length=128), nullable=False),
        sa.Column('inbound_config_fee_rule_label', sa.String(length=128), nullable=False),
        sa.Column('storage_fee_rule_label', sa.String(length=128), nullable=False),
        # 费用详情
        sa.Column('referral_fee_usd', sa.Numeric(18, 2), nullable=False),
        sa.Column('advertising_fee_usd', sa.Numeric(18, 2), nullable=False),
        sa.Column('return_loss_usd', sa.Numeric(18, 2), nullable=False),
        sa.Column('fba_fulfillment_fee_usd', sa.Numeric(18, 2), nullable=False),
        sa.Column('inbound_config_fee_usd', sa.Numeric(18, 2), nullable=False),
        sa.Column('storage_fee_usd', sa.Numeric(18, 2), nullable=False),
        sa.Column('total_fee_usd', sa.Numeric(18, 2), nullable=False),
        # EU 手动填写费用
        sa.Column('delivery_fee_usd', sa.Numeric(18, 2), nullable=False, server_default='0.00'),
        sa.Column('inbound_config_fee_manual_usd', sa.Numeric(18, 2), nullable=False, server_default='0.00'),
        sa.Column('storage_fee_manual_usd', sa.Numeric(18, 2), nullable=False, server_default='0.00'),
        # 利润详情
        sa.Column('payout_usd', sa.Numeric(18, 2), nullable=False),
        sa.Column('profit_usd', sa.Numeric(18, 2), nullable=False),
        sa.Column('profit_rate', sa.Numeric(8, 6), nullable=False),
        # EU VAT
        sa.Column('vat_usd', sa.Numeric(18, 2), nullable=False, server_default='0.00'),
        sa.Column('profit_after_vat_usd', sa.Numeric(18, 2), nullable=True),
        sa.Column('profit_after_vat_rate', sa.Numeric(8, 6), nullable=True),
        # 警告信息
        sa.Column('warnings_json', postgresql.JSONB, nullable=True),
        # 备注
        sa.Column('notes', sa.Text(), nullable=True),
        # 操作人
        sa.Column('created_by', sa.String(length=255), nullable=True),
        # 原始快照来源（关联 store_sku_pricing_snapshots.id）
        sa.Column('snapshot_source_id', sa.BigInteger(), nullable=True),
        # 时间戳
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )

    # 2. 创建索引
    op.create_index('idx_store_accounting_project_id', 'store_accounting', ['project_id'])
    op.create_index('idx_store_accounting_country', 'store_accounting', ['country'])
    op.create_index('idx_store_accounting_project_country', 'store_accounting', ['project_id', 'country'])
    op.create_index('idx_store_accounting_updated_at', 'store_accounting', ['updated_at'])

    # 3. 唯一约束：(project_id, sku, country) 每个店铺 SKU 在每个国家只有一条
    op.create_unique_constraint(
        'uq_store_accounting_project_sku_country',
        'store_accounting',
        ['project_id', 'sku', 'country'],
    )

    # 4. 从 store_sku_pricing_snapshots 迁移数据
    # 只迁移正算类记录（profit_calc 和 eu_accounting）
    op.execute(sa.text("""
        INSERT INTO store_accounting (
            id,
            project_id,
            project_name,
            sku,
            asin,
            country,
            accounting_type,
            package_length_cm,
            package_width_cm,
            package_height_cm,
            weight_kg,
            fob_product_cost_rmb,
            first_leg_cost_rmb,
            ddp_cost_rmb,
            ddp_cost_usd,
            sale_price_usd,
            advertising_rate,
            return_loss_rate,
            storage_months,
            inbound_placement_mode,
            usd_to_rmb_rate,
            usd_to_rmb_rate_source,
            size_tier,
            size_tier_label,
            price_band,
            price_band_label,
            longest_side_in,
            middle_side_in,
            shortest_side_in,
            length_plus_girth_in,
            volume_cubic_in,
            volume_cubic_ft,
            product_weight_lb,
            product_weight_oz,
            dimensional_weight_lb,
            chargeable_weight_lb,
            chargeable_weight_oz,
            chargeable_weight_rule,
            fulfillment_fee_rule_label,
            inbound_config_fee_rule_label,
            storage_fee_rule_label,
            referral_fee_usd,
            advertising_fee_usd,
            return_loss_usd,
            fba_fulfillment_fee_usd,
            inbound_config_fee_usd,
            storage_fee_usd,
            total_fee_usd,
            delivery_fee_usd,
            inbound_config_fee_manual_usd,
            storage_fee_manual_usd,
            payout_usd,
            profit_usd,
            profit_rate,
            vat_usd,
            profit_after_vat_usd,
            profit_after_vat_rate,
            warnings_json,
            notes,
            created_by,
            snapshot_source_id,
            created_at,
            updated_at
        )
        SELECT
            id,
            project_id,
            project_name,
            sku,
            asin,
            country,
            calculation_type AS accounting_type,
            package_length_cm,
            package_width_cm,
            package_height_cm,
            weight_kg,
            fob_product_cost_rmb,
            first_leg_cost_rmb,
            ddp_cost_rmb,
            ddp_cost_usd,
            sale_price_usd,
            advertising_rate,
            return_loss_rate,
            storage_months,
            inbound_placement_mode,
            usd_to_rmb_rate,
            usd_to_rmb_rate_source,
            size_tier,
            size_tier_label,
            price_band,
            price_band_label,
            longest_side_in,
            middle_side_in,
            shortest_side_in,
            length_plus_girth_in,
            volume_cubic_in,
            volume_cubic_ft,
            product_weight_lb,
            product_weight_oz,
            dimensional_weight_lb,
            chargeable_weight_lb,
            chargeable_weight_oz,
            chargeable_weight_rule,
            fulfillment_fee_rule_label,
            inbound_config_fee_rule_label,
            storage_fee_rule_label,
            referral_fee_usd,
            advertising_fee_usd,
            return_loss_usd,
            fba_fulfillment_fee_usd,
            inbound_config_fee_usd,
            storage_fee_usd,
            total_fee_usd,
            COALESCE(delivery_fee_usd, 0),
            COALESCE(inbound_config_fee_manual_usd, 0),
            COALESCE(storage_fee_manual_usd, 0),
            payout_usd,
            profit_usd,
            profit_rate,
            COALESCE(vat_usd, 0),
            profit_after_vat_usd,
            profit_after_vat_rate,
            warnings_json,
            notes,
            created_by,
            id AS snapshot_source_id,
            created_at,
            updated_at
        FROM store_sku_pricing_snapshots
        WHERE calculation_type IN ('profit_calc', 'eu_accounting')
        ON CONFLICT (project_id, sku, country) DO NOTHING
    """))

    # Fix PostgreSQL sequence after migrating IDs from source table.
    # Without this, INSERTs into store_accounting would fail with
    # "duplicate key value violates unique constraint (id=N)"
    # because PostgreSQL doesn't know the sequence was seeded by COPY/INSERT.
    op.execute(sa.text("""
        SELECT setval(
            'store_accounting_id_seq',
            COALESCE((SELECT MAX(id) FROM store_accounting), 0) + 1,
            true
        )
    """))


def downgrade() -> None:
    op.drop_constraint(
        'uq_store_accounting_project_sku_country',
        'store_accounting',
        type_='unique',
    )
    op.drop_index('idx_store_accounting_updated_at', table_name='store_accounting')
    op.drop_index('idx_store_accounting_project_country', table_name='store_accounting')
    op.drop_index('idx_store_accounting_country', table_name='store_accounting')
    op.drop_index('idx_store_accounting_project_id', table_name='store_accounting')
    op.drop_table('store_accounting')
