"""缓存写端点白名单登记表（BLF-666）。

设计来源：`docs/superpowers/specs/2026-08-13-cache-governance-design.md` §6。
白名单是"写后失效治理"的权威对照源——CI 钩子与 B 类不变量测试
（AST 扫描 + dataclass 对照）都以本文件为准。

登记约定（BLF-666 首版）:
- 只登记**已存在**的写端点 + **已有 invalidate**（避免新声明错位）。
- 后续子 issue（BLF-667/668/669）在改造对应域时，把端点补登进对应层。
- ``required_decorator`` 是治理目标：该端点**应**挂的装饰器名。
  首版登记时端点多为手工 invalidate 调用（尚未挂装饰器），
  ``decorator_applied=False`` 标记"待 BLF-667/668/669 改造"。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

Layer = Literal["L0", "L1", "L2"]

# 三层各自的装饰器名称（治理约定，与 cache_decorator.py 一致）
DECORATOR_L0 = "invalidate_cache_on_commit"
DECORATOR_L1 = "invalidate_cache_on_commit_l1"
DECORATOR_CELERY = "invalidate_cache_on_commit_celery"


@dataclass(frozen=True)
class WriteEndpointSpec:
    """单个写端点的白名单登记项。

    Attributes:
        domain: 缓存域（必须已在 REGISTERED_DOMAINS 登记）。
        layer: 所属层（L0 强一致 / L1 弱一致 / L2 省 token）。
        module: 端点所在模块（点分路径，AST 扫描用）。
        function: 端点函数名（AST 扫描用）。
        method: HTTP 方法（POST/PUT/PATCH/DELETE，登记用途）。
        path: 路由路径（登记用途）。
        required_decorator: 该端点应挂的装饰器名（治理目标）。
        decorator_applied: 该装饰器是否已实际挂上（False = 待后续子 issue 改造）。
        rationale: 登记原因（为什么需要写后失效）。
        issue_ref: 关联 issue（首个登记 BLF-666；改造 BLF-667/668/669）。
    """

    domain: str
    layer: Layer
    module: str
    function: str
    method: str
    path: str
    required_decorator: str
    decorator_applied: bool = False
    rationale: str = ""
    issue_ref: str = ""


# ── L0 强一致层（10 域）写端点 ────────────────────────────────────────
# 首版登记：BLF-633 已修路径（inventory_replenishment ×2）+ platform_revenues。

L0_WRITE_ENDPOINTS: tuple[WriteEndpointSpec, ...] = (
    WriteEndpointSpec(
        domain="inventory_replenishment",
        layer="L0",
        module="app.api.v1.endpoints.inventory_replenishment",
        function="update_inventory_replenishment_setting",
        method="PUT",
        path="/inventory-replenishment-settings/{project_id}/{sku}",
        required_decorator=DECORATOR_L0,
        decorator_applied=True,
        rationale="BLF-633 根因路径：设置写后必须立即失效补货分析缓存",
        issue_ref="BLF-666 (BLF-667 改造)",
    ),
    WriteEndpointSpec(
        domain="inventory_replenishment",
        layer="L0",
        module="app.api.v1.endpoints.agent.replenishment_analysis",
        function="update_replenishment_analysis_setting",
        method="PUT",
        path="/agent/projects/{project_id}/replenishment-analysis/settings/{sku}",
        required_decorator=DECORATOR_L0,
        decorator_applied=True,
        rationale="BLF-633 根因路径（Agent 写侧）：设置写后立即失效补货分析缓存",
        issue_ref="BLF-666 (BLF-667 改造)",
    ),
    WriteEndpointSpec(
        domain="platform_revenues",
        layer="L0",
        module="app.api.v1.endpoints.platform_revenues",
        function="create_platform_revenue",
        method="POST",
        path="/platform-revenues",
        required_decorator=DECORATOR_L0,
        decorator_applied=True,
        rationale="财务数据手动录入：写入后立即失效，防旧值",
        issue_ref="BLF-666 (BLF-667 改造)",
    ),
    WriteEndpointSpec(
        domain="platform_revenues",
        layer="L0",
        module="app.api.v1.endpoints.platform_revenues",
        function="update_platform_revenue",
        method="PATCH",
        path="/platform-revenues/{revenue_id}",
        required_decorator=DECORATOR_L0,
        decorator_applied=True,
        rationale="财务数据手动编辑：写入后立即失效",
        issue_ref="BLF-666 (BLF-667 改造)",
    ),
    WriteEndpointSpec(
        domain="platform_revenues",
        layer="L0",
        module="app.api.v1.endpoints.platform_revenues",
        function="delete_platform_revenue",
        method="DELETE",
        path="/platform-revenues/{revenue_id}",
        required_decorator=DECORATOR_L0,
        decorator_applied=True,
        rationale="财务数据手动删除：写入后立即失效",
        issue_ref="BLF-666 (BLF-667 改造)",
    ),

    # ── BLF-667 新增 L0 写端点（快照 / data_management / operator_performance / commission）──
    WriteEndpointSpec(
        domain="inventory_replenishment", layer="L0",
        module="app.api.v1.endpoints.inventory_replenishment_snapshots",
        function="create_snapshot", method="POST", path="/inventory-replenishment-snapshots",
        required_decorator=DECORATOR_L0, decorator_applied=True,
        rationale="快照创建：补货/库存分析/选项缓存失效（BLF-667 装饰器接管手动 invalidate）", issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="inventory_replenishment", layer="L0",
        module="app.api.v1.endpoints.inventory_replenishment_snapshots",
        function="update_snapshot_endpoint", method="PATCH", path="/inventory-replenishment-snapshots/{snapshot_id}",
        required_decorator=DECORATOR_L0, decorator_applied=True,
        rationale="快照编辑：缓存失效（BLF-667 装饰器接管）", issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="inventory_replenishment", layer="L0",
        module="app.api.v1.endpoints.inventory_replenishment_snapshots",
        function="delete_snapshot_endpoint", method="DELETE", path="/inventory-replenishment-snapshots/{snapshot_id}",
        required_decorator=DECORATOR_L0, decorator_applied=True,
        rationale="快照删除：缓存失效（BLF-667 装饰器接管）", issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="data_management", layer="L0",
        module="app.api.v1.endpoints.system_management.data_management",
        function="update_data_status", method="PATCH", path="/system/data-status",
        required_decorator=DECORATOR_L0, decorator_applied=True,
        rationale="数据状态写后立即失效 overview（BLF-667）", issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="operator_performance", layer="L0",
        module="app.api.v1.endpoints.system_management.operator_performance",
        function="upsert_operator_performance_endpoint", method="POST", path="/operator-management/performance/upsert",
        required_decorator=DECORATOR_L0, decorator_applied=True,
        rationale="运营绩效写后失效（BLF-667）", issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="commission_records", layer="L0",
        module="app.api.v1.endpoints.system_management.commission.records",
        function="upsert_commission_records_endpoint", method="POST", path="/commission-management/records/upsert",
        required_decorator=DECORATOR_L0, decorator_applied=True,
        rationale="佣金记录 upsert 后失效（BLF-667）", issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="commission_records", layer="L0",
        module="app.api.v1.endpoints.system_management.commission.records",
        function="update_commission_payment_status_endpoint", method="PATCH", path="/commission-management/records/{record_id}/payment-status",
        required_decorator=DECORATOR_L0, decorator_applied=True,
        rationale="支付状态更新后失效（BLF-667）", issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="commission_records", layer="L0",
        module="app.api.v1.endpoints.system_management.commission.records",
        function="update_commission_project_payment_endpoint", method="PATCH", path="/commission-management/project-months/{project_month_id}/payment",
        required_decorator=DECORATOR_L0, decorator_applied=True,
        rationale="项目支付更新后失效（BLF-667）", issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="commission_ratio_overrides", layer="L0",
        module="app.api.v1.endpoints.system_management.commission.ratio_overrides",
        function="upsert_commission_ratio_overrides_endpoint", method="POST", path="/commission-management/ratio-overrides/upsert",
        required_decorator=DECORATOR_L0, decorator_applied=True,
        rationale="比例覆盖 upsert 后失效（BLF-667）", issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="commission_role_assignments", layer="L0",
        module="app.api.v1.endpoints.system_management.commission.role_assignments",
        function="upsert_project_role_assignments_endpoint", method="POST", path="/commission-management/role-assignments/upsert",
        required_decorator=DECORATOR_L0, decorator_applied=True,
        rationale="角色分配 upsert 后失效（BLF-667）", issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="commission_summary", layer="L0",
        module="app.api.v1.endpoints.system_management.commission.summary",
        function="recompute_commission_records_endpoint", method="POST", path="/commission-management/recompute",
        required_decorator=DECORATOR_L0, decorator_applied=True,
        rationale="佣金重算后全域失效（BLF-667）", issue_ref="BLF-667",
    ),

    # ── BLF-667 CRM 统一 L0（crm + crm_tasks；全局工作区无 project 维度）──
    WriteEndpointSpec(
        domain="crm", layer="L0", module="app.api.v1.endpoints.crm",
        function="create_customer", method="POST", path="/crm",
        required_decorator=DECORATOR_L0, decorator_applied=True,
        rationale="CRM 写端点统一失效（BLF-667）", issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="crm", layer="L0", module="app.api.v1.endpoints.crm",
        function="import_customers_to_sea", method="POST", path="/crm",
        required_decorator=DECORATOR_L0, decorator_applied=True,
        rationale="CRM 写端点统一失效（BLF-667）", issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="crm", layer="L0", module="app.api.v1.endpoints.crm",
        function="update_customer", method="PATCH", path="/crm",
        required_decorator=DECORATOR_L0, decorator_applied=True,
        rationale="CRM 写端点统一失效（BLF-667）", issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="crm", layer="L0", module="app.api.v1.endpoints.crm",
        function="update_value_scores", method="PATCH", path="/crm",
        required_decorator=DECORATOR_L0, decorator_applied=True,
        rationale="CRM 写端点统一失效（BLF-667）", issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="crm", layer="L0", module="app.api.v1.endpoints.crm",
        function="delete_customer", method="DELETE", path="/crm",
        required_decorator=DECORATOR_L0, decorator_applied=True,
        rationale="CRM 写端点统一失效（BLF-667）", issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="crm", layer="L0", module="app.api.v1.endpoints.crm",
        function="batch_transfer", method="POST", path="/crm",
        required_decorator=DECORATOR_L0, decorator_applied=True,
        rationale="CRM 写端点统一失效（BLF-667）", issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="crm", layer="L0", module="app.api.v1.endpoints.crm",
        function="batch_move_to_sea", method="POST", path="/crm",
        required_decorator=DECORATOR_L0, decorator_applied=True,
        rationale="CRM 写端点统一失效（BLF-667）", issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="crm", layer="L0", module="app.api.v1.endpoints.crm",
        function="claim_from_sea", method="POST", path="/crm",
        required_decorator=DECORATOR_L0, decorator_applied=True,
        rationale="CRM 写端点统一失效（BLF-667）", issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="crm", layer="L0", module="app.api.v1.endpoints.crm",
        function="create_contact", method="POST", path="/crm",
        required_decorator=DECORATOR_L0, decorator_applied=True,
        rationale="CRM 写端点统一失效（BLF-667）", issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="crm", layer="L0", module="app.api.v1.endpoints.crm",
        function="update_contact", method="PATCH", path="/crm",
        required_decorator=DECORATOR_L0, decorator_applied=True,
        rationale="CRM 写端点统一失效（BLF-667）", issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="crm", layer="L0", module="app.api.v1.endpoints.crm",
        function="delete_contact", method="DELETE", path="/crm",
        required_decorator=DECORATOR_L0, decorator_applied=True,
        rationale="CRM 写端点统一失效（BLF-667）", issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="crm", layer="L0", module="app.api.v1.endpoints.crm",
        function="create_lead", method="POST", path="/crm",
        required_decorator=DECORATOR_L0, decorator_applied=True,
        rationale="CRM 写端点统一失效（BLF-667）", issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="crm", layer="L0", module="app.api.v1.endpoints.crm",
        function="update_lead", method="PATCH", path="/crm",
        required_decorator=DECORATOR_L0, decorator_applied=True,
        rationale="CRM 写端点统一失效（BLF-667）", issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="crm", layer="L0", module="app.api.v1.endpoints.crm",
        function="batch_transfer_leads", method="POST", path="/crm",
        required_decorator=DECORATOR_L0, decorator_applied=True,
        rationale="CRM 写端点统一失效（BLF-667）", issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="crm", layer="L0", module="app.api.v1.endpoints.crm",
        function="batch_move_leads_to_pool", method="POST", path="/crm",
        required_decorator=DECORATOR_L0, decorator_applied=True,
        rationale="CRM 写端点统一失效（BLF-667）", issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="crm", layer="L0", module="app.api.v1.endpoints.crm",
        function="claim_lead_from_pool", method="POST", path="/crm",
        required_decorator=DECORATOR_L0, decorator_applied=True,
        rationale="CRM 写端点统一失效（BLF-667）", issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="crm", layer="L0", module="app.api.v1.endpoints.crm",
        function="convert_lead", method="POST", path="/crm",
        required_decorator=DECORATOR_L0, decorator_applied=True,
        rationale="CRM 写端点统一失效（BLF-667）", issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="crm", layer="L0", module="app.api.v1.endpoints.crm",
        function="create_follow", method="POST", path="/crm",
        required_decorator=DECORATOR_L0, decorator_applied=True,
        rationale="CRM 写端点统一失效（BLF-667）", issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="crm", layer="L0", module="app.api.v1.endpoints.crm",
        function="create_rule", method="POST", path="/crm",
        required_decorator=DECORATOR_L0, decorator_applied=True,
        rationale="CRM 写端点统一失效（BLF-667）", issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="crm", layer="L0", module="app.api.v1.endpoints.crm",
        function="update_rule", method="PATCH", path="/crm",
        required_decorator=DECORATOR_L0, decorator_applied=True,
        rationale="CRM 写端点统一失效（BLF-667）", issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="crm", layer="L0", module="app.api.v1.endpoints.crm",
        function="delete_rule", method="DELETE", path="/crm",
        required_decorator=DECORATOR_L0, decorator_applied=True,
        rationale="CRM 写端点统一失效（BLF-667）", issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="crm", layer="L0", module="app.api.v1.endpoints.crm",
        function="update_workflow_settings", method="PUT", path="/crm",
        required_decorator=DECORATOR_L0, decorator_applied=True,
        rationale="CRM 写端点统一失效（BLF-667）", issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="crm", layer="L0", module="app.api.v1.endpoints.crm",
        function="create_category", method="POST", path="/crm",
        required_decorator=DECORATOR_L0, decorator_applied=True,
        rationale="CRM 写端点统一失效（BLF-667）", issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="crm", layer="L0", module="app.api.v1.endpoints.crm",
        function="update_category", method="PATCH", path="/crm",
        required_decorator=DECORATOR_L0, decorator_applied=True,
        rationale="CRM 写端点统一失效（BLF-667）", issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="crm", layer="L0", module="app.api.v1.endpoints.crm",
        function="delete_category", method="DELETE", path="/crm",
        required_decorator=DECORATOR_L0, decorator_applied=True,
        rationale="CRM 写端点统一失效（BLF-667）", issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="crm", layer="L0", module="app.api.v1.endpoints.crm",
        function="set_customer_categories", method="PUT", path="/crm",
        required_decorator=DECORATOR_L0, decorator_applied=True,
        rationale="CRM 写端点统一失效（BLF-667）", issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="crm", layer="L0", module="app.api.v1.endpoints.crm",
        function="create_saved_view", method="POST", path="/crm",
        required_decorator=DECORATOR_L0, decorator_applied=True,
        rationale="CRM 写端点统一失效（BLF-667）", issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="crm", layer="L0", module="app.api.v1.endpoints.crm",
        function="update_saved_view", method="PATCH", path="/crm",
        required_decorator=DECORATOR_L0, decorator_applied=True,
        rationale="CRM 写端点统一失效（BLF-667）", issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="crm", layer="L0", module="app.api.v1.endpoints.crm",
        function="delete_saved_view", method="DELETE", path="/crm",
        required_decorator=DECORATOR_L0, decorator_applied=True,
        rationale="CRM 写端点统一失效（BLF-667）", issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="crm_tasks", layer="L0", module="app.api.v1.endpoints.crm",
        function="create_task", method="POST", path="/crm/tasks",
        required_decorator=DECORATOR_L0, decorator_applied=True,
        rationale="CRM 任务写端点统一失效（BLF-667）", issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="crm_tasks", layer="L0", module="app.api.v1.endpoints.crm",
        function="update_task", method="PATCH", path="/crm/tasks",
        required_decorator=DECORATOR_L0, decorator_applied=True,
        rationale="CRM 任务写端点统一失效（BLF-667）", issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="crm_tasks", layer="L0", module="app.api.v1.endpoints.crm",
        function="set_task_status", method="POST", path="/crm/tasks",
        required_decorator=DECORATOR_L0, decorator_applied=True,
        rationale="CRM 任务写端点统一失效（BLF-667）", issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="crm_tasks", layer="L0", module="app.api.v1.endpoints.crm",
        function="complete_task", method="POST", path="/crm/tasks",
        required_decorator=DECORATOR_L0, decorator_applied=True,
        rationale="CRM 任务写端点统一失效（BLF-667）", issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="crm_tasks", layer="L0", module="app.api.v1.endpoints.crm",
        function="cancel_task", method="POST", path="/crm/tasks",
        required_decorator=DECORATOR_L0, decorator_applied=True,
        rationale="CRM 任务写端点统一失效（BLF-667）", issue_ref="BLF-667",
    ),
)

# ── L1 弱一致层（9 域）写端点 ─────────────────────────────────────────
# 首版登记：已有 invalidate 的 shipment_schedules / inventory_analysis 快照。

L1_WRITE_ENDPOINTS: tuple[WriteEndpointSpec, ...] = (
    WriteEndpointSpec(
        domain="shipment_schedules",
        layer="L1",
        module="app.api.v1.endpoints.shipment_schedules",
        function="create_shipment_schedule",
        method="POST",
        path="/shipment-schedules",
        required_decorator=DECORATOR_L1,
        decorator_applied=True,
        rationale="货件新建：列表/汇总/在途量缓存需失效",
        issue_ref="BLF-666 (BLF-668 改造)",
    ),
    WriteEndpointSpec(
        domain="shipment_schedules",
        layer="L1",
        module="app.api.v1.endpoints.shipment_schedules",
        function="update_shipment_schedule",
        method="PATCH",
        path="/shipment-schedules/{schedule_id}",
        required_decorator=DECORATOR_L1,
        decorator_applied=True,
        rationale="货件编辑：详情/列表缓存需失效",
        issue_ref="BLF-666 (BLF-668 改造)",
    ),
    WriteEndpointSpec(
        domain="shipment_schedules",
        layer="L1",
        module="app.api.v1.endpoints.shipment_schedules",
        function="delete_shipment_schedule",
        method="DELETE",
        path="/shipment-schedules/{schedule_id}",
        required_decorator=DECORATOR_L1,
        decorator_applied=True,
        rationale="货件删除：列表缓存需失效",
        issue_ref="BLF-666 (BLF-668 改造)",
    ),


    # ── BLF-668 新增 L1 写端点（agent shipments / product_analysis / sku_info）──
    # agent shipments（async 写路径 ×6）
    WriteEndpointSpec(
        domain="shipment_schedules", layer="L1",
        module="app.api.v1.endpoints.agent.shipments",
        function="create_shipment", method="POST", path="/agent/projects/{project_id}/shipments",
        required_decorator=DECORATOR_L1, decorator_applied=True,
        rationale="Agent 发货创建（源路径）；L1 best_effort", issue_ref="BLF-668",
    ),
    WriteEndpointSpec(
        domain="shipment_schedules", layer="L1",
        module="app.api.v1.endpoints.agent.shipments",
        function="replace_shipment_items", method="PUT", path="/agent/projects/{project_id}/shipments/{shipment_no}/items",
        required_decorator=DECORATOR_L1, decorator_applied=True,
        rationale="Agent 发货 items 替换（源路径）；L1 best_effort", issue_ref="BLF-668",
    ),
    WriteEndpointSpec(
        domain="shipment_schedules", layer="L1",
        module="app.api.v1.endpoints.agent.shipments",
        function="patch_shipment", method="PATCH", path="/agent/projects/{project_id}/shipments/{shipment_no}",
        required_decorator=DECORATOR_L1, decorator_applied=True,
        rationale="Agent 发货更新（源路径）；L1 best_effort", issue_ref="BLF-668",
    ),
    WriteEndpointSpec(
        domain="shipment_schedules", layer="L1",
        module="app.api.v1.endpoints.agent.shipments",
        function="transition_shipment_status", method="POST", path="/agent/projects/{project_id}/shipments/{shipment_no}/status",
        required_decorator=DECORATOR_L1, decorator_applied=True,
        rationale="Agent 发货状态变更（源路径）；L1 best_effort", issue_ref="BLF-668",
    ),
    WriteEndpointSpec(
        domain="shipment_schedules", layer="L1",
        module="app.api.v1.endpoints.agent.shipments",
        function="recalculate_shipment_costs", method="POST", path="/agent/projects/{project_id}/shipments/{shipment_no}/recalculate",
        required_decorator=DECORATOR_L1, decorator_applied=True,
        rationale="Agent 发货成本重算（源路径）；L1 best_effort", issue_ref="BLF-668",
    ),
    WriteEndpointSpec(
        domain="shipment_schedules", layer="L1",
        module="app.api.v1.endpoints.agent.shipments",
        function="delete_shipment", method="DELETE", path="/agent/projects/{project_id}/shipments/{shipment_no}",
        required_decorator=DECORATOR_L1, decorator_applied=True,
        rationale="Agent 发货删除（源路径）；L1 best_effort", issue_ref="BLF-668",
    ),
    # product_analysis（读缓存已复活 + L1 装饰器）
    WriteEndpointSpec(
        domain="product_analysis", layer="L1",
        module="app.api.v1.endpoints.product_analysis",
        function="recompute_product_analysis_weekly", method="POST", path="/product-analysis/weekly/recompute",
        required_decorator=DECORATOR_L1, decorator_applied=True,
        rationale="产品分析周重算；L1 best_effort", issue_ref="BLF-668",
    ),
    WriteEndpointSpec(
        domain="product_analysis", layer="L1",
        module="app.api.v1.endpoints.product_analysis",
        function="run_product_analysis", method="POST", path="/product-analysis/calculation/run",
        required_decorator=DECORATOR_L1, decorator_applied=True,
        rationale="产品分析计算 run；L1 best_effort", issue_ref="BLF-668",
    ),
    WriteEndpointSpec(
        domain="product_analysis", layer="L1",
        module="app.api.v1.endpoints.product_analysis",
        function="trigger_pt1_recompute", method="POST", path="/product-analysis/trigger-recompute",
        required_decorator=DECORATOR_L1, decorator_applied=True,
        rationale="产品分析 PT1 重算；L1 best_effort", issue_ref="BLF-668",
    ),
    WriteEndpointSpec(
        domain="product_analysis", layer="L1",
        module="app.api.v1.endpoints.product_analysis",
        function="upload_product_analysis_sources", method="POST", path="/product-analysis/sources/upload-file",
        required_decorator=DECORATOR_L1, decorator_applied=True,
        rationale="产品分析源文件上传；L1 best_effort", issue_ref="BLF-668",
    ),
    # sku_info（5 写端点）
    WriteEndpointSpec(
        domain="sku_info", layer="L1",
        module="app.api.v1.endpoints.sku_info",
        function="create_or_update_sku_record", method="POST", path="/sku-info",
        required_decorator=DECORATOR_L1, decorator_applied=True,
        rationale="SKU 主数据 upsert；L1 best_effort", issue_ref="BLF-668",
    ),
    WriteEndpointSpec(
        domain="sku_info", layer="L1",
        module="app.api.v1.endpoints.sku_info",
        function="import_sku_records_from_csv", method="POST", path="/sku-info/bulk",
        required_decorator=DECORATOR_L1, decorator_applied=True,
        rationale="SKU 主数据 CSV 导入；L1 best_effort", issue_ref="BLF-668",
    ),
    WriteEndpointSpec(
        domain="sku_info", layer="L1",
        module="app.api.v1.endpoints.sku_info",
        function="update_sku_record", method="PATCH", path="/sku-info/{sku_record_id}",
        required_decorator=DECORATOR_L1, decorator_applied=True,
        rationale="SKU 主数据编辑；L1 best_effort", issue_ref="BLF-668",
    ),
    WriteEndpointSpec(
        domain="sku_info", layer="L1",
        module="app.api.v1.endpoints.sku_info",
        function="delete_sku_record_endpoint", method="DELETE", path="/sku-info/{sku_record_id}",
        required_decorator=DECORATOR_L1, decorator_applied=True,
        rationale="SKU 主数据删除；L1 best_effort", issue_ref="BLF-668",
    ),
    WriteEndpointSpec(
        domain="sku_info", layer="L1",
        module="app.api.v1.endpoints.sku_info",
        function="move_sku_record", method="POST", path="/sku-info/{sku_record_id}/move",
        required_decorator=DECORATOR_L1, decorator_applied=True,
        rationale="SKU 主数据转移项目；L1 best_effort", issue_ref="BLF-668",
    ),
    # return_analysis（Celery 任务，_celery 装饰器）

)

# ── L2 省 token 层（2 域）写端点 ──────────────────────────────────────
# 首版：ai_chat_v2 / ai_insight 的写端点待 BLF-669 盘点后登记。

L2_WRITE_ENDPOINTS: tuple[WriteEndpointSpec, ...] = ()

# ── 合并访问器 ────────────────────────────────────────────────────────


def all_write_endpoints() -> tuple[WriteEndpointSpec, ...]:
    """合并三层全部白名单登记项（去重保序）。"""
    return tuple(
        dict.fromkeys([*L0_WRITE_ENDPOINTS, *L1_WRITE_ENDPOINTS, *L2_WRITE_ENDPOINTS])
    )


ALL_WRITE_ENDPOINTS: tuple[WriteEndpointSpec, ...] = all_write_endpoints()


def endpoints_for_domain(domain: str) -> tuple[WriteEndpointSpec, ...]:
    """按缓存域筛白名单登记项（后续子 issue 改造时用）。"""
    return tuple(spec for spec in ALL_WRITE_ENDPOINTS if spec.domain == domain)
