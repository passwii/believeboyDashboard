"""Agent 平台巡检（写侧）域路由（BLF-944；spec §5/§6，v0.1）。

在 ``/api/v1/agent/platform-inspection/*`` 开放 R0 + W1–W4（写 4 + 支撑读 1）：

* R0 ``GET /template`` —— 巡检表单模板（字段+类型+枚举+阈值 = 写输入 schema）；
* W1 ``PUT .../periods/{period_id}/projects/{project_id}`` —— upsert 草稿（幂等，
  **不 confirm**——可反复 PUT 覆盖，保留 Agent 自主填报工作流）；
* W2 ``POST .../submit`` —— 提交报告（draft/overdue → submitted，**不可逆**，
  confirm 两步）；
* W3 ``POST .../screenshots`` —— 上传截图（multipart，压缩+缩略图，**不 confirm**，
  纯增量新增对象可删除）；
* W4 ``DELETE /screenshots/{screenshot_id}`` —— 删除截图（R2 对象 + DB 行，
  **不可逆**，confirm 两步）。

设计要点（spec §3/§6/§8）：
* 与 account-health 读写分离：读巡检数据走 account-health，本域只覆盖写路径；
  **零新增表/迁移**，数据底座复用 ``inspection_periods`` / ``inspection_reports`` /
  ``inspection_screenshots``（同 account-health 一套）。
* 服务层**零改造复用**：``create_or_update_report`` / ``submit_report`` /
  ``upload_screenshot`` / ``delete_screenshot`` / ``get_report`` /
  ``get_report_by_id`` / ``get_period``（spec §2.4，0 签名/行为改动）。
* 模板常量提取共享：R0 与内部 ``GET /inspections/template`` 同源引用
  ``app/constants/inspection_template.py``（spec §6.1，杜绝两处漂移）。
* **不暴露 presigned URL**（D6）：截图响应只给 id + 元数据，对齐 account-health
  安全口径（R2 私桶临时凭证不外泄给 Agent 平台）。
* **显式字段合并**（§6.2）：health_data / compliance_data 只透传 Agent 显式
  提供的 key（``model_fields_set``），未提供的保持当前值（不置 null 覆盖）。
* **不提供 screenshot_ids**（§2.4：service 层 no-op；截图经 W3 上传挂靠 report_id）。
* 错误码全部复用 ``app/api/agent/errors.py``（D7：无新增 INSPECTION_* 码）。
* 鉴权：``require_agent_credential`` + ``require_business_scope("platform_inspection")``
  装配时挂载；W1–W4 挂写限流 + W1–W3 挂 ``require_project_scope``（W4 在
  handler/validate 内校验归属）；写操作落审计（agent_id/idempotency_key 归因）。
"""

from __future__ import annotations

import json
from contextlib import contextmanager
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session
from starlette.datastructures import UploadFile as StarletteUploadFile

from app.api.agent.confirm import require_confirmation
from app.api.agent.errors import AgentApiError, ErrorCode
from app.api.agent.rate_limit import require_agent_write_rate_limit
from app.api.agent.response import agent_ok
from app.api.agent.scope import require_project_scope
from app.api.deps import get_primary_db_session
from app.constants.inspection_template import (
    COMPLIANCE_FIELDS,
    HEALTH_FIELDS,
    SERVICE_PERFORMANCE_FIELDS,
    SHIPPING_PERFORMANCE_FIELDS,
)
from app.core.config import get_settings
from app.db.session import SessionLocal
from app.models.agent_api_key import AgentApiKey
from app.models.inspection import (
    InspectionPeriod,
    InspectionReport,
    InspectionScreenshot,
)
from app.models.project import Project
from app.schemas.inspection import ComplianceData, HealthData
from app.services import inspection_service
from app.services.audit_log_service import append_operation_audit_log

platform_inspection_router = APIRouter(
    prefix="/platform-inspection",
    tags=["agent-platform-inspection"],
)

#: health/compliance 块的可写 key（对齐 pydantic schema 字段名）。
_HEALTH_KEYS = frozenset(HealthData.model_fields.keys())
_COMPLIANCE_KEYS = frozenset(ComplianceData.model_fields.keys())

#: account_health_rating 枚举（单一事实源 = 模板常量 HEALTH_FIELDS[0].options）。
_ACCOUNT_HEALTH_RATINGS = frozenset(HEALTH_FIELDS[0].options or [])


# ============================================================
# 壳翻译与解析 helper（对齐 account-health / sku_info 模板）
# ============================================================


@contextmanager
def _service_errors():
    """把 service 层 HTTPException 翻译成 agent 响应壳（spec §8）。"""
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


def _audit_kwargs(request: Request) -> dict:
    """agent 写审计归因（spec §8：operator=NULL，agent_id/idempotency_key 归因）。"""
    return {
        "agent_id": getattr(request.state, "agent_id", None),
        "agent_name": getattr(request.state, "agent_label", None),
        "idempotency_key": request.headers.get("idempotency-key") or None,
        "request": request,
    }


def _check_idempotency_header(request: Request) -> None:
    """Idempotency-Key 可缺失；出现则必须非空且 ≤64 字符（spec §3）。"""
    value = request.headers.get("idempotency-key")
    if value is not None and (len(value) == 0 or len(value) > 64):
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            human_message="Idempotency-Key 必须为非空字符串且不超过 64 字符",
        )


def _compliance_total(compliance: dict | None) -> int | None:
    """10 项合规计数求和（口径与内部 overview / history 一致）。"""
    if not compliance:
        return None
    return sum(compliance.get(k, 0) or 0 for k in _COMPLIANCE_KEYS)


def _project_in_scope(request: Request, project_id: int) -> bool:
    """凭据 project_scope 的可见项目；``*`` / 缺省 → True（全放行）。

    W4 handler/validate 内校验归属用（对齐 account_health ``_project_in_scope``
    语义：不在范围 → 403 ``AGENT_PROJECT_OUT_OF_SCOPE``）。
    """
    key_id = getattr(request.state, "agent_api_key_id", None)
    if key_id is None:
        raise AgentApiError(ErrorCode.AGENT_AUTH_FAILED, reason="token_invalid")
    db = SessionLocal()
    try:
        key = db.get(AgentApiKey, key_id)
        scope = (key.project_scope if key else None) or "*"
    finally:
        db.close()
    if scope == "*":
        return True
    return project_id in {int(p.strip()) for p in scope.split(",") if p.strip()}


def _get_period_or_shell_404(db: Session, period_id: int) -> InspectionPeriod:
    period = db.get(InspectionPeriod, period_id)
    if period is None:
        raise AgentApiError(
            ErrorCode.RESOURCE_NOT_FOUND,
            human_message=f"周期 {period_id} 不存在",
        )
    return period


def _serialize_report(report: InspectionReport) -> dict[str, Any]:
    """写侧序列化：对齐 account_health 拍平口径，但**不含 presigned URL**
    （D6），含 ``screenshot_count``（spec §6.2 W1 响应形态）。
    """
    health = report.health_data or {}
    compliance = report.compliance_data or {}
    screenshots = report.screenshots or []
    return {
        "report_id": int(report.id),
        "period_id": int(report.period_id),
        "project_id": int(report.project_id),
        "status": report.status,
        "health_data": {k: health.get(k) for k in _HEALTH_KEYS},
        "compliance_data": {k: compliance.get(k) for k in _COMPLIANCE_KEYS},
        "compliance_total": _compliance_total(compliance),
        "status_summary": report.status_summary,
        "submitted_by": report.submitted_by,
        "submitted_at": report.submitted_at.isoformat()
        if report.submitted_at
        else None,
        "screenshot_count": len(screenshots),
        "created_at": report.created_at.isoformat() if report.created_at else None,
        "updated_at": report.updated_at.isoformat() if report.updated_at else None,
    }


def _serialize_screenshot(s: InspectionScreenshot) -> dict[str, Any]:
    """截图写侧序列化（D6）：只给 id + 元数据，**不含 r2_key / presigned URL**。
    """
    return {
        "screenshot_id": int(s.id),
        "filename": s.filename,
        "content_type": s.content_type,
        "file_size": int(s.file_size),
        "caption": s.caption,
        "sort_order": int(s.sort_order),
        "created_at": s.created_at.isoformat() if s.created_at else None,
    }


def _get_report_or_shell_404(
    db: Session, period_id: int, project_id: int, settings
) -> InspectionReport:
    report = inspection_service.get_report(db, period_id, project_id, settings)
    if report is None:
        raise AgentApiError(
            ErrorCode.RESOURCE_NOT_FOUND,
            human_message=f"周期 {period_id} 项目 {project_id} 无巡检报告，"
            "请先通过 W1 保存草稿再上传截图",
        )
    return report


# ============================================================
# R0 GET /template（读，不落审计；spec §6.1）
# ============================================================


@platform_inspection_router.get("/template")
def get_template() -> dict:
    """R0 巡检表单模板：与内部 ``GET /inspections/template`` 同源引用共享常量。
    """
    return agent_ok(
        {
            "health_fields": [f.model_dump() for f in HEALTH_FIELDS],
            "service_performance_fields": [
                f.model_dump() for f in SERVICE_PERFORMANCE_FIELDS
            ],
            "shipping_performance_fields": [
                f.model_dump() for f in SHIPPING_PERFORMANCE_FIELDS
            ],
            "compliance_fields": [f.model_dump() for f in COMPLIANCE_FIELDS],
        }
    )


# ============================================================
# W1 PUT .../projects/{project_id}（upsert 草稿；不 confirm；spec §6.2）
# ============================================================


def _parse_health_block(block: dict | None) -> dict | None:
    """用 pydantic HealthData 校验 health 块；返回**显式提供的 key 子集**。

    ``account_health_rating`` 额外做枚举校验（spec §10 #2：非法枚举值 400
    ``VALIDATION_FAILED``；pydantic schema 只给 str 类型，枚举约束在端点层）。
    """
    if block is None:
        return None
    try:
        parsed = HealthData(**block)
    except ValidationError as exc:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            details=[
                {"loc": [str(p) for p in err.get("loc", [])], "msg": err.get("msg")}
                for err in exc.errors()
            ],
        ) from None
    provided = {
        key: getattr(parsed, key)
        for key in parsed.model_fields_set
        if key in _HEALTH_KEYS
    }
    if "account_health_rating" in provided:
        rating = provided["account_health_rating"]
        if rating is not None and rating not in _ACCOUNT_HEALTH_RATINGS:
            raise AgentApiError(
                ErrorCode.VALIDATION_FAILED,
                details={
                    "loc": ["health_data", "account_health_rating"],
                    "msg": (
                        f"account_health_rating 必须是 "
                        f"{sorted(_ACCOUNT_HEALTH_RATINGS)} 之一，收到 {rating!r}"
                    ),
                },
            )
    return provided


def _parse_compliance_block(block: dict | None) -> dict | None:
    """用 pydantic ComplianceData 校验 compliance 块；返回**显式提供的 key 子集**。
    """
    if block is None:
        return None
    try:
        parsed = ComplianceData(**block)
    except ValidationError as exc:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            details=[
                {"loc": [str(p) for p in err.get("loc", [])], "msg": err.get("msg")}
                for err in exc.errors()
            ],
        ) from None
    return {
        key: getattr(parsed, key)
        for key in parsed.model_fields_set
        if key in _COMPLIANCE_KEYS
    }


def _merge_report_payload(
    body: dict,
    current: InspectionReport | None,
) -> dict:
    """显式字段合并（spec §6.2 / §9 #2 默认值陷阱规避）。

    只透传 Agent 显式提供的 key；未提供的 health/compliance 子键与
    status_summary 保持当前值（不置 null 覆盖）。缺失整块 → 保持现状。
    """
    payload: dict[str, Any] = {}
    if "health_data" in body:
        provided = _parse_health_block(body.get("health_data"))
        if provided is not None:
            merged = dict((current.health_data or {}) if current else {})
            merged.update(provided)
            payload["health_data"] = merged
    if "compliance_data" in body:
        provided = _parse_compliance_block(body.get("compliance_data"))
        if provided is not None:
            merged = dict((current.compliance_data or {}) if current else {})
            merged.update(provided)
            payload["compliance_data"] = merged
    if "status_summary" in body:
        payload["status_summary"] = body.get("status_summary")
    return payload


@platform_inspection_router.put(
    "/periods/{period_id}/projects/{project_id}",
    dependencies=[Depends(require_agent_write_rate_limit)],
)
async def upsert_report(
    request: Request,
    period_id: int,
    project_id: int,
    db: Session = Depends(get_primary_db_session),
    settings=Depends(get_settings),
    _scope=Depends(require_project_scope),
) -> dict:
    """W1 填写 / 更新草稿：upsert 语义 + 显式字段合并 + 审计（不 confirm）。

    周期不存在 → 404 ``RESOURCE_NOT_FOUND``；项目不在凭据范围 → 403
    ``AGENT_PROJECT_OUT_OF_SCOPE``（``require_project_scope`` 直取）。
    幂等：重复 PUT 更新同一条不新建。
    """
    _check_idempotency_header(request)
    raw = await request.body()
    body = json.loads(raw) if raw else {}
    if not isinstance(body, dict):
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED, human_message="请求体必须是 JSON 对象"
        )
    with _service_errors():
        _get_period_or_shell_404(db, period_id)
        current = db.execute(
            select(InspectionReport).where(
                InspectionReport.period_id == period_id,
                InspectionReport.project_id == project_id,
            )
        ).scalar_one_or_none()
        before = _serialize_report(current) if current is not None else None
        payload = _merge_report_payload(body, current)
        report = inspection_service.create_or_update_report(
            db, period_id, project_id, payload, operator=None
        )
        append_operation_audit_log(
            db,
            action="platform_inspection.save",
            target_type="inspection_report",
            target_id=report.id,
            operator=None,
            before=before,
            after=_serialize_report(report),
            **_audit_kwargs(request),
        )
        db.commit()
    return agent_ok(
        _serialize_report(report),
        idempotency_key=request.headers.get("idempotency-key") or None,
    )


# ============================================================
# W2 POST .../submit（提交；confirm 两步；spec §6.3）
# ============================================================


def _resolve_report_for_submit(
    db: Session, period_id: int, project_id: int, settings
) -> InspectionReport:
    report = inspection_service.get_report(db, period_id, project_id, settings)
    if report is None:
        raise AgentApiError(
            ErrorCode.RESOURCE_NOT_FOUND,
            human_message="无草稿报告，无法提交（请先通过 W1 保存草稿）",
        )
    return report


def _w2_preview(body: dict, request: Request) -> dict:
    """W2 confirm 预览摘要（spec §6.3）：from_status / 摘要 / warnings。"""
    period_id = int(request.path_params["period_id"])
    project_id = int(request.path_params["project_id"])
    db = SessionLocal()
    try:
        period = _get_period_or_shell_404(db, period_id)
        report = _resolve_report_for_submit(db, period_id, project_id, get_settings())
        project = db.get(Project, project_id)
        compliance = report.compliance_data or {}
        warnings = inspection_service.check_thresholds(report)
    finally:
        db.close()
    return {
        "project_id": project_id,
        "project_name": project.project_name if project else None,
        "period_id": period_id,
        "week_start": period.week_start.isoformat(),
        "week_end": period.week_end.isoformat(),
        "from_status": report.status,
        "to_status": "submitted",
        "account_health_rating": (report.health_data or {}).get(
            "account_health_rating"
        ),
        "compliance_total": _compliance_total(compliance),
        "screenshot_count": len(report.screenshots or []),
        "warnings": warnings,
        "note": "提交后状态变为 submitted（不可逆，无回退路径），请确认",
    }


def _w2_validate(body: dict, request: Request) -> None:
    """W2 业务校验（先于 confirm 签发 token；短路不生成 token）。"""
    _check_idempotency_header(request)
    period_id = int(request.path_params["period_id"])
    project_id = int(request.path_params["project_id"])
    db = SessionLocal()
    try:
        _get_period_or_shell_404(db, period_id)
        _resolve_report_for_submit(db, period_id, project_id, get_settings())
    finally:
        db.close()


@platform_inspection_router.post(
    "/periods/{period_id}/projects/{project_id}/submit",
    dependencies=[Depends(require_agent_write_rate_limit)],
)
@require_confirmation(
    action="platform_inspection.submit",
    build_preview=_w2_preview,
    validate=_w2_validate,
)
async def submit_report(
    request: Request,
    period_id: int,
    project_id: int,
    db: Session = Depends(get_primary_db_session),
    settings=Depends(get_settings),
    _scope=Depends(require_project_scope),
) -> dict:
    """W2 提交报告：confirm 两步后 draft/overdue → submitted（不可逆）+ 审计。

    ``submitted_by=<agent_id>``、``submitted_at`` 由 ``submit_report`` 写入；
    响应透出 ``warnings``（阈值告警，Agent 可向用户汇报异常指标）。
    """
    agent_id = getattr(request.state, "agent_id", None)
    report = _resolve_report_for_submit(db, period_id, project_id, settings)
    report, warnings = inspection_service.submit_report(db, report.id, agent_id)
    append_operation_audit_log(
        db,
        action="platform_inspection.submit",
        target_type="inspection_report",
        target_id=report.id,
        operator=None,
        after={"warnings": warnings} if warnings else None,
        **_audit_kwargs(request),
    )
    db.commit()
    return agent_ok(
        {**_serialize_report(report), "warnings": warnings},
        idempotency_key=request.headers.get("idempotency-key") or None,
    )


# ============================================================
# W3 POST .../screenshots（上传；multipart；不 confirm；spec §6.4）
# ============================================================


@platform_inspection_router.post(
    "/periods/{period_id}/projects/{project_id}/screenshots",
    dependencies=[Depends(require_agent_write_rate_limit)],
)
async def upload_screenshot(
    request: Request,
    period_id: int,
    project_id: int,
    db: Session = Depends(get_primary_db_session),
    settings=Depends(get_settings),
    _scope=Depends(require_project_scope),
) -> dict:
    """W3 上传截图：multipart ``file``，复用 ``inspection_service.upload_screenshot``
    （压缩 + 缩略图 + R2 + 入库，0 改造）。**不 confirm**（纯增量新增对象可删）。

    该 (period, project) 无草稿报告 → 404（先 W1 建档再传图，与前端流程一致）。
    响应**不含 presigned URL**（D6）：只给 screenshot_id + 元数据。
    """
    _check_idempotency_header(request)
    form = await request.form()
    upload_file = form.get("file")
    if not isinstance(upload_file, StarletteUploadFile):
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED, human_message="缺少文件字段 file"
        )
    report = _get_report_or_shell_404(db, period_id, project_id, settings)
    project = db.get(Project, project_id)
    project_slug = project.project_name if project else "unknown"
    try:
        screenshot = inspection_service.upload_screenshot(
            db, settings, upload_file, report.id, project_slug
        )
    except ValueError as exc:
        raise AgentApiError(ErrorCode.VALIDATION_FAILED, human_message=str(exc)) from None
    append_operation_audit_log(
        db,
        action="platform_inspection.upload_screenshot",
        target_type="inspection_screenshot",
        target_id=screenshot.id,
        operator=None,
        after={
            "report_id": report.id,
            "period_id": period_id,
            "project_id": project_id,
            "screenshot_id": screenshot.id,
            "filename": screenshot.filename,
            "file_size": screenshot.file_size,
            "sort_order": screenshot.sort_order,
        },
        **_audit_kwargs(request),
    )
    db.commit()
    return agent_ok(
        _serialize_screenshot(screenshot),
        idempotency_key=request.headers.get("idempotency-key") or None,
    )


# ============================================================
# W4 DELETE /screenshots/{screenshot_id}（删除；confirm 两步；spec §6.5）
# ============================================================


def _get_screenshot_or_shell_404(
    db: Session, screenshot_id: int
) -> InspectionScreenshot:
    screenshot = db.get(InspectionScreenshot, screenshot_id)
    if screenshot is None:
        raise AgentApiError(
            ErrorCode.RESOURCE_NOT_FOUND,
            human_message=f"截图 {screenshot_id} 不存在",
        )
    return screenshot


def _w4_preview(body: dict, request: Request) -> dict:
    """W4 confirm 预览摘要（spec §6.5）：删除范围（R2 原图 + 缩略图 + DB 行）。"""
    screenshot_id = int(request.path_params["screenshot_id"])
    db = SessionLocal()
    try:
        screenshot = _get_screenshot_or_shell_404(db, screenshot_id)
        report = db.get(InspectionReport, screenshot.report_id)
        project = db.get(Project, report.project_id) if report else None
        period = db.get(InspectionPeriod, report.period_id) if report else None
    finally:
        db.close()
    return {
        "screenshot_id": screenshot_id,
        "filename": screenshot.filename,
        "period_id": report.period_id if report else None,
        "project_id": report.project_id if report else None,
        "project_name": project.project_name if project else None,
        "week_start": period.week_start.isoformat() if period else None,
        "delete_scope": "R2 原图 + 缩略图 + DB 行，无恢复路径",
        "note": "删除后截图不可恢复，请确认",
    }


def _w4_validate(body: dict, request: Request) -> None:
    """W4 业务校验（先于 confirm 签发 token）：截图存在 + 归属项目在凭据范围。"""
    _check_idempotency_header(request)
    screenshot_id = int(request.path_params["screenshot_id"])
    db = SessionLocal()
    try:
        screenshot = _get_screenshot_or_shell_404(db, screenshot_id)
        report = db.get(InspectionReport, screenshot.report_id)
        if report is not None and not _project_in_scope(request, report.project_id):
            raise AgentApiError(
                ErrorCode.AGENT_PROJECT_OUT_OF_SCOPE,
                reason="project_not_in_scope",
                human_message=f"截图 {screenshot_id} 归属项目不在凭据范围",
            )
    finally:
        db.close()


@platform_inspection_router.delete(
    "/screenshots/{screenshot_id}",
    dependencies=[Depends(require_agent_write_rate_limit)],
)
@require_confirmation(
    action="platform_inspection.delete_screenshot",
    build_preview=_w4_preview,
    validate=_w4_validate,
)
async def delete_screenshot(
    request: Request,
    screenshot_id: int,
    db: Session = Depends(get_primary_db_session),
    settings=Depends(get_settings),
) -> dict:
    """W4 删除截图：confirm 两步后 R2 原图 + 缩略图 + DB 行（不可逆）+ 审计。

    project 范围在 handler 内校验（spec §5：W4 只有 screenshot_id 稳定键 →
    screenshot → report → project_id → scope）。
    """
    with _service_errors():
        screenshot = _get_screenshot_or_shell_404(db, screenshot_id)
        report = db.get(InspectionReport, screenshot.report_id)
        if report is not None and not _project_in_scope(request, report.project_id):
            raise AgentApiError(
                ErrorCode.AGENT_PROJECT_OUT_OF_SCOPE,
                reason="project_not_in_scope",
                human_message=f"截图 {screenshot_id} 归属项目不在凭据范围",
            )
        success = inspection_service.delete_screenshot(db, settings, screenshot_id)
        if not success:
            raise AgentApiError(
                ErrorCode.RESOURCE_NOT_FOUND,
                human_message=f"截图 {screenshot_id} 不存在",
            )
        append_operation_audit_log(
            db,
            action="platform_inspection.delete_screenshot",
            target_type="inspection_screenshot",
            target_id=screenshot_id,
            operator=None,
            after={"deleted": True, "screenshot_id": screenshot_id},
            **_audit_kwargs(request),
        )
        db.commit()
    return agent_ok({"deleted": True, "screenshot_id": screenshot_id})