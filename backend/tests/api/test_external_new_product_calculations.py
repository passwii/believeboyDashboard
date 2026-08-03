"""Contract tests for BEL-416 New Product Calculation external endpoint.

Covers:

* 404 for missing project
* 400 for missing / invalid country / order_by / order_dir
* 200 + correct shape for valid requests
* 15-field whitelist enforced
* Pagination
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.main import app


# ---------------------------------------------------------------------------
# Fixtures + helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture
def db_session() -> Session:
    session = SessionLocal()
    try:
        yield session
    finally:
        session.rollback()
        session.close()


def _np_url(project_id: int, **params: str) -> str:
    base = f"/api/v1/external/projects/{project_id}/new-product-calculations"
    qs = "&".join(f"{k}={v}" for k, v in params.items())
    return f"{base}?{qs}" if qs else base


def _seed_new_product_calculation(
    db_session: Session,
    project_id: int,
    project_name: str,
    *,
    sku: str,
    country: str = "US",
    calculation_type: str = "profit_calc",
    sale_price_usd: float = 29.99,
    profit_usd: float = 5.0,
    profit_rate: float = 0.10,
    target_profit_rate: float | None = None,
) -> None:
    from app.models import NewProductCalculation

    db_session.add(
        NewProductCalculation(
            project_id=project_id,
            project_name=project_name,
            sku=sku,
            asin=f"B{abs(hash(sku)) % (10**10):010d}",
            country=country,
            calculation_type=calculation_type,
            package_length_cm=20.0,
            package_width_cm=15.0,
            package_height_cm=10.0,
            weight_kg=0.5,
            fob_product_cost_rmb=50.0,
            first_leg_cost_rmb=10.0,
            ddp_cost_rmb=60.0,
            ddp_cost_usd=8.57,
            sale_price_usd=sale_price_usd,
            target_profit_rate=target_profit_rate,
            advertising_rate=0.12,
            return_loss_rate=0.04,
            storage_months=1.0,
            inbound_placement_mode="single_destination",
            usd_to_rmb_rate=7.0,
            usd_to_rmb_rate_source="manual",
            size_tier="standard",
            size_tier_label="标准",
            price_band="mid",
            price_band_label="中端",
            longest_side_in=8.0,
            middle_side_in=6.0,
            shortest_side_in=4.0,
            length_plus_girth_in=22.0,
            volume_cubic_in=192.0,
            volume_cubic_ft=0.111,
            product_weight_lb=1.1,
            product_weight_oz=17.6,
            dimensional_weight_lb=1.0,
            chargeable_weight_lb=1.1,
            chargeable_weight_oz=17.6,
            chargeable_weight_rule="actual",
            fulfillment_fee_rule_label="standard",
            inbound_config_fee_rule_label="standard",
            storage_fee_rule_label="standard",
            referral_fee_usd=4.5,
            advertising_fee_usd=3.6,
            return_loss_usd=1.2,
            fba_fulfillment_fee_usd=5.0,
            inbound_config_fee_usd=1.0,
            storage_fee_usd=0.5,
            total_fee_usd=15.8,
            delivery_fee_usd=0.0,
            inbound_config_fee_manual_usd=0.0,
            storage_fee_manual_usd=0.0,
            payout_usd=14.19,
            profit_usd=profit_usd,
            profit_rate=profit_rate,
            vat_usd=0.0,
            profit_after_vat_usd=None,
            profit_after_vat_rate=None,
            warnings_json=None,
            notes=None,
            created_by=None,
        )
    )
    db_session.commit()


@pytest.fixture()
def seeded_project(db_session: Session):
    """Create a unique inactive project + 3 NewProductCalculation rows:
    - SKU-A profit_calc
    - SKU-B profit_calc
    - SKU-A profit_reverse (target_profit_rate set)
    """
    from datetime import datetime, timezone
    from app.models import Project

    marker = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    project = Project(
        project_name=f"BEL-416 NPC Test {marker}",
        sort_order=0,
        is_active=False,
    )
    db_session.add(project)
    db_session.commit()
    db_session.refresh(project)
    pid = project.id
    pname = project.project_name

    _seed_new_product_calculation(db_session, pid, pname, sku="BEL-416-A")
    _seed_new_product_calculation(
        db_session,
        pid,
        pname,
        sku="BEL-416-A",
        calculation_type="profit_reverse",
        sale_price_usd=24.99,
        profit_usd=4.0,
        profit_rate=0.16,
        target_profit_rate=0.20,
    )
    _seed_new_product_calculation(db_session, pid, pname, sku="BEL-416-B")

    try:
        yield pid
    finally:
        db_session.expire_all()
        db_session.execute(
            text("DELETE FROM new_product_calculations WHERE project_id = :pid"),
            {"pid": pid},
        )
        db_session.execute(text("DELETE FROM projects WHERE id = :pid"), {"pid": pid})
        db_session.commit()


# ---------------------------------------------------------------------------
# /new-product-calculations tests
# ---------------------------------------------------------------------------


class TestNewProductCalculationsContract:
    def test_missing_project_returns_404(self, client):
        resp = client.get(_np_url(99999999))
        assert resp.status_code == 404, resp.text

    def test_invalid_country_returns_400(self, client, seeded_project):
        resp = client.get(_np_url(seeded_project, country="ZZ"))
        assert resp.status_code == 400, resp.text

    def test_valid_request_returns_200_with_correct_shape(self, client, seeded_project):
        resp = client.get(_np_url(seeded_project))
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["project_id"] == seeded_project
        assert body["page"] == 1
        assert body["page_size"] == 200
        assert isinstance(body["data"], list)
        assert body["total"] == 3

    def test_row_has_15_fields(self, client, seeded_project):
        resp = client.get(_np_url(seeded_project))
        body = resp.json()
        row = body["data"][0]
        expected = {
            "id",
            "project_id",
            "project_name",
            "sku",
            "asin",
            "country",
            "calculation_type",
            "sale_price_usd",
            "target_profit_rate",
            "profit_usd",
            "profit_rate",
            "payout_usd",
            "total_fee_usd",
            "created_at",
            "updated_at",
        }
        assert set(row.keys()) == expected, (
            f"unexpected fields: {set(row.keys()) ^ expected}"
        )

    def test_sensitive_fields_not_exposed(self, client, seeded_project):
        resp = client.get(_np_url(seeded_project))
        body = resp.json()
        forbidden = {
            "created_by",
            "warnings",
            "warnings_json",
            "notes",
            "fulfillment_fee_rule_label",
            "inbound_config_fee_rule_label",
            "storage_fee_rule_label",
        }
        for row in body["data"]:
            assert forbidden.isdisjoint(row.keys()), (
                f"row leaked forbidden field: {forbidden & row.keys()}"
            )

    def test_calculation_type_filter(self, client, seeded_project):
        resp = client.get(_np_url(seeded_project, calculation_type="profit_reverse"))
        body = resp.json()
        assert body["total"] == 1
        assert body["data"][0]["calculation_type"] == "profit_reverse"
        assert body["data"][0]["target_profit_rate"] == 0.20

    def test_country_filter(self, client, seeded_project):
        resp = client.get(_np_url(seeded_project, country="DE"))
        # No DE rows seeded → 0
        body = resp.json()
        assert body["total"] == 0

    def test_pagination(self, client, seeded_project):
        resp = client.get(_np_url(seeded_project, page="1", page_size="2"))
        body = resp.json()
        assert body["total"] == 3
        assert len(body["data"]) == 2
        resp2 = client.get(_np_url(seeded_project, page="2", page_size="2"))
        body2 = resp2.json()
        assert len(body2["data"]) == 1
        # Distinct ids across pages
        page1_ids = {r["id"] for r in body["data"]}
        page2_ids = {r["id"] for r in body2["data"]}
        assert page1_ids.isdisjoint(page2_ids)


class TestNewProductCalculationsOrdering:
    def test_unknown_order_by_returns_400(self, client, seeded_project):
        resp = client.get(_np_url(seeded_project, order_by="warnings_json"))
        assert resp.status_code == 400, resp.text
        assert "order_by must be one of" in resp.json()["detail"].lower()

    def test_sensitive_order_by_returns_400(self, client, seeded_project):
        for forbidden in ("created_by", "warnings_json", "notes"):
            resp = client.get(_np_url(seeded_project, order_by=forbidden))
            assert resp.status_code == 400, (
                f"order_by={forbidden!r} should 400, got {resp.status_code}"
            )

    def test_invalid_order_dir_returns_422(self, client, seeded_project):
        resp = client.get(_np_url(seeded_project, order_dir="sideways"))
        assert resp.status_code == 422, resp.text

    def test_all_15_whitelisted_order_by_work(self, client, seeded_project):
        from app.api.v1.endpoints.external import _whitelist
        from app.models import NewProductCalculation

        whitelisted = list(_whitelist.ROW_WHITELIST[NewProductCalculation].keys())
        assert len(whitelisted) == 15
        for field in whitelisted:
            resp = client.get(
                _np_url(
                    seeded_project,
                    order_by=field,
                    order_dir="asc",
                )
            )
            assert resp.status_code == 200, (
                f"order_by={field!r} should 200, got {resp.status_code}: {resp.text}"
            )
