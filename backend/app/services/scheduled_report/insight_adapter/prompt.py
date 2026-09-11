"""Schedule report summary role 的 server-owned prompt 模板（BLF-1014）。

Stage 1 冻结的 role registry 不存 prompt 文本；本模块是
``schedule_report_summary.v1`` 的服务端模板实现，由 executor 按
role_id 选择注入。客户端永远接触不到这些文本（合同：客户端不得提交
system prompt；manifest/fixture 不含 prompt）。

输出清洗口径与旧 `ai_schedule_report._call_ai_inner` 一致：
- 用户内容：数据 JSON + 货币对照表（daily）+ 项目背景三段；
- 系统指令：按 frequency 的冻结 SYSTEM_PROMPT（同
  ``ai_schedule_report.SYSTEM_PROMPTS``）；
- daily 的输出清洗（去元信息污染）由 executor 在落库前统一应用
  （见 ``clean_markdown``）。
"""

from __future__ import annotations

import logging
from typing import Any

from app.services.insight.roles import InsightRoleDefinition
from app.services.scheduled_report.ai_schedule_report import (
    SYSTEM_PROMPTS,
    _build_user_content,
)
from app.services.scheduled_report.ai_schedule_report import (
    _clean_ai_output as clean_markdown,
)

logger = logging.getLogger(__name__)


def build_schedule_report_prompt(
    role: InsightRoleDefinition, slots: dict[str, Any]
) -> str:
    """role slots → 用户内容（与旧 _build_user_content 同口径）。

    ``report.data.payload`` 是数据本体；``report.context`` 提供
    frequency/country 等口径信息。旧口径中 project_context /
    sku_context / sku_factory_info_text 是 payload 的三个键，这里把
    payload 原样传给旧构建器，形状零改动。
    """
    context = slots.get("report.context") or {}
    data_slot = slots.get("report.data") or {}
    payload = data_slot.get("payload")
    if not isinstance(payload, dict):
        payload = {}
    frequency = str(context.get("frequency") or "daily")
    return _build_user_content(frequency, payload)


def schedule_report_instructions(
    role: InsightRoleDefinition, slots: dict[str, Any]
) -> tuple[str, ...]:
    """按 frequency 取冻结 system prompt（tuple 供 Agent(instructions=)）。"""
    context = slots.get("report.context") or {}
    frequency = str(context.get("frequency") or "daily")
    prompt = SYSTEM_PROMPTS.get(frequency, SYSTEM_PROMPTS["daily"])
    return (prompt,)


def clean_schedule_report_markdown(role: InsightRoleDefinition, markdown: str) -> str:
    """终态落库前的输出清洗：daily 去元信息污染，其余原样 strip。"""
    return clean_markdown(markdown)


__all__ = [
    "build_schedule_report_prompt",
    "clean_schedule_report_markdown",
    "schedule_report_instructions",
]
