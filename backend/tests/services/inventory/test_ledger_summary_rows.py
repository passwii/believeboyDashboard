"""Tests for ``get_ledger_summary_rows`` + ``GET /summary`` (BLF-428 前端重构).

The Summary view is the truth source: 1 row = 1 (FNSKU × FC × Disposition ×
Date) daily water-level snapshot (sparse ledger). These tests cover:

* service-level filters (msku / location / disposition) + date-desc ordering
* the agent 镜像端点契约（BLF-459 V3 起 /external/* 已下线，走 /agent/*）

Test isolation mirrors ``test_ledger_consistency.py``: unique project per
test, teardown deletes every ledger row for it.
"""

from __future__ import annotations

import uuid
from datetime import date

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.main import app
from app.db.session import SessionLocal
from app.models import Project
from app.services.inventory.ledger import (
    get_ledger_summary_rows,
    ingest_ledger_csv,
)

_SUMMARY_HEADER = (
    "Date,FNSKU,ASIN,MSKU,Title,Disposition,Starting Warehouse Balance,"
    "In Transit Between Warehouses,Receipts,Customer Shipments,Customer Returns,"
    "Vendor Returns,Warehouse Transfer In/Out,Found,Lost,Damaged,Disposed,"
    "Other Events,Ending Warehouse Balance,Unknown Events,Location,Store"
)


def _summary_csv(rows: list[str]) -> str:
    return _SUMMARY_HEADER + "\n" + "\n".join(rows) + "\n"


def _summary_row(
    day: str,
    msku: str,
    starting: int,
    ending: int,
    location: str = "LAX1",
    disposition: str = "SELLABLE",
    receipts: int = 0,
    shipments: int = 0,
) -> str:
    return (
        f"{day},FN-{msku},B-{msku},{msku},Item {msku},{disposition},{starting},"
        f"0,{receipts},{shipments},0,0,0,0,0,0,0,0,{ending},0,{location},TestStore"
    )


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture
def project(db_session: Session):
    p = Project(
        project_name=f"blf428-summary-rows-{uuid.uuid4().hex[:8]}",
        sort_order=999_999,
        is_active=True,
    )
    db_session.add(p)
    db_session.flush()
    yield p
    db_session.execute(
        text("DELETE FROM inventory_ledger_detail WHERE project_id = :pid"),
        {"pid": p.id},
    )
    db_session.execute(
        text("DELETE FROM inventory_ledger_summary WHERE project_id = :pid"),
        {"pid": p.id},
    )
    db_session.execute(
        text("DELETE FROM inventory_ledger_ingest_batch WHERE project_id = :pid"),
        {"pid": p.id},
    )
    db_session.rollback()


def _ingest(db: Session, project_id: int, csv: str, filename: str) -> None:
    ingest_ledger_csv(db, project_id=project_id, csv_content=csv, filename=filename)
    db.commit()


def _seed_three_rows(db: Session, project_id: int) -> None:
    """2 SKUs × 2 locations × mixed dispositions across 2 days."""
    _ingest(
        db,
        project_id,
        _summary_csv(
            [
                _summary_row("03/01/2026", "SKU-A", 50, 45, location="LAX1"),
                _summary_row("03/02/2026", "SKU-A", 45, 40, location="LAX1"),
                _summary_row(
                    "03/02/2026",
                    "SKU-A",
                    5,
                    5,
                    location="SCK8",
                    disposition="CUSTOMER_DAMAGED",
                ),
                _summary_row(
                    "03/01/2026", "SKU-B", 10, 12, location="SCK8", receipts=2
                ),
            ]
        ),
        "库存分类账 2026-0301-0331.csv",
    )


# ---------------------------------------------------------------------------
# Service level
# ---------------------------------------------------------------------------


class TestGetLedgerSummaryRows:
    def test_no_data_returns_empty(self, db_session: Session, project: Project):
        rows = get_ledger_summary_rows(
            db_session, project.id, date(2026, 3, 1), date(2026, 3, 31)
        )
        assert rows == []

    def test_returns_all_rows_date_desc(self, db_session: Session, project: Project):
        _seed_three_rows(db_session, project.id)
        rows = get_ledger_summary_rows(
            db_session, project.id, date(2026, 3, 1), date(2026, 3, 31)
        )
        assert len(rows) == 4
        # newest first
        assert rows[0].date >= rows[-1].date
        # water-level columns round-trip
        sku_a_lax1_0302 = next(
            r
            for r in rows
            if r.msku == "SKU-A" and r.location == "LAX1" and r.date == date(2026, 3, 2)
        )
        assert sku_a_lax1_0302.starting_balance == 45
        assert sku_a_lax1_0302.ending_balance == 40

    def test_msku_filter(self, db_session: Session, project: Project):
        _seed_three_rows(db_session, project.id)
        rows = get_ledger_summary_rows(
            db_session,
            project.id,
            date(2026, 3, 1),
            date(2026, 3, 31),
            msku="SKU-A",
        )
        assert len(rows) == 3
        assert {r.msku for r in rows} == {"SKU-A"}

    def test_location_filter(self, db_session: Session, project: Project):
        _seed_three_rows(db_session, project.id)
        rows = get_ledger_summary_rows(
            db_session,
            project.id,
            date(2026, 3, 1),
            date(2026, 3, 31),
            location="SCK8",
        )
        assert len(rows) == 2
        assert {r.location for r in rows} == {"SCK8"}

    def test_disposition_filter(self, db_session: Session, project: Project):
        _seed_three_rows(db_session, project.id)
        rows = get_ledger_summary_rows(
            db_session,
            project.id,
            date(2026, 3, 1),
            date(2026, 3, 31),
            disposition="CUSTOMER_DAMAGED",
        )
        assert len(rows) == 1
        assert rows[0].disposition == "CUSTOMER_DAMAGED"
        assert rows[0].msku == "SKU-A"

    def test_date_window_excludes_out_of_range(
        self, db_session: Session, project: Project
    ):
        _seed_three_rows(db_session, project.id)
        rows = get_ledger_summary_rows(
            db_session, project.id, date(2026, 3, 2), date(2026, 3, 2)
        )
        assert {r.date for r in rows} == {date(2026, 3, 2)}
        assert len(rows) == 2


# ---------------------------------------------------------------------------
# Agent 镜像端点契约（BLF-459 V3：/external/* 已 410 下线，走 /agent/*）
# ---------------------------------------------------------------------------


class TestAgentSummaryEndpoint:
    """agent 镜像的 inventory-ledger/summary（V3 起 /external/* 已下线）。"""

    def _url(self, project_id: int, **params: str) -> str:
        base = f"/api/v1/agent/projects/{project_id}/inventory-ledger/summary"
        qs = "&".join(f"{k}={v}" for k, v in params.items())
        return f"{base}?{qs}" if qs else base

    def test_missing_period_422(self, client: TestClient, project: Project):
        # agent 命名空间强制鉴权，未带凭据先 401（与 external 的 422 不同）。
        res = client.get(self._url(project.id))
        assert res.status_code == 401

    def test_empty_period_400(
        self, client: TestClient, db_session: Session, project: Project
    ):
        from app.services.agent import key_service

        # 项目 fixture 默认只 flush 不 commit；本路由原生化后（BLF-582）对
        # 不存在的项目返回 404（项目存在性检查），先 commit 保证项目真实存在
        # （否则 400 语义被 404 覆盖）。
        db_session.commit()
        db = SessionLocal()
        try:
            _, plaintext = key_service.create_api_key(
                db,
                label="blf459-ledger-test",
                created_by="pytest",
                agent_id="blf459-ledger-400",
                project_scope=str(project.id),
            )
            db.commit()
        finally:
            db.close()
        headers = {
            "Authorization": f"Bearer {plaintext}",
            "X-Agent-Id": "blf459-ledger-400",
        }
        res = client.get(self._url(project.id, period=""), headers=headers)
        assert res.status_code == 400

    def test_shape_and_filters(
        self, client: TestClient, db_session: Session, project: Project
    ):
        from app.services.agent import key_service

        _seed_three_rows(db_session, project.id)
        db = SessionLocal()
        try:
            _, plaintext = key_service.create_api_key(
                db,
                label="blf459-ledger-test",
                created_by="pytest",
                agent_id="blf459-ledger",
                project_scope=str(project.id),
            )
            db.commit()
        finally:
            db.close()
        headers = {
            "Authorization": f"Bearer {plaintext}",
            "X-Agent-Id": "blf459-ledger",
        }

        res = client.get(self._url(project.id, period="2026-03"), headers=headers)
        assert res.status_code == 200
        body = res.json()
        assert body["ok"] is True
        data = body["data"]
        assert data["report_month"] == "2026-03-01"
        assert len(data["rows"]) == 4
        row = data["rows"][0]
        for col in (
            "date",
            "msku",
            "location",
            "disposition",
            "starting_balance",
            "ending_balance",
            "receipts",
            "customer_shipments",
            "warehouse_transfer_io",
            "batch_id",
        ):
            assert col in row

        # msku + location filters compose
        res2 = client.get(
            self._url(project.id, period="2026-03", msku="SKU-A", location="LAX1"),
            headers=headers,
        )
        rows2 = res2.json()["data"]["rows"]
        assert len(rows2) == 2
        assert all(r["msku"] == "SKU-A" and r["location"] == "LAX1" for r in rows2)


# ---------------------------------------------------------------------------
# Service-level country filter（BLF-957）
# ---------------------------------------------------------------------------


class TestSummaryCountryFilter:
    """Summary 表无 country 列 → 通过 Project.country 门过滤（BLF-952）。"""

    def test_country_mismatch_returns_empty(
        self, db_session: Session, project: Project
    ):
        """Project.country 默认 US，请求 DE → get_ledger_summary_rows 应空。"""
        _seed_three_rows(db_session, project.id)
        rows = get_ledger_summary_rows(
            db_session, project.id, date(2026, 3, 1), date(2026, 3, 31), country="DE"
        )
        assert rows == []

    def test_country_match_returns_all(
        self, db_session: Session, project: Project
    ):
        """Project.country 默认 US，请求 US → 返回全部 seed 行。"""
        _seed_three_rows(db_session, project.id)
        rows = get_ledger_summary_rows(
            db_session, project.id, date(2026, 3, 1), date(2026, 3, 31), country="US"
        )
        assert len(rows) == 4
