from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pandas as pd

from app.services.data.upload.validate import _match_ad_spec


def test_match_new_promoted_product_spec_detects_combined_date_range():
    df = pd.DataFrame([{
        '日期范围': '2026年10月20日 - 2026年10月26日',
        '广告组合名称': '250-C',
        '广告活动名称': 'campaign',
        '广告组名称': 'group',
        '投放广告活动的国家/地区': 'US',
        '推广的商品 SKU-Advertised product SKU': 'SKU-1',
        '推广的商品编号': 'B000000001',
        '展示量': 100,
        '点击量': 5,
        '点击率': 5.0,
        'CPC': 1.0,
        '总成本': 5.0,
    }])

    with patch('app.services.ad.upload.utils._read_dataframe', return_value=df):
        result = _match_ad_spec(Path('promoted.xlsx'), 'ad_promoted_product_report')

    assert result is not None
    assert result['report_type'] == 'ad_promoted_product_report'
    assert result['detected_start_date'] == '2026-10-20'
    assert result['detected_end_date'] == '2026-10-26'
