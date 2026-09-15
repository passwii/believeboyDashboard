"""Agent 退货分析读路由测试（BLF-470 spec §7：R1/R2/R3/R4 + PII + 读不落审计）。"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.db.session import SessionLocal
from app.main import app
from app.models import OperationAuditLog

from conftest import seed_return_analysis


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture(autouse=True)
def _no_redis_cache(monkeypatch):
    """R1/R4 的 Redis v2 缓存替换成直查——测试不依赖本地 Redis，也不串缓存。

    缓存命中路径单独用 monkeypatch 覆盖（``test_cache_hit``）。
    """
    from app.api.v1.endpoints.agent import return_analysis as ra_module

    monkeypatch.setattr(ra_module, "get_return_analysis_v2_cache", lambda *a, **k: None)
    monkeypatch.setattr(ra_module, "set_return_analysis_v2_cache", lambda *a, **k: None)


def _today() -> date:
    return date.today() - timedelta(days=1)


def _url(env, suffix: str = "") -> str:
    return f"/api/v1/agent/projects/{env['project_id']}/return-analysis{suffix}"


def _qs(start=None, end=None, **extra) -> str:
    d = _today()
    parts = [
        "country=US",
        f"start_date={start or d.isoformat()}",
        f"end_date={end or d.isoformat()}",
    ]
    parts += [f"{k}={v}" for k, v in extra.items()]
    return "?" + "&".join(parts)


def _seed_overview(env) -> None:
    """R1/R4 基座：X-001 两单（含顾客评论）+ X-002 一单 + 对应销售行。"""
    d = _today()
    seed_return_analysis(
        env["project_id"],
        return_rows=[
            {
                "return_date": d,
                "order_id": "O-1",
                "sku": "X-001",
                "quantity": 2,
                "customer_comments": "Bad quality|Too small",
            },
            {"return_date": d, "order_id": "O-2", "sku": "X-001", "quantity": 1},
            {"return_date": d, "order_id": "O-3", "sku": "X-002", "quantity": 1},
        ],
        sales_rows=[
            {
                "order_id": "S-1",
                "sku": "X-001",
                "quantity": 10,
                "purchase_date_pt": d,
            },
            {
                "order_id": "S-2",
                "sku": "X-002",
                "quantity": 5,
                "purchase_date_pt": d,
            },
        ],
    )


class TestR1Overview:
    def test_overview_summary(self, client, shipment_env):
        _seed_overview(shipment_env)
        resp = client.get(
            _url(shipment_env, "/overview") + _qs(),
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["project_id"] == shipment_env["project_id"]
        assert data["country"] == "US"
        assert data["summary"]["total_returns"] == 3
        assert data["summary"]["total_quantity"] == 4
        assert data["summary"]["unique_skus"] == 2
        assert data["summary"]["top_return_sku"] == "X-001"
        assert data["summary_text"], "summary_text 应有模板化文字总结"
        # ranking_rows 按 total_quantity 倒序：X-001(3) > X-002(1)
        assert [r["sku"] for r in data["ranking_rows"]] == ["X-001", "X-002"]

    def test_overview_sku_filter(self, client, shipment_env):
        _seed_overview(shipment_env)
        resp = client.get(
            _url(shipment_env, "/overview") + _qs(sku="X-001"),
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["summary"]["total_returns"] == 2
        assert data["summary"]["unique_skus"] == 1
        assert [r["sku"] for r in data["ranking_rows"]] == ["X-001"]

    def test_fresh_snapshot_ranking_uses_current_raw_for_overview(
        self, client, shipment_env
    ):
        """Fresh aggregate may be incomplete; R1 ranking must still match current raw."""
        d = _today()
        seed_return_analysis(
            shipment_env["project_id"],
            return_rows=[
                {"return_date": d, "order_id": "RAW-1", "sku": "X-001", "quantity": 2},
                {"return_date": d, "order_id": "RAW-2", "sku": "X-001", "quantity": 1},
            ],
            aggregate_rows=[
                {
                    "sku": "X-001",
                    "data_date": d,
                    "return_count": 1,
                    "return_quantity": 1,
                    "computed_at": datetime.now(timezone.utc),
                }
            ],
        )

        resp = client.get(
            _url(shipment_env, "/overview") + _qs(),
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["summary"]["total_quantity"] == 3
        assert data["ranking_rows"][0]["total_quantity"] == 3
        assert data["ranking_rows"][0]["return_count"] == 2

    def test_missing_project_404(self, client, shipment_env):
        resp = client.get(
            "/api/v1/agent/projects/99999999/return-analysis/overview" + _qs(),
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 404, resp.text
        assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"

    def test_invalid_date_400(self, client, shipment_env):
        _seed_overview(shipment_env)
        resp = client.get(
            _url(shipment_env, "/overview") + _qs(start="2026-13-99", end="2026-14-01"),
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 400, resp.text
        body = resp.json()
        assert body["ok"] is False
        assert body["error"]["code"] == "VALIDATION_FAILED"

    def test_feedback_comments_stripped_by_default(self, client, shipment_env):
        _seed_overview(shipment_env)
        resp = client.get(
            _url(shipment_env, "/overview") + _qs(),
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        rows = resp.json()["data"]["feedback_rows"]
        assert rows, "应有顾客评论行"
        for row in rows:
            assert "customer_comment" not in row, "默认剥离 customer_comment（PII）"

    def test_feedback_comments_included_explicitly(self, client, shipment_env):
        _seed_overview(shipment_env)
        resp = client.get(
            _url(shipment_env, "/overview") + _qs(include_comments="true"),
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        rows = resp.json()["data"]["feedback_rows"]
        # BLF-788：O-1 单元格 "Bad quality|Too small" 按事件聚合为一行，
        # 多段文本去重后以「 | 」合并，不再拆成两行重复计数。
        assert len(rows) == 1
        assert rows[0]["order_id"] == "O-1"
        assert rows[0]["customer_comment"] == "Bad quality | Too small"

    def test_cache_hit_returns_cached_payload(self, client, shipment_env, monkeypatch):
        """缓存命中路径：直接返回缓存 payload（与内部端点共享 v2 缓存）。"""
        from app.api.v1.endpoints.agent import return_analysis as ra_module

        cached = {
            "project_id": shipment_env["project_id"],
            "project_name": shipment_env["project_name"],
            "country": "US",
            "start_date": _today().isoformat(),
            "end_date": _today().isoformat(),
            "summary": {
                "total_returns": 7,
                "total_quantity": 9,
                "unique_skus": 1,
                "top_return_sku": "X-001",
                "top_return_reason": "NOT_AS_DESCRIBED",
                "total_sales_quantity": 100,
                "total_sales_amount": 1000.0,
                "overall_return_rate": 9.0,
            },
            "summary_text": "CACHED-PAYLOAD",
            "ranking_rows": [],
            "reason_rows": [],
            "trend_rows": [],
            "disposition_rows": [],
            "status_rows": [],
            "feedback_rows": [],
            "weekday_rows": [],
            "fulfillment_center_rows": [],
            "multi_item_return_count": 0,
            "multi_item_return_quantity": 0,
        }
        monkeypatch.setattr(
            ra_module, "get_return_analysis_v2_cache", lambda *a, **k: dict(cached)
        )
        resp = client.get(
            _url(shipment_env, "/overview") + _qs(),
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["summary_text"] == "CACHED-PAYLOAD"
        assert data["summary"]["total_returns"] == 7


class TestR4SkuDetail:
    def test_sku_detail_filters_to_sku(self, client, shipment_env):
        _seed_overview(shipment_env)
        resp = client.get(
            _url(shipment_env, "/skus/X-001") + _qs(),
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["summary"]["total_returns"] == 2
        assert data["summary"]["unique_skus"] == 1
        assert [r["sku"] for r in data["ranking_rows"]] == ["X-001"]

    def test_sku_no_data_200_empty(self, client, shipment_env):
        _seed_overview(shipment_env)
        resp = client.get(
            _url(shipment_env, "/skus/NO-SUCH-SKU") + _qs(),
            headers=shipment_env["headers"],
        )
        # D6 拍板：查询结果为空 ≠ 资源不存在 → 200 + 空分布行
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["summary"]["total_returns"] == 0
        assert data["ranking_rows"] == []

    def test_fresh_snapshot_ranking_uses_current_raw_for_sku_detail(
        self, client, shipment_env
    ):
        """R4 must not expose stale aggregate values for a single SKU either."""
        d = _today()
        seed_return_analysis(
            shipment_env["project_id"],
            return_rows=[
                {"return_date": d, "order_id": "RAW-1", "sku": "X-001", "quantity": 2},
                {"return_date": d, "order_id": "RAW-2", "sku": "X-001", "quantity": 1},
            ],
            aggregate_rows=[
                {
                    "sku": "X-001",
                    "data_date": d,
                    "return_count": 1,
                    "return_quantity": 1,
                    "computed_at": datetime.now(timezone.utc),
                }
            ],
        )

        resp = client.get(
            _url(shipment_env, "/skus/X-001") + _qs(),
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["summary"]["total_quantity"] == 3
        assert data["ranking_rows"][0]["total_quantity"] == 3
        assert data["ranking_rows"][0]["return_count"] == 2

    def test_sku_missing_project_404(self, client, shipment_env):
        resp = client.get(
            "/api/v1/agent/projects/99999999/return-analysis/skus/X-001" + _qs(),
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 404, resp.text
        assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"


class TestR2Aggregate:
    def _seed_aggregates(self, env) -> None:
        d = _today()
        # 注意：query_return_analysis_aggregate 会用 compute_risk_level 重算
        # risk_level（销量门槛 15 + Wilson 下界）。sales_quantity 必须 ≥15，
        # 否则全部落 no_data。X-001: 30/100 → critical；X-002: 8/50 → warning。
        # BLF-806：分母改从 raw 销售层取窗口 counted sales，所以这里要同步
        # seed 同额销售行（100 / 50），否则分母为 0、risk_level 全落 no_data。
        seed_return_analysis(
            env["project_id"],
            sales_rows=[
                {"order_id": "S-X001-A", "purchase_date_pt": d, "sku": "X-001", "quantity": 60},
                {"order_id": "S-X001-B", "purchase_date_pt": d, "sku": "X-001", "quantity": 40},
                {"order_id": "S-X002-A", "purchase_date_pt": d, "sku": "X-002", "quantity": 50},
            ],
            aggregate_rows=[
                {
                    "sku": "X-001",
                    "data_date": d,
                    "return_count": 20,
                    "return_quantity": 30,
                    "sales_quantity": 100,
                    "return_rate": 30.0,
                    "risk_level": "critical",
                    "reason_top1": "NOT_AS_DESCRIBED",
                    "disposition_top1": "SELLABLE",
                    "dominant_fc_id": "PHX6",
                    "wilson_lower": 10.5,
                },
                {
                    "sku": "X-002",
                    "data_date": d,
                    "return_count": 5,
                    "return_quantity": 8,
                    "sales_quantity": 50,
                    "return_rate": 16.0,
                    "risk_level": "warning",
                    "reason_top1": "DEFECTIVE",
                    "disposition_top1": "CARRIER_DAMAGED",
                    "dominant_fc_id": "LAX9",
                    "wilson_lower": 6.2,
                },
            ],
        )

    def test_aggregate_rows_with_display_enhancement(self, client, shipment_env):
        self._seed_aggregates(shipment_env)
        resp = client.get(
            _url(shipment_env) + "?period=30d&country=US&order_by=return_quantity",
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["project_id"] == shipment_env["project_id"]
        assert data["country"] == "US"
        assert data["period"]["type"] == "relative"
        assert data["period"]["value"] == "30d"
        by_sku = {row["sku"]: row for row in data["data"]}
        assert set(by_sku) == {"X-001", "X-002"}

        # 原生化增强（review 结论）：display 字段存在
        row1 = by_sku["X-001"]
        assert row1["risk_level"] == "critical"
        assert row1["reason_top1_display"] == "与描述不符"
        assert row1["disposition_top1_display"] == "可售"
        assert "product_name" in row1
        row2 = by_sku["X-002"]
        assert row2["reason_top1_display"] == "有缺陷"
        assert row2["disposition_top1_display"] == "运输损坏"

        assert data["summary"]["total_return_quantity"] == 38
        assert data["summary"]["overall_risk_level"] == "critical"
        assert data["summary"]["critical_sku_count"] == 1
        assert data["summary"]["warning_sku_count"] == 1

    def test_aggregate_risk_level_filter(self, client, shipment_env):
        self._seed_aggregates(shipment_env)
        resp = client.get(
            _url(shipment_env) + "?period=30d&country=US&risk_level=critical",
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert [row["sku"] for row in data["data"]] == ["X-001"]

    def test_aggregate_invalid_risk_level_400(self, client, shipment_env):
        self._seed_aggregates(shipment_env)
        resp = client.get(
            _url(shipment_env) + "?period=30d&country=US&risk_level=bogus",
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "VALIDATION_FAILED"

    def test_aggregate_invalid_order_by_400(self, client, shipment_env):
        self._seed_aggregates(shipment_env)
        resp = client.get(
            _url(shipment_env) + "?period=30d&country=US&order_by=not_a_column",
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "VALIDATION_FAILED"

    def test_aggregate_missing_project_404(self, client, shipment_env):
        resp = client.get(
            "/api/v1/agent/projects/99999999/return-analysis?period=30d&country=US",
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 404, resp.text
        assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"


class TestR3Raw:
    def test_raw_strips_pii(self, client, shipment_env):
        d = _today()
        seed_return_analysis(
            shipment_env["project_id"],
            return_rows=[
                {
                    "return_date": d,
                    "order_id": "O-1",
                    "sku": "X-001",
                    "quantity": 2,
                    "customer_comments": "Bad quality",
                },
                {
                    "return_date": d,
                    "order_id": "O-2",
                    "sku": "X-002",
                    "quantity": 1,
                },
            ],
        )
        resp = client.get(
            _url(shipment_env, "-raw") + "?period=30d&country=US",
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["project_id"] == shipment_env["project_id"]
        assert len(data["data"]) == 2
        row = data["data"][0]
        # PII 剥离契约（external §9.2）：这些字段永不返回
        for forbidden in (
            "customer_comments",
            "raw_row",
            "fnsku",
            "license_plate_number",
        ):
            assert forbidden not in row, f"{forbidden} 永不返回"
        assert row["sku"] in {"X-001", "X-002"}
        assert row["reason"]
        assert "order_id" in row

    def test_raw_missing_project_404(self, client, shipment_env):
        resp = client.get(
            "/api/v1/agent/projects/99999999/return-analysis-raw?period=30d&country=US",
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 404, resp.text
        assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"


class TestReadDoesNotWriteAudit:
    def test_reads_do_not_write_audit(self, client, shipment_env):
        _seed_overview(shipment_env)
        self._seed_aggregates(shipment_env)

        for url in (
            _url(shipment_env, "/overview") + _qs(),
            _url(shipment_env) + "?period=30d&country=US",
            _url(shipment_env, "-raw") + "?period=30d&country=US",
            _url(shipment_env, "/skus/X-001") + _qs(),
            _url(shipment_env, "/coverage") + "?country=US",
        ):
            resp = client.get(url, headers=shipment_env["headers"])
            assert resp.status_code == 200, f"{url}: {resp.text}"

        db = SessionLocal()
        try:
            count = db.execute(
                select(func.count())
                .select_from(OperationAuditLog)
                .where(OperationAuditLog.agent_id == shipment_env["agent_id"])
            ).scalar()
            assert count == 0, "纯读路由不落审计"
        finally:
            db.close()

    def _seed_aggregates(self, env) -> None:
        d = _today()
        seed_return_analysis(
            env["project_id"],
            aggregate_rows=[
                {
                    "sku": "X-001",
                    "data_date": d,
                    "return_quantity": 1,
                    "sales_quantity": 10,
                    "risk_level": "critical",
                },
                {
                    "sku": "X-002",
                    "data_date": d,
                    "return_quantity": 1,
                    "sales_quantity": 5,
                    "risk_level": "warning",
                },
            ],
        )
