"""Agent 报表上传状态域路由（BLF-484）。

在 ``/api/v1/agent/report-upload-status`` 开放 1 条纯读路由：

* R1 report-upload-status —— RPA 报表状态矩阵，与前端
  ``dashboard/reports/auto-upload``「RPA 报表状态」矩阵天然一致。复用内部
  ``/api/v1/rpa-reports/status`` 的 service（``get_report_status_for_date``），
  并按凭据的 project_scope 过滤 items（``*`` 全放行；白名单只返回可见项目），
  对齐 external_mirror ``/projects`` 列表的 L2 门禁语义。

报表上传状态是纯读 / 简单域（RPA 上报结果，无危险动作）——1 条路由、无
confirm、不落审计。路由挂 ``require_business_scope("report_upload_status")``
（在 ``agent/__init__.py`` 装配时挂载）；``project_id`` 不在路径 → 项目范围
过滤在 handler 内按 key 的 project_scope 做，不挂 ``require_project_scope``。

参数：``?report_date=``（必填 YYYY-MM-DD，非法 → 400 VALIDATION_FAILED，
内部端点现状静默返回全红，Agent 通道显式报错）；``?country=``（默认 US）；
``?project_id=``（可选，只看指定项目；不在凭据可见范围 → 404）。

summary 派生口径（与前端矩阵一致，BLF-482 / BLF-484）：
* ``uploaded_report_count`` / ``missing_report_types`` 只统计活跃 15 类
  （5 基础 + 10 广告）；分类账 2 类与预留 9 类不纳入缺失统计，但
  ``statuses`` 原样返回保持与内部端点一致。
"""

from __future__ import annotations

import logging
from contextlib import contextmanager
from datetime import date, datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session

from app.api.agent.errors import AgentApiError, ErrorCode
from app.api.agent.response import agent_ok
from app.api.agent.scope import SCOPE_ALL
from app.api.deps import get_read_db_session
from app.db.session import SessionLocal
from app.models.agent_api_key import AgentApiKey
from app.services.rpa_report_service import (
    AD_REPORT_TYPE_PREFIX,
    AD_REPORT_TYPE_SUFFIX,
    REPORT_TYPES,
    ProjectReportStatus,
    ReportTypeStatus,
    get_report_status_for_date,
)

logger = logging.getLogger(__name__)

report_upload_status_router = APIRouter(
    prefix="/report-upload-status",
    tags=["agent-report-upload-status"],
)


# ============================================================
# 活跃报表类型（summary 口径，单一事实源 = 服务端 REPORT_TYPES）
# ============================================================

# 5 基础（前端矩阵口径：库存 / 业务 / 销售 / 付款 / 退货）。
_BASE_ACTIVE_REPORT_TYPES: tuple[str, ...] = (
    "inventory_report",
    "business_report",
    "sales_report",
    "payment_report",
    "return_report",
)


def _active_report_types() -> tuple[str, ...]:
    """活跃 15 类 = 5 基础 + 10 广告（``ad_*_report`` 派生自 REPORT_TYPES）。

    分类账 2 类（inventory_ledger_summary / inventory_ledger_detail）与预留
    9 类不在其中——缺失统计不纳入它们，但 statuses 原样返回（内部端点一致）。
    """
    ad_types = tuple(
        rt
        for rt in REPORT_TYPES
        if rt.startswith(AD_REPORT_TYPE_PREFIX) and rt.endswith(AD_REPORT_TYPE_SUFFIX)
    )
    return _BASE_ACTIVE_REPORT_TYPES + ad_types


# ============================================================
# 壳翻译与解析 helper（对齐库存/退货域模板）
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


def _validate_report_date(report_date: str) -> None:
    """report_date 显式校验：非法 → 400 VALIDATION_FAILED。

    内部端点现状对非法日期静默返回全红矩阵；Agent 通道显式报错，
    让 Agent 能自纠（``errors.py`` 已有 VALIDATION_FAILED，无新增错误码）。
    """
    try:
        date.fromisoformat(report_date)
    except ValueError:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            human_message=f"report_date 必须是 YYYY-MM-DD，收到 {report_date!r}",
        ) from None


def _visible_items(
    request: Request, items: list[ProjectReportStatus]
) -> list[ProjectReportStatus]:
    """按 key 的 project_scope 过滤 items（对齐 external_mirror /projects 列表）。

    ``*`` 全放行（与现状一致）；白名单只返回可见项目——不抛 403，
    与 ``/projects`` 列表的 L2 门禁语义一致（列表过滤而非路径准入）。
    """
    key_id = getattr(request.state, "agent_api_key_id", None)
    if key_id is None:
        return items
    db = SessionLocal()
    try:
        key = db.get(AgentApiKey, key_id)
        scope = (key.project_scope if key else None) or SCOPE_ALL
    finally:
        db.close()
    if scope == SCOPE_ALL:
        return items
    allowed = {int(part.strip()) for part in scope.split(",") if part.strip()}
    return [item for item in items if item.project_id in allowed]


def _status_to_dict(st: ReportTypeStatus) -> dict:
    """ReportTypeStatus dataclass → JSON-safe dict（内部端点同构字段）。"""
    return {
        "report_type": st.report_type,
        "has_data": st.has_data,
        "is_uploaded": st.is_uploaded,
        "latest_date": st.latest_date,
        "original_filename": st.original_filename,
        "status_source": st.status_source,
    }


def _project_to_dict(item: ProjectReportStatus, active_types: tuple[str, ...]) -> dict:
    """单项目响应 + summary 派生（uploaded_report_count / missing_report_types）。

    ``statuses`` 原样透出（与内部端点一致，含分类账/预留类型）；summary
    只按活跃 15 类统计。
    """
    status_by_type = {st.report_type: st for st in item.statuses}
    missing = [rt for rt in active_types if not status_by_type[rt].is_uploaded]
    return {
        "project_id": item.project_id,
        "project_name": item.project_name,
        "country": item.country,
        "uploaded_report_count": len(active_types) - len(missing),
        "missing_report_types": missing,
        "statuses": [_status_to_dict(st) for st in item.statuses],
    }


# ============================================================
# R1 报表上传状态
# ============================================================


@report_upload_status_router.get("")
def get_report_upload_status(
    request: Request,
    report_date: Annotated[
        str,
        Query(
            min_length=10,
            max_length=10,
            description="业务日期（YYYY-MM-DD）",
        ),
    ],
    country: str = "US",
    project_id: int | None = Query(
        default=None, description="可选：只看指定项目（凭据可见范围内）"
    ),
    db: Session = Depends(get_read_db_session),
) -> dict:
    """R1 报表上传状态：与内部 ``/api/v1/rpa-reports/status`` 同构 + summary。

    service 返回全部项目（operator=None / is_admin=True，Agent 凭据无 operator
    语义）；再按 key 的 project_scope 过滤 items；``?project_id=`` 进一步收窄。
    """
    with _service_errors():
        _validate_report_date(report_date)
        resp = get_report_status_for_date(
            db,
            report_date=report_date,
            country=country,
            operator=None,
            is_admin=True,
        )
        items = _visible_items(request, resp.items)
        if project_id is not None:
            items = [item for item in items if item.project_id == project_id]
            if not items:
                raise AgentApiError(
                    ErrorCode.RESOURCE_NOT_FOUND,
                    human_message=f"项目 {project_id} 不存在或不在凭据可见范围内",
                )

        active_types = _active_report_types()
        payload_items = [_project_to_dict(item, active_types) for item in items]
        payload = {
            "country": country,
            "report_date": report_date,
            "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "project_count": len(payload_items),
            "missing_project_count": sum(
                1 for item in payload_items if item["missing_report_types"]
            ),
            "items": payload_items,
        }

    return agent_ok(payload)
