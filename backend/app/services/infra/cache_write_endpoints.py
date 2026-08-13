"""缓存治理白名单：写端点 → 装饰器契约（BLF-665 子 #1）。

设计文档 §6。白名单是「业务契约」：每个写端点声明它应当使用的缓存失效
装饰器。B1/B2 不变量测试用 AST 扫描 + 本表对照校验「声明即事实」；
CI 钩子 ``check_cache_decorator_coverage.py`` 用本表做 hard fail（白名单腐烂）。

首版（子 #1）只登记**已存在的写端点 + 已有的 invalidate 语义**（避免新声明
错位）。decorator 字段当前为空字符串 —— 真正的装饰器声明由子 #2/#3/#4
（BLF-667/668/669）在各域改造时逐步填写。

字段说明（§6.2）：
- ``domain``      必须已在 REGISTERED_DOMAINS
- ``module``      dotted path，不含 .py
- ``function``    函数名
- ``decorator``   invalidate_cache_on_commit / _celery / _l1（空 = 待改造）
- ``cascade``     级联失效域
- ``on_error``    raise / log（L0 必须 raise；L1 必须 log）
- ``project_id_from``  path / query / payload / arg / global
- ``extra_project_ids`` 跨项目失效回调函数名（弱引用）
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class WriteEndpointSpec:
    domain: str
    module: str
    function: str
    decorator: str = ""  # invalidate_cache_on_commit / invalidate_cache_on_commit_l1 / invalidate_cache_on_commit_celery
    cascade: tuple[str, ...] = ()
    on_error: str = "raise"
    project_id_from: str = "path"
    extra_project_ids: str | None = None
    rationale: str = ""
    issue_ref: str = ""


# ── L0 强一致层（10 域 × 写端点）── 强制登记 ────────────────────────────
# 首版登记已存在的写端点（含 BLF-633 已修 + 既有 invalidate 调用点），
# decorator 声明待子 #2（BLF-667）逐域填写。

L0_WRITE_ENDPOINTS: tuple[WriteEndpointSpec, ...] = (
    # inventory_replenishment —— BLF-633 已修（2 个写端点已有手动 invalidate）
    WriteEndpointSpec(
        domain="inventory_replenishment",
        module="app.api.v1.endpoints.inventory_replenishment",
        function="update_inventory_replenishment_setting",
        decorator="invalidate_cache_on_commit",
        project_id_from="path",
        rationale="BLF-633 补货分析设置写路径（web）；装饰器接管手动 invalidate",
        issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="inventory_replenishment",
        module="app.api.v1.endpoints.inventory_replenishment_snapshots",
        function="create_snapshot",
        decorator="invalidate_cache_on_commit",
        project_id_from="query",
        rationale="BLF-633 快照上传写路径（web）；装饰器接管手动 invalidate",
        issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="inventory_replenishment",
        module="app.api.v1.endpoints.inventory_replenishment_snapshots",
        function="update_snapshot_endpoint",
        decorator="invalidate_cache_on_commit",
        project_id_from="global",
        rationale="快照更新（管理员）；装饰器接管手动 invalidate",
        issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="inventory_replenishment",
        module="app.api.v1.endpoints.inventory_replenishment_snapshots",
        function="delete_snapshot_endpoint",
        decorator="invalidate_cache_on_commit",
        project_id_from="global",
        rationale="快照删除（管理员）；装饰器接管手动 invalidate",
        issue_ref="BLF-667",
    ),
    # platform_revenues —— 既有 invalidate_platform_revenue_cache()
    WriteEndpointSpec(
        domain="platform_revenues",
        module="app.api.v1.endpoints.platform_revenues",
        function="create_platform_revenue",
        decorator="invalidate_cache_on_commit",
        project_id_from="global",
        rationale="平台收入新增写端点；装饰器接管手动 invalidate",
        issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="platform_revenues",
        module="app.api.v1.endpoints.platform_revenues",
        function="update_platform_revenue",
        decorator="invalidate_cache_on_commit",
        project_id_from="global",
        rationale="平台收入修改写端点；装饰器接管手动 invalidate",
        issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="platform_revenues",
        module="app.api.v1.endpoints.platform_revenues",
        function="delete_platform_revenue",
        decorator="invalidate_cache_on_commit",
        project_id_from="global",
        rationale="平台收入删除写端点；装饰器接管手动 invalidate",
        issue_ref="BLF-667",
    ),
    # data_management
    WriteEndpointSpec(
        domain="data_management",
        module="app.api.v1.endpoints.system_management.data_management",
        function="update_data_status",
        decorator="invalidate_cache_on_commit",
        project_id_from="global",
        rationale="数据状态写端点；装饰器接管手动 invalidate",
        issue_ref="BLF-667",
    ),
    # operator_performance
    WriteEndpointSpec(
        domain="operator_performance",
        module="app.api.v1.endpoints.system_management.operator_performance",
        function="upsert_operator_performance_endpoint",
        decorator="invalidate_cache_on_commit",
        cascade=("data_management",),
        project_id_from="global",
        rationale="运营绩效写端点；级联 data_management",
        issue_ref="BLF-667",
    ),
    # commission_records
    WriteEndpointSpec(
        domain="commission_records",
        module="app.api.v1.endpoints.system_management.commission.records",
        function="upsert_commission_records_endpoint",
        decorator="invalidate_cache_on_commit",
        cascade=("commission_summary", "operator_performance", "data_management"),
        project_id_from="global",
        rationale="佣金记录 upsert；级联 summary/performance/data_management",
        issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="commission_records",
        module="app.api.v1.endpoints.system_management.commission.records",
        function="update_commission_payment_status_endpoint",
        decorator="invalidate_cache_on_commit",
        cascade=("commission_summary", "operator_performance", "data_management"),
        project_id_from="global",
        rationale="佣金支付状态更新；级联 summary/performance/data_management",
        issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="commission_records",
        module="app.api.v1.endpoints.system_management.commission.records",
        function="update_commission_project_payment_endpoint",
        decorator="invalidate_cache_on_commit",
        cascade=("commission_summary", "operator_performance", "data_management"),
        project_id_from="global",
        rationale="佣金项目支付更新；级联 summary/performance/data_management",
        issue_ref="BLF-667",
    ),
    # commission_ratio_overrides
    WriteEndpointSpec(
        domain="commission_ratio_overrides",
        module="app.api.v1.endpoints.system_management.commission.ratio_overrides",
        function="upsert_commission_ratio_overrides_endpoint",
        decorator="invalidate_cache_on_commit",
        cascade=("commission_summary", "operator_performance", "data_management"),
        project_id_from="global",
        rationale="佣金比例覆盖 upsert；级联 summary/performance/data_management",
        issue_ref="BLF-667",
    ),
    # commission_role_assignments
    WriteEndpointSpec(
        domain="commission_role_assignments",
        module="app.api.v1.endpoints.system_management.commission.role_assignments",
        function="upsert_project_role_assignments_endpoint",
        decorator="invalidate_cache_on_commit",
        cascade=("commission_summary", "operator_performance", "data_management"),
        project_id_from="global",
        rationale="项目角色分配 upsert；级联 summary/performance/data_management",
        issue_ref="BLF-667",
    ),
    # commission_summary
    WriteEndpointSpec(
        domain="commission_summary",
        module="app.api.v1.endpoints.system_management.commission.summary",
        function="recompute_commission_records_endpoint",
        decorator="invalidate_cache_on_commit",
        cascade=(
            "commission_records",
            "commission_ratio_overrides",
            "operator_performance",
            "data_management",
        ),
        project_id_from="global",
        rationale="佣金重算；级联全部 commission 域",
        issue_ref="BLF-667",
    ),
)

# ── CRM 统一 L0（crm + crm_tasks）──────────────────────────────────────
# CRM 为全局工作区（无 project_id 维度），写端点统一 project_id_from="global"。
# 客户/线索/联系人/公海/规则/分类/视图 → crm；任务 → crm_tasks + crm。

CRM_WRITE_ENDPOINTS: tuple[WriteEndpointSpec, ...] = (
    *(
        WriteEndpointSpec(
            domain="crm",
            module="app.api.v1.endpoints.crm",
            function=fn,
            decorator="invalidate_cache_on_commit",
            project_id_from="global",
            rationale="CRM 写端点（统一 L0 全域失效）",
            issue_ref="BLF-667",
        )
        for fn in (
            "create_customer",
            "import_customers_to_sea",
            "update_customer",
            "update_value_scores",
            "delete_customer",
            "batch_transfer",
            "batch_move_to_sea",
            "claim_from_sea",
            "create_contact",
            "update_contact",
            "delete_contact",
            "create_lead",
            "update_lead",
            "batch_transfer_leads",
            "batch_move_leads_to_pool",
            "claim_lead_from_pool",
            "convert_lead",
            "create_follow",
            "create_rule",
            "update_rule",
            "delete_rule",
            "update_workflow_settings",
            "create_category",
            "update_category",
            "delete_category",
            "set_customer_categories",
            "create_saved_view",
            "update_saved_view",
            "delete_saved_view",
        )
    ),
    *(
        WriteEndpointSpec(
            domain="crm_tasks",
            module="app.api.v1.endpoints.crm",
            function=fn,
            decorator="invalidate_cache_on_commit",
            cascade=("crm",),
            project_id_from="global",
            rationale="CRM 任务写端点（crm_tasks + 级联 crm）",
            issue_ref="BLF-667",
        )
        for fn in (
            "create_task",
            "update_task",
            "set_task_status",
            "complete_task",
            "cancel_task",
        )
    ),
)

# ── L1 弱一致层（9 域 × 部分写端点）── 建议登记（方便审计）──────────────
# 首版登记已存在的写端点；L1 装饰器声明待子 #3（BLF-668）填写。

L1_WRITE_ENDPOINTS: tuple[WriteEndpointSpec, ...] = (
    # shipment_schedules（4 源写路径：web create/update/delete + agent 写）
    WriteEndpointSpec(
        domain="shipment_schedules",
        module="app.api.v1.endpoints.shipment_schedules",
        function="create_shipment_schedule",
        decorator="invalidate_cache_on_commit_l1",
        on_error="log",
        project_id_from="global",
        rationale="发货计划创建（web）；L1 best_effort + 5min TTL 兜底",
        issue_ref="BLF-668",
    ),
    WriteEndpointSpec(
        domain="shipment_schedules",
        module="app.api.v1.endpoints.shipment_schedules",
        function="update_shipment_schedule",
        decorator="invalidate_cache_on_commit_l1",
        on_error="log",
        project_id_from="global",
        rationale="发货计划更新（web）；L1 best_effort + 5min TTL 兜底",
        issue_ref="BLF-668",
    ),
    WriteEndpointSpec(
        domain="shipment_schedules",
        module="app.api.v1.endpoints.shipment_schedules",
        function="delete_shipment_schedule",
        decorator="invalidate_cache_on_commit_l1",
        on_error="log",
        project_id_from="global",
        rationale="发货计划删除（web）；L1 best_effort + 5min TTL 兜底",
        issue_ref="BLF-668",
    ),
    WriteEndpointSpec(
        domain="shipment_schedules",
        module="app.api.v1.endpoints.agent.shipments",
        function="create_shipment",
        decorator="invalidate_cache_on_commit_l1",
        on_error="log",
        project_id_from="path",
        rationale="Agent 发货创建（源路径）；L1 best_effort",
        issue_ref="BLF-668",
    ),
    WriteEndpointSpec(
        domain="shipment_schedules",
        module="app.api.v1.endpoints.agent.shipments",
        function="replace_shipment_items",
        decorator="invalidate_cache_on_commit_l1",
        on_error="log",
        project_id_from="path",
        rationale="Agent 发货 items 替换（源路径）；L1 best_effort",
        issue_ref="BLF-668",
    ),
    WriteEndpointSpec(
        domain="shipment_schedules",
        module="app.api.v1.endpoints.agent.shipments",
        function="patch_shipment",
        decorator="invalidate_cache_on_commit_l1",
        on_error="log",
        project_id_from="path",
        rationale="Agent 发货更新（源路径）；L1 best_effort",
        issue_ref="BLF-668",
    ),
    WriteEndpointSpec(
        domain="shipment_schedules",
        module="app.api.v1.endpoints.agent.shipments",
        function="transition_shipment_status",
        decorator="invalidate_cache_on_commit_l1",
        on_error="log",
        project_id_from="path",
        rationale="Agent 发货状态变更（源路径）；L1 best_effort",
        issue_ref="BLF-668",
    ),
    WriteEndpointSpec(
        domain="shipment_schedules",
        module="app.api.v1.endpoints.agent.shipments",
        function="recalculate_shipment_costs",
        decorator="invalidate_cache_on_commit_l1",
        on_error="log",
        project_id_from="path",
        rationale="Agent 发货成本重算（源路径）；L1 best_effort",
        issue_ref="BLF-668",
    ),
    WriteEndpointSpec(
        domain="shipment_schedules",
        module="app.api.v1.endpoints.agent.shipments",
        function="delete_shipment",
        decorator="invalidate_cache_on_commit_l1",
        on_error="log",
        project_id_from="path",
        rationale="Agent 发货删除（源路径）；L1 best_effort",
        issue_ref="BLF-668",
    ),
    # product_analysis（死代码已复活 + L1 装饰器）
    WriteEndpointSpec(
        domain="product_analysis",
        module="app.api.v1.endpoints.product_analysis",
        function="recompute_product_analysis_weekly",
        decorator="invalidate_cache_on_commit_l1",
        on_error="log",
        project_id_from="query",
        rationale="产品分析周重算；L1 best_effort",
        issue_ref="BLF-668",
    ),
    WriteEndpointSpec(
        domain="product_analysis",
        module="app.api.v1.endpoints.product_analysis",
        function="run_product_analysis",
        decorator="invalidate_cache_on_commit_l1",
        on_error="log",
        project_id_from="payload",
        rationale="产品分析计算 run；L1 best_effort",
        issue_ref="BLF-668",
    ),
    WriteEndpointSpec(
        domain="product_analysis",
        module="app.api.v1.endpoints.product_analysis",
        function="trigger_pt1_recompute",
        decorator="invalidate_cache_on_commit_l1",
        on_error="log",
        project_id_from="query",
        rationale="产品分析 PT1 重算；L1 best_effort",
        issue_ref="BLF-668",
    ),
    WriteEndpointSpec(
        domain="product_analysis",
        module="app.api.v1.endpoints.product_analysis",
        function="upload_product_analysis_sources",
        decorator="invalidate_cache_on_commit_l1",
        on_error="log",
        project_id_from="payload",
        rationale="产品分析源文件上传；L1 best_effort",
        issue_ref="BLF-668",
    ),
    # sku_info（5 写端点）
    WriteEndpointSpec(
        domain="sku_info",
        module="app.api.v1.endpoints.sku_info",
        function="create_or_update_sku_record",
        decorator="invalidate_cache_on_commit_l1",
        on_error="log",
        project_id_from="global",
        rationale="SKU 主数据 upsert；L1 best_effort",
        issue_ref="BLF-668",
    ),
    WriteEndpointSpec(
        domain="sku_info",
        module="app.api.v1.endpoints.sku_info",
        function="import_sku_records_from_csv",
        decorator="invalidate_cache_on_commit_l1",
        on_error="log",
        project_id_from="global",
        rationale="SKU 主数据 CSV 导入；L1 best_effort",
        issue_ref="BLF-668",
    ),
    WriteEndpointSpec(
        domain="sku_info",
        module="app.api.v1.endpoints.sku_info",
        function="update_sku_record",
        decorator="invalidate_cache_on_commit_l1",
        on_error="log",
        project_id_from="global",
        rationale="SKU 主数据编辑；L1 best_effort",
        issue_ref="BLF-668",
    ),
    WriteEndpointSpec(
        domain="sku_info",
        module="app.api.v1.endpoints.sku_info",
        function="delete_sku_record_endpoint",
        decorator="invalidate_cache_on_commit_l1",
        on_error="log",
        project_id_from="global",
        rationale="SKU 主数据删除；L1 best_effort",
        issue_ref="BLF-668",
    ),
    WriteEndpointSpec(
        domain="sku_info",
        module="app.api.v1.endpoints.sku_info",
        function="move_sku_record",
        decorator="invalidate_cache_on_commit_l1",
        on_error="log",
        project_id_from="global",
        rationale="SKU 主数据转移项目；L1 best_effort",
        issue_ref="BLF-668",
    ),
    # return_analysis（Celery 任务）
    WriteEndpointSpec(
        domain="return_analysis",
        module="app.celery_tasks.return_analysis_refresh",
        function="refresh_return_aggregates",
        decorator="invalidate_cache_on_commit_celery",
        project_id_from="global",
        on_error="log",
        rationale="退货分析刷新 Celery 任务（v1+v2 双清）；L1 best_effort",
        issue_ref="BLF-668",
    ),
)

# ── L2 长 TTL 省 token 层（2 域 × 写端点）── 强制登记 ──────────────────
# ai_chat_v2 / ai_insight 写端点盘点在子 #4（BLF-669）完成；首版暂无登记。

L2_WRITE_ENDPOINTS: tuple[WriteEndpointSpec, ...] = ()


def ALL_WRITE_ENDPOINTS() -> tuple[WriteEndpointSpec, ...]:
    """合并访问器：L0 + L1 + L2 + CRM 全量白名单。"""
    return (
        L0_WRITE_ENDPOINTS
        + CRM_WRITE_ENDPOINTS
        + L1_WRITE_ENDPOINTS
        + L2_WRITE_ENDPOINTS
    )
