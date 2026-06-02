from __future__ import annotations

import tempfile
from pathlib import Path

import pandas as pd

from app.utils.recognition.recognizers import recognize_file


class TestXlsxRecognitionSignals:
    """xlsx 报表不再走 A 表 ad_product_report / ad_search_term_report。
    这些报表改由 app.services.ad.upload.specs 处理 (B 表 ad_upload_*)。
    shared recognition module (recognize_file) 对 xlsx ad 报表应返回 None。
    """

    def test_ad_product_xlsx_returns_none(self):
        df = pd.DataFrame(
            {
                "开始日期": ["2026-05-18"],
                "结束日期": ["2026-05-18"],
                "广告组合名称": ["No Portfolio"],
                "货币": ["EUR"],
                "广告活动名称": ["A-Full Keywords"],
                "广告组名称": ["广告组 - 3.3.2026 10:48:45.980"],
                "国家/地区": ["德国"],
                "广告sku": ["USQR-Brown-S"],
                "广告asin": ["B0G4NB54T1"],
            }
        )

        tmp = tempfile.NamedTemporaryFile(suffix=".xlsx", delete=False)
        tmp.close()
        path = Path(tmp.name)
        try:
            df.to_excel(path, index=False)
            result = recognize_file(path, country="US", original_filename="已推广商品报告18.xlsx")
            assert result is None, (
                "A 表 ad_product_report 已下线，recognize_file 对 xlsx ad 报表应返回 None，"
                "由 B 表 (app.services.ad.upload.specs) 处理"
            )
        finally:
            path.unlink(missing_ok=True)

    def test_ad_search_term_xlsx_returns_none(self):
        df = pd.DataFrame(
            {
                "开始日期": ["2026-05-18"],
                "结束日期": ["2026-05-18"],
                "投放": ["auto"],
                "客户搜索词": ["test query"],
            }
        )

        tmp = tempfile.NamedTemporaryFile(suffix=".xlsx", delete=False)
        tmp.close()
        path = Path(tmp.name)
        try:
            df.to_excel(path, index=False)
            result = recognize_file(path, country="US", original_filename="search-term.xlsx")
            assert result is None, (
                "A 表 ad_search_term_report 已下线，recognize_file 对 xlsx ad 报表应返回 None"
            )
        finally:
            path.unlink(missing_ok=True)
