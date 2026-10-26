"""Tests for payment report recognition signals."""
import tempfile
from pathlib import Path

import pandas as pd
import pytest

from app.utils.recognition.patterns import _normalize_columns
from app.utils.recognition.recognizers import recognize_file


def _write_csv(content: str) -> Path:
    """Module-level helper so multiple test classes can reuse it."""
    tmp = tempfile.NamedTemporaryFile(suffix=".csv", delete=False, mode="w", encoding="utf-8")
    tmp.write(content)
    tmp.close()
    return Path(tmp.name)


@pytest.mark.recognition
@pytest.mark.payment_report
class TestPaymentRecognitionSignals:
    """Verify payment report is recognized via different signals."""

    def test_recognizes_by_english_header(self):
        content = (
            "Includes Amazon Marketplace\n"
            "date/time,settlement id,type,order id,sku,description,quantity,marketplace,product sales,shipping credits,promotional rebates,other,selling fees,fba fees\n"
            "2024-01-01,123,Order,111-111-111,ABC-001,Test,1,amazon.com,10.00,1.00,0.00,0.00,1.00,1.00\n"
        )
        path = _write_csv(content)
        try:
            result = recognize_file(path, country="US")
            assert result is not None
            assert result.report_type == "payment_report"
        finally:
            path.unlink()

    def test_recognizes_by_german_header(self):
        content = (
            "Einschließlich Transaktionen zu Amazon Marketplace\n"
            "Datum/Uhrzeit,Abrechnungsnummer,Typ,Bestellnummer,SKU,Beschreibung,Menge,Marketplace,Umsaetze,Gutschrift fuer versandkosten,Rabatte aus werbeaktionen,Andere,Verkaufsgebuehren,Gebuehren zu versand durch amazon\n"
            "2024-01-01,123,Bestellung,111-111-111,ABC-001,Test,1,amazon.de,10,00,1,00,0,00,0,00,1,00,1,00\n"
        )
        path = _write_csv(content)
        try:
            result = recognize_file(path, country="DE")
            assert result is not None
            assert result.report_type == "payment_report"
        finally:
            path.unlink()

    def test_recognizes_by_column_names_without_header_marker(self):
        """No header marker line, but columns match payment report aliases."""
        content = (
            "date/time,settlement id,type,order id,sku,description,quantity,marketplace,product sales,shipping credits,promotional rebates,other,selling fees,fba fees\n"
            "2024-01-01,123,Order,111-111-111,ABC-001,Test,1,amazon.com,10.00,1.00,0.00,0.00,1.00,1.00\n"
        )
        path = _write_csv(content)
        try:
            result = recognize_file(path, country="US")
            assert result is not None
            assert result.report_type == "payment_report"
        finally:
            path.unlink()

    def test_recognizes_de_columns_without_header_marker(self):
        """German payment report without header marker, detected by column names."""
        content = (
            "Datum/Uhrzeit,Abrechnungsnummer,Typ,Bestellnummer,SKU,Beschreibung,Menge,Marketplace,Umsaetze,Gutschrift fuer versandkosten,Rabatte aus werbeaktionen,Andere,Verkaufsgebuehren,Gebuehren zu versand durch amazon\n"
            "2024-01-01,123,Bestellung,111-111-111,ABC-001,Test,1,amazon.de,10,00,1,00,0,00,0,00,1,00,1,00\n"
        )
        path = _write_csv(content)
        try:
            result = recognize_file(path, country="DE")
            assert result is not None
            assert result.report_type == "payment_report"
        finally:
            path.unlink()

    def test_recognizes_by_filename_transaction(self):
        content = (
            "date/time,settlement id,type,order id,sku,description,quantity,marketplace,product sales,shipping credits,promotional rebates,other,selling fees,fba fees\n"
            "2024-01-01,123,Order,111-111-111,ABC-001,Test,1,amazon.com,10.00,1.00,0.00,0.00,1.00,1.00\n"
        )
        path = _write_csv(content)
        try:
            result = recognize_file(path, country="US", original_filename="Transaction_Report_2024.csv")
            assert result is not None
            assert result.report_type == "payment_report"
        finally:
            path.unlink()

    def test_non_payment_csv_returns_none(self):
        """CSV that doesn't match any payment signal should return None."""
        content = (
            "Column1,Column2,Column3,Column4\n"
            "value1,value2,10,100.00\n"
        )
        path = _write_csv(content)
        try:
            result = recognize_file(path, country="US", original_filename="unknown_file.csv")
            assert result is None
        finally:
            path.unlink()


@pytest.mark.recognition
@pytest.mark.business_report
class TestBusinessReportRecognition:
    """Verify business report CSV recognition across Chinese and English headers.

    Regression test for BEL-129: English-locale Amazon Business Reports use
    `(Child) ASIN` / `(Parent) ASIN` headers instead of the Chinese variants,
    which previously caused the file to be classified as "未知报表".
    """

    def test_recognizes_english_child_asin_header(self):
        """English-locale report (e.g. amazon.com UI) with (Child) ASIN column."""
        content = (
            "(Parent) ASIN,(Child) ASIN,Title,Sessions - Total,Units Ordered,"
            "Ordered Product Sales\n"
            "B0F5418WTB,B0F58R5WWS,Test Product,10,1,$28.99\n"
        )
        path = _write_csv(content)
        try:
            result = recognize_file(
                path,
                country="US",
                original_filename="BusinessReport-6-16-26_20260615.csv",
            )
            assert result is not None, "English business report should be recognized"
            assert result.report_type == "business_report"
            # date 20260615 from filename should propagate through
            assert result.detected_date == "2026-06-15"
        finally:
            path.unlink()

    def test_recognizes_chinese_child_asin_header(self):
        """Chinese-locale report (e.g. 亚马逊中文站 UI) with （子）ASIN column."""
        content = (
            "（父）ASIN,（子）ASIN,标题,会话数 - 总计,已订购商品数量,已订购商品销售额\n"
            "B0F5418WTB,B0F58R5WWS,测试商品,10,1,¥100.00\n"
        )
        path = _write_csv(content)
        try:
            result = recognize_file(
                path,
                country="US",
                original_filename="BusinessReport_20260615.csv",
            )
            assert result is not None
            assert result.report_type == "business_report"
        finally:
            path.unlink()


# ─── Inventory Ledger: Summary (22 列) / Detail (16 列) 互斥识别 ─────────────
# 真实文件表头：库存分类账 2026-03一览视图.csv（Summary）/ 库存分类账-2026-03详细视图.csv（Detail）。

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


@pytest.mark.recognition
class TestInventoryLedgerRecognition:
    """Amazon 库存分类账 Summary/Detail 识别为两个互斥类型（BEL-428）。"""

    def test_recognize_inventory_ledger_summary_header(self):
        content = (
            ",".join(INVENTORY_LEDGER_SUMMARY_HEADERS)
            + "\n"
            + _INVENTORY_LEDGER_SUMMARY_ROW
            + "\n"
        )
        path = _write_csv(content)
        try:
            result = recognize_file(
                path, country="US", original_filename="库存分类账 2026-03一览视图.csv"
            )
            assert result is not None
            assert result.report_type == "inventory_ledger_summary"
        finally:
            path.unlink()

    def test_summary_month_only_date_and_numeric_filename(self):
        """Summary 的 Date 可能只有月份；纯数字文件名不能被误识别成日期。"""
        content = (
            ",".join(INVENTORY_LEDGER_SUMMARY_HEADERS)
            + "\n"
            + _INVENTORY_LEDGER_SUMMARY_ROW.replace("03/01/2026", "08/2026")
            + "\n"
        )
        path = _write_csv(content)
        try:
            result = recognize_file(
                path, country="US", original_filename="99538020752.csv"
            )
            assert result is not None
            assert result.report_type == "inventory_ledger_summary"
            assert result.date_input_mode == "single_auto"
            assert result.detected_date == "2026-08-01"
            assert result.detected_start_date is None
            assert result.detected_end_date is None
        finally:
            path.unlink()

    def test_recognize_inventory_ledger_detail_header(self):
        content = (
            ",".join(INVENTORY_LEDGER_DETAIL_HEADERS)
            + "\n"
            + _INVENTORY_LEDGER_DETAIL_ROW
            + "\n"
        )
        path = _write_csv(content)
        try:
            result = recognize_file(
                path, country="US", original_filename="库存分类账-2026-03详细视图.csv"
            )
            assert result is not None
            assert result.report_type == "inventory_ledger_detail"
        finally:
            path.unlink()

    def test_detail_numeric_filename_does_not_override_file_dates(self):
        """纯数字文件名不得覆盖 Detail Date 列中识别出的有效日期。"""
        content = (
            ",".join(INVENTORY_LEDGER_DETAIL_HEADERS)
            + "\n"
            + _INVENTORY_LEDGER_DETAIL_ROW
            + "\n"
        )
        path = _write_csv(content)
        try:
            result = recognize_file(
                path, country="US", original_filename="99539020752.csv"
            )
            assert result is not None
            assert result.report_type == "inventory_ledger_detail"
            assert result.detected_date == "2026-03-01"
            assert result.detected_start_date == "2026-03-01"
            assert result.detected_end_date == "2026-03-01"
        finally:
            path.unlink()

    def test_detail_does_not_fall_back_to_business_report(self):
        content = (
            ",".join(INVENTORY_LEDGER_DETAIL_HEADERS)
            + "\n"
            + _INVENTORY_LEDGER_DETAIL_ROW
            + "\n"
        )
        path = _write_csv(content)
        try:
            result = recognize_file(
                path, country="US", original_filename="库存分类账-2026-03详细视图.csv"
            )
            assert result is not None
            assert result.report_type != "business_report"
        finally:
            path.unlink()

    def test_ledger_never_emits_legacy_inventory_ledger_type(self):
        """recognizer 对任何新文件都不再输出旧 inventory_ledger 类型。"""
        for headers, row in (
            (INVENTORY_LEDGER_SUMMARY_HEADERS, _INVENTORY_LEDGER_SUMMARY_ROW),
            (INVENTORY_LEDGER_DETAIL_HEADERS, _INVENTORY_LEDGER_DETAIL_ROW),
        ):
            content = ",".join(headers) + "\n" + row + "\n"
            path = _write_csv(content)
            try:
                result = recognize_file(path, country="US")
                assert result is not None
                assert result.report_type != "inventory_ledger"
            finally:
                path.unlink()

    def test_summary_missing_column_raises_with_missing_names(self):
        headers = list(INVENTORY_LEDGER_SUMMARY_HEADERS)
        headers.remove("Ending Warehouse Balance")
        content = ",".join(headers) + "\n" + _INVENTORY_LEDGER_SUMMARY_ROW + "\n"
        path = _write_csv(content)
        try:
            with pytest.raises(ValueError) as exc:
                recognize_file(
                    path, country="US", original_filename="库存分类账 2026-03一览视图.csv"
                )
            assert "Summary" in str(exc.value)
            assert "ending warehouse balance" in str(exc.value)
        finally:
            path.unlink()

    def test_detail_missing_column_raises_with_missing_names(self):
        headers = list(INVENTORY_LEDGER_DETAIL_HEADERS)
        headers.remove("Fulfillment Center")
        content = ",".join(headers) + "\n" + _INVENTORY_LEDGER_DETAIL_ROW + "\n"
        path = _write_csv(content)
        try:
            with pytest.raises(ValueError) as exc:
                recognize_file(
                    path, country="US", original_filename="库存分类账-2026-03详细视图.csv"
                )
            assert "Detail" in str(exc.value)
            assert "fulfillment center" in str(exc.value)
        finally:
            path.unlink()

    def test_both_signatures_conflict_raises(self):
        """同时包含 Summary 与 Detail 完整签名 → 结构化拒绝，不落入 business_report。"""
        combined = list(INVENTORY_LEDGER_SUMMARY_HEADERS) + [
            h
            for h in INVENTORY_LEDGER_DETAIL_HEADERS
            if h not in INVENTORY_LEDGER_SUMMARY_HEADERS
        ]
        content = ",".join(combined) + "\n" + _INVENTORY_LEDGER_SUMMARY_ROW + "\n"
        path = _write_csv(content)
        try:
            with pytest.raises(ValueError) as exc:
                recognize_file(path, country="US")
            assert "冲突" in str(exc.value)
        finally:
            path.unlink()

    def test_quantity_only_column_is_not_treated_as_ledger(self):
        """只有 quantity 一个 Detail 强特征列的 CSV 不应被当作库存分类账。

        回归：其它 Amazon 导出（普通商品 CSV）也含 "quantity" 列，单列命中
        不足以认定与库存分类账相关。应返回 None（落入未知报表），既不是
        LedgerRecognitionError，也不是 business_report。
        """
        content = (
            "date,sku,quantity,price\n"
            "2026-03-01,MSKU-001,10,19.99\n"
        )
        path = _write_csv(content)
        try:
            result = recognize_file(
                path, country="US", original_filename="inventory_2026-03.csv"
            )
            assert result is None, (
                "仅含 quantity 列的 CSV 应落入未知报表（None），"
                f"实际返回 {result.report_type if result else result}"
            )
        finally:
            path.unlink()

    def test_detail_two_strong_markers_incomplete_raises(self):
        """Detail 强特征命中 2 列但不完整 → 仍按部分签名拒绝。

        两列阈值不弱化真实 Detail 部分签名的拒绝：event type + quantity
        均出现但缺 fulfillment center 时，仍抛 LedgerRecognitionError。
        """
        headers = ["date", "msku", "event type", "quantity", "disposition"]
        content = (
            ",".join(headers)
            + "\n"
            + "03/01/2026,MSKU-001,Shipments,-1,SELLABLE\n"
        )
        path = _write_csv(content)
        try:
            with pytest.raises(ValueError) as exc:
                recognize_file(path, country="US")
            assert "Detail" in str(exc.value)
            assert "fulfillment center" in str(exc.value)
        finally:
            path.unlink()

    def test_summary_and_detail_strong_markers_conflict_raises(self):
        """Summary 强特征与 Detail 强特征（≥2 列）并存 → 冲突拒绝。"""
        content = (
            "date,msku,event type,quantity,starting warehouse balance\n"
            "03/01/2026,MSKU-001,Shipments,-1,100\n"
        )
        path = _write_csv(content)
        try:
            with pytest.raises(ValueError) as exc:
                recognize_file(path, country="US")
            assert "冲突" in str(exc.value)
        finally:
            path.unlink()

    def test_normalized_headers_match_space_separated_signature_names(self):
        """签名用空格分隔（非下划线）：_normalize_columns 只做 strip+lower。

        证明选择：真实表头 "Starting Warehouse Balance" 经 _normalize_columns
        后为 "starting warehouse balance"，下划线形式（ingestion 层的
        _normalize_header 才生成）不会出现在 recognizer 的标准化列名里。
        """
        summary_cols = set(
            _normalize_columns(pd.DataFrame(columns=INVENTORY_LEDGER_SUMMARY_HEADERS)).columns
        )
        detail_cols = set(
            _normalize_columns(pd.DataFrame(columns=INVENTORY_LEDGER_DETAIL_HEADERS)).columns
        )
        assert "starting warehouse balance" in summary_cols
        assert "ending warehouse balance" in summary_cols
        assert "starting_warehouse_balance" not in summary_cols
        assert {"event type", "quantity", "fulfillment center"} <= detail_cols
        assert "event_type" not in detail_cols
