"""Insight Role/Slot registry：代码化、版本化的单一只读来源。

- Role 决定允许的 input slots、输出格式和默认模型策略。
- server-side system instruction 只保留在内部实现（Stage 4 adapter），
  永不出现在 manifest / response / fixture / 日志中——本模块不存任何 prompt 文本。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from pydantic import TypeAdapter

from app.schemas.insight import InsightErrorCode
from app.services.insight.slot_types import (
    ProjectContextSlot,
    ReportContextSlot,
    ReportDataSlot,
    SkuContextSlot,
)


class RoleAvailability(str, Enum):
    ACTIVE = "active"
    RESERVED = "reserved"


class RoleLookupError(Exception):
    """registry 查询失败：携带固定错误码，由 validator 转为 typed error。"""

    def __init__(self, code: InsightErrorCode, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class InsightRoleDefinition:
    role_id: str
    role_version: int
    availability: RoleAvailability
    required_slots: tuple[str, ...]
    optional_slots: tuple[str, ...]
    slot_adapters: dict[str, TypeAdapter[Any]] = field(compare=False, repr=False)
    output_format: str = "markdown"
    output_slot: str = "main"
    default_model_policy: str = ""

    @property
    def canonical_key(self) -> str:
        return f"{self.role_id}.v{self.role_version}"

    @property
    def allowed_slots(self) -> tuple[str, ...]:
        return self.required_slots + self.optional_slots

    def adapter_for(self, slot_name: str) -> TypeAdapter[Any]:
        try:
            return self.slot_adapters[slot_name]
        except KeyError:
            raise RoleLookupError(
                InsightErrorCode.UNKNOWN_SLOT,
                f"slot '{slot_name}' is not registered for role '{self.canonical_key}'",
            ) from None


def _schedule_report_summary() -> InsightRoleDefinition:
    return InsightRoleDefinition(
        role_id="schedule_report_summary",
        role_version=1,
        availability=RoleAvailability.ACTIVE,
        required_slots=("report.context", "report.data"),
        optional_slots=("project.context", "sku.context"),
        slot_adapters={
            "report.context": TypeAdapter(ReportContextSlot),
            "report.data": TypeAdapter(ReportDataSlot),
            "project.context": TypeAdapter(ProjectContextSlot),
            "sku.context": TypeAdapter(SkuContextSlot),
        },
        output_format="markdown",
        output_slot="main",
        default_model_policy="schedule_report_summary.default",
    )


def _reserved(role_id: str) -> InsightRoleDefinition:
    return InsightRoleDefinition(
        role_id=role_id,
        role_version=1,
        availability=RoleAvailability.RESERVED,
        required_slots=(),
        optional_slots=(),
        slot_adapters={},
        output_format="markdown",
        output_slot="main",
        default_model_policy=f"{role_id}.default",
    )


_REGISTRY: dict[tuple[str, int], InsightRoleDefinition] = {
    ("schedule_report_summary", 1): _schedule_report_summary(),
    ("ad_analysis", 1): _reserved("ad_analysis"),
    ("inventory_health", 1): _reserved("inventory_health"),
}


def lookup_role(role_id: str, role_version: int) -> InsightRoleDefinition:
    """解析 role：未知 role → UNKNOWN_ROLE；已知 role 未知版本 → ROLE_VERSION_UNSUPPORTED。"""
    known_versions = [v for (rid, v) in _REGISTRY if rid == role_id]
    if not known_versions:
        raise RoleLookupError(InsightErrorCode.UNKNOWN_ROLE, f"unknown role '{role_id}'")
    try:
        return _REGISTRY[(role_id, role_version)]
    except KeyError:
        raise RoleLookupError(
            InsightErrorCode.ROLE_VERSION_UNSUPPORTED,
            f"role '{role_id}' has no version {role_version}",
        ) from None


def require_active(role: InsightRoleDefinition) -> InsightRoleDefinition:
    """预留 role 不可运行 → ROLE_NOT_AVAILABLE（与 UNKNOWN_ROLE 区分）。"""
    if role.availability != RoleAvailability.ACTIVE:
        raise RoleLookupError(
            InsightErrorCode.ROLE_NOT_AVAILABLE,
            f"role '{role.canonical_key}' is reserved and not runnable",
        )
    return role


def role_manifest() -> list[dict[str, Any]]:
    """对外 manifest：只暴露角色/slot/version/format/limits，不含任何 prompt/secret。"""
    manifest: list[dict[str, Any]] = []
    for (role_id, role_version), role in sorted(_REGISTRY.items()):
        manifest.append(
            {
                "role_id": role_id,
                "role_version": role_version,
                "canonical_key": role.canonical_key,
                "availability": role.availability.value,
                "required_slots": list(role.required_slots),
                "optional_slots": list(role.optional_slots),
                "output_format": role.output_format,
                "output_slot": role.output_slot,
                "default_model_policy": role.default_model_policy,
            }
        )
    return manifest
