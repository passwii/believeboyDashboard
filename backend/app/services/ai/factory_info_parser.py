"""
AI Factory Info Parser - 将自然语言描述解析为 JSON 格式的产品属性
"""

from __future__ import annotations

import json
from typing import Any

from app.core.config import Settings
from app.schemas.ai_chat import LLMConfigInput

# 系统提示词
FACTORY_INFO_PARSE_SYSTEM_PROMPT = """你是一位跨境电商产品属性专家。

## 任务
将用户输入的自然语言产品属性描述，解析为结构化的 JSON 键值对格式。

## 输入示例
- 用户输入："电压220V，功率1500W，防水等级IP65"
- 解析为：{"电压": "220V", "功率": "1500W", "防水等级": "IP65"}

- 用户输入："材质: ABS塑料, 颜色: 黑色, 尺寸: 30x20x10cm"
- 解析为：{"材质": "ABS塑料", "颜色": "黑色", "尺寸": "30x20x10cm"}

- 用户输入："包装彩盒，配件说明书x1，螺丝x4"
- 解析为：{"包装": "彩盒", "配件": "说明书x1, 螺丝x4"}

## 输出要求
1. 直接输出 JSON 格式，不要包含任何解释文字
2. 属性名使用中文，保持简洁
3. 属性值保持原样，不要添加额外说明
4. 如果输入中有多条相似属性（如多个配件），可以合并为一个列表值
5. 如果无法解析，输出空对象 {}

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


def parse_factory_info_sync(
    description: str,
    settings: Settings,
) -> dict[str, str] | None:
    """
    同步解析自然语言描述。
    返回解析后的 JSON 对象，解析失败返回 None。

    Args:
        description: 自然语言描述
        settings: 应用配置

    Returns:
        解析后的键值对字典，失败返回 None
    """
    from app.services.ai.llm import build_llm_config, generate_assistant_content

    if not description.strip():
        return None

    try:
        llm_config = build_llm_config(
            settings=settings,
            model=None,  # 使用默认模型
            system_prompt=FACTORY_INFO_PARSE_SYSTEM_PROMPT,
        )

        # 创建模拟的消息对象（用于 build_payload_messages）
        # 由于 messages 参数类型是 list[AIMessage]，需要构造空列表
        from app.models.ai_chat import AIMessage

        result = generate_assistant_content(
            llm_config,
            messages=[],  # 此场景无历史消息
            user_content=description,
        )

        # 尝试解析 JSON
        result = _trim_markdown_json(result)
        parsed = json.loads(result)
        if isinstance(parsed, dict):
            return {k: str(v) for k, v in parsed.items() if k and v is not None}
        return None

    except (json.JSONDecodeError, Exception):
        return None


def parse_factory_info_stream(
    description: str,
    settings: Settings,
):
    """
    将自然语言描述解析为 JSON 键值对。
    返回生成器，产生流式文本块。

    注意：当前实现返回同步结果的字符串版本。
    如需真正的流式输出，需要修改 LLM 调用逻辑。
    """
    # 直接调用同步版本并逐字符 yield
    result = parse_factory_info_sync(description, settings)
    if result:
        import json
        json_str = json.dumps(result, ensure_ascii=False)
        for char in json_str:
            yield char