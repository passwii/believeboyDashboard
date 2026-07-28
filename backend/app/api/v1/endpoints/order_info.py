"""
BEL-157 订单信息页面 API endpoints

路由前缀：`/api/v1/order-info`
"""

from __future__ import annotations

import base64
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import (
    get_primary_db_session,
    get_read_db_session,
    get_request_operator,
    protected,
)
from app.models.product_analysis_source import AnalysisSalesOrderRow, AnalysisSourceFile
from app.models.project import Project
from app.schemas.order_info import (
    OrderInfoExportRequest,
    OrderInfoExportResponse,
    OrderInfoFilterOptions,
    OrderInfoItem,
    OrderInfoListResponse,
    OrderInfoOverview,
    OrderInfoPageData,
    OrderInfoStats,
    OrderInfoUpdate,
)
from app.services.audit_log_service import append_operation_audit_log
from app.services.data import order_info_service
from app.services.data.order_info_service import (
    OrderInfoForbidden,
    OrderInfoNotFound,
    serialize_order_row,
)

router = APIRouter(
    prefix="/order-info", tags=["order-info"], dependencies=[Depends(protected)]
)


def _parse_int_list(values: list[str] | None) -> list[int]:
    out: list[int] = []
    for v in values or []:
        try:
            out.append(int(v))
        except (TypeError, ValueError):
            continue
    return out


def _parse_str_list(values: list[str] | None) -> list[str]:
    return [v for v in (values or []) if v]


def _ensure_operator_header(operator: str | None, is_admin: bool) -> None:
    """非 admin 操作员的请求必须带 X-Operator，否则视为鉴权不完整。

    之前 `_ensure_project_access_for_orders` 在 operator 为空时直接返回 `[]`，
    端点也会 200 + 空数据 — 在 Next.js App Router 偶发的 session/operator 头
    时序窗口下，前端会把 "请求失败" 误判为 "没有订单数据"，导致首屏死锁。
    显式 401 让前端能识别并触发重试/重新登录。
    """
    if not is_admin and not (operator and operator.strip()):
        raise HTTPException(
            status_code=401, detail="缺少 X-Operator 头，请重新登录后重试"
        )


def _normalize_date_range(
    date_from: Optional[str],
    date_to: Optional[str],
) -> tuple[Optional[date], Optional[date]]:
    return order_info_service.parse_date_input(
        date_from
    ), order_info_service.parse_date_input(date_to)


@router.get("/page", response_model=OrderInfoPageData)
def get_order_info_page(
    project_ids: list[int] | None = Query(default=None),
    fulfillment_channels: list[str] | None = Query(default=None),
    order_statuses: list[str] | None = Query(default=None),
    countries: list[str] | None = Query(default=None),
    currencies: list[str] | None = Query(default=None),
    sku_keyword: str | None = None,
    order_id_keyword: str | None = None,
    asin_keyword: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    page: int = 1,
    page_size: int = order_info_service.DEFAULT_PAGE_SIZE,
    sort_by: str = "purchase_at_pt",
    sort_dir: str = "desc",
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> OrderInfoPageData:
    _ensure_operator_header(operator, bool(is_admin))
    df, dt = _normalize_date_range(date_from, date_to)
    return order_info_service.get_page_data(
        db,
        project_ids=_parse_int_list(project_ids),
        fulfillment_channels=_parse_str_list(fulfillment_channels),
        order_statuses=_parse_str_list(order_statuses),
        countries=_parse_str_list(countries),
        currencies=_parse_str_list(currencies),
        sku_keyword=sku_keyword,
        order_id_keyword=order_id_keyword,
        asin_keyword=asin_keyword,
        date_from=df,
        date_to=dt,
        page=page,
        page_size=page_size,
        sort_by=sort_by,
        sort_dir=sort_dir,
        operator=operator,
        is_admin=bool(is_admin),
    )


@router.get("/list", response_model=OrderInfoListResponse)
def list_orders(
    project_ids: list[int] | None = Query(default=None),
    fulfillment_channels: list[str] | None = Query(default=None),
    order_statuses: list[str] | None = Query(default=None),
    countries: list[str] | None = Query(default=None),
    currencies: list[str] | None = Query(default=None),
    sku_keyword: str | None = None,
    order_id_keyword: str | None = None,
    asin_keyword: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    page: int = 1,
    page_size: int = order_info_service.DEFAULT_PAGE_SIZE,
    sort_by: str = "purchase_at_pt",
    sort_dir: str = "desc",
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> OrderInfoListResponse:
    _ensure_operator_header(operator, bool(is_admin))
    df, dt = _normalize_date_range(date_from, date_to)
    return order_info_service.list_orders(
        db,
        project_ids=_parse_int_list(project_ids),
        fulfillment_channels=_parse_str_list(fulfillment_channels),
        order_statuses=_parse_str_list(order_statuses),
        countries=_parse_str_list(countries),
        currencies=_parse_str_list(currencies),
        sku_keyword=sku_keyword,
        order_id_keyword=order_id_keyword,
        asin_keyword=asin_keyword,
        date_from=df,
        date_to=dt,
        page=page,
        page_size=page_size,
        sort_by=sort_by,
        sort_dir=sort_dir,
        operator=operator,
        is_admin=bool(is_admin),
    )


@router.get("/stats", response_model=OrderInfoStats)
def get_stats(
    project_ids: list[int] | None = Query(default=None),
    fulfillment_channels: list[str] | None = Query(default=None),
    order_statuses: list[str] | None = Query(default=None),
    countries: list[str] | None = Query(default=None),
    currencies: list[str] | None = Query(default=None),
    sku_keyword: str | None = None,
    order_id_keyword: str | None = None,
    asin_keyword: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> OrderInfoStats:
    _ensure_operator_header(operator, bool(is_admin))
    df, dt = _normalize_date_range(date_from, date_to)
    return order_info_service.compute_stats(
        db,
        project_ids=_parse_int_list(project_ids),
        fulfillment_channels=_parse_str_list(fulfillment_channels),
        order_statuses=_parse_str_list(order_statuses),
        countries=_parse_str_list(countries),
        currencies=_parse_str_list(currencies),
        sku_keyword=sku_keyword,
        order_id_keyword=order_id_keyword,
        asin_keyword=asin_keyword,
        date_from=df,
        date_to=dt,
        operator=operator,
        is_admin=bool(is_admin),
    )


@router.get("/overview", response_model=OrderInfoOverview)
def get_overview(
    project_ids: list[int] | None = Query(default=None),
    fulfillment_channels: list[str] | None = Query(default=None),
    order_statuses: list[str] | None = Query(default=None),
    countries: list[str] | None = Query(default=None),
    currencies: list[str] | None = Query(default=None),
    sku_keyword: str | None = None,
    order_id_keyword: str | None = None,
    asin_keyword: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    page: int = 1,
    page_size: int = order_info_service.DEFAULT_PAGE_SIZE,
    sort_by: str = "purchase_at_pt",
    sort_dir: str = "desc",
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> OrderInfoOverview:
    """一次返回 列表 + 顶部统计（不含 filter_options）。前端筛选/翻页/排序用这个，
    取代原先并行的 /list + /stats 两请求。"""
    _ensure_operator_header(operator, bool(is_admin))
    df, dt = _normalize_date_range(date_from, date_to)
    return order_info_service.get_overview(
        db,
        project_ids=_parse_int_list(project_ids),
        fulfillment_channels=_parse_str_list(fulfillment_channels),
        order_statuses=_parse_str_list(order_statuses),
        countries=_parse_str_list(countries),
        currencies=_parse_str_list(currencies),
        sku_keyword=sku_keyword,
        order_id_keyword=order_id_keyword,
        asin_keyword=asin_keyword,
        date_from=df,
        date_to=dt,
        page=page,
        page_size=page_size,
        sort_by=sort_by,
        sort_dir=sort_dir,
        operator=operator,
        is_admin=bool(is_admin),
    )


@router.get("/filter-options", response_model=OrderInfoFilterOptions)
def get_filter_options(
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> OrderInfoFilterOptions:
    _ensure_operator_header(operator, bool(is_admin))
    return order_info_service.collect_filter_options(
        db, operator=operator, is_admin=bool(is_admin)
    )


@router.post("/export", response_model=OrderInfoExportResponse)
def export_orders(
    payload: OrderInfoExportRequest,
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> OrderInfoExportResponse:
    _ensure_operator_header(operator, bool(is_admin))
    df = order_info_service.parse_date_input(payload.date_from)
    dt = order_info_service.parse_date_input(payload.date_to)
    filename, csv_text = order_info_service.export_orders_to_csv(
        db,
        project_ids=payload.project_ids,
        fulfillment_channels=payload.fulfillment_channels,
        order_statuses=payload.order_statuses,
        countries=payload.countries,
        currencies=payload.currencies,
        sku_keyword=payload.sku_keyword,
        order_id_keyword=payload.order_id_keyword,
        asin_keyword=payload.asin_keyword,
        date_from=df,
        date_to=dt,
        operator=operator,
        is_admin=bool(is_admin),
    )
    return OrderInfoExportResponse(
        filename=filename,
        content_type="text/csv; charset=utf-8",
        content_base64=base64.b64encode(csv_text.encode("utf-8")).decode("ascii"),
    )


@router.patch("/{order_id}", response_model=OrderInfoItem)
def update_order(
    order_id: int,
    payload: OrderInfoUpdate,
    request: Request,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> OrderInfoItem:
    """FBM 订单补录/编辑（carrier / tracking_no / shipped_at / updated_by）。

    - admin：可编辑任意店铺的订单
    - operator：仅可编辑"运营关联"店铺的订单（受 _ensure_project_access_for_orders 约束）
    - 写入成功后落 operation_audit_log（action=order_info.update）
    """
    _ensure_operator_header(operator, bool(is_admin))

    # before 快照：用于审计 + 错误时回滚（虽然本次仅改新列，但保留原值便于审计）
    before_row_tuple = db.execute(
        select(AnalysisSalesOrderRow, Project)
        .join(
            AnalysisSourceFile,
            AnalysisSourceFile.id == AnalysisSalesOrderRow.source_file_id,
        )
        .join(Project, Project.id == AnalysisSourceFile.project_id)
        .where(AnalysisSourceFile.is_current.is_(True))
        .where(AnalysisSalesOrderRow.id == order_id)
    ).first()
    before = (
        serialize_order_row(before_row_tuple[0], project=before_row_tuple[1])
        if before_row_tuple
        else None
    )

    try:
        updated = order_info_service.update_order_by_id(
            db,
            order_id,
            payload,
            operator=operator,
            is_admin=bool(is_admin),
        )
    except OrderInfoNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    except OrderInfoForbidden as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc))

    append_operation_audit_log(
        db,
        action="order_info.update",
        target_type="order_info",
        target_id=order_id,
        operator=operator,
        before=before,
        after=updated,
        request=request,
    )
    db.commit()
    return updated
