"""BLF-1016：库存健康 Insight adapter 契约测试（``inventory_health.v1``）。

库存域在旧系统里没有 LLM 链路，所以这里没有「冻结旧写端」的断言；覆盖的是
新 role 的输入契约与 canonical 复用：

1. **新鲜度/缺数**：无快照（missing）与快照就是今天（fresh）必须可区分，
   slot 里的日期是 JSON 原生字符串。
2. **裁剪**：行按 ``sellable_days`` 升序取最紧急的 N 条，``None`` 排最后，
   裁剪事实（``row_total`` / ``rows_truncated`` / ``row_limit``）必须进
   payload；summary 只带走白名单计数（state×action 矩阵不要）。
3. **slot 契约**：构建出的 slots 能被 canonical validator 接受；scope
   不一致（country / project_ids）走 canonical ``SCOPE_MISMATCH``。
4. **提交**：``start_run`` 复用；幂等 replay 不重复入队、死 run 开新 attempt、
   项目不存在 → ``PROJECT_NOT_FOUND``。

不查真实业务表、不打网络：补货分析服务与快照日期都是替身。
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterator
from datetime import date, timedelta
from typing import Any

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.db.session import Base
from app.models.insight_run import InsightRun
from app.models.project import Project
from app.schemas.insight import (
    IDEMPOTENCY_KEY_PATTERN,
    InsightErrorCode,
    InsightStatus,
)
from app.services.insight.provider import (
    InsightProviderError,
    InsightProviderErrorCode,
)
from app.services.insight.validator import (
    InsightValidationError,
    ScopeError,
    validate_run_request,
)
from app.services.inventory.insight_adapter.slots import (
    INVENTORY_FRESH_MAX_AGE_DAYS,
    ROW_MAX_ITEMS,
    assess_freshness,
    assess_missing,
    build_inventory_slots,
    normalize_inventory_country,
    trim_rows,
    trim_summary,
)
from app.services.inventory.insight_adapter.submit import (
    ROLE_ID,
    ROLE_VERSION,
    idempotency_key_for,
    submit_run_for_inventory_health,
)

PROJECT_ID = 77
TODAY = date(2026, 9, 11)


# --------------------------------------------------------------------------
# 替身与构造
# --------------------------------------------------------------------------


class _AllowAll:
    """scope authorizer 替身：全部放行（scope 一致性由 validator 单测覆盖）。"""

    def __call__(self, project_id: int, country: str) -> None:
        return None


def _fake_settings(**overrides: Any) -> Any:
    """让 ``InsightModelResolver`` 通过的最小 settings（不发真实请求）。"""
    from types import SimpleNamespace

    values: dict[str, Any] = {
        "insight_default_endpoint_id": "default",
        "insight_endpoint_ids": "default",
        "insight_default_model": "test-model",
        "insight_role_default_models": "",
        "ai_chat_default_model": "test-model",
        "ai_chat_basic_models": "",
        "ai_chat_premium_models": "",
        "ai_chat_model_blocklist": "",
        "ai_chat_provider_api_key": "test-key",
        "ai_chat_provider_base_url": "https://example.invalid/v1",
    }
    values.update(overrides)
    return SimpleNamespace(**values)


@pytest.fixture()
def db() -> Iterator[Session]:
    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture()
def project(db: Session) -> Project:
    row = Project(id=PROJECT_ID, project_name="测试店铺B", sort_order=1, country="US")
    db.add(row)
    db.commit()
    return row


def _row(sku: str, sellable_days: Any, **extra: Any) -> dict[str, Any]:
    """补货分析的一条 SKU 行（真实键的子集，含 date 对象）。"""
    data: dict[str, Any] = {
        "sku": sku,
        "country": "US",
        "available_inventory": 120,
        "sellable_days": sellable_days,
        "risk_status": "out_of_stock",
        "recommended_action": "REPLENISH_NOW",
        "inventory_state": "critical",
        "replenishment_action": "REPLENISH_NOW",
        "sellout_date": TODAY + timedelta(days=12),
        "risk_anchor_date": TODAY,
    }
    data.update(extra)
    return data


def _summary(**overrides: Any) -> dict[str, Any]:
    data: dict[str, Any] = {
        "sku_count": 3,
        "out_of_stock_risk_count": 1,
        "healthy_count": 1,
        "slow_moving_count": 0,
        "pending_data_count": 0,
        "total_available_inventory": 500,
        "total_in_transit_quantity": 200,
        "critical_count": 1,
        "deteriorating_count": 1,
        "watch_count": 0,
        "healthy_count_v2": 1,
        "unknown_count": 0,
        "state_distribution": {"critical": 1, "deteriorating": 1, "healthy": 1},
        "action_distribution": {"REPLENISH_NOW": 1, "WATCH": 1, "HOLD": 1},
        "state_action_matrix": {"critical": {"REPLENISH_NOW": 1}},
    }
    data.update(overrides)
    return data


def _stub_inventory(
    monkeypatch: pytest.MonkeyPatch,
    *,
    rows: list[dict[str, Any]] | None = None,
    summary: dict[str, Any] | None = None,
    total: int | None = None,
    snapshot_date: date | None = TODAY,
) -> list[dict[str, Any]]:
    """把补货分析服务与快照日期换成替身；返回调用记录。"""
    calls: list[dict[str, Any]] = []
    body = rows if rows is not None else [_row("SKU-1", 3.0), _row("SKU-2", 40.0)]
    counts = summary if summary is not None else _summary()

    def _list(db: Any, **kwargs: Any) -> tuple[Any, Any, Any, Any]:
        calls.append(kwargs)
        return body, counts, total if total is not None else len(body), False

    def _snapshot(db: Any, project_id: int, country: str, anchor: date) -> date | None:
        return snapshot_date

    monkeypatch.setattr(
        "app.services.inventory.replenishment.list_inventory_replenishment_analysis",
        _list,
    )
    monkeypatch.setattr(
        "app.services.inventory.replenishment.latest_inventory_snapshot_date",
        _snapshot,
    )
    return calls


# --------------------------------------------------------------------------
# 1. 新鲜度
# --------------------------------------------------------------------------


class TestFreshness:
    def test_no_snapshot_is_missing_not_stale(self):
        posture = assess_freshness(None, today=TODAY)
        assert posture["status"] == "missing"
        assert posture["as_of"] is None
        assert posture["age_days"] is None

    def test_snapshot_of_today_is_fresh(self):
        posture = assess_freshness(TODAY, today=TODAY)
        assert posture["status"] == "fresh"
        assert posture["as_of"] == TODAY.isoformat()  # slot 内必须是 JSON 原生字符串
        assert posture["age_days"] == 0
        assert posture["source"] == "inventory_report"

    def test_snapshot_within_threshold_is_fresh(self):
        anchor = TODAY - timedelta(days=INVENTORY_FRESH_MAX_AGE_DAYS)
        assert assess_freshness(anchor, today=TODAY)["status"] == "fresh"

    def test_snapshot_lagging_beyond_threshold_is_stale(self):
        anchor = TODAY - timedelta(days=INVENTORY_FRESH_MAX_AGE_DAYS + 1)
        posture = assess_freshness(anchor, today=TODAY)
        assert posture["status"] == "stale"
        assert posture["age_days"] == INVENTORY_FRESH_MAX_AGE_DAYS + 1

    def test_future_snapshot_does_not_yield_negative_age(self):
        assert assess_freshness(TODAY + timedelta(days=2), today=TODAY)["age_days"] == 0


# --------------------------------------------------------------------------
# 2. 缺数 / 裁剪
# --------------------------------------------------------------------------


class TestCoverage:
    def test_complete_when_snapshot_rows_and_traffic_present(self):
        missing = assess_missing(
            snapshot_report_date=TODAY,
            summary=_summary(),
            rows=[_row("SKU-1", 3.0)],
        )
        assert missing == {"is_complete": True, "missing_dimensions": []}

    def test_missing_dimensions_are_controlled_ids(self):
        missing = assess_missing(
            snapshot_report_date=None,
            summary=_summary(
                sku_count=0,
                pending_data_count=0,
                total_available_inventory=0,
                total_in_transit_quantity=0,
            ),
            rows=[],
        )
        assert missing["is_complete"] is False
        assert set(missing["missing_dimensions"]) == {
            "snapshot",
            "skus",
            "aging",
            "in_transit",
        }

    def test_all_pending_dms_marks_dms_missing(self):
        missing = assess_missing(
            snapshot_report_date=TODAY,
            summary=_summary(sku_count=5, pending_data_count=5),
            rows=[_row("SKU-1", None)],
        )
        assert "dms" in missing["missing_dimensions"]

    def test_summary_keeps_only_whitelisted_counts(self):
        payload = trim_summary(_summary())
        assert payload["sku_count"] == 3
        assert payload["state_distribution"]["critical"] == 1
        assert "state_action_matrix" not in payload  # 矩阵太大，不进 slot

    def test_non_dict_summary_degrades_to_empty(self):
        assert trim_summary(None) == {}

    def test_rows_sorted_by_sellable_days_with_none_last(self):
        rows = [_row("SKU-slow", 90.0), _row("SKU-unknown", None), _row("SKU-hurry", 1.5)]
        ordered, truncated = trim_rows(rows)
        assert [item["sku"] for item in ordered] == ["SKU-hurry", "SKU-slow", "SKU-unknown"]
        assert truncated is False

    def test_rows_truncated_to_limit(self):
        rows = [_row(f"SKU-{index:03d}", float(index)) for index in range(ROW_MAX_ITEMS + 5)]
        ordered, truncated = trim_rows(rows)
        assert len(ordered) == ROW_MAX_ITEMS
        assert truncated is True

    def test_country_is_normalized_to_canonical_site(self):
        assert normalize_inventory_country("us") == "US"
        assert normalize_inventory_country("USA") == "US"
        assert normalize_inventory_country("DE") == "DE"


# --------------------------------------------------------------------------
# 3. slot 契约
# --------------------------------------------------------------------------


class TestSlotContract:
    def test_build_produces_canonical_valid_slots(self, db, project, monkeypatch):
        _stub_inventory(monkeypatch)
        slots = build_inventory_slots(db, project_id=PROJECT_ID, country="US", today=TODAY)
        assert slots is not None

        request = validate_run_request(
            {
                "schema_version": 1,
                "role_id": ROLE_ID,
                "role_version": ROLE_VERSION,
                "project_id": PROJECT_ID,
                "country": "US",
                "slots": slots,
                "idempotency_key": idempotency_key_for(PROJECT_ID, "US", TODAY),
            },
            _AllowAll(),
        )
        context = json.loads(json.dumps(request.slots["inventory.context"]))
        assert context["country"] == "US"
        assert context["project_ids"] == [PROJECT_ID]
        assert context["report_date"] == TODAY.isoformat()
        assert context["data_freshness"]["status"] == "fresh"
        assert context["missing_data"]["is_complete"] is True

    def test_payload_is_json_native_end_to_end(self, db, project, monkeypatch):
        """行里带 date 对象（sellout_date…）→ slot 内必须已转 ISO 字符串。"""
        _stub_inventory(monkeypatch, rows=[_row("SKU-1", 3.0)], total=9)
        slots = build_inventory_slots(db, project_id=PROJECT_ID, country="US", today=TODAY)
        assert slots is not None

        # 直接 json.dumps：create_run 就是这么落库的，非 JSON 原生类型会炸。
        dumped = json.loads(json.dumps(slots, ensure_ascii=False, sort_keys=True))
        payload = dumped["inventory.data"]["payload"]
        row = payload["rows"][0]
        assert row["sellout_date"] == (TODAY + timedelta(days=12)).isoformat()
        assert row["risk_anchor_date"] == TODAY.isoformat()
        assert payload["project_name"] == "测试店铺B"
        assert payload["row_total"] == 9
        assert payload["rows_truncated"] is True  # 服务侧还有 9 条，这里只带了 1 条
        assert payload["row_limit"] == ROW_MAX_ITEMS
        assert payload["summary"]["sku_count"] == 3

    def test_missing_project_returns_none(self, db, monkeypatch):
        _stub_inventory(monkeypatch)
        assert build_inventory_slots(db, project_id=PROJECT_ID + 1, country="US") is None

    def test_missing_snapshot_does_not_block_slot_build(self, db, project, monkeypatch):
        """无快照 = 缺数（进 slot 让模型说明数据不足），不是提交失败。"""
        _stub_inventory(monkeypatch, snapshot_date=None)
        slots = build_inventory_slots(db, project_id=PROJECT_ID, country="US", today=TODAY)
        assert slots is not None
        assert slots["inventory.context"]["data_freshness"]["status"] == "missing"
        assert "snapshot" in slots["inventory.context"]["missing_data"]["missing_dimensions"]

    def test_scope_mismatch_is_typed(self, db, project, monkeypatch):
        _stub_inventory(monkeypatch)
        slots = build_inventory_slots(db, project_id=PROJECT_ID, country="US", today=TODAY)
        assert slots is not None
        with pytest.raises(InsightValidationError) as exc:
            validate_run_request(
                {
                    "schema_version": 1,
                    "role_id": ROLE_ID,
                    "role_version": ROLE_VERSION,
                    "project_id": PROJECT_ID,
                    "country": "DE",  # run scope 与 slot 站点不符
                    "slots": slots,
                    "idempotency_key": idempotency_key_for(PROJECT_ID, "DE", TODAY),
                },
                _AllowAll(),
            )
        assert exc.value.error.code == InsightErrorCode.SCOPE_MISMATCH
        assert exc.value.error.slot == "inventory.context"


# --------------------------------------------------------------------------
# 4. 提交 / 幂等
# --------------------------------------------------------------------------


class TestSubmit:
    def _submit(self, db: Session, enqueued: list[tuple[str, int]], **overrides: Any):
        params: dict[str, Any] = {
            "project_id": PROJECT_ID,
            "country": "US",
            "report_date": TODAY,
            "scope_authorizer": _AllowAll(),
            "enqueue": lambda rid, att: enqueued.append((rid, att)),
            "settings": _fake_settings(),
            "today": TODAY,
        }
        params.update(overrides)
        return submit_run_for_inventory_health(db, **params)

    def test_submit_freezes_slots_and_enqueues_once(
        self, db, project, monkeypatch
    ):
        _stub_inventory(monkeypatch)
        enqueued: list[tuple[str, int]] = []
        run, replayed = self._submit(db, enqueued)

        assert replayed is False
        assert run.role_id == ROLE_ID
        assert run.role_version == ROLE_VERSION
        assert run.status == InsightStatus.QUEUED.value
        assert enqueued == [(run.run_id, 1)]
        slots = json.loads(run.slots_json)
        assert slots["inventory.context"]["project_ids"] == [PROJECT_ID]
        assert slots["inventory.data"]["payload"]["rows"]  # 已冻结在行里
        assert run.idempotency_key == idempotency_key_for(PROJECT_ID, "US", TODAY)

    def test_resubmit_replays_same_run_without_reenqueue(
        self, db, project, monkeypatch
    ):
        _stub_inventory(monkeypatch)
        enqueued: list[tuple[str, int]] = []
        first, _ = self._submit(db, enqueued)
        again, replayed = self._submit(db, enqueued)

        assert replayed is True
        assert again.run_id == first.run_id
        assert len(enqueued) == 1
        assert db.query(InsightRun).count() == 1

    def test_replay_of_dead_run_starts_new_attempt(self, db, project, monkeypatch):
        _stub_inventory(monkeypatch)
        enqueued: list[tuple[str, int]] = []
        run, _ = self._submit(db, enqueued)
        run.status = InsightStatus.FAILED.value
        db.commit()

        retried, replayed = self._submit(db, enqueued)

        assert replayed is True
        assert retried.run_id == run.run_id  # run_id 对前端继续有效
        assert retried.attempt == 2
        assert enqueued[-1] == (run.run_id, 2)

    def test_missing_project_raises_project_not_found(self, db, monkeypatch):
        _stub_inventory(monkeypatch)
        with pytest.raises(ScopeError) as exc:
            self._submit(db, [])
        assert exc.value.code == InsightErrorCode.PROJECT_NOT_FOUND
        assert db.query(InsightRun).count() == 0  # 无数据不建半截 run

    def test_model_outside_allowlist_reports_model_not_allowed(
        self, db, project, monkeypatch
    ):
        _stub_inventory(monkeypatch)
        with pytest.raises(InsightProviderError) as exc:
            self._submit(
                db,
                [],
                model_id="not-allowed",
                settings=_fake_settings(ai_chat_basic_models="other-model"),
            )
        assert exc.value.code == InsightProviderErrorCode.MODEL_NOT_ALLOWED
        assert db.query(InsightRun).count() == 0

    @pytest.mark.parametrize("report_date", [None, TODAY])
    def test_idempotency_key_is_stable_and_canonical(self, report_date):
        key = idempotency_key_for(PROJECT_ID, "us", report_date)
        stamp = (report_date or date.today()).isoformat()
        assert key == f"inventory:{PROJECT_ID}:US:{stamp}"
        assert re.match(IDEMPOTENCY_KEY_PATTERN, key)

    def test_same_day_different_report_date_are_distinct_runs(
        self, db, project, monkeypatch
    ):
        """口径日期不同 = 不同输入，幂等键必须区分（否则前端换日期会被 replay）。"""
        _stub_inventory(monkeypatch)
        enqueued: list[tuple[str, int]] = []
        first, _ = self._submit(db, enqueued)
        second, _ = self._submit(db, enqueued, report_date=TODAY - timedelta(days=1))

        assert second.run_id != first.run_id
        assert len(enqueued) == 2
