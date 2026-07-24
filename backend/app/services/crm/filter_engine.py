"""CRM 高级筛选引擎（P4 实用档）：FilterCondition → SQLAlchemy where。

安全核心：列白名单（allowed）。前端字段名必须先映射到模型真实属性名，
非白名单字段/未知运算符一律 ValueError（端点转 400），杜绝 SQL 注入。
"""

from __future__ import annotations

from sqlalchemy import and_, or_

# 前端字段名 → 模型属性名（白名单）。只有列出的字段可筛选。
CUSTOMER_FILTER_FIELDS: dict[str, str] = {
    "status": "status",
    "rating": "rating",
    "customerType": "customer_type",
    "interestedService": "interested_service",
    "source": "source",
    "ownerId": "owner_id",
    "industry": "industry",
    "employeeCount": "employee_count",
    "annualRevenue": "annual_revenue",
}

LEAD_FILTER_FIELDS: dict[str, str] = {
    "status": "status",
    "intent": "intent",
    "customerType": "customer_type",
    "interestedService": "interested_service",
    "source": "source",
    "ownerId": "owner_id",
}

_OPS = {"eq", "neq", "contains", "gt", "lt", "between", "in", "is_null", "is_not_null"}


def apply_filters(stmt, model, filters: list[dict], allowed: dict[str, str]):
    """把 FilterCondition 列表应用到 stmt（追加 where）。filters 为空直接返回。"""
    if not filters:
        return stmt
    return stmt.where(and_(*[_parse_condition(model, f, allowed) for f in filters]))


def _parse_condition(model, cond: dict, allowed: dict[str, str]):
    if "and" in cond:
        return and_(*[_parse_condition(model, c, allowed) for c in cond["and"]])
    if "or" in cond:
        return or_(*[_parse_condition(model, c, allowed) for c in cond["or"]])

    field, op, value = cond.get("field"), cond.get("op"), cond.get("value")
    if op not in _OPS:
        raise ValueError(f"不支持的运算符: {op}")
    attr_name = allowed.get(field)
    if attr_name is None:
        raise ValueError(f"不支持的筛选字段: {field}")
    col = getattr(model, attr_name)

    if op == "eq":
        return col == value
    if op == "neq":
        return col != value
    if op == "contains":
        return col.ilike(f"%{value}%")
    if op == "gt":
        return col > value
    if op == "lt":
        return col < value
    if op == "between":
        lo, hi = value
        return col.between(lo, hi)
    if op == "in":
        return col.in_(list(value))
    if op == "is_null":
        return col.is_(None)
    if op == "is_not_null":
        return col.is_not(None)
    raise ValueError(f"不支持的运算符: {op}")  # pragma: no cover
