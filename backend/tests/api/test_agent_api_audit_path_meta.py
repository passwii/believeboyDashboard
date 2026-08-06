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
            ("/api/v1/external/projects/2/return-analysis-raw", 2, "return_analysis"),
            ("/api/v1/external/projects/3/ad-campaigns", 3, "ad_analysis"),
            ("/api/v1/external/projects/4/ad-search-term-shares", 4, "ad_analysis"),
            ("/api/v1/external/projects/5/inventory-ledger", 5, "inventory_ledger"),
            (
                "/api/v1/external/projects/6/replenishment-analysis",
                6,
                "inventory_ledger",
            ),
            ("/api/v1/external/projects/7/sku-info", 7, "inventory_ledger"),
            (
                "/api/v1/external/projects/8/pricing-snapshots",
                8,
                "new_product_calculations",
            ),
            ("/api/v1/external/projects/9/business-summary", 9, "finance_profit"),
            ("/api/v1/external/projects/10/orders/summary", 10, "finance_profit"),
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
