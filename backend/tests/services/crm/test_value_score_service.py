"""P6a 价值评分服务单元测试 — compute_rating（10）+ update_scores（6）。"""

import pytest
from sqlalchemy import text

from app.db.session import SessionLocal
from app.services.crm.value_score_service import (
    DEFAULT_WEIGHTS,
    GRADE_POINTS,
    SCORE_FIELDS,
    compute_rating,
    update_scores,
)


@pytest.fixture
def customer(db_session):
    row = db_session.execute(
        text(
            "insert into crm_customers (name, created_by) values ('P6A', 't') returning id"
        )
    ).first()
    db_session.commit()
    return int(row[0])


def test_all_a_returns_a():
    assert compute_rating({f: "A" for f in SCORE_FIELDS}) == "A"


def test_all_d_returns_d():
    assert compute_rating({f: "D" for f in SCORE_FIELDS}) == "D"


def test_any_none_returns_none():
    s = {**{f: "A" for f in SCORE_FIELDS}, "score_coop": None}
    assert compute_rating(s) is None


def test_incomplete_one_dim_returns_none():
    s = {"score_scale": "A", "score_pay": "B", "score_fit": None, "score_coop": "A"}
    assert compute_rating(s) is None


def test_mixed_boundaries():
    # 2A+2B = (4+4+3+3)/4 = 3.5 → A
    assert (
        compute_rating(
            {"score_scale": "A", "score_pay": "A", "score_fit": "B", "score_coop": "B"}
        )
        == "A"
    )
    # 1A+2B+1C = (4+3+3+2)/4 = 3.0 → B
    assert (
        compute_rating(
            {"score_scale": "A", "score_pay": "B", "score_fit": "B", "score_coop": "C"}
        )
        == "B"
    )


def test_below_3_5_is_b():
    # A+A+A+D = (4+4+4+1)/4 = 3.25 → B
    assert (
        compute_rating(
            {"score_scale": "A", "score_pay": "A", "score_fit": "A", "score_coop": "D"}
        )
        == "B"
    )


def test_b_and_c_boundaries():
    # B+B+B+C = (3+3+3+2)/4 = 2.75 → B
    assert (
        compute_rating(
            {"score_scale": "B", "score_pay": "B", "score_fit": "B", "score_coop": "C"}
        )
        == "B"
    )
    # C+C+C+D = (2+2+2+1)/4 = 1.75 → C
    assert (
        compute_rating(
            {"score_scale": "C", "score_pay": "C", "score_fit": "C", "score_coop": "D"}
        )
        == "C"
    )


def test_weights_param_changes_result():
    s = {"score_scale": "D", "score_pay": "A", "score_fit": "D", "score_coop": "D"}
    # 等权 (1+4+1+1)/4 = 1.75 → C
    assert compute_rating(s) == "C"
    # 仅看 pay=4 → A
    w = {"score_scale": 0, "score_pay": 1, "score_fit": 0, "score_coop": 0}
    assert compute_rating(s, weights=w) == "A"


def test_extra_keys_ignored():
    s = {**{f: "A" for f in SCORE_FIELDS}, "unknown": "X"}
    assert compute_rating(s) == "A"


def test_constants():
    assert GRADE_POINTS == {"A": 4, "B": 3, "C": 2, "D": 1}
    assert abs(sum(DEFAULT_WEIGHTS.values()) - 1.0) < 1e-9
    assert SCORE_FIELDS == ("score_scale", "score_pay", "score_fit", "score_coop")


# ── update_scores：DB-touching（db_session fixture from conftest.py）──


def test_update_scores_full_set_recomputes(db_session, customer):
    cust, old, changed = update_scores(
        db_session,
        customer,
        {"score_scale": "A", "score_pay": "A", "score_fit": "A", "score_coop": "A"},
        user_id="t",
    )
    # 新行 rating 默认 "C"（DB default），4 维全 A → 重算为 "A"
    assert cust is not None and changed is True and cust.rating == "A" and old == "C"


def test_update_scores_partial_keeps_rating(db_session, customer):
    cust, _old, changed = update_scores(
        db_session, customer, {"score_scale": "A", "score_pay": "A"}, user_id="t"
    )
    # 仅 2 维 → compute_rating 返回 None → rating 保持原值 "C" 不动
    assert cust is not None and changed is False and cust.rating == "C"


def test_update_scores_legacy_rating_overwritten(db_session, customer):
    db_session.execute(
        text("update crm_customers set rating='B' where id=:i"), {"i": customer}
    )
    db_session.commit()
    update_scores(
        db_session,
        customer,
        {"score_scale": "A", "score_pay": "A", "score_fit": "A", "score_coop": "A"},
        user_id="t",
    )
    s = SessionLocal()
    try:
        assert (
            s.execute(
                text("select rating from crm_customers where id=:i"), {"i": customer}
            ).scalar_one()
            == "A"
        )
    finally:
        s.close()


def test_update_scores_invalid_grade_raises(db_session, customer):
    with pytest.raises(ValueError, match="非法档位"):
        update_scores(db_session, customer, {"score_scale": "E"}, user_id="t")


def test_update_scores_customer_not_found(db_session):
    cust, _, changed = update_scores(
        db_session, 999999, {"score_scale": "A"}, user_id="t"
    )
    assert cust is None and changed is False


def test_update_scores_commit_false_no_autocommit(db_session, customer):
    update_scores(
        db_session,
        customer,
        {"score_scale": "A", "score_pay": "A", "score_fit": "A", "score_coop": "A"},
        user_id="t",
        commit=False,
    )
    # commit=False → 仅 flush，新 SessionLocal 读 committed data → rating 仍是 "C"
    s = SessionLocal()
    try:
        assert (
            s.execute(
                text("select rating from crm_customers where id=:i"), {"i": customer}
            ).scalar_one()
            == "C"
        )
    finally:
        s.close()
