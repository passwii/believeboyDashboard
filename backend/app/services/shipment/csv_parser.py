"""
CSV 解析模块

提供发货计划和 SKU 明细的 CSV 解析功能
"""
from __future__ import annotations

import csv
from io import StringIO
from typing import TYPE_CHECKING

from fastapi import HTTPException, status

from app.services.shipment.validation import (
    normalize_shipping_method,
    normalize_shipment_no_filters,
    normalize_status,
    normalize_text_value,
    parse_carton_count,
    parse_date,
)
from app.utils.country import normalize_country

if TYPE_CHECKING:
    from decimal import Decimal


# ============================================================
# 编码处理
# ============================================================

def decode_csv_text(content: bytes) -> str:
    """解码 CSV 内容，支持 UTF-8 和 GBK/ANSI 编码"""
    for encoding in ("utf-8-sig", "gb18030"):
        try:
            return content.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="CSV 编码必须为 UTF-8 或 GBK/ANSI（Excel 常见编码）",
    )


def header_value(row: dict[str, str | None], key: str) -> str | None:
    """从 CSV 行中获取表头值（不区分大小写）"""
    for candidate in (key, key.lower(), key.upper()):
        if candidate in row:
            return row.get(candidate)
    return None


# ============================================================
# SKU 明细 CSV 解析
# ============================================================

def parse_shipment_items_csv(content: bytes) -> list[dict[str, object]]:
    """
    解析 SKU 明细 CSV 文件

    必需列: project_name, shipment_no, SKU
    可选列: quantity, carton_count, date, remark

    quantity 和 carton_count 至少需要一个
    如果只有 carton_count，会通过 SKU 信息中的 units_per_carton 反推 quantity
    """
    text = decode_csv_text(content)

    reader = csv.DictReader(StringIO(text))
    if not reader.fieldnames:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="CSV 缺少表头",
        )

    available_headers = {str(name).strip() for name in reader.fieldnames if name}
    has_quantity = "quantity" in available_headers
    has_carton_count = "carton_count" in available_headers
    if not has_quantity and not has_carton_count:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="CSV 必须包含 quantity 或 carton_count 字段（至少填一个）",
        )

    # 验证必需列
    required = {"project_name", "shipment_no", "SKU"}
    if not required.issubset(available_headers):
        missing = ", ".join(sorted(required - available_headers))
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"CSV 缺少字段: {missing}",
        )

    items: list[dict[str, object]] = []
    for index, row in enumerate(reader, start=2):
        normalized = {(key or "").strip(): value for key, value in row.items()}
        sku = normalize_text_value(normalized.get("SKU"), max_length=100)
        shipment_no = normalize_text_value(normalized.get("shipment_no"), max_length=100)
        project_name = normalize_text_value(normalized.get("project_name"), max_length=255)

        # 跳过空行
        if sku is None or shipment_no is None or project_name is None:
            continue

        # 解析数量
        quantity_text = normalize_text_value(normalized.get("quantity"))
        carton_count_text = normalize_text_value(normalized.get("carton_count"))
        parsed_carton_count = parse_carton_count(
            carton_count_text, f"第 {index} 行 carton_count"
        )

        if quantity_text is not None:
            try:
                quantity = int(quantity_text)
            except ValueError:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"第 {index} 行 quantity 必须是整数",
                )
            if quantity <= 0:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"第 {index} 行 quantity 必须大于 0",
                )
        else:
            quantity = None  # 稍后在 validate_items_against_product_costs 中计算

        items.append(
            {
                "row_no": index,
                "project_name": project_name,
                "shipment_no": shipment_no,
                "item_date": parse_date(normalized.get("date"), f"第 {index} 行 date"),
                "sku": sku,
                "quantity": quantity,
                "carton_count": parsed_carton_count,
                "remark": normalize_text_value(normalized.get("remark")),
            }
        )

    if not items:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="CSV 没有可导入的有效数据",
        )
    return items


# ============================================================
# 发货计划 CSV 解析
# ============================================================

def parse_shipment_schedules_csv(content: bytes) -> list[dict[str, object]]:
    """
    解析发货计划 CSV 文件

    必需列: project_name, country, shipment_no, shipping_method, shipment_status
    可选列: tracking_no, warehouse_code, forwarder_name, created_date,
            etd_date, eta_date, actual_inbound_date, remark
    """
    text = decode_csv_text(content)

    reader = csv.DictReader(StringIO(text))
    if not reader.fieldnames:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="CSV 缺少表头",
        )

    available_headers = {str(name).strip() for name in reader.fieldnames if name}

    # 验证必需列
    required = {"project_name", "country", "shipment_no", "shipping_method", "shipment_status"}
    if not required.issubset(available_headers):
        missing = ", ".join(sorted(required - available_headers))
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"CSV 缺少字段: {missing}",
        )

    schedules: list[dict[str, object]] = []
    shipment_nos_seen: set[str] = set()

    for index, row in enumerate(reader, start=2):
        normalized = {(key or "").strip(): value for key, value in row.items()}

        project_name = normalize_text_value(
            header_value(normalized, "project_name"), max_length=255
        )
        shipment_no = normalize_text_value(
            header_value(normalized, "shipment_no"), max_length=100
        )

        # 跳过完全空的行
        if project_name is None and shipment_no is None:
            continue

        # 验证必需字段
        if project_name is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"第 {index} 行 project_name 不能为空",
            )
        if shipment_no is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"第 {index} 行 shipment_no 不能为空",
            )

        # 检查重复
        if shipment_no in shipment_nos_seen:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"CSV 中存在重复 shipment_no: {shipment_no}",
            )
        shipment_nos_seen.add(shipment_no)

        schedules.append(
            {
                "row_no": index,
                "project_name": project_name,
                "country": normalize_country(header_value(normalized, "country")) or "US",
                "shipment_no": shipment_no,
                "tracking_no": normalize_text_value(
                    header_value(normalized, "tracking_no"), max_length=100
                ),
                "warehouse_code": normalize_text_value(
                    header_value(normalized, "warehouse_code"), max_length=100
                ),
                "forwarder_name": normalize_text_value(
                    header_value(normalized, "forwarder_name"), max_length=100
                ),
                "shipping_method": normalize_shipping_method(
                    str(header_value(normalized, "shipping_method") or "")
                ),
                "created_date": parse_date(
                    header_value(normalized, "created_date"),
                    f"第 {index} 行 created_date",
                ),
                "etd_date": parse_date(
                    header_value(normalized, "etd_date"),
                    f"第 {index} 行 etd_date",
                ),
                "eta_date": parse_date(
                    header_value(normalized, "eta_date"),
                    f"第 {index} 行 eta_date",
                ),
                "actual_inbound_date": parse_date(
                    header_value(normalized, "actual_inbound_date"),
                    f"第 {index} 行 actual_inbound_date",
                ),
                "remark": normalize_text_value(header_value(normalized, "remark")),
                "shipment_status": normalize_status(
                    str(header_value(normalized, "shipment_status") or "")
                ),
            }
        )

    if not schedules:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="CSV 没有可导入的有效数据",
        )
    return schedules