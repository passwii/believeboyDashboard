"""P6a 价值评分服务：4 维 ABCD → 等权汇总 A/B/C/D（纯函数 + 持久化）。"""

from __future__ import annotations

GRADE_POINTS: dict[str, int] = {"A": 4, "B": 3, "C": 2, "D": 1}
DEFAULT_WEIGHTS: dict[str, float] = {
    "score_scale": 0.25,
    "score_pay": 0.25,
    "score_fit": 0.25,
    "score_coop": 0.25,
}
SCORE_FIELDS: tuple[str, ...] = ("score_scale", "score_pay", "score_fit", "score_coop")


def compute_rating(
    scores: dict[str, str | None],
    weights: dict[str, float] | None = None,
) -> str | None:
    """4 维全非空 → A/B/C/D；任一空 → None。仅识别 SCORE_FIELDS keys。"""
    if any(scores.get(k) is None for k in SCORE_FIELDS):
        return None
    w = weights if weights is not None else DEFAULT_WEIGHTS
    total = sum(GRADE_POINTS[scores[k]] * w[k] for k in SCORE_FIELDS)  # type: ignore[index]
    if total >= 3.5:
        return "A"
    if total >= 2.5:
        return "B"
    if total >= 1.5:
        return "C"
    return "D"
