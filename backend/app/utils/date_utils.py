"""日期处理工具。

本模块提供统一的日期解析和计算函数，供所有 service 层使用。
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Optional, Tuple

# ─── 日期解析 ────────────────────────────────────────────────────────────────


def parse_yyyy_mm_dd(value: str | None, field_name: str = "date") -> date:
    """解析 YYYY-MM-DD 格式日期。

    Args:
        value: 日期字符串
        field_name: 字段名（用于错误提示）

    Returns:
        date 对象

    Raises:
        ValueError: 格式不正确时
    """
    text = (value or "").strip()
    if not text:
        raise ValueError(f"{field_name} is required")
    try:
        return date.fromisoformat(text)
    except ValueError:
        raise ValueError(f"{field_name} must be YYYY-MM-DD")


def parse_yyyy_mm(value: str | None, field_name: str = "month") -> str:
    """解析 YYYY-MM 格式月份。

    Args:
        value: 月份字符串
        field_name: 字段名（用于错误提示）

    Returns:
        YYYY-MM 格式字符串

    Raises:
        ValueError: 格式不正确时
    """
    text = (value or "").strip()
    if not text:
        raise ValueError(f"{field_name} is required")
    try:
        datetime.strptime(text, "%Y-%m")
        return text
    except ValueError:
        raise ValueError(f"{field_name} must be YYYY-MM")


def parse_date_flexible(value: str | None, field_name: str = "date") -> date | None:
    """灵活解析日期，支持多种格式。

    支持格式：
    - YYYY-MM-DD
    - YYYY/MM/DD
    - YYYY.MM.DD
    - YYYY年MM月DD日
    - MM/DD/YYYY
    - MM-DD-YYYY
    - MM.DD.YYYY
    - Excel 导出的带时间部分格式

    Args:
        value: 日期字符串
        field_name: 字段名（用于错误提示）

    Returns:
        date 对象，None 表示空值

    Raises:
        ValueError: 无法解析时
    """
    from app.utils.text_utils import normalize_text

    normalized = normalize_text(value)
    if normalized is None:
        return None

    # 去除时间部分（Excel 导出的常见情况）
    candidates = [normalized]
    if " " in normalized:
        candidates.append(normalized.split(" ", 1)[0].strip())
    if "T" in normalized:
        candidates.append(normalized.split("T", 1)[0].strip())

    formats = (
        "%Y-%m-%d",
        "%Y/%m/%d",
        "%Y.%m.%d",
        "%Y年%m月%d日",
        "%m/%d/%Y",
        "%m-%d-%Y",
        "%m.%d.%Y",
    )

    seen: set[str] = set()
    for candidate in candidates:
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        try:
            return date.fromisoformat(candidate)
        except ValueError:
            pass
        for fmt in formats:
            try:
                return datetime.strptime(candidate, fmt).date()
            except ValueError:
                continue

    raise ValueError(f"{field_name} must be a valid date format")


# ─── 日期范围计算 ───────────────────────────────────────────────────────────


def date_range(start: date, end: date) -> list[date]:
    """生成日期范围内的所有日期（含首尾）。

    Args:
        start: 开始日期
        end: 结束日期

    Returns:
        日期列表
    """
    days = (end - start).days
    return [start + timedelta(days=i) for i in range(days + 1)]


def date_range_days(date_from: Optional[date], date_to: Optional[date]) -> Optional[int]:
    """计算日期范围天数。

    Args:
        date_from: 开始日期
        date_to: 结束日期

    Returns:
        天数，范围无效时返回 None
    """
    if date_from is None or date_to is None or date_to < date_from:
        return None
    return (date_to - date_from).days + 1


def build_previous_period(
    date_from: Optional[date], date_to: Optional[date]
) -> Tuple[Optional[date], Optional[date]]:
    """构建上一个周期（同天数往前移）。

    Args:
        date_from: 当前周期开始
        date_to: 当前周期结束

    Returns:
        (上一个周期开始, 上一个周期结束)
    """
    days = date_range_days(date_from, date_to)
    if days is None or date_from is None:
        return None, None
    previous_end = date.fromordinal(date_from.toordinal() - 1)
    previous_start = date.fromordinal(previous_end.toordinal() - days + 1)
    return previous_start, previous_end


def _shift_year_clamped(d: date) -> date:
    """将日期年份减 1；2/29 在去年非闰年不存在时钳制到 2/28。"""
    try:
        return d.replace(year=d.year - 1)
    except ValueError:
        return d.replace(year=d.year - 1, day=28)


def build_yoy_period(start: date, end: date) -> Tuple[date, date]:
    """构建去年同期的起止日期（同比窗口）。

    收编 ``report_builder_monthly._get_yoy_month`` 的成熟实现（BLF-570）：
    逐日平移年份，闰年 2/29 → 去年 2/28 钳制（如 2024-02-29 的同比窗口
    为 2023-02-28）。对常规"当月整月"窗口，结果与旧实现完全一致；
    对任意起止日期（含跨月、跨年、单日）也正确。

    Args:
        start: 当前周期开始
        end: 当前周期结束

    Returns:
        (去年同期开始, 去年同期结束)
    """
    return _shift_year_clamped(start), _shift_year_clamped(end)