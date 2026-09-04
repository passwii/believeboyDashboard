"""SHIPMENT 错误码 + 写前校验 helper（Task 4）。"""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from app.api.agent.errors import AgentApiError, ErrorCode
from app.api.v1.endpoints.agent.shipments import (
    _check_idempotency_header,
    _normalize_items_body,
    _translate_http_exception,
)


class _FakeRequest:
    def __init__(self, idempotency_key: str | None):
        self.headers = {"idempotency-key": idempotency_key} if idempotency_key is not None else {}


class TestErrorCodeMapping:
    def test_new_codes_registered(self):
        assert AgentApiError(ErrorCode.SHIPMENT_DUPLICATE_NO).status_code == 409
        assert AgentApiError(ErrorCode.SHIPMENT_ITEMS_INVALID_SKU).status_code == 400
        assert AgentApiError(ErrorCode.SHIPMENT_ITEMS_MISSING_CARTON_INFO).status_code == 400
        assert AgentApiError(ErrorCode.SHIPMENT_STATUS_INVALID).status_code == 400

    def test_translate_404(self):
        exc = _translate_http_exception(HTTPException(status_code=404, detail="没找到"))
        assert exc.code is ErrorCode.RESOURCE_NOT_FOUND

    def test_translate_409(self):
        exc = _translate_http_exception(HTTPException(status_code=409, detail="货件编号已存在"))
        assert exc.code is ErrorCode.SHIPMENT_DUPLICATE_NO

    def test_translate_400_sku(self):
        exc = _translate_http_exception(
            HTTPException(status_code=400, detail="以下 SKU 未找到可用的 SKU 信息：X-999")
        )
        assert exc.code is ErrorCode.SHIPMENT_ITEMS_INVALID_SKU

    def test_translate_422_generic(self):
        exc = _translate_http_exception(HTTPException(status_code=422, detail="shipment_status 必须是: ..."))
        assert exc.code is ErrorCode.VALIDATION_FAILED
        assert exc.status_code == 400


class TestIdempotencyHeader:
    def test_absent_ok(self):
        _check_idempotency_header(_FakeRequest(None))  # 不抛

    def test_valid_ok(self):
        _check_idempotency_header(_FakeRequest("k" * 64))

    def test_empty_rejected(self):
        with pytest.raises(AgentApiError) as exc:
            _check_idempotency_header(_FakeRequest(""))
        assert exc.value.code is ErrorCode.VALIDATION_FAILED

    def test_too_long_rejected(self):
        with pytest.raises(AgentApiError) as exc:
            _check_idempotency_header(_FakeRequest("k" * 65))
        assert exc.value.code is ErrorCode.VALIDATION_FAILED


class TestNormalizeItemsBody:
    def test_valid(self):
        items = _normalize_items_body(
            {"items": [{"sku": "X-001", "quantity": 10}, {"sku": "X-002", "quantity": 5, "carton_count": 1}]}
        )
        assert items[0]["row_no"] == 1 and items[0]["sku"] == "X-001" and items[0]["quantity"] == 10
        assert items[1]["carton_count"] == 1

    def test_missing_items_rejected(self):
        with pytest.raises(AgentApiError) as exc:
            _normalize_items_body({})
        assert exc.value.code is ErrorCode.VALIDATION_FAILED

    def test_empty_items_rejected(self):
        with pytest.raises(AgentApiError):
            _normalize_items_body({"items": []})

    def test_duplicate_sku_rejected(self):
        with pytest.raises(AgentApiError) as exc:
            _normalize_items_body(
                {"items": [{"sku": "X-001", "quantity": 1}, {"sku": "X-001", "quantity": 2}]}
            )
        assert "重复" in exc.value.human_message

    def test_bad_quantity_rejected(self):
        with pytest.raises(AgentApiError):
            _normalize_items_body({"items": [{"sku": "X-001", "quantity": 0}]})
        with pytest.raises(AgentApiError):
            _normalize_items_body({"items": [{"sku": "X-001", "quantity": "abc"}]})

    def test_bad_carton_count_rejected(self):
        with pytest.raises(AgentApiError) as exc:
            _normalize_items_body({"items": [{"sku": "X-001", "quantity": 1, "carton_count": "abc"}]})
        assert exc.value.code is ErrorCode.VALIDATION_FAILED
        with pytest.raises(AgentApiError):
            _normalize_items_body({"items": [{"sku": "X-001", "quantity": 1, "carton_count": -1}]})
