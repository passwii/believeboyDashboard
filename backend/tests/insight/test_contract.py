"""I-7：合同冻结回归矩阵（后端侧）。

覆盖稳定序列化、往返、discriminated union、role/version/slot、scope、limits、
幂等、状态机、终态唯一性、resume cursor、retry attempt、secret redaction。
只跑契约集，不触发业务测试 / Redis / Celery / provider / DB 写入。
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from uuid import uuid4

from app.schemas.insight import (
    ERROR_HTTP_STATUS,
    RETRYABLE_ERROR_CODES,
    InsightErrorCode,
    InsightRunDetail,
    InsightRunRequest,
    InsightRunResponse,
    make_error,
)
from app.services.insight import contracts
from app.services.insight.cursor import (
    event_id_of,
    group_by_attempt,
    parse_event_id,
    validate_attempt_sequence,
)
from app.services.insight.events import TERMINAL_EVENT_TYPES, InsightEventAdapter
from tests.insight.conftest import make_request

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "insight"


def _now() -> str:
    return "2026-09-09T08:00:00Z"


def test_stable_serialization_bytes():
    request = InsightRunRequest.model_validate(make_request())
    assert contracts.serialize_contract(request) == contracts.serialize_contract(
        InsightRunRequest.model_validate(json.loads(request.model_dump_json()))
    )
    blob = contracts.serialize_contract(request).decode()
    assert '"schema_version":1' in blob.replace(" ", "")


def test_response_detail_roundtrip_and_output_format_fixed():
    run_id = str(uuid4())
    response = InsightRunResponse.model_validate(
        {
            "schema_version": 1,
            "run_id": run_id,
            "attempt": 1,
            "role_id": "schedule_report_summary",
            "role_version": 1,
            "project_id": 42,
            "country": "US",
            "status": "queued",
            "output_format": "markdown",
            "detail_url": f"/api/v1/insights/runs/{run_id}",
            "stream_url": f"/api/v1/insights/runs/{run_id}/events",
            "cancel_url": f"/api/v1/insights/runs/{run_id}/cancel",
            "retry_url": f"/api/v1/insights/runs/{run_id}/retry",
            "replayed": False,
            "created_at": _now(),
            "updated_at": _now(),
        }
    )
    assert response.output_format == "markdown"
    again = InsightRunResponse.model_validate(json.loads(response.model_dump_json()))
    assert again == response

    digest = hashlib.sha256("## 本周摘要".encode()).hexdigest()
    detail = InsightRunDetail.model_validate(
        {
            "schema_version": 1,
            "run_id": run_id,
            "attempt": 1,
            "role_id": "schedule_report_summary",
            "role_version": 1,
            "project_id": 42,
            "country": "US",
            "status": "completed",
            "stage": "finalizing",
            "progress_percent": 100,
            "output_format": "markdown",
            "outputs": {"main": {"format": "markdown", "content": "## 本周摘要", "content_sha256": digest}},
            "resume": {"latest_event_id": None, "current_attempt": 1, "history_available": True},
            "created_at": _now(),
            "updated_at": _now(),
        }
    )
    assert detail.outputs["main"].content_sha256 == digest


def test_every_error_code_has_http_mapping_and_safe_retryable_default():
    assert set(ERROR_HTTP_STATUS) == set(InsightErrorCode)
    for code in InsightErrorCode:
        error = make_error(code, "display-safe message")
        assert error.retryable == (code in RETRYABLE_ERROR_CODES)
        assert 400 <= ERROR_HTTP_STATUS[code] <= 504


def test_fixture_matrix_seq_attempt_ids_terminal():
    for name in ("normal-run", "failed-run", "cancelled-run", "retry-attempt"):
        doc = json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))
        events = [InsightEventAdapter.validate_python(raw) for raw in doc["events"]]
        assert all(e.schema_version == 1 for e in events)
        # 外部 SSE id 语义
        for event in events:
            assert event_id_of(event) == f"{event.run_id}:{event.attempt}:{event.seq}"
            assert parse_event_id(event_id_of(event)).seq == event.seq
        # 每 attempt seq 从 1 严格递增、终态唯一且收尾
        for group in group_by_attempt(events).values():
            validate_attempt_sequence(group)
            terminals = [e for e in group if e.type in TERMINAL_EVENT_TYPES]
            assert len(terminals) == 1
            assert group[-1].type in TERMINAL_EVENT_TYPES
    # normal 唯一 done、failed/cancelled 唯一 error
    normal = [InsightEventAdapter.validate_python(e) for e in json.loads((FIXTURES / "normal-run.json").read_text(encoding="utf-8"))["events"]]
    assert normal[-1].type == "done" and normal[-1].status == "completed"
    failed = [InsightEventAdapter.validate_python(e) for e in json.loads((FIXTURES / "failed-run.json").read_text(encoding="utf-8"))["events"]]
    assert failed[-1].type == "error" and failed[-1].status == "failed"
    cancelled = [InsightEventAdapter.validate_python(e) for e in json.loads((FIXTURES / "cancelled-run.json").read_text(encoding="utf-8"))["events"]]
    assert cancelled[-1].type == "error" and cancelled[-1].status == "cancelled"
    assert cancelled[-1].error.code == "CANCELLED"


def test_fixture_digest_matches_content():
    doc = json.loads((FIXTURES / "normal-run.json").read_text(encoding="utf-8"))
    done = doc["events"][-1]
    content = done["outputs"]["main"]["content"]
    assert done["outputs"]["main"]["content_sha256"] == hashlib.sha256(content.encode()).hexdigest()
    assert done["content_sha256"] == done["outputs"]["main"]["content_sha256"]


def test_retry_keeps_run_id_and_resets_seq():
    doc = json.loads((FIXTURES / "retry-attempt.json").read_text(encoding="utf-8"))
    events = [InsightEventAdapter.validate_python(raw) for raw in doc["events"]]
    groups = group_by_attempt(events)
    assert {e.run_id for e in events} == {events[0].run_id}
    assert [e.seq for e in groups[2]] == [1, 2, 3, 4]
