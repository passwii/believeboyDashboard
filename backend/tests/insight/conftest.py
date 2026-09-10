"""Insight 合同测试共享 fixture：合法请求体与 scope authorizer。"""

from __future__ import annotations

import pytest


def make_request(**overrides):
    payload = {
        "schema_version": 1,
        "role_id": "schedule_report_summary",
        "role_version": 1,
        "project_id": 42,
        "country": "US",
        "slots": {
            "report.context": {
                "slot_version": 1,
                "frequency": "weekly",
                "report_date": "2026-09-09",
                "date_range_start": "2026-09-01",
                "date_range_end": "2026-09-07",
                "project_ids": [42],
                "country": "US",
            },
            "report.data": {
                "slot_version": 1,
                "encoding": "json",
                "payload": {"current_week": {"qty": 12}},
            },
        },
        "idempotency_key": "schedule-20260909-42-weekly-1",
    }
    payload.update(overrides)
    return payload


def allow_all(project_id: int, country: str) -> None:
    return None


@pytest.fixture
def valid_request():
    return make_request()
