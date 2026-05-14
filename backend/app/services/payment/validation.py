"""Payment report project matching validation.

Validates that a payment report CSV matches the selected project and country
before processing.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import SkuRecord
from app.services.payment.locale import read_payment_report_dataframe
from app.utils.country import normalize_country


def validate_project_match(
    db: Session,
    *,
    transaction_file_path: str,
    selected_project_name: str,
    selected_country: str,
) -> dict[str, Any]:
    """Validate that a payment report CSV matches the selected project and country.

    Uses payment/locale.py for CSV parsing:
    1. Detect the country from the CSV's marketplace column
    2. Extract SKUs and cross-reference against product_costs to identify the project

    Args:
        db: Database session.
        transaction_file_path: Path to the payment report CSV.
        selected_project_name: Expected project name.
        selected_country: Expected country code.

    Returns:
        Dict with keys: valid, errors, warnings, message.

    Raises:
        HTTPException: If the transaction file does not exist.
    """
    csv_path = Path(transaction_file_path)
    if not csv_path.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="交易文件不存在，请重新上传",
        )

    result: dict[str, Any] = {
        "valid": True,
        "errors": [],
        "warnings": [],
        "message": "",
    }
    detected_country: str | None = None

    try:
        df = read_payment_report_dataframe(csv_path, country=selected_country)
        # Detect country from marketplace column
        mkt_col = next((c for c in df.columns if "marketplace" in c.lower()), None)
        if mkt_col and not df[mkt_col].dropna().empty:
            mkt_val = str(df[mkt_col].dropna().iloc[0]).strip().lower()
            if "amazon.com" in mkt_val:
                detected_country = "US"
            elif "amazon.de" in mkt_val:
                detected_country = "DE"
            elif "amazon.co.uk" in mkt_val:
                detected_country = "UK"
    except Exception:
        result["valid"] = False
        result["errors"].append(
            "无法解析交易文件，请确认文件格式正确（需为 Amazon Payment Report CSV）"
        )
        return result

    normalized_country = normalize_country(selected_country)

    # Layer 1: Country cross-check
    if detected_country and detected_country != normalized_country:
        country_zh = {"US": "美国站", "DE": "德国站", "UK": "英国站"}
        detected_zh = country_zh.get(detected_country, detected_country)
        selected_zh = country_zh.get(normalized_country, normalized_country)
        result["valid"] = False
        result["errors"].append(
            f"文件内容检测到站点为 {detected_zh}（{detected_country}），"
            f"与您选择的站点 {selected_zh}（{normalized_country}）不一致，"
            f"请确认后重新上传"
        )

    # Layer 2: SKU → project matching
    sku_col = next((c for c in df.columns if c.lower() == "sku"), None)
    if sku_col is None:
        result["warnings"].append("文件中未找到 SKU 列，略过项目校验")
        return result

    sku_values = df[sku_col].dropna().astype(str).tolist()
    unique_skus = sorted({v.strip() for v in sku_values if v.strip()})
    if not unique_skus:
        result["warnings"].append("文件中 SKU 列为空，略过项目校验")
        return result

    try:
        sku_lower = [s.lower() for s in unique_skus]
        matched_projects = (
            db.execute(
                select(func.distinct(SkuRecord.project_name))
                .where(func.lower(SkuRecord.sku).in_(sku_lower))
                .where(SkuRecord.is_active.is_(True))
                .where(SkuRecord.country == normalized_country)
            )
            .scalars()
            .all()
        )
        matched_projects = sorted(set(matched_projects))

        if len(matched_projects) == 0:
            result["valid"] = False
            result["errors"].append(
                f"文件中的 SKU 在站点 {normalized_country} 下未匹配到任何产品，"
                f"请确认文件与所选项目/站点是否一致"
            )
        elif len(matched_projects) == 1:
            matched = matched_projects[0]
            if matched != selected_project_name:
                result["valid"] = False
                result["errors"].append(
                    f"文件中的 SKU 匹配到项目「{matched}」，"
                    f"与您选择的项目「{selected_project_name}」不一致，"
                    f"请确认后重新上传"
                )
            else:
                result["message"] = (
                    f"已验证：文件 SKU 匹配项目「{selected_project_name}」"
                )
        else:
            if selected_project_name in matched_projects:
                result["warnings"].append(
                    f"文件中的 SKU 匹配到多个项目（{', '.join(matched_projects)}），"
                    f"当前所选项目「{selected_project_name}」在其中，将继续处理"
                )
            else:
                result["valid"] = False
                result["errors"].append(
                    f"文件中的 SKU 匹配到多个项目（{', '.join(matched_projects)}），"
                    f"但未包含您选择的项目「{selected_project_name}」，"
                    f"请确认后重新上传"
                )
    except Exception:
        result["warnings"].append("SKU 项目校验查询失败，略过项目校验")

    return result
