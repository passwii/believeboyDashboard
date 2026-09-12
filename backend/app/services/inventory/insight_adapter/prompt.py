"""Inventory Health role 的 server-owned prompt 模板（BLF-1016）。

Stage 1 冻结的 role registry 不存 prompt 文本；本模块是
``inventory_health.v1`` 的服务端模板实现，由 ``executor.role_runtime_for``
按 role_id 注入。客户端永远接触不到这些文本。

口径：单轮生成（用户内容 = 口径说明 + 确定性分析 JSON；系统指令 = 固定
分析框架）。库存状态/动作的判定规则属于确定性层（``state_action``），
模型只**解释**给定结论，不重新判定——这保证同一份快照下模型不会翻转
REPLENISH_NOW 这类结论。
"""

from __future__ import annotations

from typing import Any

from app.services.insight.contracts import to_canonical_json
from app.services.insight.markdown import strip_outer_code_fence
from app.services.insight.roles import InsightRoleDefinition

_INVENTORY_SYSTEM_PROMPT = """\
你是亚马逊库存与补货分析专家。基于给出的库存快照与确定性补货分析结果，
输出一份直接给运营负责人阅读的 Markdown 分析。

输出结构（固定五段，标题保持中文）：
## 库存概览
## 风险分层
## 补货建议
## 库龄与资金占用
## 数据局限

硬性规则：
- 只能使用给定数据里的数字，禁止编造、外推或引用未提供的行业基准。
- 每条结论必须可追溯到具体字段（如 sellable_days、dms_30、available_inventory、
  in_transit_quantity、risk_status、inventory_state、replenishment_action）。
- inventory_state 与 replenishment_action 是系统确定性判定的结论，直接采信：
  可以做解释、排序和取舍，不得改写或推翻。decision_path 解释了判定依据，
  引用它说明理由。
- 「库存概览」必须写明站点、口径日期、快照日期与新鲜度状态。
- data_freshness.status 不是 fresh 时，必须在「数据局限」写明滞后天数，
  并提示结论可能不反映当前库存。
- missing_data.is_complete 为 false 时，对缺失维度明确写「数据不足」，
  不得用估算值替代。
- payload.rows_truncated 为 true 时，说明 SKU 明细只覆盖最紧急的
  row_limit 条（summary 仍是全量口径），结论不得据此断言全体 SKU。
- 只输出 Markdown 正文：不要前言、不要结语寒暄、不要用代码围栏包裹整篇。
"""


def inventory_health_instructions(
    role: InsightRoleDefinition, slots: dict[str, Any]
) -> tuple[str, ...]:
    """固定 system 指令（tuple 供 Agent(instructions=)）。"""
    return (_INVENTORY_SYSTEM_PROMPT,)


def build_inventory_health_prompt(
    role: InsightRoleDefinition, slots: dict[str, Any]
) -> str:
    """role slots → 用户内容：口径说明 + 确定性分析 JSON。"""
    context = slots.get("inventory.context") or {}
    data_slot = slots.get("inventory.data") or {}
    payload = data_slot.get("payload")
    if not isinstance(payload, dict):
        payload = {}
    scope_lines = [
        f"- 项目：{context.get('project_name') or '未知'}（project_id={context.get('project_ids')}）",
        f"- 站点：{context.get('country')}",
        f"- 口径日期：{context.get('report_date')}",
        f"- 数据新鲜度：{to_canonical_json(context.get('data_freshness') or {})}",
        f"- 缺数状态：{to_canonical_json(context.get('missing_data') or {})}",
    ]
    return (
        "请分析以下库存与补货数据。\n\n"
        "## 分析口径\n" + "\n".join(scope_lines) + "\n\n"
        "## 确定性分析结果\n" + to_canonical_json(payload) + "\n"
    )


def clean_inventory_health_markdown(
    role: InsightRoleDefinition, markdown: str
) -> str:
    """终态落库前的输出清洗：剥离整篇代码围栏 + strip。"""
    return strip_outer_code_fence(markdown)


__all__ = [
    "build_inventory_health_prompt",
    "clean_inventory_health_markdown",
    "inventory_health_instructions",
]
