"""BLF-1016：域切换开关的语义测试（``insight_canonical_domains``）。

开关是迁移的**唯一**可逆控制点，所以这里逐条钉住它对两端的效果：

- 空 CSV（默认）= 迁移前行为：旧写端照常、canonical 域端点不可用；
- 含某域 role：该域旧写端冻结、canonical 端点可用；
- 只影响被点名的域，未点名的域（含未实现的 role）行为不变；
- 未知配置项被忽略——配置笔误不能打开未实现的域，也不能冻结旧写端。
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from app.models.ai_insight import InsightType
from app.services.insight.domain_switch import (
    CANONICAL_DOMAIN_ROLES,
    canonical_domain_roles,
    is_domain_canonical,
    legacy_domain_role,
    legacy_write_frozen,
)


def _settings(**overrides: Any) -> Any:
    values: dict[str, Any] = {"insight_canonical_domains": ""}
    values.update(overrides)
    return SimpleNamespace(**values)


class TestCanonicalDomainRoles:
    def test_empty_csv_enables_nothing(self):
        assert canonical_domain_roles(_settings()) == frozenset()
        assert canonical_domain_roles(_settings(insight_canonical_domains=None)) == frozenset()

    def test_missing_attribute_enables_nothing(self):
        """开关字段在旧 settings 对象上不存在时也不得抛异常。"""
        assert canonical_domain_roles(SimpleNamespace()) == frozenset()

    def test_only_known_roles_are_enabled(self):
        settings = _settings(insight_canonical_domains="ad_analysis,typo_role")
        assert canonical_domain_roles(settings) == {"ad_analysis"}
        assert set(CANONICAL_DOMAIN_ROLES) == {"ad_analysis", "inventory_health"}

    def test_whitespace_and_duplicates_are_tolerated(self):
        settings = _settings(
            insight_canonical_domains=" ad_analysis , inventory_health ,ad_analysis"
        )
        assert canonical_domain_roles(settings) == {"ad_analysis", "inventory_health"}

    @pytest.mark.parametrize("role_id", ["ad_analysis", "inventory_health"])
    def test_is_domain_canonical_matches_enabled_set(self, role_id):
        assert is_domain_canonical(_settings(insight_canonical_domains=role_id), role_id)


class TestLegacyFreeze:
    def test_nothing_frozen_when_switch_empty(self):
        settings = _settings()
        assert legacy_write_frozen(settings, InsightType.ad_analysis) is None
        assert legacy_write_frozen(settings, "ad_analysis") is None
        assert not is_domain_canonical(settings, "ad_analysis")

    def test_ad_analysis_frozen_once_switched(self):
        settings = _settings(insight_canonical_domains="ad_analysis")
        # 冻结者是被切换的 canonical role，便于日志/409 直接说明去向
        assert legacy_write_frozen(settings, InsightType.ad_analysis) == "ad_analysis"
        assert legacy_write_frozen(settings, "ad_analysis") == "ad_analysis"

    def test_other_insight_types_stay_writable(self):
        settings = _settings(insight_canonical_domains="ad_analysis")
        for insight_type in (InsightType.daily, InsightType.weekly, InsightType.custom):
            assert legacy_write_frozen(settings, insight_type) is None

    def test_inventory_switch_does_not_freeze_ad_analysis(self):
        """库存没有旧写端；打开它不能顺手冻结别的域。"""
        settings = _settings(insight_canonical_domains="inventory_health")
        assert is_domain_canonical(settings, "inventory_health")
        assert legacy_write_frozen(settings, InsightType.ad_analysis) is None

    def test_unknown_value_never_freezes(self):
        settings = _settings(insight_canonical_domains="future_domain")
        assert legacy_write_frozen(settings, InsightType.ad_analysis) is None
        assert not is_domain_canonical(settings, "future_domain")

    def test_none_insight_type_is_not_frozen(self):
        settings = _settings(insight_canonical_domains="ad_analysis")
        assert legacy_write_frozen(settings, None) is None


class TestLegacyDomainRole:
    def test_accepts_value_or_enum(self):
        assert legacy_domain_role(InsightType.ad_analysis) == "ad_analysis"
        assert legacy_domain_role("ad_analysis") == "ad_analysis"

    @pytest.mark.parametrize(
        "insight_type", [None, "daily", InsightType.daily, "", "future_domain"]
    )
    def test_unmigrated_values_have_no_role(self, insight_type):
        assert legacy_domain_role(insight_type) is None
