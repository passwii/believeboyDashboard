"""Tests for the inventory ledger field glossary (BLF-431).

Locks the EN column name → CN label contract for the two BEL-428 tables:

* ``LedgerSummaryRow`` — 22 business fields (Amazon Summary 一览视图表头)
* ``LedgerDetailRow`` — 16 business fields (Amazon Detailed 详细视图表头)

Each assertion guards against doc drift: if a column is renamed in
migration 235 / the Pydantic model, or a CN label is dropped, these tests
fail. Canonical glossary lives in
``docs/superpowers/specs/2026-08-14-inventory-ledger-field-glossary.md``.
"""

from __future__ import annotations

import re

from app.schemas.inventory_ledger import (
    LedgerDetailRow,
    LedgerSummaryRow,
)

_CJK_RE = re.compile(r"[\u4e00-\u9fff]")

# field name → 中文 label。
# 与 backend/alembic/versions/20260805_235_inventory_ledger_dual_tables.py
# 中两张表的实际列名一一对应。date/fnsku/asin/msku/title/disposition/store
# 为两表共享列，各自出现在两份词典中（合计 22 + 16 = 38 个业务字段）。
SUMMARY_GLOSSARY: dict[str, str] = {
    "date": "日期",
    "fnsku": "FNSKU",
    "asin": "ASIN",
    "msku": "MSKU",
    "title": "品名",
    "disposition": "处置状态",
    "location": "仓库",
    "starting_balance": "期初库存",
    "in_transit_between": "在途库存",
    "receipts": "入库",
    "customer_shipments": "客户发货",
    "customer_returns": "客户退货",
    "vendor_returns": "供应商退货",
    "warehouse_transfer_io": "仓库调拨",
    "found": "盘盈",
    "lost": "盘亏",
    "damaged": "损坏",
    "disposed": "报废",
    "other_events": "其他事件",
    "ending_balance": "期末库存",
    "unknown_events": "未知事件",
    "store": "店铺",
}

DETAIL_GLOSSARY: dict[str, str] = {
    "date": "日期",
    "fnsku": "FNSKU",
    "asin": "ASIN",
    "msku": "MSKU",
    "title": "品名",
    "event_type": "事件类型",
    "reference_id": "参考编号",
    "quantity": "数量",
    "fulfillment_center": "履约中心",
    "disposition": "处置状态",
    "reason": "原因",
    "country": "国家/地区",
    "reconciled_quantity": "已对账数量",
    "unreconciled_quantity": "未对账数量",
    "date_and_time": "日期时间",
    "store": "店铺",
}

# 两张表共享的技术字段（不属于 38 业务字段，但也出现在 JSON schema 输出中）
TECHNICAL_FIELDS = {"id": "记录 ID", "batch_id": "上传批次 ID"}


def test_glossary_covers_38_business_fields():
    """38 = 22 summary + 16 detail, exactly as scoped in BLF-431."""
    assert len(SUMMARY_GLOSSARY) == 22
    assert len(DETAIL_GLOSSARY) == 16
    # 两表共享 7 列（date/fnsku/asin/msku/title/disposition/store）
    shared = set(SUMMARY_GLOSSARY) & set(DETAIL_GLOSSARY)
    assert len(shared) == 7
    distinct = set(SUMMARY_GLOSSARY) | set(DETAIL_GLOSSARY)
    assert len(distinct) == 31


def test_summary_fields_match_glossary_and_technical():
    expected = set(SUMMARY_GLOSSARY) | set(TECHNICAL_FIELDS)
    assert set(LedgerSummaryRow.model_fields) == expected


def test_detail_fields_match_glossary_and_technical():
    expected = set(DETAIL_GLOSSARY) | set(TECHNICAL_FIELDS)
    assert set(LedgerDetailRow.model_fields) == expected


def test_summary_descriptions_are_chinese_labels():
    for field_name, label in SUMMARY_GLOSSARY.items():
        desc = LedgerSummaryRow.model_fields[field_name].description
        assert desc == label, f"summary.{field_name} description != {label!r}"


def test_detail_descriptions_are_chinese_labels():
    for field_name, label in DETAIL_GLOSSARY.items():
        desc = LedgerDetailRow.model_fields[field_name].description
        assert desc == label, f"detail.{field_name} description != {label!r}"


def test_technical_descriptions_are_chinese():
    for model in (LedgerSummaryRow, LedgerDetailRow):
        for field_name, label in TECHNICAL_FIELDS.items():
            desc = model.model_fields[field_name].description
            assert desc == label


def test_json_schema_emits_chinese_descriptions():
    """验收标准：model.json_schema() 输出的 description 字段是中文。"""
    for model, glossary in (
        (LedgerSummaryRow, SUMMARY_GLOSSARY),
        (LedgerDetailRow, DETAIL_GLOSSARY),
    ):
        schema = model.model_json_schema()
        for field_name, label in glossary.items():
            desc = schema["properties"][field_name].get("description", "")
            assert desc == label, (
                f"{model.__name__}.{field_name} schema desc != {label!r}"
            )
        # 技术字段也应有中文描述
        for field_name in TECHNICAL_FIELDS:
            desc = schema["properties"][field_name].get("description", "")
            assert _CJK_RE.search(desc), (
                f"{model.__name__}.{field_name} desc not Chinese"
            )


def test_no_english_description_leak():
    """所有字段描述必须含中文，除 FNSKU/ASIN/MSKU 三个标识符（刻意保留英文）。"""
    # 标识符字段刻意保留英文（对应亚马逊原生列名，不做翻译）
    ascii_allowed = {"fnsku", "asin", "msku"}
    for model in (LedgerSummaryRow, LedgerDetailRow):
        for field_name, field_info in model.model_fields.items():
            desc = field_info.description or ""
            if field_name in ascii_allowed:
                assert desc == field_name.upper(), (
                    f"{model.__name__}.{field_name} != {field_name.upper()!r}"
                )
            else:
                assert _CJK_RE.search(desc), (
                    f"{model.__name__}.{field_name} has no CJK description"
                )
