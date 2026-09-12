"""BLF-1018：观测期只读端点的 HTTP 契约（权限 / 报告结构 / 空窗口口径）。

``/insight/observation`` 是管理员专用的跨项目审计口径，这里钉住三件事：

1. **越权拒绝**：非管理员两个端点都 403（``require_admin``），不是 401 ——
   认证由网关层 ``protected`` 负责，本层只管授权。
2. **报告即审计 JSON**：闸门端点返回的结构与 ``GateReport.as_dict()``
   （``scripts/insight_gate.py`` 打印的同一份）逐字段一致，人工核对与机器
   判定不可能分叉。
3. **空窗口不达标**：窗口内没有 canonical 样本时 ``eligible_for_retirement``
   必须是 ``False`` + ``insufficient_data:insight.runs=0``，不能因为
   「没有 findings」而被读成通过。

Auth 走 ``protected`` override（与 ``test_insight_runs_stream.py`` 同口径），
数据落真实测试库 ``BLF_test``；本文件自己造行、自己删行，不依赖也不污染他测。
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import delete

GATE_URL = "/api/v1/insight/observation/gate"
READINESS_URL = "/api/v1/insight/observation/retirement-readiness"


@pytest.fixture()
def observation_app() -> FastAPI:
    """只挂观测路由；``protected`` 置空，把授权判定留给 ``require_admin``。"""
    from app.api.deps import protected
    from app.api.v1.endpoints.insight_observation import router

    app = FastAPI()
    app.dependency_overrides[protected] = lambda: None
    app.include_router(router, prefix="/api/v1")
    return app


@pytest.fixture()
def client(observation_app: FastAPI) -> TestClient:
    return TestClient(observation_app)


@pytest.fixture()
def admin_client(client: TestClient) -> TestClient:
    client.headers.update({"X-Is-Admin": "true"})
    return client


def _write_observation(run_id: str, **overrides: object) -> None:
    """落一行 canonical 桶的终态观测（等价于 ``record_run_snapshot`` 的产物）。"""
    from app.db.session import SessionLocal
    from app.models.insight_run_observation import (
        SOURCE_INSIGHT_RUN,
        InsightRunObservation,
    )

    fields: dict[str, object] = {
        "capability": "insight",
        "status": "completed",
        "duration_ms": 4_000,
        "first_delta_ms": 1_200,
        "attempts": 1,
        "retries": 0,
        "total_tokens": 350,
        "stream_opens": 3,
        "stream_reconnects": 1,
        "reconnect_completed": True,
        "stream_frames": 12,
        "stream_bytes": 2_048,
    }
    fields.update(overrides)
    with SessionLocal() as session:
        session.add(
            InsightRunObservation(source=SOURCE_INSIGHT_RUN, run_id=run_id, **fields)
        )
        session.commit()


def _drop_observation(run_id: str) -> None:
    from app.db.session import SessionLocal
    from app.models.insight_run_observation import InsightRunObservation

    with SessionLocal() as session:
        session.execute(
            delete(InsightRunObservation).where(InsightRunObservation.run_id == run_id)
        )
        session.commit()


def _clear_canonical_window() -> int:
    """清掉测试库里的 canonical 观测行，返回删除条数。

    聚合是按桶（capability）跨行计算的，而 ``tests/api`` 里别的文件（SSE 流 /
    取消）会经真实端点写入 canonical 行 —— 不清就无法断言「桶内恰好 1 个 run」。
    删的是 ``BLF_test`` 的可再生测试数据：除本文件外没有任何测试读这张表。
    """
    from app.db.session import SessionLocal
    from app.models.insight_run_observation import (
        SOURCE_INSIGHT_RUN,
        InsightRunObservation,
    )

    with SessionLocal() as session:
        result = session.execute(
            delete(InsightRunObservation).where(
                InsightRunObservation.source == SOURCE_INSIGHT_RUN,
                InsightRunObservation.capability == "insight",
            )
        )
        session.commit()
    return result.rowcount


@pytest.fixture()
def seeded_run() -> Iterator[str]:
    """独占的 canonical 窗口：清空既有行 → 落一行已知样本 → 结束即删。"""
    from tests.conftest import _require_test_database

    _require_test_database()
    run_id = f"blf1018-{uuid.uuid4().hex[:24]}"
    _clear_canonical_window()
    _write_observation(run_id)
    try:
        yield run_id
    finally:
        _drop_observation(run_id)


class TestAuthorization:
    """观测是跨项目口径，非管理员一律拒绝（验收 §2 权限越权场景）。"""

    @pytest.mark.parametrize("url", [GATE_URL, READINESS_URL])
    def test_anonymous_is_forbidden(self, client: TestClient, url: str) -> None:
        response = client.get(url)
        assert response.status_code == 403
        assert response.json()["detail"] == "需要管理员权限"

    @pytest.mark.parametrize("url", [GATE_URL, READINESS_URL])
    def test_explicit_non_admin_is_forbidden(self, client: TestClient, url: str) -> None:
        response = client.get(url, headers={"X-Is-Admin": "false"})
        assert response.status_code == 403

    def test_admin_reaches_both_endpoints(self, admin_client: TestClient) -> None:
        assert admin_client.get(GATE_URL).status_code == 200
        assert admin_client.get(READINESS_URL).status_code == 200


@pytest.mark.usefixtures("seeded_run")
class TestGateReport:
    def test_report_json_is_the_audit_json(self, admin_client: TestClient) -> None:
        """HTTP 响应 = 服务层 ``as_dict()`` + 阈值/桶上限，逐字段同源。"""
        from app.core.config import get_settings
        from app.db.session import SessionLocal
        from app.services.insight.observation import gate_report

        response = admin_client.get(
            GATE_URL, params={"window_days": 7, "capability": "insight"}
        )
        assert response.status_code == 200
        payload = response.json()

        with SessionLocal() as session:
            expected = gate_report(
                session,
                settings=get_settings(),
                window_days=7,
                capability="insight",
            ).as_dict()
        # generated_at 是两次调用的墙钟时间，不参与比对。
        payload.pop("generated_at")
        expected.pop("generated_at")
        assert payload.pop("thresholds") == {
            "duration_ms": int(get_settings().insight_gate_max_duration_ms),
            "first_delta_ms": int(get_settings().insight_gate_max_first_delta_ms),
            "stream_frames": int(get_settings().insight_gate_max_stream_frames),
            "fallback_ratio": float(get_settings().insight_gate_max_fallback_ratio),
            "cost_anomaly_multiplier": float(
                get_settings().insight_gate_cost_anomaly_multiplier
            ),
        }
        assert payload.pop("bucket_caps")
        assert payload == expected

    def test_seeded_bucket_metrics_reach_the_caller(self, admin_client: TestClient) -> None:
        """聚合值不只是在服务层算对，也要原样落到 HTTP 契约上。"""
        payload = admin_client.get(
            GATE_URL, params={"capability": "insight"}
        ).json()

        assert [b["capability"] for b in payload["buckets"]] == ["insight"]
        bucket = payload["buckets"][0]
        assert bucket["runs"] == 1
        assert bucket["completed"] == 1
        assert bucket["error_rate"] == 0.0
        assert bucket["stream_reconnects"] == 1
        assert bucket["reconnect_completed"] == 1
        assert bucket["reconnect_rate"] == 0.3333  # 服务层统一保留 4 位
        assert bucket["total_tokens"] == 350
        assert bucket["max_duration_ms"] == 4_000
        assert bucket["max_first_delta_ms"] == 1_200

        # 一行合格样本 ⇒ 指标票通过，且 findings 里没有 blocking。
        assert payload["findings"] == []
        assert payload["eligible_for_retirement"] is True
        assert payload["retirement_reasons"] == []
        assert payload["blocking_count"] == 0

    def test_empty_window_is_not_reported_as_eligible(self, admin_client: TestClient) -> None:
        """空窗口：没有 findings，但**不是达标**（review 反例回归）。"""
        payload = admin_client.get(
            GATE_URL, params={"capability": "blf1018-no-such-bucket"}
        ).json()

        assert payload["buckets"] == []
        assert payload["findings"] == []
        assert payload["eligible_for_retirement"] is False
        assert payload["retirement_reasons"] == ["insufficient_data:insight.runs=0"]
        assert payload["blocking_count"] == 1

    def test_window_days_out_of_range_is_rejected(self, admin_client: TestClient) -> None:
        assert admin_client.get(GATE_URL, params={"window_days": 0}).status_code == 422
        assert admin_client.get(GATE_URL, params={"window_days": 91}).status_code == 422


@pytest.mark.usefixtures("seeded_run")
class TestRetirementReadiness:
    def test_third_vote_stays_uncollected(self, admin_client: TestClient) -> None:
        """指标票由接口给，调用方清零票恒为 ``None`` —— 接口不替脚本下结论。"""
        payload = admin_client.get(READINESS_URL).json()

        assert payload["metrics_ok"] is True
        assert payload["metrics_reasons"] == []
        assert payload["blocking_count"] == len(payload["metrics_reasons"])
        assert payload["codegraph_verified"] is None
        assert payload["eligible"] is False
        assert payload["legacy_reads_preserved"] is True
        assert all(isinstance(domain, str) for domain in payload["canonical_domains"])
        assert "insight_canonical_domains" in payload["rollback_switch"]
