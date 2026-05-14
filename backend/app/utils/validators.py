"""通用参数校验工具。

提供跨 service 复用的参数校验函数，减少散落在各处的重复校验逻辑。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any


# ─── 分页参数校验 ────────────────────────────────────────────────────────────


def validate_page(page: int, *, minimum: int = 1) -> int:
    """校验页码。

    Args:
        page: 页码
        minimum: 最小允许值，默认 1

    Returns:
        校验通过的页码

    Raises:
        ValueError: 页码小于 minimum
    """
    if page < minimum:
        raise ValueError(f"page must be >= {minimum}, got {page}")
    return page


def validate_page_size(
    page_size: int,
    *,
    minimum: int = 1,
    maximum: int = 500,
) -> int:
    """校验每页条数。

    Args:
        page_size: 每页条数
        minimum: 最小允许值，默认 1
        maximum: 最大允许值，默认 500

    Returns:
        校验通过的每页条数

    Raises:
        ValueError: 每页条数超出 [minimum, maximum] 范围
    """
    if page_size < minimum or page_size > maximum:
        raise ValueError(f"page_size must be between {minimum} and {maximum}, got {page_size}")
    return page_size


def clamp_page_size(page_size: int, *, minimum: int = 1, maximum: int = 500) -> int:
    """将每页条数限制在 [minimum, maximum] 范围内（不抛异常，自动修正）。

    Args:
        page_size: 每页条数
        minimum: 最小值，默认 1
        maximum: 最大值，默认 500

    Returns:
        修正后的每页条数
    """
    return max(minimum, min(page_size, maximum))


# ─── 日期范围校验 ────────────────────────────────────────────────────────────


def validate_date_range(
    date_from: date | None,
    date_to: date | None,
    *,
    allow_none: bool = False,
) -> tuple[date, date]:
    """校验日期范围。

    Args:
        date_from: 开始日期
        date_to: 结束日期
        allow_none: 是否允许 None 值（默认不允许）

    Returns:
        (date_from, date_to)

    Raises:
        ValueError: 日期为空且不允许 None，或 date_from > date_to
    """
    if not allow_none:
        if date_from is None:
            raise ValueError("date_from is required")
        if date_to is None:
            raise ValueError("date_to is required")

    if date_from is not None and date_to is not None and date_from > date_to:
        raise ValueError(
            f"date_from ({date_from}) must not be later than date_to ({date_to})"
        )

    return date_from, date_to  # type: ignore[return-value]


# ─── 数值校验 ────────────────────────────────────────────────────────────────


def validate_positive(value: int | float | Decimal, *, field_name: str = "value") -> None:
    """校验值是否为正数（> 0）。

    Args:
        value: 待校验的值
        field_name: 字段名（用于错误信息）

    Raises:
        ValueError: 值不是正数
    """
    if isinstance(value, Decimal):
        if value <= Decimal("0"):
            raise ValueError(f"{field_name} must be positive, got {value}")
    elif value <= 0:
        raise ValueError(f"{field_name} must be positive, got {value}")


def validate_non_negative(
    value: int | float | Decimal, *, field_name: str = "value"
) -> None:
    """校验值是否非负（>= 0）。

    Args:
        value: 待校验的值
        field_name: 字段名（用于错误信息）

    Raises:
        ValueError: 值为负数
    """
    if isinstance(value, Decimal):
        if value < Decimal("0"):
            raise ValueError(f"{field_name} must be non-negative, got {value}")
    elif value < 0:
        raise ValueError(f"{field_name} must be non-negative, got {value}")


def validate_required(value: Any, *, field_name: str) -> Any:
    """校验值不为 None 或空字符串。

    Args:
        value: 待校验的值
        field_name: 字段名（用于错误信息）

    Returns:
        校验通过的值

    Raises:
        ValueError: 值为 None 或空字符串
    """
    if value is None:
        raise ValueError(f"{field_name} is required")
    if isinstance(value, str) and not value.strip():
        raise ValueError(f"{field_name} is required (empty string)")
    return value


# ─── 通用工具 ────────────────────────────────────────────────────────────────


def clamp(value: int, *, minimum: int, maximum: int) -> int:
    """将值限制在 [minimum, maximum] 范围内。

    Args:
        value: 待限制的值
        minimum: 最小值
        maximum: 最大值

    Returns:
        限制后的值
    """
    if minimum > maximum:
        raise ValueError(f"minimum ({minimum}) must not exceed maximum ({maximum})")
    return max(minimum, min(value, maximum))