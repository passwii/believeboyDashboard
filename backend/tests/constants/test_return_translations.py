"""退货翻译常量库的覆盖率与回归测试（BLF-1074）。

背景：`return-analysis` 页面的退货原因翻译只覆盖 14 个 code，生产库
（``analysis_return_rows``，2026-09-15 盘点 1945 行）里 26 个 reason 取值中有
16 个（488 行，25%）落回英文原文。根因不是"漏了几个词"，而是缺少一层防线——
常量库可以任意残缺而不被发现，因为漏译的默认行为就是 `返回原文`，测试也不会红。

本文件把"漏译"变成可检测错误：
- `test_live_reason_codes_are_all_translated` 用**生产库实际盘点清单**做断言，
  新增 code 若没配译文立即失败（这是防回归的主力）；
- `test_amazon_documented_codes_are_covered` 用 Amazon 文档全集防止"只补库内
  出现的、下一批报表又漏"；
- 前缀 / 别名 / 空值 / 未知值行为单独锁定。

纯常量测试：不连数据库、不需要 `TEST_DATABASE_URL`。
"""

from __future__ import annotations

import pytest

from app.constants.return_translations import (
    DETAILED_DISPOSITION_TRANSLATIONS,
    RETURN_REASON_TRANSLATIONS,
    RETURN_STATUS_TRANSLATIONS,
    has_return_reason_translation,
    translate_detailed_disposition,
    translate_return_field,
    translate_return_reason,
    translate_return_status,
)

# 生产库 ``analysis_return_rows`` 的实际 reason 取值盘点（2026-09-15）。
# 26 个 code，按行数倒序。这份清单是"用户肉眼在页面上会看到的"全集，
# 也就是说：任何一个 code 漏译，页面上就有一段英文裸露。
LIVE_REASON_CODES = [
    "DEFECTIVE",
    "UNWANTED_ITEM",
    "NOT_AS_DESCRIBED",
    "APPAREL_TOO_LARGE",
    "ORDERED_WRONG_ITEM",
    "APPAREL_TOO_SMALL",
    "UNDELIVERABLE_UNKNOWN",
    "DAMAGED_BY_FC",
    "QUALITY_UNACCEPTABLE",
    "NO_REASON_GIVEN",
    "MISSING_PARTS",
    "DID_NOT_LIKE_FABRIC",
    "NOT_COMPATIBLE",
    "MISSED_ESTIMATED_DELIVERY",
    "FOUND_BETTER_PRICE",
    "SWITCHEROO",
    "UNAUTHORIZED_PURCHASE",
    "POOR_FIT",
    "NEVER_ARRIVED",
    "APPAREL_STYLE",
    "UNDELIVERABLE_REFUSED",
    "DAMAGED_BY_CARRIER",
    "DID_NOT_LIKE_COLOR",
    "PART_NOT_COMPATIBLE",
    "EXTRA_ITEM",
    "MISORDERED",
]

# 生产库 detailed-disposition 实际取值（4 个）。
LIVE_DISPOSITION_CODES = [
    "SELLABLE",
    "CUSTOMER_DAMAGED",
    "DEFECTIVE",
    "CARRIER_DAMAGED",
]

# 生产库 status 实际取值（5 个，含两种命名风格）。
LIVE_STATUS_CODES = [
    "Unit returned to inventory",
    "IMMEDIATE_LIQUIDATION",
    "IMMEDIATE_DONATION",
    "IMMEDIATE_DISPOSAL",
    "Reimbursed",
]

# Amazon FBA Customer Returns report 文档里的 reason code 全集（含库内未出现、
# 未来可能出现的 code）。补这份清单是为了不在"下一批报表新增 code"时重演漏译。
DOCUMENTED_REASON_CODES = [
    "ACTIVATION_FAILURE",
    "CARRIER_BILL_NOT_AS_EXPECTED",
    "CARRIER_SWITCHING_COST",
    "DAMAGED_BY_CARRIER",
    "DAMAGED_BY_FC",
    "DEFECTIVE",
    "DID_NOT_LIKE_COLOR",
    "DID_NOT_LIKE_FABRIC",
    "EXCESSIVE_INSTALLATION",
    "EXTRA_ITEM",
    "FOUND_BETTER_PRICE",
    "JEWELRY_BAD_CLASP",
    "JEWELRY_BATTERY",
    "JEWELRY_LOOSE_STONE",
    "JEWELRY_NO_CERT",
    "JEWELRY_NO_DOCS",
    "JEWELRY_TOO_LARGE",
    "JEWELRY_TOO_SMALL",
    "MISORDERED",
    "MISSED_ESTIMATED_DELIVERY",
    "MISSING_PARTS",
    "NEVER_ARRIVED",
    "NO_REASON_GIVEN",
    "NOT_AS_DESCRIBED",
    "NOT_AS_PHOTO",
    "NOT_COMFORTABLE",
    "NOT_COMPATIBLE",
    "ORDERED_WRONG_ITEM",
    "OTHER",
    "PART_NOT_COMPATIBLE",
    "POOR_FIT",
    "QUALITY_UNACCEPTABLE",
    "SWITCHEROO",
    "UNAUTHORIZED_PURCHASE",
    "UNDELIVERABLE_FAILED_DELIVERY_ATTEMPTS",
    "UNDELIVERABLE_INSUFFICIENT_ADDRESS",
    "UNDELIVERABLE_REFUSED",
    "UNDELIVERABLE_UNCLAIMED",
    "UNDELIVERABLE_UNKNOWN",
    "UNWANTED_ITEM",
    "WARRANTY",
    "WRONG_ITEM",
    "WRONG_SIZE",
]


# ── 覆盖率：漏译即红（防回归主力）─────────────────────────────────────────


def test_live_reason_codes_are_all_translated() -> None:
    """生产库实际出现的 26 个 reason code 必须全部有中文译文。

    断言的是"翻译函数不再原样回吐英文"，而不是常量表里有没有这个 key——
    这样前缀别名（CR- / AMZ-PG-）走别名命中也算通过，测的是真实行为。
    """
    untranslated = [c for c in LIVE_REASON_CODES if not has_return_reason_translation(c)]
    assert not untranslated, (
        f"以下退货原因没有中文译文，页面上会直接显示英文：{untranslated}；"
        f"请在 backend/app/constants/return_translations.py 的 "
        f"RETURN_REASON_TRANSLATIONS 补齐。"
    )


def test_live_disposition_and_status_codes_are_all_translated() -> None:
    """生产库实际出现的 disposition / status 取值必须全部有译文。"""
    bad_disposition = [
        c
        for c in LIVE_DISPOSITION_CODES
        if translate_detailed_disposition(c) == c
    ]
    bad_status = [c for c in LIVE_STATUS_CODES if translate_return_status(c) == c]
    assert not bad_disposition, f"商品状态漏译：{bad_disposition}"
    assert not bad_status, f"库存属性漏译：{bad_status}"


def test_amazon_documented_reason_codes_are_covered() -> None:
    """Amazon 文档全集（含库内暂未出现）也必须有译文，防下一批报表再漏。"""
    missing = [c for c in DOCUMENTED_REASON_CODES if not has_return_reason_translation(c)]
    assert not missing, f"Amazon 文档内的 reason code 尚未登记译文：{missing}"


@pytest.mark.parametrize(
    ("code", "expected_zh"),
    [
        ("DEFECTIVE", "有缺陷"),
        ("UNWANTED_ITEM", "不需要"),
        ("NOT_AS_DESCRIBED", "与描述不符"),
        ("APPAREL_TOO_LARGE", "服装过大"),
        ("ORDERED_WRONG_ITEM", "误购商品"),
        ("APPAREL_TOO_SMALL", "服装过小"),
        ("UNDELIVERABLE_UNKNOWN", "无法投递"),
        ("DAMAGED_BY_FC", "仓库致损"),
        ("QUALITY_UNACCEPTABLE", "质量不合格"),
        ("NO_REASON_GIVEN", "未说明原因"),
        ("MISSING_PARTS", "缺少配件"),
        ("DID_NOT_LIKE_FABRIC", "不喜欢面料"),
        ("NOT_COMPATIBLE", "不兼容"),
        ("MISSED_ESTIMATED_DELIVERY", "配送超时"),
        ("FOUND_BETTER_PRICE", "找到更低价"),
        ("SWITCHEROO", "与订单不符"),
        ("UNAUTHORIZED_PURCHASE", "未经授权购买"),
        ("POOR_FIT", "不合身"),
        ("NEVER_ARRIVED", "未收到"),
        ("APPAREL_STYLE", "款式问题"),
        ("UNDELIVERABLE_REFUSED", "无法投递（拒收）"),
        ("DAMAGED_BY_CARRIER", "运输致损"),
        ("DID_NOT_LIKE_COLOR", "不喜欢颜色"),
        ("PART_NOT_COMPATIBLE", "配件不兼容"),
        ("EXTRA_ITEM", "多发货品"),
        ("MISORDERED", "订错款式尺码"),
    ],
)
def test_untranslated_live_codes_now_have_expected_wording(
    code: str, expected_zh: str
) -> None:
    """逐 code 锁死文案：这 26 个是页面上真实展示的标签，改动即契约变更。"""
    assert translate_return_reason(code) == expected_zh


def test_near_synonym_codes_do_not_collide() -> None:
    """易混 code 必须给出可区分的文案（否则用户在饼图上看不出差别）。

    NOT_AS_DESCRIBED（与描述不符）vs SWITCHEROO（与订单不符）vs
    ORDERED_WRONG_ITEM（误购商品）是三个语义相邻但归因不同的原因；
    NOT_COMPATIBLE（不兼容）vs PART_NOT_COMPATIBLE（配件不兼容）同理。
    """
    assert translate_return_reason("NOT_AS_DESCRIBED") != translate_return_reason(
        "SWITCHEROO"
    )
    assert translate_return_reason("SWITCHEROO") != translate_return_reason(
        "ORDERED_WRONG_ITEM"
    )
    assert translate_return_reason("NOT_COMPATIBLE") != translate_return_reason(
        "PART_NOT_COMPATIBLE"
    )


# ── 前缀别名 / 归一化 ───────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("raw", "expected_zh"),
    [
        ("CR-DEFECTIVE", "有缺陷"),
        ("CR-EXTRA_ITEM", "多发货品"),
        ("CR-DAMAGED_BY_CARRIER", "运输致损"),
        ("CR-MISSING_ITEM_IN_SET", "缺少配件"),
        ("AMZ-PG-APP-TOO-LARGE", "服装过大"),
        ("AMZ-PG-BAD-DESC", "与描述不符"),
        ("AMZ-PG-WJ-BATTERY", "首饰电池失效"),
    ],
)
def test_prefixed_amazon_codes_resolve_to_chinese(raw: str, expected_zh: str) -> None:
    """``CR-`` / ``AMZ-PG-`` 前缀码归一化后仍命中同一套译文。"""
    assert translate_return_reason(raw) == expected_zh


def test_whitespace_is_normalized() -> None:
    assert translate_return_reason("  DEFECTIVE  ") == "有缺陷"
    assert translate_return_status("  Reimbursed ") == "已赔偿"


# ── 兜底行为 ────────────────────────────────────────────────────────────


def test_unknown_code_falls_back_to_raw_value() -> None:
    """未知 code 原样返回 —— 宁可见英文，也不猜错语义。"""
    assert translate_return_reason("SOME_FUTURE_CODE") == "SOME_FUTURE_CODE"
    assert translate_return_status("Weird Status") == "Weird Status"
    assert translate_detailed_disposition("WEIRD") == "WEIRD"


def test_empty_value_passes_through() -> None:
    assert translate_return_reason("") == ""
    assert translate_return_status("") == ""
    assert translate_detailed_disposition("") == ""
    assert has_return_reason_translation("") is False


def test_en_language_returns_english_label() -> None:
    """``lang="en"`` 取英文标签（多语言预留路径不能被中文污染）。"""
    assert translate_return_reason("DEFECTIVE", "en") == "Defective"
    assert translate_return_reason("DAMAGED_BY_FC", "en") == "Damaged By FC"
    assert translate_detailed_disposition("SELLABLE", "en") == "Sellable"


def test_translate_return_field_dispatches_by_type() -> None:
    """三列共用入口按 field_type 正确分派（端点/服务层都走这条）。"""
    assert translate_return_field("reason", "NOT_AS_DESCRIBED") == "与描述不符"
    assert translate_return_field("disposition", "CUSTOMER_DAMAGED") == "顾客损坏"
    assert translate_return_field("status", "IMMEDIATE_DONATION") == "立即捐赠"


def test_every_entry_has_both_languages() -> None:
    """常量表不得出现"只有中文没有英文"的半截条目。"""
    for table_name, table in (
        ("RETURN_REASON_TRANSLATIONS", RETURN_REASON_TRANSLATIONS),
        ("DETAILED_DISPOSITION_TRANSLATIONS", DETAILED_DISPOSITION_TRANSLATIONS),
        ("RETURN_STATUS_TRANSLATIONS", RETURN_STATUS_TRANSLATIONS),
    ):
        for code, langs in table.items():
            assert langs.get("zh"), f"{table_name}[{code}] 缺 zh"
            assert langs.get("en"), f"{table_name}[{code}] 缺 en"


def test_translation_values_are_unique_per_code() -> None:
    """同一枚举列内不同 code 不得共用同一句中文（否则聚合结果看起来重复）。"""
    zh_values = [v["zh"] for v in RETURN_REASON_TRANSLATIONS.values()]
    duplicates = {v for v in zh_values if zh_values.count(v) > 1}
    assert not duplicates, (
        f"退货原因存在重复中文文案，饼图/表格无法区分：{sorted(duplicates)}"
    )
