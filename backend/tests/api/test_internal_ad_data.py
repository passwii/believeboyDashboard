"""内部 ad-data 读路由测试（BLF-459 V3：/external/* 下线后浏览器通道重建）。

覆盖：
* 鉴权：未带 API key → 401；带 key（admin/master）→ 200。
* ad-{endpoint}-raw：10 个报表端点均 200，响应形状 {project_id, period,
  country, data, summary}（与 external 时代一致，ad-data 页形态不变）。
* ad-upload-files：列表恢复（含 report_type / ingestion_status 字段）；
  缺项目 → 404。
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db.session import SessionLocal
from app.main import app
from app.models import Project


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture
def admin_headers():
    """内部 API 的管理员上下文（与 test_internal_api_keys_agent 一致）。"""
    from app.core.config import get_settings

    settings = get_settings()
    return {
        "X-API-Key": settings.api_key,
        "X-Is-Admin": "true",
        "X-Operator": "pytest",
    }


def _first_project_id() -> int:
    db = SessionLocal()
    try:
        row = db.execute(
            select(Project.id).order_by(Project.id).limit(1)
        ).scalar_one_or_none()
    finally:
        db.close()
    if row is None:
        pytest.skip("no project in test DB")
    return row


class TestAuth:
    def test_401_without_key(self, client):
        resp = client.get(
            "/api/v1/internal/ad-data/projects/1/ad-campaigns-raw?country=US"
        )
        assert resp.status_code == 401

    def test_200_with_key(self, client, admin_headers):
        pid = _first_project_id()
        resp = client.get(
            f"/api/v1/internal/ad-data/projects/{pid}/ad-campaigns-raw?country=US&period=30d&limit=3",
            headers=admin_headers,
        )
        assert resp.status_code == 200, resp.text


class TestAdRawEndpoints:
    @pytest.mark.parametrize(
        "endpoint",
        [
            "ad-campaigns",
            "ad-search-terms",
            "ad-budgets",
            "ad-targets",
            "ad-placements",
            "ad-promoted-products",
            "ad-time-trends",
            "ad-search-term-shares",
            "ad-invalid-traffic",
            "ad-purchased-products",
        ],
    )
    def test_raw_shape(self, client, admin_headers, endpoint):
        pid = _first_project_id()
        resp = client.get(
            f"/api/v1/internal/ad-data/projects/{pid}/{endpoint}-raw"
            "?country=US&period=30d&limit=3",
            headers=admin_headers,
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        # 与 external 时代同形：ad-data 页直接消费
        assert set(body.keys()) == {
            "project_id",
            "period",
            "country",
            "data",
            "summary",
        }
        assert isinstance(body["data"], list)

    def test_404_unknown_project(self, client, admin_headers):
        resp = client.get(
            "/api/v1/internal/ad-data/projects/99999999/ad-campaigns-raw"
            "?country=US&period=30d",
            headers=admin_headers,
        )
        assert resp.status_code == 404


class TestAdUploadFiles:
    def test_list_shape(self, client, admin_headers):
        pid = _first_project_id()
        resp = client.get(
            f"/api/v1/internal/ad-data/projects/{pid}/ad-upload-files?country=US",
            headers=admin_headers,
        )
        assert resp.status_code == 200, resp.text
        items = resp.json()
        assert isinstance(items, list)
        for item in items:
            assert set(item.keys()) >= {
                "file_id",
                "report_type",
                "report_label",
                "country",
                "version",
                "is_current",
                "ingestion_status",
            }

    def test_404_unknown_project(self, client, admin_headers):
        resp = client.get(
            "/api/v1/internal/ad-data/projects/99999999/ad-upload-files",
            headers=admin_headers,
        )
        assert resp.status_code == 404
