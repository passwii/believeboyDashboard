"""filter_engine TDD tests — FilterCondition → SQLAlchemy where（列白名单防注入）。"""

from __future__ import annotations

import pytest
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.models.crm import CrmCustomer
from app.services.crm.filter_engine import CUSTOMER_FILTER_FIELDS, apply_filters


@pytest.fixture(autouse=True)
def _clean(db_session):
    """每个测试前清空 crm_customers + crm_contacts，避免跨测试脏数据。"""
    from app.db.session import SessionLocal

    s = SessionLocal()
    try:
        s.execute(text("delete from crm_contacts"))
        s.execute(text("delete from crm_customers"))
        s.commit()
    finally:
        s.close()
    yield


def _sql(filters):
    stmt = apply_filters(
        select(CrmCustomer), CrmCustomer, filters, CUSTOMER_FILTER_FIELDS
    )
    return str(stmt.compile(compile_kwargs={"literal_binds": True}))


def _run(filters):
    """真实执行 filter：返回 industry 值列表。"""
    from app.db.session import SessionLocal

    stmt = apply_filters(
        select(CrmCustomer.industry), CrmCustomer, filters, CUSTOMER_FILTER_FIELDS
    )
    s = SessionLocal()
    try:
        rows = s.execute(stmt).all()
    finally:
        s.close()
    return sorted(r[0] for r in rows if r[0] is not None)


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


# ── P5-3 contains 转义 % / _ ──────────────────────────────────────────────────


def _seed_customer(db: Session, name: str, **kw) -> CrmCustomer:
    c = CrmCustomer(name=name, owner_id="u", created_by="u", **kw)
    db.add(c)
    db.flush()
    return c


def test_contains_literal_percent_does_not_match_all():
    """搜 `%` 应只匹配 industry 含字面 % 的，不应匹配所有行。"""
    from app.db.session import SessionLocal

    s = SessionLocal()
    try:
        _seed_customer(s, "Alpha Corp", industry="Alpha Corp")
        _seed_customer(s, "Bravo%Co", industry="Bravo%Co")  # industry 含字面 %
        _seed_customer(s, "Charlie", industry="Charlie")
        s.commit()
    finally:
        s.close()

    matches = _run([{"field": "industry", "op": "contains", "value": "%"}])
    assert matches == ["Bravo%Co"], f"应只匹配字面 %, 实际 {matches}"


def test_contains_escapes_underscore():
    """搜 `_` 应只匹配 industry 含字面 _ 的，不应匹配所有单字符位置。"""
    from app.db.session import SessionLocal

    s = SessionLocal()
    try:
        _seed_customer(s, "foo_bar", industry="foo_bar")  # 含字面 _
        _seed_customer(s, "fooxbar", industry="fooxbar")  # 中间是 x（不应被 _ 匹配）
        _seed_customer(s, "fxxbar", industry="fxxbar")
        s.commit()
    finally:
        s.close()

    matches = _run([{"field": "industry", "op": "contains", "value": "_"}])
    # 如果未转义，_ 匹配任意单字符，会匹到全部三行
    assert matches == ["foo_bar"], f"应只匹配字面 _, 实际 {matches}"


def test_contains_uses_escape_clause():
    """生成的 SQL 应包含 ESCAPE 子句（防默认 escape 行为变更时静默失效）。"""
    sql = _sql([{"field": "industry", "op": "contains", "value": "%"}]).upper()
    assert "ESCAPE" in sql


# ── P5-7 and/or 递归深度上限 ──────────────────────────────────────────────────


def _nested_and(depth: int) -> dict:
    """构造 depth 层 and 嵌套，叶子是一个 eq 条件。"""
    cond: dict = {"field": "status", "op": "eq", "value": "active"}
    for _ in range(depth):
        cond = {"and": [cond]}
    return cond


def _nested_or(depth: int) -> dict:
    cond: dict = {"field": "status", "op": "eq", "value": "active"}
    for _ in range(depth):
        cond = {"or": [cond]}
    return cond


def test_and_max_depth_allowed():
    """MAX_FILTER_DEPTH 层 and 嵌套（叶子 1 + 8 层 and）应不报错。"""
    from app.services.crm.filter_engine import MAX_FILTER_DEPTH

    cond = _nested_and(MAX_FILTER_DEPTH)
    # 不抛异常即通过
    _sql([cond])


def test_and_exceeds_depth_raises_value_error():
    """超过 MAX_FILTER_DEPTH 层 → ValueError。"""
    from app.services.crm.filter_engine import MAX_FILTER_DEPTH

    cond = _nested_and(MAX_FILTER_DEPTH + 1)
    with pytest.raises(ValueError, match="嵌套深度"):
        _sql([cond])


def test_nested_or_at_max_depth_works():
    """刚好 MAX_FILTER_DEPTH 层 + 叶子条件 → 应能正常编译 SQL。"""
    cond = _nested_or(8)
    sql = _sql([cond]).upper()
    assert "STATUS" in sql
