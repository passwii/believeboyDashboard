"""BLF-1016：广告分析 Insight adapter 契约测试（``ad_analysis.v1``）。

覆盖验收矩阵：

1. **role/slot 契约**：scope 一致（country / project_ids）、未知字段、
   必填 slot 缺失、slot 超限、权限拒绝都走 canonical 码表——本域不定义
   第二套错误语义。
2. **新鲜度与缺数**：``data_freshness`` / ``missing_data`` 是可审计的
   slot 输入（无覆盖率→unknown、覆盖为 0→missing、缺日→stale），并能在
   落库 slots_json 往返中保持。
3. **提交复用 canonical 基础设施**：provider/run/幂等全走 ``start_run``；
   无数据 → ``ScopeError(PROJECT_NOT_FOUND)``、模型越界 →
   ``MODEL_NOT_ALLOWED``、provider 未配置 → ``PROVIDER_UNAVAILABLE``；
   replay 到死 run 开新 attempt。

不打真实网络、不查业务表：聚合产物用替身，模型解析用 ``_fake_settings()``。
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
from app.schemas.insight import (
    IDEMPOTENCY_KEY_PATTERN,
    InsightErrorCode,
    InsightStatus,
)
from app.services.ad.insight_adapter.slots import (
    AD_FRESHNESS_MAX_AGE_DAYS,
    SERIES_MAX_ITEMS,
    ad_context_slot,
    ad_data_slot,
    assess_freshness,
    assess_missing,
    trim_ad_payload,
)
from app.services.ad.insight_adapter.submit import (
    ROLE_ID,
    ROLE_VERSION,
    idempotency_key_for,
    submit_run_for_ad_analysis,
)
from app.api.v1.endpoints.insight_common import submission_error
from app.services.insight.provider import (
    InsightProviderError,
    InsightProviderErrorCode,
)
from app.services.insight.validator import (
    InsightValidationError,
    ScopeError,
    validate_run_request,
)

PROJECT_ID = 42
START = date(2026, 8, 13)
TODAY = date(2026, 9, 11)


# --------------------------------------------------------------------------
# 替身与构造
# --------------------------------------------------------------------------


class _AllowAll:
    """scope authorizer 替身：全部放行（scope 一致性由 validator 单测覆盖）。"""

    def __call__(self, project_id: int, country: str) -> None:
        return None


class _Aggregate:
    """``AggregatedData`` 替身：adapter 只消费 ``to_dict()``。"""

    def __init__(self, data: dict[str, Any]) -> None:
        self._data = data

    def to_dict(self) -> dict[str, Any]:
        return self._data


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


def _series(days: int, *, end: date = TODAY) -> list[dict[str, Any]]:
    return [
        {
            "date": (end - timedelta(days=offset)).isoformat(),
            "order_qty": 3,
            "sales_amount": 30.0,
            "unique_asins": 1,
        }
        for offset in range(days)
    ]


def _ad_data(**overrides: Any) -> dict[str, Any]:
    """``AggregatedData.to_dict()`` 的真实键（值可裁剪，结构不简化）。"""
    data: dict[str, Any] = {
        "project_name": "测试店铺A",
        "country": "US",
        "date_range_start": START.isoformat(),
        "date_range_end": TODAY.isoformat(),
        "sales_by_date": _series(30),
        "ad_by_date": [
            {
                "date": row["date"],
                "impressions": 100,
                "clicks": 5,
                "ad_spend": 8.0,
                "ad_sales": 20.0,
                "ad_orders": 2,
            }
            for row in _series(30)
        ],
        "inventory_summary": {"total_available": 10},
        "comparison_period": None,
        "top_skus": [{"sku": "SKU-1", "sales_amount": 120.0}],
        "ad_campaigns": [{"campaign_id": "c1", "ad_spend": 40.0}],
        "ad_breakdown_by_type": {
            "sponsored_products": {
                "summary": {"ad_spend": 40.0},
                "top": [{"key": "c1"}],
                "has_data": True,
                "label": "SP",
            }
        },
        "data_coverage": {"sales_days": 30, "ad_days": 30, "total_requested_days": 30},
        "project_context": {"name": "测试店铺A"},
        "sku_context": {"skus": [{"sku": "SKU-1"}]},
    }
    data.update(overrides)
    return data


def _slots(
    data: dict[str, Any] | None = None,
    *,
    project_id: int = PROJECT_ID,
    country: str = "US",
) -> dict[str, Any]:
    raw = data if data is not None else _ad_data()
    payload, _ = trim_ad_payload(raw)
    return {
        "ad.context": ad_context_slot(
            project_id=project_id,
            project_name=str(raw.get("project_name") or ""),
            country=country,
            date_range_start=START,
            date_range_end=TODAY,
            data_freshness=assess_freshness(raw, today=TODAY),
            missing_data=assess_missing(raw),
        ),
        "ad.data": ad_data_slot(payload),
    }


def _raw_request(
    *,
    slots: dict[str, Any] | None = None,
    project_id: int = PROJECT_ID,
    country: str = "US",
) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "role_id": ROLE_ID,
        "role_version": ROLE_VERSION,
        "project_id": project_id,
        "country": country,
        "slots": _slots() if slots is None else slots,
        "idempotency_key": idempotency_key_for(project_id, country, START, TODAY),
    }


def _code(exc: pytest.ExceptionInfo[Any]) -> InsightErrorCode:
    return exc.value.error.code


# --------------------------------------------------------------------------
# 1. role / slot 契约
# --------------------------------------------------------------------------


class TestSlotContract:
    def test_generated_slots_pass_canonical_validation(self):
        request = validate_run_request(_raw_request(), _AllowAll())
        assert request.role_id == ROLE_ID
        assert set(request.slots) == {"ad.context", "ad.data"}
        context = json.loads(json.dumps(request.slots["ad.context"], default=str))
        assert context["country"] == "US"
        assert context["project_ids"] == [PROJECT_ID]
        assert context["data_freshness"]["status"] == "fresh"
        assert context["missing_data"]["is_complete"] is True

    @pytest.mark.parametrize(
        ("request_country", "request_project", "slot_country", "slot_project"),
        [
            ("US", PROJECT_ID, "DE", PROJECT_ID),  # 站点与 run scope 不符
            ("US", PROJECT_ID, "US", PROJECT_ID + 1),  # 项目不在 slot scope
        ],
    )
    def test_scope_mismatch_is_typed(
        self, request_country, request_project, slot_country, slot_project
    ):
        raw = _raw_request(
            slots=_slots(country=slot_country, project_id=slot_project),
            country=request_country,
            project_id=request_project,
        )
        with pytest.raises(InsightValidationError) as exc:
            validate_run_request(raw, _AllowAll())
        assert _code(exc) == InsightErrorCode.SCOPE_MISMATCH
        assert exc.value.error.slot == "ad.context"

    def test_unknown_field_in_context_slot_is_rejected(self):
        slots = _slots()
        slots["ad.context"]["unexpected_dimension"] = ["x"]
        with pytest.raises(InsightValidationError) as exc:
            validate_run_request(_raw_request(slots=slots), _AllowAll())
        assert _code(exc) == InsightErrorCode.SLOT_VALIDATION_FAILED
        assert exc.value.error.slot == "ad.context"

    def test_stringified_payload_is_rejected(self):
        """slot payload 必须是 JSON 对象——字符串化的 JSON 是不可审的载荷。

        拒绝必须是 typed 422：裸 ``TypeError`` 会绕过 validator 变成 500。
        """
        slots = _slots()
        slots["ad.data"]["payload"] = json.dumps(slots["ad.data"]["payload"])
        with pytest.raises(InsightValidationError) as exc:
            validate_run_request(_raw_request(slots=slots), _AllowAll())
        assert _code(exc) == InsightErrorCode.SLOT_VALIDATION_FAILED
        assert exc.value.error.slot == "ad.data"

    def test_missing_required_slot_is_typed(self):
        slots = _slots()
        slots.pop("ad.data")
        with pytest.raises(InsightValidationError) as exc:
            validate_run_request(_raw_request(slots=slots), _AllowAll())
        assert _code(exc) == InsightErrorCode.MISSING_REQUIRED_SLOT
        assert exc.value.error.slot == "ad.data"

    def test_oversized_slot_is_typed(self):
        slots = _slots()
        slots["ad.data"]["payload"]["padding"] = ["x" * 1000] * 400  # ≈400KiB
        with pytest.raises(InsightValidationError) as exc:
            validate_run_request(_raw_request(slots=slots), _AllowAll())
        assert _code(exc) == InsightErrorCode.SLOT_TOO_LARGE
        assert exc.value.error.slot == "ad.data"

    def test_scope_denials_keep_canonical_codes(self):
        def out_of_scope(project_id: int, country: str) -> None:
            raise ScopeError(InsightErrorCode.PROJECT_OUT_OF_SCOPE, "no access")

        def not_found(project_id: int, country: str) -> None:
            raise ScopeError(InsightErrorCode.PROJECT_NOT_FOUND, "missing")

        def country_mismatch(project_id: int, country: str) -> None:
            raise ScopeError(InsightErrorCode.COUNTRY_MISMATCH, "wrong country")

        for authorizer, expected in (
            (out_of_scope, InsightErrorCode.PROJECT_OUT_OF_SCOPE),
            (not_found, InsightErrorCode.PROJECT_NOT_FOUND),
            (country_mismatch, InsightErrorCode.COUNTRY_MISMATCH),
        ):
            with pytest.raises(InsightValidationError) as exc:
                validate_run_request(_raw_request(), authorizer)
            assert _code(exc) == expected


# --------------------------------------------------------------------------
# 2. 数据新鲜度 / 缺数 / 裁剪
# --------------------------------------------------------------------------


class TestFreshnessAndCoverage:
    def test_fresh_when_series_current_and_coverage_complete(self):
        posture = assess_freshness(_ad_data(), today=TODAY)
        assert posture["status"] == "fresh"
        assert posture["as_of"] == TODAY.isoformat()  # slot 内必须是 JSON 原生字符串
        assert posture["age_days"] == 0
        assert posture["source"] == "ad_reports"

    def test_stale_when_series_lags_beyond_threshold(self):
        lagged = TODAY - timedelta(days=AD_FRESHNESS_MAX_AGE_DAYS + 1)
        data = _ad_data(sales_by_date=_series(30, end=lagged), ad_by_date=[])
        posture = assess_freshness(data, today=TODAY)
        assert posture["status"] == "stale"
        assert posture["age_days"] == AD_FRESHNESS_MAX_AGE_DAYS + 1

    def test_stale_when_coverage_short_of_requested_days(self):
        data = _ad_data(
            data_coverage={"sales_days": 10, "ad_days": 10, "total_requested_days": 30}
        )
        assert assess_freshness(data, today=TODAY)["status"] == "stale"

    def test_missing_when_no_series_at_all(self):
        data = _ad_data(
            sales_by_date=[],
            ad_by_date=[],
            data_coverage={"sales_days": 0, "ad_days": 0, "total_requested_days": 30},
        )
        posture = assess_freshness(data, today=TODAY)
        assert posture["status"] == "missing"
        assert posture["as_of"] is None
        assert posture["age_days"] is None
        assert assess_missing(data)["is_complete"] is False

    def test_unknown_when_coverage_unavailable(self):
        assert assess_freshness(_ad_data(data_coverage={}), today=TODAY)["status"] == "unknown"

    def test_missing_dimensions_are_controlled_ids(self):
        data = _ad_data(
            sales_by_date=[],
            ad_by_date=[],
            top_skus=[],
            ad_campaigns=[],
            ad_breakdown_by_type={},
            data_coverage={"sales_days": 0, "ad_days": 0, "total_requested_days": 30},
        )
        missing = assess_missing(data)
        assert missing["is_complete"] is False
        assert set(missing["missing_dimensions"]) == {
            "sales_series",
            "ad_series",
            "ad_campaigns",
            "ad_breakdown",
            "top_skus",
        }

    def test_truncation_is_recorded_in_payload(self):
        data = _ad_data(sales_by_date=_series(SERIES_MAX_ITEMS + 5), ad_by_date=[])
        payload, truncated = trim_ad_payload(data)
        assert len(payload["sales_by_date"]) == SERIES_MAX_ITEMS
        assert "sales_by_date" in truncated
        assert payload["truncated_sections"] == truncated

    def test_freshness_and_missing_survive_slot_roundtrip(self):
        """落库 slots_json 是 worker 唯一输入 → 新鲜度/缺数不能丢。"""
        request = validate_run_request(_raw_request(), _AllowAll())
        dumped = json.loads(
            json.dumps(request.slots, ensure_ascii=False, default=str)
        )
        context = dumped["ad.context"]
        assert context["data_freshness"]["status"] == "fresh"
        assert context["missing_data"]["is_complete"] is True


# --------------------------------------------------------------------------
# 3. 提交 / 幂等 / fallback
# --------------------------------------------------------------------------


class TestSubmit:
    @pytest.fixture()
    def aggregate(self, monkeypatch) -> list[dict[str, Any]]:
        """替身聚合器；返回调用记录（断言请求侧组装，不在 worker 侧查库）。"""
        calls: list[dict[str, Any]] = []

        def _fake(*args: Any, **kwargs: Any) -> _Aggregate:
            calls.append({"args": args, "kwargs": kwargs})
            return _Aggregate(_ad_data())

        monkeypatch.setattr(
            "app.services.ai_insight_aggregator.aggregate_project_data", _fake
        )
        return calls

    def _submit(self, db: Session, enqueued: list[tuple[str, int]], **overrides: Any):
        params: dict[str, Any] = {
            "project_id": PROJECT_ID,
            "country": "US",
            "start_date": START,
            "end_date": TODAY,
            "scope_authorizer": _AllowAll(),
            "enqueue": lambda rid, att: enqueued.append((rid, att)),
            "settings": _fake_settings(),
            "today": TODAY,
        }
        params.update(overrides)
        return submit_run_for_ad_analysis(db, **params)

    def test_submit_freezes_slots_and_enqueues_once(self, db, aggregate):
        enqueued: list[tuple[str, int]] = []
        run, replayed = self._submit(db, enqueued)

        assert replayed is False
        assert run.role_id == ROLE_ID
        assert run.role_version == ROLE_VERSION
        assert run.status == InsightStatus.QUEUED.value
        assert enqueued == [(run.run_id, 1)]
        assert len(aggregate) == 1  # 请求侧组装一次
        slots = json.loads(run.slots_json)
        assert slots["ad.context"]["country"] == "US"
        assert slots["ad.context"]["project_ids"] == [PROJECT_ID]
        assert slots["ad.data"]["payload"]["sales_by_date"]  # 已冻结在行里
        assert run.idempotency_key == idempotency_key_for(PROJECT_ID, "US", START, TODAY)

    def test_resubmit_replays_same_run_without_reenqueue(self, db, aggregate):
        enqueued: list[tuple[str, int]] = []
        first, _ = self._submit(db, enqueued)
        again, replayed = self._submit(db, enqueued)

        assert replayed is True
        assert again.run_id == first.run_id
        assert len(enqueued) == 1  # replay 不再入队（不重复扣费）
        assert db.query(InsightRun).count() == 1

    def test_replay_of_dead_run_starts_new_attempt(self, db, aggregate):
        enqueued: list[tuple[str, int]] = []
        run, _ = self._submit(db, enqueued)
        run.status = InsightStatus.FAILED.value
        db.commit()

        retried, replayed = self._submit(db, enqueued)

        assert replayed is True
        assert retried.run_id == run.run_id  # 前端持有的 run_id 继续有效
        assert retried.attempt == 2
        assert enqueued[-1] == (run.run_id, 2)

    def test_missing_project_raises_project_not_found(self, db, monkeypatch):
        monkeypatch.setattr(
            "app.services.ai_insight_aggregator.aggregate_project_data",
            lambda *a, **k: None,
        )
        with pytest.raises(ScopeError) as exc:
            self._submit(db, [])
        assert exc.value.code == InsightErrorCode.PROJECT_NOT_FOUND
        assert db.query(InsightRun).count() == 0  # 无数据不建半截 run

    def test_model_outside_allowlist_reports_model_not_allowed(self, db, aggregate):
        with pytest.raises(InsightProviderError) as exc:
            self._submit(
                db,
                [],
                model_id="not-allowed",
                settings=_fake_settings(ai_chat_basic_models="other-model"),
            )
        assert exc.value.code == InsightProviderErrorCode.MODEL_NOT_ALLOWED
        http = submission_error(exc.value)
        assert http.status_code == 422
        assert http.detail["code"] == InsightErrorCode.MODEL_NOT_ALLOWED.value
        assert db.query(InsightRun).count() == 0

    def test_provider_unavailable_when_no_model_configured(self, db, aggregate):
        with pytest.raises(InsightProviderError) as exc:
            self._submit(
                db,
                [],
                settings=_fake_settings(
                    insight_default_model="", ai_chat_default_model=""
                ),
            )
        assert exc.value.code == InsightProviderErrorCode.MODEL_UNAVAILABLE
        assert exc.value.retryable is False
        # canonical 码表：model_unavailable 折叠成 MODEL_NOT_ALLOWED（422、不可重试）
        http = submission_error(exc.value)
        assert http.status_code == 422
        assert http.detail["code"] == InsightErrorCode.MODEL_NOT_ALLOWED.value
        assert http.detail["retryable"] is False
        assert db.query(InsightRun).count() == 0

    def test_idempotency_key_is_stable_and_canonical(self):
        key = idempotency_key_for(PROJECT_ID, "us", START, TODAY)
        assert key == f"ad:{PROJECT_ID}:US:2026-08-13:2026-09-11"
        assert re.match(IDEMPOTENCY_KEY_PATTERN, key)
        assert key == idempotency_key_for(PROJECT_ID, "US", START, TODAY)
