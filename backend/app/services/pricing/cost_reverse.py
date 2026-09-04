from __future__ import annotations

from decimal import Decimal

from sqlalchemy.orm import Session

from app.schemas.pricing_calculation import PricingCalculationCreateRequest
from app.services.pricing.computation import _compute_pricing
from app.services.pricing.utils import _decimal, _money_decimal, _ratio


def _solve_fob_cost_for_profit_rate(
    payload: object, db: Session
) -> Decimal:
    target_profit_rate = _ratio(_decimal(getattr(payload, "target_profit_rate", 0)))
    low = Decimal("0.01")
    high = Decimal("100000")
    best_cost = low
    best_result: dict[str, object] | None = None

    def compute_at(cost: Decimal) -> dict[str, object]:
        candidate_payload = PricingCalculationCreateRequest(
            product_name=getattr(payload, "product_name", ""),
            package_length_cm=getattr(payload, "package_length_cm", 0),
            package_width_cm=getattr(payload, "package_width_cm", 0),
            package_height_cm=getattr(payload, "package_height_cm", 0),
            weight_kg=getattr(payload, "weight_kg", 0),
            fob_product_cost_rmb=float(cost),
            first_leg_cost_rmb=getattr(payload, "first_leg_cost_rmb", 0),
            project_id=getattr(payload, "project_id", None),
            sku=getattr(payload, "sku", None),
            use_historical_shipping_cost=getattr(payload, "use_historical_shipping_cost", False),
            sale_price_usd=getattr(payload, "sale_price_usd", 0),
            commission_rate=getattr(payload, "commission_rate", 0.15),
            advertising_rate=getattr(payload, "advertising_rate", 0),
            return_loss_rate=getattr(payload, "return_loss_rate", 0),
            storage_months=getattr(payload, "storage_months", 1),
            inbound_placement_mode=getattr(payload, "inbound_placement_mode", "single_destination"),
            usd_to_rmb_rate=getattr(payload, "usd_to_rmb_rate", None),
        )
        return _compute_pricing(candidate_payload, db)

    for _ in range(40):
        mid = _money_decimal((low + high) / Decimal("2"))
        result = compute_at(mid)
        current_profit_rate = result["profit_decimal"]["profit_rate"]

        if abs(current_profit_rate - target_profit_rate) < Decimal("0.0001"):
            best_cost = mid
            best_result = result
            break

        if current_profit_rate > target_profit_rate:
            low = mid
        else:
            high = mid

        best_cost = mid
        best_result = result

    if best_result is None:
        raise ValueError("无法找到满足目标利润率的 FOB 成本")

    return _money_decimal(best_cost)
