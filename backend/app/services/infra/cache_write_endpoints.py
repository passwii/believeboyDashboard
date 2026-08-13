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
        decorator_applied=False,
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
        decorator_applied=False,
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
        decorator_applied=False,
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
        decorator_applied=False,
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
        decorator_applied=False,
        rationale="财务数据手动删除：写入后立即失效",
        issue_ref="BLF-666 (BLF-667 改造)",
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
        decorator_applied=False,
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
        decorator_applied=False,
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
        decorator_applied=False,
        rationale="货件删除：列表缓存需失效",
        issue_ref="BLF-666 (BLF-668 改造)",
    ),
    WriteEndpointSpec(
        domain="inventory_analysis",
        layer="L1",
        module="app.api.v1.endpoints.inventory_replenishment_snapshots",
        function="create_snapshot",
        method="POST",
        path="/inventory-replenishment-snapshots",
        required_decorator=DECORATOR_L1,
        decorator_applied=False,
        rationale="快照创建：库存分析/选项缓存需失效",
        issue_ref="BLF-666 (BLF-668 改造)",
    ),
    WriteEndpointSpec(
        domain="inventory_analysis",
        layer="L1",
        module="app.api.v1.endpoints.inventory_replenishment_snapshots",
        function="update_snapshot_endpoint",
        method="PATCH",
        path="/inventory-replenishment-snapshots/{snapshot_id}",
        required_decorator=DECORATOR_L1,
        decorator_applied=False,
        rationale="快照编辑：库存分析缓存需失效",
        issue_ref="BLF-666 (BLF-668 改造)",
    ),
    WriteEndpointSpec(
        domain="inventory_analysis",
        layer="L1",
        module="app.api.v1.endpoints.inventory_replenishment_snapshots",
        function="delete_snapshot_endpoint",
        method="DELETE",
        path="/inventory-replenishment-snapshots/{snapshot_id}",
        required_decorator=DECORATOR_L1,
        decorator_applied=False,
        rationale="快照删除：库存分析缓存需失效",
        issue_ref="BLF-666 (BLF-668 改造)",
    ),
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
