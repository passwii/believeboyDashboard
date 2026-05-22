"""
AI Context Parser - 将自然语言描述解析为项目背景配置的 Key-Value 结构
"""

from __future__ import annotations

import json
from typing import Any

from app.core.config import Settings


# 系统提示词
CONTEXT_PARSE_SYSTEM_PROMPT = """你是一位跨境电商项目背景配置专家。

## 任务
将用户输入的自然语言项目背景描述，解析为 Key-Value 格式的 JSON 对象。

## 设计理念
- 每个维度是一个 Key（维度名称），值是对应的描述内容
- Key 应该简洁明了，便于后续 AI 读取理解
- Value 应该是完整的、可独立理解的段落
- 维度可以灵活扩展，不限于固定类别

## Key 命名建议
- 工厂供货、季节性、增长趋势、风险备注、项目优势、团队配置、竞品分析、物流方案、资金安排等
- 也可以用更具体的名称如"供应商信息"、"旺季节奏"、"新品开发周期"等

## 输入示例
输入: "深圳华强北供应商，月产能 5000 件，旺季可扩到 8000。交货周期 15 天，淡季 10 天。对接人王经理响应快。旺季是 11-12 月礼品季，3-4 月开学季，需要提前 2 个月备货。淡季 6-8 月可以考虑清库存。去年增长率 30%，主要是新品上线带动。新品开发周期 3 周。目前库存周转率偏低，风险是交期延误。"

输出:
{
  "工厂供货": "深圳华强北供应商，标准交货周期 15 天，淡季可压缩至 10 天",
  "生产能力": "月产能 5000 件，旺季峰值 8000 件",
  "对接沟通": "对接人王经理，响应速度快，配合度好",
  "季节性": "旺季 11-12 月礼品季、3-4 月开学季；淡季 6-8 月",
  "备货策略": "旺季提前 2 个月备货，淡季考虑清库存",
  "增长趋势": "去年增长率 30%，主要由新品上线带动",
  "新品开发": "新品开发周期 3 周",
  "风险备注": "当前库存周转率偏低，存在交期延误风险"
}

## 输出要求
1. 直接输出 JSON 格式，不要包含任何解释文字
2. Key 使用中文，简洁明了（1-4 个字为佳）
3. Value 是完整的段落，可以包含具体数值和时间
4. 相同的语义信息合并到一个 Key 下，不要重复
5. 如果信息量较少，至少生成 2-3 个有意义的 Key
6. 如果输入信息非常少或不明确，至少返回一个空对象 {}

## 输出格式
只输出 JSON，不要有其他内容。"""


def _trim_markdown_json(text: str) -> str:
    """移除 markdown 代码块包装"""
    result = text.strip()
    if result.startswith("```json"):
        result = result[7:]
    elif result.startswith("```"):
        result = result[3:]
    if result.endswith("```"):
        result = result[:-3]
    return result.strip()


def parse_context_sync(
    description: str,
    settings: Settings,
) -> dict[str, str] | None:
    """
    同步解析自然语言描述。
    返回解析后的 Key-Value 对象，解析失败返回 None。

    Args:
        description: 自然语言描述
        settings: 应用配置

    Returns:
        解析后的 Key-Value 字典，失败返回 None
    """
    from app.services.ai.llm import build_llm_config, generate_assistant_content

    if not description.strip():
        return None

    try:
        llm_config = build_llm_config(
            settings=settings,
            model=None,
            system_prompt=CONTEXT_PARSE_SYSTEM_PROMPT,
        )

        result = generate_assistant_content(
            llm_config,
            messages=[],
            user_content=description,
        )

        result = _trim_markdown_json(result)
        parsed = json.loads(result)
        
        if isinstance(parsed, dict):
            # 确保是 string -> string 的映射
            return {str(k): str(v) for k, v in parsed.items() if k and v is not None}
        return None

    except (json.JSONDecodeError, Exception):
        return None
