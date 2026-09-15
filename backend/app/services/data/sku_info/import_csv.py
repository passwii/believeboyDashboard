from __future__ import annotations

import csv
from decimal import Decimal
from io import StringIO
from pathlib import Path
from typing import Any, cast

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import SkuRecord
from app.schemas.sku_info import SkuRecordCreate
from app.services.data.sku_info.cache import _resolve_project_id
from app.services.data.sku_info.crud import (
    RMB_CURRENCY,
    WEIGHT_DECIMAL_QUANT,
    _apply_listing_copy_fields,
    _listing_copy_values,
    _normalize_cost,
    _normalize_decimal_value,
    _normalize_int,
    _normalize_optional_text,
    _normalize_sort_order,
    _normalize_text,
    _resequence_project_sort_orders,
    upsert_sku_record,
)
from app.utils.country import normalize_country

DEFAULT_BLF_BASIC_INFO_PATH = (
    Path(__file__).resolve().parents[4] / "Docs" / "ModelFiles" / "BLF_Basic_Info.csv"
)


def _csv_value(
    normalized_row: dict[str, str | None], *headers: str
) -> tuple[str, bool]:
    for header in headers:
        if header in normalized_row:
            return (normalized_row.get(header) or "").strip(), True
    return "", False


def _normalize_item_for_import(
    item: SkuRecordCreate,
    source_file: str | None = None,
) -> dict[str, Any]:
    provided_fields = set(item.model_fields_set)

    def optional_cost(
        field_name: str, value: float | str | Decimal | None
    ) -> Decimal | None:
        return (
            _normalize_cost(value, field_name)
            if field_name in provided_fields and value not in (None, "")
            else None
        )

    def optional_weight(
        field_name: str, value: float | str | Decimal | None
    ) -> Decimal | None:
        return (
            _normalize_decimal_value(value, field_name, WEIGHT_DECIMAL_QUANT)
            if field_name in provided_fields and value not in (None, "")
            else None
        )

    def optional_int(field_name: str, value: int | str | None) -> int | None:
        return (
            _normalize_int(value, field_name)
            if field_name in provided_fields and value not in (None, "")
            else None
        )

    return {
        "project_name": _normalize_text(item.project_name, "project_name"),
        "sku": _normalize_text(item.sku, "sku"),
        "asin": _normalize_optional_text(item.asin) or "",
        "fnsku": _normalize_optional_text(item.fnsku)
        if "fnsku" in provided_fields
        else None,
        "product_name": _normalize_optional_text(item.product_name)
        if "product_name" in provided_fields
        else None,
        "fob_unit_cost": optional_cost("fob_unit_cost", item.fob_unit_cost),
        "first_leg_cost_rmb": optional_cost(
            "first_leg_cost_rmb", item.first_leg_cost_rmb
        ),
        "package_length_cm": optional_cost("package_length_cm", item.package_length_cm),
        "package_width_cm": optional_cost("package_width_cm", item.package_width_cm),
        "package_height_cm": optional_cost("package_height_cm", item.package_height_cm),
        "weight_kg": optional_weight("weight_kg", item.weight_kg),
        "carton_length_cm": optional_cost("carton_length_cm", item.carton_length_cm),
        "carton_width_cm": optional_cost("carton_width_cm", item.carton_width_cm),
        "carton_height_cm": optional_cost("carton_height_cm", item.carton_height_cm),
        "carton_weight_kg": optional_weight("carton_weight_kg", item.carton_weight_kg),
        "units_per_carton": optional_int("units_per_carton", item.units_per_carton),
        "currency": RMB_CURRENCY,
        "country": normalize_country(item.country),
        "sort_order": _normalize_sort_order(item.sort_order),
        "is_active": bool(item.is_active) if "is_active" in provided_fields else None,
        "source_file": (source_file or item.source_file or "").strip() or None,
    }


def _find_existing_for_import(
    db: Session,
    normalized: dict[str, Any],
    *,
    allow_multiple_matches: bool = False,
) -> SkuRecord | None:
    project_name = str(normalized["project_name"])
    project_id = _resolve_project_id(db, project_name)
    sku = str(normalized["sku"])
    country = str(normalized["country"])

    matches = (
        db.execute(
            select(SkuRecord).where(
                SkuRecord.project_id == project_id,
                SkuRecord.sku == sku,
                SkuRecord.country == country,
            )
        )
        .scalars()
        .all()
    )
    if len(matches) > 1 and not allow_multiple_matches:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"存在多条同 project_name + SKU + 国家 的记录，请补充 ASIN 后再导入: {project_name} / {sku} / {country}",
        )
    return matches[0] if matches else None


def import_sku_records(
    db: Session,
    items: list[SkuRecordCreate],
    *,
    import_mode: str,
    source_file: str | None = None,
    operator: str | None = None,
) -> tuple[list[SkuRecord], int, int, int]:
    """批量导入 SKU 记录（BLF-1080：同步落产品文案字段）。

    ``items`` 是公开的 ``SkuRecordCreate``（JSON 批量端点），文案字段与
    通用 CRUD 同语义：只写显式提供项，显式提供即刷新溯源列。
    """
    normalized_mode = import_mode.strip().lower()
    if normalized_mode not in {"create", "update"}:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="import_mode must be create or update",
        )

    inserted = 0
    updated = 0
    skipped = 0
    rows: list[SkuRecord] = []
    next_sort_order_cache: dict[str, int] = {}

    for item in items:
        normalized = _normalize_item_for_import(item, source_file)
        # 产品文案（BLF-1080 P1）：只收集显式提供项，未提供的字段不进入 payload。
        listing_values = _listing_copy_values(item)
        existing = _find_existing_for_import(
            db,
            normalized,
            allow_multiple_matches=normalized_mode == "create",
        )

        if normalized_mode == "create":
            if existing is not None:
                skipped += 1
                continue

            create_data: dict[str, Any] = {
                "project_name": str(normalized["project_name"]),
                "sku": str(normalized["sku"]),
                "asin": str(normalized["asin"]),
                "fnsku": (
                    str(normalized["fnsku"])
                    if normalized["fnsku"] is not None
                    else None
                ),
                "product_name": (
                    str(normalized["product_name"])
                    if normalized["product_name"] is not None
                    else None
                ),
                "fob_unit_cost": cast(float | None, normalized["fob_unit_cost"]),
                "first_leg_cost_rmb": cast(
                    float | None, normalized["first_leg_cost_rmb"]
                ),
                "package_length_cm": cast(float | None, normalized["package_length_cm"]),
                "package_width_cm": cast(float | None, normalized["package_width_cm"]),
                "package_height_cm": cast(float | None, normalized["package_height_cm"]),
                "weight_kg": cast(float | None, normalized["weight_kg"]),
                "carton_length_cm": cast(float | None, normalized["carton_length_cm"]),
                "carton_width_cm": cast(float | None, normalized["carton_width_cm"]),
                "carton_height_cm": cast(float | None, normalized["carton_height_cm"]),
                "carton_weight_kg": cast(float | None, normalized["carton_weight_kg"]),
                "units_per_carton": cast(int | None, normalized["units_per_carton"]),
                "country": str(normalized["country"]),
                "sort_order": cast(int | None, normalized["sort_order"]),
                "is_active": (
                    bool(normalized["is_active"])
                    if normalized["is_active"] is not None
                    else True
                ),
                "source_file": (
                    str(normalized["source_file"])
                    if normalized["source_file"] is not None
                    else None
                ),
                # 文案字段：仅显式提供项进入构造（保 model_fields_set 语义），
                # 由 upsert_sku_record 落列并盖 listing_copy_updated_{at,by}。
                **listing_values,
            }
            create_item = SkuRecordCreate.model_validate(create_data)
            row, _ = upsert_sku_record(
                db,
                create_item,
                source_file,
                next_sort_order_cache=next_sort_order_cache,
                operator=operator,
            )
            rows.append(row)
            inserted += 1
            continue

        if existing is None:
            skipped += 1
            continue

        if "asin" in item.model_fields_set and str(normalized["asin"]) != existing.asin:
            duplicate = (
                db.execute(
                    select(SkuRecord).where(
                        SkuRecord.project_id == existing.project_id,
                        SkuRecord.sku == existing.sku,
                        SkuRecord.country == existing.country,
                        SkuRecord.asin == str(normalized["asin"]),
                        SkuRecord.id != existing.id,
                    )
                )
                .scalars()
                .first()
            )
            if duplicate:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=f"更新 ASIN 后与现有记录重复: {existing.project_name} / {existing.sku} / {existing.country} / {normalized['asin']}",
                )
            existing.asin = str(normalized["asin"])
        if "fnsku" in item.model_fields_set:
            existing.fnsku = (
                str(normalized["fnsku"]) if normalized["fnsku"] is not None else None
            )
        if "product_name" in item.model_fields_set:
            existing.product_name = (
                str(normalized["product_name"])
                if normalized["product_name"] is not None
                else None
            )
        if normalized["fob_unit_cost"] is not None:
            existing.fob_unit_cost = float(normalized["fob_unit_cost"])
        if normalized["first_leg_cost_rmb"] is not None:
            existing.first_leg_cost_rmb = float(normalized["first_leg_cost_rmb"])
        if normalized["package_length_cm"] is not None:
            existing.package_length_cm = float(normalized["package_length_cm"])
        if normalized["package_width_cm"] is not None:
            existing.package_width_cm = float(normalized["package_width_cm"])
        if normalized["package_height_cm"] is not None:
            existing.package_height_cm = float(normalized["package_height_cm"])
        if normalized["weight_kg"] is not None:
            existing.weight_kg = float(normalized["weight_kg"])
        if normalized["carton_length_cm"] is not None:
            existing.carton_length_cm = float(normalized["carton_length_cm"])
        if normalized["carton_width_cm"] is not None:
            existing.carton_width_cm = float(normalized["carton_width_cm"])
        if normalized["carton_height_cm"] is not None:
            existing.carton_height_cm = float(normalized["carton_height_cm"])
        if normalized["carton_weight_kg"] is not None:
            existing.carton_weight_kg = float(normalized["carton_weight_kg"])
        if normalized["units_per_carton"] is not None:
            existing.units_per_carton = int(normalized["units_per_carton"])
        if normalized["sort_order"] is not None:
            existing.sort_order = int(normalized["sort_order"])
            _resequence_project_sort_orders(
                db,
                project_id=existing.project_id,
                project_name=existing.project_name,
                prioritized_row=existing,
                requested_sort_order=int(normalized["sort_order"]),
            )
        if normalized["is_active"] is not None:
            existing.is_active = bool(normalized["is_active"])
        existing.currency = RMB_CURRENCY
        existing.source_file = (
            str(normalized["source_file"])
            if normalized["source_file"] is not None
            else existing.source_file
        )
        # 产品文案（BLF-1080 P1）：update 模式同样落显式提供的文案字段。
        _apply_listing_copy_fields(existing, listing_values, operator=operator)
        db.flush()
        db.refresh(existing)
        rows.append(existing)
        updated += 1

    return rows, inserted, updated, skipped


def read_sku_record_csv_file(
    csv_path: Path | None = None,
) -> tuple[list[SkuRecordCreate], str]:
    target = csv_path or DEFAULT_BLF_BASIC_INFO_PATH
    if not target.exists() or not target.is_file():
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"CSV 文件不存在: {target}",
        )

    try:
        content = target.read_bytes()
    except OSError as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"读取 CSV 文件失败: {exc}",
        ) from exc

    items = parse_sku_record_csv(content)
    return items, target.name


def parse_sku_record_csv(content: bytes) -> list[SkuRecordCreate]:
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="CSV 编码必须为 UTF-8"
        ) from None

    reader = csv.DictReader(StringIO(text))
    required_headers = {"project_name", "SKU"}
    if not reader.fieldnames:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="CSV 缺少表头"
        )

    available_headers = {name.strip() for name in reader.fieldnames if name}
    if not required_headers.issubset(available_headers):
        missing = ", ".join(sorted(required_headers - available_headers))
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=f"CSV 缺少字段: {missing}"
        )

    items: list[SkuRecordCreate] = []
    for row in reader:
        normalized_row = {(key or "").strip(): value for key, value in row.items()}
        asin_value, asin_present = _csv_value(
            normalized_row, "ASIN", "ASIN(可留空)", "ASIN(可留空，后续维护)", "asin"
        )
        fnsku_value, fnsku_present = _csv_value(
            normalized_row, "FNSKU", "FNSKU(可留空)", "FNSKU(可留空，后续维护)", "fnsku"
        )
        product_name_value, product_name_present = _csv_value(
            normalized_row, "品名", "品名(可留空)", "product_name"
        )
        first_leg_value, first_leg_present = _csv_value(
            normalized_row, "头程成本(RMB)", "头程成本"
        )
        fob_value, fob_present = _csv_value(normalized_row, "FOB单价", "FOB单价(RMB)")
        package_length_value, package_length_present = _csv_value(
            normalized_row, "单品长(cm)"
        )
        package_width_value, package_width_present = _csv_value(
            normalized_row, "单品宽(cm)"
        )
        package_height_value, package_height_present = _csv_value(
            normalized_row, "单品高(cm)"
        )
        weight_value, weight_present = _csv_value(normalized_row, "单品重量(kg)")
        carton_length_value, carton_length_present = _csv_value(
            normalized_row, "外箱长(cm)"
        )
        carton_width_value, carton_width_present = _csv_value(
            normalized_row, "外箱宽(cm)"
        )
        carton_height_value, carton_height_present = _csv_value(
            normalized_row, "外箱高(cm)"
        )
        carton_weight_value, carton_weight_present = _csv_value(
            normalized_row, "外箱重量(kg)"
        )
        units_value, units_present = _csv_value(normalized_row, "装箱数量")
        # 产品文案（BLF-1080）：导出 `export_type=listing` 模板承诺「可直接回传导入」，
        # 故同一批表头需能读回。仅当列**存在**时才进入 payload（保 model_fields_set
        # 语义：列缺失 = 不动该字段）。
        listing_values: dict[str, str | None] = {}
        for field, *headers in (
            ("listing_title", "标题"),
            ("listing_bullet_1", "五点描述1"),
            ("listing_bullet_2", "五点描述2"),
            ("listing_bullet_3", "五点描述3"),
            ("listing_bullet_4", "五点描述4"),
            ("listing_bullet_5", "五点描述5"),
            ("listing_description", "Description"),
            ("listing_selling_points", "卖点提炼"),
        ):
            value, present = _csv_value(normalized_row, *headers, field)
            if present:
                listing_values[field] = value or None
        items.append(
            SkuRecordCreate(
                project_name=(normalized_row.get("project_name") or "").strip(),
                sku=(normalized_row.get("SKU") or "").strip(),
                asin=asin_value if asin_present else "",
                fnsku=fnsku_value or None if fnsku_present else None,
                **(
                    {"product_name": str(product_name_value or "") or None}
                    if product_name_present
                    else {}
                ),
                **(
                    {"first_leg_cost_rmb": float(first_leg_value or 0)}
                    if first_leg_present
                    else {}
                ),
                **(
                    {"fob_unit_cost": float(fob_value or 0)}
                    if fob_present
                    else {}
                ),
                **(
                    {"package_length_cm": float(package_length_value or 0)}
                    if package_length_present
                    else {}
                ),
                **(
                    {"package_width_cm": float(package_width_value or 0)}
                    if package_width_present
                    else {}
                ),
                **(
                    {"package_height_cm": float(package_height_value or 0)}
                    if package_height_present
                    else {}
                ),
                **({"weight_kg": float(weight_value or 0)} if weight_present else {}),
                **(
                    {"carton_length_cm": float(carton_length_value or 0)}
                    if carton_length_present
                    else {}
                ),
                **(
                    {"carton_width_cm": float(carton_width_value or 0)}
                    if carton_width_present
                    else {}
                ),
                **(
                    {"carton_height_cm": float(carton_height_value or 0)}
                    if carton_height_present
                    else {}
                ),
                **(
                    {"carton_weight_kg": float(carton_weight_value or 0)}
                    if carton_weight_present
                    else {}
                ),
                **({"units_per_carton": int(units_value or 0)} if units_present else {}),
                **listing_values,
                currency=RMB_CURRENCY,
                country=(
                    normalized_row.get("国家") or normalized_row.get("country") or "US"
                ).strip()
                or "US",
            )
        )

    valid_items = [item for item in items if item.project_name and item.sku]
    if not valid_items:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="CSV 没有可导入的有效数据"
        )

    return valid_items
