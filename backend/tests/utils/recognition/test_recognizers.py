"""Tests for payment report recognition signals."""
import tempfile
from pathlib import Path

import pytest

from app.utils.recognition.recognizers import recognize_file


def _write_csv(content: str) -> Path:
    """Module-level helper so multiple test classes can reuse it."""
    tmp = tempfile.NamedTemporaryFile(suffix=".csv", delete=False, mode="w", encoding="utf-8")
    tmp.write(content)
    tmp.close()
    return Path(tmp.name)


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
