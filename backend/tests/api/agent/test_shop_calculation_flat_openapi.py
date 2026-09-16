"""R5/R6/R7 扁平锚列响应必须能从 OpenAPI 自动生成客户端类型。"""

from __future__ import annotations

from app.api.v1.lazy_router import preload_all_lazy_groups
from app.main import app

ROUTES = {
    "/api/v1/agent/projects/{project_id}/shop-calculation-history": (
        "ShopCalculationHistoryResponse"
    ),
    "/api/v1/agent/projects/{project_id}/shop-calculation/snapshots": (
        "ShopCalculationSnapshotsResponse"
    ),
    "/api/v1/agent/projects/{project_id}/pricing-snapshots": (
        "ShopCalculationSnapshotsResponse"
    ),
}


def _resolve_ref(schema: dict, ref: str) -> dict:
    assert ref.startswith("#/components/schemas/")
    return schema["components"]["schemas"][ref.rsplit("/", 1)[-1]]


def test_flat_anchor_routes_expose_explicit_openapi_schema() -> None:
    preload_all_lazy_groups()
    schema = app.openapi()
    schemas = schema["components"]["schemas"]

    assert "ShopCalculationHistoryRow" in schemas
    row_properties = schemas["ShopCalculationHistoryRow"]["properties"]
    assert {
        "breakeven_advertising_rate",
        "non_ad_fee_usd",
        "max_ad_spend_per_unit_usd",
        "target_advertising_rate",
    }.issubset(row_properties)

    for path, data_schema_name in ROUTES.items():
        operation = schema["paths"][path]["get"]
        parameter_names = {
            parameter["name"] for parameter in operation.get("parameters", [])
        }
        assert "include_anchor" in parameter_names

        response_schema = operation["responses"]["200"]["content"]["application/json"][
            "schema"
        ]
        assert "$ref" in response_schema
        wrapper = _resolve_ref(schema, response_schema["$ref"])
        ok_property = wrapper["properties"]["ok"]
        assert ok_property.get("const", ok_property.get("default")) is True
        data_ref = wrapper["properties"]["data"]["$ref"]
        assert data_ref.endswith(f"/{data_schema_name}")
