"""
BEL-157 订单信息页面 API endpoints

路由前缀：`/api/v1/order-info`
"""

from __future__ import annotations

import base64
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.deps import get_primary_db_session, get_read_db_session, protected
from app.schemas.order_info import (
    OrderInfoExportRequest,
    OrderInfoExportResponse,
    OrderInfoFilterOptions,
    OrderInfoListResponse,
    OrderInfoPageData,
    OrderInfoStats,
)
from app.services.data import order_info_service

router = APIRouter(prefix="/order-info", tags=["order-info"], dependencies=[Depends(protected)])


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


def _normalize_date_range(
    date_from: Optional[str],
    date_to: Optional[str],
) -> tuple[Optional[date], Optional[date]]:
    return order_info_service.parse_date_input(date_from), order_info_service.parse_date_input(date_to)


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
) -> OrderInfoPageData:
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
    )


@router.get("/list", response_model=OrderInfoListResponse)
def list_orders(
    project_ids: list[int] | None = Query(default=None),
    fulfillment_channels: list[str] | None = Query(default=None),
    order_statuses: list[str] | None = Query(default=None),
    countries: list[str] | None = Query(default=None),
    currencies: list[str] | None = Query(default=None),
    sku_keyword: str | None = None,
    order_id_keyword: str | None = Query(default=None, alias="orderIdKeyword"),
    asin_keyword: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    page: int = 1,
    page_size: int = order_info_service.DEFAULT_PAGE_SIZE,
    sort_by: str = "purchase_at_pt",
    sort_dir: str = "desc",
    db: Session = Depends(get_read_db_session),
) -> OrderInfoListResponse:
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
    )


@router.get("/stats", response_model=OrderInfoStats)
def get_stats(
    project_ids: list[int] | None = Query(default=None),
    fulfillment_channels: list[str] | None = Query(default=None),
    order_statuses: list[str] | None = Query(default=None),
    countries: list[str] | None = Query(default=None),
    currencies: list[str] | None = Query(default=None),
    sku_keyword: str | None = None,
    order_id_keyword: str | None = Query(default=None, alias="orderIdKeyword"),
    asin_keyword: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    db: Session = Depends(get_read_db_session),
) -> OrderInfoStats:
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
    )


@router.get("/filter-options", response_model=OrderInfoFilterOptions)
def get_filter_options(db: Session = Depends(get_read_db_session)) -> OrderInfoFilterOptions:
    return order_info_service.collect_filter_options(db)


@router.post("/export", response_model=OrderInfoExportResponse)
def export_orders(
    payload: OrderInfoExportRequest,
    db: Session = Depends(get_read_db_session),
) -> OrderInfoExportResponse:
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
    )
    return OrderInfoExportResponse(
        filename=filename,
        content_type="text/csv; charset=utf-8",
        content_base64=base64.b64encode(csv_text.encode("utf-8")).decode("ascii"),
    )