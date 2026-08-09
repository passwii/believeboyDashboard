"""BLF-564：销售额统一口径公共模块（app/utils/sales_amount.py）单测。

覆盖：
- ``sales_amount_expr``（SQL 表达式）：DE/UK 含税（item+shipping+item_tax+
  shipping_tax）、US 净额（item+shipping），与 BLF-475 行为逐字节一致；
- ``sales_amount_expr_by_row``（多站点 CASE 表达式）：``IN (DE, UK)`` 分支含税；
- ``sales_amount_value``（Python 标量版）：与 SQL 表达式同口径、同常量源；
- ``VAT_INCLUSIVE_COUNTRIES`` 单一权威来源：financial.py 直接 import 同一对象。
"""

from __future__ import annotations

from decimal import Decimal

import pytest
from sqlalchemy.dialects import postgresql

from app.utils.sales_amount import (
    VAT_INCLUSIVE_COUNTRIES,
    sales_amount_expr,
    sales_amount_expr_by_row,
    sales_amount_value,
)

_TAX_COLUMNS = ("item_tax", "shipping_tax")
_NET_COLUMNS = ("item_price", "shipping_price")


def _compile_sql(expr) -> str:
    return str(expr.compile(dialect=postgresql.dialect()))


# ─── SQL 表达式：DE/UK 含税 ────────────────────────────────────────────────


@pytest.mark.parametrize("country", ["DE", "UK", "de", " uk "])
def test_sales_amount_expr_vat_inclusive_includes_taxes(country: str) -> None:
    """DE/UK 表达式含 item_tax + shipping_tax 四项（BLF-475 口径）。"""
    sql = _compile_sql(sales_amount_expr(country))
    for col in _NET_COLUMNS + _TAX_COLUMNS:
        assert col in sql, f"{country}: 期望含 {col}，实际 {sql}"


# ─── SQL 表达式：US 净额 ──────────────────────────────────────────────────


@pytest.mark.parametrize("country", ["US", "CA", "", None])
def test_sales_amount_expr_net_excludes_taxes(country) -> None:
    """非含税站点表达式不含税列（净额 = item + shipping）。"""
    sql = _compile_sql(sales_amount_expr(country))
    for col in _NET_COLUMNS:
        assert col in sql, f"{country}: 期望含 {col}，实际 {sql}"
    for col in _TAX_COLUMNS:
        assert col not in sql, f"{country}: 不应含 {col}，实际 {sql}"


def test_sales_amount_expr_by_row_case_uses_vat_countries() -> None:
    """多站点表达式按行 CASE：DE/UK 分支含税，ELSE 净额。"""
    sql = _compile_sql(sales_amount_expr_by_row())
    assert sql.startswith("CASE WHEN")
    assert "IN (__[POSTCOMPILE_country_1])" in sql
    # 分支体内含税（THEN net+tax），ELSE 净额（net）
    then_branch = sql.split("THEN")[1].split("ELSE")[0]
    else_branch = sql.split("ELSE")[1]
    for col in _TAX_COLUMNS:
        assert col in then_branch, f"THEN 分支应含税 {col}"
        assert col not in else_branch, f"ELSE 分支不应含税 {col}"


# ─── Python 标量版 sales_amount_value ─────────────────────────────────────


@pytest.mark.parametrize("country", ["DE", "UK"])
def test_sales_amount_value_vat_inclusive(country: str) -> None:
    """DE/UK：净额 + item_tax + shipping_tax。"""
    result = sales_amount_value(
        country,
        item_price=Decimal("10.50"),
        shipping_price=Decimal("3.00"),
        item_tax=Decimal("1.20"),
        shipping_tax=Decimal("0.80"),
    )
    assert result == Decimal("15.50")
    assert isinstance(result, Decimal)


@pytest.mark.parametrize("country", ["US", "CA"])
def test_sales_amount_value_net_ignores_taxes(country: str) -> None:
    """US 等：仅 item + shipping，忽略税列（与 SQL 表达式一致）。"""
    result = sales_amount_value(
        country,
        item_price=Decimal("10.50"),
        shipping_price=Decimal("3.00"),
        item_tax=Decimal("1.20"),
        shipping_tax=Decimal("0.80"),
    )
    assert result == Decimal("13.50")


def test_sales_amount_value_normalizes_country_case() -> None:
    """大小写 / 空白归一化与 SQL 表达式一致（'de' / ' UK ' 均含税）。"""
    assert sales_amount_value(
        "de", item_price="10", shipping_price="1", item_tax="2", shipping_tax="3"
    ) == Decimal("16")
    assert sales_amount_value(
        " UK ", item_price="10", shipping_price="1", item_tax="2", shipping_tax="3"
    ) == Decimal("16")


def test_sales_amount_value_accepts_none_and_types() -> None:
    """None / float / int 入参归一为 Decimal，None 按 0 处理。"""
    assert sales_amount_value("DE", item_price=None, shipping_price=None) == Decimal(
        "0"
    )
    assert sales_amount_value("US", item_price=10, shipping_price=1.5) == Decimal(
        "11.5"
    )
    assert sales_amount_value(
        "DE", item_price=10.5, shipping_price=3, item_tax=1.2, shipping_tax=0.8
    ) == Decimal("15.5")


def test_sales_amount_value_consistent_with_expr_constant() -> None:
    """标量版与 SQL 表达式共用同一常量源：加税与否由同一个 frozenset 决定。"""
    # 两个函数读取的必须是同一对象（单一权威来源，改常量不会出现分叉）
    assert (
        sales_amount_value.__globals__["VAT_INCLUSIVE_COUNTRIES"]
        is sales_amount_expr.__globals__["VAT_INCLUSIVE_COUNTRIES"]
    )
    # 抽查：所有站点走同一份常量做判断，DE 含税 / US 净额
    for country in ("DE", "UK"):
        assert (country or "").strip().upper() in VAT_INCLUSIVE_COUNTRIES
    assert "US" not in VAT_INCLUSIVE_COUNTRIES


# ─── 常量单一权威来源 ──────────────────────────────────────────────────────


def test_vat_inclusive_countries_single_source() -> None:
    """financial.py 不再重复定义：import 的是 app.utils.sales_amount 同一对象。"""
    from app.services.payment.financial import (
        VAT_INCLUSIVE_COUNTRIES as FINANCIAL_VAT,
    )

    assert FINANCIAL_VAT is VAT_INCLUSIVE_COUNTRIES
    assert VAT_INCLUSIVE_COUNTRIES == frozenset({"DE", "UK"})
    assert isinstance(VAT_INCLUSIVE_COUNTRIES, frozenset)


def test_private_module_migrated_away() -> None:
    """旧私有模块已迁出，不能再被 import（单一权威落点）。"""
    with pytest.raises(ModuleNotFoundError):
        from app.services.scheduled_report._sales_amount import (  # noqa: F401
            sales_amount_expr as _,
        )
