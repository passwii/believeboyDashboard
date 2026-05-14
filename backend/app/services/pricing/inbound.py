from __future__ import annotations

from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import ExchangeRate, ShipmentSkuSummary
from app.services.pricing.utils import _decimal, _money


def _resolve_first_leg_cost_rmb(
    payload: object, db: Session
) -> tuple[Decimal, str | None]:
    manual_cost = _money(getattr(payload, "first_leg_cost_rmb", None) or 0)
    if not getattr(payload, "use_historical_shipping_cost", False):
        return manual_cost, None

    project_id = getattr(payload, "project_id", None)
    sku = (getattr(payload, "sku", None) or "").strip()
    if project_id is None or not sku:
        return manual_cost, "历史头程成本未命中项目或 SKU，已回退到手动头程成本"

    row = db.execute(
        select(ShipmentSkuSummary.average_logistics_unit_price)
        .where(
            ShipmentSkuSummary.project_id == project_id,
            ShipmentSkuSummary.sku == sku,
        )
        .limit(1)
    ).scalar_one_or_none()
    if row is None:
        return manual_cost, "未找到该 SKU 的头程历史加权成本，已回退到手动头程成本"

    historical_cost = _money(row)
    if historical_cost <= 0:
        return manual_cost, "该 SKU 的头程历史加权成本为 0，已回退到手动头程成本"
    return historical_cost, None


def _resolve_exchange_rate_to_rmb(
    db: Session, *, manual_rate: float | None, currency: str
) -> tuple[Decimal, str]:
    if manual_rate is not None:
        return _decimal(manual_rate), "manual"
    normalized_currency = currency.strip().upper()
    row = (
        db.execute(
            select(ExchangeRate)
            .where(ExchangeRate.currency == normalized_currency)
            .order_by(ExchangeRate.year_month.desc(), ExchangeRate.id.desc())
            .limit(1)
        )
        .scalars()
        .first()
    )
    if row is None:
        raise ValueError(f"缺少 {normalized_currency} 汇率，请先维护汇率信息或在请求中传入 usd_to_rmb_rate")
    return _decimal(row.rate), f"system:{row.year_month}"
