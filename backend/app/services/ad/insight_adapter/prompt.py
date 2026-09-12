"""Ad Analysis role 的 server-owned prompt 模板（BLF-1016）。

Stage 1 冻结的 role registry 不存 prompt 文本；本模块是
``ad_analysis.v1`` 的服务端模板实现，由 ``executor.role_runtime_for``
按 role_id 注入。客户端永远接触不到这些文本（合同：客户端不得提交
system prompt；manifest/fixture 不含 prompt）。

口径：单轮生成（用户内容 = 范围说明 + 裁剪后的聚合 JSON；系统指令 =
固定分析框架）。legacy 的多轮 ad_agent pipeline 留在旧链路，本 role
不复制其分轮逻辑，只保证同一份聚合数据在 canonical 侧产出一份可读
分析。
"""

from __future__ import annotations

from typing import Any

from app.services.insight.contracts import to_canonical_json
from app.services.insight.markdown import strip_outer_code_fence
from app.services.insight.roles import InsightRoleDefinition

_AD_SYSTEM_PROMPT = """\
你是亚马逊广告投放分析专家。基于给出的项目广告聚合数据，输出一份直接给运营负责人阅读的 Markdown 分析。

输出结构（固定五段，标题保持中文）：
## 数据概览
## 关键发现
## 问题诊断
## 行动建议
## 数据局限

硬性规则：
- 只能使用给定数据里的数字，禁止编造、外推或引用未提供的行业基准。
- 每条结论必须可追溯到具体指标（如 ad_spend、ad_sales、ACoS、CTR、转化率）。
- 「数据概览」必须写明站点、分析周期、数据覆盖率与新鲜度状态。
- data_freshness.status 不是 fresh 时，必须在「数据局限」说明滞后天数或覆盖率缺口。
- missing_data.is_complete 为 false 时，对缺失维度明确写「数据不足」，不得用估算值替代。
- payload.truncated_sections 非空时，说明哪些列表被截断、结论仅基于头部数据。
- 若 ad_series 缺失（无任何广告数据），只输出数据不足的说明，不给出投放建议。
- 只输出 Markdown 正文：不要前言、不要结语寒暄、不要用代码围栏包裹整篇。
"""


def ad_analysis_instructions(
    role: InsightRoleDefinition, slots: dict[str, Any]
) -> tuple[str, ...]:
    """固定 system 指令（tuple 供 Agent(instructions=)）。"""
    return (_AD_SYSTEM_PROMPT,)


def build_ad_analysis_prompt(
    role: InsightRoleDefinition, slots: dict[str, Any]
) -> str:
    """role slots → 用户内容：范围口径 + 裁剪后的聚合数据 JSON。"""
    context = slots.get("ad.context") or {}
    data_slot = slots.get("ad.data") or {}
    payload = data_slot.get("payload")
    if not isinstance(payload, dict):
        payload = {}
    scope_lines = [
        f"- 项目：{context.get('project_name') or '未知'}（project_id={context.get('project_ids')}）",
        f"- 站点：{context.get('country')}",
        f"- 周期：{context.get('date_range_start')} ~ {context.get('date_range_end')}",
        f"- 数据新鲜度：{to_canonical_json(context.get('data_freshness') or {})}",
        f"- 缺数状态：{to_canonical_json(context.get('missing_data') or {})}",
    ]
    return (
        "请分析以下广告数据。\n\n"
        "## 分析范围\n" + "\n".join(scope_lines) + "\n\n"
        "## 聚合数据\n" + to_canonical_json(payload) + "\n"
    )


def clean_ad_analysis_markdown(role: InsightRoleDefinition, markdown: str) -> str:
    """终态落库前的输出清洗：剥离整篇代码围栏 + strip。"""
    return strip_outer_code_fence(markdown)


__all__ = [
    "ad_analysis_instructions",
    "build_ad_analysis_prompt",
    "clean_ad_analysis_markdown",
]
