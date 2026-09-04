"""P6a 价值评分服务：4 维 ABCD → 等权汇总 A/B/C/D（纯函数 + 持久化）。"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.crm import CrmCustomer

GRADE_POINTS: dict[str, int] = {"A": 4, "B": 3, "C": 2, "D": 1}
DEFAULT_WEIGHTS: dict[str, float] = {
    "score_scale": 0.25,
    "score_pay": 0.25,
    "score_fit": 0.25,
    "score_coop": 0.25,
}
SCORE_FIELDS: tuple[str, ...] = ("score_scale", "score_pay", "score_fit", "score_coop")

_VALID_GRADES = frozenset(GRADE_POINTS.keys())


def _validate_scores(scores: dict) -> None:
    for k, v in scores.items():
        if k not in SCORE_FIELDS:
            continue
        if v is None:
            continue
        if v not in _VALID_GRADES:
            raise ValueError(f"非法档位 {k}={v!r}（须为 A/B/C/D 或 null）")


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


def update_scores(
    db: Session,
    customer_id: int,
    scores: dict,
    *,
    user_id: str | None,
    commit: bool = True,
) -> tuple[CrmCustomer | None, str | None, bool]:
    """部分更新 4 维；写入后 4 维全非空 → 重算 rating；否则不动。

    返回 (customer, old_rating, rating_changed)。客户不存在 → (None, None, False)。
    非法档位抛 ValueError。commit=False 仅 flush（端点统一 commit）。
    """
    _validate_scores(scores)
    cust = db.execute(
        select(CrmCustomer).where(
            CrmCustomer.id == customer_id, CrmCustomer.is_deleted.is_(False)
        )
    ).scalar_one_or_none()
    if cust is None:
        return None, None, False
    old_rating = cust.rating
    for k, v in scores.items():
        if k in SCORE_FIELDS and v is not None:
            setattr(cust, k, v)
    db.flush()
    current = {
        "score_scale": cust.score_scale,
        "score_pay": cust.score_pay,
        "score_fit": cust.score_fit,
        "score_coop": cust.score_coop,
    }
    new_rating = compute_rating(current)
    rating_changed = False
    if new_rating is not None and new_rating != cust.rating:
        cust.rating = new_rating
        rating_changed = True
        db.flush()
    if commit:
        db.commit()
    db.refresh(cust)
    return cust, old_rating, rating_changed
