"""Contract tests for BEL-416 Shop Calculation external endpoints.

Two endpoints under test:

* ``GET /api/v1/external/projects/{id}/shop-calculation-history``
* ``GET /api/v1/external/projects/{id}/shop-calculation/snapshots``

Covers:

* 404 for missing project
* 400 for missing / invalid period / country / order_by / order_dir
* 200 + correct shape for valid requests
* 15-field whitelist enforced (``?order_by=warnings_json`` → 400)
* Soft-deleted rows are excluded from current-state
* History endpoint applies ``?from=&to=&sku=&country=`` filters

Test isolation: each test that seeds data creates a unique inactive
Project, then teardown deletes every dependent row by FK order
(``shop_calculation`` → ``projects``).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

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


def _history_url(project_id: int, **params: str) -> str:
    base = f"/api/v1/external/projects/{project_id}/shop-calculation-history"
    qs = "&".join(f"{k}={v}" for k, v in params.items())
    return f"{base}?{qs}" if qs else base


def _snapshots_url(project_id: int, **params: str) -> str:
    base = f"/api/v1/external/projects/{project_id}/shop-calculation/snapshots"
    qs = "&".join(f"{k}={v}" for k, v in params.items())
    return f"{base}?{qs}" if qs else base


def _seed_shop_calculation(
    db_session: Session,
    project_id: int,
    project_name: str,
    *,
    sku: str,
    country: str = "US",
    accounting_type: str = "profit_calc",
    sale_price_usd: float = 29.99,
    profit_usd: float = 5.0,
    profit_rate: float = 0.10,
    observed_at: datetime | None = None,
    source: str = "manual",
    deleted_at: datetime | None = None,
) -> None:
    """Insert one ShopCalculation row.

    Defaults are tuned to satisfy NOT NULL / Numeric constraints.
    """
    from app.models import ShopCalculation

    now = datetime.now(timezone.utc)
    db_session.add(
        ShopCalculation(
            project_id=project_id,
            project_name=project_name,
            sku=sku,
            asin=f"B{uuid_like(sku)}",
            country=country,
            accounting_type=accounting_type,
            # Package dims (NOT NULL)
            package_length_cm=20.0,
            package_width_cm=15.0,
            package_height_cm=10.0,
            weight_kg=0.5,
            # Costs
            fob_product_cost_rmb=50.0,
            first_leg_cost_rmb=10.0,
            ddp_cost_rmb=60.0,
            ddp_cost_usd=8.57,
            # Sales params
            sale_price_usd=sale_price_usd,
            advertising_rate=0.12,
            return_loss_rate=0.04,
            storage_months=1.0,
            inbound_placement_mode="single_destination",
            # Rates
            usd_to_rmb_rate=7.0,
            usd_to_rmb_rate_source="manual",
            # Size tier
            size_tier="standard",
            size_tier_label="标准",
            price_band="mid",
            price_band_label="中端",
            # Dim details
            longest_side_in=8.0,
            middle_side_in=6.0,
            shortest_side_in=4.0,
            length_plus_girth_in=22.0,
            volume_cubic_in=192.0,
            volume_cubic_ft=0.111,
            # Weight details
            product_weight_lb=1.1,
            product_weight_oz=17.6,
            dimensional_weight_lb=1.0,
            chargeable_weight_lb=1.1,
            chargeable_weight_oz=17.6,
            chargeable_weight_rule="actual",
            # Fee rule labels
            fulfillment_fee_rule_label="standard",
            inbound_config_fee_rule_label="standard",
            storage_fee_rule_label="standard",
            # Fees
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
            platform_fee_usd=0.0,
            # Profit
            payout_usd=14.19,
            profit_usd=profit_usd,
            profit_rate=profit_rate,
            vat_usd=0.0,
            profit_after_vat_usd=None,
            profit_after_vat_rate=None,
            # Lineage
            warnings_json=None,
            notes=None,
            created_by=None,
            source=source,
            observed_at=observed_at or now,
            deleted_at=deleted_at,
        )
    )
    db_session.commit()


def uuid_like(s: str) -> str:
    """Stable 10-char alphanumeric from input string for ASIN-like field."""
    h = abs(hash(s)) % (10**10)
    return f"{h:010d}"


@pytest.fixture()
def seeded_project(db_session: Session):
    """Create a unique inactive project + 3 ShopCalculation rows:
    - SKU-A (current)
    - SKU-A (older observation, append-only)
    - SKU-B (deleted — must not surface in current-state)

    Yields the project_id; teardown deletes everything by FK order.
    """
    from app.models import Project

    marker = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    project = Project(
        project_name=f"BEL-416 Shop Calc Test {marker}",
        sort_order=0,
        is_active=False,
    )
    db_session.add(project)
    db_session.commit()
    db_session.refresh(project)
    pid = project.id
    pname = project.project_name

    now = datetime.now(timezone.utc)
    older = now - timedelta(days=30)

    _seed_shop_calculation(
        db_session,
        pid,
        pname,
        sku="BEL-416-A",
        sale_price_usd=29.99,
        profit_usd=5.0,
        profit_rate=0.10,
        observed_at=now,
    )
    _seed_shop_calculation(
        db_session,
        pid,
        pname,
        sku="BEL-416-A",
        sale_price_usd=24.99,
        profit_usd=3.0,
        profit_rate=0.08,
        observed_at=older,
    )
    _seed_shop_calculation(
        db_session,
        pid,
        pname,
        sku="BEL-416-DEL",
        sale_price_usd=29.99,
        profit_usd=5.0,
        profit_rate=0.10,
        observed_at=now,
        deleted_at=now,
    )

    try:
        yield pid
    finally:
        db_session.expire_all()
        db_session.execute(
            text("DELETE FROM shop_calculation WHERE project_id = :pid"),
            {"pid": pid},
        )
        db_session.execute(text("DELETE FROM projects WHERE id = :pid"), {"pid": pid})
        db_session.commit()


# ---------------------------------------------------------------------------
# /shop-calculation-history tests
# ---------------------------------------------------------------------------


class TestShopCalculationHistoryContract:
    def test_missing_project_returns_404(self, client):
        resp = client.get(_history_url(99999999, country="US"))
        assert resp.status_code == 404, resp.text
        assert "not found" in resp.json()["detail"].lower()

    def test_invalid_country_returns_400(self, client, seeded_project):
        resp = client.get(_history_url(seeded_project, country="ZZ"))
        assert resp.status_code == 400, resp.text

    def test_valid_request_returns_200_with_correct_shape(self, client, seeded_project):
        resp = client.get(_history_url(seeded_project, country="US"))
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["project_id"] == seeded_project
        assert body["country"] == "US"
        assert isinstance(body["data"], list)
        assert body["total"] >= 1

    def test_row_has_16_fields(self, client, seeded_project):
        resp = client.get(_history_url(seeded_project, country="US"))
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert len(body["data"]) >= 1
        row = body["data"][0]
        expected = {
            "id",
            "project_id",
            "project_name",
            "sku",
            "asin",
            "country",
            "accounting_type",
            "observed_at",
            "source",
            "sale_price_usd",
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
        resp = client.get(_history_url(seeded_project, country="US"))
        body = resp.json()
        forbidden = {
            "created_by",
            "deleted_at",
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

    def test_deleted_rows_excluded(self, client, seeded_project):
        """BEL-416: soft-deleted rows must not surface in current-state."""
        resp = client.get(_history_url(seeded_project, country="US"))
        body = resp.json()
        skus = {r["sku"] for r in body["data"]}
        assert "BEL-416-DEL" not in skus
        # SKU-A latest should be present (the current-state view)
        assert "BEL-416-A" in skus

    def test_current_state_uses_latest_inserted_row(self, client, seeded_project):
        """The current-state list dedups by (project, sku, country) and
        surfaces the latest *inserted* row (MAX(id)). The first seeded
        SKU-A row (observed_at=now, sale_price=29.99) is inserted first
        (smaller id), so it gets *replaced* by the second seed (older
        observation, sale_price=24.99) — this matches the legacy
        ``list_by_project`` semantics (``MAX(id)``).

        Note: this means backfilling older observations via
        ``observed_at`` would surface the backfilled row, not the
        most-recent-observed one. That's the existing service contract
        and is what ``/api/v1/shop-calculation`` already returns — we
        mirror it deliberately."""
        resp = client.get(_history_url(seeded_project, country="US"))
        body = resp.json()
        sku_a = next(r for r in body["data"] if r["sku"] == "BEL-416-A")
        # The second seeded row (sale_price=24.99) wins because it has
        # the larger id.
        assert sku_a["sale_price_usd"] == 24.99
        assert sku_a["profit_usd"] == 3.0


class TestShopCalculationHistoryOrdering:
    def test_unknown_order_by_returns_400(self, client, seeded_project):
        resp = client.get(
            _history_url(seeded_project, country="US", order_by="warnings_json")
        )
        assert resp.status_code == 400, resp.text
        assert "order_by must be one of" in resp.json()["detail"].lower()

    def test_sensitive_order_by_returns_400(self, client, seeded_project):
        for forbidden in ("created_by", "deleted_at", "warnings_json", "notes"):
            resp = client.get(
                _history_url(seeded_project, country="US", order_by=forbidden)
            )
            assert resp.status_code == 400, (
                f"order_by={forbidden!r} should 400, got {resp.status_code}"
            )

    def test_invalid_order_dir_returns_422(self, client, seeded_project):
        resp = client.get(
            _history_url(seeded_project, country="US", order_dir="sideways")
        )
        assert resp.status_code == 422, resp.text

    def test_all_16_whitelisted_order_by_work(self, client, seeded_project):
        """Every field in ROW_WHITELIST[ShopCalculation] should be
        accepted by the endpoint."""
        from app.api.v1.endpoints.external import _whitelist
        from app.models import ShopCalculation

        whitelisted = list(_whitelist.ROW_WHITELIST[ShopCalculation].keys())
        assert len(whitelisted) == 16
        for field in whitelisted:
            resp = client.get(
                _history_url(
                    seeded_project,
                    country="US",
                    order_by=field,
                    order_dir="asc",
                )
            )
            assert resp.status_code == 200, (
                f"order_by={field!r} should 200, got {resp.status_code}: {resp.text}"
            )


# ---------------------------------------------------------------------------
# /shop-calculation/snapshots tests
# ---------------------------------------------------------------------------


class TestShopCalculationSnapshotsContract:
    def test_missing_project_returns_404(self, client):
        resp = client.get(_snapshots_url(99999999, country="US"))
        assert resp.status_code == 404, resp.text

    def test_invalid_country_returns_400(self, client, seeded_project):
        resp = client.get(_snapshots_url(seeded_project, country="ZZ"))
        assert resp.status_code == 400, resp.text

    def test_from_after_to_returns_400(self, client, seeded_project):
        resp = client.get(
            _snapshots_url(
                seeded_project,
                from_date="2026-08-03",
                to_date="2026-01-01",
                country="US",
            )
        )
        assert resp.status_code == 400, resp.text
        assert "from_date must be <=" in resp.json()["detail"].lower()

    def test_malformed_date_returns_400(self, client, seeded_project):
        resp = client.get(
            _snapshots_url(seeded_project, from_date="not-a-date", country="US")
        )
        assert resp.status_code == 400, resp.text

    def test_valid_request_returns_200_with_correct_shape(self, client, seeded_project):
        resp = client.get(_snapshots_url(seeded_project, country="US"))
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["project_id"] == seeded_project
        assert body["country"] == "US"
        assert isinstance(body["data"], list)
        # We seeded SKU-A twice + 1 deleted = 2 visible history rows
        # (history excludes soft-deleted by default).
        assert body["total"] == 2

    def test_history_includes_all_observations(self, client, seeded_project):
        """Unlike current-state, history must include both observations."""
        resp = client.get(_snapshots_url(seeded_project, country="US"))
        body = resp.json()
        skus = [r["sku"] for r in body["data"]]
        # Both BEL-416-A rows present (append-only history)
        assert skus.count("BEL-416-A") == 2
        # Deleted SKU must NOT be present
        assert "BEL-416-DEL" not in skus

    def test_sku_filter(self, client, seeded_project):
        resp = client.get(_snapshots_url(seeded_project, sku="BEL-416-A", country="US"))
        body = resp.json()
        for row in body["data"]:
            assert row["sku"] == "BEL-416-A"

    def test_from_date_filter(self, client, seeded_project):
        """?from= (today - 7d) must exclude the 30-day-old observation."""
        recent = (datetime.now(timezone.utc) - timedelta(days=7)).date().isoformat()
        resp = client.get(
            _snapshots_url(seeded_project, from_date=recent, country="US")
        )
        body = resp.json()
        # Only the recent observation should remain
        assert body["total"] == 1

    def test_to_date_filter(self, client, seeded_project):
        """?to= (today - 7d) must include only the 30-day-old observation."""
        recent = (datetime.now(timezone.utc) - timedelta(days=7)).date().isoformat()
        resp = client.get(_snapshots_url(seeded_project, to_date=recent, country="US"))
        body = resp.json()
        # Only the older observation should remain
        assert body["total"] == 1
