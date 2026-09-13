"""Excel export module for monthly reports.

Generates multi-sheet Excel workbooks for financial accounting details.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import UTC, datetime
from decimal import Decimal
from io import BytesIO
from pathlib import Path
from typing import TYPE_CHECKING, Any

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import (
    ExchangeRate,
    MonthlyReport,
    MonthlyReportPT3Calculation,
    MonthlyReportPT4Calculation,
    MonthlyReportTransaction,
    Project,
)
from app.models.job import JobStatus
from app.utils.country import get_country_label_cn, normalize_country

# BLF-1036: openpyxl imported lazily — this module loads at API/worker/beat boot
# via app.services.report.monthly; openpyxl pulls numpy+PIL (~40MB) that the
# report-pipeline processes only need when actually exporting an xlsx.
if TYPE_CHECKING:
    from openpyxl import Workbook

from app.services.report.pt3 import (
    _build_accounting_rows,
    _build_transaction_payloads,
    _classify_monthly_rows,
    _load_transaction_raw_rows,
    _normalize_pt3_payload,
)
from app.services.report.pt4 import (
    _build_financial_row,
    _load_monthly_cost_totals,
    _resolve_operation_commission_rmb,
)
from app.services.report.utils import (
    _format_month_label,
    _group_sku_quantity,
    _safe_project_name,
    _to_float,
    _round2,
    _to_decimal,
)


_ADMIN_ONLY_EXPORT_KEYS = {
    "evaluationFeeRmb",
    "prepaymentOtherRmb",
    "operationCommissionRmb",
    "payableTotalRmb",
    "exchangeRate",
}

_EXPORT_DETAIL_COLUMNS: list[dict[str, str]] = [
    {"key": "monthLabel", "title": "年月", "format": "text", "group": "基础信息"},
    {
        "key": "hasSourceReport",
        "title": "是否有源报表",
        "format": "boolean",
        "group": "基础信息",
    },
    {
        "key": "incomeSales",
        "title": "销售额",
        "format": "currency_usd",
        "group": "平台收入",
    },
    {
        "key": "incomeRefund",
        "title": "退款",
        "format": "currency_usd",
        "group": "平台收入",
    },
    {
        "key": "incomeAdjustment",
        "title": "赔偿",
        "format": "currency_usd",
        "group": "平台收入",
    },
    {
        "key": "incomeOther",
        "title": "其他收入",
        "format": "currency_usd",
        "group": "平台收入",
    },
    {
        "key": "expenseSellingFee",
        "title": "平台费",
        "format": "currency_usd",
        "group": "平台支出",
    },
    {
        "key": "expenseFbaFee",
        "title": "配送费",
        "format": "currency_usd",
        "group": "平台支出",
    },
    {
        "key": "expenseInventoryFee",
        "title": "仓储费",
        "format": "currency_usd",
        "group": "平台支出",
    },
    {
        "key": "expenseServiceFee",
        "title": "服务费",
        "format": "currency_usd",
        "group": "平台支出",
    },
    {
        "key": "expenseAdvertising",
        "title": "广告费",
        "format": "currency_usd",
        "group": "平台支出",
    },
    {
        "key": "expenseOtherFees",
        "title": "其他费用",
        "format": "currency_usd",
        "group": "平台支出",
    },
    {
        "key": "incomeTotal",
        "title": "收入合计",
        "format": "currency_usd",
        "group": "结果",
    },
    {
        "key": "expenseTotal",
        "title": "支出合计",
        "format": "currency_usd",
        "group": "结果",
    },
    {
        "key": "amazonPayBack",
        "title": "亚马逊回款",
        "format": "currency_usd",
        "group": "结果",
    },
    {
        "key": "creditCardDeductionUsd",
        "title": "信用卡扣款",
        "format": "currency_usd",
        "group": "结果",
    },
    {
        "key": "evaluationFeeRmb",
        "title": "测评费用RMB",
        "format": "currency_rmb",
        "group": "运营结算",
    },
    {
        "key": "prepaymentOtherRmb",
        "title": "垫付其他RMB",
        "format": "currency_rmb",
        "group": "运营结算",
    },
    {
        "key": "operationCommissionRmb",
        "title": "运营佣金RMB",
        "format": "currency_rmb_nullable",
        "group": "运营结算",
    },
    {
        "key": "payableTotalRmb",
        "title": "应付总计RMB",
        "format": "currency_rmb_nullable",
        "group": "运营结算",
    },
    {"key": "exchangeRate", "title": "汇率", "format": "rate", "group": "运营结算"},
    {
        "key": "platformRatio",
        "title": "平台占比",
        "format": "percent",
        "group": "费用占比",
    },
    {
        "key": "deliveryRatio",
        "title": "配送占比",
        "format": "percent",
        "group": "费用占比",
    },
    {
        "key": "storageRatio",
        "title": "仓储占比",
        "format": "percent",
        "group": "费用占比",
    },
    {
        "key": "serviceRatio",
        "title": "服务占比",
        "format": "percent",
        "group": "费用占比",
    },
    {"key": "adRatio", "title": "广告占比", "format": "percent", "group": "费用占比"},
    {"key": "refundRatio", "title": "退款率", "format": "percent", "group": "费用占比"},
    {
        "key": "paybackRatio",
        "title": "回款率",
        "format": "percent_signed",
        "group": "费用占比",
    },
    {
        "key": "fobCostRmb",
        "title": "FOB成本RMB",
        "format": "currency_rmb",
        "group": "成本核算",
    },
    {
        "key": "firstLegCostRmb",
        "title": "头程成本RMB",
        "format": "currency_rmb",
        "group": "成本核算",
    },
    {
        "key": "netProfitRmb",
        "title": "净利润RMB",
        "format": "currency_rmb",
        "group": "成本核算",
    },
    {
        "key": "netProfitUsd",
        "title": "净利润USD",
        "format": "currency_usd",
        "group": "成本核算",
    },
    {
        "key": "netProfitRate",
        "title": "净利率",
        "format": "percent_signed",
        "group": "成本核算",
    },
]


def _load_report_with_pt3_or_404(
    db: Session,
    *,
    project_id: int,
    country: str = "US",
    report_month: str,
) -> tuple[MonthlyReport, MonthlyReportPT3Calculation]:
    """Load report with PT3 calculation or raise 404.

    Args:
        db: Database session
        project_id: Project ID
        country: Country code
        report_month: YYYY-MM string

    Returns:
        Tuple of (MonthlyReport, MonthlyReportPT3Calculation)

    Raises:
        HTTPException: If report not found
    """
    normalized_country = normalize_country(country)
    row = db.execute(
        select(MonthlyReport, MonthlyReportPT3Calculation)
        .join(
            MonthlyReportPT3Calculation,
            MonthlyReportPT3Calculation.report_id == MonthlyReport.id,
        )
        .where(
            MonthlyReport.project_id == project_id,
            MonthlyReport.country == normalized_country,
            MonthlyReport.report_month == report_month,
            MonthlyReport.is_current.is_(True),
            MonthlyReport.status == JobStatus.success,
        )
        .limit(1)
    ).first()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Monthly report not found for selected month",
        )
    report, pt3 = row
    return report, pt3


def _load_usd_exchange_rate(db: Session, report_month: str) -> float:
    """Load USD exchange rate for a month.

    Args:
        db: Database session
        report_month: YYYY-MM string

    Returns:
        Exchange rate (USD to RMB) or 0.0 if not found
    """
    row = db.execute(
        select(ExchangeRate).where(
            ExchangeRate.currency == "USD",
            ExchangeRate.year_month == report_month,
        )
    ).scalar_one_or_none()
    if row is None:
        return 0.0
    return _to_float(row.rate)


def _rows_to_sheet(ws, rows: list[dict[str, object]]) -> None:
    """Write rows to worksheet with dynamic column detection.

    Args:
        ws: Worksheet
        rows: List of row dicts
    """
    if not rows:
        ws.append(["No Data"])
        return
    headers: list[str] = []
    seen: set[str] = set()
    for row in rows:
        for key in row.keys():
            header = str(key)
            if header not in seen:
                seen.add(header)
                headers.append(header)
    ws.append(headers)
    for row in rows:
        ws.append([row.get(h, "") for h in headers])


def _auto_width(ws) -> None:
    from openpyxl.utils import get_column_letter

    """Set column widths based on content.

    Args:
        ws: Worksheet
    """
    for col in range(1, ws.max_column + 1):
        letter = get_column_letter(col)
        max_length = 0
        for row in range(1, ws.max_row + 1):
            value = ws.cell(row, col).value
            text = "" if value is None else str(value)
            max_length = max(max_length, min(len(text) + 2, 50))
        ws.column_dimensions[letter].width = max(10, max_length)


# Per-country currency symbol used by the ``currency_usd`` number format.
# The In/Ex amount columns are denominated in the report's country currency,
# not necessarily USD, so the format must render €/£ for DE/UK reports.
_CURRENCY_SYMBOL_BY_CODE = {"USD": "$", "EUR": "€", "GBP": "£"}


def _excel_num_fmt(format_key: str, currency_code: str = "USD") -> str | None:
    """Get Excel number format string for format key.

    Args:
        format_key: Format key (currency_usd, currency_rmb, percent, rate)
        currency_code: ISO currency code (USD/EUR/GBP) used for the
            ``currency_usd`` format key so the rendered symbol matches the
            report's country instead of always being a dollar sign.

    Returns:
        Excel format string or None
    """
    if format_key == "currency_usd":
        symbol = _CURRENCY_SYMBOL_BY_CODE.get(currency_code, "$")
        return f'"{symbol}"#,##0.00;[Red]-"{symbol}"#,##0.00'
    if format_key in ("currency_rmb", "currency_rmb_nullable"):
        return "¥#,##0.00;[Red]-¥#,##0.00"
    if format_key in ("percent", "percent_signed"):
        return "0.0%"
    if format_key == "rate":
        return "0.0000"
    return None


def _apply_excel_border(cell, color: str = "FFE2E8F0") -> None:
    from openpyxl.styles import Border, Side

    """Apply standard border to cell.

    Args:
        cell: Excel cell
        color: Border color
    """
    cell.border = Border(
        left=Side(style="thin", color=color),
        right=Side(style="thin", color=color),
        top=Side(style="thin", color=color),
        bottom=Side(style="thin", color=color),
    )


def _apply_monthly_like_styles(workbook: Workbook) -> None:
    from openpyxl.styles import Alignment, Border, Font, NamedStyle, PatternFill, Side

    """Apply consistent styling to all sheets in workbook.

    Args:
        workbook: Excel workbook
    """
    thin = Side(style="thin", color="FFCBD5E1")
    medium = Side(style="medium", color="FF94A3B8")
    header_fill = PatternFill(
        start_color="FFE2E8F0", end_color="FFE2E8F0", fill_type="solid"
    )
    even_row_fill = PatternFill(
        start_color="FFFFFFFF", end_color="FFFFFFFF", fill_type="solid"
    )
    odd_row_fill = PatternFill(
        start_color="FFF8FAFC", end_color="FFF8FAFC", fill_type="solid"
    )

    existing_style_names: set[str] = set()
    for style in workbook.named_styles:
        if isinstance(style, str):
            existing_style_names.add(style)
        else:
            name = getattr(style, "name", "")
            if isinstance(name, str) and name:
                existing_style_names.add(name)
    if "sty1" not in existing_style_names:
        sty1 = NamedStyle(name="sty1")
        sty1.font = Font(name="等线", size=11, bold=True, color="FF0F172A")
        sty1.alignment = Alignment(
            horizontal="center", vertical="center", wrap_text=True
        )
        sty1.border = Border(top=medium, bottom=medium, left=thin, right=thin)
        sty1.fill = header_fill
        workbook.add_named_style(sty1)

    if "sty2" not in existing_style_names:
        sty2 = NamedStyle(name="sty2")
        sty2.font = Font(name="等线", size=10, color="FF334155")
        sty2.alignment = Alignment(horizontal="left", vertical="center")
        sty2.border = Border(top=thin, bottom=thin, left=thin, right=thin)
        workbook.add_named_style(sty2)

    core_sheets = {"报表核算"}
    legacy_financial_sheets = {"汇总", "月度财务明细"}
    for ws in workbook.worksheets:
        if ws.title in legacy_financial_sheets:
            continue
        ws.freeze_panes = "A2"
        if ws.title in core_sheets:
            for r in range(1, ws.max_row + 1):
                row_fill = (
                    header_fill
                    if r == 1
                    else (even_row_fill if r % 2 == 0 else odd_row_fill)
                )
                ws.row_dimensions[r].height = 24 if r > 1 else 28
                for c in range(1, ws.max_column + 1):
                    cell = ws.cell(r, c)
                    cell.style = "sty1" if r == 1 else "sty2"
                    if r > 1:
                        cell.fill = row_fill
            _auto_width_for_report_sheet_service(ws)
        else:
            ws.row_dimensions[1].height = 28
            for c in range(1, ws.max_column + 1):
                cell = ws.cell(1, c)
                cell.style = "sty1"
                cell.fill = header_fill
            for r in range(2, ws.max_row + 1):
                ws.row_dimensions[r].height = 24
                row_fill = even_row_fill if r % 2 == 0 else odd_row_fill
                for c in range(1, ws.max_column + 1):
                    ws.cell(r, c).style = "sty2"
                    ws.cell(r, c).fill = row_fill
            for c in range(1, ws.max_column + 1):
                ws.column_dimensions[get_column_letter(c)].width = 14


def _auto_width_for_report_sheet_service(ws) -> None:
    from openpyxl.utils import get_column_letter

    """Set column widths for report sheets (supports Chinese characters).

    Args:
        ws: Worksheet
    """
    for col in range(1, ws.max_column + 1):
        letter = get_column_letter(col)
        max_length = 0
        for row in range(1, ws.max_row + 1):
            value = ws.cell(row, col).value
            if value is None:
                continue
            text = str(value)
            length = 0
            for ch in text:
                length += 2 if "一" <= ch <= "鿿" else 1
            max_length = max(max_length, length)
        ws.column_dimensions[letter].width = min(max(max_length + 2, 8), 50)


def _style_accounting_summary_rows(
    ws, rows: list[dict[str, Any]], currency_code: str = "USD"
) -> None:
    from openpyxl.styles import Border, Font, PatternFill, Side

    """Post-style the 报表核算 sheet to highlight the spacer and total rows.

    `_apply_monthly_like_styles` already gives every cell a uniform sty1/sty2
    treatment and an alternating fill; we override the per-cell fill and font
    for spacer and total rows here. Runs *after* `_apply_monthly_like_styles`
    so the overrides win.

    Layout convention: sheet row 1 is the header. Detail rows start at sheet
    row 2 and follow the order of `rows`.

    Args:
        ws: The 报表核算 worksheet.
        rows: The structured row list returned by `_build_accounting_rows`,
            which carries the `kind` discriminator ("detail" | "spacer" | "total").
    """
    thin = Side(style="thin", color="FFCBD5E1")
    medium = Side(style="medium", color="FF64748B")
    # Tailwind emerald-100 / rose-100 + emerald-800 / rose-800, mirroring
    # the frontend's `bg-emerald-100` / `bg-rose-100` summary colors.
    income_fill = PatternFill(
        start_color="FFD1FAE5", end_color="FFD1FAE5", fill_type="solid"
    )
    income_font = Font(name="等线", size=11, bold=True, color="FF065F46")
    expense_fill = PatternFill(
        start_color="FFFFE4E6", end_color="FFFFE4E6", fill_type="solid"
    )
    expense_font = Font(name="等线", size=11, bold=True, color="FF9F1239")
    no_fill = PatternFill(fill_type=None)

    # sheet row 1 = header, so the first data row is row 2.
    for offset, row in enumerate(rows):
        sheet_row = 2 + offset
        kind = row.get("kind", "detail")
        if kind == "spacer":
            # Compress the spacer so the totals read as a visual summary.
            ws.row_dimensions[sheet_row].height = 8
            for col in range(1, 10):
                cell = ws.cell(sheet_row, col)
                cell.fill = no_fill
                cell.font = Font(name="等线", size=10)
                cell.border = Border()
            continue
        if kind == "total":
            ws.row_dimensions[sheet_row].height = 28
            # Income half: columns 1..4, leave a thicker top border to mark
            # the totals as a separated summary block.
            income_border = Border(
                top=medium, bottom=thin, left=thin, right=thin
            )
            for col in range(1, 5):
                cell = ws.cell(sheet_row, col)
                cell.fill = income_fill
                cell.font = income_font
                cell.border = income_border
            # Visual gap column 5: keep the border minimal so the two halves
            # read as a paired summary.
            gap = ws.cell(sheet_row, 5)
            gap.fill = PatternFill(
                start_color="FFF1F5F9", end_color="FFF1F5F9", fill_type="solid"
            )
            gap.font = Font(name="等线", size=11, bold=True, color="FF334155")
            gap.border = Border(top=medium, bottom=thin, left=thin, right=thin)
            # Expense half: columns 6..9.
            expense_border = Border(
                top=medium, bottom=thin, left=thin, right=thin
            )
            for col in range(6, 10):
                cell = ws.cell(sheet_row, col)
                cell.fill = expense_fill
                cell.font = expense_font
                cell.border = expense_border
            # Number format for the two amount cells (columns 3 and 8).
            ws.cell(sheet_row, 3).number_format = _excel_num_fmt(
                "currency_usd", currency_code
            )
            ws.cell(sheet_row, 8).number_format = _excel_num_fmt(
                "currency_usd", currency_code
            )


def _style_financial_export_sheets(
    ws_summary, ws_financial_detail, currency_code: str = "USD"
) -> None:
    """Apply specific styling to financial export sheets.

    Args:
        ws_summary: Summary sheet
        ws_financial_detail: Financial detail sheet
    """
    ws_summary.column_dimensions["A"].width = 18
    ws_summary.column_dimensions["B"].width = 18
    ws_summary.column_dimensions["C"].width = 36
    for row in range(2, ws_summary.max_row + 1):
        ws_summary.cell(row, 2).number_format = _excel_num_fmt(
            "currency_usd", currency_code
        )

    num_fmt_usd = _excel_num_fmt("currency_usd", currency_code)
    num_fmt_rmb = "¥#,##0.00;[Red]-¥#,##0.00"
    ws_financial_detail.cell(2, 2).number_format = num_fmt_usd
    ws_financial_detail.cell(2, 3).number_format = num_fmt_usd
    ws_financial_detail.cell(2, 4).number_format = num_fmt_usd
    ws_financial_detail.cell(2, 5).number_format = num_fmt_usd
    ws_financial_detail.cell(2, 6).number_format = num_fmt_usd
    ws_financial_detail.cell(2, 7).number_format = num_fmt_usd
    ws_financial_detail.cell(2, 8).number_format = num_fmt_usd
    ws_financial_detail.cell(2, 9).number_format = num_fmt_usd
    ws_financial_detail.cell(2, 10).number_format = num_fmt_usd
    ws_financial_detail.cell(2, 11).number_format = num_fmt_usd
    ws_financial_detail.cell(2, 12).number_format = num_fmt_usd
    ws_financial_detail.cell(2, 13).number_format = num_fmt_usd
    ws_financial_detail.cell(2, 14).number_format = num_fmt_usd
    ws_financial_detail.cell(2, 15).number_format = num_fmt_usd
    ws_financial_detail.cell(2, 16).number_format = num_fmt_rmb
    ws_financial_detail.cell(2, 17).number_format = num_fmt_rmb
    ws_financial_detail.cell(2, 18).number_format = "0.0000"
    ws_financial_detail.cell(2, 19).number_format = num_fmt_rmb
    ws_financial_detail.cell(2, 20).number_format = num_fmt_rmb
    ws_financial_detail.cell(2, 21).number_format = num_fmt_rmb
    ws_financial_detail.cell(2, 22).number_format = num_fmt_usd
    ws_financial_detail.cell(2, 23).number_format = "0.00%"


def export_financial_accounting_detail_workbook(
    db: Session,
    *,
    project_id: int,
    country: str = "US",
    report_month: str,
    is_admin: bool = False,
) -> tuple[str, bytes]:
    """Export financial accounting detail as Excel workbook.

    Args:
        db: Database session
        project_id: Project ID
        country: Country code (US/DE/UK)
        report_month: YYYY-MM string
        is_admin: Whether current user is admin (affects exported columns)

    Returns:
        Tuple of (filename, file_bytes)
    """
    from openpyxl import Workbook

    month = _parse_report_month(report_month)
    report, pt3 = _load_report_with_pt3_or_404(
        db,
        project_id=project_id,
        country=country,
        report_month=month,
    )
    pt4 = db.execute(
        select(MonthlyReportPT4Calculation).where(
            MonthlyReportPT4Calculation.report_id == report.id
        )
    ).scalar_one_or_none()
    if pt4 is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Monthly report accounting snapshot not found",
        )

    all_rows = _load_transaction_raw_rows(db, report_id=int(report.id))
    classified = _classify_monthly_rows(all_rows)
    debt_sum = db.execute(
        select(func.coalesce(func.sum(MonthlyReportTransaction.total), 0)).where(
            MonthlyReportTransaction.report_id == report.id,
            func.lower(func.trim(MonthlyReportTransaction.transaction_type)) == "debt",
        )
    ).scalar_one()
    cost_totals = _load_monthly_cost_totals(
        db,
        report_ids=[int(report.id)],
        project_name=report.project_name,
        country=report.country,
    ).get(int(report.id), {})
    financial_row = _build_financial_row(
        report_month=month,
        pt4=pt4,
        pt3=pt3,
        credit_card_deduction_usd=debt_sum,
        fob_cost_rmb=cost_totals.get("fob_cost_rmb", 0),
        first_leg_cost_rmb=cost_totals.get("first_leg_cost_rmb", 0),
    )
    exchange_rate = _load_usd_exchange_rate(db, month)
    project_row = db.get(Project, report.project_id)
    disable_commission = (
        project_row is None or not (project_row.commission_basis or "").strip()
    )
    commission_rmb, payable_total_rmb = _resolve_operation_commission_rmb(
        db=db,
        report=report,
        income_total=financial_row["income_total"],
        amazon_pay_back=financial_row["amazon_pay_back"],
        exchange_rate=exchange_rate,
    )
    net_profit_rmb = (
        financial_row["amazon_pay_back"] * exchange_rate
        - financial_row["fob_cost_rmb"]
        - financial_row["first_leg_cost_rmb"]
        - financial_row["credit_card_deduction_usd"] * exchange_rate
    )
    total_cost_usd = (
        (financial_row["fob_cost_rmb"] + financial_row["first_leg_cost_rmb"])
        / exchange_rate
        if exchange_rate > 0
        else 0
    )
    net_profit_usd = (
        financial_row["amazon_pay_back"]
        - total_cost_usd
        - financial_row["credit_card_deduction_usd"]
    )
    net_profit_rate = (
        net_profit_usd / financial_row["income_total"]
        if financial_row["income_total"] != 0
        else 0
    )

    # Determine currency label based on country
    currency_label = "EUR" if country == "DE" else "GBP" if country == "UK" else "USD"

    wb = Workbook()
    ws = wb.active
    ws.title = "报表核算"
    ws.append(
        [
            "Income",
            "收入",
            f"In金额（{currency_label}）",
            "In源表",
            "",
            "Expense",
            "支出",
            f"Ex金额（{currency_label}）",
            "Ex源表",
        ]
    )
    # Each row carries a `kind` discriminator produced by
    # `_build_accounting_rows` (detail / spacer / total). The layout
    # arranges the totals on the same line with one blank row separating
    # the detail block from the totals.
    for line in _build_accounting_rows(pt3, country=report.country):
        kind = line.get("kind", "detail")
        if kind == "spacer":
            ws.append([""] * 9)
            continue
        if kind == "total":
            ws.append(
                [
                    line["income_en"],
                    line["income_zh"],
                    line["income_amount_usd"],
                    line["income_source"],
                    "",
                    line["expense_en"],
                    line["expense_zh"],
                    line["expense_amount_usd"],
                    line["expense_source"],
                ]
            )
            continue
        ws.append(
            [
                line["income_en"],
                line["income_zh"],
                line["income_amount_usd"],
                line["income_source"],
                "",
                line["expense_en"],
                line["expense_zh"],
                line["expense_amount_usd"],
                line["expense_source"],
            ]
        )

    sheets_to_write: list[tuple[str, list[dict[str, object]]]] = [
        ("交易一览", all_rows),
        ("销售SKU明细", _group_sku_quantity(classified["order"])),
        ("退款SKU明细", _group_sku_quantity(classified["refund"])),
        ("所有订单", classified["order"]),
        ("所有退款", classified["refund"]),
        ("FBM 订单", classified["fbm_order"]),
        ("FBM 退款", classified["fbm_refund"]),
        ("FBA 订单", classified["fba_order"]),
        ("FBA 退款", classified["fba_refund"]),
        ("FBA库存赔偿", classified["adjustment_income"]),
        ("其他赔偿", classified["adjustment_expense"]),
        ("清算费用", classified["liquidation"]),
        ("拒付退款", classified["chargeback_refund"]),
        ("FBA仓储及入库服务费", classified["fba_inventory_fee"]),
        ("服务费（不含广告）", classified["amazon_fees_and_service_fee_without_ad"]),
        ("广告费", classified["advertising"]),
        ("广告退款", classified["service_refund_for_advertiser"]),
    ]
    for sheet_name, rows in sheets_to_write:
        detail_ws = wb.create_sheet(title=sheet_name)
        _rows_to_sheet(detail_ws, rows)
        _auto_width(detail_ws)

    _apply_monthly_like_styles(wb)

    # Post-process the 报表核算 sheet so that spacer / total rows are styled
    # on top of the uniform sty1/sty2 treatment applied above. `_apply_monthly_like_styles`
    # iterates every cell, so the overrides here run after it and win.
    _style_accounting_summary_rows(
        ws,
        _build_accounting_rows(pt3, country=report.country),
        currency_code=currency_label,
    )

    # 统一关闭网格线：本页面所有导出 Excel 均不显示网格线
    for sheet in wb.worksheets:
        sheet.sheet_view.showGridLines = False

    out = BytesIO()
    wb.save(out)
    safe_project = _safe_project_name(report.project_name)
    site_label = get_country_label_cn(country) or country
    ym = month.split("-")
    month_cn = f"{ym[0]}年{int(ym[1])}月"
    filename = f"{safe_project}_{site_label}-月度财务核算明细-{month_cn}.xlsx"
    return filename, out.getvalue()


def _parse_report_month(value: str) -> str:
    """Parse and validate YYYY-MM format month string.

    Args:
        value: Month string

    Returns:
        Normalized YYYY-MM string

    Raises:
        HTTPException: If format is invalid
    """
    raw = (value or "").strip()
    try:
        parsed = datetime.strptime(raw, "%Y-%m")
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="report_month must be YYYY-MM",
        ) from exc
    return parsed.strftime("%Y-%m")


__all__ = [
    "_auto_width",
    "_auto_width_for_report_sheet_service",
    "_apply_excel_border",
    "_apply_monthly_like_styles",
    "_excel_num_fmt",
    "_load_report_with_pt3_or_404",
    "_load_usd_exchange_rate",
    "_parse_report_month",
    "_rows_to_sheet",
    "_style_accounting_summary_rows",
    "_style_financial_export_sheets",
    "export_financial_accounting_detail_workbook",
]
