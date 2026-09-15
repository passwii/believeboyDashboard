"""退货翻译常量库的覆盖率与回归测试（BLF-1074）。

## 本文件防什么

背景：`return-analysis` 页面的退货原因翻译只覆盖 14 个 code，生产库
（``analysis_return_rows``，2026-09-15 盘点 1945 行）里 26 个 reason 取值中有
16 个（488 行，25%）落回英文原文。根因不是"漏了几个词"，而是缺少一层防线——
常量库可以任意残缺而不被发现，因为漏译的默认行为就是 `返回原文`，测试也不会红。

## 覆盖范围（有界）

范围**不是**"Amazon 全集"（BLF-1074 review 已纠正这一过度声明）：只承诺
FBA 买家退货报表口径，由两侧证据界定——

1. ``LIVE_REASON_CODES``：生产库实测 26 个（权威；页面真实展示的取值）；
2. ``FBA_DOCUMENTED_REASON_CODES``：FBA 文档列出、库内暂未出现的补充项。

其他报表 / 业务域（Buy with Prime、MFN、``TA-CR-*`` 等）**不在承诺范围内**，
见常量库模块 docstring 的「明确不覆盖」段。未登记的 code 原样返回英文，这一
兜底行为由测试显式锁定。

## 防线清单

- ``test_live_reason_codes_are_all_translated`` —— 库内 26 个全覆盖（防回归主力）
- ``test_fba_documented_reason_codes_are_covered`` —— FBA 文档补充项覆盖
- ``test_alias_targets_exist_in_main_table`` —— 别名 target 必须存在（机械校验）
- ``test_no_dangling_code_references_in_comments`` —— 注释引用的 code 必须存在
- ``test_out_of_scope_codes_fall_back_and_are_documented`` —— 边界行为锁定

纯常量测试：不连数据库、不需要 ``TEST_DATABASE_URL``。
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from app.constants.return_translations import (
    _REASON_ALIASES,
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

# FBA Customer Returns report 文档列出、而生产库暂未出现的补充 code。
# 补这份是为了不在"下一批报表新增 code"时重演漏译；**不声称是文档全集**
# ——见模块 docstring「明确不覆盖」。
FBA_DOCUMENTED_REASON_CODES = [
    "JEWELRY_TOO_SMALL",
    "JEWELRY_TOO_LARGE",
    "JEWELRY_BATTERY",
    "JEWELRY_NO_DOCS",
    "JEWELRY_BAD_CLASP",
    "JEWELRY_LOOSE_STONE",
    "JEWELRY_NO_CERT",
    "UNDELIVERABLE_UNCLAIMED",
    "UNDELIVERABLE_INSUFFICIENT_ADDRESS",
    "UNDELIVERABLE_FAILED_DELIVERY_ATTEMPTS",
    "WARRANTY",
    "OTHER",
]

# 明确**不在**承诺范围的取值样本（其他业务域 / 报表）。锁定"原样返回英文"这一
# 兜底行为，避免有人误以为它们该有译文。
OUT_OF_SCOPE_CODES = [
    "NUMBER_PORTING_ISSUES",  # 无线/设备域
    "PRODUCT_NOT_ITALIAN",  # 欧盟站点域
    "NOT_COMPATIBLE_WITH_PHONE",  # 设备兼容域
    "REBATE_ELIGIBILITY",  # 促销域
    "TA-CR-SOMETHING",  # 未见实际入库的变体前缀
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


# ── 覆盖率：漏译即红（防回归主力）─────────────────────────────────────────


def test_live_reason_codes_are_all_translated() -> None:
    """生产库实际出现的 26 个 reason code 必须全部有中文译文。

    断言的是"翻译函数不再原样回吐英文"，而不是常量表里有没有这个 key——
    这样前缀别名命中（如 CR-*）也算通过，测的是真实行为。
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
        c for c in LIVE_DISPOSITION_CODES if translate_detailed_disposition(c) == c
    ]
    bad_status = [c for c in LIVE_STATUS_CODES if translate_return_status(c) == c]
    assert not bad_disposition, f"商品状态漏译：{bad_disposition}"
    assert not bad_status, f"库存属性漏译：{bad_status}"


def test_fba_documented_reason_codes_are_covered() -> None:
    """FBA 文档列出的补充 code 也必须有译文，防下一批报表再漏。"""
    missing = [
        c for c in FBA_DOCUMENTED_REASON_CODES if not has_return_reason_translation(c)
    ]
    assert not missing, f"FBA 文档列出的 reason code 尚未登记译文：{missing}"


def test_live_codes_are_actually_in_constant_table() -> None:
    """库内 26 个 code 必须**直接**在主表里（不是只靠别名兜住）。

    理由：主表是"页面会看到什么"的单一真相源；若某个库内 code 只能靠别名命中，
    说明主表缺条目，文案归属会变得难以推理。
    """
    missing = [c for c in LIVE_REASON_CODES if c not in RETURN_REASON_TRANSLATIONS]
    assert not missing, f"以下库内 code 未直接登记在主表：{missing}"


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
        ("AMZ-PG-WJ-TARNISHED", "首饰氧化变色"),
    ],
)
def test_prefixed_amazon_codes_resolve_to_chinese(raw: str, expected_zh: str) -> None:
    """``CR-`` / ``AMZ-PG-`` 前缀码归一化后仍命中同一套译文。"""
    assert translate_return_reason(raw) == expected_zh


def test_alias_targets_exist_in_main_table() -> None:
    """``_REASON_ALIASES`` 的每个 target 必须在主表里有条目。

    BLF-1074 review 发现的缺陷类：常量文件里出现过"注释声称某 code 已挂在主表、
    实际并不存在"的悬空引用——别名 target 写错会静默退化成"返回原文"，且没有
    任何测试会红。此断言把该类错误变成机械可检测。
    """
    dangling = {
        alias: target
        for alias, target in _REASON_ALIASES.items()
        if target not in RETURN_REASON_TRANSLATIONS
    }
    assert not dangling, (
        f"别名指向了主表里不存在的条目（会静默漏译）：{dangling}；"
        f"请补主表条目或修正 target。"
    )


def test_alias_never_points_to_itself() -> None:
    """别名不得自指（否则归一化结果仍查不到，等价于漏译）。"""
    self_ref = [a for a, t in _REASON_ALIASES.items() if a == t]
    assert not self_ref, f"别名自指：{self_ref}"


def test_whitespace_is_normalized() -> None:
    assert translate_return_reason("  DEFECTIVE  ") == "有缺陷"
    assert translate_return_status("  Reimbursed ") == "已赔偿"


# ── 来源完整性：注释不得悬空（review 缺陷类）─────────────────────────────


def _constant_module_text() -> str:
    import app.constants.return_translations as mod

    return Path(mod.__file__).read_text(encoding="utf-8")


def test_no_dangling_code_references_in_comments() -> None:
    """文件里提到的每个 ``AMZ-PG-*`` / ``CR-*`` 前缀码都必须真能翻译出中文。

    BLF-1074 review 的原缺陷：注释写 ``AMZ-PG-WJ-TARNISHED ... 直接挂在主表``，
    但主表并没有这个 entry，别名表里也没有——即归一化后仍查不到，会静默返回
    英文，而当时没有任何测试会红。此断言把该类悬空引用变成机械可检测。

    只限定前缀码（有固定形态 ``AMZ-PG-*`` / ``CR-*``）而不做全文件大写 token
    扫描，避免把常量名、docstring 里刻意列举的「范围外」取值误报。
    """
    text = _constant_module_text()
    # 只取“具体 code”形态：以字母/数字结尾（排除 ``AMZ-PG-WJ-*`` 这类通配族），
    # 并排除 ``CR-XXXX`` 这类占位符（含连续重复 X）。
    referenced = set(re.findall(r"\b(?:AMZ-PG|CR)-[A-Z0-9][A-Z0-9_-]*[A-Z0-9]\b", text))
    referenced = {
        c
        for c in referenced
        if "XXXX" not in c
        and f"{c}-*" not in text  # 通配族前缀，不是具体 code
    }
    assert referenced, "未在文件中发现任何具体前缀码引用，正则可能失效"
    dangling = sorted(
        c for c in referenced if translate_return_reason(c) == c
    )
    assert not dangling, (
        f"文件里提到的前缀码无法翻译（悬空引用，会静默漏译）：{dangling}；"
        f"请补 _REASON_ALIASES 或主表条目——不能让注释制造『已覆盖』的错误安全感。"
    )


# ── 边界行为：范围外 code 明确不译（review 结论 option 2）──────────────


@pytest.mark.parametrize("code", OUT_OF_SCOPE_CODES)
def test_out_of_scope_codes_fall_back_and_are_documented(code: str) -> None:
    """范围外（其他业务域/报表）的 code 原样返回英文，且不假装已覆盖。

    这是刻意决定的支持边界（BLF-1074 review option 2）：与其为无法从本报表口径
    验证的 code 硬造译文，不如显式声明不支持并锁定兜底行为。
    """
    assert translate_return_reason(code) == code, (
        f"{code} 属范围外，应原样返回；（若确实要支持，请补进主表并加入 "
        f"FBA_DOCUMENTED_REASON_CODES / LIVE_REASON_CODES 的证据基础）"
    )
    assert has_return_reason_translation(code) is False


def test_scope_boundary_is_documented_in_module_docstring() -> None:
    """模块 docstring 必须写明覆盖范围与不覆盖范围，防止再次过度声明。"""
    text = _constant_module_text()
    assert "明确不覆盖" in text, "模块 docstring 缺少『明确不覆盖』边界说明"
    for token in ("Buy with Prime", "MFN"):
        assert token in text, f"模块 docstring 未声明不覆盖 {token}"


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
