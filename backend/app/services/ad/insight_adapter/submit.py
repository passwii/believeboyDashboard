"""Ad Analysis Insight adapter — run 提交（BLF-1016）。

把「广告分析」从 legacy ``POST /ai-insights/generate``（多轮 ad_agent
pipeline，3–7 次 LLM 调用）切到 canonical ``ad_analysis.v1`` run（单轮）。
provider、run、SSE、重试、取消、持久化全部复用 ``app/services/insight``；
本模块只做三件事：

1. **幂等键**：``ad:{project_id}:{country}:{start}:{end}`` —— 同一分析
   无论重复点击、worker 重启还是重试，都复用同一 run 行（LLM 只扣一次费）。
2. **提交期组装**：聚合产物写进 ``ad.data`` slot（worker 只消费 slots，
   不回查业务库），scope 交给 canonical validator + scope_authorizer。
3. **古典 fallback 保留**：无数据不建假的 run，而是把 ``missing_data``
   显式写进 slot 交由 role 输出「数据不足」章；生成/模型/权限失败沿用
   canonical typed error（``insight_common.submission_error`` 映射 HTTP）。
"""

from __future__ import annotations

import logging
from datetime import date
from typing import Any

from sqlalchemy.orm import Session

from app.schemas.insight import InsightErrorCode
from app.services.ad.insight_adapter.slots import build_ad_slots
from app.services.insight.executor import start_run
from app.services.insight.lifecycle import LifecycleError
from app.services.insight.runs import (
    StaleRunWrite,
    get_run,
    retry_run,
)
from app.services.insight.validator import ScopeError

logger = logging.getLogger(__name__)

#: ad_analysis role 的固定标识（与 roles._REGISTRY 一致）
ROLE_ID = "ad_analysis"
ROLE_VERSION = 1

#: 死掉的 run：行在但不可能再产出内容 → 再次触发必须开新 attempt
#: （completed 相反：已有内容，只 replay 不重复扣费）。
_DEAD_RUN_STATUSES = ("failed", "cancelled")


def idempotency_key_for(
    project_id: int, country: str, start_date: date, end_date: date
) -> str:
    """同一 (项目, 站点, 周期) 的所有触发共享一个幂等键（ASCII ≤64）。"""
    return (
        f"ad:{project_id}:{country.strip().upper()}:"
        f"{start_date.isoformat()}:{end_date.isoformat()}"
    )


def submit_run_for_ad_analysis(
    db: Session,
    *,
    project_id: int,
    country: str,
    start_date: date,
    end_date: date,
    scope_authorizer: Any,
    enqueue: Any = None,
    settings: Any = None,
    model_id: str | None = None,
    progress_cb: Any = None,
    today: date | None = None,
) -> tuple[Any, bool]:
    """提交（或 replay）一个广告分析 run；返回 ``(run, replayed)``。

    失败一律抛 canonical 异常（``InsightValidationError`` /
    ``RoleLookupError`` / ``ScopeError`` / ``InsightProviderError`` /
    ``IdempotencyConflict``），由 HTTP 层用同一码表映射——本模块不定义
    第二套错误语义，也不把 typed error 压成字符串。
    """
    slots = build_ad_slots(
        db,
        project_id=project_id,
        country=country,
        start_date=start_date,
        end_date=end_date,
        today=today,
        progress_cb=progress_cb,
    )
    if slots is None:
        raise ScopeError(InsightErrorCode.PROJECT_NOT_FOUND, "Project not found")

    if enqueue is None:
        # 生产 EnqueueFunc：只建行不入队会让 run 永远停在 queued。
        from app.celery_tasks.insights.run import enqueue_insight_run

        enqueue = enqueue_insight_run

    raw: dict[str, Any] = {
        "schema_version": 1,
        "role_id": ROLE_ID,
        "role_version": ROLE_VERSION,
        "project_id": project_id,
        "country": country,
        "slots": slots,
        "idempotency_key": idempotency_key_for(
            project_id, country, start_date, end_date
        ),
    }
    if model_id:
        raw["model_id"] = model_id

    run, replayed = start_run(
        db=db,
        raw=raw,
        scope_authorizer=scope_authorizer,
        enqueue=enqueue,
        settings=settings,
    )

    if replayed and run.status in _DEAD_RUN_STATUSES:
        # 上一次尝试已失败/被取消：只 replay 会让「重新生成」变成永久空操作。
        # 开新 attempt（同一 run 行 → 前端持有的 run_id 继续有效）并重新派发。
        restarted = False
        try:
            run = retry_run(db, run.run_id)
            db.commit()
            restarted = True
        except (LifecycleError, StaleRunWrite):
            # 并发触发已经把它重启了：本次不重复入队。
            db.rollback()
            run = get_run(db, run.run_id)
        if restarted:
            enqueue(run.run_id, run.attempt)
    return run, replayed


__all__ = [
    "ROLE_ID",
    "ROLE_VERSION",
    "idempotency_key_for",
    "submit_run_for_ad_analysis",
]
