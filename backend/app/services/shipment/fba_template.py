"""FBA 发货模板（Create workflow – template）xlsx 导出。"""

from __future__ import annotations

import re
from dataclasses import dataclass
from io import BytesIO

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.sku_info import SkuRecord
from app.services.shipment.schedule import get_shipment_schedule_detail
from app.services.shipment.serialization import build_shipment_schedule_detail
from app.utils.country import get_country_label_cn

SHEET_NAME = "Create workflow – template"
XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
METRIC_COUNTRIES = frozenset({"DE", "UK"})
CM_TO_INCH = 2.54
KG_TO_LB = 2.20462
DATA_START_ROW = 4

_COLUMN_WIDTHS = (24, 12, 14, 16, 16, 16, 16, 14)
_FONT_NAME = "Microsoft YaHei"
_TEXT_COLOR = "FF0F172A"
_HEADER_FILL = "FFE2E8F0"
_BORDER_COLOR = "FFE2E8F0"
_HEADER_BORDER_COLOR = "FFCBD5E1"
_UNSAFE_FILENAME_CHARS = re.compile(r'[\\/:*?"<>|]')


@dataclass(frozen=True)
class FbaTemplateArtifact:
    """可直接作为 HTTP 文件响应返回的 FBA 模板。"""

    filename: str
    content: bytes
    content_type: str = XLSX_CONTENT_TYPE


def _headers(use_metric: bool) -> list[str]:
    length_unit = "cm" if use_metric else "in"
    weight_unit = "kg" if use_metric else "lb"
    return [
        "Merchant SKU",
        "Quantity",
        "Units per box",
        "Number of boxes",
        f"Box length ({length_unit})",
        f"Box width ({length_unit})",
        f"Box height ({length_unit})",
        f"Box weight ({weight_unit})",
    ]


def _round2(value: float) -> float:
    return round(float(value), 2)


def _box_dimensions(info: SkuRecord | None, use_metric: bool) -> list[float | None]:
    """将 SKU 外箱尺寸/重量转换为模板单位；缺失或非正数留空。"""
    if info is None:
        return [None, None, None, None]

    length = float(info.carton_length_cm or 0)
    width = float(info.carton_width_cm or 0)
    height = float(info.carton_height_cm or 0)
    weight = float(info.carton_weight_kg or 0)
    if use_metric:
        return [
            _round2(value) if value > 0 else None
            for value in (length, width, height, weight)
        ]
    return [
        *[
            _round2(value / CM_TO_INCH) if value > 0 else None
            for value in (length, width, height)
        ],
        _round2(weight * KG_TO_LB) if weight > 0 else None,
    ]


def _load_carton_info(
    db: Session,
    *,
    project_name: str,
    country: str,
    skus: list[str],
) -> dict[str, SkuRecord]:
    """按项目、站点和 SKU 加载装箱主数据；后出现的记录覆盖前一条。"""
    if not skus:
        return {}

    rows = (
        db.execute(
            select(SkuRecord)
            .where(
                SkuRecord.project_name == project_name,
                SkuRecord.country == country,
                SkuRecord.sku.in_(skus),
            )
            .order_by(SkuRecord.sort_order.asc(), SkuRecord.id.asc())
        )
        .scalars()
        .all()
    )
    return {str(row.sku): row for row in rows}


def _build_rows(
    detail, carton_info: dict[str, SkuRecord], use_metric: bool
) -> list[list]:
    rows: list[list] = []
    for item in detail.items:
        info = carton_info.get(item.sku)
        units_per_box = int(getattr(info, "units_per_carton", 0) or 0) if info else 0
        carton_count = int(item.carton_count or 0)
        rows.append(
            [
                str(item.sku),
                int(item.quantity),
                units_per_box if units_per_box > 0 else None,
                carton_count if carton_count > 0 else None,
                *_box_dimensions(info, use_metric),
            ]
        )
    return rows


def _render_xlsx(*, headers: list[str], rows: list[list]) -> bytes:
    """渲染模板 xlsx；openpyxl 只在真正导出时加载。"""
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    from openpyxl.utils import get_column_letter

    workbook = Workbook()
    worksheet = workbook.active
    worksheet.title = SHEET_NAME
    worksheet.freeze_panes = "A4"
    worksheet.sheet_view.showGridLines = False

    for index, width in enumerate(_COLUMN_WIDTHS, start=1):
        worksheet.column_dimensions[get_column_letter(index)].width = width

    thin_border = Border(
        left=Side(style="thin", color=_BORDER_COLOR),
        right=Side(style="thin", color=_BORDER_COLOR),
        top=Side(style="thin", color=_BORDER_COLOR),
        bottom=Side(style="thin", color=_BORDER_COLOR),
    )
    info_font = Font(name=_FONT_NAME, size=9, color=_TEXT_COLOR)
    info_alignment = Alignment(vertical="center", horizontal="left")
    for row_index, label in ((1, "Default prep owner"), (2, "Default labeling owner")):
        worksheet.row_dimensions[row_index].height = 18
        for column, value in ((1, label), (2, "Seller")):
            cell = worksheet.cell(row=row_index, column=column, value=value)
            cell.font = info_font
            cell.alignment = info_alignment
            cell.border = thin_border

    worksheet.row_dimensions[3].height = 22
    header_font = Font(name=_FONT_NAME, bold=True, color=_TEXT_COLOR)
    header_fill = PatternFill(fill_type="solid", fgColor=_HEADER_FILL)
    header_alignment = Alignment(vertical="center", horizontal="center")
    header_border = Border(
        left=Side(style="thin", color=_HEADER_BORDER_COLOR),
        right=Side(style="thin", color=_HEADER_BORDER_COLOR),
        top=Side(style="thin", color=_HEADER_BORDER_COLOR),
        bottom=Side(style="thin", color=_HEADER_BORDER_COLOR),
    )
    for column, title in enumerate(headers, start=1):
        cell = worksheet.cell(row=3, column=column, value=title)
        cell.font = header_font
        cell.fill = header_fill
        cell.alignment = header_alignment
        cell.border = header_border

    data_font = Font(name=_FONT_NAME, size=9, color=_TEXT_COLOR)
    for offset, values in enumerate(rows):
        row_index = DATA_START_ROW + offset
        worksheet.row_dimensions[row_index].height = 18
        for column, value in enumerate(values, start=1):
            cell = worksheet.cell(row=row_index, column=column, value=value)
            cell.font = data_font
            cell.alignment = Alignment(
                vertical="center",
                horizontal="left" if column <= 2 else "right",
            )
            cell.border = thin_border

    buffer = BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def _build_filename(*, project_name: str, country: str, shipment_no: str) -> str:
    safe_project = _UNSAFE_FILENAME_CHARS.sub("-", project_name or "未选项目")
    site_label = get_country_label_cn(country)
    return f"{safe_project}_{site_label}-FBA发货模板-{shipment_no}.xlsx"


def build_fba_delivery_template(db: Session, schedule) -> FbaTemplateArtifact:
    """生成货件 FBA 发货模板，返回可直接下载的二进制文件。"""
    row, sku_count, total_quantity = get_shipment_schedule_detail(db, schedule.id)
    detail = build_shipment_schedule_detail(row, sku_count, total_quantity)
    country = str(detail.country).strip().upper()
    use_metric = country in METRIC_COUNTRIES
    carton_info = _load_carton_info(
        db,
        project_name=str(detail.project_name),
        country=country,
        skus=[str(item.sku) for item in detail.items],
    )
    rows = _build_rows(detail, carton_info, use_metric)
    content = _render_xlsx(headers=_headers(use_metric), rows=rows)
    return FbaTemplateArtifact(
        filename=_build_filename(
            project_name=str(detail.project_name),
            country=country,
            shipment_no=str(detail.shipment_no),
        ),
        content=content,
    )
