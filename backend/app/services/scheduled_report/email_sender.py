"""Shared utilities for scheduled report email templates."""

from __future__ import annotations

import logging
import re
from typing import Any

logger = logging.getLogger(__name__)


CURRENCY_SYMBOLS: dict[str, str] = {
    "US": "$", "USD": "$",
    "DE": "€", "EUR": "€",
    "UK": "£", "GBP": "£",
}

CURRENCY_CODES: dict[str, str] = {
    "US": "USD", "USD": "USD",
    "DE": "EUR", "EUR": "EUR",
    "UK": "GBP", "GBP": "GBP",
}


def _fmt_currency(val: float, country: str = "US") -> str:
    """格式化货币金额，根据国家/站点自动选择符号。

    Args:
        val: 金额数值
        country: 国家代码（US/DE/UK）或货币代码（USD/EUR/GBP）
    """
    symbol = CURRENCY_SYMBOLS.get(country, "$")
    return f"{symbol}{val:,.2f}"


def _currency_code(country: str = "US") -> str:
    """返回货币代码（USD/EUR/GBP）。"""
    return CURRENCY_CODES.get(country, "USD")


def _color_positive(val: float, good_threshold: float = 0) -> str:
    """绿色正数 / 红色负数（相对于阈值）"""
    return "#16A34A" if val >= good_threshold else "#DC2626"


def _color_delta(positive: bool) -> str:
    return "#16A34A" if positive else "#DC2626"


def _arrow_delta(positive: bool) -> str:
    return "↑" if positive else "↓"


# ── Country code → Chinese name ──────────────────────────────────────────────
_COUNTRY_CN: dict[str, str] = {
    "US": "美国", "UK": "英国", "GB": "英国",
    "DE": "德国", "FR": "法国", "IT": "意大利", "ES": "西班牙",
    "NL": "荷兰", "SE": "瑞典", "PL": "波兰", "BE": "比利时",
    "CA": "加拿大", "AU": "澳大利亚", "JP": "日本", "MX": "墨西哥",
    "EU": "欧洲",
}


def _country_label(country: str) -> str:
    """将国家代码转换为 'XX站' 格式，未知代码直接返回原值 + '站'。"""
    name = _COUNTRY_CN.get(country.upper(), country.upper())
    return f"{name}站"


_COUNTRY_FLAGS: dict[str, str] = {
    "US": "🇺🇸", "UK": "🇬🇧", "GB": "🇬🇧", "DE": "🇩🇪", "FR": "🇫🇷",
    "IT": "🇮🇹", "ES": "🇪🇸", "JP": "🇯🇵", "CA": "🇨🇦", "MX": "🇲🇽",
    "AU": "🇦🇺", "IN": "🇮🇳", "BR": "🇧🇷", "NL": "🇳🇱", "SE": "🇸🇪",
    "PL": "🇵🇱", "TR": "🇹🇷", "SG": "🇸🇬", "AE": "🇦🇪", "BE": "🇧🇪",
    "SA": "🇸🇦", "EU": "🇪🇺",
}


def _render_country_sub_header(country: str) -> str:
    """渲染国家子标题 Badge 行（板块优先布局用）。"""
    label = _country_label(country)
    flag = _COUNTRY_FLAGS.get(country.upper(), "🌐")
    return f"""<tr>
      <td style="padding: 8px 16px 4px;">
        <table cellpadding="0" cellspacing="0" border="0">
          <tr><td style="background: #EFF6FF; border: 1px solid #BFDBFE; border-radius: 4px; padding: 4px 10px; font-size: 13px; font-weight: 600; color: #1D4ED8;">{flag} {label}</td></tr>
        </table>
      </td>
    </tr>"""


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

    # 预处理：将 Unicode bullet（•）转为标准 markdown 列表语法（- ）
    # AI 模型常返回 • 开头的 bullet point，但 mistune 不识别为列表项
    import re as _re
    md_text = _re.sub(r"^[•·●]\s*", "- ", md_text, flags=_re.MULTILINE)

    # 预处理：将单个换行（站点名与数据行之间）转为 markdown 硬换行（两个空格 + \n）
    # 否则 mistune 会把它折叠成空格，站点名和数据会被拼到同一行
    md_text = _re.sub(r"(?<!\n)\n(?!\n)", "  \n", md_text)

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
        "<ul>": '<ul style="margin: 4px 0 8px; padding-left: 20px; list-style: none;">',
        "<ol>": '<ol style="margin: 4px 0 8px; padding-left: 20px; list-style-type: decimal;">',
        "<li>": '<li style="margin-bottom: 6px; line-height: 1.6; display: list-item;"><span style="color: #2563EB; margin-right: 6px;">◉</span>',
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

        if re.match(r"^[-*•·●]\s", stripped):
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


def _scale_html_fonts(html: str, factor: float) -> str:
    """将 HTML 字符串中所有内联 `font-size: Npx` 按 factor 缩放。

    用途：调整手机版邮件/截图的字号，使在小屏设备上更易读。
    只缩放 font-size，不动 padding/margin/max-width（需调用方同步调整容器宽度）。
    """
    def _replace(m: re.Match[str]) -> str:
        px = float(m.group(1))
        return f'font-size: {round(px * factor, 2)}px'

    return re.sub(r"font-size:\s*([\d.]+)px", _replace, html)
