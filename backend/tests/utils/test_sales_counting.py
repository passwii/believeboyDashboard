"""Unit tests for ``app.utils.parsers.is_counted_sales_status``.

纯函数、无 DB 依赖。锁定 BEL-348 的计数窗口规则：
- Cancelled/Canceled 永远不计；
- 订单产生后 ``age_days <= 5`` 内，Pending/Unshipped/Shipped 均计入；
- 超过 5 天窗口仍未发货，只认 Shipped（防历史挂单虚高销量）。
"""
from __future__ import annotations

from datetime import date, timedelta

import pytest

from app.utils.parsers import is_counted_sales_status


@pytest.mark.parametrize(
    "status,age,expected",
    [
        # 边界内：age = 5 天仍计入
        ("Shipped", 0, True),
        ("Pending", 0, True),
        ("Unshipped", 0, True),
        ("Shipped", 5, True),
        ("Pending", 5, True),
        ("Unshipped", 5, True),
        # 边界外：age = 6 天，仅 Shipped 计入
        ("Shipped", 6, True),
        ("Pending", 6, False),
        ("Unshipped", 6, False),
        ("Shipped", 30, True),
        ("Pending", 30, False),
    ],
)
def test_counted_sales_status_window(status, age, expected):
    purchase = date(2026, 6, 1)
    as_of = purchase + timedelta(days=age)
    assert is_counted_sales_status(status, purchase, as_of) is expected


@pytest.mark.parametrize("status", ["Cancelled", "Canceled", "CANCELLED"])
def test_counted_sales_status_cancelled_never_counted(status):
    # 取消单无论年龄都不计入（即便 age=0）
    purchase = date(2026, 7, 10)
    as_of = date(2026, 7, 10)
    assert is_counted_sales_status(status, purchase, as_of) is False


def test_counted_sales_status_case_insensitive():
    purchase = date(2026, 7, 10)
    as_of = date(2026, 7, 12)  # age=2
    assert is_counted_sales_status("  pending ", purchase, as_of) is True
