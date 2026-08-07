"""BLF-475：订单报表解析须提取 item-tax / shipping-tax（VAT 列）。

解析出的行 dict 需带 ``item_tax`` / ``shipping_tax``，供定时报告销售额
含税聚合（DE/UK）消费。报表缺该列时解析为 0。
"""
from __future__ import annotations

from decimal import Decimal
from pathlib import Path

from app.utils.parsers import parse_sales_rows


def _write_tsv(tmp_path: Path, header: list[str], *rows: list[str]) -> Path:
    p = tmp_path / "sales.tsv"
    p.write_text(
        "\t".join(header) + "\n" + "\n".join("\t".join(r) for r in rows) + "\n",
        encoding="utf-8",
    )
    return p


_HEADER = [
    "amazon-order-id",
    "purchase-date",
    "order-status",
    "sku",
    "asin",
    "quantity",
    "item-price",
    "shipping-price",
    "item-tax",
    "shipping-tax",
    "currency",
]


def test_parse_sales_rows_extracts_tax_columns(tmp_path):
    """含 item-tax / shipping-tax 的 DE 订单：正确解析为 item_tax / shipping_tax。"""
    path = _write_tsv(
        tmp_path,
        _HEADER,
        [
            "111-0000001-0000001",
            "2026-07-01T12:00:00+00:00",
            "Shipped",
            "SKU-A",
            "B0TEST00001",
            "1",
            "100.00",
            "10.00",
            "19.00",
            "1.90",
            "EUR",
        ],
    )
    payloads, total, included = parse_sales_rows(path, source_file_id=42, country="DE")
    assert total == 1
    assert included == 1
    assert payloads[0]["item_price"] == Decimal("100.00")
    assert payloads[0]["shipping_price"] == Decimal("10.00")
    assert payloads[0]["item_tax"] == Decimal("19.00")
    assert payloads[0]["shipping_tax"] == Decimal("1.90")


def test_parse_sales_rows_missing_tax_columns_defaults_to_zero(tmp_path):
    """报表没有 item-tax / shipping-tax 列（如 US）：解析为 0，不抛错。"""
    header = [c for c in _HEADER if c not in ("item-tax", "shipping-tax")]
    path = _write_tsv(
        tmp_path,
        header,
        [
            "111-0000002-0000002",
            "2026-07-01T12:00:00+00:00",
            "Shipped",
            "SKU-B",
            "B0TEST00002",
            "2",
            "9.99",
            "0.00",
            "USD",
        ],
    )
    payloads, total, included = parse_sales_rows(path, source_file_id=42, country="US")
    assert total == 1
    assert payloads[0]["item_tax"] == Decimal("0")
    assert payloads[0]["shipping_tax"] == Decimal("0")
