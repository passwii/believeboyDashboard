"""API v1 路由总装（BLF-657 方案 1：懒分组）。

内存优化：53 个 endpoint router 中，33 个按业务域拆进懒分组
（app/api/v1/router_groups/*），由 LazyGroupRouter 控制"首次命中才 import"。
启动时只加载 20 个热/核心 router（auth / health / projects / agent / 内部路由等），
冷接口的 endpoint + schemas + services 模块树在稳态下保持未加载，降低常驻内存。

- include 顺序与改造前完全一致（顺序即匹配优先级）。
- 全部路由路径 / 行为不变；首次 /openapi.json 会一次性加载所有懒分组。
- 详见 app/api/v1/lazy_router.py 的模块 docstring。
"""

from fastapi import APIRouter

from app.api.v1.lazy_router import include_lazy_router

# ---------------------------------------------------------------------------
# 急切核心（启动即加载：热接口 / 健康检查 / 认证 / 内部管理路由）
# ---------------------------------------------------------------------------
from app.api.v1.endpoints.agent import agent_router
from app.api.v1.endpoints.alerts import router as alerts_router
from app.api.v1.endpoints.auth import router as auth_router
from app.api.v1.endpoints.exchange_rates import router as exchange_rates_router
from app.api.v1.endpoints.external_retired import external_retired_router
from app.api.v1.endpoints.health import router as health_router
from app.api.v1.endpoints.internal.api_keys import router as internal_api_keys_router
from app.api.v1.endpoints.internal.user_api_keys import (
    router as internal_user_api_keys_router,
)
from app.api.v1.endpoints.internal.ad_data import router as internal_ad_data_router
from app.api.v1.endpoints.internal_jobs import router as internal_jobs_router
from app.api.v1.endpoints.jobs import router as jobs_router
from app.api.v1.endpoints.notifications import router as notifications_router
from app.api.v1.endpoints.order_info import router as order_info_router
from app.api.v1.endpoints.page_render import router as page_render_router
from app.api.v1.endpoints.profile import router as profile_router
from app.api.v1.endpoints.projects import router as projects_router
from app.api.v1.endpoints.scheduled_reports import router as scheduled_reports_router
from app.api.v1.endpoints.sku_info import router as sku_info_router
from app.api.v1.endpoints.system_management import router as system_management_router
from app.api.v1.endpoints.uploads import router as uploads_router
from app.api.v1.endpoints.users import router as users_router

api_router = APIRouter()

# -- 核心组（原序） ---------------------------------------------------------
api_router.include_router(auth_router)
api_router.include_router(health_router)
api_router.include_router(exchange_rates_router)
api_router.include_router(order_info_router)
api_router.include_router(projects_router)
api_router.include_router(sku_info_router)

# -- 定价测算域（懒，首次命中才 import）--------------------------------------
include_lazy_router(api_router, "app.api.v1.router_groups.pricing_group")

# -- 库存域（懒）--------------------------------------------------------------
include_lazy_router(api_router, "app.api.v1.router_groups.inventory_group")

# -- AI 域（懒）----------------------------------------------------------------
include_lazy_router(api_router, "app.api.v1.router_groups.ai_group")

api_router.include_router(uploads_router)

# -- 广告域（懒）----------------------------------------------------------------
include_lazy_router(api_router, "app.api.v1.router_groups.ads_group")

api_router.include_router(jobs_router)

# -- 报表域（懒）----------------------------------------------------------------
include_lazy_router(api_router, "app.api.v1.router_groups.reporting_group")

# -- 类目/归因分析域（懒）--------------------------------------------------------
include_lazy_router(api_router, "app.api.v1.router_groups.analysis_group")

api_router.include_router(system_management_router)
api_router.include_router(users_router)
api_router.include_router(profile_router)

# -- 数字员工/办公/大屏（懒）------------------------------------------------------
include_lazy_router(api_router, "app.api.v1.router_groups.digital_group")

api_router.include_router(alerts_router)
api_router.include_router(scheduled_reports_router)

# -- 系统杂项（懒）----------------------------------------------------------------
include_lazy_router(api_router, "app.api.v1.router_groups.system_extra_group")

api_router.include_router(page_render_router)
# BLF-459 V3：/external/* 已彻底下线（老消费者全部切到 /agent/*）。
# 保留一个 410 Gone 兜底路由，给仍打旧路径的调用方明确信号（见
# app/api/v1/endpoints/external_retired.py），而不是裸 404。
api_router.include_router(external_retired_router)
api_router.include_router(agent_router)

# -- CRM（懒）---------------------------------------------------------------------
include_lazy_router(api_router, "app.api.v1.router_groups.crm_group")

api_router.include_router(notifications_router)
api_router.include_router(internal_jobs_router)
api_router.include_router(internal_api_keys_router)
api_router.include_router(internal_user_api_keys_router)
# BLF-459 V3：/external/* 下线后浏览器 ad-data 页的内部读路由。
api_router.include_router(internal_ad_data_router)
