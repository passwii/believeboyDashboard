"""Contract tests for ``GET /external/projects/{id}/return-analysis``.

BEL-374 acceptance — covers:
  * 404 for missing project
  * 400 for missing / invalid period / country / order_by / order_dir
  * 200 + correct shape for valid requests
  * 12-field whitelist enforced (``?order_by=customer_comments`` → 400)
  * Sensitive fields are **never** present in any response
  * risk_level propagates from the snapshot (Wilson 95% lower-bound)
  * ``min_return_rate`` / ``risk_level`` filters

Test isolation: each test that seeds data creates a unique inactive
Project, then teardown deletes every dependent row by FK order
(``analysis_return_aggregates`` → ``analysis_source_files`` →
``projects``).
"""

from __future__ import annotations

from datetime import date, timedelta

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


def _aggregate_url(project_id: int, **params: str) -> str:
    base = f"/api/v1/external/projects/{project_id}/return-analysis"
    qs = "&".join(f"{k}={v}" for k, v in params.items())
    return f"{base}?{qs}" if qs else base


@pytest.fixture()
def seeded_project(db_session: Session):
    """Create a unique inactive project + a few snapshot rows.

    Yields the project_id; teardown deletes everything by FK order.
    """
    from app.models import AnalysisReturnAggregate, Project

    pid_marker = date.today().isoformat()
    project = Project(
        project_name=f"BEL-374 Aggregate Test {pid_marker}",
        sort_order=0,
        is_active=False,
    )
    db_session.add(project)
    db_session.commit()
    db_session.refresh(project)
    pid = project.id

    yesterday = date.today() - timedelta(days=1)
    day_before = date.today() - timedelta(days=2)

    # Two snapshot rows for the same SKU (so per-SKU rollup sums them).
    # SKU-A: 5 returns / 100 sales → Wilson 1.95 → normal.
    db_session.add(
        AnalysisReturnAggregate(
            project_id=pid,
            country="US",
            sku="BEL-374-A",
            data_date=yesterday,
            return_count=3,
            return_quantity=5,
            sales_quantity=100,
            return_rate=5.0,
            cycle_avg_days=10.0,
            cycle_min_days=2,
            cycle_max_days=20,
            reason_top1="NOT_AS_DESCRIBED",
            disposition_top1="SELLABLE",
            dominant_fc_id="PHX6",
            risk_level="normal",
            wilson_lower=1.95,
        )
    )
    db_session.add(
        AnalysisReturnAggregate(
            project_id=pid,
            country="US",
            sku="BEL-374-A",
            data_date=day_before,
            return_count=2,
            return_quantity=5,
            sales_quantity=100,
            return_rate=5.0,
            cycle_avg_days=10.0,
            cycle_min_days=2,
            cycle_max_days=20,
            reason_top1="NOT_AS_DESCRIBED",
            disposition_top1="SELLABLE",
            dominant_fc_id="PHX6",
            risk_level="normal",
            wilson_lower=1.95,
        )
    )

    # SKU-B: 20 returns / 50 sales → Wilson 28.5 → critical.
    db_session.add(
        AnalysisReturnAggregate(
            project_id=pid,
            country="US",
            sku="BEL-374-B",
            data_date=yesterday,
            return_count=10,
            return_quantity=20,
            sales_quantity=50,
            return_rate=40.0,
            cycle_avg_days=5.0,
            cycle_min_days=1,
            cycle_max_days=15,
            reason_top1="DEFECTIVE",
            disposition_top1="DAMAGED",
            dominant_fc_id="BFI4",
            risk_level="critical",
            wilson_lower=28.5,
        )
    )
    # SKU-B same SKU different day (test sum).
    db_session.add(
        AnalysisReturnAggregate(
            project_id=pid,
            country="US",
            sku="BEL-374-B",
            data_date=day_before,
            return_count=5,
            return_quantity=10,
            sales_quantity=50,
            return_rate=20.0,
            cycle_avg_days=6.0,
            cycle_min_days=2,
            cycle_max_days=10,
            reason_top1="DEFECTIVE",
            disposition_top1="DAMAGED",
            dominant_fc_id="BFI4",
            risk_level="critical",
            wilson_lower=15.2,
        )
    )

    # SKU-C: very small sales (5 sales) → no_data (under the 15 threshold).
    db_session.add(
        AnalysisReturnAggregate(
            project_id=pid,
            country="US",
            sku="BEL-374-C",
            data_date=yesterday,
            return_count=2,
            return_quantity=3,
            sales_quantity=5,
            return_rate=60.0,
            reason_top1="OTHER",
            disposition_top1="SELLABLE",
            dominant_fc_id="PHX6",
            risk_level="no_data",
            wilson_lower=0.0,
        )
    )
    db_session.commit()

    try:
        yield pid
    finally:
        db_session.expire_all()
        db_session.execute(
            text("DELETE FROM analysis_return_aggregates WHERE project_id = :pid"),
            {"pid": pid},
        )
        db_session.execute(text("DELETE FROM projects WHERE id = :pid"), {"pid": pid})
        db_session.commit()


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestReturnAnalysisAggregateContract:
    """Basic request/response contract tests."""

    def test_missing_project_returns_404(self, client):
        resp = client.get(_aggregate_url(99999999, period="7d", country="US"))
        assert resp.status_code == 404, resp.text
        assert "not found" in resp.json()["detail"].lower()

    def test_missing_period_returns_400(self, client, seeded_project):
        resp = client.get(_aggregate_url(seeded_project, country="US"))
        assert resp.status_code == 400, resp.text
        assert "period" in resp.json()["detail"].lower()

    def test_unknown_period_returns_400(self, client, seeded_project):
        resp = client.get(_aggregate_url(seeded_project, period="foo", country="US"))
        assert resp.status_code == 400, resp.text
        assert "period must be one of" in resp.json()["detail"].lower()

    def test_missing_country_returns_400(self, client, seeded_project):
        resp = client.get(_aggregate_url(seeded_project, period="7d"))
        assert resp.status_code == 400, resp.text
        assert "country" in resp.json()["detail"].lower()

    def test_invalid_country_returns_400(self, client, seeded_project):
        resp = client.get(_aggregate_url(seeded_project, period="7d", country="ZZ"))
        assert resp.status_code == 400, resp.text

    def test_valid_request_returns_correct_shape(self, client, seeded_project):
        resp = client.get(
            _aggregate_url(
                seeded_project,
                period="7d",
                country="US",
            )
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["project_id"] == seeded_project
        assert body["country"] == "US"
        assert body["period"]["start_date"]
        assert body["period"]["end_date"]
        assert isinstance(body["data"], list)
        assert isinstance(body["summary"], dict)
        # Summary keys (lock contract)
        assert set(body["summary"].keys()) == {
            "total_rows",
            "total_return_count",
            "total_return_quantity",
            "total_sales_quantity",
            "overall_return_rate",
            "overall_risk_level",
            "critical_sku_count",
            "warning_sku_count",
        }

    def test_row_has_13_fields(self, client, seeded_project):
        """12 metrics + sku (group key)."""
        resp = client.get(_aggregate_url(seeded_project, period="7d", country="US"))
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert len(body["data"]) >= 1
        row = body["data"][0]
        expected = {
            "sku",
            "return_count",
            "return_quantity",
            "sales_quantity",
            "return_rate",
            "wilson_lower",
            "cycle_avg_days",
            "cycle_min_days",
            "cycle_max_days",
            "reason_top1",
            "disposition_top1",
            "dominant_fc_id",
            "risk_level",
        }
        assert set(row.keys()) == expected

    def test_sensitive_fields_not_exposed(self, client, seeded_project):
        """customer_comments / raw_row / fnsku / license_plate_number
        must never appear on the aggregate endpoint — defense-in-depth
        alongside the schema."""
        resp = client.get(_aggregate_url(seeded_project, period="7d", country="US"))
        body = resp.json()
        forbidden = {
            "customer_comments",
            "raw_row",
            "fnsku",
            "license_plate_number",
            "estimated_loss_amount",
        }
        for row in body["data"]:
            assert forbidden.isdisjoint(row.keys()), (
                f"row leaked forbidden field: {forbidden & row.keys()}"
            )

    def test_sku_rollup_sums_daily_rows(self, client, seeded_project):
        """SKU-A has 2 daily rows (yesterday + day_before).
        Return quantity should sum (5 + 5 = 10)."""
        resp = client.get(
            _aggregate_url(
                seeded_project,
                period="7d",
                country="US",
                order_by="return_quantity",
                order_dir="desc",
            )
        )
        body = resp.json()
        sku_a = next(r for r in body["data"] if r["sku"] == "BEL-374-A")
        assert sku_a["return_quantity"] == 10
        assert sku_a["return_count"] == 5  # 3 + 2

    def test_worst_risk_level_propagates(self, client, seeded_project):
        """SKU-B is critical on both days → still critical after rollup."""
        resp = client.get(_aggregate_url(seeded_project, period="7d", country="US"))
        body = resp.json()
        sku_b = next(r for r in body["data"] if r["sku"] == "BEL-374-B")
        assert sku_b["risk_level"] == "critical"

    def test_sales_quantity_uses_max_for_cumulative(self, client, seeded_project):
        """BEL-376: snapshot 行 sales_quantity 是 cumulative 的；消费者应取 max 而非 sum。
        固定数据：BEL-374-A 有 2 天 daily snapshot，sales_quantity=100 (cumulative)。
        当前 buggy += 会输出 200；修复后 max 应输出 100。
        """
        resp = client.get(
            _aggregate_url(
                seeded_project,
                period="7d",
                country="US",
                order_by="sku",
                order_dir="asc",
            )
        )
        body = resp.json()
        sku_a = next(r for r in body["data"] if r["sku"] == "BEL-374-A")
        assert sku_a["sales_quantity"] == 100, (
            f"sales_quantity must be max across rows (cumulative), got {sku_a['sales_quantity']}"
        )

    def test_summary_counts_match(self, client, seeded_project):
        resp = client.get(
            _aggregate_url(
                seeded_project,
                period="7d",
                country="US",
                order_by="return_quantity",
                order_dir="desc",
            )
        )
        body = resp.json()
        s = body["summary"]
        # 3 SKUs seeded
        assert s["total_rows"] == 3
        # 2 critical? Only SKU-B → critical; SKU-A → normal; SKU-C → no_data
        assert s["critical_sku_count"] == 1
        assert s["warning_sku_count"] == 0
        # Totals
        assert s["total_return_count"] == 22  # 5 + 17
        assert s["total_return_quantity"] == 43  # 10 + 30 + 3
        # Overall rate
        assert s["overall_return_rate"] > 0


class TestReturnAnalysisAggregateFiltering:
    def test_sku_substring_filter(self, client, seeded_project):
        resp = client.get(
            _aggregate_url(
                seeded_project,
                period="7d",
                country="US",
                sku="BEL-374-B",
            )
        )
        body = resp.json()
        assert resp.status_code == 200
        for row in body["data"]:
            assert "bel-374-b" in row["sku"].lower()

    def test_min_return_rate_filter(self, client, seeded_project):
        resp = client.get(
            _aggregate_url(
                seeded_project,
                period="7d",
                country="US",
                min_return_rate="20.0",
            )
        )
        body = resp.json()
        assert resp.status_code == 200
        for row in body["data"]:
            assert row["return_rate"] >= 20.0

    def test_risk_level_filter(self, client, seeded_project):
        resp = client.get(
            _aggregate_url(
                seeded_project,
                period="7d",
                country="US",
                risk_level="critical",
            )
        )
        body = resp.json()
        assert resp.status_code == 200
        for row in body["data"]:
            assert row["risk_level"] == "critical"

    def test_invalid_risk_level_returns_400(self, client, seeded_project):
        resp = client.get(
            _aggregate_url(
                seeded_project,
                period="7d",
                country="US",
                risk_level="bogus",
            )
        )
        assert resp.status_code == 400, resp.text
        assert "risk_level must be one of" in resp.json()["detail"].lower()

    def test_pagination_limit(self, client, seeded_project):
        resp = client.get(
            _aggregate_url(
                seeded_project,
                period="7d",
                country="US",
                limit="2",
            )
        )
        body = resp.json()
        assert resp.status_code == 200
        assert len(body["data"]) <= 2

    def test_pagination_offset(self, client, seeded_project):
        # Fetch all
        resp_all = client.get(
            _aggregate_url(
                seeded_project,
                period="7d",
                country="US",
                order_by="sku",
                order_dir="asc",
            )
        )
        all_skus = [r["sku"] for r in resp_all.json()["data"]]
        # Fetch with offset=1
        resp_off = client.get(
            _aggregate_url(
                seeded_project,
                period="7d",
                country="US",
                order_by="sku",
                order_dir="asc",
                limit="10",
                offset="1",
            )
        )
        offset_skus = [r["sku"] for r in resp_off.json()["data"]]
        assert offset_skus == all_skus[1:]


class TestReturnAnalysisAggregateWhitelist:
    def test_unknown_order_by_returns_400(self, client, seeded_project):
        resp = client.get(
            _aggregate_url(
                seeded_project,
                period="7d",
                country="US",
                order_by="secret_field",
            )
        )
        assert resp.status_code == 400, resp.text
        assert "order_by must be one of" in resp.json()["detail"].lower()

    def test_sensitive_order_by_returns_400(self, client, seeded_project):
        """``customer_comments`` / ``raw_row`` are NOT in the whitelist."""
        for forbidden in ("customer_comments", "raw_row"):
            resp = client.get(
                _aggregate_url(
                    seeded_project,
                    period="7d",
                    country="US",
                    order_by=forbidden,
                )
            )
            assert resp.status_code == 400, (
                f"order_by={forbidden!r} should 400, got {resp.status_code}"
            )

    def test_invalid_order_dir_returns_400(self, client, seeded_project):
        resp = client.get(
            _aggregate_url(
                seeded_project,
                period="7d",
                country="US",
                order_dir="sideways",
            )
        )
        assert resp.status_code == 422, resp.text

    def test_all_13_whitelisted_order_by_work(self, client, seeded_project):
        """Every field in AGG_SORT_KEYS[AnalysisReturnAggregate] should be
        accepted by the endpoint."""
        from app.api.v1.endpoints.external import _whitelist

        whitelisted = list(
            _whitelist.AGG_SORT_KEYS[_whitelist.AnalysisReturnAggregate].keys()
        )
        assert len(whitelisted) == 13
        for field in whitelisted:
            resp = client.get(
                _aggregate_url(
                    seeded_project,
                    period="7d",
                    country="US",
                    order_by=field,
                    order_dir="asc",
                )
            )
            assert resp.status_code == 200, (
                f"order_by={field!r} should 200, got {resp.status_code}: {resp.text}"
            )
