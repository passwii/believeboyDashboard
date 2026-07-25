"""filter_engine TDD tests — FilterCondition → SQLAlchemy where（列白名单防注入）。"""

from __future__ import annotations

import pytest
from sqlalchemy import select

from app.models.crm import CrmCustomer
from app.services.crm.filter_engine import CUSTOMER_FILTER_FIELDS, apply_filters


def _sql(filters):
    stmt = apply_filters(
        select(CrmCustomer), CrmCustomer, filters, CUSTOMER_FILTER_FIELDS
    )
    return str(stmt.compile(compile_kwargs={"literal_binds": True}))


def test_eq():
    assert "active" in _sql([{"field": "status", "op": "eq", "value": "active"}])


def test_in():
    assert "IN" in _sql([{"field": "rating", "op": "in", "value": ["A", "B"]}]).upper()


def test_contains_uses_ilike():
    sql = _sql([{"field": "industry", "op": "contains", "value": "电子"}]).upper()
    assert "ILIKE" in sql or "LOWER" in sql


def test_between():
    assert (
        "BETWEEN"
        in _sql(
            [{"field": "employeeCount", "op": "between", "value": [10, 100]}]
        ).upper()
    )


def test_is_null():
    assert (
        "IS NULL"
        in _sql([{"field": "ownerId", "op": "is_null", "value": None}]).upper()
    )


def test_or_nesting():
    sql = _sql(
        [
            {
                "or": [
                    {"field": "status", "op": "eq", "value": "active"},
                    {"field": "rating", "op": "eq", "value": "A"},
                ]
            }
        ]
    ).upper()
    assert " OR " in sql


def test_unknown_field_rejected():
    with pytest.raises(ValueError):
        _sql([{"field": "name; DROP TABLE", "op": "eq", "value": "x"}])


def test_unknown_op_rejected():
    with pytest.raises(ValueError):
        _sql([{"field": "status", "op": "like_evil", "value": "x"}])
