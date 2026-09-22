"""Shop calculation Excel export built from the authoritative backend snapshots."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone
from io import BytesIO
from typing import Literal

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.shop_calculation import ShopCalculation
from app.models.sku_info import SkuRecord
from app.services import shop_calculation_service

ExportMode = Literal["current", "history"]

US_FRONTEND_HEADERS = [
    "SKU",
    "FOB(RMB)",
    "长",
    "宽",
    "高",
    "重量(kg)",
    "计费重",
    "头程(RMB)",
    "DDP(RMB)",
    "DDP(USD)",
    "汇率",
    "售价(USD)",
    "广告费率%",
    "广告费",
    "退货折损率%",
    "退货损耗",
    "佣金",
    "派送费",
    "配置费",
    "仓储月数",
    "仓储费",
    "费用合计",
    "回款",
    "利润",
    "利润率",
    "尺寸等级",
    "售价带",
    "规则",
]

EU_FRONTEND_HEADERS = [
    "SKU",
    "FOB(RMB)",
    "长",
    "宽",
    "高",
    "重量(kg)",
    "计费重",
    "头程(RMB)",
    "DDP(RMB)",
    "DDP(USD)",
    "汇率",
    "售价(USD)",
    "平台佣金",
    "广告费率%",
    "广告费",
    "退货率%",
    "退货损失",
    "派送费",
    "配置费",
    "仓储费",
    "费用合计",
    "回款",
    "增值税",
    "利润(扣税后)",
    "利润率(扣税)",
]

TRACE_HEADERS = ["ASIN", "source", "observed_at", "warnings"]
XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


@dataclass(frozen=True)
class ShopCalculationExportResult:
    content: bytes
    filename: str
    row_count: int
    countries: tuple[str, ...]


def _safe_filename_part(value: str) -> str:
    cleaned = re.sub(r'[\\/:*?"<>|]+', "-", value).strip() or "未命名"
    return cleaned[:120]


def _frontend_headers(country: str) -> list[str]:
    if country == "US":
        return list(US_FRONTEND_HEADERS)
    headers = list(EU_FRONTEND_HEADERS)
    currency = {"DE": "EUR", "UK": "GBP"}.get(country, "USD")
    headers[9] = f"DDP({currency})"
    headers[11] = f"售价({currency})"
    return headers


def _calculation_rows(
    db: Session,
    *,
    project_id: int,
    country: str | None,
    sku: str | None,
    mode: ExportMode,
    as_of: datetime | None,
) -> list[ShopCalculation]:
    filters = [ShopCalculation.project_id == project_id]
    if country is not None:
        filters.append(ShopCalculation.country == country)
    if sku is not None:
        filters.append(ShopCalculation.sku == sku)

    if mode == "current" and as_of is None:
        statement = shop_calculation_service.latest_stmt().where(*filters)
        statement = statement.order_by(ShopCalculation.country, ShopCalculation.sku)
    elif mode == "current":
        latest_ids = (
            select(func.max(ShopCalculation.id))
            .where(
                ShopCalculation.deleted_at.is_(None),
                *filters,
                ShopCalculation.observed_at <= as_of,
            )
            .group_by(
                ShopCalculation.project_id,
                ShopCalculation.sku,
                ShopCalculation.country,
            )
        )
        statement = select(ShopCalculation).where(ShopCalculation.id.in_(latest_ids))
        statement = statement.order_by(ShopCalculation.country, ShopCalculation.sku)
    else:
        statement = select(ShopCalculation).where(
            ShopCalculation.deleted_at.is_(None),
            *filters,
        )
        if as_of is not None:
            statement = statement.where(ShopCalculation.observed_at <= as_of)
        statement = statement.order_by(
            ShopCalculation.country,
            ShopCalculation.sku,
            ShopCalculation.observed_at.desc(),
            ShopCalculation.id.desc(),
        )

    return list(db.scalars(statement))


def _sku_rows(
    db: Session,
    *,
    project_id: int,
    country: str | None,
    sku: str | None,
) -> list[SkuRecord]:
    filters = [SkuRecord.project_id == project_id, SkuRecord.is_active.is_(True)]
    if country is not None:
        filters.append(SkuRecord.country == country)
    if sku is not None:
        filters.append(SkuRecord.sku == sku)
    rows = list(
        db.scalars(
            select(SkuRecord)
            .where(*filters)
            .order_by(SkuRecord.country, SkuRecord.sort_order, SkuRecord.id)
        )
    )
    deduped: dict[tuple[str, str], SkuRecord] = {}
    for row in rows:
        deduped.setdefault((str(row.sku), str(row.country)), row)
    return list(deduped.values())


def _as_float(value: object | None) -> float | None:
    return float(value) if value is not None else None


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


def _master_value(
    master: SkuRecord | None, row: ShopCalculation | None, name: str
) -> object | None:
    if master is not None and hasattr(master, name):
        return getattr(master, name)
    return getattr(row, name, None) if row is not None else None


def _chargeable_weight(
    master: SkuRecord | None, row: ShopCalculation | None
) -> float | None:
    weight = _master_value(master, row, "weight_kg")
    length = _master_value(master, row, "package_length_cm")
    width = _master_value(master, row, "package_width_cm")
    height = _master_value(master, row, "package_height_cm")
    if None in (weight, length, width, height):
        return None
    return max(float(weight), float(length) * float(width) * float(height) / 6000)


def _trace_values(
    row: ShopCalculation | None, master: SkuRecord | None
) -> list[object | None]:
    if row is None:
        return [
            str(master.asin) if master is not None else None,
            None,
            None,
            "未核算/缺数据",
        ]
    warnings = "; ".join(str(value) for value in (row.warnings_json or []))
    return [
        str(row.asin or (master.asin if master is not None else "")) or None,
        row.source,
        _iso(row.observed_at),
        warnings or None,
    ]


def _row_values(
    row: ShopCalculation | None,
    master: SkuRecord | None,
    *,
    country: str,
) -> list[object | None]:
    sku = str(row.sku if row is not None else master.sku)
    basic = [
        sku,
        _as_float(
            _master_value(
                master,
                row,
                "fob_unit_cost" if master is not None else "fob_product_cost_rmb",
            )
        ),
        _as_float(_master_value(master, row, "package_length_cm")),
        _as_float(_master_value(master, row, "package_width_cm")),
        _as_float(_master_value(master, row, "package_height_cm")),
        _as_float(_master_value(master, row, "weight_kg")),
        _chargeable_weight(master, row),
        _as_float(_master_value(master, row, "first_leg_cost_rmb")),
    ]
    if row is None:
        values = basic + ([None] * 20 if country == "US" else [None] * 17)
    elif country == "US":
        values = basic + [
            _as_float(row.ddp_cost_rmb),
            _as_float(row.ddp_cost_usd),
            _as_float(row.usd_to_rmb_rate),
            _as_float(row.sale_price_usd),
            _as_float(row.advertising_rate) * 100,
            _as_float(row.advertising_fee_usd),
            _as_float(row.return_loss_rate) * 100,
            _as_float(row.return_loss_usd),
            _as_float(row.referral_fee_usd),
            _as_float(row.fba_fulfillment_fee_usd),
            _as_float(row.inbound_config_fee_usd),
            _as_float(row.storage_months),
            _as_float(row.storage_fee_usd),
            _as_float(row.total_fee_usd),
            _as_float(row.payout_usd),
            _as_float(row.profit_usd),
            _as_float(row.profit_rate),
            row.size_tier_label,
            row.price_band_label,
            f"{row.fulfillment_fee_rule_label} / {row.inbound_config_fee_rule_label} / {row.storage_fee_rule_label}",
        ]
    else:
        profit_after_vat = (
            row.profit_after_vat_usd
            if row.profit_after_vat_usd is not None
            else row.profit_usd
        )
        profit_rate_after_vat = (
            row.profit_after_vat_rate
            if row.profit_after_vat_rate is not None
            else row.profit_rate
        )
        values = basic + [
            _as_float(row.ddp_cost_rmb),
            _as_float(row.ddp_cost_usd),
            _as_float(row.usd_to_rmb_rate),
            _as_float(row.sale_price_usd),
            _as_float(row.platform_fee_usd),
            _as_float(row.advertising_rate) * 100,
            _as_float(row.advertising_fee_usd),
            _as_float(row.return_loss_rate) * 100,
            _as_float(row.return_loss_usd),
            _as_float(row.delivery_fee_usd),
            _as_float(row.inbound_config_fee_manual_usd),
            _as_float(row.storage_fee_manual_usd),
            _as_float(row.total_fee_usd),
            _as_float(row.payout_usd),
            _as_float(row.vat_usd),
            _as_float(profit_after_vat),
            _as_float(profit_rate_after_vat),
        ]
    return values + _trace_values(row, master)


def _group_headers(
    country: str, column_count: int
) -> list[tuple[str, int, int, str, str]]:
    if country == "US":
        groups = [
            ("店铺产品", 1, 1, "FF312E81", "FFE0E7FF"),
            ("货品数据", 2, 7, "FF0C4A6E", "FFE0F2FE"),
            ("DDP成本", 8, 11, "FF78350F", "FFFEF3C7"),
            ("费用支出", 12, 22, "FF881337", "FFFFE4E6"),
            ("利润核算", 23, 26, "FF064E3B", "FFD1FAE5"),
            ("产品核定", 27, 28, "FF4C1D95", "FFEDE9FE"),
        ]
    else:
        groups = [
            ("店铺产品", 1, 1, "FF312E81", "FFE0E7FF"),
            ("货品数据", 2, 7, "FF0C4A6E", "FFE0F2FE"),
            ("DDP成本", 8, 11, "FF78350F", "FFFEF3C7"),
            ("费用支出", 12, 21, "FF881337", "FFFFE4E6"),
            ("利润核算", 22, 25, "FF064E3B", "FFD1FAE5"),
        ]
    trace_start = column_count - len(TRACE_HEADERS) + 1
    groups.append(("数据追溯", trace_start, column_count, "FF475569", "FFE2E8F0"))
    return groups


def _write_sheet(
    worksheet,
    *,
    project_name: str,
    country: str,
    rows: list[list[object | None]],
) -> None:
    frontend_headers = _frontend_headers(country)
    headers = frontend_headers + TRACE_HEADERS
    worksheet.title = f"{country}店铺SKU测算"
    worksheet.sheet_view.showGridLines = False
    column_count = len(headers)
    border = Border(
        left=Side(style="thin", color="D0D5DD"),
        right=Side(style="thin", color="D0D5DD"),
        top=Side(style="thin", color="D0D5DD"),
        bottom=Side(style="thin", color="D0D5DD"),
    )
    worksheet.merge_cells(
        start_row=1, start_column=1, end_row=1, end_column=column_count
    )
    title = worksheet.cell(1, 1, f"{country}店铺SKU测算表 - {project_name}")
    title.font = Font(name="Microsoft YaHei", size=14, bold=True)
    title.fill = PatternFill("solid", fgColor="E2E8F0")
    title.alignment = Alignment(horizontal="center", vertical="center")
    worksheet.row_dimensions[1].height = 24
    for column in range(1, column_count + 1):
        worksheet.cell(1, column).border = border

    worksheet.append([None] * column_count)
    for name, start, end, dark, _ in _group_headers(country, column_count):
        cell = worksheet.cell(2, start, name)
        cell.font = Font(name="Microsoft YaHei", size=10, bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor=dark)
        cell.alignment = Alignment(horizontal="center", vertical="center")
        cell.border = border
        if end > start:
            worksheet.merge_cells(
                start_row=2, start_column=start, end_row=2, end_column=end
            )
    worksheet.row_dimensions[2].height = 20

    worksheet.append(headers)
    for cell in worksheet[3]:
        cell.font = Font(name="Microsoft YaHei", size=9, bold=True)
        cell.fill = PatternFill("solid", fgColor="E2E8F0")
        cell.alignment = Alignment(
            horizontal="center", vertical="center", wrap_text=True
        )
        cell.border = border
    worksheet.row_dimensions[3].height = 20

    percentage_columns = {
        headers.index("利润率") + 1 if "利润率" in headers else -1,
        headers.index("利润率(扣税)") + 1 if "利润率(扣税)" in headers else -1,
    }
    for index, values in enumerate(rows, start=4):
        worksheet.append(values)
        for column, value in enumerate(values, start=1):
            cell = worksheet.cell(index, column)
            cell.font = Font(name="Microsoft YaHei", size=9)
            cell.alignment = Alignment(
                horizontal="center", vertical="center", wrap_text=column == column_count
            )
            cell.border = border
            cell.fill = PatternFill(
                "solid", fgColor="F8FAFC" if index % 2 == 0 else "FFFFFF"
            )
            if column in percentage_columns:
                cell.number_format = "0.00%"
            elif isinstance(value, (int, float)):
                cell.number_format = "#,##0.00"
        profit_column = (
            headers.index("利润") + 1
            if "利润" in headers
            else headers.index("利润(扣税后)") + 1
        )
        profit_value = worksheet.cell(index, profit_column).value
        if isinstance(profit_value, (int, float)) and profit_value < 0:
            worksheet.cell(index, profit_column).font = Font(
                name="Microsoft YaHei", size=9, color="DC2626"
            )

    worksheet.freeze_panes = "A4"
    worksheet.auto_filter.ref = f"A3:{worksheet.cell(3, column_count).coordinate}"
    for column in range(1, column_count + 1):
        width = max(
            10,
            min(
                42,
                max(
                    len(str(worksheet.cell(row, column).value or ""))
                    for row in range(1, worksheet.max_row + 1)
                )
                + 2,
            ),
        )
        worksheet.column_dimensions[
            worksheet.cell(3, column).column_letter
        ].width = width


def _write_workbook(
    *,
    project_name: str,
    country_rows: dict[str, list[list[object | None]]],
) -> bytes:
    workbook = Workbook()
    if not country_rows:
        country_rows = {"US": []}
    for index, (country, rows) in enumerate(sorted(country_rows.items())):
        worksheet = workbook.active if index == 0 else workbook.create_sheet()
        _write_sheet(
            worksheet,
            project_name=project_name,
            country=country,
            rows=rows,
        )
    output = BytesIO()
    workbook.save(output)
    return output.getvalue()


def build_shop_calculation_export(
    db: Session,
    *,
    project_id: int,
    project_name: str,
    country: str | None = None,
    sku: str | None = None,
    mode: ExportMode = "current",
    as_of: datetime | None = None,
    include_uncomputed: bool = True,
) -> ShopCalculationExportResult:
    if mode not in ("current", "history"):
        raise ValueError("mode must be current or history")
    if as_of is not None and as_of.tzinfo is None:
        as_of = as_of.replace(tzinfo=timezone.utc)

    calculation_rows = _calculation_rows(
        db,
        project_id=project_id,
        country=country,
        sku=sku,
        mode=mode,
        as_of=as_of,
    )
    sku_rows = _sku_rows(db, project_id=project_id, country=country, sku=sku)
    masters = {(str(row.sku), str(row.country)): row for row in sku_rows}
    calculated_keys = {(str(row.sku), str(row.country)) for row in calculation_rows}

    country_rows: dict[str, list[list[object | None]]] = {}
    for row in calculation_rows:
        master = masters.get((str(row.sku), str(row.country)))
        country_rows.setdefault(str(row.country), []).append(
            _row_values(row, master, country=str(row.country))
        )
    if include_uncomputed:
        for master in sku_rows:
            key = (str(master.sku), str(master.country))
            if key not in calculated_keys:
                country_rows.setdefault(str(master.country), []).append(
                    _row_values(None, master, country=str(master.country))
                )

    content = _write_workbook(
        project_name=project_name,
        country_rows=country_rows,
    )
    country_part = country or "全部站点"
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%SZ")
    filename = (
        f"{_safe_filename_part(project_name)}_{_safe_filename_part(country_part)}"
        f"-店铺SKU测算-{timestamp}.xlsx"
    )
    countries = tuple(
        sorted(
            {str(row.country) for row in calculation_rows}
            | {str(row.country) for row in sku_rows}
        )
    )
    return ShopCalculationExportResult(
        content=content,
        filename=filename,
        row_count=sum(len(rows) for rows in country_rows.values()),
        countries=countries,
    )
