"""parse_audit_path_meta 纯函数单测（BLF-460 读操作明细）。

覆盖 agent 原生路由 / external 镜像路由 / 无项目路径（health、/projects 列表）
的 project_id 与 operation_type 解析。
"""

from __future__ import annotations

import pytest

from app.middleware.agent_api_audit import (
    AGENT_PATH_DOMAIN_MAP,
    parse_audit_country,
    parse_audit_path_meta,
)


class TestParseAuditPathMeta:
    @pytest.mark.parametrize(
        ("path", "expected_project_id", "expected_operation_type"),
        [
            # agent 原生路由
            ("/api/v1/agent/projects/12/shipments", 12, "shipments"),
            (
                "/api/v1/agent/projects/7/shipments/ABC123/status",
                7,
                "shipments",
            ),
            (
                "/api/v1/agent/projects/3/shop-calculations",
                3,
                "shop_calculations",
            ),
            (
                "/api/v1/agent/projects/5/shop-calculation-history",
                5,
                "shop_calculations",
            ),
            (
                "/api/v1/agent/projects/9/new-product-calculations",
                9,
                "new_product_calculations",
            ),
            # external 镜像路由（规划中域）
            (
                "/api/v1/external/projects/1/return-analysis",
                1,
                "return_analysis",
            ),
            (
                "/api/v1/external/projects/2/return-analysis-raw",
                2,
                "return_analysis",
            ),
            (
                "/api/v1/external/projects/3/ad-campaigns",
                3,
                "ad_analysis",
            ),
            # BLF-580：agent 原生 ad_campaigns 域（/ad-campaigns 片段 → ad_analysis）
            (
                "/api/v1/agent/projects/11/ad-campaigns",
                11,
                "ad_analysis",
            ),
            # BLF-581：agent 原生其余 9 个 ad 域（/ad- 片段 → ad_analysis）
            (
                "/api/v1/agent/projects/21/ad-budgets",
                21,
                "ad_analysis",
            ),
            (
                "/api/v1/agent/projects/22/ad-targets-raw",
                22,
                "ad_analysis",
            ),
            (
                "/api/v1/agent/projects/23/ad-placements",
                23,
                "ad_analysis",
            ),
            (
                "/api/v1/agent/projects/24/ad-promoted-products-raw",
                24,
                "ad_analysis",
            ),
            (
                "/api/v1/agent/projects/25/ad-time-trends",
                25,
                "ad_analysis",
            ),
            (
                "/api/v1/agent/projects/26/ad-search-terms-raw",
                26,
                "ad_analysis",
            ),
            (
                "/api/v1/agent/projects/27/ad-search-term-shares",
                27,
                "ad_analysis",
            ),
            (
                "/api/v1/agent/projects/28/ad-invalid-traffic-raw",
                28,
                "ad_analysis",
            ),
            (
                "/api/v1/agent/projects/29/ad-purchased-products",
                29,
                "ad_analysis",
            ),
            ("/api/v1/external/projects/4/ad-search-term-shares", 4, "ad_analysis"),
            # BLF-582：sku-info 已原生化收口进 sku_info 域（审计映射已修正）
            (
                "/api/v1/external/projects/7/sku-info",
                7,
                "sku_info",
            ),
            # BLF-845：replenishment_analysis 是独立注册域，不再误归
            # inventory_ledger；report_upload_status / account_health 补齐映射。
            (
                "/api/v1/external/projects/6/replenishment-analysis",
                6,
                "replenishment_analysis",
            ),
            (
                "/api/v1/agent/projects/31/report-upload-status",
                31,
                "report_upload_status",
            ),
            (
                "/api/v1/agent/projects/32/account-health",
                32,
                "account_health",
            ),
            (
                "/api/v1/agent/platform-inspection/projects/42",
                42,
                "platform_inspection",
            ),
            (
                "/api/v1/agent/provisioning/keys",
                None,
                "agent_provisioning",
            ),
            # BLF-582：sku-info 已原生化收口进 sku_info 域（审计映射已修正）
            (
                "/api/v1/external/projects/7/sku-info",
                7,
                "sku_info",
            ),
            # BLF-582：pricing-snapshots 归 shop_calculations 域（原映射陈旧的
            # new_product_calculations 已修正）
            (
                "/api/v1/external/projects/8/pricing-snapshots",
                8,
                "shop_calculations",
            ),
            # BLF-582：agent 原生非 ad 域路径（projects 列表 / sku_info /
            # inventory_ledger / shop-calculation 2 条 / pricing-snapshots）
            ("/api/v1/agent/projects", None, None),
            (
                "/api/v1/agent/projects/7/sku-info",
                7,
                "sku_info",
            ),
            (
                "/api/v1/agent/projects/5/inventory-ledger/months",
                5,
                "inventory_ledger",
            ),
            # BLF-845：库存信息域（BLF-478）补齐映射；/inventory 是
            # /inventory-ledger 的子串，长片段必须优先命中。
            ("/api/v1/agent/projects/1/inventory", 1, "inventory"),
            (
                "/api/v1/agent/projects/5/shop-calculation/snapshots",
                5,
                "shop_calculations",
            ),
            (
                "/api/v1/agent/projects/8/pricing-snapshots",
                8,
                "shop_calculations",
            ),
            # BLF-1378：评论追踪采集域（路径无 project_id，项目归属在 handler 内校验）
            (
                "/api/v1/agent/review-tracking/targets",
                None,
                "review_tracking",
            ),
            (
                "/api/v1/agent/review-tracking/targets/12/runs",
                None,
                "review_tracking",
            ),
            # v3 下线（BLF-571）后 /orders/ 片段已从审计映射移除 → 归 None。
            ("/api/v1/external/projects/10/orders/summary", 10, None),
            ("/api/v1/agent/projects/10/sales/summary", 10, "sales"),
            # 无项目 / 无域
            ("/api/v1/agent/projects", None, None),
            ("/api/v1/agent/health", None, None),
            ("/api/v1/external/projects", None, None),
        ],
    )
    def test_parse_audit_path_meta(
        self,
        path: str,
        expected_project_id: int | None,
        expected_operation_type: str | None,
    ):
        project_id, operation_type = parse_audit_path_meta(path)
        assert project_id == expected_project_id
        assert operation_type == expected_operation_type


class TestParseAuditCountry:
    """BLF-845 项目日志国家维度：query string country 参数解析纯函数。"""

    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            # 常规：大写归一，便于后续聚合
            ("us", "US"),
            ("US", "US"),
            ("gb", "GB"),
            # 超长截断到列宽 8
            ("ABCDEFGH", "ABCDEFGH"),
            ("ABCDEFGHI", "ABCDEFGH"),
            # 无参数 / 空值 → None（落库 NULL）
            (None, None),
            ("", None),
            ("   ", None),
        ],
    )
    def test_parse_audit_country(self, raw: str | None, expected: str | None):
        assert parse_audit_country(raw) == expected


class TestAgentPathDomainMapCoverage:
    """BLF-845：agent-domains.ts 已注册域必须在审计映射表中有条目。

    防回归：前端注册表新增业务域时，后端 AGENT_PATH_DOMAIN_MAP 若漏配，
    该域读访问会全落「其他」（本轮中文缺失的另一根因）。
    """

    KNOWN_DOMAINS = {
        "new_product_calculations",
        "shop_calculations",
        "return_analysis",
        "replenishment_analysis",
        "inventory_ledger",
        "inventory",
        "sku_info",
        "sales",
        "ad_analysis",
        "shipments",
        "report_upload_status",
        "account_health",
        "platform_inspection",
        "agent_provisioning",
        "review_tracking",
    }

    def test_all_registered_domains_have_path_fragments(self):
        mapped = {domain for _, domain in AGENT_PATH_DOMAIN_MAP}
        missing = self.KNOWN_DOMAINS - mapped
        assert not missing, f"审计映射缺域: {missing}"

    def test_no_duplicate_domain_alias(self):
        """同一 domain 不得被两个不同 path 片段别名指向（历史撞车教训）。"""
        seen: dict[str, str] = {}
        for fragment, domain in AGENT_PATH_DOMAIN_MAP:
            if domain in seen and seen[domain] != fragment:
                # 允许 shop_calculations 双片段（/pricing-snapshots +
                # /shop-calculation 是同一域的两条路由形态）。
                if domain == "shop_calculations":
                    continue
                raise AssertionError(
                    f"domain {domain} 被 {fragment} 与 {seen[domain]} 重复映射"
                )
            seen[domain] = fragment

    def test_longer_fragment_precedes_substring(self):
        """长片段必须排在子串片段之前（BLF-845 教训：/inventory 是
        /inventory-ledger 的子串，短片段排前面会先命中、误吞台账路径）。"""
        seen: list[tuple[str, str]] = []
        for fragment, domain in AGENT_PATH_DOMAIN_MAP:
            for prev_fragment, _ in seen:
                assert prev_fragment not in fragment, (
                    f"子串片段 {prev_fragment!r} 排在了长片段 {fragment!r} 之前，"
                    "先到先得的顺序匹配会误吞长片段路径"
                )
            seen.append((fragment, domain))
