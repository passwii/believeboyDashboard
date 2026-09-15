"""
退货分析翻译常量库（BLF-1074 全量补齐）

覆盖三张 Amazon FBA 买家退货报表的枚举列：

- ``reason``（退货原因，对应报表 Buyer return reason 列）
- ``detailed-disposition``（商品状态，Condition code 列）
- ``status``（库存属性，Return status 列）

数据来源（枚举口径以此为准，改文案不要改 key）：
- Amazon FBA Customer Returns report（``GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA``）
  的 Buyer return reason / Condition code / Return status 三张对照表；
- 2026-09-15 对生产库 ``analysis_return_rows``（本机快照 + VPS 双查一致，1945 行）
  的盘点结果——26 个 reason 取值、4 个 disposition、5 个 status 全部在库内。

BLF-1074 背景：原表只覆盖 14 个 reason，生产库里 488/1945 行（16 个 code）落回
英文原文直接显示。本次按"库内实际取值 + Amazon 文档全集"两类一次补齐，并给
``CR-`` / ``AMZ-PG-`` 前缀码留 normalize 兜底，避免新增 code 再次漏译。
"""

from typing import Literal

# 退货原因翻译。
#
# key 一律用 Amazon 原始大写 code（不做大小写变体），前缀码走 _REASON_ALIASES。
# 文案约定：短（表格/图表标签可读）、区分度优先——例如 NOT_AS_DESCRIBED「与描述不符」
# 与 SWITCHEROO「与订单不符」必须能一眼分辨。
RETURN_REASON_TRANSLATIONS: dict[str, dict[str, str]] = {
    # ── 质量 / 商品本身 ──────────────────────────────────────────────
    "DEFECTIVE": {"zh": "有缺陷", "en": "Defective"},
    "QUALITY_UNACCEPTABLE": {"zh": "质量不合格", "en": "Quality Unacceptable"},
    "WARRANTY": {"zh": "保修期内损坏", "en": "Warranty"},
    "MISSING_PARTS": {"zh": "缺少配件", "en": "Missing Parts"},
    "EXTRA_ITEM": {"zh": "多发货品", "en": "Extra Item"},
    # ── 买家主观 ────────────────────────────────────────────────────
    "UNWANTED_ITEM": {"zh": "不需要", "en": "Unwanted Item"},
    "NO_REASON_GIVEN": {"zh": "未说明原因", "en": "No Reason Given"},
    "CHANGED_MIND": {"zh": "改变主意", "en": "Changed Mind"},
    "FOUND_BETTER_PRICE": {"zh": "找到更低价", "en": "Found Better Price"},
    # ── 与预期不一致 ────────────────────────────────────────────────
    "NOT_AS_DESCRIBED": {"zh": "与描述不符", "en": "Not As Described"},
    "NOT_AS_PHOTO": {"zh": "与图片不符", "en": "Not As Photo"},
    "SWITCHEROO": {"zh": "与订单不符", "en": "Switcheroo"},
    "ORDERED_WRONG_ITEM": {"zh": "误购商品", "en": "Ordered Wrong Item"},
    "MISORDERED": {"zh": "订错款式尺码", "en": "Misordered"},
    "WRONG_ITEM": {"zh": "错发商品", "en": "Wrong Item"},
    "WRONG_SIZE": {"zh": "尺码错误", "en": "Wrong Size"},
    # ── 服装 / 鞋类 ─────────────────────────────────────────────────
    "APPAREL_TOO_LARGE": {"zh": "服装过大", "en": "Apparel Too Large"},
    "APPAREL_TOO_SMALL": {"zh": "服装过小", "en": "Apparel Too Small"},
    "APPAREL_STYLE": {"zh": "款式问题", "en": "Apparel Style"},
    "DID_NOT_LIKE_FABRIC": {"zh": "不喜欢面料", "en": "Did Not Like Fabric"},
    "DID_NOT_LIKE_COLOR": {"zh": "不喜欢颜色", "en": "Did Not Like Color"},
    "POOR_FIT": {"zh": "不合身", "en": "Poor Fit"},
    "NOT_COMFORTABLE": {"zh": "穿着不舒适", "en": "Not Comfortable"},
    # ── 珠宝 ────────────────────────────────────────────────────────
    "JEWELRY_TOO_SMALL": {"zh": "首饰过小或过短", "en": "Jewelry Too Small"},
    "JEWELRY_TOO_LARGE": {"zh": "首饰过大或过长", "en": "Jewelry Too Large"},
    "JEWELRY_BATTERY": {"zh": "首饰电池失效", "en": "Jewelry Battery"},
    "JEWELRY_NO_DOCS": {"zh": "首饰缺少说明书或保修卡", "en": "Jewelry Missing Docs"},
    "JEWELRY_BAD_CLASP": {"zh": "首饰搭扣损坏", "en": "Jewelry Bad Clasp"},
    "JEWELRY_LOOSE_STONE": {"zh": "首饰宝石脱落或松动", "en": "Jewelry Loose Stone"},
    "JEWELRY_NO_CERT": {"zh": "首饰缺少承诺的证书", "en": "Jewelry No Cert"},
    # ── 兼容性 ──────────────────────────────────────────────────────
    "NOT_COMPATIBLE": {"zh": "不兼容", "en": "Not Compatible"},
    "PART_NOT_COMPATIBLE": {"zh": "配件不兼容", "en": "Part Not Compatible"},
    "EXCESSIVE_INSTALLATION": {"zh": "无法安装", "en": "Excessive Installation"},
    "ACTIVATION_FAILURE": {"zh": "激活失败", "en": "Activation Failure"},
    # ── 物流 / 损坏 ─────────────────────────────────────────────────
    "DAMAGED_BY_FC": {"zh": "仓库致损", "en": "Damaged By FC"},
    "DAMAGED_BY_CARRIER": {"zh": "运输致损", "en": "Damaged By Carrier"},
    "LATE_ARRIVAL": {"zh": "到货延迟", "en": "Late Arrival"},
    "MISSED_ESTIMATED_DELIVERY": {"zh": "配送超时", "en": "Missed Estimated Delivery"},
    "NEVER_ARRIVED": {"zh": "未收到", "en": "Never Arrived"},
    "UNDELIVERABLE_UNKNOWN": {"zh": "无法投递", "en": "Undeliverable Unknown"},
    "UNDELIVERABLE_REFUSED": {"zh": "无法投递（拒收）", "en": "Undeliverable Refused"},
    "UNDELIVERABLE_UNCLAIMED": {
        "zh": "无法投递（无人认领）",
        "en": "Undeliverable Unclaimed",
    },
    "UNDELIVERABLE_INSUFFICIENT_ADDRESS": {
        "zh": "无法投递（地址不详）",
        "en": "Undeliverable Insufficient Address",
    },
    "UNDELIVERABLE_FAILED_DELIVERY_ATTEMPTS": {
        "zh": "无法投递（多次派送失败）",
        "en": "Undeliverable Failed Delivery Attempts",
    },
    # ── 非买家原因 ──────────────────────────────────────────────────
    "UNAUTHORIZED_PURCHASE": {"zh": "未经授权购买", "en": "Unauthorized Purchase"},
    "CARRIER_BILL_NOT_AS_EXPECTED": {
        "zh": "承运商账单不符预期",
        "en": "Carrier Bill Not As Expected",
    },
    "CARRIER_SWITCHING_COST": {"zh": "承运商切换成本", "en": "Carrier Switching Cost"},
    # ── 兜底 ────────────────────────────────────────────────────────
    "OTHER": {"zh": "其他", "en": "Other"},
}

# 前缀码别名：Amazon 在部分站点/报表版本里返回带前缀的等价 code
# （``CR-`` = Customer Returns，``AMZ-PG-`` = Amazon 商品组自定义码）。
# 归一化后再查主表，避免同一语义出现两套文案。
_REASON_ALIASES: dict[str, str] = {
    # CR- 前缀：去掉前缀即主表 code，只有语义确实不同的才单列
    "CR-MISSING_ITEM_IN_SET": "MISSING_PARTS",
    # AMZ-PG- 商品组码 → 主表 code
    "AMZ-PG-APP-STYLE": "APPAREL_STYLE",
    "AMZ-PG-APP-TOO-LARGE": "APPAREL_TOO_LARGE",
    "AMZ-PG-APP-TOO-SMALL": "APPAREL_TOO_SMALL",
    "AMZ-PG-BAD-DESC": "NOT_AS_DESCRIBED",
    "AMZ-PG-MISORDERED": "MISORDERED",
    "AMZ-PG-WJ-TOO-LARGE": "JEWELRY_TOO_LARGE",
    "AMZ-PG-WJ-TOO-SMALL": "JEWELRY_TOO_SMALL",
    "AMZ-PG-WJ-BATTERY": "JEWELRY_BATTERY",
    "AMZ-PG-WJ-NO-DOCS": "JEWELRY_NO_DOCS",
    "AMZ-PG-WJ-BAD-CLASP": "JEWELRY_BAD_CLASP",
    "AMZ-PG-WJ-LOOSE-STONE": "JEWELRY_LOOSE_STONE",
    "AMZ-PG-WJ-NO-CERT": "JEWELRY_NO_CERT",
    # AMZ-PG-WJ-TARNISHED（首饰氧化/外观不合格）主表无等价码，直接挂在主表
}

# 商品状态（detailed-disposition，报表 Condition code 列）翻译。
# 既有 CUSTOMER_DAMAGED / DAMAGED_BY_CUSTOMER 是同一语义的历史双写法，都保留。
DETAILED_DISPOSITION_TRANSLATIONS: dict[str, dict[str, str]] = {
    "SELLABLE": {"zh": "可售", "en": "Sellable"},
    "CUSTOMER_DAMAGED": {"zh": "顾客损坏", "en": "Customer Damaged"},
    "DAMAGED_BY_CUSTOMER": {"zh": "顾客损坏", "en": "Damaged by Customer"},
    "CARRIER_DAMAGED": {"zh": "运输损坏", "en": "Carrier Damaged"},
    "DEFECTIVE": {"zh": "有缺陷", "en": "Defective"},
    "DAMAGED": {"zh": "亚马逊致损", "en": "Damaged"},
    "EXPIRED": {"zh": "已过期", "en": "Expired"},
}

# 库存状态（status，报表 Return status 列）翻译。
#
# 同一状态在报表里有两种呈现——``IMMEDIATE_LIQUIDATION`` 这类下划线大写 code，
# 以及 ``Unit returned to inventory`` 这类带空格的英文短语，故两种写法都登记，
# 保证 UI / 邮件不因取到哪一种而漏译。
RETURN_STATUS_TRANSLATIONS: dict[str, dict[str, str]] = {
    "Unit returned to inventory": {"zh": "退回库存", "en": "Unit returned to inventory"},
    "Reimbursed": {"zh": "已赔偿", "en": "Reimbursed"},
    "IMMEDIATE_LIQUIDATION": {"zh": "立即清算", "en": "Immediate Liquidation"},
    "Immediate liquidation": {"zh": "立即清算", "en": "Immediate liquidation"},
    "Liquidated": {"zh": "已清算", "en": "Liquidated"},
    "Refunded": {"zh": "已退款", "en": "Refunded"},
    "IMMEDIATE_DONATION": {"zh": "立即捐赠", "en": "Immediate Donation"},
    "Immediate donation": {"zh": "立即捐赠", "en": "Immediate donation"},
    "IMMEDIATE_DISPOSAL": {"zh": "立即弃置", "en": "Immediate Disposal"},
    "Immediate disposal": {"zh": "立即弃置", "en": "Immediate disposal"},
    "Pending": {"zh": "处理中", "en": "Pending"},
    "Pending repackaging": {"zh": "待重新包装", "en": "Pending repackaging"},
    "Repackaged successfully": {"zh": "重新包装完成", "en": "Repackaged successfully"},
    "To be autoremoved": {"zh": "待自动移除", "en": "To be autoremoved"},
    "Policy-related disposal": {"zh": "政策原因弃置", "en": "Policy-related disposal"},
    "Closed": {"zh": "已关闭", "en": "Closed"},
}


def _normalize_return_code(value: str) -> str:
    """归一化原始 code：去首尾空白 → 解析 ``CR-`` / ``AMZ-PG-`` 前缀别名。

    只做"等价改写"，不做模糊猜测（如 ``Defective (opened)`` 这类带附注的值一律
    原样返回原文，宁可显示英文也不猜错语义）。
    """
    code = value.strip()
    if code in _REASON_ALIASES:
        return _REASON_ALIASES[code]
    if code.startswith("CR-"):
        # CR-XXXX 与主表 XXXX 同义（CR-DEFECTIVE / CR-EXTRA_ITEM / ...）
        return code[3:]
    return code


def has_return_reason_translation(value: str, lang: Literal["zh", "en"] = "zh") -> bool:
    """该原因是否已有译文（盘点/测试用，不用于请求路径）。"""
    if not value:
        return False
    code = _normalize_return_code(value)
    return lang in RETURN_REASON_TRANSLATIONS.get(code, {})


def translate_return_reason(
    value: str, lang: Literal["zh", "en"] = "zh"
) -> str:
    """翻译退货原因"""
    if not value:
        return value
    return RETURN_REASON_TRANSLATIONS.get(_normalize_return_code(value), {}).get(
        lang, value
    )


def translate_detailed_disposition(
    value: str, lang: Literal["zh", "en"] = "zh"
) -> str:
    """翻译商品状态"""
    if not value:
        return value
    return DETAILED_DISPOSITION_TRANSLATIONS.get(value.strip(), {}).get(lang, value)


def translate_return_status(
    value: str, lang: Literal["zh", "en"] = "zh"
) -> str:
    """翻译库存状态"""
    if not value:
        return value
    return RETURN_STATUS_TRANSLATIONS.get(value.strip(), {}).get(lang, value)


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
