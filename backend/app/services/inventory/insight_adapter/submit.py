"""Inventory Health Insight adapter — run 提交（BLF-1016）。

库存洞察在旧系统里**不存在 LLM 链路**，所以这里没有可冻结的旧写端点；
本模块的职责是把确定性补货分析的结果送进 canonical run：

1. **幂等键**：``inventory:{project_id}:{country}:{report_date}`` ——
   同一天同一站点重复触发只复用同一 run（LLM 只扣一次费）。
2. **提交期组装**：确定性分析产物写进 ``inventory.data`` slot；worker
   只消费 slots，不回查业务表。
3. **降级语义**：项目不存在 → ``ScopeError(PROJECT_NOT_FOUND)``；权限与
   国家不一致交给 canonical validator/authorizer；无快照/无 SKU 不阻断
   run（``missing_data`` 会进 slot 让 role 输出「数据不足」）。
"""

from __future__ import annotations

import logging
from datetime import date
from typing import Any

from sqlalchemy.orm import Session

from app.schemas.insight import InsightErrorCode
from app.services.insight.executor import start_run
from app.services.insight.lifecycle import LifecycleError
from app.services.insight.runs import StaleRunWrite, get_run, retry_run
from app.services.insight.validator import ScopeError
from app.services.inventory.insight_adapter.slots import (
    build_inventory_slots,
    normalize_inventory_country,
)

logger = logging.getLogger(__name__)

#: inventory_health role 的固定标识（与 roles._REGISTRY 一致）
ROLE_ID = "inventory_health"
ROLE_VERSION = 1

#: 死掉的 run：行在但不可能再产出内容 → 再次触发必须开新 attempt。
_DEAD_RUN_STATUSES = ("failed", "cancelled")


def idempotency_key_for(
    project_id: int, country: str, report_date: date | None
) -> str:
    """同一 (项目, 站点, 口径日期) 的所有触发共享一个幂等键（ASCII ≤64）。"""
    stamp = (report_date or date.today()).isoformat()
    return f"inventory:{project_id}:{normalize_inventory_country(country)}:{stamp}"


def submit_run_for_inventory_health(
    db: Session,
    *,
    project_id: int,
    country: str,
    report_date: date | None = None,
    scope_authorizer: Any,
    enqueue: Any = None,
    settings: Any = None,
    model_id: str | None = None,
    today: date | None = None,
) -> tuple[Any, bool]:
    """提交（或 replay）一个库存健康 run；返回 ``(run, replayed)``。

    失败抛 canonical 异常（``InsightValidationError`` /
    ``RoleLookupError`` / ``ScopeError`` / ``InsightProviderError`` /
    ``IdempotencyConflict``），HTTP 层用同一码表映射；本模块不定义第二套
    错误语义，也不把 typed error 压成字符串。
    """
    normalized_country = normalize_inventory_country(country)
    # 授权必须在读业务表之前：``build_inventory_slots`` 会跑补货分析查询，
    # 未授权 operator 否则能借提交端点读走不属于自己的数据（复审[1]）。
    # 这里用**归一后**的站点：slot 与 run 都用它，authorizer 的
    # ``row.country == country`` 判定必须与之一致，否则会凭空 409。
    # canonical validator 的二次校验保留（defense in depth）。
    scope_authorizer(project_id, normalized_country)
    slots = build_inventory_slots(
        db,
        project_id=project_id,
        country=normalized_country,
        report_date=report_date,
        today=today,
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
        "country": normalized_country,
        "slots": slots,
        "idempotency_key": idempotency_key_for(
            project_id, normalized_country, report_date
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
        restarted = False
        try:
            run = retry_run(db, run.run_id)
            db.commit()
            restarted = True
        except (LifecycleError, StaleRunWrite):
            db.rollback()
            run = get_run(db, run.run_id)
        if restarted:
            enqueue(run.run_id, run.attempt)
    return run, replayed


__all__ = [
    "ROLE_ID",
    "ROLE_VERSION",
    "idempotency_key_for",
    "submit_run_for_inventory_health",
]
