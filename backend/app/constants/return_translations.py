"""
退货分析翻译常量库（BLF-1074）

## 覆盖范围（有界，非"Amazon 全集"）

只服务本仓库实际入库的**一种**报表：FBA 买家退货报表
（``GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA``），其 ``reason`` /
``detailed-disposition`` / ``status`` 三列取值。

范围由两侧证据共同界定，缺一不可：

1. **FBA 生产库实测**（权威）—— 2026-09-15 对生产库 ``analysis_return_rows``
   （本机生产快照 + VPS 生产库双查一致，1945 行）的盘点结果：
   26 个 reason、4 个 disposition、5 个 status。这 26 个 reason 是**页面上真实
   出现过**的取值，任何回归都以它们为准（见 BLF-1074 测试）。
2. **FBA 文档补充** —— Amazon FBA Customer Returns report 文档列出的、
   库内暂未出现但同属该报表的 code（``JEWELRY_*`` / ``WARRANTY`` /
   ``UNDELIVERABLE_*`` 等），提前译好以免下一批报表漏译。

## 明确不覆盖（边界）

以下来源**不做覆盖承诺**——不保证有译文，缺译也不视为缺陷：

- **其他报表类型**：MFN / Seller Fulfilled Prime 退货报表、Buy with Prime
  （Buy with Prime 文档里的 ``AMZ-PG-*``、``NUMBER_PORTING_ISSUES``、
  ``PRODUCT_NOT_ITALIAN`` 等属设备 / 无线 / 欧盟站点等**其他业务域**，
  与本 Dashboard 的 FBA 退货报表无关）；
- **前缀码**：``TA-CR-*`` / ``UND-*`` 等未见实际入库的变体；
- **其他站点历史 code**：未在 FBA 文档中出现的取值。

之所以不把它们逐个补进常量表作为**承诺**：那些 code 无法从本报表口径验证是否
会真的出现，硬造译文反而制造"已覆盖"的错误安全感（BLF-1074 review 结论）。

但表里确实保留了一小批范围外的 **best-effort 条目**（见下方 "[其他域]" 分组，
如 ``AMZ-PG-*`` 首饰码）。它们**仅为兜底，不构成承诺**：命中则少一段英文，
不命中也不作回归缺陷。真实漏译仍由生产库盘点测试兜住——新增 code 一进库，
``test_live_reason_codes_are_all_translated`` 立即变红。

## 兜底行为

未登记的 code **原样返回原文**（英文），并在测试中以显式断言锁定这一行为：
宁可让用户看到英文，也不猜错语义（例如 ``Defective (opened)`` 这类带附注的值
不做模糊匹配）。未知 code 的可观测信号 = 页面上出现英文 + 盘点测试失败。

## 维护约定

- key 一律用 Amazon 原始大写 code（不做大小写变体）；前缀码走 ``_REASON_ALIASES``。
- 文案约定：短（表格/图表标签可读）、同列内不重复、易混码可分辨
  （``NOT_AS_DESCRIBED``「与描述不符」vs ``SWITCHEROO``「与订单不符」）。
- **``_REASON_ALIASES`` 的每个 target 必须存在于主表**——由
  ``test_alias_targets_exist_in_main_table`` 机械保证（BLF-1074 review 曾出现
  注释引用不存在的 entry，属同一缺陷类）。
- 注释里出现的 code 由 ``test_no_dangling_code_references_in_comments`` 机械校验。
"""

from typing import Literal

# ── 退货原因（reason / Buyer return reason）───────────────────────────────
#
# 分组即来源标注：
#   [库内]    生产库实测 26 个，页面上真实展示，改动即契约变更
#   [FBA]     FBA Customer Returns report 文档列出
#   [历史]    本次之前就在表里的 best-effort 条目（保留以免回归性漏译）
#   [非FBA]   其他业务域（Buy with Prime 商品组码）的 best-effort 条目
#   [其他域]  其余其他业务域 / 报表的 best-effort 条目（不构成承诺）
RETURN_REASON_TRANSLATIONS: dict[str, dict[str, str]] = {
    # ── 质量 / 商品本身 ──────────────────────────────────────────────
    "DEFECTIVE": {"zh": "有缺陷", "en": "Defective"},  # [库内]
    "QUALITY_UNACCEPTABLE": {"zh": "质量不合格", "en": "Quality Unacceptable"},  # [库内]
    "WARRANTY": {"zh": "保修期内损坏", "en": "Warranty"},  # [FBA]
    "MISSING_PARTS": {"zh": "缺少配件", "en": "Missing Parts"},  # [库内]
    "EXTRA_ITEM": {"zh": "多发货品", "en": "Extra Item"},  # [库内]
    # ── 买家主观 ────────────────────────────────────────────────────
    "UNWANTED_ITEM": {"zh": "不需要", "en": "Unwanted Item"},  # [库内]
    "NO_REASON_GIVEN": {"zh": "未说明原因", "en": "No Reason Given"},  # [库内]
    "CHANGED_MIND": {"zh": "改变主意", "en": "Changed Mind"},  # [历史]
    "FOUND_BETTER_PRICE": {"zh": "找到更低价", "en": "Found Better Price"},  # [库内]
    # ── 与预期不一致 ────────────────────────────────────────────────
    "NOT_AS_DESCRIBED": {"zh": "与描述不符", "en": "Not As Described"},  # [库内]
    "SWITCHEROO": {"zh": "与订单不符", "en": "Switcheroo"},  # [库内]
    "ORDERED_WRONG_ITEM": {"zh": "误购商品", "en": "Ordered Wrong Item"},  # [库内]
    "MISORDERED": {"zh": "订错款式尺码", "en": "Misordered"},  # [库内]
    "WRONG_ITEM": {"zh": "错发商品", "en": "Wrong Item"},  # [历史]
    # ── 服装 / 鞋类 ─────────────────────────────────────────────────
    "APPAREL_TOO_LARGE": {"zh": "服装过大", "en": "Apparel Too Large"},  # [库内]
    "APPAREL_TOO_SMALL": {"zh": "服装过小", "en": "Apparel Too Small"},  # [库内]
    "APPAREL_STYLE": {"zh": "款式问题", "en": "Apparel Style"},  # [库内]
    "DID_NOT_LIKE_FABRIC": {"zh": "不喜欢面料", "en": "Did Not Like Fabric"},  # [库内]
    "DID_NOT_LIKE_COLOR": {"zh": "不喜欢颜色", "en": "Did Not Like Color"},  # [库内]
    "POOR_FIT": {"zh": "不合身", "en": "Poor Fit"},  # [库内]
    # ── 珠宝 ────────────────────────────────────────────────────────
    "JEWELRY_TOO_SMALL": {"zh": "首饰过小或过短", "en": "Jewelry Too Small"},  # [FBA]
    "JEWELRY_TOO_LARGE": {"zh": "首饰过大或过长", "en": "Jewelry Too Large"},  # [FBA]
    "JEWELRY_BATTERY": {"zh": "首饰电池失效", "en": "Jewelry Battery"},  # [FBA]
    "JEWELRY_NO_DOCS": {"zh": "首饰缺少说明书或保修卡", "en": "Jewelry Missing Docs"},  # [FBA]
    "JEWELRY_BAD_CLASP": {"zh": "首饰搭扣损坏", "en": "Jewelry Bad Clasp"},  # [FBA]
    "JEWELRY_LOOSE_STONE": {"zh": "首饰宝石脱落或松动", "en": "Jewelry Loose Stone"},  # [FBA]
    "JEWELRY_NO_CERT": {"zh": "首饰缺少承诺的证书", "en": "Jewelry No Cert"},  # [FBA]
    "JEWELRY_TARNISHED": {"zh": "首饰氧化变色", "en": "Jewelry Tarnished"},  # [非FBA]
    # ── 兼容性 ──────────────────────────────────────────────────────
    "NOT_COMPATIBLE": {"zh": "不兼容", "en": "Not Compatible"},  # [库内]
    "PART_NOT_COMPATIBLE": {"zh": "配件不兼容", "en": "Part Not Compatible"},  # [库内]
    # ── 物流 / 损坏 ─────────────────────────────────────────────────
    "DAMAGED_BY_FC": {"zh": "仓库致损", "en": "Damaged By FC"},  # [库内]
    "DAMAGED_BY_CARRIER": {"zh": "运输致损", "en": "Damaged By Carrier"},  # [库内]
    "MISSED_ESTIMATED_DELIVERY": {"zh": "配送超时", "en": "Missed Estimated Delivery"},  # [库内]
    "NEVER_ARRIVED": {"zh": "未收到", "en": "Never Arrived"},  # [库内]
    "LATE_ARRIVAL": {"zh": "到货延迟", "en": "Late Arrival"},  # [历史]
    "UNDELIVERABLE_UNKNOWN": {"zh": "无法投递", "en": "Undeliverable Unknown"},  # [库内]
    "UNDELIVERABLE_REFUSED": {"zh": "无法投递（拒收）", "en": "Undeliverable Refused"},  # [库内]
    "UNDELIVERABLE_UNCLAIMED": {
        "zh": "无法投递（无人认领）",
        "en": "Undeliverable Unclaimed",
    },  # [FBA]
    "UNDELIVERABLE_INSUFFICIENT_ADDRESS": {
        "zh": "无法投递（地址不详）",
        "en": "Undeliverable Insufficient Address",
    },  # [FBA]
    "UNDELIVERABLE_FAILED_DELIVERY_ATTEMPTS": {
        "zh": "无法投递（多次派送失败）",
        "en": "Undeliverable Failed Delivery Attempts",
    },  # [FBA]
    # ── 非买家原因 ──────────────────────────────────────────────────
    "UNAUTHORIZED_PURCHASE": {"zh": "未经授权购买", "en": "Unauthorized Purchase"},  # [库内]
    # ── 其他业务域 best-effort（不构成承诺，见模块 docstring）────────────
    # 这些来自 Buy with Prime / 其他报表文档，无法从 FBA 报表口径验证是否会
    # 出现；保留仅为兜底，缺译不算缺陷。保留而不删，避免"删了反而漏译"。
    "NOT_AS_PHOTO": {"zh": "与图片不符", "en": "Not As Photo"},  # [其他域]
    "WRONG_SIZE": {"zh": "尺码错误", "en": "Wrong Size"},  # [其他域]
    "NOT_COMFORTABLE": {"zh": "穿着不舒适", "en": "Not Comfortable"},  # [其他域]
    "EXCESSIVE_INSTALLATION": {"zh": "无法安装", "en": "Excessive Installation"},  # [其他域]
    "ACTIVATION_FAILURE": {"zh": "激活失败", "en": "Activation Failure"},  # [其他域]
    "CARRIER_BILL_NOT_AS_EXPECTED": {
        "zh": "承运商账单不符预期",
        "en": "Carrier Bill Not As Expected",
    },  # [其他域]
    "CARRIER_SWITCHING_COST": {"zh": "承运商切换成本", "en": "Carrier Switching Cost"},  # [其他域]
    # ── 兜底 ────────────────────────────────────────────────────────
    "OTHER": {"zh": "其他", "en": "Other"},  # [历史] / [FBA] 文档亦列出
}

# 前缀码别名：Amazon 在部分站点/报表版本里返回带前缀的等价 code。
#
# 归一化后再查主表，避免同一语义出现两套文案。**每个 target 必须存在于主表**
# ——由 ``test_alias_targets_exist_in_main_table`` 机械校验，防止注释/别名指向
# 不存在的 entry（BLF-1074 review 曾出现的缺陷类）。
#
# 仅登记 ``AMZ-PG-`` 商品组码里与本报表口径相关、且主表有对应语义的那些；
# ``CR-`` 前缀走下方通用剥离逻辑（``CR-XXXX`` ≡ ``XXXX``），不逐个列举。
_REASON_ALIASES: dict[str, str] = {
    # 首饰商品组码（AMZ-PG-WJ-*）→ 主表条目
    "AMZ-PG-WJ-TOO-LARGE": "JEWELRY_TOO_LARGE",
    "AMZ-PG-WJ-TOO-SMALL": "JEWELRY_TOO_SMALL",
    "AMZ-PG-WJ-BATTERY": "JEWELRY_BATTERY",
    "AMZ-PG-WJ-NO-DOCS": "JEWELRY_NO_DOCS",
    "AMZ-PG-WJ-BAD-CLASP": "JEWELRY_BAD_CLASP",
    "AMZ-PG-WJ-LOOSE-STONE": "JEWELRY_LOOSE_STONE",
    "AMZ-PG-WJ-NO-CERT": "JEWELRY_NO_CERT",
    "AMZ-PG-WJ-TARNISHED": "JEWELRY_TARNISHED",
    # 服装 / 通用商品组码 → 主表条目
    "AMZ-PG-APP-STYLE": "APPAREL_STYLE",
    "AMZ-PG-APP-TOO-LARGE": "APPAREL_TOO_LARGE",
    "AMZ-PG-APP-TOO-SMALL": "APPAREL_TOO_SMALL",
    "AMZ-PG-BAD-DESC": "NOT_AS_DESCRIBED",
    "AMZ-PG-MISORDERED": "MISORDERED",
    # 集合缺件：语义等同缺配件
    "CR-MISSING_ITEM_IN_SET": "MISSING_PARTS",
}

# 商品状态（detailed-disposition / 报表 Condition code 列）翻译。
#
# 库内实测 4 个（SELLABLE / CUSTOMER_DAMAGED / DEFECTIVE / CARRIER_DAMAGED）
# 全部覆盖；DAMAGED / EXPIRED 为 FBA 文档补充。CUSTOMER_DAMAGED 与
# DAMAGED_BY_CUSTOMER 是同一语义的历史双写法，都保留。
DETAILED_DISPOSITION_TRANSLATIONS: dict[str, dict[str, str]] = {
    "SELLABLE": {"zh": "可售", "en": "Sellable"},
    "CUSTOMER_DAMAGED": {"zh": "顾客损坏", "en": "Customer Damaged"},
    "DAMAGED_BY_CUSTOMER": {"zh": "顾客损坏", "en": "Damaged by Customer"},
    "CARRIER_DAMAGED": {"zh": "运输损坏", "en": "Carrier Damaged"},
    "DEFECTIVE": {"zh": "有缺陷", "en": "Defective"},
    "DAMAGED": {"zh": "亚马逊致损", "en": "Damaged"},
    "EXPIRED": {"zh": "已过期", "en": "Expired"},
}

# 库存状态（status / 报表 Return status 列）翻译。
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
        # CR-XXXX 与主表 XXXX 同义（例如 CR-DEFECTIVE / CR-EXTRA_ITEM）
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
