"""Agent 退货分析域路由（BLF-470；spec §3-§4）。

在 ``/api/v1/agent/projects/{project_id}/return-analysis*`` 开放 5 条读路由：

* R1 overview —— 全量分析（与内部 ``/api/v1/return-analysis`` 同构：Redis v2
  缓存 → snapshot-or-fallback 双路径；``?sku=`` 可钻取；``?include_comments=``
  控制顾客评论 PII 开关，D4 拍板默认剥离）；
* R2 per-SKU 聚合 —— 原生替换镜像（BLF-459），查询契约对齐 external §9
  （period/country/sku/min_return_rate/risk_level/分页/排序）+ 补
  ``product_name`` / ``reason_top1_display`` / ``disposition_top1_display``；
* R3 raw 事件 —— 原生替换镜像，PII 剥离契约保持不变
  （customer_comments/raw_row/fnsku/license_plate_number 永不返回）；
* R4 单 SKU 钻取 —— 薄封装 ``build_return_analysis(sku=...)``；
* R5 数据覆盖度 / 快照新鲜度 —— 新增（仅 Agent 通道）：报表上传历史 +
  数据跨度 + snapshot fresh 布尔。

退货分析是纯读 / 分析域（raw 行是 Amazon 报表来源的不可变事实）——5 条路由
全部读、无 confirm、无写桶、不落审计。全部路由挂 ``Depends(require_project_scope)``
（BLF-441 硬前置）；域级 ``require_business_scope("return_analysis")`` 在
``agent/__init__.py`` 装配时挂载。
"""

from __future__ import annotations

import logging
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.agent.errors import AgentApiError, ErrorCode
from app.api.agent.response import agent_ok
from app.api.agent.scope import require_project_scope
from app.api.deps import get_read_db_session
from app.api.v1.endpoints.external._helpers import parse_country
from app.api.v1.endpoints.external._period import parse_period_v2
from app.api.v1.endpoints.external._whitelist import (
    parse_aggregate_order_by,
    parse_order_by,
)
from app.constants.return_thresholds import SNAPSHOT_STALENESS_HOURS
from app.constants.return_translations import translate_return_field
from app.models import (
    AnalysisReturnAggregate,
    AnalysisReturnRow,
    AnalysisSourceFile,
    Project,
)
from app.schemas.external.common import PeriodInfo
from app.services.analysis.return_analysis.analysis import (
    _build_sku_product_name_map,
    build_return_analysis,
    build_return_analysis_from_snapshot,
    get_snapshot_last_computed_at,
    is_snapshot_fresh_for_range,
)
from app.services.external.return_analysis_query import (
    build_aggregate_summary,
    query_return_analysis_aggregate,
    query_return_analysis_raw,
)
from app.services.infra.inventory_cache import (
    get_return_analysis_v2_cache,
    set_return_analysis_v2_cache,
)

logger = logging.getLogger(__name__)

return_analysis_router = APIRouter(
    prefix="/projects/{project_id}",
    tags=["agent-return-analysis"],
)

# risk_level 白名单（对齐 external handler，防御纵深）。
_VALID_RISK_LEVELS = frozenset({"critical", "warning", "normal", "no_data"})


# ============================================================
# 壳翻译与解析 helper（对齐店铺/新品域模板）
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


def _get_project_or_shell_404(db: Session, project_id: int) -> Project:
    project = db.get(Project, project_id)
    if project is None:
        raise AgentApiError(
            ErrorCode.RESOURCE_NOT_FOUND,
            human_message=f"项目 {project_id} 不存在",
        )
    return project


def _validate_date_range(start_date: str, end_date: str) -> None:
    """R1/R4 日期参数语义校验：``YYYY-MM-DD`` 且为合法日历日期。

    ``Query(min_length=10, max_length=10)`` 只卡格式不卡语义（如 ``2026-13-99``），
    这里在进入双段式（``date.fromisoformat``）前提前 400 VALIDATION_FAILED，
    避免 500。
    """
    for label, value in (("start_date", start_date), ("end_date", end_date)):
        try:
            date.fromisoformat(value)
        except ValueError:
            raise AgentApiError(
                ErrorCode.VALIDATION_FAILED,
                human_message=f"{label} 必须是合法日期（YYYY-MM-DD），got {value!r}",
            ) from None


def _period_to_json(period: PeriodInfo) -> dict:
    """PeriodInfo → JSON-safe dict（date 字段转 ISO 字符串）。"""
    return {
        "type": period.type,
        "value": period.value,
        "start_date": period.start_date.isoformat(),
        "end_date": period.end_date.isoformat(),
    }


def _strip_feedback_comments(data: dict, include_comments: bool) -> dict:
    """D4：默认剥离 feedback_rows 的 customer_comment（PII）。

    ``include_comments=True`` 时原样返回（Agent 通道直连后端、凭据可控）。
    返回新 dict，不就地修改缓存 payload。
    """
    if include_comments:
        return data
    rows = data.get("feedback_rows")
    if not rows:
        return data
    stripped = [
        {k: v for k, v in row.items() if k != "customer_comment"} for row in rows
    ]
    return {**data, "feedback_rows": stripped}


def _build_return_analysis_payload(
    db: Session,
    *,
    project_id: int,
    country: str,
    start_date: str,
    end_date: str,
    sku: str | None,
) -> dict:
    """R1/R4 共用：与内部端点完全相同的双段式（缓存 → snapshot-or-fallback）。

    复用同一个 Redis v2 缓存 key（含 sku），Agent 读与 UI 读共享缓存，
    天然一致、成本为 0。写入缓存的始终是完整 payload（含 customer_comment），
    PII 剥离只在返回时进行（``_strip_feedback_comments``）。
    """
    cached = get_return_analysis_v2_cache(project_id, country, start_date, end_date, sku)
    if cached is not None:
        # 去掉辅助字段后构造（对齐内部端点；缓存 dict 直接作为 payload）
        cached.pop("_cache_source", None)
        return cached

    if is_snapshot_fresh_for_range(
        db,
        project_id=project_id,
        country=country,
        start_date=start_date,
        end_date=end_date,
    ):
        try:
            result = build_return_analysis_from_snapshot(
                db,
                project_id=project_id,
                country=country,
                start_date=start_date,
                end_date=end_date,
                sku=sku,
            )
            source = "snapshot"
        except Exception as exc:  # 物化表路径出问题时降级到现场跑
            logger.warning(
                "snapshot path failed, fallback to live: project=%s err=%s",
                project_id,
                exc,
            )
            result = build_return_analysis(
                db,
                project_id=project_id,
                country=country,
                start_date=start_date,
                end_date=end_date,
                sku=sku,
            )
            source = "fallback"
    else:
        result = build_return_analysis(
            db,
            project_id=project_id,
            country=country,
            start_date=start_date,
            end_date=end_date,
            sku=sku,
        )
        source = "fallback"

    payload = result.model_dump(mode="json")
    set_return_analysis_v2_cache(
        project_id,
        country,
        start_date,
        end_date,
        sku,
        payload,
        source=source,
    )
    return payload


def _enrich_aggregate_rows(
    db: Session, *, project_id: int, country: str, rows: list[dict]
) -> list[dict]:
    """R2 原生化增强：补 ``product_name`` + reason/disposition 中文 display。

    external-api.md §9 文档承诺过这些字段但代码未实现——原生化时以代码契约为
    基准补上（翻译常量已现成）；``risk_trend`` 需新算法，不承诺。
    """
    skus = [r.get("sku") for r in rows if r.get("sku")]
    name_map = _build_sku_product_name_map(db, project_id, country, skus) if skus else {}
    enriched: list[dict] = []
    for r in rows:
        row = dict(r)
        row["product_name"] = name_map.get(r.get("sku"))
        reason = row.get("reason_top1")
        disposition = row.get("disposition_top1")
        row["reason_top1_display"] = (
            translate_return_field("reason", reason) if reason else None
        )
        row["disposition_top1_display"] = (
            translate_return_field("disposition", disposition) if disposition else None
        )
        enriched.append(row)
    return enriched


def _query_report_uploads(db: Session, *, project_id: int, country: str) -> list[dict]:
    """R5：当前 return_report 上传版本列表（period 倒序，最多 20 条）。"""
    stmt = (
        select(AnalysisSourceFile)
        .where(
            AnalysisSourceFile.project_id == project_id,
            AnalysisSourceFile.country == country,
            AnalysisSourceFile.report_type == "return_report",
            AnalysisSourceFile.is_current == True,  # noqa: E712
        )
        .order_by(
            AnalysisSourceFile.period_end_date.desc(),
            AnalysisSourceFile.id.desc(),
        )
        .limit(20)
    )
    rows = db.scalars(stmt).all()
    return [
        {
            "source_file_id": r.id,
            "version": r.version,
            "is_current": r.is_current,
            "period_start_date": r.period_start_date.isoformat()
            if r.period_start_date
            else None,
            "period_end_date": r.period_end_date.isoformat()
            if r.period_end_date
            else None,
            "ingestion_status": r.ingestion_status,
            "row_count": r.row_count_total,
            "original_filename": r.original_filename,
            "created_by": r.created_by,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]


def _is_snapshot_fresh(last_computed_at: datetime | None) -> bool:
    """R5：快照新鲜度布尔（last_computed_at 距今 ≤ SNAPSHOT_STALENESS_HOURS）。"""
    if last_computed_at is None:
        return False
    now = (
        datetime.now(tz=last_computed_at.tzinfo)
        if last_computed_at.tzinfo
        else datetime.now()
    )
    return (now - last_computed_at).total_seconds() <= SNAPSHOT_STALENESS_HOURS * 3600


def _query_data_span(db: Session, *, project_id: int, country: str) -> dict:
    """R5：当前 return_report 数据的 min/max return_date 跨度。"""
    row = db.execute(
        select(
            func.min(AnalysisReturnRow.return_date),
            func.max(AnalysisReturnRow.return_date),
        )
        .join(
            AnalysisSourceFile,
            AnalysisSourceFile.id == AnalysisReturnRow.source_file_id,
        )
        .where(
            AnalysisSourceFile.project_id == project_id,
            AnalysisSourceFile.country == country,
            AnalysisSourceFile.report_type == "return_report",
            AnalysisSourceFile.is_current == True,  # noqa: E712
        )
    ).first()
    if row and row[0] is not None and row[1] is not None:
        return {
            "min_return_date": row[0].isoformat(),
            "max_return_date": row[1].isoformat(),
        }
    return {"min_return_date": None, "max_return_date": None}


# ============================================================
# R1 全量分析 overview
# ============================================================


@return_analysis_router.get("/return-analysis/overview")
def get_return_analysis_overview(
    project_id: int,
    start_date: Annotated[str, Query(min_length=10, max_length=10)],
    end_date: Annotated[str, Query(min_length=10, max_length=10)],
    country: str = "US",
    sku: str | None = None,
    include_comments: bool = False,
    db: Session = Depends(get_read_db_session),
    _scope=Depends(require_project_scope),
) -> dict:
    """R1 全量退货分析：与内部端点同构的双段式（缓存 → snapshot-or-fallback）。

    ``?sku=`` 可钻取单 SKU；``?include_comments=true`` 显式开启顾客评论
    （默认剥离，D4 拍板）。
    """
    with _service_errors():
        _get_project_or_shell_404(db, project_id)
        _validate_date_range(start_date, end_date)
        payload = _build_return_analysis_payload(
            db,
            project_id=project_id,
            country=country,
            start_date=start_date,
            end_date=end_date,
            sku=sku,
        )
    return agent_ok(_strip_feedback_comments(payload, include_comments))


# ============================================================
# R2 per-SKU 聚合（原生替换镜像）
# ============================================================


@return_analysis_router.get("/return-analysis")
def get_return_analysis_aggregate(
    project_id: int = Path(..., ge=1),
    period: str = Query(default=""),
    start_date: str | None = Query(default=None),
    end_date: str | None = Query(default=None),
    country: str = Query(default=""),
    sku: str | None = Query(
        default=None,
        description="Optional SKU substring filter (case-insensitive)",
    ),
    min_return_rate: float | None = Query(
        default=None,
        ge=0.0,
        le=100.0,
        description="Filter: return_rate >= value (percent)",
    ),
    risk_level: str | None = Query(
        default=None,
        description="Filter: critical / warning / normal / no_data",
    ),
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    order_by: str = Query(default="return_quantity"),
    order_dir: str = Query(default="desc", pattern="^(asc|desc)$"),
    db: Session = Depends(get_read_db_session),
    _scope=Depends(require_project_scope),
) -> dict:
    """R2 per-SKU 聚合：查询契约与 external §9 完全一致（原生替换镜像）。

    每行补 ``product_name`` / ``reason_top1_display`` / ``disposition_top1_display``
    （external-api.md §9 文档承诺过但代码未实现）。
    """
    with _service_errors():
        _get_project_or_shell_404(db, project_id)
        try:
            normalized_country = parse_country(country)
            period_info = parse_period_v2(
                period,
                start_date,
                end_date,
                today=date.today() - timedelta(days=1),
            )
            sort_key, direction = parse_aggregate_order_by(
                order_by,
                order_dir,
                model=AnalysisReturnAggregate,
            )
        except Exception as exc:
            raise AgentApiError(
                ErrorCode.VALIDATION_FAILED, human_message=str(exc)
            ) from None

        if risk_level and risk_level not in _VALID_RISK_LEVELS:
            raise AgentApiError(
                ErrorCode.VALIDATION_FAILED,
                human_message=(
                    f"risk_level must be one of {sorted(_VALID_RISK_LEVELS)}, "
                    f"got {risk_level!r}"
                ),
            )

        rows, total = query_return_analysis_aggregate(
            db,
            project_id=project_id,
            country=normalized_country,
            date_from=period_info.start_date,
            date_to=period_info.end_date,
            order_column=sort_key,
            order_dir=direction,
            limit=limit,
            offset=offset,
            sku_substring=sku,
            min_return_rate=min_return_rate,
            risk_level=risk_level,
        )
        rows = _enrich_aggregate_rows(
            db, project_id=project_id, country=normalized_country, rows=rows
        )
        summary = build_aggregate_summary(rows)

    return agent_ok(
        {
            "project_id": project_id,
            "period": _period_to_json(period_info),
            "country": normalized_country,
            "data": rows,
            "summary": summary,
        }
    )


# ============================================================
# R3 raw 事件（原生替换镜像）
# ============================================================


@return_analysis_router.get("/return-analysis-raw")
def get_return_analysis_raw(
    project_id: int = Path(..., ge=1),
    period: str = Query(default=""),
    start_date: str | None = Query(default=None),
    end_date: str | None = Query(default=None),
    country: str = Query(default=""),
    limit: int = Query(default=10000, ge=1, le=50000),
    offset: int = Query(default=0, ge=0),
    order_by: str = Query(default="return_date"),
    order_dir: str = Query(default="desc", pattern="^(asc|desc)$"),
    db: Session = Depends(get_read_db_session),
    _scope=Depends(require_project_scope),
) -> dict:
    """R3 raw 退货事件：PII 剥离契约保持不变（永不返回
    customer_comments / raw_row / fnsku / license_plate_number）。
    """
    with _service_errors():
        _get_project_or_shell_404(db, project_id)
        try:
            normalized_country = parse_country(country)
            period_info = parse_period_v2(
                period,
                start_date,
                end_date,
                today=date.today() - timedelta(days=1),
            )
            order_column, direction = parse_order_by(
                order_by,
                order_dir,
                model=AnalysisReturnRow,
            )
        except Exception as exc:
            raise AgentApiError(
                ErrorCode.VALIDATION_FAILED, human_message=str(exc)
            ) from None

        rows, min_d, max_d = query_return_analysis_raw(
            db,
            project_id=project_id,
            country=normalized_country,
            date_from=period_info.start_date,
            date_to=period_info.end_date,
            order_column=order_column,
            order_dir=direction,
            limit=limit,
            offset=offset,
        )

    return agent_ok(
        {
            "project_id": project_id,
            "period": _period_to_json(period_info),
            "country": normalized_country,
            "data": rows,
            "summary": {
                "total_rows": len(rows),
                "date_range": [min_d.isoformat(), max_d.isoformat()],
            },
        }
    )


# ============================================================
# R4 单 SKU 钻取
# ============================================================


@return_analysis_router.get("/return-analysis/skus/{sku}")
def get_return_analysis_sku(
    project_id: int,
    sku: str,
    start_date: Annotated[str, Query(min_length=10, max_length=10)],
    end_date: Annotated[str, Query(min_length=10, max_length=10)],
    country: str = "US",
    include_comments: bool = False,
    db: Session = Depends(get_read_db_session),
    _scope=Depends(require_project_scope),
) -> dict:
    """R4 单 SKU 钻取：R1 overview 的薄切片（``build_return_analysis(sku=...)``）。

    无该 SKU 退货数据 → 200 + 空分布行（``summary.total_returns=0``），
    不是 404——查询结果为空 ≠ 资源不存在（D6 拍板）。
    """
    with _service_errors():
        _get_project_or_shell_404(db, project_id)
        _validate_date_range(start_date, end_date)
        payload = _build_return_analysis_payload(
            db,
            project_id=project_id,
            country=country,
            start_date=start_date,
            end_date=end_date,
            sku=sku,
        )
    return agent_ok(_strip_feedback_comments(payload, include_comments))


# ============================================================
# R5 数据覆盖度 / 快照新鲜度（新增）
# ============================================================


@return_analysis_router.get("/return-analysis/coverage")
def get_return_analysis_coverage(
    project_id: int,
    country: str = "US",
    db: Session = Depends(get_read_db_session),
    _scope=Depends(require_project_scope),
) -> dict:
    """R5 数据覆盖度 / 快照新鲜度：报表上传历史 + 数据跨度 + snapshot fresh。

    退货分析强烈依赖数据新鲜度（报表按周期上传、snapshot 每日刷新）——Agent
    拿 overview 前可先自查「这份数据覆盖到哪天、快照是否过期」。
    """
    with _service_errors():
        _get_project_or_shell_404(db, project_id)
        report_uploads = _query_report_uploads(
            db, project_id=project_id, country=country
        )
        last_computed = get_snapshot_last_computed_at(
            db, project_id=project_id, country=country
        )
        fresh = _is_snapshot_fresh(last_computed)
        data_span = _query_data_span(db, project_id=project_id, country=country)

    return agent_ok(
        {
            "project_id": project_id,
            "country": country,
            "report_uploads": report_uploads,
            "snapshot": {
                "last_computed_at": last_computed.isoformat()
                if last_computed
                else None,
                "fresh": fresh,
                "staleness_threshold_hours": SNAPSHOT_STALENESS_HOURS,
            },
            "data_span": data_span,
        }
    )
