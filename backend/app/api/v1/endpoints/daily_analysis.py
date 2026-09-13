from __future__ import annotations

import logging
from typing import Annotated

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    Header,
    HTTPException,
    Query,
    Response,
    status,
)
from sqlalchemy.orm import Session

from app.api.deps import get_read_db_session, get_request_operator, protected
from app.db.session import SessionLocal
from app.schemas.daily_analysis import (
    ALL_PROJECTS_RESPONSE_SCHEMA_FINGERPRINT,
    DailyAnalysisAllCountriesResponse,
    DailyAnalysisAllProjectsCountriesResponse,
    DailyAnalysisAllProjectsResponse,
    DailyAnalysisResponse,
    serialize_all_projects_response,
)
from app.services import infra as redis_service
from app.services import project_service
from app.services.daily import (
    build_daily_analysis,
    build_daily_analysis_all_countries,
    build_daily_analysis_all_projects,
    build_daily_analysis_all_projects_countries,
)
from app.utils.country import normalize_country
from app.utils.date_utils import parse_yyyy_mm_dd

router = APIRouter(dependencies=[Depends(protected)])

logger = logging.getLogger(__name__)


def _build_all_projects_body(
    db: Session,
    *,
    project_ids: list[int],
    country: str,
    start_date: str,
    end_date: str,
    sku: str | None,
) -> bytes:
    """跑聚合 + 序列化响应字节（BLF-1038：缓存体 = 响应体）。"""
    payload = build_daily_analysis_all_projects(
        db,
        project_ids=project_ids,
        country=country,
        start_date=start_date,
        end_date=end_date,
        sku=sku,
    )
    return serialize_all_projects_response(payload)


def _refresh_all_projects_snapshot(
    *,
    cache_key: str,
    project_ids: list[int],
    country: str,
    start_date: str,
    end_date: str,
    sku: str | None,
) -> None:
    """stale-while-revalidate 的后台刷新（FastAPI BackgroundTasks 调用）。

    - 用独立 session（请求 session 可能已随响应关闭），读主库保证拿到刚提交的数据；
    - 失败只记 warning（旧快照继续服务，下个周期再试），不把异常往上抛；
    - 无论成败都释放单飞锁，否则后续请求将永远无法刷新。
    """
    db = SessionLocal()
    try:
        body = _build_all_projects_body(
            db,
            project_ids=project_ids,
            country=country,
            start_date=start_date,
            end_date=end_date,
            sku=sku,
        )
        redis_service.store_daily_analysis_all_snapshot(cache_key, body)
    except Exception:
        logger.warning(
            "daily-analysis/all 后台刷新失败（cache_key=%s）", cache_key, exc_info=True
        )
    finally:
        db.close()
        redis_service.release_daily_analysis_all_lock(cache_key)


@router.get("/daily-analysis", response_model=DailyAnalysisResponse)
def get_daily_analysis(
    project_id: int,
    start_date: Annotated[str, Query(min_length=10, max_length=10)],
    end_date: Annotated[str, Query(min_length=10, max_length=10)],
    country: str = "US",
    sku: str | None = None,
    no_cache: bool = Query(default=False),
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
):
    project_service.ensure_project_access(
        db,
        project_id,
        operator=operator,
        is_admin=bool(is_admin),
    )
    return build_daily_analysis(
        db,
        project_id=project_id,
        country=country,
        start_date=start_date,
        end_date=end_date,
        sku=sku,
        no_cache=no_cache,
    )


@router.get("/daily-analysis/all", response_model=DailyAnalysisAllProjectsResponse)
def get_daily_analysis_all(
    background_tasks: BackgroundTasks,
    project_ids: Annotated[
        str,
        Query(
            description=(
                "comma-separated project IDs, or 'all' for the caller's "
                "visible active projects (admin sees every active project)"
            )
        ),
    ],
    start_date: Annotated[str, Query(min_length=10, max_length=10)],
    end_date: Annotated[str, Query(min_length=10, max_length=10)],
    country: str = "US",
    sku: str | None = None,
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
):
    normalized_operator = (operator or "").strip()

    if project_ids.strip().lower() == "all":
        # BLF-915 跟进：首页顶栏 KPI / Footer 快报 hook 传 all 哨兵。
        # 解析为调用者可见的活跃项目集 —— 与 /projects/manage 同一套
        # operator 过滤（list_accessible_project_ids → list_project_items），
        # 因此这里无需再逐个 ensure_project_access（可见集本身就是授权结果）。
        accessible = project_service.list_accessible_project_ids(
            db,
            operator=normalized_operator,
            is_admin=bool(is_admin),
        )
        if accessible is None:
            # admin → None 表示"全部项目"：展开为全部活跃项目 id
            # （与 /projects/manage 的 admin 列表同口径）。
            ids = [
                row.id
                for row in project_service.list_project_items(
                    db,
                    operator=normalized_operator,
                    is_admin=True,
                )
            ]
        else:
            ids = accessible
    else:
        try:
            ids = [int(x.strip()) for x in project_ids.split(",") if x.strip()]
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="project_ids must be comma-separated integers",
            )
        if not ids:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="at least one project_id is required",
            )

        for pid in ids:
            project_service.ensure_project_access(
                db,
                pid,
                operator=normalized_operator,
                is_admin=bool(is_admin),
            )

    # 可见项目集为空是合法状态（如 operator 名下无项目），照常走空聚合
    # 而不是 422 —— hook 拿到 200 才能正常显示 0 而非一直 --。
    # build_daily_analysis_all_projects 对空 project_ids 自然返回空响应。
    #
    # BLF-1038：命中路径直接返回缓存的响应字节（stale-while-revalidate）：
    # - 新鲜快照 → 字节直出（无 DB、无聚合、无 Pydantic/FastAPI 序列化）；
    # - 过期快照（超软新鲜期或数据已被写入 epoch 标记）→ 立即返回旧字节，
    #   并交 BackgroundTasks 异步刷新，请求不等重算；
    # - 无快照 → 单飞计算并回填（并发调用方等先到者，避免 N 份全量计算）。
    # 授权/可见集解析仍在缓存之前执行，缓存不短路权限校验。
    normalized_country = normalize_country(country)
    normalized_start = parse_yyyy_mm_dd(start_date, "start_date")
    normalized_end = parse_yyyy_mm_dd(end_date, "end_date")
    if normalized_start > normalized_end:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="start_date cannot be greater than end_date",
        )
    start_text = normalized_start.isoformat()
    end_text = normalized_end.isoformat()

    cache_key = redis_service.make_daily_analysis_all_cache_key(
        project_ids=ids,
        country=normalized_country,
        start_date=start_text,
        end_date=end_text,
        sku=sku,
        schema_fingerprint=ALL_PROJECTS_RESPONSE_SCHEMA_FINGERPRINT,
    )

    def _compute_body() -> bytes:
        return _build_all_projects_body(
            db,
            project_ids=ids,
            country=normalized_country,
            start_date=start_text,
            end_date=end_text,
            sku=sku,
        )

    body, needs_refresh = redis_service.load_or_compute_daily_analysis_all_body(
        cache_key, _compute_body
    )
    if needs_refresh and redis_service.try_acquire_daily_analysis_all_lock(cache_key):
        background_tasks.add_task(
            _refresh_all_projects_snapshot,
            cache_key=cache_key,
            project_ids=ids,
            country=normalized_country,
            start_date=start_text,
            end_date=end_text,
            sku=sku,
        )

    return Response(content=body, media_type="application/json")


@router.get(
    "/daily-analysis/all-countries", response_model=DailyAnalysisAllCountriesResponse
)
def get_daily_analysis_all_countries(
    project_id: int,
    start_date: Annotated[str, Query(min_length=10, max_length=10)],
    end_date: Annotated[str, Query(min_length=10, max_length=10)],
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
):
    """跨国家站点聚合单项目数据。

    当前对 US / DE / UK 三个国家分别加载数据并按 (date, sku) 求和；
    响应里 ``country_breakdown`` 字段给出按国家分桶的明细。
    """
    project_service.ensure_project_access(
        db,
        project_id,
        operator=operator,
        is_admin=bool(is_admin),
    )
    return build_daily_analysis_all_countries(
        db,
        project_id=project_id,
        start_date=start_date,
        end_date=end_date,
    )


@router.get(
    "/daily-analysis/all-projects-countries",
    response_model=DailyAnalysisAllProjectsCountriesResponse,
)
def get_daily_analysis_all_projects_countries(
    project_ids: Annotated[str, Query(description="comma-separated project IDs")],
    start_date: Annotated[str, Query(min_length=10, max_length=10)],
    end_date: Annotated[str, Query(min_length=10, max_length=10)],
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
):
    """全部项目 × 全部国家站点聚合（BLF-913，USD 基准）。

    对每个 (project, country) 组合装载 US/DE/UK metrics，金额字段按当月
    汇率折算成 USD 后合并；响应同时给出 ``project_breakdown``（项目跨
    国家合并）与 ``country_breakdown``（国家跨项目合并）。
    """
    try:
        ids = [int(x.strip()) for x in project_ids.split(",") if x.strip()]
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="project_ids must be comma-separated integers",
        )
    if not ids:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="at least one project_id is required",
        )

    normalized_operator = (operator or "").strip()
    for pid in ids:
        project_service.ensure_project_access(
            db,
            pid,
            operator=normalized_operator,
            is_admin=bool(is_admin),
        )

    return build_daily_analysis_all_projects_countries(
        db,
        project_ids=ids,
        start_date=start_date,
        end_date=end_date,
    )
