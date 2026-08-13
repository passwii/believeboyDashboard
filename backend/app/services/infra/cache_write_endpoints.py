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
        project_id_from="path",
        rationale="BLF-633 补货分析设置写路径（web）；已手动 invalidate，待改装饰器",
        issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="inventory_replenishment",
        module="app.api.v1.endpoints.inventory_replenishment_snapshots",
        function="create_snapshot",
        project_id_from="path",
        rationale="BLF-633 快照上传写路径（web）；已手动 invalidate，待改装饰器",
        issue_ref="BLF-667",
    ),
    # platform_revenues —— 既有 invalidate_platform_revenue_cache()
    WriteEndpointSpec(
        domain="platform_revenues",
        module="app.api.v1.endpoints.platform_revenues",
        function="create_platform_revenue",
        rationale="平台收入新增写端点；既有全量 invalidate，待改装饰器",
        issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="platform_revenues",
        module="app.api.v1.endpoints.platform_revenues",
        function="update_platform_revenue",
        rationale="平台收入修改写端点；待改装饰器",
        issue_ref="BLF-667",
    ),
    WriteEndpointSpec(
        domain="platform_revenues",
        module="app.api.v1.endpoints.platform_revenues",
        function="delete_platform_revenue",
        rationale="平台收入删除写端点；待改装饰器",
        issue_ref="BLF-667",
    ),
)

# ── L1 弱一致层（9 域 × 部分写端点）── 建议登记（方便审计）──────────────
# 首版登记已存在的写端点；L1 装饰器声明待子 #3（BLF-668）填写。

L1_WRITE_ENDPOINTS: tuple[WriteEndpointSpec, ...] = (
    WriteEndpointSpec(
        domain="shipment_schedules",
        module="app.api.v1.endpoints.shipment_schedules",
        function="create_shipment_schedule",
        rationale="发货计划创建（4 源写路径之一）；待 L1 装饰器",
        issue_ref="BLF-668",
    ),
    WriteEndpointSpec(
        domain="shipment_schedules",
        module="app.api.v1.endpoints.shipment_schedules",
        function="update_shipment_schedule",
        rationale="发货计划更新（4 源写路径之一）；待 L1 装饰器",
        issue_ref="BLF-668",
    ),
    WriteEndpointSpec(
        domain="return_analysis",
        module="app.celery_tasks.return_analysis_refresh",
        function="refresh_return_aggregates",
        project_id_from="arg",
        on_error="log",
        rationale="退货分析刷新 Celery 任务（v1+v2 双清）；首版登记，装饰器随 BLF-668 落地",
        issue_ref="BLF-668",
    ),
)

# ── L2 长 TTL 省 token 层（2 域 × 写端点）── 强制登记 ──────────────────
# ai_chat_v2 / ai_insight 写端点盘点在子 #4（BLF-669）完成；首版暂无登记。

L2_WRITE_ENDPOINTS: tuple[WriteEndpointSpec, ...] = ()


def ALL_WRITE_ENDPOINTS() -> tuple[WriteEndpointSpec, ...]:
    """合并访问器：L0 + L1 + L2 全量白名单。"""
    return L0_WRITE_ENDPOINTS + L1_WRITE_ENDPOINTS + L2_WRITE_ENDPOINTS
