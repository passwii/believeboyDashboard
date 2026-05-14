"""
System Management 数据管理服务。
"""
from datetime import datetime, timedelta

from sqlalchemy import MetaData, Table, func, inspect, select, text
from sqlalchemy.engine.url import make_url
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.schemas.system_management.data_management import (
    DataLifecycleStatus,
    TableHealthStatus,
)


STALE_WINDOW_HOURS = 72
DATA_STATE_TABLE = "system_management_data_state"

TABLE_NAME_CN_MAP: dict[str, str] = {
    "ad_upload_budget_rows": "广告预算数据",
    "ad_upload_campaign_rows": "广告活动数据",
    "ad_upload_files": "广告上传文件",
    "ad_upload_invalid_traffic_rows": "广告无效流量数据",
    "ad_upload_placement_rows": "广告投放位置数据",
    "ad_upload_promoted_product_rows": "广告推广产品数据",
    "ad_upload_purchased_product_rows": "广告购买产品数据",
    "ad_upload_search_term_rows": "广告搜索词数据",
    "ad_upload_search_term_share_rows": "广告搜索词份额数据",
    "ad_upload_target_rows": "广告定向数据",
    "ad_upload_time_trend_rows": "广告时间趋势数据",
    "ai_conversations": "AI对话",
    "ai_messages": "AI消息",
    "analysis_ad_product_rows": "广告产品分析数据",
    "analysis_business_rows": "商业分析数据",
    "analysis_payment_rows": "支付分析数据",
    "analysis_pt1_calculation": "PT1计算数据",
    "analysis_pt_sku_details": "PT-SKU详情数据",
    "analysis_sales_order_rows": "销售订单分析数据",
    "analysis_source_files": "分析数据源文件",
    "analysis_validation_runs": "分析验证记录",
    "category_research_datasets": "类目研究数据集",
    "category_research_product_details": "类目研究产品详情",
    "category_research_sales_trends": "类目研究销售趋势",
    "commission_project_months": "佣金项目月度数据",
    "commission_ratio_overrides": "佣金比例覆盖",
    "commission_records": "佣金记录",
    "exchange_rates": "汇率信息",
    "inventory_replenishment_settings": "补货设置",
    "inventory_snapshot_rows": "库存快照数据",
    "job_runs": "任务执行记录",
    "jobs": "任务配置",
    "monthly_report_pt3_calculation": "月报PT3计算",
    "monthly_report_pt4_calculation": "月报PT4计算",
    "monthly_report_transactions": "月报交易数据",
    "monthly_reports": "月报",
    "operation_audit_logs": "操作审计日志",
    "operator_performance_records": "运营绩效记录",
    "pricing_calculation_runs": "定价计算记录",
    "product_costs": "产品成本",
    "project_role_assignments": "项目角色分配",
    "projects": "项目",
    "report_upload_statuses": "报表上传状态",
    "shipment_schedule_items": "发货计划明细",
    "shipment_schedules": "发货计划",
    "shipment_sku_summaries": "发货SKU汇总",
    "store_sku_pricing_snapshots": "店铺SKU定价快照",
    "system_management_data_state": "系统数据状态",
    "user_accounts": "用户账户",
    "user_presence": "用户在线状态",
    "weekly_payment_pt_summary": "周付款PT汇总",
}


def _now() -> datetime:
    return datetime.now().astimezone()


def _to_iso(value: datetime | str | None) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    if value.tzinfo is None:
        return value.isoformat(timespec="seconds")
    return value.astimezone().isoformat(timespec="seconds")


def _ensure_data_state_table(db: Session) -> None:
    """确保 system_management_data_state 表存在。"""
    try:
        db.execute(
            text(
                f"""
                create table if not exists {DATA_STATE_TABLE} (
                    id integer primary key,
                    status varchar(32) not null,
                    note text,
                    updated_by varchar(255),
                    updated_at timestamp not null
                )
                """
            )
        )
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        if "pg_type_typname_nsp_index" not in str(exc):
            raise


def _load_data_state(
    db: Session,
) -> tuple[str, str | None, str | None, str | None]:
    """返回 (status, note, updated_by, updated_at)。"""
    _ensure_data_state_table(db)
    row = (
        db.execute(
            text(
                f"select status, note, updated_by, updated_at from {DATA_STATE_TABLE} where id = 1"
            )
        )
        .mappings()
        .first()
    )
    if not row:
        return DataLifecycleStatus.active.value, None, None, None

    raw_status = (row.get("status") or DataLifecycleStatus.active.value).lower()
    try:
        status = DataLifecycleStatus(raw_status).value
    except ValueError:
        status = DataLifecycleStatus.active.value

    return status, row.get("note"), row.get("updated_by"), _to_iso(row.get("updated_at"))


def _check_database(db: Session) -> tuple[bool, str]:
    checked_at = _now().isoformat(timespec="seconds")
    healthy = True
    try:
        db.execute(text("select 1"))
    except Exception:
        healthy = False
    return healthy, checked_at


def _collect_table_statuses(db: Session) -> tuple[list[dict], int, int]:
    """扫描所有表，返回 (statuses, total_rows, stale_tables)。"""
    inspector = inspect(db.bind)
    table_names = sorted(
        name for name in inspector.get_table_names() if name != "alembic_version"
    )
    statuses: list[dict] = []
    total_rows = 0
    stale_tables = 0
    stale_threshold = _now() - timedelta(hours=STALE_WINDOW_HOURS)

    for table_name in table_names:
        try:
            table = Table(table_name, MetaData(), autoload_with=db.bind)
            row_count = int(
                db.execute(select(func.count()).select_from(table)).scalar() or 0
            )
            total_rows += row_count

            timestamp_col = None
            if "updated_at" in table.c:
                timestamp_col = table.c.updated_at
            elif "created_at" in table.c:
                timestamp_col = table.c.created_at

            last_updated_dt: datetime | str | None = None
            if timestamp_col is not None:
                last_updated_dt = db.execute(select(func.max(timestamp_col))).scalar()

            if row_count == 0:
                status = TableHealthStatus.empty
                note = "表中暂无数据"
            elif (
                isinstance(last_updated_dt, datetime)
                and last_updated_dt < stale_threshold
            ):
                status = TableHealthStatus.stale
                note = f"超过 {STALE_WINDOW_HOURS} 小时无更新"
                stale_tables += 1
            else:
                status = TableHealthStatus.healthy
                note = "运行正常"

            statuses.append(
                {
                    "table_name": table_name,
                    "table_name_cn": TABLE_NAME_CN_MAP.get(table_name),
                    "row_count": row_count,
                    "last_updated_at": _to_iso(last_updated_dt),
                    "status": status.value,
                    "note": note,
                }
            )
        except Exception as exc:
            statuses.append(
                {
                    "table_name": table_name,
                    "table_name_cn": TABLE_NAME_CN_MAP.get(table_name),
                    "row_count": None,
                    "last_updated_at": None,
                    "status": "error",
                    "note": f"读取失败: {exc.__class__.__name__}",
                }
            )

    return statuses, total_rows, stale_tables


def _collect_recent_statuses(db: Session, data_status: str, checked_at: str) -> list[dict]:
    items: list[dict] = [
        {
            "source": "data-status",
            "level": "info",
            "message": f"当前数据状态: {data_status}",
            "occurred_at": checked_at,
        }
    ]

    inspector = inspect(db.bind)
    if inspector.has_table("jobs") and inspector.has_table("job_runs"):
        rows = (
            db.execute(
                text(
                    """
                select
                    j.job_type as source,
                    j.status as level,
                    coalesce(jr.error_message, jr.log_excerpt, '任务执行记录') as message,
                    coalesce(jr.finished_at, jr.started_at) as occurred_at
                from job_runs jr
                join jobs j on j.id = jr.job_id
                order by jr.started_at desc
                limit 8
                """
                )
            )
            .mappings()
            .all()
        )

        for row in rows:
            items.append(
                {
                    "source": row.get("source") or "job",
                    "level": str(row.get("level") or "info"),
                    "message": str(row.get("message") or "任务状态更新"),
                    "occurred_at": _to_iso(row.get("occurred_at")) or checked_at,
                }
            )

    return items


def set_data_status(
    db: Session,
    status: str,
    note: str | None = None,
    updated_by: str | None = None,
) -> tuple[str, str | None, str | None, str]:
    """更新数据状态。

    返回 (new_status, note, updated_by, updated_at)。
    """
    _ensure_data_state_table(db)
    now = _now().isoformat(timespec="seconds")

    normalized_status = status.lower()
    try:
        DataLifecycleStatus(normalized_status)
    except ValueError:
        normalized_status = DataLifecycleStatus.active.value

    db.execute(
        text(
            f"""
            insert into {DATA_STATE_TABLE} (id, status, note, updated_by, updated_at)
            values (1, :status, :note, :updated_by, :updated_at)
            on conflict (id) do update set
                status = :status,
                note = :note,
                updated_by = :updated_by,
                updated_at = :updated_at
            """
        ),
        {"status": normalized_status, "note": note, "updated_by": updated_by, "updated_at": now},
    )
    db.commit()

    return normalized_status, note, updated_by, now