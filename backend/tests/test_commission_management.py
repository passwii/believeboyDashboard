from decimal import Decimal

from app.api.v1.endpoints.system_management import (
    _build_default_bonus_ratios,
    _resolve_factory_commission,
    _resolve_operator_bonus_ratio,
)


def test_resolve_operator_bonus_ratio_uses_tiers():
    assert _resolve_operator_bonus_ratio(Decimal('0')) == Decimal('0.12')
    assert _resolve_operator_bonus_ratio(Decimal('10000')) == Decimal('0.12')
    assert _resolve_operator_bonus_ratio(Decimal('10000.01')) == Decimal('0.14')
    assert _resolve_operator_bonus_ratio(Decimal('50000.01')) == Decimal('0.16')
    assert _resolve_operator_bonus_ratio(Decimal('150000.01')) == Decimal('0.18')
    assert _resolve_operator_bonus_ratio(Decimal('450000.01')) == Decimal('0.20')


def test_build_default_bonus_ratios_splits_with_assistant():
    ratio_map = _build_default_bonus_ratios(
        income_total_usd=Decimal('60000'),
        operator_names=['运营A', '运营B'],
        assistant_names=['助理A'],
    )

    assert ratio_map[('运营A', 'operator')] == Decimal('0.08')
    assert ratio_map[('运营B', 'operator')] == Decimal('0.08')
    assert ratio_map[('助理A', 'assistant')] == Decimal('0.02')


def test_resolve_factory_commission_for_cash_received_basis():
    rate, base_amount_usd, commission_usd = _resolve_factory_commission(
        'cash_received',
        Decimal('0.05'),
        Decimal('10000'),
        Decimal('6500'),
    )

    assert rate == Decimal('0.13')
    assert base_amount_usd == Decimal('6500')
    assert commission_usd == Decimal('845.00')


def test_resolve_factory_commission_for_sales_amount_basis():
    rate, base_amount_usd, commission_usd = _resolve_factory_commission(
        'sales_amount',
        Decimal('0.05'),
        Decimal('20000'),
        Decimal('15000'),
    )

    assert rate == Decimal('0.05')
    assert base_amount_usd == Decimal('20000')
    assert commission_usd == Decimal('1000.00')
