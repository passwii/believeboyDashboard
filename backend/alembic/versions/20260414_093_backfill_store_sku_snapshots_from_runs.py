"""backfill store sku pricing snapshots from pricing calculation runs

将 pricing_calculation_runs 中属于店铺核算的历史记录（有 project_id 和 sku）
回填到 store_sku_pricing_snapshots 表。

仅回填每个 (project_id, sku, calculation_type) 组合中 created_at 最新的一条记录，
使用 INSERT ... ON CONFLICT DO NOTHING 避免覆盖已有的快照记录。

Revision ID: 20260414_093
Revises: 20260413_092
Create Date: 2026-04-14 00:00:00.000000
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = '20260414_093'
down_revision: str | None = '20260413_092'
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    """
    从 pricing_calculation_runs 回填 store_sku_pricing_snapshots。
    仅处理有 project_id 和 sku 的记录（店铺核算），每个组合保留最新一条。
    """
    # 使用 CTE + ON CONFLICT 语法一次性完成，避免 Python 循环开销
    op.execute(sa.text("""
        INSERT INTO store_sku_pricing_snapshots (
            project_id,
            project_name,
            sku,
            asin,
            country,
            calculation_type,
            package_length_cm,
            package_width_cm,
            package_height_cm,
            weight_kg,
            fob_product_cost_rmb,
            first_leg_cost_rmb,
            ddp_cost_rmb,
            ddp_cost_usd,
            sale_price_usd,
            target_profit_rate,
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
            payout_usd,
            profit_usd,
            profit_rate,
            vat_usd,
            profit_after_vat_usd,
            profit_after_vat_rate,
            warnings_json,
            notes,
            created_by,
            created_at,
            updated_at
        )
        WITH latest AS (
            SELECT DISTINCT ON (project_id, sku, calculation_type)
                id,
                project_id,
                product_name,
                country
            FROM pricing_calculation_runs
            WHERE
                project_id IS NOT NULL
                AND sku IS NOT NULL
            ORDER BY
                project_id,
                sku,
                calculation_type,
                created_at DESC
        )
        SELECT
            r.project_id,
            r.product_name,
            r.sku,
            NULL::character varying(64) AS asin,
            r.country,
            r.calculation_type,
            r.package_length_cm,
            r.package_width_cm,
            r.package_height_cm,
            r.weight_kg,
            r.fob_product_cost_rmb,
            r.first_leg_cost_rmb,
            r.ddp_cost_rmb,
            r.ddp_cost_usd,
            r.sale_price_usd,
            NULL::numeric(8,6) AS target_profit_rate,
            r.advertising_rate,
            r.return_loss_rate,
            r.storage_months,
            r.inbound_placement_mode,
            r.usd_to_rmb_rate,
            r.usd_to_rmb_rate_source,
            r.size_tier,
            r.size_tier_label,
            r.price_band,
            r.price_band_label,
            r.longest_side_in,
            r.middle_side_in,
            r.shortest_side_in,
            r.length_plus_girth_in,
            r.volume_cubic_in,
            r.volume_cubic_ft,
            r.product_weight_lb,
            r.product_weight_oz,
            r.dimensional_weight_lb,
            r.chargeable_weight_lb,
            r.chargeable_weight_oz,
            r.chargeable_weight_rule,
            r.fulfillment_fee_rule_label,
            r.inbound_config_fee_rule_label,
            r.storage_fee_rule_label,
            r.referral_fee_usd,
            r.advertising_fee_usd,
            r.return_loss_usd,
            r.fba_fulfillment_fee_usd,
            r.inbound_config_fee_usd,
            r.storage_fee_usd,
            r.total_fee_usd,
            r.payout_usd,
            r.profit_usd,
            r.profit_rate,
            COALESCE(r.vat_usd, 0::numeric) AS vat_usd,
            r.profit_after_vat_usd,
            r.profit_after_vat_rate,
            r.warnings_json,
            r.notes,
            r.created_by,
            r.created_at,
            r.updated_at
        FROM pricing_calculation_runs r
        INNER JOIN latest l ON r.id = l.id
        ON CONFLICT (project_id, sku, calculation_type) DO NOTHING
    """))


def downgrade() -> None:
    # 回滚时只清理本次回填的快照（通过 created_at 范围或 created_by 判断不准确，
    # 故降级操作仅作提示，不做实际清理，避免误删用户手动保存的快照）
    pass
