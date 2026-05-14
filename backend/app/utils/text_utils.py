"""文本规范化工具。

本模块提供统一的文本处理函数，供所有 service 层使用。
"""
from __future__ import annotations

import re
from typing import Any, Optional

# ─── 文本规范化 ──────────────────────────────────────────────────────────────


def normalize_text(value: Any, max_length: int | None = None) -> str | None:
    """规范化文本：去空格、转 None、处理常见空值标记。

    Args:
        value: 待处理的值
        max_length: 可选的最大长度限制

    Returns:
        规范化后的字符串，空白值返回 None
    """
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    # 常见空值标记（不区分大小写）
    if text.lower() in ("nan", "na", "n/a", "null", "none", "-", "--", ""):
        return None
    if max_length is not None:
        return text[:max_length]
    return text


def normalize_identity(value: Any) -> str:
    """规范化标识符：去空格、转小写、空值返回空字符串。"""
    normalized = normalize_text(value)
    return normalized.lower() if normalized else ""


def _normalize_identity_upper(value: Any) -> str:
    """规范化标识符：去空格、转大写、空值返回空字符串。

    保留此函数是为了兼容性目的。新代码应使用 normalize_identity（小写）。
    """
    normalized = normalize_text(value)
    return normalized.upper() if normalized else ""


def normalize_upper(value: Any) -> str | None:
    """规范化文本为大写。"""
    normalized = normalize_text(value)
    return normalized.upper() if normalized else None


# ─── 特殊格式处理 ────────────────────────────────────────────────────────────


def normalize_asin(value: Any) -> str | None:
    """规范化 ASIN：大写。"""
    normalized = normalize_text(value)
    if not normalized:
        return None
    return normalized.upper()


def normalize_sku(value: Any) -> str | None:
    """规范化 SKU：大写、去除空格。"""
    normalized = normalize_text(value)
    if not normalized:
        return None
    return normalized.upper().replace(" ", "")


def normalize_slug(value: Any) -> Optional[str]:
    """规范化 URL slug：去除特殊字符、转小写。"""
    normalized = normalize_text(value)
    if not normalized:
        return None
    return re.sub(r"[^a-zA-Z0-9\-_]", "-", normalized).strip("-").lower()[:80]