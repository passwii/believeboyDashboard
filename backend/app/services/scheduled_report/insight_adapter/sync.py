"""Schedule Report Insight adapter — 终态回写 delivery_log（BLF-1014）。

Insight run 终态 → ``ScheduledReportDeliveryLog.ai_summary_*`` 的唯一回写点：

- ``completed`` → ai_summary=run.content_markdown、status=done、model=run.model_id
- ``failed``    → status=failed、error=typed error 摘要（安全文本）
- ``cancelled`` → status=pending（用户主动取消不算失败，可再次触发）

调用方：Celery ``generate_delivery_summary``（提交后观察 run 到终态并回写）。
回写以 run 行为准、幂等：重复调用同值覆盖，不产生重复邮件/扣费。
"""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy.orm import Session

from app.models.scheduled_report import AiSummaryStatus, ScheduledReportDeliveryLog
from app.services.insight.runs import InsightRun, to_detail
from app.services.scheduled_report.subscription_service import (
    update_delivery_log_ai_summary,
    update_delivery_log_ai_summary_status,
)

logger = logging.getLogger(__name__)

def _error_text(detail: Any) -> str:
    """typed error → 安全展示文本（无 secret；message 本身受合同约束）。"""
    error = getattr(detail, "error", None)
    if error is None:
        return "AI 摘要生成失败"
    code = getattr(error, "code", None)
    message = getattr(error, "message", "") or "AI 摘要生成失败"
    return f"{getattr(code, 'value', 'UNKNOWN')}: {message}"


def sync_delivery_log_from_run(
    db: Session, log: ScheduledReportDeliveryLog, run: InsightRun
) -> bool:
    """把 run 的当前（通常为终态）状态同步进 delivery_log。

    非终态 run 只同步 generating 标记；返回是否到达终态。
    """
    detail = to_detail(run)
    if detail.status == "completed":
        markdown = (run.content_markdown or "").strip()
        if not markdown:
            # completed 但内容缺失：视为失败，不写空摘要。
            update_delivery_log_ai_summary_status(
                db,
                log.id,
                AiSummaryStatus.FAILED.value,
                error_message="AI 摘要内容为空",
                ai_model=run.model_id,
            )
            return True
        update_delivery_log_ai_summary(
            db, log.id, markdown, ai_model=run.model_id
        )
        return True
    if detail.status == "failed":
        update_delivery_log_ai_summary_status(
            db,
            log.id,
            AiSummaryStatus.FAILED.value,
            error_message=_error_text(detail),
            ai_model=run.model_id,
        )
        return True
    if detail.status == "cancelled":
        # 主动取消回到 pending：不算失败，允许再次触发生成。
        update_delivery_log_ai_summary_status(
            db, log.id, AiSummaryStatus.PENDING.value, ai_model=run.model_id
        )
        return True
    if log.ai_summary_status != AiSummaryStatus.GENERATING.value:
        update_delivery_log_ai_summary_status(
            db, log.id, AiSummaryStatus.GENERATING.value, ai_model=run.model_id
        )
    return False


__all__ = ["sync_delivery_log_from_run"]
