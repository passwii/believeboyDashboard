from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Any
from decimal import Decimal

# BLF-1036: openpyxl imported lazily — this module loads at API boot via the
# reporting lazy router group; openpyxl pulls numpy+PIL (~40MB) that only the
# actual reconciliation path needs.
from app.utils.pdf_extractor import PDFExtractor


@dataclass
class ReconciliationItem:
    field_name: str
    excel_value: Optional[float]
    pdf_value: Optional[float]
    match: bool
    difference: Optional[float] = None
    difference_percent: Optional[float] = None
    note: Optional[str] = None


@dataclass
class ReconciliationResult:
    total_items: int
    matched_items: int
    mismatched_items: int
    missing_items: int
    items: List[ReconciliationItem]
    summary: Dict[str, Any]


EXCEL_TO_PDF_MAPPING: Dict[str, str] = {
    "FBA_product_sales": "FBA_product_sales",
    "FBA_product_sale_refunds": "FBA_product_sale_refunds",
    "FBA_selling_fees": "FBA_selling_fees",
    "FBA_transaction_fees": "FBA_transaction_fees",
    "FBA_inventory_and_inbound_services": "FBA_inventory_and_inbound_services",
    "service_fees": "service_fees",
    "advertising_costs": "advertising_costs",
}

EXCEL_ROW_MAPPING: Dict[str, tuple] = {
    "FBA_product_sales": (4, 3),
    "FBA_product_sale_refunds": (5, 3),
    "FBA_selling_fees": (3, 8),
    "FBA_transaction_fees": (5, 8),
    "FBA_inventory_and_inbound_services": (9, 8),
    "service_fees": (13, 8),
    "advertising_costs": (16, 8),
}

TOLERANCE = 0.01


def read_excel_report核算(sheet) -> Dict[str, float]:
    excel_data = {}

    for field_name, (row_num, col) in EXCEL_ROW_MAPPING.items():
        try:
            value = sheet.cell(row=row_num, column=col).value
            if value is not None:
                excel_data[field_name] = float(value)
            else:
                excel_data[field_name] = None
        except (ValueError, TypeError):
            excel_data[field_name] = None

    total_income_col = 3
    total_expense_col = 8
    try:
        income_val = sheet.cell(row=23, column=total_income_col).value
        expense_val = sheet.cell(row=23, column=total_expense_col).value
        excel_data["total_income"] = float(income_val) if income_val is not None else None
        excel_data["total_expense"] = float(expense_val) if expense_val is not None else None
    except (ValueError, TypeError):
        excel_data["total_income"] = None
        excel_data["total_expense"] = None

    return excel_data


def calculate_match(
    excel_val: Optional[float], pdf_val: Optional[float], tolerance: float = TOLERANCE
) -> tuple[bool, Optional[float], Optional[float]]:
    if excel_val is None and pdf_val is None:
        return True, None, None
    if excel_val is None or pdf_val is None:
        return False, None, None

    diff = round(abs(excel_val - pdf_val), 2)
    diff_percent = round((diff / abs(pdf_val) * 100), 2) if pdf_val != 0 else None

    is_match = diff <= tolerance

    return is_match, diff, diff_percent


def reconcile(
    excel_path: str,
    pdf_path: str,
    excel_sheet_name: str = "报表核算",
    tolerance: float = TOLERANCE,
) -> ReconciliationResult:
    import openpyxl

    wb = openpyxl.load_workbook(excel_path, data_only=True)
    sheet = wb[excel_sheet_name]

    excel_data = read_excel_report核算(sheet)

    extractor = PDFExtractor(pdf_path)
    pdf_data = extractor.get_raw_data().get("key_values", {})

    items: List[ReconciliationItem] = []
    matched = 0
    mismatched = 0
    missing = 0

    all_fields = set(list(EXCEL_ROW_MAPPING.keys()) + ["total_income", "total_expense"])

    for field_name in sorted(all_fields):
        excel_val = excel_data.get(field_name)
        pdf_val = pdf_data.get(field_name)

        if excel_val is None and pdf_val is None:
            continue

        is_match, diff, diff_pct = calculate_match(excel_val, pdf_val, tolerance)

        item = ReconciliationItem(
            field_name=field_name,
            excel_value=excel_val,
            pdf_value=pdf_val,
            match=is_match,
            difference=diff,
            difference_percent=diff_pct,
        )
        items.append(item)

        if is_match:
            matched += 1
        elif excel_val is None or pdf_val is None:
            missing += 1
        else:
            mismatched += 1

    summary = {
        "excel_total_income": excel_data.get("total_income"),
        "excel_total_expense": excel_data.get("total_expense"),
        "excel_net_amount": (
            (excel_data.get("total_income") or 0) + (excel_data.get("total_expense") or 0)
            if excel_data.get("total_income") is not None
            and excel_data.get("total_expense") is not None
            else None
        ),
        "pdf_total_income": pdf_data.get("total_income"),
        "pdf_total_expense": pdf_data.get("total_expense"),
        "pdf_net_amount": (
            (pdf_data.get("total_income") or 0) + (pdf_data.get("total_expense") or 0)
            if pdf_data.get("total_income") is not None
            and pdf_data.get("total_expense") is not None
            else None
        ),
    }

    return ReconciliationResult(
        total_items=len(items),
        matched_items=matched,
        mismatched_items=mismatched,
        missing_items=missing,
        items=items,
        summary=summary,
    )


def reconcile_to_dict(
    excel_path: str, pdf_path: str, excel_sheet_name: str = "报表核算", tolerance: float = TOLERANCE
) -> Dict[str, Any]:
    result = reconcile(excel_path, pdf_path, excel_sheet_name, tolerance)
    return {
        "summary": result.summary,
        "total_items": result.total_items,
        "matched_items": result.matched_items,
        "mismatched_items": result.mismatched_items,
        "missing_items": result.missing_items,
        "match_rate": round(result.matched_items / result.total_items * 100, 1)
        if result.total_items > 0
        else 0,
        "items": [
            {
                "field_name": item.field_name,
                "excel_value": item.excel_value,
                "pdf_value": item.pdf_value,
                "match": item.match,
                "difference": item.difference,
                "difference_percent": item.difference_percent,
                "note": item.note,
            }
            for item in result.items
        ],
    }