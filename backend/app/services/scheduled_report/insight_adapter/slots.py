"""Schedule Report Insight adapter — typed slot 组装（BLF-1014）。

从 delivery_log / subscription / ledger entry 组装
``schedule_report_summary.v1`` 的 slots：

- ``report.context``（必填）：frequency、报告日期、project 列表、国家。
  日期与数据构建用的 ``reference_date`` 口径一致（weekly/monthly 用锚定日
  本身，daily 用锚定日的前一天——与
  ``ledger_service._summary_reference_date`` 相同）。
- ``report.data``（必填）：数据构建产物（builder 输出的原始 report_data
  JSON），在 worker 侧组装后注入。
- ``project.context``（可选，本 PR 未启用）：项目摘要，数据缺失时整体
  省略（可审计：run detail 的 slots 快照里可见）。

scope 一致性（validator._check_scope_consistency 要求）：run 的
``project_id`` 必须出现在 ``report.context.project_ids`` 里、
``country`` 必须与 ``report.context.country`` 一致。多国家订阅为每个
国家提交一个 run，各自携带该国数据。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Any

from app.models.scheduled_report import (
    ScheduledReportDeliveryLog,
    ScheduledReportLedgerEntry,
    ScheduledReportSubscription,
)
from app.services.scheduled_report.ledger_service import (
    _resolve_effective_ai_model,
    _summary_reference_date,
)


@dataclass(frozen=True)
class ScheduleReportSubject:
    """一个 delivery 的最小定位信息（服务端 subject_ref，不含数据本体）。

    ``ai_model`` 是订阅预设 / 用户覆盖后的生效模型；进入 Insight 请求的
    ``model_id`` 受 allowlist 约束，越界时 provider 层报 MODEL_NOT_ALLOWED。
    """

    log_id: int
    ledger_key: str | None
    frequency: str
    report_date: str
    reference_date: date
    project_ids: list[int] | None
    countries: list[str]
    project_name: str | None
    ai_model: str | None
    date_range: tuple[date, date]

    @classmethod
    def from_delivery(
        cls,
        log: ScheduledReportDeliveryLog,
        subscription: ScheduledReportSubscription,
        *,
        ledger_key: str | None = None,
        expected_date: str | None = None,
        override_ai_model: str | None = None,
    ) -> ScheduleReportSubject:
        """从 delivery_log + subscription 解析定位信息。

        ``expected_date`` 优先于 ``log.report_date``（ledger entry 的口径，
        与旧 ``generate_ai_summary_for_delivery_log`` 一致）。
        """
        frequency = log.frequency
        report_date = expected_date or log.report_date
        reference = _summary_reference_date(report_date, frequency)
        return cls(
            log_id=log.id,
            ledger_key=ledger_key,
            frequency=frequency,
            report_date=report_date,
            reference_date=reference,
            project_ids=subscription.project_id_list or None,
            countries=subscription.country_list,
            project_name=None,
            ai_model=_resolve_effective_ai_model(subscription, override_ai_model),
            date_range=(reference, reference),
        )

    @classmethod
    def from_ledger_entry(
        cls,
        entry: ScheduledReportLedgerEntry,
        log: ScheduledReportDeliveryLog,
        subscription: ScheduledReportSubscription,
        *,
        override_ai_model: str | None = None,
    ) -> ScheduleReportSubject:
        """台账重生成路径：expected_date 以 ledger entry 为准。"""
        return cls.from_delivery(
            log,
            subscription,
            ledger_key=entry.ledger_key,
            expected_date=entry.expected_date,
            override_ai_model=override_ai_model,
        )


def _reference_window(reference: date) -> tuple[date, date]:
    """报告覆盖窗口的展示口径：start=end=数据锚定日。

    展示值仅用于 prompt 语境（与 ledger 的 expected/reference 口径一致）；
    数据本体由 builder 按同一 reference 计算，窗口不参与取数。
    """
    return reference, reference


def report_context_slot(
    subject: ScheduleReportSubject,
    *,
    country: str,
    project_ids: list[int],
) -> dict[str, Any]:
    """``report.context``：报告范围与口径（与 run scope 一致，validator 校验）。"""
    start, end = _reference_window(subject.reference_date)
    return {
        "slot_version": 1,
        "frequency": subject.frequency,
        "report_date": subject.reference_date.isoformat(),
        "date_range_start": start.isoformat(),
        "date_range_end": end.isoformat(),
        "project_ids": project_ids,
        "country": country,
        "project_name": subject.project_name,
    }


def report_data_slot(payload: dict[str, Any]) -> dict[str, Any]:
    """``report.data``：builder 产物原样入 slot（真实 JSON 对象，非字符串化）。"""
    return {
        "slot_version": 1,
        "encoding": "json",
        "payload": payload,
    }


__all__ = [
    "ScheduleReportSubject",
    "report_context_slot",
    "report_data_slot",
]
