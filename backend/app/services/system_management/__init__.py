"""
System Management 服务子模块入口。

从 app.services.system_service 拆分而来（阶段 2）。
"""
# 共享工具
from app.services.system_management.shared import (
    PASSIVE_AUDIT_ACTION_PATTERNS,
    DATA_STATE_TABLE,
    STALE_WINDOW_HOURS,
    REPORT_MONTH_RE,
    YEAR_RE,
    MULTI_NAME_SPLIT_RE,
    _to_iso,
    _now,
    _parse_report_month,
    _parse_year,
    _to_decimal,
    _normalize_rate_decimal,
    _dedupe_names,
    _split_role_names,
    _apply_audit_log_filters,
)

# 审计日志服务
from app.services.system_management.audit_service import get_audit_log_summary

# 数据管理服务
from app.services.system_management.data_management_service import (
    _check_database,
    _collect_table_statuses,
    _collect_recent_statuses,
    set_data_status,
    TABLE_NAME_CN_MAP,
    _load_data_state,
)

# 佣金计算逻辑
from app.services.system_management.commission._commission_calculator import (
    _resolve_factory_commission,
    _resolve_operator_bonus_ratio,
    _build_default_bonus_ratios,
    OPERATOR_BONUS_RATIO_TIERS,
    ASSISTANT_BONUS_RATIO,
)

# 佣金服务
from app.services.system_management.commission import (
    upsert_commission_records,
    update_commission_payment_status,
    upsert_commission_ratio_overrides,
    upsert_project_role_assignments,
    get_commission_yearly_monthly_summary,
    get_commission_project_yearly_summary,
    update_commission_project_payment,
    recompute_commission_records,
)

# 运营绩效服务
from app.services.system_management.operator_performance_service import (
    upsert_operator_performance,
)


__all__ = [
    # 共享
    "PASSIVE_AUDIT_ACTION_PATTERNS",
    "DATA_STATE_TABLE",
    "STALE_WINDOW_HOURS",
    "REPORT_MONTH_RE",
    "YEAR_RE",
    "MULTI_NAME_SPLIT_RE",
    "_to_iso",
    "_now",
    "_parse_report_month",
    "_parse_year",
    "_to_decimal",
    "_normalize_rate_decimal",
    "_dedupe_names",
    "_split_role_names",
    "_apply_audit_log_filters",
    # 审计
    "get_audit_log_summary",
    # 数据管理
    "_check_database",
    "_collect_table_statuses",
    "_collect_recent_statuses",
    "set_data_status",
    "TABLE_NAME_CN_MAP",
    "_load_data_state",
    # 佣金计算
    "_resolve_factory_commission",
    "_resolve_operator_bonus_ratio",
    "_build_default_bonus_ratios",
    "OPERATOR_BONUS_RATIO_TIERS",
    "ASSISTANT_BONUS_RATIO",
    # 佣金服务
    "upsert_commission_records",
    "update_commission_payment_status",
    "upsert_commission_ratio_overrides",
    "upsert_project_role_assignments",
    "get_commission_yearly_monthly_summary",
    "get_commission_project_yearly_summary",
    "update_commission_project_payment",
    "recompute_commission_records",
    # 运营绩效
    "upsert_operator_performance",
]