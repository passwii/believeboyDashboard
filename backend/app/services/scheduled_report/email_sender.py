"""Shared utilities for scheduled report email templates."""

from __future__ import annotations

import logging
import re
from typing import Any

logger = logging.getLogger(__name__)


def _fmt_currency(val: float) -> str:
    return f"${val:,.2f}"


def _color_positive(val: float, good_threshold: float = 0) -> str:
    """绿色正数 / 红色负数（相对于阈值）"""
    return "#16A34A" if val >= good_threshold else "#DC2626"


def _color_delta(positive: bool) -> str:
    return "#16A34A" if positive else "#DC2626"


def _arrow_delta(positive: bool) -> str:
    return "↑" if positive else "↓"


def _safe_html(text: str) -> str:
    return (text
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;"))


def _markdown_to_email_html(md_text: str) -> str:
    """将 Markdown 文本转换为邮件安全的 HTML（内联样式）。

    使用 mistune 解析后，对输出的 HTML 标签注入内联样式，
    确保在 Gmail / Outlook 等邮件客户端正确渲染。
    如果 mistune 不可用，退回到基础的手动替换。
    """
    if not md_text or not md_text.strip():
        return md_text

    try:
        import mistune
        html = mistune.html(md_text)
    except ImportError:
        logger.warning("mistune not installed, falling back to basic markdown rendering")
        html = _basic_markdown_to_html(md_text)
    except Exception as e:
        logger.warning("Markdown parsing failed, using basic renderer: %s", e)
        html = _basic_markdown_to_html(md_text)

    # 注入邮件安全内联样式
    style_map = {
        "<p>": '<p style="margin: 0 0 8px; line-height: 1.7;">',
        "<strong>": '<strong style="font-weight: 700; color: #111827;">',
        "<em>": '<em style="font-style: italic;">',
        "<ul>": '<ul style="margin: 4px 0 8px; padding-left: 20px; list-style-type: disc;">',
        "<ol>": '<ol style="margin: 4px 0 8px; padding-left: 20px; list-style-type: decimal;">',
        "<li>": '<li style="margin-bottom: 6px; line-height: 1.6; display: list-item;">',
        "<h1>": '<h1 style="font-size: 16px; font-weight: 700; color: #111827; margin: 0 0 6px;">',
        "<h2>": '<h2 style="font-size: 14px; font-weight: 700; color: #111827; margin: 0 0 6px;">',
        "<h3>": '<h3 style="font-size: 13px; font-weight: 700; color: #374151; margin: 0 0 4px;">',
        "<blockquote>": '<blockquote style="margin: 6px 0; padding: 6px 12px; border-left: 3px solid #93C5FD; background: #EFF6FF; font-size: 12px; color: #1E3A5F;">',
        "<hr>": '<hr style="border: none; border-top: 1px solid #E5E7EB; margin: 8px 0;">',
        "<code>": '<code style="background: #F3F4F6; padding: 1px 4px; border-radius: 3px; font-size: 12px; font-family: monospace;">',
    }
    for tag, styled_tag in style_map.items():
        html = html.replace(tag, styled_tag)

    return html.strip()


def _basic_markdown_to_html(md_text: str) -> str:
    """无依赖的基础 Markdown → HTML 转换（作为 mistune 不可用时的 fallback）。"""
    lines = md_text.strip().split("\n")
    html_lines: list[str] = []
    in_list = False

    for line in lines:
        stripped = line.strip()

        if not stripped:
            if in_list:
                html_lines.append("</ul>")
                in_list = False
            html_lines.append("")
            continue

        if stripped.startswith("### "):
            html_lines.append(f"<h3>{_safe_html(stripped[4:])}</h3>")
            continue
        if stripped.startswith("## "):
            html_lines.append(f"<h2>{_safe_html(stripped[3:])}</h2>")
            continue
        if stripped.startswith("# "):
            html_lines.append(f"<h1>{_safe_html(stripped[2:])}</h1>")
            continue

        if re.match(r"^[-*]\s", stripped):
            if not in_list:
                html_lines.append("<ul>")
                in_list = True
            content = _safe_html(stripped[2:].strip())
            content = _inline_markdown(content)
            html_lines.append(f"<li>{content}</li>")
            continue

        m = re.match(r"^(\d+)\.\s", stripped)
        if m:
            if not in_list:
                html_lines.append("<ul>")
                in_list = True
            content = _safe_html(stripped[m.end():].strip())
            content = _inline_markdown(content)
            html_lines.append(f"<li>{content}</li>")
            continue

        if in_list:
            html_lines.append("</ul>")
            in_list = False
        content = _safe_html(stripped)
        content = _inline_markdown(content)
        html_lines.append(f"<p>{content}</p>")

    if in_list:
        html_lines.append("</ul>")

    return "\n".join(html_lines)


def _inline_markdown(text: str) -> str:
    """处理行内 Markdown 格式（加粗、斜体）。"""
    text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"\*(.+?)\*", r"<em>\1</em>", text)
    return text
