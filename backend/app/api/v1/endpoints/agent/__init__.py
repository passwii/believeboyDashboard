"""Agent API 命名空间 — ``/api/v1/agent/*``。

面向 LLM Agent 的读写 API（替代 /api/v1/external/*；设计稿见
docs/agent-api-design.md）。鉴权 day-1 强制：Bearer + X-Agent-Id。
"""

from fastapi import APIRouter, Depends, HTTPException

from app.api.agent.auth import require_agent_credential
from app.api.agent.rate_limit import require_agent_read_rate_limit
from app.api.agent.scope import require_business_scope
from app.api.v1.endpoints.agent.account_health import account_health_router

# BLF-581：其余 9 个 ad 域原生化（agent/ad_*.py 原生路由）
from app.api.v1.endpoints.agent.ad_budgets import ad_budgets_router
from app.api.v1.endpoints.agent.ad_campaigns import ad_campaigns_router
from app.api.v1.endpoints.agent.ad_invalid_traffic import ad_invalid_traffic_router
from app.api.v1.endpoints.agent.ad_placements import ad_placements_router
from app.api.v1.endpoints.agent.ad_promoted_products import ad_promoted_products_router
from app.api.v1.endpoints.agent.ad_purchased_products import (
    ad_purchased_products_router,
)
from app.api.v1.endpoints.agent.ad_search_term_shares import (
    ad_search_term_shares_router,
)
from app.api.v1.endpoints.agent.ad_search_terms import ad_search_terms_router
from app.api.v1.endpoints.agent.ad_targets import ad_targets_router
from app.api.v1.endpoints.agent.ad_time_trends import ad_time_trends_router
from app.api.v1.endpoints.agent.health import router as health_router
from app.api.v1.endpoints.agent.inventory import inventory_router
from app.api.v1.endpoints.agent.inventory_ledger import inventory_ledger_router
from app.api.v1.endpoints.agent.new_product_calculations import (
    new_product_calculations_router,
)
from app.api.v1.endpoints.agent.platform_inspection import platform_inspection_router
from app.api.v1.endpoints.agent.pricing_calculation_snapshots import (
    pricing_snapshots_router,
)
from app.api.v1.endpoints.agent.projects import projects_router
from app.api.v1.endpoints.agent.provisioning import provisioning_router
from app.api.v1.endpoints.agent.replenishment_analysis import (
    replenishment_analysis_router,
)
from app.api.v1.endpoints.agent.report_upload_status import report_upload_status_router
from app.api.v1.endpoints.agent.return_analysis import return_analysis_router
from app.api.v1.endpoints.agent.sales import sales_router
from app.api.v1.endpoints.agent.shipments import shipments_router
from app.api.v1.endpoints.agent.shop_calculation import shop_calculation_router
from app.api.v1.endpoints.agent.shop_calculations import shop_calculations_router
from app.api.v1.endpoints.agent.sku_info import sku_info_router
from app.api.v1.endpoints.agent.upload import router as upload_router

agent_router = APIRouter(
    prefix="/agent",
    tags=["agent"],
    dependencies=[
        Depends(require_agent_credential),
        Depends(require_agent_read_rate_limit),
    ],
)

agent_router.include_router(health_router)
agent_router.include_router(
    shipments_router,
    dependencies=[Depends(require_business_scope("shipments"))],
)
agent_router.include_router(
    shop_calculations_router,
    dependencies=[Depends(require_business_scope("shop_calculations"))],
)
# 新品测算域（BLF-451）：5 条路由（读3+写1+试算1），挂 business_scope(
# "new_product_calculations")（BLF-526 上线收尾，与其它 live 域对齐）。
# 必须插在兜底路由之前，否则被静默吞成 404 壳。
agent_router.include_router(
    new_product_calculations_router,
    dependencies=[Depends(require_business_scope("new_product_calculations"))],
)
# 退货分析域（BLF-470）：纯读 5 条路由，挂 business_scope("return_analysis")
# （D3 拍板，与 shipments/shop_calculations 对齐）。
agent_router.include_router(
    return_analysis_router,
    dependencies=[Depends(require_business_scope("return_analysis"))],
)
# 库存信息域（BLF-478）：纯读 1 条路由，挂 business_scope("inventory")——
# 与补货/库存台账分析独立（只读当前库存快照，不含 DMS/补货周期）。
agent_router.include_router(
    inventory_router,
    dependencies=[Depends(require_business_scope("inventory"))],
)
# 报表上传状态域（BLF-484）：纯读 1 条路由，挂 business_scope(
# "report_upload_status")。project_id 不在路径 → 项目范围过滤在 handler 内
# 按 key 的 project_scope 做（对齐 agent/projects 列表 L2 语义）。
# 必须插在兜底路由之前，否则被静默吞成 404 壳。
agent_router.include_router(
    report_upload_status_router,
    dependencies=[Depends(require_business_scope("report_upload_status"))],
)
# 补货分析域（BLF-502）：Agent 任务模型 6 路由（R1 决策清单 / R2 深挖 /
# R3 总览 / R4 覆盖度 / R5 设置读 / R6 设置写 confirm），挂
# business_scope("replenishment_analysis")（D3，与各域对齐）。
# 必须插在兜底路由之前，否则被静默吞成 404 壳。
agent_router.include_router(
    replenishment_analysis_router,
    dependencies=[Depends(require_business_scope("replenishment_analysis"))],
)
# 店铺合规健康域（BLF-550）：纯读 5 条路由，挂 business_scope("account_health")。
# 数据底座直接复用巡检数据（S2 结论）；project_scope 过滤在 handler 内做（对齐
# report_upload_status 列表过滤语义）。必须插在兜底路由之前，否则被静默吞成 404 壳。
agent_router.include_router(
    account_health_router,
    dependencies=[Depends(require_business_scope("account_health"))],
)
# 销售数据域（BLF-569）：orders/summary → sales/summary 路径 + 域 code
# orders → sales 迁移（用户 2026-08-09 拍板）；v3 下线（BLF-571，2026-08-10
# 用户拍板提前执行）后旧路径 /orders/summary 已移除，仅挂 /sales/summary。
# 挂 business_scope("sales")。必须插在兜底路由之前，否则被静默吞成 404 壳。
agent_router.include_router(
    sales_router,
    dependencies=[Depends(require_business_scope("sales"))],
)
# SKU Info 主数据域（BLF-579 S2）：读 3 + 写 3（confirm 两步），挂
# business_scope("sku_info")（spec §3 D1）。
# 必须插在兜底路由之前，否则被静默吞成 404 壳。
agent_router.include_router(
    sku_info_router,
    dependencies=[Depends(require_business_scope("sku_info"))],
)
# 广告投放活动域（BLF-580 原生化样板）：3 条纯读路由（aggregate + raw +
# raw 单数 alias），原生替换 external 镜像（external/ad_campaigns.py 端点
# 模块已删除），挂 business_scope("ad_analysis")（既有 ad 域 scope 约定：
# 前端 agent-domains.ts 注册表 + 审计操作类型均为 ad_analysis）。
# 必须插在兜底路由之前，否则被静默吞成 404 壳。
agent_router.include_router(
    ad_campaigns_router,
    dependencies=[Depends(require_business_scope("ad_analysis"))],
)
# BLF-581：其余 9 个 ad 域原生路由（budgets/targets/placements/promoted/time_trends/
# search_terms/shares/invalid/purchased），同样挂 business_scope("ad_analysis")——
# 既有 ad 域 scope 约定（前端 agent-domains.ts 注册表 + 审计操作类型）。
# 必须插在兜底路由之前，否则被静默吞成 404 壳。
agent_router.include_router(
    ad_budgets_router,
    dependencies=[Depends(require_business_scope("ad_analysis"))],
)
agent_router.include_router(
    ad_targets_router,
    dependencies=[Depends(require_business_scope("ad_analysis"))],
)
agent_router.include_router(
    ad_placements_router,
    dependencies=[Depends(require_business_scope("ad_analysis"))],
)
agent_router.include_router(
    ad_promoted_products_router,
    dependencies=[Depends(require_business_scope("ad_analysis"))],
)
agent_router.include_router(
    ad_time_trends_router,
    dependencies=[Depends(require_business_scope("ad_analysis"))],
)
agent_router.include_router(
    ad_search_terms_router,
    dependencies=[Depends(require_business_scope("ad_analysis"))],
)
agent_router.include_router(
    ad_search_term_shares_router,
    dependencies=[Depends(require_business_scope("ad_analysis"))],
)
agent_router.include_router(
    ad_invalid_traffic_router,
    dependencies=[Depends(require_business_scope("ad_analysis"))],
)
agent_router.include_router(
    ad_purchased_products_router,
    dependencies=[Depends(require_business_scope("ad_analysis"))],
)
# 项目列表域（BLF-582 原生化）：1 条读路由，无 project_id → 不挂
# project_scope；**无 business_scope 门禁**——跨域基础设施端点（所有 agent
# 域靠它做「名字 → ID」解析）。scope 过滤在 handler 内按 key 的 project_scope 做。
agent_router.include_router(projects_router)
# 库存台账域（BLF-582 原生化）：10 条纯读路由，挂 business_scope(
# "inventory_ledger")（前端 agent-domains.ts 注册表已有 live 条目）。与
# BLF-478 agent/inventory.py（当前库存快照，scope inventory）路径与定位均
# 独立。必须插在兜底路由之前，否则被静默吞成 404 壳。
agent_router.include_router(
    inventory_ledger_router,
    dependencies=[Depends(require_business_scope("inventory_ledger"))],
)
# 店铺测算历史/快照读路由（BLF-582 原生化）：2 条 BI 扁平契约路由，挂与原生
# shop-calculations 域**同一个** business_scope("shop_calculations")——同域
# 不同契约独立保留（边界结论见 agent/shop_calculation.py 模块 docstring）。
agent_router.include_router(
    shop_calculation_router,
    dependencies=[Depends(require_business_scope("shop_calculations"))],
)
# 定价快照域（BLF-582 原生化）：1 条读路由（目录冻结 as-of），挂既有
# business_scope("shop_calculations")（定价快照 = 店铺测算目录冻结，不新增
# 孤儿域 code；边界结论见 agent/pricing_calculation_snapshots.py docstring）。
agent_router.include_router(
    pricing_snapshots_router,
    dependencies=[Depends(require_business_scope("shop_calculations"))],
)
# Agent 凭据自助签发域（BLF-843）：1 条写路由（confirm 两步），挂
# business_scope("agent_provisioning")——只有持有该域的 provisioner key 能
# 调用；业务 key 无此域铸不了 key，双向物理隔离。必须插在兜底路由之前，
# 否则被静默吞成 404 壳。
agent_router.include_router(
    provisioning_router,
    dependencies=[Depends(require_business_scope("agent_provisioning"))],
)
# 平台巡检写侧域（BLF-944）：R0 模板 + W1 保存 / W2 提交 / W3 截图上传 /
# W4 截图删除（confirm 矩阵 spec §7 D5：W2 提交 / W4 删除 confirm 两步，
# W1 保存 / W3 上传不 confirm）。挂 business_scope("platform_inspection")
# （D1，KNOWN_BUSINESS_DOMAINS 已加）。读侧同数据底座由 account-health 覆盖
# （D3 读写边界）。必须插在兜底路由之前，否则被静默吞成 404 壳。
agent_router.include_router(
    platform_inspection_router,
    dependencies=[Depends(require_business_scope("platform_inspection"))],
)
# 报表上传域（BLF-975）：dry-run 校验 + 正式提交两步契约，挂
# business_scope("report_upload")。必须插在兜底路由之前，否则被静默吞成 404 壳。
agent_router.include_router(
    upload_router,
    dependencies=[Depends(require_business_scope("report_upload"))],
)


# 兜底路由前不挂任何镜像（BLF-583：external_mirror 已退役删除，全部域已原生化）。
# 兜底路由必须是 agent_router 注册的最后一个路由。
# 后续新增 include_router(...) 一律插在它之前，否则新路由会被这里
# 静默吞成 404 壳（鉴权照常执行，但永远到不了真实 handler）。
@agent_router.api_route(
    "/{path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    include_in_schema=False,
)
def _agent_namespace_fallback(path: str) -> None:
    """命名空间内未注册路径的兜底 404（spec E6）。

    Starlette 先路由后依赖：没有这条兜底，未匹配路径会绕过路由级鉴权
    直接 404。挂在 agent_router 之下可保证鉴权依赖先跑——未鉴权得
    401 壳，已鉴权得 404 壳（均由 agent 错误处理器包装）。
    """
    raise HTTPException(status_code=404)
