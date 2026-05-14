"""
System Management 端点入口。

从 endpoints/system_management.py 拆分而来（阶段 3）。
"""
from fastapi import APIRouter

from app.api.v1.endpoints.system_management.audit import router as audit_router
from app.api.v1.endpoints.system_management.data_management import router as data_management_router, cache_router
from app.api.v1.endpoints.system_management.commission import (
    records_router,
    ratio_overrides_router,
    role_assignments_router,
    summary_router,
)
from app.api.v1.endpoints.system_management.operator_performance import router as operator_performance_router
from app.api.v1.endpoints.system_management.client_audit import router as client_audit_router


router = APIRouter(prefix="/system-management", tags=["系统管理"])

# 审计日志
router.include_router(audit_router)

# 数据管理
router.include_router(data_management_router)

# 缓存管理（独立 prefix）
router.include_router(cache_router)

# 佣金管理
router.include_router(records_router)
router.include_router(ratio_overrides_router)
router.include_router(role_assignments_router)
router.include_router(summary_router)

# 运营绩效
router.include_router(operator_performance_router)

# 客户端审计
router.include_router(client_audit_router)