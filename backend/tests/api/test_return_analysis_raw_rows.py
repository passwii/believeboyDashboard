"""内部退货分析原始行端点测试（GET /api/v1/return-analysis/raw-rows）。

口径（spec §1.1/§2）：只回当前生效（is_current）退货报表源文件下、
return_date 落在所选周期内的行；带中文翻译列；超上限显式 400 不静默截断。

种子数据统一走 ``return_row_factories``（与服务层测试共用一份，防漂移）。
"""

from __future__ import annotations

import uuid
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from return_row_factories import (
    default_return_window,
    purge_project_return_data,
    seed_return_row,
    seed_return_source,
)

from app.db.session import SessionLocal
from app.main import app


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture
def db_session():
    """提交型会话：工厂内部 commit，端点走的是自己的会话，必须彼此可见。"""
    session = SessionLocal()
    try:
        yield session
    finally:
        session.rollback()
        session.close()


@pytest.fixture
def project_id(db_session):
    """独占测试项目 + 显式 teardown（competing 会话/历史数据不干扰断言）。"""
    from app.models import Project

    project = Project(
        project_name=f"raw-rows-api {uuid.uuid4().hex[:8]}",
        sort_order=0,
        is_active=False,
    )
    db_session.add(project)
    db_session.commit()
    db_session.refresh(project)
    pid = project.id

    yield pid

    purge_project_return_data(db_session, pid)


def _qs(project_id: int, **extra) -> str:
    start, end = default_return_window()
    parts = [
        f"project_id={project_id}",
        "country=US",
        f"start_date={start}",
        f"end_date={end}",
    ]
    parts += [f"{k}={v}" for k, v in extra.items()]
    return "/api/v1/return-analysis/raw-rows?" + "&".join(parts)


class TestRawRowsEndpoint:
    def test_returns_rows_with_display_fields(
        self, client, project_id, db_session, admin_headers
    ):
        """基线：字段齐全 + 三个中文翻译列与分析页同源。"""
        d = date.today() - timedelta(days=1)
        sf = seed_return_source(db_session, project_id, tag="base")
        seed_return_row(
            db_session,
            source_file_id=sf.id,
            project_id=project_id,
            order_id="O-1",
            sku="S-1",
            return_date=d,
            license_plate="LP-1",
            row_no=1,
            asin="B01",
            fnsku="X01",
            product_name="测试商品",
            fulfillment_center_id="PGA1",
            customer_comments="质量差",
        )

        resp = client.get(_qs(project_id), headers=admin_headers)

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["project_id"] == project_id
        assert body["country"] == "US"
        assert body["row_count"] == 1
        assert body["start_date"] == default_return_window()[0]
        assert body["end_date"] == default_return_window()[1]
        row = body["rows"][0]
        assert row["order_id"] == "O-1"
        assert row["sku"] == "S-1"
        assert row["asin"] == "B01"
        assert row["fnsku"] == "X01"
        assert row["product_name"] == "测试商品"
        assert row["quantity"] == 1
        assert row["fulfillment_center_id"] == "PGA1"
        assert row["license_plate_number"] == "LP-1"
        assert row["customer_comment"] == "质量差"
        assert row["return_date"] == d.isoformat()
        assert row["original_return_datetime"].startswith(d.isoformat())
        # 中文翻译列（与 translate_return_field 同源）
        assert row["reason"] == "NOT_AS_DESCRIBED"
        assert row["reason_display"] == "与描述不符"
        assert row["detailed_disposition"] == "SELLABLE"
        assert row["disposition_display"] == "可售"
        assert row["status_display"] == "退回库存"

    def test_excludes_non_current_source_file(
        self, client, project_id, db_session, admin_headers
    ):
        """旧版本源文件（is_current=False）的行不得出现。"""
        d = date.today() - timedelta(days=1)
        current = seed_return_source(
            db_session, project_id, tag="cur", is_current=True, version=1
        )
        stale = seed_return_source(
            db_session, project_id, tag="old", is_current=False, version=2
        )
        seed_return_row(
            db_session, source_file_id=current.id, project_id=project_id,
            order_id="O-CUR", sku="S-1", return_date=d,
            license_plate="LP-CUR", row_no=1,
        )
        seed_return_row(
            db_session, source_file_id=stale.id, project_id=project_id,
            order_id="O-OLD", sku="S-1", return_date=d,
            license_plate="LP-OLD", row_no=1,
        )

        body = client.get(_qs(project_id), headers=admin_headers).json()

        assert [r["order_id"] for r in body["rows"]] == ["O-CUR"]

    def test_excludes_out_of_range(self, client, project_id, db_session, admin_headers):
        start, end = default_return_window()
        d = date.today() - timedelta(days=1)
        sf = seed_return_source(db_session, project_id, tag="range")
        seed_return_row(
            db_session, source_file_id=sf.id, project_id=project_id,
            order_id="O-IN", sku="S-1", return_date=d,
            license_plate="LP-IN", row_no=1,
        )
        seed_return_row(
            db_session, source_file_id=sf.id, project_id=project_id,
            order_id="O-BEFORE", sku="S-1",
            return_date=date.fromisoformat(start) - timedelta(days=1),
            license_plate="LP-B", row_no=2,
        )
        seed_return_row(
            db_session, source_file_id=sf.id, project_id=project_id,
            order_id="O-AFTER", sku="S-1",
            return_date=date.fromisoformat(end) + timedelta(days=1),
            license_plate="LP-A", row_no=3,
        )

        body = client.get(_qs(project_id), headers=admin_headers).json()

        assert [r["order_id"] for r in body["rows"]] == ["O-IN"]

    def test_sku_filter(self, client, project_id, db_session, admin_headers):
        d = date.today() - timedelta(days=1)
        sf = seed_return_source(db_session, project_id, tag="sku")
        seed_return_row(
            db_session, source_file_id=sf.id, project_id=project_id,
            order_id="O-A", sku="SKU-A", return_date=d,
            license_plate="LP-A", row_no=1,
        )
        seed_return_row(
            db_session, source_file_id=sf.id, project_id=project_id,
            order_id="O-B", sku="SKU-B", return_date=d,
            license_plate="LP-B", row_no=2,
        )

        filtered = client.get(_qs(project_id, sku="SKU-A"), headers=admin_headers).json()
        everything = client.get(_qs(project_id), headers=admin_headers).json()

        assert [r["order_id"] for r in filtered["rows"]] == ["O-A"]
        assert filtered["row_count"] == 1
        assert everything["row_count"] == 2

    def test_ordering_is_return_date_then_id(
        self, client, project_id, db_session, admin_headers
    ):
        end_date = date.today() - timedelta(days=1)
        earlier = end_date - timedelta(days=1)
        sf = seed_return_source(db_session, project_id, tag="ord")
        seed_return_row(
            db_session, source_file_id=sf.id, project_id=project_id,
            order_id="O-LATE", sku="S-1", return_date=end_date,
            license_plate="LP-L", row_no=1,
        )
        seed_return_row(
            db_session, source_file_id=sf.id, project_id=project_id,
            order_id="O-EARLY", sku="S-1", return_date=earlier,
            license_plate="LP-E", row_no=2,
        )

        body = client.get(_qs(project_id), headers=admin_headers).json()

        assert [r["order_id"] for r in body["rows"]] == ["O-EARLY", "O-LATE"]

    def test_sum_matches_analysis_total_quantity(
        self, client, project_id, db_session, admin_headers
    ):
        """对账：端点 quantity 合计 == 分析 summary.total_quantity（跨层锁口径）。"""
        from app.services.analysis.return_analysis import build_return_analysis

        d = date.today() - timedelta(days=1)
        sf = seed_return_source(db_session, project_id, tag="parity")
        seed_return_row(
            db_session, source_file_id=sf.id, project_id=project_id,
            order_id="O-1", sku="S-1", return_date=d,
            license_plate="LP-1", row_no=1, quantity=2,
        )
        seed_return_row(
            db_session, source_file_id=sf.id, project_id=project_id,
            order_id="O-2", sku="S-2", return_date=d,
            license_plate="LP-2", row_no=2, quantity=3,
        )

        body = client.get(_qs(project_id), headers=admin_headers).json()
        start, end = default_return_window()
        analysis = build_return_analysis(
            db_session,
            project_id=project_id,
            country="US",
            start_date=start,
            end_date=end,
        )
        # build_return_analysis 会把 ORM 对象的 return_date 就地改成 str（历史行为），
        # rollback 丢弃这处脏状态，避免 teardown 的 DELETE 触发 autoflush 写坏列。
        # 种子数据是已提交的，rollback 不会丢。
        db_session.rollback()

        assert sum(r["quantity"] for r in body["rows"]) == 5
        assert sum(r["quantity"] for r in body["rows"]) == analysis.summary.total_quantity

    def test_project_not_found_404(self, client, admin_headers):
        """不存在的项目 → 由端点自己的鉴权路径（ensure_project_access）抛 404。

        只断言 ``status_code == 404`` 没有鉴别力：路由压根不存在时 FastAPI 也
        回 404。这里额外锁定 detail 文案，确保 404 来自「项目不存在」而不是
        路由缺失（路由缺失时 detail 是 ``Not Found``）。
        """
        resp = client.get(_qs(99999999), headers=admin_headers)

        assert resp.status_code == 404
        assert resp.json()["detail"] == "项目不存在"

    def test_non_admin_without_operator_403(self, client, project_id, settings):
        """与 /return-analysis 同鉴权语义：非 admin 且无 X-Operator → 403。"""
        headers = {"X-API-Key": settings.api_key, "X-Is-Admin": "false"}

        resp = client.get(_qs(project_id), headers=headers)

        assert resp.status_code == 403

    def test_exceeds_max_rows_400(
        self, client, project_id, db_session, admin_headers, monkeypatch
    ):
        """超上限显式 400，不返回任何部分数据（拒绝静默截断）。"""
        from app.api.v1.endpoints import return_analysis as ra_module

        monkeypatch.setattr(ra_module, "MAX_RAW_ROWS", 1)
        d = date.today() - timedelta(days=1)
        sf = seed_return_source(db_session, project_id, tag="cap")
        seed_return_row(
            db_session, source_file_id=sf.id, project_id=project_id,
            order_id="O-1", sku="S-1", return_date=d,
            license_plate="LP-1", row_no=1,
        )
        seed_return_row(
            db_session, source_file_id=sf.id, project_id=project_id,
            order_id="O-2", sku="S-1", return_date=d,
            license_plate="LP-2", row_no=2,
        )

        resp = client.get(_qs(project_id), headers=admin_headers)

        assert resp.status_code == 400
        assert "上限" in resp.json()["detail"]
        assert "rows" not in resp.json()
