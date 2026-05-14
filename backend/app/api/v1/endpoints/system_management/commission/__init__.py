"""
佣金管理端点子模块。
"""
from app.api.v1.endpoints.system_management.commission.records import router as records_router
from app.api.v1.endpoints.system_management.commission.ratio_overrides import router as ratio_overrides_router
from app.api.v1.endpoints.system_management.commission.role_assignments import router as role_assignments_router
from app.api.v1.endpoints.system_management.commission.summary import router as summary_router


__all__ = [
    "records_router",
    "ratio_overrides_router",
    "role_assignments_router",
    "summary_router",
]