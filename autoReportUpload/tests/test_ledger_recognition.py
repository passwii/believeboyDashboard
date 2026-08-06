"""RPA recognition: 库存分类账 Summary / Detail 必须识别为两个独立类型。

表头形状与 backend/tests/utils/recognition/test_recognizers.py 中的真实文件
签名保持一致（库存分类账 2026-03一览视图.csv 22 列 / 库存分类账-2026-03详细视图.csv
16 列），识别结果必须与后端 recognizer 一致。
"""
from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import pytest

from recognition import recognize_file

# ─── 真实文件表头（与 backend 识别测试同源）───────────────────────────────────

INVENTORY_LEDGER_SUMMARY_HEADERS = [
    "Date",
    "FNSKU",
    "ASIN",
    "MSKU",
    "Title",
    "Disposition",
    "Starting Warehouse Balance",
    "In Transit Between Warehouses",
    "Receipts",
    "Customer Shipments",
    "Customer Returns",
    "Vendor Returns",
    "Warehouse Transfer In/Out",
    "Found",
    "Lost",
    "Damaged",
    "Disposed",
    "Other Events",
    "Ending Warehouse Balance",
    "Unknown Events",
    "Location",
    "Store",
]

INVENTORY_LEDGER_DETAIL_HEADERS = [
    "Date",
    "FNSKU",
    "ASIN",
    "MSKU",
    "Title",
    "Event Type",
    "Reference ID",
    "Quantity",
    "Fulfillment Center",
    "Disposition",
    "Reason",
    "Country",
    "Reconciled Quantity",
    "Unreconciled Quantity",
    "Date and Time",
    "Store",
]

_INVENTORY_LEDGER_SUMMARY_ROW = (
    "03/01/2026,X00ABC,B0001,MSKU-001,Test Item,SELLABLE,"
    "100,0,0,5,0,0,0,0,0,0,0,0,95,0,LAX1,Bel-Bel"
)
_INVENTORY_LEDGER_DETAIL_ROW = (
    "03/01/2026,X00ABC,B0001,MSKU-001,Test Item,Shipments,REF-123,"
    "-1,LAX1,SELLABLE,,US,,-1,2026-03-01T00:00:00-0700,"
)


def _write_csv(tmp_path: Path, project_folder: str, name: str, headers, row: str) -> Path:
    """写入一份 RPA 目录布局下的 CSV（项目文件夹内），返回文件路径。"""
    path = tmp_path / project_folder / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(",".join(headers) + "\n" + row + "\n", encoding="utf-8")
    return path


def _stub_db(*, project_name: str | None = None, matched_projects: list[str] | None = None) -> MagicMock:
    """MagicMock DB：MSKU 内容匹配查不到 → 目录名 fallback 命中 project_name。"""
    db = MagicMock()
    db.execute.return_value.scalars.return_value.all.return_value = list(matched_projects or [])
    if project_name is not None:
        db.execute.return_value.scalars.return_value.first.return_value = MagicMock(
            project_name=project_name
        )
    else:
        db.execute.return_value.scalars.return_value.first.return_value = None
    return db


class TestRpaInventoryLedgerRecognition:
    """RPA 识别必须输出与后端相同的两个独立类型（BEL-428）。"""

    def test_rpa_summary_uses_summary_ledger_path(self, tmp_path):
        path = _write_csv(
            tmp_path,
            "测试项目",
            "库存分类账 2026-03一览视图.csv",
            INVENTORY_LEDGER_SUMMARY_HEADERS,
            _INVENTORY_LEDGER_SUMMARY_ROW,
        )
        result = recognize_file(_stub_db(project_name="测试项目"), path, country="US",
                                original_filename=path.name)
        assert result is not None
        assert result.report_type == "inventory_ledger_summary"

    def test_rpa_detail_uses_detail_ledger_path(self, tmp_path):
        path = _write_csv(
            tmp_path,
            "测试项目",
            "库存分类账-2026-03详细视图.csv",
            INVENTORY_LEDGER_DETAIL_HEADERS,
            _INVENTORY_LEDGER_DETAIL_ROW,
        )
        result = recognize_file(_stub_db(project_name="测试项目"), path, country="US",
                                original_filename=path.name)
        assert result is not None
        assert result.report_type == "inventory_ledger_detail"

    def test_rpa_detail_never_falls_back_to_business_report(self, tmp_path):
        path = _write_csv(
            tmp_path,
            "测试项目",
            "库存分类账-2026-03详细视图.csv",
            INVENTORY_LEDGER_DETAIL_HEADERS,
            _INVENTORY_LEDGER_DETAIL_ROW,
        )
        result = recognize_file(_stub_db(project_name="测试项目"), path, country="US",
                                original_filename=path.name)
        assert result is not None
        assert result.report_type != "business_report"

    def test_rpa_ledger_project_match_by_msku_content(self, tmp_path):
        """MSKU 列命中 ProductCost.sku → matched（不是 manual/UnboundLocalError）。"""
        path = _write_csv(
            tmp_path,
            "测试项目",
            "库存分类账 2026-03一览视图.csv",
            INVENTORY_LEDGER_SUMMARY_HEADERS,
            _INVENTORY_LEDGER_SUMMARY_ROW,
        )
        db = _stub_db(matched_projects=["测试项目"])
        result = recognize_file(db, path, country="US", original_filename=path.name)
        assert result is not None
        assert result.project_match is not None
        assert result.project_match["status"] == "matched"
        assert result.project_match["project_name"] == "测试项目"

    def test_rpa_ledger_project_match_folder_fallback_when_msku_unknown(self, tmp_path):
        """MSKU 查不到时按目录名匹配项目，状态不能是 manual（回归 UnboundLocalError）。"""
        path = _write_csv(
            tmp_path,
            "测试项目",
            "库存分类账-2026-03详细视图.csv",
            INVENTORY_LEDGER_DETAIL_HEADERS,
            _INVENTORY_LEDGER_DETAIL_ROW,
        )
        db = _stub_db(project_name="测试项目")
        result = recognize_file(db, path, country="US", original_filename=path.name)
        assert result is not None
        assert result.project_match is not None
        assert result.project_match["status"] != "manual"
        assert result.project_match["status"] == "matched"
        assert result.project_match["project_name"] == "测试项目"

    def test_rpa_ledger_chinese_filename_does_not_affect_recognition(self, tmp_path):
        """中文文件名不影响识别（库存分类账 2026-03一览视图.csv 等）。"""
        path = _write_csv(
            tmp_path,
            "测试项目",
            "库存分类账 2026-03一览视图.csv",
            INVENTORY_LEDGER_SUMMARY_HEADERS,
            _INVENTORY_LEDGER_SUMMARY_ROW,
        )
        result = recognize_file(_stub_db(project_name="测试项目"), path, country="US",
                                original_filename=path.name)
        assert result is not None
        assert result.report_type == "inventory_ledger_summary"
