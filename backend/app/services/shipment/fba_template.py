"""FBA 发货模板（Create workflow – template）xlsx 导出（BLF-1178）。

对应前端「编辑船期批次 → 导出 FBA 发货模板」
（``frontend/app/dashboard/operations/shipment-management/page.tsx`` 的
``exportFbaDeliveryTemplateToExcel``，纯前端 exceljs 生成）。本模块在服务端用
openpyxl 复刻同一份输出，供持有 ``business_scope("shipments")`` 凭据的 agent
通过 ``GET /projects/{project_id}/shipments/{shipment_no}/fba-delivery-template``
拿到模板文件（base64 xlsx）。

模板结构（亚马逊 Create workflow 要求，所有站点一致）：

- 第 1 行 ``Default prep owner`` / ``Seller``
- 第 2 行 ``Default labeling owner`` / ``Seller``
- 第 3 行 表头（8 列：Merchant SKU / Quantity / Units per box / Number of boxes /
  Box length / Box width / Box height / Box weight）
- 第 4 行起 数据行

单位按站点区分（与前端口径一致）：DE / UK 用 cm/kg（metric），其余站点（US）
换算成 in/lb（imperial，1 in = 2.54 cm，1 kg = 2.20462 lb），保留 2 位小数。

数据来源：货件明细的 ``sku / quantity / carton_count``（持久化值；前端界面上
未保存的箱数编辑不在库里——agent 侧如需改箱数先走 W2 ``PUT .../items``）+
SKU 主数据（``product_costs``）的 ``units_per_carton / carton_*`` 装箱信息。

openpyxl 懒加载：该库拖入 numpy+PIL（约 40MB），只在导出路径 import
（与 ``services/report/export.py``、``services/category/export.py`` 同一约定）。
"""

from __future__ import annotations

import base64
import re
from io import BytesIO

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.sku_info import SkuRecord
from app.services.shipment.schedule import get_shipment_schedule_detail
from app.services.shipment.serialization import build_shipment_schedule_detail
from app.utils.country import get_country_label_cn

#: 工作表名（亚马逊 Create workflow 模板约定名，前端同款）。
SHEET_NAME = "Create workflow – template"

XLSX_CONTENT_TYPE = (
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
)

#: 用公制单位（cm/kg）的站点；其余站点换算英制（in/lb）。
METRIC_COUNTRIES = frozenset({"DE", "UK"})

CM_TO_INCH = 2.54
KG_TO_LB = 2.20462

#: 数据行从第 4 行开始（前 2 行 prep/labeling owner + 第 3 行表头）。
DATA_START_ROW = 4

#: 8 列列宽（ExcelJS width 单位 ≈ 字符数，openpyxl 同义）。
_COLUMN_WIDTHS = (24, 12, 14, 16, 16, 16, 16, 14)

_FONT_NAME = "Microsoft YaHei"
_TEXT_COLOR = "FF0F172A"
_HEADER_FILL = "FFE2E8F0"
_BORDER_COLOR = "FFE2E8F0"
_HEADER_BORDER_COLOR = "FFCBD5E1"

_UNSAFE_FILENAME_CHARS = re.compile(r'[\\/:*?"<>|]')


def _headers(use_metric: bool) -> list[str]:
    """第 3 行表头：仅尺寸/重量单位随站点变（cm/kg vs in/lb）。"""
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
    """外箱尺寸/毛重 → 4 列值；缺失或非正数给 ``None``（空单元格，前端写 ''）。"""
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
        _round2(value / CM_TO_INCH) if value > 0 else None
        for value in (length, width, height)
    ] + [_round2(weight * KG_TO_LB) if weight > 0 else None]


def _load_carton_info(
    db: Session, *, project_name: str, country: str, skus: list[str]
) -> dict[str, SkuRecord]:
    """按 (project_name, country) 取 SKU 装箱信息，key 为 sku。

    排序与 ``list_sku_records`` 一致（``sort_order, id``）；同 sku 多条时后者
    覆盖前者——与前端 ``skuInfoMap``「列表序后者生效」口径相同。
    """
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
    info: dict[str, SkuRecord] = {}
    for row in rows:
        info[str(row.sku)] = row
    return info


def _build_rows(detail, carton_info: dict[str, SkuRecord], use_metric: bool) -> list:
    """明细 → 数据行（每行 8 列），逐字段对齐前端 ``detail.items.forEach``。"""
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
    """按模板结构渲染 xlsx 字节（openpyxl 懒加载，样式对齐前端 exceljs 输出）。"""
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    from openpyxl.utils import get_column_letter

    workbook = Workbook()
    worksheet = workbook.active
    worksheet.title = SHEET_NAME
    # ExcelJS views ySplit=3：前 3 行冻结 → openpyxl 冻结窗格在 A4。
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

    # ---- 第 1/2 行：亚马逊必需的 Default prep / labeling owner（仅 A、B 两列）----
    info_font = Font(name=_FONT_NAME, size=9, color=_TEXT_COLOR)
    info_alignment = Alignment(vertical="center", horizontal="left")
    for row_index, label in ((1, "Default prep owner"), (2, "Default labeling owner")):
        worksheet.row_dimensions[row_index].height = 18
        for column, value in ((1, label), (2, "Seller")):
            cell = worksheet.cell(row=row_index, column=column, value=value)
            cell.font = info_font
            cell.alignment = info_alignment
            cell.border = thin_border

    # ---- 第 3 行：表头 ----
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

    # ---- 第 4 行起：数据行（前 2 列左对齐，数值列右对齐）----
    data_font = Font(name=_FONT_NAME, size=9, color=_TEXT_COLOR)
    for offset, values in enumerate(rows):
        row_index = DATA_START_ROW + offset
        worksheet.row_dimensions[row_index].height = 18
        for column, value in enumerate(values, start=1):
            cell = worksheet.cell(row=row_index, column=column, value=value)
            cell.font = data_font
            cell.alignment = Alignment(
                vertical="center", horizontal="left" if column <= 2 else "right"
            )
            cell.border = thin_border

    buffer = BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def _build_filename(*, project_name: str, country: str, shipment_no: str) -> str:
    """文件名 ``${项目}_${中文站点}-FBA发货模板-${货件编号}.xlsx``（前端同款）。"""
    safe_project = _UNSAFE_FILENAME_CHARS.sub("-", project_name or "未选项目")
    site_label = get_country_label_cn(country)
    return f"{safe_project}_{site_label}-FBA发货模板-{shipment_no}.xlsx"


def build_fba_delivery_template(db: Session, schedule) -> dict:
    """生成货件的 FBA 发货模板，返回 agent 响应 payload（含 base64 xlsx）。

    纯读：不落审计、不写库（对齐 shipments 域读路由约定）。货件没有明细时仍
    输出只有 prep/labeling owner + 表头的空模板（与前端导出按钮口径一致）。
    """
    row, sku_count, total_quantity = get_shipment_schedule_detail(db, schedule.id)
    detail = build_shipment_schedule_detail(row, sku_count, total_quantity)
    country = str(detail.country)
    use_metric = country.upper() in METRIC_COUNTRIES
    carton_info = _load_carton_info(
        db,
        project_name=str(detail.project_name),
        country=country,
        skus=[str(item.sku) for item in detail.items],
    )
    rows = _build_rows(detail, carton_info, use_metric)
    content = _render_xlsx(headers=_headers(use_metric), rows=rows)
    return {
        "shipment_no": str(detail.shipment_no),
        "project_name": str(detail.project_name),
        "country": country,
        "unit_system": "metric" if use_metric else "imperial",
        "sheet_name": SHEET_NAME,
        "row_count": len(rows),
        "filename": _build_filename(
            project_name=str(detail.project_name),
            country=country,
            shipment_no=str(detail.shipment_no),
        ),
        "content_type": XLSX_CONTENT_TYPE,
        "content_base64": base64.b64encode(content).decode("ascii"),
    }
