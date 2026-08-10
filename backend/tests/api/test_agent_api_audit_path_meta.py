"""parse_audit_path_meta 纯函数单测（BLF-460 读操作明细）。

覆盖 agent 原生路由 / external 镜像路由 / 无项目路径（health、/projects 列表）
的 project_id 与 operation_type 解析。
"""

from __future__ import annotations

import pytest

from app.middleware.agent_api_audit import parse_audit_path_meta


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
            (
                "/api/v1/external/projects/5/inventory-ledger",
                5,
                "inventory_ledger",
            ),
            (
                "/api/v1/external/projects/6/replenishment-analysis",
                6,
                "inventory_ledger",
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
