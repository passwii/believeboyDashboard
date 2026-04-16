"""
退货分析翻译常量库

提供退货报告相关字段的翻译映射，支持多语言（预留DE等语言扩展）
"""

from typing import Literal

# 退货原因翻译
RETURN_REASON_TRANSLATIONS: dict[str, dict[str, str]] = {
    "APPAREL_TOO_LARGE": {"zh": "服装过大", "en": "Apparel Too Large"},
    "APPAREL_TOO_SMALL": {"zh": "服装过小", "en": "Apparel Too Small"},
    "QUALITY_UNACCEPTABLE": {"zh": "质量不合格", "en": "Quality Unacceptable"},
    "DID_NOT_LIKE_FABRIC": {"zh": "不喜欢面料", "en": "Did Not Like Fabric"},
    "NOT_AS_DESCRIBED": {"zh": "与描述不符", "en": "Not As Described"},
    "APPAREL_STYLE": {"zh": "款式问题", "en": "Apparel Style"},
    "DEFECTIVE": {"zh": "有缺陷", "en": "Defective"},
    "UNDELIVERABLE_UNKNOWN": {"zh": "无法投递", "en": "Undeliverable Unknown"},
    "NEVER_ARRIVED": {"zh": "未收到", "en": "Never Arrived"},
    "UNWANTED_ITEM": {"zh": "不需要", "en": "Unwanted Item"},
    "CHANGED_MIND": {"zh": "改变主意", "en": "Changed Mind"},
    "WRONG_ITEM": {"zh": "错发商品", "en": "Wrong Item"},
    "LATE_ARRIVAL": {"zh": "到货延迟", "en": "Late Arrival"},
    "OTHER": {"zh": "其他", "en": "Other"},
}

# 商品状态（detailed-disposition）翻译
DETAILED_DISPOSITION_TRANSLATIONS: dict[str, dict[str, str]] = {
    "SELLABLE": {"zh": "可售", "en": "Sellable"},
    "CARRIER_DAMAGED": {"zh": "运输损坏", "en": "Carrier Damaged"},
    "CUSTOMER_DAMAGED": {"zh": "顾客损坏", "en": "Customer Damaged"},
    "DEFECTIVE": {"zh": "有缺陷", "en": "Defective"},
    "DAMAGED_BY_CUSTOMER": {"zh": "顾客损坏", "en": "Damaged by Customer"},
}

# 库存状态（status）翻译
RETURN_STATUS_TRANSLATIONS: dict[str, dict[str, str]] = {
    "Unit returned to inventory": {"zh": "退回库存", "en": "Unit returned to inventory"},
    "Reimbursed": {"zh": "已退款", "en": "Reimbursed"},
    "IMMEDIATE_LIQUIDATION": {"zh": "立即清算", "en": "Immediate Liquidation"},
    "Liquidated": {"zh": "已清算", "en": "Liquidated"},
    "Refunded": {"zh": "已退款", "en": "Refunded"},
    "Pending": {"zh": "处理中", "en": "Pending"},
    "Closed": {"zh": "已关闭", "en": "Closed"},
}


def translate_return_reason(
    value: str, lang: Literal["zh", "en"] = "zh"
) -> str:
    """翻译退货原因"""
    if not value:
        return value
    return RETURN_REASON_TRANSLATIONS.get(value, {}).get(lang, value)


def translate_detailed_disposition(
    value: str, lang: Literal["zh", "en"] = "zh"
) -> str:
    """翻译商品状态"""
    if not value:
        return value
    return DETAILED_DISPOSITION_TRANSLATIONS.get(value, {}).get(lang, value)


def translate_return_status(
    value: str, lang: Literal["zh", "en"] = "zh"
) -> str:
    """翻译库存状态"""
    if not value:
        return value
    return RETURN_STATUS_TRANSLATIONS.get(value, {}).get(lang, value)


def translate_return_field(
    field_type: Literal["reason", "disposition", "status"],
    value: str,
    lang: Literal["zh", "en"] = "zh",
) -> str:
    """
    通用翻译函数

    Args:
        field_type: 字段类型 ("reason", "disposition", "status")
        value: 原始值
        lang: 语言 ("zh" 或 "en")
    """
    if field_type == "reason":
        return translate_return_reason(value, lang)
    elif field_type == "disposition":
        return translate_detailed_disposition(value, lang)
    elif field_type == "status":
        return translate_return_status(value, lang)
    return value
