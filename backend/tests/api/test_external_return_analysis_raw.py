"""Contract tests for ``GET /external/projects/{id}/return-analysis-raw``.

BEL-374 acceptance — covers:
  * 404 for missing project
  * 400 for missing / invalid period / country / order_by / order_dir
  * 200 + correct shape for valid requests
  * 12 whitelisted fields exposed
  * **``customer_comments`` and ``raw_row`` are NEVER returned**
  * ``?order_by=customer_comments`` → 400 (whitelist contract)

Test isolation: same pattern as the aggregate test — unique inactive
project + FK-ordered teardown.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.main import app


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


def _raw_url(project_id: int, **params: str) -> str:
    base = f"/api/v1/external/projects/{project_id}/return-analysis-raw"
    qs = "&".join(f"{k}={v}" for k, v in params.items())
    return f"{base}?{qs}" if qs else base


@pytest.fixture()
def seeded_project(db_session: Session):
    """Create a unique inactive project + a return source + 3 rows.
    One row deliberately carries a ``customer_comments`` value so we
    can prove it never leaks through the endpoint."""
    from app.models import AnalysisReturnRow, AnalysisSourceFile, Project

    pid_marker = date.today().isoformat()
    project = Project(
        project_name=f"BEL-374 Raw Test {pid_marker}",
        sort_order=0,
        is_active=False,
    )
    db_session.add(project)
    db_session.commit()
    db_session.refresh(project)
    pid = project.id

    yesterday = date.today() - timedelta(days=1)
    day_before = date.today() - timedelta(days=2)

    sf = AnalysisSourceFile(
        project_id=pid,
        country="US",
        report_type="return_report",
        upload_file_id=f"test_upload_ret_{pid}",
        upload_file_path="/tmp/test_ret.csv",
        original_filename="test_ret.csv",
        stored_filename="test_ret.csv",
        logical_filename="test_ret.csv",
        storage_key="test_ret.csv",
        period_start_date=day_before,
        period_end_date=yesterday,
        is_current=True,
    )
    db_session.add(sf)
    db_session.commit()
    db_session.refresh(sf)

    # Seed 3 rows: deliberately include customer_comments / raw_row
    # values that MUST NOT appear in any endpoint response.
    test_payloads = [
        {
            "source_row_no": 1,
            "return_date": yesterday,
            "order_id": "O-1",
            "sku": "BEL-374-RAW-A",
            "asin": "B111",
            "product_name": "Product A",
            "quantity": 2,
            "fulfillment_center_id": "PHX6",
            "detailed_disposition": "SELLABLE",
            "reason": "NOT_AS_DESCRIBED",
            "status": "PROCESSED",
            "license_plate_number": "LP001",
            "original_return_datetime": yesterday.isoformat() + "T10:00:00+00:00",
            "customer_comments": "SECRET: very angry customer, wants refund",
            "raw_row": {"SECRET_RAW": "do not leak", "extra": "data"},
        },
        {
            "source_row_no": 2,
            "return_date": yesterday,
            "order_id": "O-2",
            "sku": "BEL-374-RAW-B",
            "asin": "B222",
            "product_name": "Product B",
            "quantity": 1,
            "fulfillment_center_id": "BFI4",
            "detailed_disposition": "DAMAGED",
            "reason": "DEFECTIVE",
            "status": "PROCESSED",
            "license_plate_number": "LP002",
            "original_return_datetime": yesterday.isoformat() + "T11:00:00+00:00",
            "customer_comments": "SECRET: item arrived broken",
            "raw_row": {"SECRET_RAW": "x"},
        },
        {
            "source_row_no": 3,
            "return_date": day_before,
            "order_id": "O-3",
            "sku": "BEL-374-RAW-C",
            "asin": "B333",
            "product_name": "Product C",
            "quantity": 3,
            "fulfillment_center_id": "PHX6",
            "detailed_disposition": "SELLABLE",
            "reason": "OTHER",
            "status": "PROCESSED",
            "license_plate_number": "LP003",
            "original_return_datetime": day_before.isoformat() + "T09:00:00+00:00",
            "customer_comments": None,
            "raw_row": {},
        },
    ]
    for kwargs in test_payloads:
        db_session.add(
            AnalysisReturnRow(
                project_id=pid, country="US", source_file_id=sf.id, **kwargs
            )
        )
    db_session.commit()

    try:
        yield pid
    finally:
        db_session.expire_all()
        db_session.execute(
            text("DELETE FROM analysis_return_rows WHERE project_id = :pid"),
            {"pid": pid},
        )
        db_session.execute(
            text("DELETE FROM analysis_source_files WHERE project_id = :pid"),
            {"pid": pid},
        )
        db_session.execute(text("DELETE FROM projects WHERE id = :pid"), {"pid": pid})
        db_session.commit()


class TestReturnAnalysisRawContract:
    def test_missing_project_returns_404(self, client):
        resp = client.get(_raw_url(99999999, period="7d", country="US"))
        assert resp.status_code == 404, resp.text
        assert "not found" in resp.json()["detail"].lower()

    def test_missing_period_returns_400(self, client, seeded_project):
        resp = client.get(_raw_url(seeded_project, country="US"))
        assert resp.status_code == 400, resp.text
        assert "period" in resp.json()["detail"].lower()

    def test_unknown_period_returns_400(self, client, seeded_project):
        resp = client.get(_raw_url(seeded_project, period="foo", country="US"))
        assert resp.status_code == 400, resp.text

    def test_missing_country_returns_400(self, client, seeded_project):
        resp = client.get(_raw_url(seeded_project, period="7d"))
        assert resp.status_code == 400, resp.text

    def test_invalid_country_returns_400(self, client, seeded_project):
        resp = client.get(_raw_url(seeded_project, period="7d", country="ZZ"))
        assert resp.status_code == 400, resp.text

    def test_valid_request_returns_correct_shape(self, client, seeded_project):
        resp = client.get(_raw_url(seeded_project, period="7d", country="US"))
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["project_id"] == seeded_project
        assert body["country"] == "US"
        assert body["period"]["start_date"]
        assert body["period"]["end_date"]
        assert isinstance(body["data"], list)
        assert isinstance(body["summary"], dict)
        # summary keys (lock contract)
        assert set(body["summary"].keys()) == {"total_rows", "date_range"}

    def test_row_has_exactly_12_fields(self, client, seeded_project):
        """12 whitelisted fields only — defense-in-depth via schema."""
        resp = client.get(_raw_url(seeded_project, period="7d", country="US"))
        body = resp.json()
        assert len(body["data"]) == 3
        expected = {
            "id",
            "return_date",
            "order_id",
            "sku",
            "asin",
            "product_name",
            "quantity",
            "fulfillment_center_id",
            "detailed_disposition",
            "reason",
            "status",
            "original_return_datetime",
        }
        for row in body["data"]:
            assert set(row.keys()) == expected

    def test_customer_comments_never_returned(self, client, seeded_project):
        """Even though the seeded rows carry customer_comments values,
        the endpoint must strip them. This is the load-bearing guarantee
        of the raw endpoint."""
        resp = client.get(_raw_url(seeded_project, period="7d", country="US"))
        body = resp.json()
        for row in body["data"]:
            assert "customer_comments" not in row, (
                f"row leaked customer_comments: {row}"
            )

    def test_raw_row_never_returned(self, client, seeded_project):
        resp = client.get(_raw_url(seeded_project, period="7d", country="US"))
        body = resp.json()
        for row in body["data"]:
            assert "raw_row" not in row

    def test_fnsku_never_returned(self, client, seeded_project):
        """Internal Amazon identifier — trimmed from surface."""
        resp = client.get(_raw_url(seeded_project, period="7d", country="US"))
        body = resp.json()
        for row in body["data"]:
            assert "fnsku" not in row

    def test_license_plate_number_never_returned(self, client, seeded_project):
        resp = client.get(_raw_url(seeded_project, period="7d", country="US"))
        body = resp.json()
        for row in body["data"]:
            assert "license_plate_number" not in row

    def test_summary_date_range_populated(self, client, seeded_project):
        resp = client.get(_raw_url(seeded_project, period="7d", country="US"))
        body = resp.json()
        assert body["summary"]["total_rows"] == 3
        assert len(body["summary"]["date_range"]) == 2
        # date_range should reflect actual data span
        from datetime import date as _date

        start = _date.fromisoformat(body["summary"]["date_range"][0])
        end = _date.fromisoformat(body["summary"]["date_range"][1])
        assert start <= end


class TestReturnAnalysisRawWhitelist:
    def test_unknown_order_by_returns_400(self, client, seeded_project):
        resp = client.get(
            _raw_url(
                seeded_project,
                period="7d",
                country="US",
                order_by="secret_field",
            )
        )
        assert resp.status_code == 400, resp.text
        assert "order_by must be one of" in resp.json()["detail"].lower()

    def test_sensitive_order_by_returns_400(self, client, seeded_project):
        for forbidden in ("customer_comments", "raw_row", "fnsku"):
            resp = client.get(
                _raw_url(
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
            _raw_url(
                seeded_project,
                period="7d",
                country="US",
                order_dir="sideways",
            )
        )
        assert resp.status_code == 422, resp.text

    def test_all_12_whitelisted_order_by_work(self, client, seeded_project):
        from app.api.v1.endpoints.external import _whitelist
        from app.models import AnalysisReturnRow

        whitelisted = list(_whitelist.ROW_WHITELIST[AnalysisReturnRow].keys())
        assert len(whitelisted) == 12
        for field in whitelisted:
            resp = client.get(
                _raw_url(
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

    def test_pagination_limit(self, client, seeded_project):
        resp = client.get(
            _raw_url(
                seeded_project,
                period="7d",
                country="US",
                limit="1",
            )
        )
        body = resp.json()
        assert resp.status_code == 200
        assert len(body["data"]) == 1

    def test_pagination_offset(self, client, seeded_project):
        resp_a = client.get(
            _raw_url(
                seeded_project,
                period="7d",
                country="US",
                order_by="id",
                order_dir="asc",
            )
        )
        ids_all = [r["id"] for r in resp_a.json()["data"]]
        resp_b = client.get(
            _raw_url(
                seeded_project,
                period="7d",
                country="US",
                order_by="id",
                order_dir="asc",
                limit="10",
                offset="1",
            )
        )
        ids_offset = [r["id"] for r in resp_b.json()["data"]]
        assert ids_offset == ids_all[1:]


class TestReturnAnalysisRawCustomPeriod:
    def test_custom_period(self, client, seeded_project):
        today = date.today()
        start = (today - timedelta(days=3)).isoformat()
        end = today.isoformat()
        resp = client.get(
            _raw_url(
                seeded_project,
                period="custom",
                start_date=start,
                end_date=end,
                country="US",
            )
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["period"]["type"] == "custom"
        assert body["period"]["start_date"] == start
        assert body["period"]["end_date"] == end

    def test_custom_period_missing_dates_returns_400(self, client, seeded_project):
        resp = client.get(_raw_url(seeded_project, period="custom", country="US"))
        assert resp.status_code == 400, resp.text
        assert "start_date" in resp.json()["detail"].lower()
