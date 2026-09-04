"""
System Management 服务共享工具。
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

from sqlalchemy import or_, select

from app.models.operation_audit_log import OperationAuditLog


PASSIVE_AUDIT_ACTION_PATTERNS = (
    "%.list",
    "%.view",
)

DATA_STATE_TABLE = "system_management_data_state"
STALE_WINDOW_HOURS = 72

REPORT_MONTH_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")
YEAR_RE = re.compile(r"^\d{4}$")
MULTI_NAME_SPLIT_RE = re.compile(r"[、,，;\n]+")


def _to_iso(value: datetime | str | None) -> str | None:
    """将 datetime 转为 ISO 字符串。"""
    if value is None:
        return None
    if isinstance(value, str):
        return value
    if value.tzinfo is None:
        return value.isoformat(timespec="seconds")
    return value.astimezone().isoformat(timespec="seconds")


def _now() -> datetime:
    """返回当前时间（带时区）。"""
    return datetime.now().astimezone()


def _parse_report_month(value: str) -> str:
    """解析并验证 YYYY-MM 格式的报表月份。"""
    normalized = value.strip()
    if not REPORT_MONTH_RE.match(normalized):
        raise ValueError("report_month must be in YYYY-MM format")
    return normalized


def _parse_year(value: str) -> str:
    """解析并验证 YYYY 格式的年份。"""
    normalized = value.strip()
    if not YEAR_RE.match(normalized):
        raise ValueError("year must be in YYYY format")
    return normalized


def _to_decimal(value: float | int | str, scale: str = "0.000000") -> Decimal:
    """将值转为指定精度的 Decimal。"""
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise ValueError("invalid decimal value") from None
    return parsed.quantize(Decimal(scale), rounding=ROUND_HALF_UP)


def _normalize_rate_decimal(value: Decimal | None) -> Decimal:
    """将比例值规范化为 0~1 之间。"""
    if value is None:
        return Decimal("0")
    if value <= 0:
        return Decimal("0")
    if value >= 1:
        return Decimal("1")
    return value


def _dedupe_names(values: list[str]) -> list[str]:
    """去重并过滤空字符串。"""
    seen: set[str] = set()
    result: list[str] = []
    for item in values:
        normalized = item.strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        result.append(normalized)
    return result


def _split_role_names(value: str | None) -> list[str]:
    """按分隔符拆分角色名称列表。"""
    normalized = (value or "").strip()
    if not normalized:
        return []
    return [
        item.strip() for item in MULTI_NAME_SPLIT_RE.split(normalized) if item.strip()
    ]


def _apply_audit_log_filters(
    stmt,
    *,
    operator: str | None,
    action: str | None,
    target_type: str | None,
    result: str | None,
    keyword: str | None,
):
    """应用审计日志过滤条件。"""
    for pattern in PASSIVE_AUDIT_ACTION_PATTERNS:
        stmt = stmt.where(~OperationAuditLog.action.ilike(pattern))

    normalized_operator = (operator or "").strip()
    if normalized_operator:
        stmt = stmt.where(OperationAuditLog.operator.ilike(f"%{normalized_operator}%"))

    normalized_action = (action or "").strip()
    if normalized_action:
        stmt = stmt.where(OperationAuditLog.action.ilike(f"%{normalized_action}%"))

    normalized_target_type = (target_type or "").strip()
    if normalized_target_type:
        stmt = stmt.where(
            OperationAuditLog.target_type.ilike(f"%{normalized_target_type}%")
        )

    normalized_result = (result or "").strip().lower()
    if normalized_result in {"success", "failure"}:
        stmt = stmt.where(OperationAuditLog.result == normalized_result)

    normalized_keyword = (keyword or "").strip()
    if normalized_keyword:
        like_value = f"%{normalized_keyword}%"
        stmt = stmt.where(
            or_(
                OperationAuditLog.operator.ilike(like_value),
                OperationAuditLog.action.ilike(like_value),
                OperationAuditLog.target_type.ilike(like_value),
                OperationAuditLog.request_path.ilike(like_value),
                OperationAuditLog.target_id.ilike(like_value),
                OperationAuditLog.trace_id.ilike(like_value),
                OperationAuditLog.error_message.ilike(like_value),
            )
        )

    return stmt