from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Optional

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from app.models import AdUploadFile, AnalysisSourceFile, ReportUploadLog
from app.services import project_service


def _business_date_iso(src: AnalysisSourceFile) -> Optional[str]:
    """Return the business date of a source file as an ISO date string.

    For periodic reports (business_report, payment_report, etc.), uses period_end_date.
    For inventory snapshots, uses snapshot_at.
    Returns None if the date field is null.
    """
    if src.report_type == "inventory_report":
        if src.snapshot_at is not None:
            return src.snapshot_at.date().isoformat()
        return None
    # Periodic report — use period_end_date as the canonical business date
    if src.period_end_date is not None:
        return src.period_end_date.isoformat()
    return None

# 广告类报表 report_type 必须以 ad_ 开头、_report 结尾
AD_REPORT_TYPE_PREFIX = "ad_"
AD_REPORT_TYPE_SUFFIX = "_report"

REPORT_TYPES = [
    # 已接入
    "inventory_report",      # 库存
    "business_report",        # 业务
    # 广告（C 表 10 个细分维度；已推广商品报告 = ad_promoted_product_report 在列内）
    "ad_search_term_share_report",  # 广告 - 搜索词展示量份额
    "ad_budget_report",             # 广告 - 预算
    "ad_campaign_report",           # 广告 - 广告活动
    "ad_purchased_product_report",  # 广告 - 已购买商品
    "ad_promoted_product_report",   # 广告 - 推广的商品（已推广商品报告）
    "ad_invalid_traffic_report",    # 广告 - 总流量和无效流量
    "ad_placement_report",          # 广告 - 广告位
    "ad_target_report",             # 广告 - 搜索词投放
    "ad_search_term_report",        # 广告 - 搜索词
    "ad_time_trend_report",         # 广告 - 按时间查看效果
    "sales_report",                 # 销售
    "payment_report",               # 付款
    "return_report",                # 退货
    # 预留（未来报表类型）
    "storage_report",         # 仓储
    "returns_detail_report",  # 退货明细
    "fba_inventory_report",   # FBA库存
    "reimbursement_report",   # 赔偿
    "tax_invoice_report",     # 税务发票
    "health_report",          # 健康报告
    "advertising_reports",    # 广告报表
    "brand_report",           # 品牌报表
    "vendor_report",          # 供应商报表
]


def _ad_report_types() -> list[str]:
    """Return all ad_*_report entries from REPORT_TYPES (derived from a single source of truth)."""
    return [
        rt for rt in REPORT_TYPES
        if rt.startswith(AD_REPORT_TYPE_PREFIX) and rt.endswith(AD_REPORT_TYPE_SUFFIX)
    ]


@dataclass
class ReportTypeStatus:
    report_type: str
    has_data: bool  # 有真实业务数据
    is_uploaded: bool  # 是否有上传记录（含历史月份补充）
    latest_date: Optional[str] = None  # 报表实际业务日期（period_end_date / snapshot_at）
    original_filename: Optional[str] = None
    status_source: Optional[str] = None  # upload_log | business_date_backfill


@dataclass
class ProjectReportStatus:
    project_id: int
    project_name: str
    country: str
    statuses: list[ReportTypeStatus]


@dataclass
class RpaReportStatusResponse:
    country: str
    items: list[ProjectReportStatus]


def get_report_status_for_date(
    db: Session,
    *,
    report_date: str,
    country: str = "US",
    operator: Optional[str] = None,
    is_admin: bool = True,
) -> RpaReportStatusResponse:
    """Query RPA report status for a given date using report_upload_logs.

    Three-priority logic:
    1. report_upload_logs — today's upload record (upload_date == target_date)
    2. analysis_source_files — source file whose business date covers the target date
       (periodic: period_start_date <= target_date <= period_end_date;
        inventory: snapshot_at date == target_date)
    3. latest_date reflects the source file's actual business date
       (period_end_date for periodic reports, snapshot_at date for inventory),
       not the query parameter — enabling historical month coverage.
    """
    try:
        target_date = date.fromisoformat(report_date)
    except ValueError:
        target_date = None

    projects = project_service.list_project_items(
        db, operator=operator, is_admin=is_admin
    )
    project_map = {int(p.id): p.project_name for p in projects}
    project_sort_orders = {int(p.id): p.sort_order for p in projects}
    project_ids = list(project_map.keys())

    if not project_ids:
        return RpaReportStatusResponse(country=country, items=[])

    # Build default status map
    status_by_project: dict[int, dict[str, ReportTypeStatus]] = {
        pid: {rt: ReportTypeStatus(report_type=rt, has_data=False, is_uploaded=False) for rt in REPORT_TYPES}
        for pid in project_ids
    }

    if target_date is None:
        items = [
            ProjectReportStatus(
                project_id=pid,
                project_name=project_map[pid],
                country=country,
                statuses=list(status_by_project[pid].values()),
            )
            for pid in sorted(
                project_ids,
                key=lambda pid: project_sort_orders.get(pid, 0),
            )
        ]
        return RpaReportStatusResponse(country=country, items=items)

    # Unified query: fetch all upload logs for target date
    logs = db.execute(
        select(ReportUploadLog)
        .where(ReportUploadLog.project_id.in_(project_ids))
        .where(ReportUploadLog.country == country)
        .where(ReportUploadLog.upload_date == target_date)
    ).scalars().all()

    # Group by (project_id, report_type) — keep latest if multiple
    log_map: dict[tuple[int, str], ReportUploadLog] = {}
    for log in logs:
        key = (int(log.project_id), log.report_type)
        if key not in log_map or log.created_at > log_map[key].created_at:
            log_map[key] = log

    source_ids = sorted(
        {
            int(log.source_file_id)
            for log in log_map.values()
            if log.source_file_id is not None
        }
    )
    source_by_id: dict[int, AnalysisSourceFile] = {}
    if source_ids:
        source_by_id = {
            int(source.id): source
            for source in db.execute(
                select(AnalysisSourceFile).where(AnalysisSourceFile.id.in_(source_ids))
            ).scalars().all()
        }

    # Populate status from upload logs (priority 1)
    for (pid, rt), log in log_map.items():
        if pid not in status_by_project:
            continue
        original_filename = None
        latest_date: Optional[str] = report_date
        if log.source_file_id:
            source = source_by_id.get(int(log.source_file_id))
            if source:
                original_filename = source.original_filename
                # Prefer the source file's actual business date over the query param
                biz = _business_date_iso(source)
                if biz is not None:
                    latest_date = biz

        status_by_project[pid][rt] = ReportTypeStatus(
            report_type=rt,
            has_data=log.has_real_data,
            is_uploaded=True,
            latest_date=latest_date,
            original_filename=original_filename,
            status_source="upload_log",
        )

    # ── Fallback: query analysis_source_files for date coverage ──
    # Priority 2: if no upload_log, check actual source file rows by business date.
    # This turns previously red (missing) markers green when data actually exists.
    missing_pairs = [
        (pid, rt)
        for pid in project_ids
        for rt, st in status_by_project[pid].items()
        if not st.is_uploaded
    ]
    if missing_pairs and target_date is not None:
        missing_report_types = sorted({rt for _, rt in missing_pairs})
        sources = db.execute(
            select(AnalysisSourceFile)
            .where(AnalysisSourceFile.project_id.in_(project_ids))
            .where(AnalysisSourceFile.report_type.in_(missing_report_types))
            .where(AnalysisSourceFile.country == country)
            .where(AnalysisSourceFile.is_current.is_(True))
            .where(AnalysisSourceFile.ingestion_status == "success")
            .where(
                or_(
                    # Periodic reports: target_date within [period_start, period_end]
                    and_(
                        AnalysisSourceFile.report_type.in_([
                            "business_report",
                            "payment_report",
                            "sales_report",
                            "return_report",
                        ]),
                        AnalysisSourceFile.period_start_date.isnot(None),
                        AnalysisSourceFile.period_end_date.isnot(None),
                        AnalysisSourceFile.period_start_date <= target_date,
                        AnalysisSourceFile.period_end_date >= target_date,
                    ),
                    # Inventory snapshot: snapshot_at date matches target_date
                    and_(
                        AnalysisSourceFile.report_type == "inventory_report",
                        func.date(AnalysisSourceFile.snapshot_at) == target_date,
                    ),
                )
            )
        ).scalars().all()

        # Keep latest source per (project_id, report_type)
        source_map: dict[tuple[int, str], AnalysisSourceFile] = {}
        for src in sources:
            key = (int(src.project_id), src.report_type)
            if key not in source_map or src.created_at > source_map[key].created_at:
                source_map[key] = src

        for (pid, rt), src in source_map.items():
            if pid not in status_by_project:
                continue
            if status_by_project[pid][rt].is_uploaded:
                continue  # log already covered
            biz = _business_date_iso(src)
            status_by_project[pid][rt] = ReportTypeStatus(
                report_type=rt,
                has_data=src.row_count_total > 0,
                is_uploaded=True,
                latest_date=biz,
                original_filename=src.original_filename,
                status_source="business_date_backfill",
            )

    # ── Fallback for ad data: query ad_upload_files (C 表) for each of the 10 ad report types ──
    if target_date is not None:
        ad_report_types = _ad_report_types()
        ad_missing_pairs = [
            (pid, rt)
            for pid in project_ids
            for rt in ad_report_types
            if pid in status_by_project
            and not status_by_project[pid][rt].is_uploaded
        ]
        if ad_missing_pairs:
            missing_pids = sorted({pid for pid, _ in ad_missing_pairs})
            ad_sources = db.execute(
                select(AdUploadFile)
                .where(AdUploadFile.project_id.in_(missing_pids))
                .where(AdUploadFile.country == country)
                .where(AdUploadFile.report_type.in_(ad_report_types))
                .where(AdUploadFile.is_current.is_(True))
                .where(AdUploadFile.ingestion_status == "success")
                .where(AdUploadFile.period_start_date <= target_date)
                .where(AdUploadFile.period_end_date >= target_date)
            ).scalars().all()
            # Keep latest source per (project_id, report_type) — 每个 ad 维度独立
            ad_map: dict[tuple[int, str], AdUploadFile] = {}
            for src in ad_sources:
                key = (int(src.project_id), src.report_type)
                if key not in ad_map or src.created_at > ad_map[key].created_at:
                    ad_map[key] = src
            for (pid, rt), src in ad_map.items():
                if pid not in status_by_project:
                    continue
                status_by_project[pid][rt] = ReportTypeStatus(
                    report_type=rt,
                    has_data=src.row_count_total > 0,
                    is_uploaded=True,
                    latest_date=str(src.report_date) if src.report_date else None,
                    original_filename=src.original_filename,
                    status_source="business_date_backfill",
                )

    items = [
        ProjectReportStatus(
            project_id=pid,
            project_name=project_map[pid],
            country=country,
            statuses=list(status_by_project[pid].values()),
        )
        for pid in sorted(
            project_ids,
            key=lambda pid: project_sort_orders.get(pid, 0),
        )
    ]
    return RpaReportStatusResponse(country=country, items=items)
