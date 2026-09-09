"""客诉中心 Dashboard 端点（BLF-981）。

对齐 inventory/shipments 模式：project_id 路径参数 + country 查询参数。

供前端「客诉中心」页面调用，走 ``/api/backend`` 代理 + session 鉴权（``protected``）。

* ``GET /overview`` —— 概览（指标卡 + 近 30 天趋势 + 店铺健康表）
* ``GET /complaints`` —— 明细列表（筛选/排序/分页）
* ``GET /complaints/{id}`` —— 详情（消息原文、Agent 摘要、订单时间线、状态历史）
* ``PATCH /complaints/{id}`` —— 状态流转（带状态机校验 + 审计）
"""

from __future__ import annotations

from datetime import date as _date
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session

from app.api.deps import get_primary_db_session, get_read_db_session, get_request_operator, protected
from app.schemas.complaint_center import ComplaintDetail, ComplaintListItem, ComplaintPatchRequest, OverviewResponse
from app.services.audit_log_service import append_operation_audit_log
from app.services.complaint_center_service import (
    StatusTransitionError,
    count_spam_complaints,
    fetch_complaints,
    fetch_overview,
    get_complaint_by_id,
    patch_complaint,
)

router = APIRouter(
    prefix="/complaints",
    tags=["complaints"],
    dependencies=[Depends(protected)],
)


ComplaintSort = Literal["sla_asc", "sla_desc", "date_asc", "date_desc"]


def _parse_date_param(value: str | None, field: str) -> _date:
    if not value:
        raise HTTPException(status_code=400, detail=f"{field} 必填")
    try:
        return _date.fromisoformat(value)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"{field} 格式非法（期望 YYYY-MM-DD）") from None


@router.get("/overview", response_model=OverviewResponse)
def get_overview(
    date: str | None = Query(default=None, description="巡检日期，默认今天"),
    country: str | None = Query(default=None, description="站点筛选 US|DE|GB"),
    db: Session = Depends(get_read_db_session),
) -> OverviewResponse:
    target = _parse_date_param(date, "date") if date else _date.today()
    return OverviewResponse.model_validate(fetch_overview(db, target, country=country))


@router.get("", response_model=dict)
def list_complaints(
    date: str | None = Query(default=None),
    project_id: int | None = Query(default=None),
    category: str | None = Query(default=None),
    status: str | None = Query(
        default=None,
        description="pending|drafted|replied|resolved|closed_no_response",
    ),
    country: str | None = Query(default=None),
    keyword: str | None = Query(default=None),
    sort: ComplaintSort = Query(
        default="sla_asc",
        description="sla_asc|sla_desc|date_asc|date_desc",
    ),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_read_db_session),
) -> dict:
    target_date = _parse_date_param(date, "date") if date else None
    offset = (page - 1) * page_size
    items, total = fetch_complaints(
        db,
        run_date=target_date,
        project_id=project_id,
        category=category,
        status_filter=status,
        country=country,
        keyword=keyword,
        sort=sort,
        offset=offset,
        limit=page_size,
    )
    return {
        "items": [
            ComplaintListItem.model_validate(item).model_dump(mode="json", by_alias=True)
            for item in items
        ],
        "total": total,
        "page": page,
        "page_size": page_size,
        "spam_count": count_spam_complaints(
            db,
            run_date=target_date,
            project_id=project_id,
            country=country,
        ),
    }


@router.get("/{complaint_id}", response_model=ComplaintDetail)
def get_complaint(complaint_id: int, db: Session = Depends(get_read_db_session)) -> dict:
    complaint = get_complaint_by_id(db, complaint_id)
    if complaint is None:
        raise HTTPException(status_code=404, detail=f"客诉 {complaint_id} 不存在")
    return ComplaintDetail.model_validate(complaint).model_dump(mode="json", by_alias=True)


@router.patch("/{complaint_id}", response_model=ComplaintDetail)
def patch_complaint_endpoint(
    complaint_id: int,
    body: ComplaintPatchRequest,
    request: Request,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
) -> dict:
    complaint = get_complaint_by_id(db, complaint_id)
    if complaint is None:
        raise HTTPException(status_code=404, detail=f"客诉 {complaint_id} 不存在")

    try:
        patch_complaint(db, complaint, body, operator=operator)
    except StatusTransitionError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None

    append_operation_audit_log(
        db,
        action="complaint_center.status_change",
        target_type="complaint",
        target_id=complaint.id,
        operator=operator,
        after={
            "status": complaint.status,
            "draft_path": complaint.draft_path,
            "reply_sent_at": complaint.reply_sent_at.isoformat() if complaint.reply_sent_at else None,
            "handler_note": complaint.handler_note,
        },
        request=request,
    )
    db.commit()
    db.refresh(complaint)
    complaint = get_complaint_by_id(db, complaint.id) or complaint
    return ComplaintDetail.model_validate(complaint).model_dump(mode="json", by_alias=True)
