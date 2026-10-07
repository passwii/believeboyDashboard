"""
BEL-157 订单信息页面 API endpoints

路由前缀：`/api/v1/order-info`
"""

from __future__ import annotations

import base64
import logging
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.api.deps import (
    get_bounded_read_db_session,
    get_primary_db_session,
    get_read_db_session,
    get_request_operator,
    protected,
)
from app.core.config import get_settings
from app.db.query_timeout import is_query_timeout_error
from app.models.product_analysis_source import AnalysisSalesOrderRow, AnalysisSourceFile
from app.models.project import Project
from app.schemas.order_info import (
    OrderInfoExportRequest,
    OrderInfoExportResponse,
    OrderInfoFilterOptions,
    OrderInfoItem,
    OrderLiveStreamItem,
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

logger = logging.getLogger("app.request")

#: 语句超时返回给前端的稳定错误码。放在 detail 字符串最前面，前端既能整串
#: 展示，也能 `detail.startsWith(...)` 做分支；Next.js 代理对非流式响应是
#: 透传状态码 + body 的，所以这个 token 能原样到达浏览器。
QUERY_TIMEOUT_CODE = "order_info_query_timeout"


@contextmanager
def _query_timeout_guard(db: Session, endpoint: str) -> Iterator[None]:
    """把 statement timeout 失败翻译成 504，与真实 500 区分开。

    为什么必须区分：客户端断开（代理 abort / 关页面）之后，后端线程并不会停，
    靠的就是 `statement_timeout` 主动取消语句。这种"服务端主动放弃"对用户来说
    是超时（可提示收窄筛选后重试），不是服务端故障；混进 500 会让前端把它当成
    崩溃路径，也让监控把预算问题误报成可用性事故。

    顺带在这里 rollback：PG 取消语句后当前事务已进入 aborted 状态，显式回滚可以
    立刻把连接还回池里，而不是等依赖的 `db.close()`。
    """
    try:
        yield
    except SQLAlchemyError as exc:
        if not is_query_timeout_error(exc):
            raise
        timeout_ms = get_settings().order_info_statement_timeout_ms
        logger.warning(
            "[order-info] %s 语句超时：单语句上限 %dms 已耗尽，连接已归还。"
            "请收窄店铺/日期范围后重试。",
            endpoint,
            timeout_ms,
        )
        try:
            db.rollback()
        except Exception:  # noqa: BLE001 - 回滚失败也不能盖掉原始超时语义
            logger.warning("[order-info] %s 超时后回滚失败", endpoint, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail=(
                f"{QUERY_TIMEOUT_CODE}: 订单查询超过服务端上限（{timeout_ms}ms），"
                "请收窄店铺或日期范围后重试"
            ),
        ) from exc


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
    db: Session = Depends(get_bounded_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> OrderInfoPageData:
    _ensure_operator_header(operator, bool(is_admin))
    df, dt = _normalize_date_range(date_from, date_to)
    with _query_timeout_guard(db, "page"):
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
    db: Session = Depends(get_bounded_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> OrderInfoListResponse:
    _ensure_operator_header(operator, bool(is_admin))
    df, dt = _normalize_date_range(date_from, date_to)
    with _query_timeout_guard(db, "list"):
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
    db: Session = Depends(get_bounded_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> OrderInfoStats:
    _ensure_operator_header(operator, bool(is_admin))
    df, dt = _normalize_date_range(date_from, date_to)
    with _query_timeout_guard(db, "stats"):
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
    db: Session = Depends(get_bounded_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> OrderInfoOverview:
    """一次返回 列表 + 顶部统计（不含 filter_options）。前端筛选/翻页/排序用这个，
    取代原先并行的 /list + /stats 两请求。"""
    _ensure_operator_header(operator, bool(is_admin))
    df, dt = _normalize_date_range(date_from, date_to)
    with _query_timeout_guard(db, "overview"):
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
    db: Session = Depends(get_bounded_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> OrderInfoFilterOptions:
    _ensure_operator_header(operator, bool(is_admin))
    with _query_timeout_guard(db, "filter-options"):
        return order_info_service.collect_filter_options(
            db, operator=operator, is_admin=bool(is_admin)
        )


@router.get("/live-stream", response_model=list[OrderLiveStreamItem])
def get_order_live_stream(
    project_ids: list[int] | None = Query(default=None),
    countries: list[str] | None = Query(default=None),
    limit: int = order_info_service.DEFAULT_LIVE_STREAM_LIMIT,
    db: Session = Depends(get_bounded_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> list[OrderLiveStreamItem]:
    """今日出单流：按订单去重的最近 N 条出单事件（BLF-839）。

    供终端 Inspector Live Stream 区块轮询（建议 30s–60s 间隔）。
    字段最小集 ``id`` / ``title`` / ``time_label`` 对齐前端
    ``LiveStreamItem`` 插槽（PR #425）；权限与 order-info 列表页同口径。
    """
    _ensure_operator_header(operator, bool(is_admin))
    with _query_timeout_guard(db, "live-stream"):
        return order_info_service.query_order_live_stream(
            db,
            project_ids=project_ids or None,
            countries=countries,
            limit=limit,
            operator=operator,
            is_admin=bool(is_admin),
        )


@router.post("/export", response_model=OrderInfoExportResponse)
def export_orders(
    payload: OrderInfoExportRequest,
    # BLF-1262 Stage 1 刻意**不**给 export 套 15s 上限：这是用户主动发起、
    # 有明确完成预期的 CSV 导出（EXPORT_MAX_ROWS=5000 行），压到 15s 会让
    # 正常的大导出失败。全店铺无筛选导出仍走全局 120s 兜底。
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
