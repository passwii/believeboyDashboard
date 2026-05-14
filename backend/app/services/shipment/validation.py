"""
验证逻辑模块

提供发货计划相关的校验函数
"""
from __future__ import annotations

from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from typing import TYPE_CHECKING

from fastapi import HTTPException, status

from app.utils.text_utils import normalize_text
from app.utils.date_utils import parse_date_flexible
from app.utils.country import normalize_country

if TYPE_CHECKING:
    from app.models.shipment_schedule import ShipmentSchedule
    from app.schemas.shipment_schedule import ShipmentScheduleItemInput


# ============================================================
# 常量定义
# ============================================================

ALLOWED_SHIPMENT_STATUS = {"draft", "in_transit", "completed"}
ALLOWED_SHIPPING_METHOD = {"sea", "air", "express", "truck", "rail", "other"}


# ============================================================
# 状态验证
# ============================================================

def normalize_status(value: str) -> str:
    """验证并规范化 shipment_status"""
    normalized = (value or "").strip()
    if normalized not in ALLOWED_SHIPMENT_STATUS:
        allowed = ", ".join(sorted(ALLOWED_SHIPMENT_STATUS))
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"shipment_status 必须是: {allowed}",
        )
    return normalized


def normalize_status_filters(value: str | None) -> list[str]:
    """验证并规范化 shipment_status 过滤条件（逗号分隔）"""
    normalized = normalize_text(value)
    if normalized is None:
        return []
    return [normalize_status(part.strip()) for part in normalized.split(",") if part.strip()]


# ============================================================
# 运输方式验证
# ============================================================

def normalize_shipping_method(value: str) -> str:
    """验证并规范化 shipping_method"""
    normalized = (value or "").strip()
    if normalized not in ALLOWED_SHIPPING_METHOD:
        allowed = ", ".join(sorted(ALLOWED_SHIPPING_METHOD))
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"shipping_method 必须是: {allowed}",
        )
    return normalized


# ============================================================
# 货件编号验证
# ============================================================

def normalize_shipment_no_filters(values: str | list[str] | None) -> list[str]:
    """
    验证并规范化货件编号过滤条件
    支持单个字符串或字符串列表
    """
    if values is None:
        return []
    raw_values = values if isinstance(values, list) else [values]
    normalized_values: list[str] = []
    seen: set[str] = set()
    for raw_value in raw_values:
        for part in str(raw_value).replace("\n", ",").split(","):
            normalized = normalize_text(part, max_length=100)
            if normalized is None or normalized in seen:
                continue
            seen.add(normalized)
            normalized_values.append(normalized)
    return normalized_values


# ============================================================
# 日期验证
# ============================================================

def parse_date(value: str | None, field_name: str) -> date | None:
    """灵活解析日期，支持多种格式"""
    if value is None:
        return None
    try:
        return parse_date_flexible(value, field_name)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"{field_name} 必须是 YYYY-MM-DD，或 Excel 常见日期格式（如 2026/03/08、03/08/2026）",
        )


# ============================================================
# 数量验证
# ============================================================

def parse_carton_count(value: str | None, field_name: str) -> int | None:
    """解析 carton_count，必须是大于等于 0 的整数"""
    if value is None:
        return None
    normalized = normalize_text(value)
    if normalized is None:
        return None
    try:
        result = int(normalized)
        if result < 0:
            raise ValueError("negative")
        return result
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"{field_name} 必须是大于等于 0 的整数",
        )


# ============================================================
# 数字验证
# ============================================================

DECIMAL_ZERO = Decimal("0")
MONEY_QUANT = Decimal("0.01")
WEIGHT_QUANT = Decimal("0.001")
VOLUME_QUANT = Decimal("0.00001")


def decimal_to_float(value: Decimal | int | float | None, quant: Decimal) -> float:
    """Decimal 转为 float，保留指定精度"""
    if value is None:
        return float(DECIMAL_ZERO.quantize(quant))
    return float(Decimal(str(value)).quantize(quant, rounding=ROUND_HALF_UP))


def normalize_non_negative_decimal(
    value: Decimal | float | int | str, field_name: str, quant: Decimal
) -> Decimal:
    """验证并规范化非负数 Decimal 值"""
    try:
        normalized = Decimal(str(value)).quantize(quant, rounding=ROUND_HALF_UP)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"{field_name} 必须是数字",
        ) from exc
    if normalized < 0:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"{field_name} 必须大于等于 0",
        )
    return normalized


# ============================================================
# 国家/地区验证
# ============================================================

# ============================================================
# 文本验证
# ============================================================

def normalize_text_value(value: str | None, *, max_length: int | None = None) -> str | None:
    """规范化文本值"""
    return normalize_text(value, max_length=max_length)


# ============================================================
# 手动明细验证
# ============================================================

def normalize_manual_items(
    items: list[ShipmentScheduleItemInput] | None,
) -> list[dict[str, object]] | None:
    """
    验证并规范化手动输入的 SKU 明细
    返回规范化后的字典列表
    """
    if items is None:
        return None
    if len(items) == 0:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="SKU 明细不能为空，请至少保留一行有效明细",
        )

    normalized_items: list[dict[str, object]] = []
    seen_skus: set[str] = set()
    for index, item in enumerate(items, start=1):
        sku = normalize_text(item.sku, max_length=100)
        if sku is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"第 {index} 行 SKU 不能为空",
            )
        if sku in seen_skus:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"SKU 明细中存在重复 SKU: {sku}",
            )
        seen_skus.add(sku)
        normalized_items.append(
            {
                "row_no": index,
                "project_name": None,
                "shipment_no": None,
                "item_date": parse_date(item.item_date, f"第 {index} 行 item_date"),
                "sku": sku,
                "quantity": int(item.quantity),
                "carton_count": int(item.carton_count) if item.carton_count is not None else None,
                "remark": normalize_text(item.remark),
            }
        )
    return normalized_items


# ============================================================
# 明细匹配验证
# ============================================================

def manual_items_match_existing(
    schedule: ShipmentSchedule,
    items: list[dict[str, object]],
) -> bool:
    """检查新导入的明细是否与现有明细完全一致"""
    existing_items = sorted(
        schedule.items,
        key=lambda item: (
            item.item_date or date.min,
            item.sku,
            int(item.quantity),
            item.remark or "",
        ),
    )
    normalized_items = sorted(
        items,
        key=lambda item: (
            item["item_date"] or date.min,
            str(item["sku"]),
            int(item["quantity"]),
            str(item["remark"] or ""),
        ),
    )

    if len(existing_items) != len(normalized_items):
        return False

    return all(
        existing.item_date == incoming["item_date"]
        and existing.sku == str(incoming["sku"])
        and int(existing.quantity) == int(incoming["quantity"])
        and (existing.remark or None) == incoming["remark"]
        for existing, incoming in zip(existing_items, normalized_items)
    )