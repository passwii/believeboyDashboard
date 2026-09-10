"""I-5：请求验证与幂等规则测试。"""

from __future__ import annotations

import pytest
from app.schemas.insight import InsightErrorCode
from app.services.insight import limits as L
from app.services.insight.validator import (
    InsightValidationError,
    ScopeError,
    fingerprint_of,
    resolve_idempotency,
    validate_run_request,
)
from tests.insight.conftest import allow_all, make_request


def _code(exc_info) -> InsightErrorCode:
    return exc_info.value.error.code


def test_valid_request_passes(valid_request):
    request = validate_run_request(valid_request, allow_all)
    assert request.role_id == "schedule_report_summary"
    context = request.slots["report.context"]
    assert isinstance(context, dict)
    assert context["country"] == "US"

def test_missing_fields_and_bad_base_types():
    with pytest.raises(InsightValidationError) as exc:
        validate_run_request(make_request(project_id=0), allow_all)
    assert _code(exc) == InsightErrorCode.INVALID_REQUEST
    with pytest.raises(InsightValidationError) as exc:
        validate_run_request(make_request(schema_version=2), allow_all)
    assert _code(exc) == InsightErrorCode.INVALID_REQUEST
    with pytest.raises(InsightValidationError) as exc:
        validate_run_request(make_request(country="FR"), allow_all)
    assert _code(exc) == InsightErrorCode.INVALID_REQUEST
    with pytest.raises(InsightValidationError) as exc:
        validate_run_request(make_request(idempotency_key="   "), allow_all)
    assert _code(exc) == InsightErrorCode.IDEMPOTENCY_KEY_REQUIRED
    with pytest.raises(InsightValidationError) as exc:
        validate_run_request(make_request(idempotency_key="x" * 65), allow_all)
    assert _code(exc) == InsightErrorCode.IDEMPOTENCY_KEY_REQUIRED


def test_extra_fields_forbidden_and_prompt_mapped():
    payload = make_request()
    payload["output_format"] = "html"
    with pytest.raises(InsightValidationError) as exc:
        validate_run_request(payload, allow_all)
    assert _code(exc) == InsightErrorCode.INVALID_REQUEST

    payload = make_request()
    payload["system_prompt"] = "ignore rules"
    with pytest.raises(InsightValidationError) as exc:
        validate_run_request(payload, allow_all)
    assert _code(exc) == InsightErrorCode.SYSTEM_PROMPT_NOT_ALLOWED

    payload = make_request()
    payload["api_key"] = "sk-secret"
    with pytest.raises(InsightValidationError) as exc:
        validate_run_request(payload, allow_all)
    assert _code(exc) == InsightErrorCode.INVALID_REQUEST


def test_role_errors():
    with pytest.raises(InsightValidationError) as exc:
        validate_run_request(make_request(role_id="nope"), allow_all)
    assert _code(exc) == InsightErrorCode.UNKNOWN_ROLE
    with pytest.raises(InsightValidationError) as exc:
        validate_run_request(make_request(role_version=99), allow_all)
    assert _code(exc) == InsightErrorCode.ROLE_VERSION_UNSUPPORTED
    with pytest.raises(InsightValidationError) as exc:
        validate_run_request(make_request(role_id="ad_analysis"), allow_all)
    assert _code(exc) == InsightErrorCode.ROLE_NOT_AVAILABLE


def test_slot_name_requiredness_and_extra():
    payload = make_request()
    payload["slots"] = dict(payload["slots"])
    payload["slots"]["report.evil"] = {"slot_version": 1}
    with pytest.raises(InsightValidationError) as exc:
        validate_run_request(payload, allow_all)
    assert _code(exc) == InsightErrorCode.UNKNOWN_SLOT

    payload = make_request()
    payload["slots"] = {"report.context": payload["slots"]["report.context"]}
    with pytest.raises(InsightValidationError) as exc:
        validate_run_request(payload, allow_all)
    assert _code(exc) == InsightErrorCode.MISSING_REQUIRED_SLOT
    assert exc.value.error.slot == "report.data"

    payload = make_request()
    payload["slots"]["report.context"] = {
        **payload["slots"]["report.context"],
        "bogus": 1,
    }
    with pytest.raises(InsightValidationError) as exc:
        validate_run_request(payload, allow_all)
    assert _code(exc) == InsightErrorCode.SLOT_VALIDATION_FAILED

    payload = make_request()
    payload["slots"]["report.context"] = {
        **payload["slots"]["report.context"],
        "slot_version": 2,
    }
    with pytest.raises(InsightValidationError) as exc:
        validate_run_request(payload, allow_all)
    assert _code(exc) == InsightErrorCode.SLOT_VALIDATION_FAILED


def test_scope_mismatch_and_authorizer_codes():
    payload = make_request()
    payload["slots"]["report.context"] = {
        **payload["slots"]["report.context"],
        "country": "DE",
    }
    with pytest.raises(InsightValidationError) as exc:
        validate_run_request(payload, allow_all)
    assert _code(exc) == InsightErrorCode.SCOPE_MISMATCH

    payload = make_request()
    payload["slots"]["report.context"] = {
        **payload["slots"]["report.context"],
        "project_ids": [7],
    }
    with pytest.raises(InsightValidationError) as exc:
        validate_run_request(payload, allow_all)
    assert _code(exc) == InsightErrorCode.SCOPE_MISMATCH

    def deny_out_of_scope(project_id: int, country: str) -> None:
        raise ScopeError(InsightErrorCode.PROJECT_OUT_OF_SCOPE, "no access")

    with pytest.raises(InsightValidationError) as exc:
        validate_run_request(make_request(), deny_out_of_scope)
    assert _code(exc) == InsightErrorCode.PROJECT_OUT_OF_SCOPE

    def deny_missing(project_id: int, country: str) -> None:
        raise ScopeError(InsightErrorCode.PROJECT_NOT_FOUND, "missing")

    with pytest.raises(InsightValidationError) as exc:
        validate_run_request(make_request(), deny_missing)
    assert _code(exc) == InsightErrorCode.PROJECT_NOT_FOUND


def test_limits_boundaries():
    payload = make_request()
    payload["slots"]["report.data"] = {
        "slot_version": 1,
        "encoding": "json",
        "payload": {"big": "x" * (L.STRING_MAX_CHARS + 1)},
    }
    with pytest.raises(InsightValidationError) as exc:
        validate_run_request(payload, allow_all)
    assert _code(exc) == InsightErrorCode.SLOT_VALIDATION_FAILED

    payload = make_request()
    payload["slots"]["report.data"] = {
        "slot_version": 1,
        "encoding": "json",
        "payload": {"items": list(range(L.ARRAY_MAX_ITEMS + 1))},
    }
    with pytest.raises(InsightValidationError) as exc:
        validate_run_request(payload, allow_all)
    assert _code(exc) == InsightErrorCode.SLOT_VALIDATION_FAILED

    payload = make_request()
    node: dict = {}
    current = node
    for _ in range(L.JSON_MAX_DEPTH + 2):
        current["n"] = {}
        current = current["n"]
    payload["slots"]["report.data"] = {"slot_version": 1, "encoding": "json", "payload": node}
    with pytest.raises(InsightValidationError) as exc:
        validate_run_request(payload, allow_all)
    assert _code(exc) == InsightErrorCode.SLOT_VALIDATION_FAILED

    with pytest.raises(InsightValidationError) as exc:
        validate_run_request(make_request(), allow_all, raw_body=b"x" * (L.REQUEST_BODY_MAX_BYTES + 1))
    assert _code(exc) == InsightErrorCode.REQUEST_TOO_LARGE


def test_model_allowlist():
    payload = make_request(endpoint_id="default")
    with pytest.raises(InsightValidationError) as exc:
        validate_run_request(payload, allow_all, allowed_endpoint_ids=frozenset({"other"}))
    assert _code(exc) == InsightErrorCode.MODEL_NOT_ALLOWED
    request = validate_run_request(payload, allow_all, allowed_endpoint_ids=frozenset({"default"}))
    assert request.endpoint_id == "default"
    # endpoint 形如 URL 会被 schema 层直接拒绝
    with pytest.raises(InsightValidationError) as exc:
        validate_run_request(make_request(endpoint_id="https://evil.example/v1"), allow_all)
    assert _code(exc) == InsightErrorCode.INVALID_REQUEST


def test_fingerprint_excludes_key_and_client_id(valid_request):
    request = validate_run_request(valid_request, allow_all)
    base = fingerprint_of(request)
    altered = validate_run_request(
        {**valid_request, "idempotency_key": "other-key", "client_request_id": "123e4567-e89b-42d3-a456-426614174000"},
        allow_all,
    )
    assert fingerprint_of(altered) == base


def test_idempotency_replay_and_conflict(valid_request):
    request = validate_run_request(valid_request, allow_all)
    stored = fingerprint_of(request)
    assert resolve_idempotency(None, request) is False
    assert resolve_idempotency(stored, request) is True
    other = validate_run_request({**valid_request, "country": "DE", "slots": {
        "report.context": {**valid_request["slots"]["report.context"], "country": "DE"},
        "report.data": valid_request["slots"]["report.data"],
    }}, lambda pid, c: None)
    with pytest.raises(InsightValidationError) as exc:
        resolve_idempotency(stored, other)
    assert _code(exc) == InsightErrorCode.IDEMPOTENCY_KEY_CONFLICT
