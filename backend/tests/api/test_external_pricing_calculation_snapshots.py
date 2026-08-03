"""Contract tests for BEL-416 Pricing Snapshot external endpoint.

Covers:

* 404 for missing project / missing snapshot
* 400 for malformed as_of date / invalid country
* 200 + correct shape when as_of picks an existing snapshot
* as_of boundary (exact match + before/after)
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


def _pricing_url(project_id: int, **params: str) -> str:
    base = f"/api/v1/external/projects/{project_id}/pricing-snapshots"
    qs = "&".join(f"{k}={v}" for k, v in params.items())
    return f"{base}?{qs}" if qs else base


def _seed_snapshot(
    db_session: Session,
    *,
    project_id: int,
    project_name: str,
    country: str,
    snapshot_date: datetime,
    skus: list[str] | None = None,
) -> int:
    """Create a PricingCalculationSnapshot + a few items. Returns id."""
    from app.models import PricingCalculationSnapshot, PricingCalculationSnapshotItem

    snap = PricingCalculationSnapshot(
        project_id=project_id,
        project_name=project_name,
        country=country,
        snapshot_date=snapshot_date,
        name=f"snap-{snapshot_date.date().isoformat()}",
        description=None,
        summary_json={"total": 1, "calculated": 1, "profitable": 1, "passRate": 100.0},
        row_count=1,
        created_by=None,
    )
    db_session.add(snap)
    db_session.flush()

    if skus is None:
        skus = ["BEL-416-SKU-1"]
    for idx, sku in enumerate(skus):
        item = PricingCalculationSnapshotItem(
            snapshot_id=snap.id,
            source_row_no=idx,
            project_id=project_id,
            project_name=project_name,
            sku=sku,
            asin=f"B{abs(hash(sku)) % (10**10):010d}",
            country=country,
            calculation_type="profit_calc",
            package_length_cm=10.0,
            package_width_cm=8.0,
            package_height_cm=5.0,
            weight_kg=0.5,
            fob_product_cost_rmb=20.0,
            first_leg_cost_rmb=5.0,
            ddp_cost_rmb=30.0,
            ddp_cost_usd=4.2,
            sale_price_usd=19.99,
            target_profit_rate=None,
            advertising_rate=0.12,
            return_loss_rate=0.04,
            storage_months=1.0,
            inbound_placement_mode="single_destination",
            usd_to_rmb_rate=7.2,
            usd_to_rmb_rate_source="manual",
            size_tier="standard",
            size_tier_label="标准",
            price_band="mid",
            price_band_label="中端",
            longest_side_in=4.0,
            middle_side_in=3.0,
            shortest_side_in=2.0,
            length_plus_girth_in=14.0,
            volume_cubic_in=24.0,
            volume_cubic_ft=0.014,
            product_weight_lb=1.0,
            product_weight_oz=16.0,
            dimensional_weight_lb=0.8,
            chargeable_weight_lb=1.0,
            chargeable_weight_oz=16.0,
            chargeable_weight_rule="actual",
            fulfillment_fee_rule_label="rule",
            inbound_config_fee_rule_label="rule",
            storage_fee_rule_label="rule",
            referral_fee_usd=3.0,
            advertising_fee_usd=2.4,
            return_loss_usd=0.8,
            fba_fulfillment_fee_usd=3.5,
            inbound_config_fee_usd=0.3,
            storage_fee_usd=0.2,
            total_fee_usd=10.2,
            platform_fee_usd=0.0,
            delivery_fee_usd=0.0,
            inbound_config_fee_manual_usd=0.0,
            storage_fee_manual_usd=0.0,
            payout_usd=15.0,
            profit_usd=4.8,
            profit_rate=0.24,
            vat_usd=0.0,
            profit_after_vat_usd=None,
            profit_after_vat_rate=None,
            warnings_json=None,
            notes=None,
        )
        db_session.add(item)
    db_session.commit()
    db_session.refresh(snap)
    return snap.id


@pytest.fixture()
def seeded_project(db_session: Session):
    """Create a unique inactive project + 3 PricingCalculationSnapshot rows:

    - 2026-01-01 (older)
    - 2026-06-01 (middle)
    - 2026-08-01 (newest)
    """
    from app.models import Project

    marker = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    project = Project(
        project_name=f"BEL-416 Snap Test {marker}",
        sort_order=0,
        is_active=False,
    )
    db_session.add(project)
    db_session.commit()
    db_session.refresh(project)
    pid = project.id
    pname = project.project_name

    older_id = _seed_snapshot(
        db_session,
        project_id=pid,
        project_name=pname,
        country="US",
        snapshot_date=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )
    middle_id = _seed_snapshot(
        db_session,
        project_id=pid,
        project_name=pname,
        country="US",
        snapshot_date=datetime(2026, 6, 1, tzinfo=timezone.utc),
    )
    newest_id = _seed_snapshot(
        db_session,
        project_id=pid,
        project_name=pname,
        country="US",
        snapshot_date=datetime(2026, 8, 1, tzinfo=timezone.utc),
    )

    try:
        yield {
            "project_id": pid,
            "older_id": older_id,
            "middle_id": middle_id,
            "newest_id": newest_id,
        }
    finally:
        db_session.expire_all()
        db_session.execute(
            text(
                "DELETE FROM pricing_calculation_snapshot_items WHERE project_id = :pid"
            ),
            {"pid": pid},
        )
        db_session.execute(
            text("DELETE FROM pricing_calculation_snapshots WHERE project_id = :pid"),
            {"pid": pid},
        )
        db_session.execute(text("DELETE FROM projects WHERE id = :pid"), {"pid": pid})
        db_session.commit()


# ---------------------------------------------------------------------------
# /pricing-snapshots tests
# ---------------------------------------------------------------------------


class TestPricingSnapshotAsOfContract:
    def test_missing_project_returns_404(self, client):
        resp = client.get(_pricing_url(99999999, as_of="2026-06-01"))
        assert resp.status_code == 404, resp.text

    def test_missing_snapshot_returns_404(self, client, seeded_project):
        pid = seeded_project["project_id"]
        # Project has snapshots through 2026-08-01; use an as_of that is
        # *strictly before* the oldest (2026-01-01) — no qualifying snap.
        resp = client.get(_pricing_url(pid, as_of="2025-12-31"))
        assert resp.status_code == 404, resp.text
        assert "no pricing snapshot" in resp.json()["detail"].lower()

    def test_malformed_as_of_returns_400(self, client, seeded_project):
        pid = seeded_project["project_id"]
        resp = client.get(_pricing_url(pid, as_of="not-a-date"))
        assert resp.status_code == 400, resp.text

    def test_invalid_country_returns_400(self, client, seeded_project):
        pid = seeded_project["project_id"]
        resp = client.get(_pricing_url(pid, as_of="2026-06-01", country="ZZ"))
        assert resp.status_code == 400, resp.text

    def test_valid_request_returns_200_with_correct_shape(self, client, seeded_project):
        pid = seeded_project["project_id"]
        resp = client.get(_pricing_url(pid, as_of="2026-06-15"))
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["project_id"] == pid
        assert body["country"] == "US"
        assert body["to_date"] == "2026-06-15"
        assert isinstance(body["data"], list)
        assert body["total"] == 1  # one item per snapshot

    def test_row_has_16_fields(self, client, seeded_project):
        pid = seeded_project["project_id"]
        resp = client.get(_pricing_url(pid, as_of="2026-06-15"))
        body = resp.json()
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
        assert set(row.keys()) == expected

    def test_sensitive_fields_not_exposed(self, client, seeded_project):
        pid = seeded_project["project_id"]
        resp = client.get(_pricing_url(pid, as_of="2026-06-15"))
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


class TestPricingSnapshotAsOfBoundary:
    """as_of semantics: pick the latest snapshot with snapshot_date <= as_of."""

    def test_as_of_before_oldest_returns_404(self, client, seeded_project):
        pid = seeded_project["project_id"]
        # as_of = 2025-12-31, oldest snapshot is 2026-01-01 → 404
        resp = client.get(_pricing_url(pid, as_of="2025-12-31"))
        assert resp.status_code == 404, resp.text

    def test_as_of_exact_match_picks_snapshot(self, client, seeded_project):
        pid = seeded_project["project_id"]
        # as_of = 2026-01-01 (exact match for oldest)
        resp = client.get(_pricing_url(pid, as_of="2026-01-01"))
        assert resp.status_code == 200, resp.text
        # Items have synthetic ids = snapshot_id * 1_000_000 + source_row_no
        row = resp.json()["data"][0]
        synthetic_id = row["id"]
        # synthetic_id should be in [older_id*1M, middle_id*1M)
        older = seeded_project["older_id"]
        middle = seeded_project["middle_id"]
        assert older * 1_000_000 <= synthetic_id < middle * 1_000_000

    def test_as_of_picks_latest_among_qualifying(self, client, seeded_project):
        pid = seeded_project["project_id"]
        # as_of = 2026-07-15 → between middle (2026-06-01) and newest (2026-08-01)
        # Should pick the middle snapshot.
        resp = client.get(_pricing_url(pid, as_of="2026-07-15"))
        assert resp.status_code == 200, resp.text
        row = resp.json()["data"][0]
        middle = seeded_project["middle_id"]
        assert middle * 1_000_000 <= row["id"] < middle * 1_000_001 + 100

    def test_as_of_after_all_picks_newest(self, client, seeded_project):
        pid = seeded_project["project_id"]
        resp = client.get(_pricing_url(pid, as_of="2099-01-01"))
        # Wait — this is "after all", should pick newest (NOT 404)
        # Actually no — we seeded through 2026-08-01, so as_of=2099 should
        # match newest. Let me check the seeded_project — only 3 snapshots.
        assert resp.status_code == 200, resp.text
        row = resp.json()["data"][0]
        newest = seeded_project["newest_id"]
        assert newest * 1_000_000 <= row["id"] < newest * 1_000_001 + 100

    def test_omitted_as_of_returns_newest(self, client, seeded_project):
        pid = seeded_project["project_id"]
        resp = client.get(_pricing_url(pid))
        assert resp.status_code == 200, resp.text
        row = resp.json()["data"][0]
        newest = seeded_project["newest_id"]
        assert newest * 1_000_000 <= row["id"] < newest * 1_000_001 + 100
