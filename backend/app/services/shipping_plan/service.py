from __future__ import annotations

from calendar import monthrange
from collections import defaultdict
from datetime import date, timedelta
from decimal import Decimal

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import (
    AnalysisSalesOrderRow,
    AnalysisSourceFile,
    Project,
    ShipmentSchedule,
    ShipmentScheduleItem,
    ShippingPlanAllocation,
    ShippingPlanBatch,
    ShippingPlanItem,
    ShippingPlanSkuSetting,
    SkuRecord,
)
from app.services.inventory.replenishment import load_shipping_plan_baseline
from app.services.sales_query import counted_sales_where
from app.services.shipping_plan.forecast import (
    ShippingPlanBaseline,
    ShippingPlanBaselineItem,
    SupplyArrival,
    simulate_sku_forecast,
)
from app.utils.country import normalize_country

FORECAST_HORIZON_DAYS = 180


def _invalid(detail: str, code: int = status.HTTP_422_UNPROCESSABLE_ENTITY) -> HTTPException:
    return HTTPException(status_code=code, detail=detail)


def _require_single_country(country: str) -> str:
    if (country or "").strip().upper() == "ALL":
        raise _invalid("发货规划必须选择单一站点")
    try:
        return normalize_country(country)
    except ValueError as exc:
        raise _invalid(str(exc)) from exc


def _get_project(db: Session, project_id: int) -> Project:
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="项目不存在")
    return project


def _get_sku_setting_map(db: Session, project_id: int, country: str) -> dict[str, ShippingPlanSkuSetting]:
    rows = db.scalars(
        select(ShippingPlanSkuSetting).where(
            ShippingPlanSkuSetting.project_id == project_id,
            ShippingPlanSkuSetting.country == country,
        )
    ).all()
    return {row.sku: row for row in rows}


def _get_shipments_by_sku(
    db: Session, project_id: int, country: str
) -> dict[str, list[dict[str, object]]]:
    rows = db.execute(
        select(
            ShipmentSchedule.id,
            ShipmentSchedule.shipment_no,
            ShipmentSchedule.shipment_status,
            ShipmentSchedule.eta_date,
            ShipmentSchedule.etd_date,
            ShipmentSchedule.created_date,
            ShipmentSchedule.actual_inbound_date,
            ShipmentScheduleItem.sku,
            ShipmentScheduleItem.quantity,
        )
        .join(ShipmentScheduleItem, ShipmentScheduleItem.shipment_schedule_id == ShipmentSchedule.id)
        .where(
            ShipmentSchedule.project_id == project_id,
            ShipmentSchedule.country == country,
            ShipmentSchedule.shipment_status.in_(("draft", "in_transit", "completed")),
        )
    ).all()
    grouped: dict[str, list[dict[str, object]]] = defaultdict(list)
    for row in rows:
        grouped[str(row.sku)].append(
            {
                "schedule_id": int(row.id),
                "shipment_no": str(row.shipment_no),
                "status": str(row.shipment_status),
                "eta_date": row.eta_date,
                "etd_date": row.etd_date,
                "created_date": row.created_date,
                "actual_inbound_date": row.actual_inbound_date,
                "quantity": int(row.quantity),
            }
        )
    return grouped


def _get_plan_arrivals(
    db: Session, project_id: int, country: str
) -> dict[str, list[dict[str, object]]]:
    rows = db.execute(
        select(
            ShippingPlanItem.sku,
            ShippingPlanBatch.id,
            ShippingPlanBatch.name,
            ShippingPlanBatch.expected_arrival_date,
            ShippingPlanItem.quantity,
            func.coalesce(func.sum(ShippingPlanAllocation.quantity), 0).label("allocated"),
        )
        .join(ShippingPlanBatch, ShippingPlanBatch.id == ShippingPlanItem.batch_id)
        .outerjoin(ShippingPlanAllocation, ShippingPlanAllocation.plan_item_id == ShippingPlanItem.id)
        .where(
            ShippingPlanBatch.project_id == project_id,
            ShippingPlanBatch.country == country,
            ShippingPlanBatch.status == "active",
        )
        .group_by(
            ShippingPlanItem.id,
            ShippingPlanItem.sku,
            ShippingPlanBatch.id,
            ShippingPlanBatch.name,
            ShippingPlanBatch.expected_arrival_date,
            ShippingPlanItem.quantity,
        )
    ).all()
    grouped: dict[str, list[dict[str, object]]] = defaultdict(list)
    for row in rows:
        remaining = max(0, int(row.quantity) - int(row.allocated or 0))
        if remaining:
            grouped[str(row.sku)].append(
                {
                    "batch_id": int(row.id),
                    "name": str(row.name),
                    "arrival_date": row.expected_arrival_date,
                    "quantity": remaining,
                }
            )
    return grouped


def _resolve_eta(shipment: dict[str, object], shipping_days: int) -> date | None:
    eta = shipment["eta_date"]
    if eta is not None:
        return eta  # type: ignore[return-value]
    etd = shipment["etd_date"]
    if etd is not None:
        return etd + timedelta(days=shipping_days)  # type: ignore[operator]
    created = shipment["created_date"]
    if created is not None:
        return created + timedelta(days=shipping_days)  # type: ignore[operator]
    return None


def _build_forecast(
    db: Session,
    *,
    project_id: int,
    country: str,
    sku: str,
    as_of_date: date,
    baseline: ShippingPlanBaseline | None = None,
    setting_map: dict[str, ShippingPlanSkuSetting] | None = None,
    shipment_map: dict[str, list[dict[str, object]]] | None = None,
    plan_map: dict[str, list[dict[str, object]]] | None = None,
    include_historical_sales: bool = True,
) -> dict[str, object]:
    country = _require_single_country(country)
    if baseline is None:
        baseline = load_shipping_plan_baseline(
            db, project_id=project_id, country=country, as_of_date=as_of_date
        )
    item = next((entry for entry in baseline.items if entry.sku == sku), None)
    if item is None:
        raise HTTPException(status_code=404, detail="项目站点下未找到该 SKU")
    start_date = as_of_date + timedelta(days=1)
    end_date = start_date + timedelta(days=FORECAST_HORIZON_DAYS - 1)
    settings = setting_map if setting_map is not None else _get_sku_setting_map(db, project_id, country)
    setting = settings.get(sku)
    growth_factor = setting.growth_factor if setting else Decimal("1.0")
    shipments = shipment_map if shipment_map is not None else _get_shipments_by_sku(db, project_id, country)
    plans = plan_map if plan_map is not None else _get_plan_arrivals(db, project_id, country)
    shipment_rows = shipments.get(sku, [])
    plan_rows = plans.get(sku, [])
    confirmed_arrivals: list[SupplyArrival] = []
    plan_only_arrivals: list[SupplyArrival] = []
    arrivals: list[dict[str, object]] = []
    quality: list[str] = []
    overdue_shipment_quantity = 0
    overdue_plan_quantity = 0
    unverified_completed_quantity = 0
    stale_post_snapshot = False

    for shipment in shipment_rows:
        shipment_status = str(shipment["status"])
        quantity = int(shipment["quantity"])
        if shipment_status == "completed":
            actual_inbound_date = shipment["actual_inbound_date"]
            snapshot_date = item.inventory_snapshot_date
            if actual_inbound_date is None or snapshot_date is None:
                unverified_completed_quantity += quantity
                quality.append("completed_inbound_unverified")
                # The baseline may or may not include this receipt; inventory is not trustworthy.
                stale_post_snapshot = True
                arrivals.append(
                    {"arrival_date": None, "sku": sku, "quantity": quantity, "source_type": "completed", "reference": shipment["shipment_no"], "data_quality": "inbound_unverified"}
                )
                continue
            if actual_inbound_date <= snapshot_date:
                continue
            if actual_inbound_date < start_date:
                stale_post_snapshot = True
                quality.append("post_snapshot_inbound_before_forecast_start")
                arrivals.append(
                    {"arrival_date": actual_inbound_date, "sku": sku, "quantity": quantity, "source_type": "completed", "reference": shipment["shipment_no"], "data_quality": "inventory_snapshot_required"}
                )
                continue
            if actual_inbound_date <= end_date:
                confirmed_arrivals.append(SupplyArrival(actual_inbound_date, quantity))
                arrivals.append(
                    {"arrival_date": actual_inbound_date, "sku": sku, "quantity": quantity, "source_type": "completed", "reference": shipment["shipment_no"]}
                )
            continue

        eta = _resolve_eta(shipment, item.shipping_days)
        source_type = shipment_status
        if eta is None:
            quality.append("shipment_eta_missing")
            arrivals.append(
                {"arrival_date": None, "sku": sku, "quantity": quantity, "source_type": source_type, "reference": shipment["shipment_no"], "data_quality": "eta_missing"}
            )
            continue
        if eta < start_date:
            overdue_shipment_quantity += quantity
            quality.append("shipment_eta_overdue")
            arrivals.append(
                {"arrival_date": eta, "sku": sku, "quantity": quantity, "source_type": source_type, "reference": shipment["shipment_no"], "data_quality": "eta_overdue"}
            )
            continue
        if eta <= end_date:
            if shipment_status == "in_transit":
                confirmed_arrivals.append(SupplyArrival(eta, quantity))
            else:
                plan_only_arrivals.append(SupplyArrival(eta, quantity))
            arrivals.append(
                {"arrival_date": eta, "sku": sku, "quantity": quantity, "source_type": source_type, "reference": shipment["shipment_no"]}
            )

    for plan in plan_rows:
        eta = plan["arrival_date"]
        quantity = int(plan["quantity"])
        if eta < start_date:
            overdue_plan_quantity += quantity
            quality.append("plan_eta_overdue")
            arrivals.append(
                {"arrival_date": eta, "sku": sku, "quantity": quantity, "source_type": "expected_plan", "reference": plan["name"], "data_quality": "plan_overdue"}
            )
            continue
        if eta <= end_date:
            plan_only_arrivals.append(SupplyArrival(eta, quantity))
            arrivals.append(
                {"arrival_date": eta, "sku": sku, "quantity": quantity, "source_type": "expected_plan", "reference": plan["name"]}
            )

    if item.inventory_snapshot_date is None:
        quality.append("inventory_snapshot_missing")
    if item.available_inventory is None:
        quality.append("sku_inventory_snapshot_missing")
    if item.base_dms is None:
        quality.append("sales_baseline_missing")
    simulation = simulate_sku_forecast(
        start_date=start_date,
        horizon_days=FORECAST_HORIZON_DAYS,
        available_inventory=None if stale_post_snapshot else item.available_inventory,
        base_dms=item.base_dms,
        growth_factor=growth_factor,
        confirmed_arrivals=confirmed_arrivals,
        planned_only_arrivals=plan_only_arrivals,
    )
    confirmed_total = (
        None
        if not simulation or simulation[0].confirmed_sales is None
        else sum((point.confirmed_sales or Decimal(0) for point in simulation), Decimal(0))
    )
    planned_total = (
        None
        if not simulation or simulation[0].planned_sales is None
        else sum((point.planned_sales or Decimal(0) for point in simulation), Decimal(0))
    )
    if stale_post_snapshot:
        confirmed_total = planned_total = None
    historical_sales = (
        _load_historical_sales(
            db, project_id=project_id, country=country, sku=sku,
            forecast_start=start_date, forecast_days=FORECAST_HORIZON_DAYS,
        )
        if include_historical_sales
        else {}
    )
    return {
        "project_id": project_id,
        "country": country,
        "sku": sku,
        "as_of_date": as_of_date,
        "forecast_start_date": start_date,
        "forecast_end_date": end_date,
        "inventory_snapshot_date": item.inventory_snapshot_date,
        "sales_baseline_start_date": as_of_date - timedelta(days=29),
        "sales_baseline_end_date": as_of_date,
        "base_dms": item.base_dms,
        "growth_factor": growth_factor,
        "demand_source": "manual" if setting else "default",
        "data_quality": list(dict.fromkeys(quality)),
        "daily_points": [
            {
                "forecast_date": point.forecast_date,
                "demand": point.demand,
                "confirmed_sales": point.confirmed_sales,
                "planned_sales": point.planned_sales,
                "confirmed_closing_inventory": point.confirmed_closing_inventory,
                "planned_closing_inventory": point.planned_closing_inventory,
                "historical_order_sales": historical_sales.get(point.forecast_date),
            }
            for point in simulation
        ],
        "arrivals": arrivals,
        "confirmed_180d_sales_upper_bound": confirmed_total,
        "planned_180d_sales_upper_bound": planned_total,
        "unverified_completed_quantity": unverified_completed_quantity,
        "overdue_shipment_quantity": overdue_shipment_quantity,
        "overdue_plan_quantity": overdue_plan_quantity,
    }


def _sales_coverage_intervals(
    db: Session,
    *,
    project_id: int,
    country: str,
    start: date,
    end: date,
) -> list[tuple[date, date]]:
    """Return merged successful sales-report coverage intervals overlapping a window."""
    sources = db.execute(
        select(AnalysisSourceFile.period_start_date, AnalysisSourceFile.period_end_date)
        .where(
            AnalysisSourceFile.project_id == project_id,
            AnalysisSourceFile.country == country,
            AnalysisSourceFile.report_type == "sales_report",
            AnalysisSourceFile.ingestion_status == "success",
            AnalysisSourceFile.is_current.is_(True),
            AnalysisSourceFile.superseded_at.is_(None),
            AnalysisSourceFile.period_start_date <= end,
            AnalysisSourceFile.period_end_date >= start,
        )
    ).all()
    intervals = sorted(
        (row.period_start_date, row.period_end_date)
        for row in sources
        if row.period_start_date is not None and row.period_end_date is not None
    )
    merged: list[list[date]] = []
    for left, right in intervals:
        if not merged or left > merged[-1][1] + timedelta(days=1):
            merged.append([left, right])
        elif right > merged[-1][1]:
            merged[-1][1] = right
    return [(left, right) for left, right in merged]


def _load_historical_sales(
    db: Session,
    *,
    project_id: int,
    country: str,
    sku: str,
    forecast_start: date,
    forecast_days: int,
) -> dict[date, int | None]:
    """Return prior-year orderSales only for days fully covered by successful reports."""
    target_dates = [forecast_start + timedelta(days=offset) - timedelta(days=365) for offset in range(forecast_days)]
    start_date, end_date = min(target_dates), max(target_dates)
    intervals = _sales_coverage_intervals(
        db,
        project_id=project_id,
        country=country,
        start=start_date,
        end=end_date,
    )
    covered = {
        target_date: any(left <= target_date <= right for left, right in intervals)
        for target_date in target_dates
    }
    rows = db.execute(
        select(
            AnalysisSalesOrderRow.purchase_date_pt,
            func.coalesce(func.sum(AnalysisSalesOrderRow.quantity), 0),
        )
        .where(
            *counted_sales_where(
                project_id=project_id,
                country=country,
                date_from=start_date,
                date_to=end_date,
            ),
            AnalysisSalesOrderRow.sku == sku,
        )
        .group_by(AnalysisSalesOrderRow.purchase_date_pt)
    ).all()
    sales = {row[0]: int(row[1] or 0) for row in rows}
    return {
        forecast_date: sales.get(historical_date, 0) if covered[historical_date] else None
        for forecast_date, historical_date in zip(
            (forecast_start + timedelta(days=offset) for offset in range(forecast_days)),
            target_dates,
        )
    }


def _forecast_summary(item: ShippingPlanBaselineItem, forecast: dict[str, object]) -> dict[str, object]:
    return {
        "available_inventory": item.available_inventory,
        "base_dms": item.base_dms,
        "confirmed_180d_sales_upper_bound": forecast["confirmed_180d_sales_upper_bound"],
        "planned_180d_sales_upper_bound": forecast["planned_180d_sales_upper_bound"],
    }


def list_shipping_plan_skus(
    db: Session,
    *, project_id: int, country: str, as_of_date: date, page: int, page_size: int
) -> dict[str, object]:
    country = _require_single_country(country)
    baseline = load_shipping_plan_baseline(db, project_id=project_id, country=country, as_of_date=as_of_date)
    setting_map = _get_sku_setting_map(db, project_id, country)
    start = (page - 1) * page_size
    page_end = start + page_size
    shipments = _get_shipments_by_sku(db, project_id, country)
    plans = _get_plan_arrivals(db, project_id, country)
    results: list[dict[str, object]] = []
    forecasts_by_sku: dict[str, dict[str, object]] = {}
    for index, item in enumerate(baseline.items):
        setting = setting_map.get(item.sku)
        forecast = _build_forecast(
            db,
            project_id=project_id,
            country=country,
            sku=item.sku,
            as_of_date=as_of_date,
            baseline=baseline,
            setting_map=setting_map,
            shipment_map=shipments,
            plan_map=plans,
            include_historical_sales=False,
        )
        forecasts_by_sku[item.sku] = forecast
        if index < start or index >= page_end:
            continue
        skushipments = shipments.get(item.sku, [])
        results.append(
            {
                "sku": item.sku,
                "asin": item.asin,
                "product_name": item.product_name,
                "available_inventory": item.available_inventory,
                "inventory_snapshot_date": item.inventory_snapshot_date,
                "base_dms": item.base_dms,
                "growth_factor": setting.growth_factor if setting else Decimal("1.0"),
                "demand_source": "manual" if setting else "default",
                "in_transit_quantity": sum(int(row["quantity"]) for row in skushipments if row["status"] == "in_transit"),
                "draft_quantity": sum(int(row["quantity"]) for row in skushipments if row["status"] == "draft"),
                "active_plan_remaining_quantity": sum(int(row["quantity"]) for row in plans.get(item.sku, [])),
                **_forecast_summary(item, forecast),
                "data_quality": forecast["data_quality"],
            }
        )
    valid_count = sum(
        1
        for forecast in forecasts_by_sku.values()
        if forecast["confirmed_180d_sales_upper_bound"] is not None
        and forecast["planned_180d_sales_upper_bound"] is not None
    )
    missing_count = len(baseline.items) - valid_count
    known_confirmed = sum(
        (
            forecast["confirmed_180d_sales_upper_bound"]
            for forecast in forecasts_by_sku.values()
            if forecast["confirmed_180d_sales_upper_bound"] is not None
        ),
        Decimal(0),
    )
    known_planned = sum(
        (
            forecast["planned_180d_sales_upper_bound"]
            for forecast in forecasts_by_sku.values()
            if forecast["planned_180d_sales_upper_bound"] is not None
        ),
        Decimal(0),
    )
    total = len(baseline.items)
    return {
        "items": results,
        "total": total,
        "page": page,
        "page_size": page_size,
        "valid_forecast_sku_count": valid_count,
        "missing_forecast_sku_count": missing_count,
        "known_confirmed_sales_upper_bound": known_confirmed,
        "known_planned_sales_upper_bound": known_planned,
    }


def get_shipping_plan_forecast(db: Session, *, project_id: int, country: str, sku: str, as_of_date: date) -> dict[str, object]:
    return _build_forecast(db, project_id=project_id, country=country, sku=sku, as_of_date=as_of_date)


def upsert_growth_factor(
    db: Session, *, project_id: int, country: str, sku: str, growth_factor: Decimal, operator: str | None
) -> ShippingPlanSkuSetting:
    country = _require_single_country(country)
    project = _get_project(db, project_id)
    sku = sku.strip()
    if not sku:
        raise _invalid("sku 不能为空")
    if growth_factor < 0:
        raise _invalid("growth_factor 必须大于等于 0")
    if not db.scalar(select(SkuRecord.id).where(SkuRecord.project_id == project_id, SkuRecord.country == country, SkuRecord.sku == sku, SkuRecord.is_active.is_(True)).limit(1)):
        raise HTTPException(status_code=404, detail="项目站点下未找到该 SKU")
    row = db.scalar(select(ShippingPlanSkuSetting).where(ShippingPlanSkuSetting.project_id == project_id, ShippingPlanSkuSetting.country == country, ShippingPlanSkuSetting.sku == sku).with_for_update())
    if row is None:
        row = ShippingPlanSkuSetting(project_id=project.id, country=country, sku=sku, growth_factor=growth_factor, created_by=operator, updated_by=operator)
        db.add(row)
    else:
        row.growth_factor = growth_factor
        row.updated_by = operator
    db.flush()
    return row


def _batch_response(db: Session, batch: ShippingPlanBatch) -> dict[str, object]:
    item_rows = db.execute(
        select(ShippingPlanItem, func.coalesce(func.sum(ShippingPlanAllocation.quantity), 0))
        .outerjoin(ShippingPlanAllocation, ShippingPlanAllocation.plan_item_id == ShippingPlanItem.id)
        .where(ShippingPlanItem.batch_id == batch.id)
        .group_by(ShippingPlanItem.id)
        .order_by(ShippingPlanItem.sku)
    ).all()
    items = []
    for plan_item, allocated in item_rows:
        allocations = db.scalars(select(ShippingPlanAllocation).where(ShippingPlanAllocation.plan_item_id == plan_item.id).order_by(ShippingPlanAllocation.id)).all()
        allocated = int(allocated or 0)
        items.append({"id": plan_item.id, "sku": plan_item.sku, "quantity": plan_item.quantity, "allocated_quantity": allocated, "remaining_quantity": max(0, plan_item.quantity - allocated), "allocations": [
            {"id": allocation.id, "plan_item_id": allocation.plan_item_id, "shipment_schedule_id": allocation.shipment_schedule_id, "sku": allocation.sku, "quantity": allocation.quantity}
            for allocation in allocations
        ]})
    return {"id": batch.id, "project_id": batch.project_id, "country": batch.country, "name": batch.name, "expected_arrival_date": batch.expected_arrival_date, "status": batch.status, "remark": batch.remark, "items": items}


def list_plan_batches(db: Session, *, project_id: int, country: str) -> dict[str, object]:
    country = _require_single_country(country)
    batches = db.scalars(select(ShippingPlanBatch).where(ShippingPlanBatch.project_id == project_id, ShippingPlanBatch.country == country).order_by(ShippingPlanBatch.expected_arrival_date, ShippingPlanBatch.id)).all()
    return {"items": [_batch_response(db, batch) for batch in batches], "total": len(batches)}


def create_plan_batch(db: Session, *, payload, operator: str | None) -> ShippingPlanBatch:
    country = _require_single_country(payload.country)
    project = _get_project(db, payload.project_id)
    _validate_skus(db, project.id, country, [item.sku for item in payload.items])
    batch = ShippingPlanBatch(project_id=project.id, country=country, name=payload.name, expected_arrival_date=payload.expected_arrival_date, remark=payload.remark, status="active", created_by=operator, updated_by=operator)
    batch.items = [ShippingPlanItem(sku=item.sku, quantity=item.quantity) for item in payload.items]
    db.add(batch)
    db.flush()
    return batch


def update_plan_batch(db: Session, *, batch_id: int, project_id: int, country: str, payload, operator: str | None) -> ShippingPlanBatch:
    batch = _get_batch(db, batch_id, project_id, country, lock=True)
    if batch.status != "active":
        raise _invalid("已取消计划批次不可编辑", status.HTTP_409_CONFLICT)
    if payload.name is not None:
        batch.name = payload.name.strip()
    if payload.expected_arrival_date is not None:
        batch.expected_arrival_date = payload.expected_arrival_date
    if payload.remark is not None:
        batch.remark = payload.remark
    if payload.items is not None:
        _validate_skus(db, project_id, country, [item.sku for item in payload.items])
        incoming = {item.sku: item.quantity for item in payload.items}
        existing_items = db.scalars(select(ShippingPlanItem).where(ShippingPlanItem.batch_id == batch.id).with_for_update()).all()
        for plan_item in existing_items:
            allocated = int(db.scalar(select(func.coalesce(func.sum(ShippingPlanAllocation.quantity), 0)).where(ShippingPlanAllocation.plan_item_id == plan_item.id)) or 0)
            requested = incoming.pop(plan_item.sku, None)
            if requested is None:
                if allocated:
                    raise _invalid(f"SKU {plan_item.sku} 存在已关联数量，不能从批次移除", status.HTTP_409_CONFLICT)
                db.delete(plan_item)
            else:
                if requested < allocated:
                    raise _invalid(f"SKU {plan_item.sku} 的计划数量不能小于已关联数量", status.HTTP_409_CONFLICT)
                plan_item.quantity = requested
        for sku, quantity in incoming.items():
            db.add(ShippingPlanItem(batch_id=batch.id, sku=sku, quantity=quantity))
    batch.updated_by = operator
    db.flush()
    return batch


def cancel_plan_batch(db: Session, *, batch_id: int, project_id: int, country: str, operator: str | None) -> ShippingPlanBatch:
    batch = _get_batch(db, batch_id, project_id, country, lock=True)
    batch.status = "cancelled"
    batch.updated_by = operator
    db.flush()
    return batch


def _get_batch(db: Session, batch_id: int, project_id: int, country: str, *, lock: bool = False) -> ShippingPlanBatch:
    country = _require_single_country(country)
    stmt = select(ShippingPlanBatch).where(ShippingPlanBatch.id == batch_id, ShippingPlanBatch.project_id == project_id, ShippingPlanBatch.country == country)
    if lock:
        stmt = stmt.with_for_update()
    batch = db.scalar(stmt)
    if batch is None:
        raise HTTPException(status_code=404, detail="计划批次不存在")
    return batch


def _validate_skus(db: Session, project_id: int, country: str, skus: list[str]) -> None:
    found = set(db.scalars(select(SkuRecord.sku).where(SkuRecord.project_id == project_id, SkuRecord.country == country, SkuRecord.is_active.is_(True), SkuRecord.sku.in_(skus))).all())
    missing = sorted(set(skus) - found)
    if missing:
        raise _invalid(f"SKU 不属于项目及站点: {', '.join(missing)}")


def create_or_add_allocation(db: Session, *, payload, project_id: int, country: str) -> dict[str, object]:
    country = _require_single_country(country)
    plan_item_ref = db.execute(
        select(ShippingPlanItem.batch_id).where(ShippingPlanItem.id == payload.plan_item_id)
    ).first()
    if plan_item_ref is None:
        raise HTTPException(status_code=404, detail="计划 SKU 明细不存在")

    # Lock the shared shipment row first, matching the item replacement path.
    schedule = db.scalar(
        select(ShipmentSchedule)
        .where(ShipmentSchedule.id == payload.shipment_schedule_id)
        .with_for_update()
    )
    if schedule is None or schedule.project_id != project_id or schedule.country != country:
        raise HTTPException(status_code=404, detail="正式货件不存在")
    batch = db.scalar(
        select(ShippingPlanBatch)
        .where(ShippingPlanBatch.id == plan_item_ref.batch_id)
        .with_for_update()
    )
    if batch is None or batch.project_id != project_id or batch.country != country:
        raise HTTPException(status_code=404, detail="计划 SKU 明细不存在")
    plan_item = db.scalar(
        select(ShippingPlanItem)
        .where(ShippingPlanItem.id == payload.plan_item_id)
        .with_for_update()
    )
    if plan_item is None:
        raise HTTPException(status_code=404, detail="计划 SKU 明细不存在")
    if batch.status != "active":
        raise _invalid("已取消计划不能新增货件关联", status.HTTP_409_CONFLICT)
    if schedule.shipment_status not in ("draft", "in_transit"):
        raise _invalid("仅 draft / in_transit 货件可关联", status.HTTP_409_CONFLICT)
    schedule_item_quantity = db.scalar(select(ShipmentScheduleItem.quantity).where(ShipmentScheduleItem.shipment_schedule_id == schedule.id, ShipmentScheduleItem.sku == plan_item.sku))
    if schedule_item_quantity is None:
        raise _invalid("正式货件不包含该 SKU")
    plan_allocated = int(db.scalar(select(func.coalesce(func.sum(ShippingPlanAllocation.quantity), 0)).where(ShippingPlanAllocation.plan_item_id == plan_item.id)) or 0)
    shipment_allocated = int(db.scalar(select(func.coalesce(func.sum(ShippingPlanAllocation.quantity), 0)).where(ShippingPlanAllocation.shipment_schedule_id == schedule.id, ShippingPlanAllocation.sku == plan_item.sku)) or 0)
    if plan_allocated + payload.quantity > plan_item.quantity:
        raise _invalid("关联数量超过计划余额", status.HTTP_409_CONFLICT)
    if shipment_allocated + payload.quantity > int(schedule_item_quantity):
        raise _invalid("关联数量超过正式货件 SKU 未分配数量", status.HTTP_409_CONFLICT)
    allocation = db.scalar(select(ShippingPlanAllocation).where(ShippingPlanAllocation.plan_item_id == plan_item.id, ShippingPlanAllocation.shipment_schedule_id == schedule.id).with_for_update())
    if allocation is not None:
        raise _invalid("该计划明细与正式货件已关联", status.HTTP_409_CONFLICT)
    allocation = ShippingPlanAllocation(plan_item_id=plan_item.id, shipment_schedule_id=schedule.id, sku=plan_item.sku, quantity=payload.quantity)
    db.add(allocation)
    db.flush()
    return {"allocation": allocation, "plan_item_remaining_quantity": plan_item.quantity - plan_allocated - payload.quantity, "shipment_sku_remaining_quantity": int(schedule_item_quantity) - shipment_allocated - payload.quantity}


def delete_allocation(db: Session, *, allocation_id: int, project_id: int, country: str) -> None:
    country = _require_single_country(country)
    allocation = db.scalar(select(ShippingPlanAllocation).where(ShippingPlanAllocation.id == allocation_id))
    if allocation is None:
        raise HTTPException(status_code=404, detail="货件关联不存在")
    schedule = db.scalar(select(ShipmentSchedule).where(ShipmentSchedule.id == allocation.shipment_schedule_id).with_for_update())
    if schedule is None or schedule.project_id != project_id or schedule.country != country:
        raise HTTPException(status_code=404, detail="货件关联不存在")
    db.delete(allocation)
    db.flush()



def get_shipment_history(db: Session, *, project_id: int, country: str, etd_from: date, etd_to: date) -> dict[str, object]:
    country = _require_single_country(country)
    if etd_to < etd_from:
        raise _invalid("etd_to 必须大于或等于 etd_from")
    rows = db.execute(
        select(ShipmentSchedule.id, ShipmentSchedule.etd_date, ShipmentSchedule.shipment_no, ShipmentScheduleItem.quantity)
        .join(ShipmentScheduleItem, ShipmentScheduleItem.shipment_schedule_id == ShipmentSchedule.id)
        .where(ShipmentSchedule.project_id == project_id, ShipmentSchedule.country == country, ShipmentSchedule.shipment_status.in_(("in_transit", "completed")))
    ).all()
    monthly: dict[str, dict[str, object]] = {}
    missing_ids: set[int] = set()
    missing_quantity = 0
    for schedule_id, etd, shipment_no, quantity in rows:
        if etd is None:
            missing_ids.add(int(schedule_id))
            missing_quantity += int(quantity)
            continue
        if etd < etd_from or etd > etd_to:
            continue
        month = etd.strftime("%Y-%m")
        record = monthly.setdefault(month, {"month": month, "shipment_count": 0, "quantity": 0, "_ids": set()})
        record["quantity"] = int(record["quantity"]) + int(quantity)
        record["_ids"].add(int(schedule_id))
    months = []
    for month in sorted(monthly):
        row = monthly[month]
        months.append({"month": month, "shipment_count": len(row["_ids"]), "quantity": row["quantity"]})

    coverage_intervals = _sales_coverage_intervals(
        db,
        project_id=project_id,
        country=country,
        start=etd_from,
        end=etd_to,
    )
    month_expr = func.date_trunc("month", AnalysisSalesOrderRow.purchase_date_pt)
    sales_rows = db.execute(
        select(
            month_expr,
            func.coalesce(func.sum(AnalysisSalesOrderRow.quantity), 0),
            func.max(AnalysisSalesOrderRow.purchase_date_pt),
        )
        .where(
            *counted_sales_where(
                project_id=project_id,
                country=country,
                date_from=etd_from,
                date_to=etd_to,
            )
        )
        .group_by(month_expr)
    ).all()
    sales_by_month = {row[0].strftime("%Y-%m"): int(row[1] or 0) for row in sales_rows}
    sales_through_by_month = {
        row[0].strftime("%Y-%m"): row[2] for row in sales_rows if row[2] is not None
    }

    sales_months = []
    month_start = date(etd_from.year, etd_from.month, 1)
    while month_start <= etd_to:
        _, last_day = monthrange(month_start.year, month_start.month)
        month_end = date(month_start.year, month_start.month, last_day)
        covered_start = max(month_start, etd_from)
        covered_end = min(month_end, etd_to)
        covered = any(
            left <= covered_start and right >= covered_end
            for left, right in coverage_intervals
        )
        month = month_start.strftime("%Y-%m")
        # Only report an official coverage cutoff when coverage is contiguous from
        # the start of this month's requested window. A later isolated interval
        # must not be presented as a continuous "through" date.
        coverage_through = next(
            (
                min(right, covered_end)
                for left, right in coverage_intervals
                if left <= covered_start <= right
            ),
            None,
        )
        sales_months.append(
            {
                "month": month,
                "sales_quantity": sales_by_month.get(month, 0) if covered else None,
                "covered": covered,
                "provisional_sales_quantity": (
                    None if covered else sales_by_month.get(month, 0)
                ),
                "provisional_sales_through": (
                    None if covered else sales_through_by_month.get(month)
                ),
                "coverage_through": None if covered else coverage_through,
            }
        )
        if month_start.month == 12:
            month_start = date(month_start.year + 1, 1, 1)
        else:
            month_start = date(month_start.year, month_start.month + 1, 1)

    return {
        "project_id": project_id,
        "country": country,
        "etd_from": etd_from,
        "etd_to": etd_to,
        "months": months,
        "missing_etd_shipment_count": len(missing_ids),
        "missing_etd_quantity": missing_quantity,
        "sales_months": sales_months,
    }
