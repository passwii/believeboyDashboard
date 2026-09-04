"""create pricing calculation snapshots tables

Revision ID: 20260707_204
Revises: 20260706_203
Create Date: 2026-07-07 00:00:00.000000

店铺定价历史快照。区别于 ``store_sku_pricing_snapshots``（每个 project+sku 永远只有
"最新一条"的当前态缓存），本表为 append-only 模式：每次用户在前端点"保存为快照"会
新增一行 header + 一组 items，历史可任意回放。

设计要点（参考 ``20260516_121_create_inventory_replenishment_snapshot_tables``）：

- Header 字段：``project_id``、``country``、``snapshot_date``、``name``、``description``、
  ``summary_json``、``row_count``、``created_by``、``created_at``
- Summary 字段：``{total, calculated, profitable, passRate}`` 与 shop-calculation 顶部
  stat bar 的 4 个数字对齐
- Item 字段：镜像 ``store_sku_pricing_snapshots`` 全部业务列（含 US + EU 通用字段：
  ``delivery_fee_usd`` / ``inbound_config_fee_manual_usd`` / ``storage_fee_manual_usd`` /
  ``vat_usd`` / ``profit_after_vat_*``）
- 唯一性：不做 partial unique —— pricing 侧每条历史都需要保留，不强制"当前快照唯一"
- 删除策略：cascade（删 header 自动清 items），与 inventory 一致
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = '20260707_204'
down_revision: Union[str, None] = '20260706_203'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── Header table ─────────────────────────────────────────────────────────
    op.create_table(
        'pricing_calculation_snapshots',
        sa.Column('id', sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column('project_id', sa.Integer(), nullable=False, index=True),
        sa.Column('project_name', sa.String(255), nullable=False),
        # US / DE / UK —— 与 shop-calculation 的 selectedCountry 对齐
        sa.Column('country', sa.String(2), nullable=False),
        sa.Column('snapshot_date', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('name', sa.String(255), nullable=True),
        sa.Column('description', sa.Text(), nullable=True),
        # 4 个 stat bar 字段：total / calculated / profitable / passRate
        sa.Column('summary_json', postgresql.JSON(astext_type=sa.Text()).with_variant(sa.JSON(), 'sqlite'), nullable=False, server_default='{}'),
        sa.Column('row_count', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('created_by', sa.String(255), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )

    op.create_index(
        'idx_pricing_calculation_snapshots_project_id',
        'pricing_calculation_snapshots',
        ['project_id'],
    )
    op.create_index(
        'idx_pricing_calculation_snapshots_project_country',
        'pricing_calculation_snapshots',
        ['project_id', 'country'],
    )
    op.create_index(
        'idx_pricing_calculation_snapshots_date',
        'pricing_calculation_snapshots',
        ['snapshot_date'],
    )

    # ── Items table ──────────────────────────────────────────────────────────
    # 镜像 store_sku_pricing_snapshots 的列定义。
    # 不加唯一约束 —— append-only，允许多份历史同 SKU 重复。
    op.create_table(
        'pricing_calculation_snapshot_items',
        sa.Column('id', sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column(
            'snapshot_id', sa.BigInteger(),
            sa.ForeignKey('pricing_calculation_snapshots.id', ondelete='CASCADE'),
            nullable=False,
        ),
        sa.Column('source_row_no', sa.Integer(), nullable=False, server_default='0'),

        # ── 主键维度 ─────────────────────────────────────────────────────────
        sa.Column('project_id', sa.Integer(), nullable=False),
        sa.Column('project_name', sa.String(255), nullable=False),
        sa.Column('sku', sa.String(128), nullable=False),
        sa.Column('asin', sa.String(64), nullable=True),
        sa.Column('country', sa.String(2), nullable=True),
        # profit_calc | profit_reverse | eu_accounting
        sa.Column('calculation_type', sa.String(32), nullable=False, server_default='profit_calc'),

        # ── 尺寸 ─────────────────────────────────────────────────────────────
        sa.Column('package_length_cm', sa.Numeric(18, 4), nullable=False),
        sa.Column('package_width_cm', sa.Numeric(18, 4), nullable=False),
        sa.Column('package_height_cm', sa.Numeric(18, 4), nullable=False),
        sa.Column('weight_kg', sa.Numeric(18, 4), nullable=False),

        # ── 成本 ─────────────────────────────────────────────────────────────
        sa.Column('fob_product_cost_rmb', sa.Numeric(18, 2), nullable=False),
        sa.Column('first_leg_cost_rmb', sa.Numeric(18, 2), nullable=False),
        sa.Column('ddp_cost_rmb', sa.Numeric(18, 2), nullable=False),
        sa.Column('ddp_cost_usd', sa.Numeric(18, 2), nullable=False),

        # ── 销售参数 ─────────────────────────────────────────────────────────
        sa.Column('sale_price_usd', sa.Numeric(18, 2), nullable=False),
        sa.Column('target_profit_rate', sa.Numeric(8, 6), nullable=True),
        sa.Column('advertising_rate', sa.Numeric(8, 6), nullable=False, server_default='0.120000'),
        sa.Column('return_loss_rate', sa.Numeric(8, 6), nullable=False, server_default='0.040000'),
        sa.Column('storage_months', sa.Numeric(8, 2), nullable=False, server_default='1.00'),
        sa.Column('inbound_placement_mode', sa.String(32), nullable=False, server_default='single_destination'),

        # ── 汇率 ─────────────────────────────────────────────────────────────
        sa.Column('usd_to_rmb_rate', sa.Numeric(18, 8), nullable=False),
        sa.Column('usd_to_rmb_rate_source', sa.String(64), nullable=False, server_default=''),

        # ── 尺寸等级 / 售价带 ────────────────────────────────────────────────
        sa.Column('size_tier', sa.String(32), nullable=False),
        sa.Column('size_tier_label', sa.String(64), nullable=False),
        sa.Column('price_band', sa.String(32), nullable=False),
        sa.Column('price_band_label', sa.String(64), nullable=False),

        # ── 尺寸详情 ─────────────────────────────────────────────────────────
        sa.Column('longest_side_in', sa.Numeric(18, 4), nullable=False),
        sa.Column('middle_side_in', sa.Numeric(18, 4), nullable=False),
        sa.Column('shortest_side_in', sa.Numeric(18, 4), nullable=False),
        sa.Column('length_plus_girth_in', sa.Numeric(18, 4), nullable=False),
        sa.Column('volume_cubic_in', sa.Numeric(18, 4), nullable=False),
        sa.Column('volume_cubic_ft', sa.Numeric(18, 6), nullable=False),

        # ── 重量详情 ─────────────────────────────────────────────────────────
        sa.Column('product_weight_lb', sa.Numeric(18, 4), nullable=False),
        sa.Column('product_weight_oz', sa.Numeric(18, 4), nullable=False),
        sa.Column('dimensional_weight_lb', sa.Numeric(18, 4), nullable=False),
        sa.Column('chargeable_weight_lb', sa.Numeric(18, 4), nullable=False),
        sa.Column('chargeable_weight_oz', sa.Numeric(18, 4), nullable=False),
        sa.Column('chargeable_weight_rule', sa.String(64), nullable=False),

        # ── 费用规则标签 ─────────────────────────────────────────────────────
        sa.Column('fulfillment_fee_rule_label', sa.String(128), nullable=False),
        sa.Column('inbound_config_fee_rule_label', sa.String(128), nullable=False),
        sa.Column('storage_fee_rule_label', sa.String(128), nullable=False),

        # ── 费用详情 ─────────────────────────────────────────────────────────
        sa.Column('referral_fee_usd', sa.Numeric(18, 2), nullable=False),
        sa.Column('advertising_fee_usd', sa.Numeric(18, 2), nullable=False),
        sa.Column('return_loss_usd', sa.Numeric(18, 2), nullable=False),
        sa.Column('fba_fulfillment_fee_usd', sa.Numeric(18, 2), nullable=False),
        sa.Column('inbound_config_fee_usd', sa.Numeric(18, 2), nullable=False),
        sa.Column('storage_fee_usd', sa.Numeric(18, 2), nullable=False),
        sa.Column('total_fee_usd', sa.Numeric(18, 2), nullable=False),
        sa.Column('platform_fee_usd', sa.Numeric(18, 2), nullable=False, server_default='0.00'),
        # EU 手动填写费用
        sa.Column('delivery_fee_usd', sa.Numeric(18, 2), nullable=False, server_default='0.00'),
        sa.Column('inbound_config_fee_manual_usd', sa.Numeric(18, 2), nullable=False, server_default='0.00'),
        sa.Column('storage_fee_manual_usd', sa.Numeric(18, 2), nullable=False, server_default='0.00'),

        # ── 利润详情 ─────────────────────────────────────────────────────────
        sa.Column('payout_usd', sa.Numeric(18, 2), nullable=False),
        sa.Column('profit_usd', sa.Numeric(18, 2), nullable=False),
        sa.Column('profit_rate', sa.Numeric(8, 6), nullable=False),
        # EU VAT
        sa.Column('vat_usd', sa.Numeric(18, 2), nullable=False, server_default='0.00'),
        sa.Column('profit_after_vat_usd', sa.Numeric(18, 2), nullable=True),
        sa.Column('profit_after_vat_rate', sa.Numeric(8, 6), nullable=True),

        # ── 警告 / 备注 ──────────────────────────────────────────────────────
        sa.Column('warnings_json', postgresql.JSON(astext_type=sa.Text()).with_variant(sa.JSON(), 'sqlite'), nullable=True),
        sa.Column('notes', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )

    op.create_index(
        'idx_pricing_calculation_snapshot_items_snapshot_id',
        'pricing_calculation_snapshot_items',
        ['snapshot_id'],
    )
    op.create_index(
        'idx_pricing_calculation_snapshot_items_sku',
        'pricing_calculation_snapshot_items',
        ['snapshot_id', 'sku'],
    )


def downgrade() -> None:
    op.drop_index('idx_pricing_calculation_snapshot_items_sku', table_name='pricing_calculation_snapshot_items')
    op.drop_index('idx_pricing_calculation_snapshot_items_snapshot_id', table_name='pricing_calculation_snapshot_items')
    op.drop_table('pricing_calculation_snapshot_items')
    op.drop_index('idx_pricing_calculation_snapshots_date', table_name='pricing_calculation_snapshots')
    op.drop_index('idx_pricing_calculation_snapshots_project_country', table_name='pricing_calculation_snapshots')
    op.drop_index('idx_pricing_calculation_snapshots_project_id', table_name='pricing_calculation_snapshots')
    op.drop_table('pricing_calculation_snapshots')
