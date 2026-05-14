"""
佣金管理 Schema 子模块。
"""
# 记录
from app.schemas.system_management.commission.records import (
    CommissionRecordItem,
    CommissionRecordUpsertItem,
    CommissionRecordsResponse,
    UpdateCommissionPaymentStatusRequest,
    UpdateCommissionPaymentStatusResponse,
    UpsertCommissionRecordsRequest,
)

# 项目月度佣金
from app.schemas.system_management.commission.project_months import (
    CommissionProjectMonthItem,
    CommissionProjectMonthsResponse,
    UpdateCommissionProjectPaymentRequest,
    UpdateCommissionProjectPaymentResponse,
)

# 汇总
from app.schemas.system_management.commission.summary import (
    CommissionProjectYearlySummaryItem,
    CommissionProjectYearlySummaryResponse,
    CommissionProjectMonthlySummaryMonthItem,
    CommissionYearlyMonthlySummaryItem,
    CommissionYearlyMonthlySummaryResponse,
    RecomputeCommissionRequest,
    RecomputeCommissionResponse,
)

# 比例覆盖
from app.schemas.system_management.commission.ratio_overrides import (
    CommissionRatioOverrideItem,
    CommissionRatioOverridesResponse,
    UpsertCommissionRatioOverrideItem,
    UpsertCommissionRatioOverridesRequest,
)

# 角色分配
from app.schemas.system_management.commission.role_assignments import (
    ProjectRoleAssignmentItem,
    ProjectRoleAssignmentsResponse,
    UpsertProjectRoleAssignmentItem,
    UpsertProjectRoleAssignmentsRequest,
)

__all__ = [
    # 记录
    "CommissionRecordItem",
    "CommissionRecordUpsertItem",
    "CommissionRecordsResponse",
    "UpdateCommissionPaymentStatusRequest",
    "UpdateCommissionPaymentStatusResponse",
    "UpsertCommissionRecordsRequest",
    # 项目月度
    "CommissionProjectMonthItem",
    "CommissionProjectMonthsResponse",
    "UpdateCommissionProjectPaymentRequest",
    "UpdateCommissionProjectPaymentResponse",
    # 汇总
    "CommissionYearlyMonthlySummaryItem",
    "CommissionYearlyMonthlySummaryResponse",
    "CommissionProjectYearlySummaryItem",
    "CommissionProjectYearlySummaryResponse",
    "CommissionProjectMonthlySummaryMonthItem",
    # 重计算
    "RecomputeCommissionRequest",
    "RecomputeCommissionResponse",
    # 比例覆盖
    "CommissionRatioOverrideItem",
    "CommissionRatioOverridesResponse",
    "UpsertCommissionRatioOverrideItem",
    "UpsertCommissionRatioOverridesRequest",
    # 角色分配
    "ProjectRoleAssignmentItem",
    "ProjectRoleAssignmentsResponse",
    "UpsertProjectRoleAssignmentItem",
    "UpsertProjectRoleAssignmentsRequest",
]