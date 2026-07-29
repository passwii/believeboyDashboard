"""P6a 价值评分服务单元测试 — 纯函数 compute_rating（9 用例）。"""

from app.services.crm.value_score_service import (
    GRADE_POINTS,
    DEFAULT_WEIGHTS,
    SCORE_FIELDS,
    compute_rating,
)


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
