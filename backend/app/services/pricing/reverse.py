from __future__ import annotations

from decimal import Decimal

from sqlalchemy.orm import Session

from app.schemas.pricing_calculation import PricingCalculationCreateRequest
from app.services.pricing.computation import _compute_pricing
from app.services.pricing.utils import _decimal, _money_decimal, _ratio


def _solve_sale_price_for_profit_rate(
    payload: object, db: Session
) -> Decimal:
    target_profit_rate = _ratio(_decimal(getattr(payload, "target_profit_rate", 0)))
    low = Decimal("0.01")
    high = Decimal("10")

    def compute_at(price: Decimal) -> dict[str, object]:
        candidate_payload = PricingCalculationCreateRequest(
            product_name=getattr(payload, "product_name", ""),
            package_length_cm=getattr(payload, "package_length_cm", 0),
            package_width_cm=getattr(payload, "package_width_cm", 0),
            package_height_cm=getattr(payload, "package_height_cm", 0),
            weight_kg=getattr(payload, "weight_kg", 0),
            fob_product_cost_rmb=getattr(payload, "fob_product_cost_rmb", 0),
            first_leg_cost_rmb=getattr(payload, "first_leg_cost_rmb", 0),
            project_id=getattr(payload, "project_id", None),
            sku=getattr(payload, "sku", None),
            use_historical_shipping_cost=getattr(payload, "use_historical_shipping_cost", False),
            sale_price_usd=float(price),
            commission_rate=getattr(payload, "commission_rate", 0.15),
            advertising_rate=getattr(payload, "advertising_rate", 0),
            return_loss_rate=getattr(payload, "return_loss_rate", 0),
            storage_months=getattr(payload, "storage_months", 1),
            inbound_placement_mode=getattr(payload, "inbound_placement_mode", "single_destination"),
            usd_to_rmb_rate=getattr(payload, "usd_to_rmb_rate", None),
        )
        return _compute_pricing(candidate_payload, db)

    high_result = compute_at(high)
    high_profit_rate = high_result["profit_decimal"]["profit_rate"]
    while high_profit_rate < target_profit_rate:
        high *= Decimal("2")
        if high > Decimal("1000000"):
            raise ValueError("目标利润率过高，当前参数下无法倒算出合理售价")
        high_result = compute_at(high)
        high_profit_rate = high_result["profit_decimal"]["profit_rate"]

    for _ in range(40):
        mid = _money_decimal((low + high) / Decimal("2"))
        result = compute_at(mid)
        current_profit_rate = result["profit_decimal"]["profit_rate"]
        if current_profit_rate >= target_profit_rate:
            high = mid
        else:
            low = mid

    final_price = _money_decimal(high)
    final_result = compute_at(final_price)
    if final_result["profit_decimal"]["profit_rate"] < target_profit_rate:
        final_price = _money_decimal(final_price + Decimal("0.01"))

    return final_price
