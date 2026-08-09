"""Agent 店铺合规健康域路由（BLF-550；spec §6/§8，v0.2）。

在 ``/api/v1/agent/account-health/*`` 开放 5 条纯读路由（S1 D3 拍板：读 5 写 0，
纯读域不落审计）。数据底座直接复用巡检数据（S2 结论：``inspection_periods`` /
``inspection_reports`` / ``inspection_screenshots``，零新增表/迁移）：

* R1 ``/account-health/periods`` —— 周期列表（limit/offset + submitted_count）；
* R2 ``/account-health/periods/current`` —— 当前周期（**新增纯读 service**
  ``inspection_service.get_current_period``——内部 ``get_or_create_current_period``
  有建行副作用不可复用，不改其签名）；
* R3 ``/account-health/periods/{period_id}/overview`` —— 周期概览（逐店拍平行，
  items 按凭据 project_scope 过滤）；
* R4 ``/account-health/periods/{period_id}/projects/{project_id}`` —— 单店明细
  （项目不在凭据范围 → 404 ``RESOURCE_NOT_FOUND``）；
* R5 ``/account-health/history`` —— 历史趋势（period/project 筛选 + 白名单排序）。

设计要点（spec §6 公共约定 / §7）：
* 鉴权 + 读限流由 ``agent/__init__.py`` 命名空间级依赖保证；域级
  ``require_business_scope("account_health")`` 也在装配时挂载（本模块不重复挂）。
* project_scope **列表过滤语义**（对齐 report_upload_status / external_mirror
  /projects）：白名单只返回可见项目，不抛 403；R4 直取项目不在范围 → 404。
* 字段**拍平**（§7.1）：health_data 8 + compliance_data 10 + 派生
  compliance_total 逐列展开，不暴露 raw JSON blob；空值 = null 非 0；
  空结果 = 200 非 404（只有资源本身不存在才 404）。
* 不暴露：截图 presigned URL（只给 ``screenshot_count``）、``status_summary``
  （R4 ``include_summary=true`` 才带，覆盖率仅 ~23% 的弱数据）。
* 错误码全部复用 ``app/api/agent/errors.py``（无新增）。
"""

from __future__ import annotations

import logging
from contextlib import contextmanager
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.api.agent.errors import AgentApiError, ErrorCode
from app.api.agent.response import agent_ok
from app.api.agent.scope import SCOPE_ALL
from app.api.deps import get_read_db_session
from app.core.config import Settings, get_settings
from app.db.session import SessionLocal
from app.models.agent_api_key import AgentApiKey
from app.models.inspection import InspectionPeriod, InspectionReport
from app.models.project import Project
from app.services import inspection_service

logger = logging.getLogger(__name__)

account_health_router = APIRouter(
    prefix="/account-health",
    tags=["agent-account-health"],
)

# §7.1 拍平行字段集（单一事实源 = 周巡检表单字段，见 inspections.py 模板常量）。
_HEALTH_KEYS: tuple[str, ...] = (
    "account_health_rating",
    "negative_feedback",
    "a2z_claims",
    "chargeback_claims",
    "late_shipment_rate",
    "pre_fulfillment_cancel_rate",
    "valid_tracking_rate",
    "on_time_delivery_rate",
)

_COMPLIANCE_KEYS: tuple[str, ...] = (
    "ip_infringement",
    "ip_complaints",
    "product_authenticity_complaints",
    "product_condition_complaints",
    "food_product_safety",
    "listing_policy_violations",
    "restricted_product_violations",
    "review_policy_violations",
    "other_policy_violations",
    "regulatory_compliance",
)

# R5 排序白名单（spec §6 R5：week_start / project_name / account_health_rating /
# compliance_total / submitted_at + 各数值健康/合规列）。行构建时保留全字段，
# 排序键可访问所有拍平列；输出行是 §7.3 子集。
_ORDER_BY_WHITELIST: tuple[str, ...] = (
    "week_start",
    "project_name",
    "account_health_rating",
    "compliance_total",
    "submitted_at",
    *_HEALTH_KEYS,
    *_COMPLIANCE_KEYS,
)
_ORDER_BY_SET = frozenset(_ORDER_BY_WHITELIST)

# 拍平后为 ISO 字符串的排序列（None → 空串，保持同列类型一致）。
_STRING_SORT_COLUMNS = frozenset(
    {"week_start", "project_name", "account_health_rating", "submitted_at"}
)


# ============================================================
# 壳翻译与解析 helper（对齐退货/报表上传状态域模板）
# ============================================================


@contextmanager
def _service_errors():
    """把 service 层 HTTPException 翻译成 agent 响应壳（设计稿 §5）。"""
    try:
        yield
    except AgentApiError:
        raise
    except HTTPException as exc:
        detail = str(exc.detail) if exc.detail else None
        if exc.status_code == 404:
            raise AgentApiError(
                ErrorCode.RESOURCE_NOT_FOUND, human_message=detail
            ) from None
        raise AgentApiError(ErrorCode.VALIDATION_FAILED, human_message=detail) from None


def _visible_project_ids(request: Request) -> set[int] | None:
    """凭据 project_scope 的可见项目集合；``*`` / 缺省 → None（全放行）。

    列表过滤语义（对齐 report_upload_status ``_visible_items``）：白名单只
    返回可见项目，不抛 403。
    """
    key_id = getattr(request.state, "agent_api_key_id", None)
    if key_id is None:
        return None
    db = SessionLocal()
    try:
        key = db.get(AgentApiKey, key_id)
        scope = (key.project_scope if key else None) or SCOPE_ALL
    finally:
        db.close()
    if scope == SCOPE_ALL:
        return None
    return {int(part.strip()) for part in scope.split(",") if part.strip()}


def _project_in_scope(request: Request, project_id: int) -> bool:
    visible = _visible_project_ids(request)
    return visible is None or project_id in visible


def _compliance_total(compliance: dict | None) -> int | None:
    """10 项合规计数求和（口径与内部 overview / history 完全一致：
    空 dict / None → None；有值则逐 key ``or 0`` 求和）。"""
    if not compliance:
        return None
    return sum(compliance.get(k, 0) or 0 for k in _COMPLIANCE_KEYS)


def _period_item(
    period: InspectionPeriod, *, submitted_count: int | None = None
) -> dict:
    """§7.2 周期项（R1 可附 submitted_count）。"""
    item = {
        "period_id": period.id,
        "week_start": period.week_start.isoformat(),
        "week_end": period.week_end.isoformat(),
        "deadline": period.deadline.isoformat(),
    }
    if submitted_count is not None:
        item["submitted_count"] = submitted_count
    return item


def _flatten_row(
    period: InspectionPeriod,
    project: Project,
    report: InspectionReport | None,
) -> dict:
    """§7.1 拍平事实行（R3/R4/R5 共用）。

    空值语义（D4）：未填写的数值字段 → ``null``（非 0）；``compliance_total``
    全部 null / 空 → ``null``。不含 status_summary（R4 单独附加）。
    """
    health = (report.health_data or {}) if report else {}
    compliance = (report.compliance_data or {}) if report else {}
    row: dict = {
        "period_id": period.id,
        "week_start": period.week_start.isoformat(),
        "week_end": period.week_end.isoformat(),
        "project_id": project.id,
        "project_name": project.project_name,
        "status": report.status if report else None,
        "submitted_at": (
            report.submitted_at.isoformat() if report and report.submitted_at else None
        ),
    }
    for key in _HEALTH_KEYS:
        row[key] = health.get(key)
    for key in _COMPLIANCE_KEYS:
        row[key] = compliance.get(key)
    row["compliance_total"] = _compliance_total(compliance)
    row["screenshot_count"] = len(report.screenshots or []) if report else 0
    return row


def _history_subset(row: dict) -> dict:
    """§7.3 R5 输出行：§7.1 子集（对齐 InspectionHistoryItem：context +
    account_health_rating + compliance_total + submitted_at + screenshot_count）。"""
    return {
        "period_id": row["period_id"],
        "week_start": row["week_start"],
        "week_end": row["week_end"],
        "project_id": row["project_id"],
        "project_name": row["project_name"],
        "status": row["status"],
        "account_health_rating": row["account_health_rating"],
        "compliance_total": row["compliance_total"],
        "submitted_at": row["submitted_at"],
        "screenshot_count": row["screenshot_count"],
    }


# ============================================================
# R1 周期列表
# ============================================================


@account_health_router.get("/periods")
def list_periods(
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_read_db_session),
) -> dict:
    """R1 周期列表：复用 ``inspection_service.list_periods``（纯读，零改造）。"""
    with _service_errors():
        items, total = inspection_service.list_periods(db, limit=limit, offset=offset)
        page_ids = [p.id for p in items]
        counts: dict[int, int] = {}
        if page_ids:
            rows = db.execute(
                select(InspectionReport.period_id, func.count())
                .where(
                    InspectionReport.period_id.in_(page_ids),
                    InspectionReport.status == "submitted",
                )
                .group_by(InspectionReport.period_id)
            ).all()
            counts = {pid: cnt for pid, cnt in rows}
        payload_items = [
            _period_item(p, submitted_count=counts.get(p.id, 0)) for p in items
        ]

    return agent_ok({"items": payload_items, "total": total})


# ============================================================
# R2 当前周期（纯读锁契约）
# ============================================================


@account_health_router.get("/periods/current")
def get_current_period(db: Session = Depends(get_read_db_session)) -> dict:
    """R2 当前周期：**纯读**（``inspection_service.get_current_period``，无建行
    副作用——内部 ``get_or_create_current_period`` 无周期时会 INSERT，Agent 通道
    不可复用）。无周期 → 404 ``RESOURCE_NOT_FOUND``。"""
    with _service_errors():
        period = inspection_service.get_current_period(db)
        if period is None:
            raise AgentApiError(
                ErrorCode.RESOURCE_NOT_FOUND,
                human_message="当前没有巡检周期（本周周期尚未创建）",
            )
    return agent_ok(_period_item(period))


# ============================================================
# R3 周期概览
# ============================================================


@account_health_router.get("/periods/{period_id}/overview")
def get_period_overview(
    period_id: int,
    request: Request,
    db: Session = Depends(get_read_db_session),
    settings: Settings = Depends(get_settings),
) -> dict:
    """R3 周期概览：复用 ``inspection_service.get_overview``（状态推导 / 逾期口径
    与内部端点一致）→ 逐店行拍平（§7.3 字段）→ 按凭据 project_scope 过滤 items，
    计数在过滤后重算。周期不存在 → 404 ``RESOURCE_NOT_FOUND``。"""
    with _service_errors():
        result = inspection_service.get_overview(
            db, period_id, settings, operator=None, is_admin=True
        )
        if not result["period"]:
            raise AgentApiError(
                ErrorCode.RESOURCE_NOT_FOUND,
                human_message=f"周期 {period_id} 不存在",
            )
        period = db.get(InspectionPeriod, period_id)

        reports = list(
            db.execute(
                select(InspectionReport)
                .where(InspectionReport.period_id == period_id)
                .options(selectinload(InspectionReport.screenshots))
            )
            .scalars()
            .all()
        )
        report_map = {r.project_id: r for r in reports}
        project_ids = [item["project_id"] for item in result["items"]]
        projects = (
            list(
                db.execute(select(Project).where(Project.id.in_(project_ids)))
                .scalars()
                .all()
            )
            if project_ids
            else []
        )
        project_map = {p.id: p for p in projects}

        visible = _visible_project_ids(request)
        items = []
        for item in result["items"]:
            pid = item["project_id"]
            if visible is not None and pid not in visible:
                continue
            project = project_map.get(pid)
            if project is None:
                continue
            row = _flatten_row(period, project, report_map.get(pid))
            # get_overview 的逐店状态（submitted/overdue/draft/pending）优先，
            # 拍平行里补上 status（_flatten_row 只给了 report.status）。
            row["status"] = item["status"]
            items.append(row)

    return agent_ok(
        {
            "period": _period_item(period),
            "items": items,
            "total_projects": len(items),
            "submitted_count": sum(1 for i in items if i["status"] == "submitted"),
            "overdue_count": sum(1 for i in items if i["status"] == "overdue"),
        }
    )


# ============================================================
# R4 单店报告明细
# ============================================================


@account_health_router.get("/periods/{period_id}/projects/{project_id}")
def get_project_report(
    request: Request,
    period_id: int,
    project_id: int,
    include_summary: bool = Query(
        default=False,
        description="可选：true 时返回 status_summary（默认不返回，覆盖率低）",
    ),
    db: Session = Depends(get_read_db_session),
    settings: Settings = Depends(get_settings),
) -> dict:
    """R4 单店报告明细：复用 ``inspection_service.get_report``（纯读）+
    project_scope 语义——项目不在凭据范围 → 404；无报告 → 404。
    ``include_summary=true`` 才带 ``status_summary``。"""
    with _service_errors():
        if not _project_in_scope(request, project_id):
            raise AgentApiError(
                ErrorCode.RESOURCE_NOT_FOUND,
                human_message=f"项目 {project_id} 不存在或不在凭据可见范围内",
            )
        period = db.get(InspectionPeriod, period_id)
        if period is None:
            raise AgentApiError(
                ErrorCode.RESOURCE_NOT_FOUND,
                human_message=f"周期 {period_id} 不存在",
            )
        report = inspection_service.get_report(db, period_id, project_id, settings)
        if report is None:
            raise AgentApiError(
                ErrorCode.RESOURCE_NOT_FOUND,
                human_message=f"周期 {period_id} 项目 {project_id} 无巡检报告",
            )
        project = db.get(Project, project_id)
        row = _flatten_row(period, project, report)
        if include_summary:
            row["status_summary"] = report.status_summary

    return agent_ok(row)


# ============================================================
# R5 历史趋势
# ============================================================


def _sort_key(order_by: str):
    """R5 排序键（None → 中性值：数值 0 / 字符串空串）。

    对齐 return_analysis aggregate 的 Python 侧排序模式（数据量小，全量取回
    后内存排序再分页）；``compliance_total`` 为派生列，SQL 无法直接排序。
    **类型安全**：同列全量返回同类型（week_start/submitted_at 用 ISO 字符串
    lexicographic 排序，与 SQL date 排序一致），避免 None 混入 datetime 比较。
    """

    def _key(row: dict):
        value = row[order_by]
        if value is None:
            # 字符串列 None → 空串；数值列 None → 0（保持同列类型一致）。
            return "" if order_by in _STRING_SORT_COLUMNS else 0
        if order_by == "project_name":
            return str(value).lower()
        return value

    return _key


@account_health_router.get("/history")
def get_history(
    request: Request,
    period_id: int | None = Query(default=None),
    project_id: int | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    order_by: str = Query(default="week_start"),
    order_dir: str = Query(default="desc", pattern="^(asc|desc)$"),
    db: Session = Depends(get_read_db_session),
) -> dict:
    """R5 历史趋势：与内部 ``/api/v1/inspections/history`` 同构查询（拍平 +
    compliance_total 派生）→ 按凭据 project_scope 过滤 → 白名单排序 → 分页。

    ``order_by`` 非法 → 400 ``VALIDATION_FAILED``；空结果 → 200 + 空 items。
    """
    with _service_errors():
        if order_by not in _ORDER_BY_SET:
            allowed = ", ".join(_ORDER_BY_WHITELIST)
            raise AgentApiError(
                ErrorCode.VALIDATION_FAILED,
                human_message=f"order_by 必须是白名单之一（{allowed}），收到 {order_by!r}",
            )

        query = (
            select(InspectionReport, InspectionPeriod, Project)
            .join(InspectionPeriod, InspectionReport.period_id == InspectionPeriod.id)
            .join(Project, InspectionReport.project_id == Project.id)
            .options(selectinload(InspectionReport.screenshots))
        )
        if period_id is not None:
            query = query.where(InspectionReport.period_id == period_id)
        if project_id is not None:
            query = query.where(InspectionReport.project_id == project_id)
        visible = _visible_project_ids(request)
        if visible is not None:
            query = query.where(InspectionReport.project_id.in_(visible))

        rows = db.execute(query).all()
        full_rows = []
        for report, period, project in rows:
            full_rows.append(_flatten_row(period, project, report))

        full_rows.sort(key=_sort_key(order_by), reverse=(order_dir == "desc"))
        total = len(full_rows)
        page = [_history_subset(r) for r in full_rows[offset : offset + limit]]

    return agent_ok({"items": page, "total": total})
