"""UK Amazon CSV 日期格式解析测试。

UK 站点的 Amazon Payment Report 使用 ``DD MMM YYYY HH:MM:SS TZ`` 格式
（例如 ``17 May 2026 02:44:48 UTC``），与 US 的 ``MMM DD, YYYY ... PM``
和 DE 的 ``DD.MM.YYYY HH:MM:SS`` 都不同。原始 ``_parse_transaction_datetime``
只支持后两种，所以 UK 月报上传时 Excel 生成成功（聚合只依赖 type+amount），
但 persistence 阶段抛 ValueError → MonthlyReport.status=failed → 前端"数据同步失败"。

参考：
- BEL-127 follow-up：UK 月报"数据同步失败"问题定位
- Amazon UK Payment Report Date Format
"""
from datetime import UTC, datetime

import pytest

from app.services.report.utils import _parse_transaction_datetime


# ── UK 格式回归 ────────────────────────────────────────────────────────────


def test_uk_amazon_full_date_with_utc():
    """UK Amazon 完整日期 ``17 May 2026 02:44:48 UTC`` 必须解析为 UTC。"""
    result = _parse_transaction_datetime("17 May 2026 02:44:48 UTC")
    assert result == datetime(2026, 5, 17, 2, 44, 48, tzinfo=UTC)


def test_uk_amazon_single_digit_day():
    """UK 单数字日期 ``7 May 2026 02:44:48 UTC``（无前导零）必须解析。"""
    result = _parse_transaction_datetime("7 May 2026 02:44:48 UTC")
    assert result == datetime(2026, 5, 7, 2, 44, 48, tzinfo=UTC)


def test_uk_amazon_with_gmt_timezone():
    """UK 用 GMT 时区缩写也要解析。"""
    result = _parse_transaction_datetime("1 Jun 2026 14:30:00 GMT")
    assert result == datetime(2026, 6, 1, 14, 30, 0, tzinfo=UTC)


def test_uk_amazon_no_timezone_suffix():
    """UK 不带时区后缀也按 UTC 兜底（与现有 US 行为一致）。"""
    result = _parse_transaction_datetime("17 May 2026 02:44:48")
    assert result == datetime(2026, 5, 17, 2, 44, 48, tzinfo=UTC)


# ── 已有 US / DE 格式不回归 ────────────────────────────────────────────────


def test_us_iso_format_still_parses():
    """US ISO 格式 ``2026-05-17 02:44:48`` 仍能解析。"""
    result = _parse_transaction_datetime("2026-05-17 02:44:48")
    assert result == datetime(2026, 5, 17, 2, 44, 48, tzinfo=UTC)


def test_us_am_pm_format_still_parses():
    """US ``May 17, 2026 02:44:48 PM`` 仍能解析。"""
    result = _parse_transaction_datetime("May 17, 2026 02:44:48 PM")
    assert result == datetime(2026, 5, 17, 14, 44, 48, tzinfo=UTC)


def test_de_dotted_format_still_parses():
    """DE ``17.05.2026 02:44:48`` 仍能解析。"""
    result = _parse_transaction_datetime("17.05.2026 02:44:48")
    assert result == datetime(2026, 5, 17, 2, 44, 48, tzinfo=UTC)


# ── 异常路径不回归 ────────────────────────────────────────────────────────


def test_empty_string_raises():
    with pytest.raises(ValueError, match="empty"):
        _parse_transaction_datetime("")


def test_garbage_string_raises():
    with pytest.raises(ValueError, match="invalid transaction date"):
        _parse_transaction_datetime("not a date")