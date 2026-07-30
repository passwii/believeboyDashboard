"""Tests for ``app.services.shipment.sku_sort.natural_sku_sort_key``.

覆盖 FBA 箱单明细 SKU 排序规则：
- ``-`` 字符按"字母之后、数字之后"参与排序
- 其他字符完全保持 Python 默认 str 字典序（含大小写敏感）
- 空字符串边界

设计动机：用户(2026-07-29)反馈 ``NEW-ELTB-002BEG-Q`` 这种带 ``-`` 的 SKU 会被排到
``NEW-ELTB-002BEGTR/TW``（无 ``-`` 的主 SKU 续段）前面，导致标签号段不连续。
规则：把 ``-`` 替换为 ASCII 0x7F（DEL，控制字符），``\x7f`` 在字典序中位于所有字母 + 数字之后。
"""

from __future__ import annotations

from datetime import date

from app.services.shipment.sku_sort import natural_sku_sort_key, sort_skus


def test_three_eltab_skus_puts_dash_variant_last():
    """用户原始诉求：TR / TW / -Q 三者排成 TR → TW → Q。"""
    skus = [
        "NEW-ELTB-002BEG-Q",
        "NEW-ELTB-002BEGTR",
        "NEW-ELTB-002BEGTW",
    ]
    assert sort_skus(skus) == [
        "NEW-ELTB-002BEGTR",
        "NEW-ELTB-002BEGTW",
        "NEW-ELTB-002BEG-Q",
    ]


def test_dash_variant_sinks_after_main_sku_extension():
    """主 SKU 续段（无 ``-``）排前，变体（带 ``-`` 后缀）沉底。"""
    skus = ["ABC-1", "ABC1"]
    assert sort_skus(skus) == ["ABC1", "ABC-1"]


def test_pure_alpha_sku_unchanged():
    """无数字无 ``-`` 的纯字母 SKU，等价于默认字典序。"""
    skus = ["XYZ", "ABC", "DEF"]
    assert sort_skus(skus) == ["ABC", "DEF", "XYZ"]


def test_case_sensitive_preserves_existing_behavior():
    """保持现有区分大小写：A (0x41) < a (0x61)，全大写在前。"""
    skus = ["abc", "Abc", "ABC"]
    assert sort_skus(skus) == ["ABC", "Abc", "abc"]


def test_empty_string_does_not_crash():
    """空字符串作为边界，不崩，返回空字符串（最小）。"""
    assert natural_sku_sort_key("") == ""
    assert sort_skus(["", "A", "B"]) == ["", "A", "B"]


def test_composite_key_with_item_date_and_id():
    """模拟 schedule.py 的 sort key: (item_date, sku, id)。
    SKU 段用 natural_sku_sort_key 替换默认字符串序，日期与 id 兜底。
    """
    rows = [
        # (item_date, sku, id)
        (date(2026, 7, 29), "NEW-ELTB-002BEG-Q", 3),
        (date(2026, 7, 29), "NEW-ELTB-002BEGTR", 1),
        (date(2026, 7, 29), "NEW-ELTB-002BEGTW", 2),
        # 不同日期的 SKU：日期优先
        (date(2026, 7, 28), "ANY", 99),
    ]
    ranked = sorted(
        rows,
        key=lambda r: (r[0], natural_sku_sort_key(r[1]), r[2]),
    )
    assert [r[1] for r in ranked] == [
        "ANY",  # 7-28
        "NEW-ELTB-002BEGTR",  # 7-29
        "NEW-ELTB-002BEGTW",
        "NEW-ELTB-002BEG-Q",
    ]
    # 同 SKU 时 id 兜底
    rows_same_sku = [
        (date(2026, 7, 29), "ABC", 5),
        (date(2026, 7, 29), "ABC", 2),
        (date(2026, 7, 29), "ABC", 8),
    ]
    ranked_same = sorted(
        rows_same_sku,
        key=lambda r: (r[0], natural_sku_sort_key(r[1]), r[2]),
    )
    assert [r[2] for r in ranked_same] == [2, 5, 8]


def test_key_returns_replaced_string():
    """natural_sku_sort_key 直接返回替换后的字符串，便于审查。"""
    assert natural_sku_sort_key("ABC-1") == "ABC\x7f1"
    assert natural_sku_sort_key("A-B-C") == "A\x7fB\x7fC"
