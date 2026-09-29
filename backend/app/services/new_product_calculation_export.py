"""Agent 新品测算对比矩阵 XLSX 导出。"""

from __future__ import annotations

import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from io import BytesIO
from typing import Literal

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.worksheet.worksheet import Worksheet

from app.models.new_product_calculation import NewProductCalculation

XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
MAX_COMPARISON_SNAPSHOTS = 12

ValueType = Literal["text", "currency_usd", "currency_rmb", "percent", "number"]

_SECTION_FILLS = {
    "货品数据": "DCEEFF",
    "DDP 成本": "FEE7C7",
    "费用支出": "FFD9E2",
    "售价与利润": "D8F7E7",
    "核算规则": "E9D5F9",
}

_CALCULATION_TYPE_LABELS = {
    "profit_calc": "利润核算",
    "profit_reverse": "利润倒算",
    "cost_reverse": "成本倒推",
    "fbm_calc": "FBM测算",
}


@dataclass(frozen=True)
class NewProductComparisonExportResult:
    content: bytes
    filename: str
    column_count: int


@dataclass(frozen=True)
class _ComparisonRow:
    section: str
    label: str
    value_type: ValueType
    getter: Callable[[NewProductCalculation], object]


def _safe_filename_part(value: str) -> str:
    cleaned = re.sub(r'[\\/:*?"<>|]+', "-", value).strip() or "未命名"
    return cleaned[:120]


def _as_float(value: object | None) -> float | None:
    return float(value) if value is not None else None


def _number_text(value: object | None) -> str:
    number = _as_float(value)
    if number is None:
        return "-"
    return str(int(number)) if number.is_integer() else f"{number:g}"


def _product_name(row: NewProductCalculation) -> str:
    return f"{row.project_name} / {row.sku}"


def _packaging_size(row: NewProductCalculation) -> str:
    return (
        f"{_number_text(row.package_length_cm)} × "
        f"{_number_text(row.package_width_cm)} × "
        f"{_number_text(row.package_height_cm)}"
    )


def _dimensions_in(row: NewProductCalculation) -> str:
    return (
        f"{_number_text(row.longest_side_in)} × "
        f"{_number_text(row.middle_side_in)} × "
        f"{_number_text(row.shortest_side_in)}"
    )


def _commission_rate(row: NewProductCalculation) -> object:
    sale_price = _as_float(row.sale_price_usd)
    if not sale_price:
        return "-"
    return _as_float(row.referral_fee_usd) / sale_price


def _comparison_rows() -> list[_ComparisonRow]:
    return [
        _ComparisonRow(
            "货品数据", "产品名称", "text", lambda row: _product_name(row)
        ),
        _ComparisonRow("货品数据", "SKU", "text", lambda row: row.sku),
        _ComparisonRow(
            "货品数据",
            "国家站点",
            "text",
            lambda row: row.country or "-",
        ),
        _ComparisonRow(
            "货品数据",
            "测算时间",
            "text",
            lambda row: row.created_at.isoformat() if row.created_at else "-",
        ),
        _ComparisonRow("货品数据", "竞品链接", "text", lambda row: "-"),
        _ComparisonRow(
            "货品数据",
            "测算类型",
            "text",
            lambda row: _CALCULATION_TYPE_LABELS.get(
                str(row.calculation_type), str(row.calculation_type)
            ),
        ),
        _ComparisonRow(
            "货品数据", "包装尺寸(cm)", "text", lambda row: _packaging_size(row)
        ),
        _ComparisonRow(
            "货品数据",
            "重量(kg)",
            "number",
            lambda row: _as_float(row.weight_kg) or 0.0,
        ),
        _ComparisonRow(
            "货品数据",
            "体积(in³)",
            "number",
            lambda row: _as_float(row.volume_cubic_in) or 0.0,
        ),
        _ComparisonRow(
            "货品数据",
            "体积(ft³)",
            "number",
            lambda row: _as_float(row.volume_cubic_ft) or 0.0,
        ),
        _ComparisonRow(
            "DDP 成本",
            "FOB成本",
            "currency_rmb",
            lambda row: _as_float(row.fob_product_cost_rmb) or 0.0,
        ),
        _ComparisonRow(
            "DDP 成本",
            "头程",
            "currency_rmb",
            lambda row: _as_float(row.first_leg_cost_rmb) or 0.0,
        ),
        _ComparisonRow(
            "DDP 成本",
            "DDP(RMB)",
            "currency_rmb",
            lambda row: _as_float(row.ddp_cost_rmb) or 0.0,
        ),
        _ComparisonRow(
            "DDP 成本",
            "DDP(USD)",
            "currency_usd",
            lambda row: _as_float(row.ddp_cost_usd) or 0.0,
        ),
        _ComparisonRow("DDP 成本", "头程单价(RMB/kg)", "currency_rmb", lambda row: "-"),
        _ComparisonRow("DDP 成本", "头程数量", "number", lambda row: "-"),
        _ComparisonRow(
            "费用支出",
            "平台佣金",
            "currency_usd",
            lambda row: _as_float(row.referral_fee_usd) or 0.0,
        ),
        _ComparisonRow("费用支出", "平台佣金率", "percent", _commission_rate),
        _ComparisonRow(
            "费用支出",
            "广告费",
            "currency_usd",
            lambda row: _as_float(row.advertising_fee_usd) or 0.0,
        ),
        _ComparisonRow(
            "费用支出",
            "广告费率",
            "percent",
            lambda row: _as_float(row.advertising_rate) or 0.0,
        ),
        _ComparisonRow(
            "费用支出",
            "派送",
            "currency_usd",
            lambda row: _as_float(row.fba_fulfillment_fee_usd) or 0.0,
        ),
        _ComparisonRow(
            "费用支出",
            "配置费",
            "currency_usd",
            lambda row: _as_float(row.inbound_config_fee_usd) or 0.0,
        ),
        _ComparisonRow(
            "费用支出",
            "仓储费",
            "currency_usd",
            lambda row: _as_float(row.storage_fee_usd) or 0.0,
        ),
        _ComparisonRow(
            "费用支出",
            "仓储月数",
            "number",
            lambda row: _as_float(row.storage_months) or 0.0,
        ),
        _ComparisonRow(
            "费用支出",
            "退货损耗",
            "currency_usd",
            lambda row: _as_float(row.return_loss_usd) or 0.0,
        ),
        _ComparisonRow(
            "费用支出",
            "退货折损率",
            "percent",
            lambda row: _as_float(row.return_loss_rate) or 0.0,
        ),
        _ComparisonRow(
            "费用支出",
            "费用合计",
            "currency_usd",
            lambda row: _as_float(row.total_fee_usd) or 0.0,
        ),
        _ComparisonRow(
            "售价与利润",
            "售价",
            "currency_usd",
            lambda row: _as_float(row.sale_price_usd) or 0.0,
        ),
        _ComparisonRow(
            "售价与利润",
            "回款",
            "currency_usd",
            lambda row: _as_float(row.payout_usd) or 0.0,
        ),
        _ComparisonRow(
            "售价与利润",
            "利润",
            "currency_usd",
            lambda row: _as_float(row.profit_usd) or 0.0,
        ),
        _ComparisonRow(
            "售价与利润",
            "利润率",
            "percent",
            lambda row: _as_float(row.profit_rate) or 0.0,
        ),
        _ComparisonRow(
            "核算规则", "尺寸等级", "text", lambda row: row.size_tier_label
        ),
        _ComparisonRow(
            "核算规则", "售价带", "text", lambda row: row.price_band_label
        ),
        _ComparisonRow(
            "核算规则",
            "计费重(lb)",
            "number",
            lambda row: _as_float(row.chargeable_weight_lb) or 0.0,
        ),
        _ComparisonRow(
            "核算规则",
            "体积(ft³)",
            "number",
            lambda row: _as_float(row.volume_cubic_ft) or 0.0,
        ),
        _ComparisonRow(
            "核算规则",
            "派送规则",
            "text",
            lambda row: row.fulfillment_fee_rule_label,
        ),
        _ComparisonRow(
            "核算规则",
            "入库配置",
            "text",
            lambda row: row.inbound_config_fee_rule_label,
        ),
        _ComparisonRow(
            "核算规则",
            "仓储规则",
            "text",
            lambda row: row.storage_fee_rule_label,
        ),
        _ComparisonRow(
            "核算规则",
            "汇率",
            "number",
            lambda row: _as_float(row.usd_to_rmb_rate) or 0.0,
        ),
        _ComparisonRow(
            "核算规则",
            "计费重规则",
            "text",
            lambda row: row.chargeable_weight_rule,
        ),
        _ComparisonRow(
            "核算规则",
            "产品重(lb)",
            "number",
            lambda row: _as_float(row.product_weight_lb) or 0.0,
        ),
        _ComparisonRow(
            "核算规则",
            "体积重(lb)",
            "number",
            lambda row: _as_float(row.dimensional_weight_lb) or 0.0,
        ),
        _ComparisonRow(
            "核算规则", "尺寸(in)", "text", lambda row: _dimensions_in(row)
        ),
    ]


def _number_format(value_type: ValueType) -> str | None:
    if value_type == "currency_usd":
        return '$#,##0.00;[Red]-$#,##0.00'
    if value_type == "currency_rmb":
        return 'RMB #,##0.00;[Red]-RMB #,##0.00'
    if value_type == "percent":
        return "0.00%"
    if value_type == "number":
        return "0.0000"
    return None


def _write_sheet(
    worksheet: Worksheet,
    *,
    rows: Sequence[NewProductCalculation],
) -> None:
    worksheet.sheet_view.showGridLines = False
    worksheet.freeze_panes = "C2"
    worksheet.row_dimensions[1].height = 36

    border = Border(
        left=Side(style="thin", color="D0D5DD"),
        right=Side(style="thin", color="D0D5DD"),
        top=Side(style="thin", color="D0D5DD"),
        bottom=Side(style="thin", color="D0D5DD"),
    )
    header_fill = PatternFill("solid", fgColor="E2E8F0")

    header_values = ["指标", "子项", *[_product_name(row) for row in rows]]
    for column, value in enumerate(header_values, start=1):
        cell = worksheet.cell(1, column, value)
        cell.font = Font(name="Microsoft YaHei", bold=True, color="0F172A")
        cell.fill = header_fill
        cell.alignment = Alignment(
            horizontal="center" if column <= 2 else "left",
            vertical="center",
            wrap_text=True,
        )
        cell.border = border

    comparison_rows = _comparison_rows()
    current_row = 2
    section_start: int | None = None
    current_section = ""

    for row_definition in comparison_rows:
        if row_definition.section != current_section:
            if (
                section_start is not None
                and current_row - 1 > section_start
            ):
                worksheet.merge_cells(
                    start_row=section_start,
                    start_column=1,
                    end_row=current_row - 1,
                    end_column=1,
                )
            current_section = row_definition.section
            section_start = current_row
            section_cell = worksheet.cell(current_row, 1, current_section)
            section_cell.fill = PatternFill(
                "solid", fgColor=_SECTION_FILLS[current_section]
            )
            section_cell.font = Font(
                name="Microsoft YaHei", bold=True, color="0F172A"
            )
            section_cell.alignment = Alignment(
                horizontal="center", vertical="top", wrap_text=True
            )

        label_cell = worksheet.cell(current_row, 2, row_definition.label)
        label_cell.fill = PatternFill(
            "solid", fgColor=_SECTION_FILLS[current_section]
        )
        label_cell.font = Font(name="Microsoft YaHei", color="334155")
        label_cell.alignment = Alignment(horizontal="left", vertical="center", wrap_text=True)

        for column, snapshot_row in enumerate(rows, start=3):
            value = row_definition.getter(snapshot_row)
            cell = worksheet.cell(current_row, column, value)
            cell.font = Font(name="Microsoft YaHei", color="0F172A")
            cell.alignment = Alignment(
                horizontal="right" if isinstance(value, (int, float)) else "left",
                vertical="center",
                wrap_text=True,
            )
            number_format = _number_format(row_definition.value_type)
            if number_format and isinstance(value, (int, float)):
                cell.number_format = number_format
            if row_definition.label in {"利润", "利润率"} and isinstance(
                value, (int, float)
            ):
                cell.font = Font(
                    name="Microsoft YaHei",
                    bold=True,
                    color="047857" if value >= 0 else "BE123C",
                )

        for column in range(1, len(header_values) + 1):
            worksheet.cell(current_row, column).border = border
        current_row += 1

    if section_start is not None and current_row - 1 > section_start:
        worksheet.merge_cells(
            start_row=section_start,
            start_column=1,
            end_row=current_row - 1,
            end_column=1,
        )
        merged_section_cell = worksheet.cell(section_start, 1)
        merged_section_cell.fill = PatternFill(
            "solid", fgColor=_SECTION_FILLS[current_section]
        )
        merged_section_cell.font = Font(
            name="Microsoft YaHei", bold=True, color="0F172A"
        )
        merged_section_cell.alignment = Alignment(
            horizontal="center", vertical="top", wrap_text=True
        )

    worksheet.column_dimensions["A"].width = 16
    worksheet.column_dimensions["B"].width = 22
    for column in range(3, len(header_values) + 1):
        worksheet.column_dimensions[
            worksheet.cell(1, column).column_letter
        ].width = 24


def build_new_product_comparison_export(
    rows: Sequence[NewProductCalculation],
    *,
    project_name: str,
    snapshot_ids: Sequence[int],
) -> NewProductComparisonExportResult:
    if not snapshot_ids:
        raise ValueError("snapshot_ids must not be empty")
    if len(snapshot_ids) > MAX_COMPARISON_SNAPSHOTS:
        raise ValueError(f"snapshot_ids must not exceed {MAX_COMPARISON_SNAPSHOTS}")

    rows_by_id = {row.id: row for row in rows}
    try:
        ordered_rows = [rows_by_id[snapshot_id] for snapshot_id in snapshot_ids]
    except KeyError as exc:
        raise ValueError(f"missing snapshot id: {exc.args[0]}") from None

    workbook = Workbook()
    worksheet = workbook.active
    worksheet.title = "测算对比矩阵"
    _write_sheet(worksheet, rows=ordered_rows)

    output = BytesIO()
    workbook.save(output)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%SZ")
    return NewProductComparisonExportResult(
        content=output.getvalue(),
        filename=f"{_safe_filename_part(project_name)}_新品测算对比矩阵-{timestamp}.xlsx",
        column_count=len(ordered_rows),
    )
