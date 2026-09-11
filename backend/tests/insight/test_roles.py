"""I-3：Role/Slot registry 契约测试。"""

from __future__ import annotations

from dataclasses import replace

import pytest

from app.schemas.insight import InsightErrorCode
from app.services.insight.roles import (
    RoleAvailability,
    RoleLookupError,
    lookup_role,
    require_active,
    role_manifest,
)


def test_schedule_report_summary_resolves_with_deterministic_adapters():
    role = require_active(lookup_role("schedule_report_summary", 1))
    assert role.canonical_key == "schedule_report_summary.v1"
    assert role.required_slots == ("report.context", "report.data")
    assert set(role.optional_slots) == {"project.context", "sku.context"}
    assert role.output_format == "markdown"
    assert role.default_model_policy == "schedule_report_summary.default"
    assert "://" not in role.default_model_policy
    # 同一 slot 返回确定的 adapter / JSON Schema
    first = role.adapter_for("report.context").json_schema()
    second = role.adapter_for("report.context").json_schema()
    assert first == second


def test_unknown_role():
    with pytest.raises(RoleLookupError) as exc:
        lookup_role("nope", 1)
    assert exc.value.code == InsightErrorCode.UNKNOWN_ROLE


def test_unknown_role_version():
    with pytest.raises(RoleLookupError) as exc:
        lookup_role("schedule_report_summary", 99)
    assert exc.value.code == InsightErrorCode.ROLE_VERSION_UNSUPPORTED


def test_migrated_domain_roles_are_runnable():
    """BLF-1016：两个域 role 已从 reserved 提升为可运行。"""
    expected_slots = {
        "ad_analysis": ("ad.context", "ad.data"),
        "inventory_health": ("inventory.context", "inventory.data"),
    }
    for role_id, required_slots in expected_slots.items():
        role = lookup_role(role_id, 1)
        assert role.availability == RoleAvailability.ACTIVE
        assert require_active(role) is role
        assert role.canonical_key == f"{role_id}.v1"
        assert role.required_slots == required_slots


def test_reserved_role_keeps_distinct_error_code():
    """预留 role 与未知 role 报不同码（registry 无 reserved 项时仍须成立）。"""
    reserved = replace(
        lookup_role("schedule_report_summary", 1),
        role_id="future_role",
        availability=RoleAvailability.RESERVED,
    )
    with pytest.raises(RoleLookupError) as exc:
        require_active(reserved)
    assert exc.value.code == InsightErrorCode.ROLE_NOT_AVAILABLE
    with pytest.raises(RoleLookupError) as exc:
        lookup_role("future_role", 1)
    assert exc.value.code == InsightErrorCode.UNKNOWN_ROLE


def test_unknown_slot():
    role = require_active(lookup_role("schedule_report_summary", 1))
    with pytest.raises(RoleLookupError) as exc:
        role.adapter_for("report.evil")
    assert exc.value.code == InsightErrorCode.UNKNOWN_SLOT


def test_manifest_exposes_only_safe_metadata():
    manifest = role_manifest()
    by_key = {entry["canonical_key"]: entry for entry in manifest}
    assert set(by_key) == {
        "schedule_report_summary.v1",
        "ad_analysis.v1",
        "inventory_health.v1",
    }
    blob = str(manifest).lower()
    for leaked in ("system_prompt", "system prompt", "api_key", "base_url", "provider_url", "authorization", "secret"):
        assert leaked not in blob
    # 首个 role 输出键固定为 main（registry 约定）
    assert by_key["schedule_report_summary.v1"]["output_slot"] == "main"
