from __future__ import annotations

from datetime import date
from decimal import Decimal
from unittest.mock import MagicMock

import pandas as pd

from app.services.ad.upload.persistence import _ingest_promoted_product_rows


def test_ingest_new_promoted_product_columns_into_existing_row_fields():
    db = MagicMock()
    df = pd.DataFrame([{
        '日期范围': '2026年10月26日 - 2026年10月26日',
        '广告组合名称': '250-C',
        '预算货币': 'USD',
        '广告活动名称': 'campaign',
        '广告组名称': 'group',
        '投放广告活动的国家/地区': 'US',
        '推广的商品 SKU-Advertised product SKU': 'SKU-1',
        '推广的商品编号': 'B000000001',
        '展示量': 1200,
        '点击量': 24,
        '点击率': 0.6829,
        'CPC': 1.25,
        '总成本': 30.0,
        '销售额': 300.0,
        '归因于点击的 ROAS': 10.0,
        '购买量': 3,
        '由点击产生的已售商品数量': 4,
        '点击购买率': 12.5,
        '已售商品数量（推广）': 3,
        '已售商品数量（光环）': 1,
        '推广商品的销量': 250.0,
        '销售额（光环）': 50.0,
    }])

    _ingest_promoted_product_rows(db, source_file_id=42, df=df)
    row = db.add.call_args.args[0]

    assert row.report_start_date == date(2026, 10, 26)
    assert row.report_end_date == date(2026, 10, 26)
    assert row.campaign_name == 'campaign'
    assert row.ad_group_name == 'group'
    assert row.ad_sku == 'SKU-1'
    assert row.ad_asin == 'B000000001'
    assert row.impressions == 1200
    assert row.clicks == 24
    assert row.ctr == Decimal('0.006829')
    assert row.cpc == Decimal('1.25')
    assert row.spend == Decimal('30.0')
    assert row.orders_7d == 3
    assert row.units_7d == 4
    assert row.sales_7d == Decimal('300.0')
    assert row.acos == Decimal('0.1')
    assert row.roas == Decimal('10.0')
    assert row.cvr_7d == Decimal('0.125')
    assert row.ad_sku_units_7d == 3
    assert row.other_sku_units_7d == 1
    assert row.ad_sku_sales_7d == Decimal('250.0')
    assert row.other_sku_sales_7d == Decimal('50.0')
    assert row.country == 'US'
    assert row.currency == 'USD'
    assert row.portfolio_name == '250-C'
    assert row.raw_row['日期范围'] == '2026年10月26日 - 2026年10月26日'


def test_ingest_new_percentage_columns_and_infer_acos():
    db = MagicMock()
    df = pd.DataFrame([{
        '日期范围': '2026年10月26日 - 2026年10月26日',
        '广告活动名称': 'campaign',
        '广告组名称': 'group',
        '推广的商品 SKU-Advertised product SKU': 'SKU-3',
        '推广的商品编号': 'B000000003',
        '展示量': 200,
        '点击量': 20,
        '点击率': 10.0,
        'CPC': 1.5,
        '总成本': 30.0,
        '销售额': 300.0,
        '归因于点击的 ROAS': 10.0,
        '购买量': 2,
        '由点击产生的已售商品数量': 2,
        '点击购买率': 10.0,
    }])

    _ingest_promoted_product_rows(db, source_file_id=44, df=df)
    row = db.add.call_args.args[0]

    assert row.ctr == Decimal('0.1')
    assert row.cvr_7d == Decimal('0.1')
    assert row.acos == Decimal('0.1')


def test_ingest_localized_promoted_product_country_as_iso_code():
    db = MagicMock()
    df = pd.DataFrame([{
        '日期范围': '2026年10月26日 - 2026年10月26日',
        '广告活动名称': 'campaign',
        '广告组名称': 'group',
        '投放广告活动的国家/地区': '德国',
        '推广的商品 SKU-Advertised product SKU': 'SKU-DE',
        '推广的商品编号': 'B000000004',
        '展示量': 100,
        '点击量': 1,
        '点击率': 1.0,
        'CPC': 1.0,
        '总成本': 1.0,
    }])

    _ingest_promoted_product_rows(db, source_file_id=45, df=df)
    row = db.add.call_args.args[0]

    assert row.country == 'DE'


def test_ingest_legacy_promoted_product_columns_remain_supported():
    db = MagicMock()
    df = pd.DataFrame([{
        '开始日期': '2026-10-26',
        '结束日期': '2026-10-26',
        '广告活动名称': 'legacy campaign',
        '广告组名称': 'legacy group',
        '广告SKU': 'SKU-OLD',
        '广告ASIN': 'B000000002',
        '展示量': 100,
        '点击量': 5,
        '点击率 (CTR)': 0.05,
        '花费': 4.0,
        '单次点击成本 (CPC)': 0.8,
        '7天总订单数(#)': 2,
        '7天总销售量(#)': 2,
        '7天总销售额': 40.0,
        '广告投入产出比 (ACOS) 总计': 0.1,
        '总广告投资回报率 (ROAS)': 10.0,
        '7天的转化率': 0.4,
        '7天内广告SKU销售量(#)': 2,
        '7天内其他SKU销售量(#)': 1,
        '7天内广告SKU销售额': 30.0,
        '7天内其他SKU销售额': 10.0,
        '国家/地区': 'US',
        '货币': 'USD',
        '广告组合名称': 'legacy portfolio',
    }])

    _ingest_promoted_product_rows(db, source_file_id=43, df=df)
    row = db.add.call_args.args[0]

    assert row.ad_sku == 'SKU-OLD'
    assert row.ctr == Decimal('0.05')
    assert row.spend == Decimal('4.0')
    assert row.acos == Decimal('0.1')
    assert row.cvr_7d == Decimal('0.4')
    assert row.raw_row['广告SKU'] == 'SKU-OLD'
