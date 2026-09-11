"""Insight Markdown 清洗（域无关）。

canonical run 的终态 markdown 由各域 adapter 的 cleaner 产出；模型常见的
「整篇包在 ```markdown 围栏里」是渲染层噪音，两个域都要处理，故放在
canonical 层共享，避免各域各写一份。
"""

from __future__ import annotations

_FENCE_PREFIXES = ("```markdown", "```md", "```Markdown", "```MD")


def strip_outer_code_fence(markdown: str) -> str:
    """剥离包裹整篇输出的 Markdown 围栏（仅当首尾成对时）。

    只在第一行是 ```/```markdown 围栏**且**最后一行为闭合围栏时剥离，
    正文内部的分段围栏（图表代码块）保持原样。
    """
    text = markdown.strip()
    if not text.startswith("```") or not text.endswith("```"):
        return text
    lines = text.splitlines()
    if len(lines) < 2:
        return text
    first = lines[0].strip()
    if first != "```" and not first.startswith(_FENCE_PREFIXES):
        return text
    # 闭合行必须是最后一行且没有语言标记
    if lines[-1].strip() != "```":
        return text
    return "\n".join(lines[1:-1]).strip()


__all__ = ["strip_outer_code_fence"]
