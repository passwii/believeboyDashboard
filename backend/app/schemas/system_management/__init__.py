"""
System Management Schema 子模块。

从 app.schemas.system_management 拆分而来（阶段 1）。
"""
from app.schemas.system_management.audit import (
    OperationAuditLogActionSummaryItem,
    OperationAuditLogItem,
    OperationAuditLogModuleSummaryItem,
    OperationAuditLogsResponse,
    OperationAuditLogsSummaryResponse,
)

from app.schemas.system_management.client_audit import (
    OperationAuditClientActionRequest,
)

from app.schemas.system_management.data_management import (
    ClearCacheResponse,
    DataLifecycleStatus,
    DataManagementOverviewResponse,
    DataManagementStatusResponse,
    DataSummary,
    DatabaseStatus,
    RecentSystemStatusItem,
    TableHealthStatus,
    TableStatusItem,
    UpdateDataStatusRequest,
    UpdateDataStatusResponse,
)

# 从 _enums 导入枚举，避免循环导入
from app.schemas.system_management.commission._enums import (
    CommissionIncomeCategory,
    CommissionPaymentStatus,
    CommissionProjectPaymentStatus,
    CommissionRatioSource,
)

# 从 commission/__init__.py 导入其他类型
from app.schemas.system_management.commission import (
    CommissionRecordItem,
    CommissionRecordUpsertItem,
    CommissionRecordsResponse,
    CommissionProjectMonthItem,
    CommissionProjectMonthsResponse,
    CommissionYearlyMonthlySummaryItem,
    CommissionYearlyMonthlySummaryResponse,
    CommissionProjectYearlySummaryItem,
    CommissionProjectYearlySummaryResponse,
    CommissionProjectMonthlySummaryMonthItem,
    RecomputeCommissionRequest,
    RecomputeCommissionResponse,
    CommissionRatioOverrideItem,
    CommissionRatioOverridesResponse,
    UpsertCommissionRatioOverrideItem,
    UpsertCommissionRatioOverridesRequest,
    ProjectRoleAssignmentItem,
    ProjectRoleAssignmentsResponse,
    UpsertProjectRoleAssignmentItem,
    UpsertProjectRoleAssignmentsRequest,
    UpdateCommissionPaymentStatusRequest,
    UpdateCommissionPaymentStatusResponse,
    UpdateCommissionProjectPaymentRequest,
    UpdateCommissionProjectPaymentResponse,
)

from app.schemas.system_management.operator_performance import (
    OperatorPerformanceItem,
    OperatorPerformanceResponse,
    UpsertOperatorPerformanceItem,
    UpsertOperatorPerformanceRequest,
)

from app.schemas.system_management.user_role import UserRoleType


__all__ = [
    # 审计
    "OperationAuditLogItem",
    "OperationAuditLogsResponse",
    "OperationAuditLogModuleSummaryItem",
    "OperationAuditLogActionSummaryItem",
    "OperationAuditLogsSummaryResponse",
    # 客户端审计
    "OperationAuditClientActionRequest",
    # 数据管理
    "DataLifecycleStatus",
    "TableHealthStatus",
    "DatabaseStatus",
    "DataSummary",
    "DataManagementStatusResponse",
    "TableStatusItem",
    "RecentSystemStatusItem",
    "DataManagementOverviewResponse",
    "UpdateDataStatusRequest",
    "UpdateDataStatusResponse",
    "ClearCacheResponse",
    # 佣金枚举
    "CommissionIncomeCategory",
    "CommissionPaymentStatus",
    "CommissionProjectPaymentStatus",
    "CommissionRatioSource",
    # 佣金记录
    "CommissionRecordItem",
    "CommissionRecordUpsertItem",
    "CommissionRecordsResponse",
    "UpdateCommissionPaymentStatusRequest",
    "UpdateCommissionPaymentStatusResponse",
    # 项目月度佣金
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
    "UpsertCommissionRatioOverrideItem",
    "UpsertCommissionRatioOverridesRequest",
    "CommissionRatioOverridesResponse",
    # 角色分配
    "ProjectRoleAssignmentItem",
    "UpsertProjectRoleAssignmentItem",
    "UpsertProjectRoleAssignmentsRequest",
    "ProjectRoleAssignmentsResponse",
    # 运营绩效
    "OperatorPerformanceItem",
    "UpsertOperatorPerformanceItem",
    "UpsertOperatorPerformanceRequest",
    "OperatorPerformanceResponse",
    # 用户角色
    "UserRoleType",
]