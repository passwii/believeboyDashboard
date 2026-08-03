"""SKU info response schemas for the external API."""

from __future__ import annotations

from pydantic import BaseModel


class ExternalSkuInfoItem(BaseModel):
    """Public-facing SKU descriptor returned by ``GET /external/projects/{id}/sku-info``.

    Exposes product identity, pricing, dimensions, and carton specs.
    Internal fields (id, sort_order, source_file, factory_info JSON, R2 keys,
    uploaded_by) are intentionally omitted.
    """

    sku: str
    asin: str
    fnsku: str | None = None
    product_name: str | None = None

    # Pricing
    fob_unit_cost: float
    first_leg_cost_rmb: float
    currency: str
    country: str

    # Package dimensions (single unit)
    package_length_cm: float
    package_width_cm: float
    package_height_cm: float
    weight_kg: float

    # Carton specs
    carton_length_cm: float
    carton_width_cm: float
    carton_height_cm: float
    carton_weight_kg: float
    units_per_carton: int

    # Status
    is_active: bool

    # Product image (public URL only, no internal R2 key)
    product_image_url: str | None = None

    # Canonical Amazon product-detail URL derived from (country, asin) via
    # app.utils.marketplace_url.build_marketplace_url; None when the country
    # is empty or not a known marketplace.
    marketplace_url: str | None = None


class ExternalSkuInfoResponse(BaseModel):
    """Paginated wrapper for the SKU info list endpoint."""

    project_id: int
    country: str
    data: list[ExternalSkuInfoItem]
    total: int | None = None
    has_next: bool
