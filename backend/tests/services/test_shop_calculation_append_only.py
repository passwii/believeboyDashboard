"""BEL-378 shop_calculation append-only 改造测试。

覆盖：
- append 每次新增一行（不覆盖）
- list_by_project 返回每 SKU 最新有效行（软删过滤）
- observed_at / source 正确记录；显式 observed_at 被采用
- soft_delete_group 软删整组（列表移除、历史保留）
- list_history 返回全部历史
- pricing_calculation_snapshot.create_snapshot 只复制「当前态」（最新行）
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from sqlalchemy import delete

from app.models import PricingCalculationSnapshot, PricingCalculationSnapshotItem
from app.models.shop_calculation import ShopCalculation
from app.schemas.shop_calculation import ShopCalculationCreateRequest
from app.services import pricing_calculation_snapshot_service, shop_calculation_service

# 专用测试 project_id，避免与真实数据冲突（BLF_test 通常为空，但保险起见用高位 id）
TEST_PROJECT_ID = 999901
TEST_PROJECT_NAME = "BEL378测试店"


def _payload(**overrides) -> ShopCalculationCreateRequest:
    """构造一个字段齐全的最小有效核算请求，可用 overrides 覆盖任意字段。"""
    base = dict(
        project_id=TEST_PROJECT_ID,
        project_name=TEST_PROJECT_NAME,
        sku="SKU-A",
        asin="B0TESTASIN",
        country="US",
        accounting_type="profit_calc",
        package_length_cm=10.0,
        package_width_cm=8.0,
        package_height_cm=5.0,
        weight_kg=0.5,
        fob_product_cost_rmb=20.0,
        first_leg_cost_rmb=5.0,
        ddp_cost_rmb=30.0,
        ddp_cost_usd=4.2,
        sale_price_usd=19.99,
        advertising_rate=0.12,
        return_loss_rate=0.04,
        storage_months=1.0,
        inbound_placement_mode="single_destination",
        usd_to_rmb_rate=7.2,
        usd_to_rmb_rate_source="test",
        size_tier="standard",
        size_tier_label="标准尺寸",
        price_band="15_25",
        price_band_label="$15-25",
        longest_side_in=4.0,
        middle_side_in=3.0,
        shortest_side_in=2.0,
        length_plus_girth_in=14.0,
        volume_cubic_in=24.0,
        volume_cubic_ft=0.014,
        product_weight_lb=1.0,
        product_weight_oz=16.0,
        dimensional_weight_lb=0.8,
        chargeable_weight_lb=1.0,
        chargeable_weight_oz=16.0,
        chargeable_weight_rule="actual",
        fulfillment_fee_rule_label="rule",
        inbound_config_fee_rule_label="rule",
        storage_fee_rule_label="rule",
        referral_fee_usd=3.0,
        advertising_fee_usd=2.4,
        return_loss_usd=0.8,
        fba_fulfillment_fee_usd=3.5,
        inbound_config_fee_usd=0.3,
        storage_fee_usd=0.2,
        total_fee_usd=10.2,
        payout_usd=15.0,
        profit_usd=4.8,
        profit_rate=0.24,
    )
    base.update(overrides)
    return ShopCalculationCreateRequest(**base)


def _count_rows(db) -> int:
    return len(
        db.query(ShopCalculation)
        .filter(ShopCalculation.project_id == TEST_PROJECT_ID)
        .all()
    )


def test_append_creates_new_row_each_write(db_session):
    """同一 SKU 连续 append 两次 → DB 两行，列表只显示最新一行。"""
    shop_calculation_service.append_calculation(
        db_session, _payload(sale_price_usd=19.99), operator="tester"
    )
    shop_calculation_service.append_calculation(
        db_session, _payload(sale_price_usd=24.99), operator="tester"
    )

    assert _count_rows(db_session) == 2, "append-only 应保留两行历史"

    items, total = shop_calculation_service.list_by_project(
        db_session, project_id=TEST_PROJECT_ID
    )
    assert total == 1, "当前态列表应只显示最新一行"
    assert items[0].sale_price_usd == 24.99, "最新一行应为第二次写入"


def test_list_returns_latest_per_sku(db_session):
    """多 SKU 各自取最新行。"""
    shop_calculation_service.append_calculation(
        db_session, _payload(sku="SKU-A", sale_price_usd=10.0)
    )
    shop_calculation_service.append_calculation(
        db_session, _payload(sku="SKU-A", sale_price_usd=11.0)
    )
    shop_calculation_service.append_calculation(
        db_session, _payload(sku="SKU-B", sale_price_usd=20.0)
    )

    items, total = shop_calculation_service.list_by_project(
        db_session, project_id=TEST_PROJECT_ID
    )
    assert total == 2
    by_sku = {it.sku: it for it in items}
    assert by_sku["SKU-A"].sale_price_usd == 11.0
    assert by_sku["SKU-B"].sale_price_usd == 20.0


def test_source_and_observed_at_recorded(db_session):
    """source 正确记录；默认 observed_at 由 DB 生成（非空）。"""
    item = shop_calculation_service.append_calculation(
        db_session, _payload(source="agent_listing_pull"), operator="agent"
    )
    assert item.source == "agent_listing_pull"
    assert item.observed_at is not None

    default_item = shop_calculation_service.append_calculation(
        db_session, _payload(sku="SKU-DEF"), operator="tester"
    )
    assert default_item.source == "manual", "source 缺省应为 manual"


def test_explicit_observed_at_is_used(db_session):
    """Agent 补录历史价：显式 observed_at 被采用。"""
    past = datetime(2026, 1, 1, 8, 0, 0, tzinfo=timezone.utc)
    item = shop_calculation_service.append_calculation(
        db_session, _payload(observed_at=past), operator="agent"
    )
    assert item.observed_at == past


def test_soft_delete_group_removes_from_list_but_keeps_history(db_session):
    """软删整组：列表移除该 SKU，历史行保留（带 deleted_at）。"""
    first = shop_calculation_service.append_calculation(
        db_session, _payload(sale_price_usd=10.0)
    )
    second = shop_calculation_service.append_calculation(
        db_session, _payload(sale_price_usd=12.0)
    )

    # 用最新行 id 触发整组软删
    deleted = shop_calculation_service.soft_delete_group(db_session, second.id)
    assert deleted == 2, "应软删该 SKU 组的两行"

    items, total = shop_calculation_service.list_by_project(
        db_session, project_id=TEST_PROJECT_ID
    )
    assert total == 0, "软删后当前态列表应为空"

    # 历史仍在（含已删除）
    history = shop_calculation_service.list_history(
        db_session, project_id=TEST_PROJECT_ID, sku="SKU-A", include_deleted=True
    )
    assert len(history) == 2

    # 默认 history（排除软删）应为空
    visible = shop_calculation_service.list_history(
        db_session, project_id=TEST_PROJECT_ID, sku="SKU-A"
    )
    assert len(visible) == 0

    # 两行都打了 deleted_at
    rows = (
        db_session.query(ShopCalculation)
        .filter(ShopCalculation.project_id == TEST_PROJECT_ID)
        .all()
    )
    assert all(r.deleted_at is not None for r in rows)
    assert {first.id, second.id} == {r.id for r in rows}


def test_history_returns_all_versions_desc(db_session):
    """history 按 observed_at 倒序返回全部版本。"""
    for price in (10.0, 11.0, 12.0):
        shop_calculation_service.append_calculation(
            db_session, _payload(sale_price_usd=price)
        )

    history = shop_calculation_service.list_history(
        db_session, project_id=TEST_PROJECT_ID, sku="SKU-A"
    )
    assert [h.sale_price_usd for h in history] == [12.0, 11.0, 10.0]


def test_create_page_snapshot_copies_latest_only(db_session):
    """页面级快照（聚合多 SKU 成一页）只复制每 SKU 的最新有效行。

    这是用户最关心的：『每次聚合多个 SKU 维度的组合成一个页面』行为保持不变，
    且 append-only 后不会把历史行也复制进去。
    """
    # SKU-A 写两版（10 → 12），SKU-B 写一版（20）
    shop_calculation_service.append_calculation(
        db_session, _payload(sku="SKU-A", sale_price_usd=10.0)
    )
    shop_calculation_service.append_calculation(
        db_session, _payload(sku="SKU-A", sale_price_usd=12.0)
    )
    shop_calculation_service.append_calculation(
        db_session, _payload(sku="SKU-B", sale_price_usd=20.0)
    )

    snapshot = None
    try:
        snapshot = pricing_calculation_snapshot_service.create_snapshot(
            db_session,
            project_id=TEST_PROJECT_ID,
            country="US",
            name="BEL378 测试快照",
            description=None,
            operator="tester",
        )
        # 只有 2 个 SKU 的当前态被复制（不是 3 行历史）
        assert snapshot.row_count == 2

        detail = pricing_calculation_snapshot_service.get_snapshot_items(
            db_session, snapshot.id
        )
        assert detail is not None
        by_sku = {it.sku: it for it in detail.items}
        assert set(by_sku.keys()) == {"SKU-A", "SKU-B"}
        # SKU-A 取最新价 12，而非历史价 10
        assert by_sku["SKU-A"].sale_price_usd == 12.0
        assert by_sku["SKU-B"].sale_price_usd == 20.0
    finally:
        # create_snapshot 内部 commit 了，显式清理避免污染 BLF_test
        if snapshot is not None:
            db_session.execute(
                delete(PricingCalculationSnapshotItem).where(
                    PricingCalculationSnapshotItem.snapshot_id == snapshot.id
                )
            )
            db_session.execute(
                delete(PricingCalculationSnapshot).where(
                    PricingCalculationSnapshot.id == snapshot.id
                )
            )
        db_session.execute(
            delete(ShopCalculation).where(ShopCalculation.project_id == TEST_PROJECT_ID)
        )
        db_session.commit()
