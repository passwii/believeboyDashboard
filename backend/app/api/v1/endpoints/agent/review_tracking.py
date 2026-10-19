"""Agent 评论追踪采集域路由（BLF-1378，阶段 D；设计稿 §8.3 / §8.5）。

在 ``/api/v1/agent/review-tracking/*`` 开放 2 条路由——采集端（Agent）的**唯一**
入口，把阶段 B 已完成的写入服务接上对外通道：

* R1 ``GET /targets`` —— 当前 active 采集目标 + 抓取规则常量。按凭据的
  ``project_scope`` 过滤内部目标；外部竞品目标（``project_id IS NULL``）
  跨项目可见（见下）。路径无 ``project_id`` → 范围过滤在 handler 内做，
  不挂 ``require_project_scope``。
* W1 ``POST /targets/{target_id}/runs`` —— 提交一次采集结果：``record_crawl_result``
  的薄封装（服务层零改造），幂等键 ``(target_id, idempotency_key)`` 唯一，
  重复提交返回首次 run。挂写限流 + 审计归因（agent_id / idempotency_key）。
  **不 confirm**——幂等 + 只增量写入，无金钱/不可逆状态（对齐 platform-inspection
  W1 保存草稿的先例）。

**提交顺序护栏（乱序提交 → 409）**：``captured_at`` 由调用方控制，而
``amazon_review_reviews`` / ``amazon_review_rating_snapshots`` 是**当前态表、无版本**——
服务层 ``_upsert_review`` 无条件覆盖当前行并回写 ``last_seen_at``，``_apply_missing``
也无条件在当前 ``missing_streak`` 上 +1。若允许任意顺序提交，补采一条更旧的结果会
把当前态评论正文 / ``last_seen_at`` **倒退**，并按陈旧数据再记一次「缺失」，直接
产出错误的「疑似移除」结论。因此本阶段在**路由层**加护栏（issue 要求不改服务层
签名 / 行为）：进入 ``record_crawl_result`` 前查该 target 的 ``max(started_at)``，
``body.captured_at`` 早于它 → 409 ``REVIEW_TRACKING_CAPTURE_OUT_OF_ORDER``。

* 同一业务日重跑天然是更晚的 ``captured_at``，不受影响；
* 幂等重放走既有 run 短路（先查幂等键，命中则不校验顺序），也不受响；
* 护栏是**尽力而为**：两个携带不同幂等键的并发请求可能同时通过检查
 （无数据库级约束，需真正串行化时得另加唯一索引 / advisory lock）。
  若产品确实需要允许补采，则必须先给当前态表加版本或改成「以 captured_at 为准
  的条件更新」，并在设计文档里写清影响，不能只去掉这道检查。

范围口径（重要，两处都显式写死并待产品确认）：

* **内部目标**（``kind=internal_group``，有 ``project_id``）——严格按 key 的
  ``project_scope``：读侧过滤掉不可见项目；写侧不在范围 → 403
  ``AGENT_PROJECT_OUT_OF_SCOPE``。
* **外部目标**（``kind=external_asin``，``project_id`` 为空）——**跨项目可见 /
  可写**：外部竞品 ASIN 是「评论追踪」的全局共享数据（同一
  ``marketplace + asin`` 全仓只保留一份追踪历史），不归属任何项目，因此不参与
  ``project_scope`` 过滤。这与阶段 B 运营读 API 的既有实现一致
  （``or_(kind == 'external_asin', project_id.in_(...))``），阶段 B 报告 §5.2
  已把「外部目标跨项目可见」列为待产品确认项，本阶段不改变行为，仅在契约里
  显式声明。若产品要求收紧，改为「按 active external link 的 shop 所属项目判定」
  即可（只需改 ``_target_visible`` / 列表 where 一处）。

「抓取规则」：库里没有该字段，本阶段**常量下发**（``crawl_rules``，
见 ``app/constants/amazon_review_crawl_rules.py``），不加列、不加表。
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.api.agent.errors import AgentApiError, ErrorCode
from app.api.agent.rate_limit import require_agent_write_rate_limit
from app.api.agent.response import agent_ok
from app.api.agent.scope import SCOPE_ALL, _parse_scope, require_project_scope
from app.api.deps import get_primary_db_session, get_read_db_session
from app.constants.amazon_review_crawl_rules import (
    CRAWL_RULES,
    MAX_IDEMPOTENCY_KEY_LENGTH,
)
from app.db.session import SessionLocal
from app.models.agent_api_key import AgentApiKey
from app.models.amazon_review_tracking import (
    AmazonReviewCrawlRun,
    AmazonReviewExternalLink,
    AmazonReviewTarget,
)
from app.schemas.amazon_review_tracking_agent import (
    AgentCrawlResultRequest,
    AgentRatingCapture,
    AgentReviewCapture,
)
from app.services.amazon_review_ingestion_service import (
    IngestionError,
    RatingCapture,
    ReviewCapture,
    business_date,
    record_crawl_result,
)
from app.services.audit_log_service import append_operation_audit_log

logger = logging.getLogger(__name__)

review_tracking_router = APIRouter(
    prefix="/review-tracking",
    tags=["agent-review-tracking"],
)

#: ``source`` 缺省值：区分 Agent 采集与运营手填（``raw_payload`` 之外的可追溯标记）。
DEFAULT_SOURCE = "agent_review_tracking"

#: ``kind`` 合法值（与 ``amazon_review_targets`` 的 CHECK 约束一致）。
_TARGET_KINDS = frozenset({"internal_group", "external_asin"})


# ============================================================
# 共享 helper
# ============================================================


def _key_project_scope(request: Request) -> set[int] | None:
    """凭据的项目范围：``None`` 表示 ``*``（全放行），否则是白名单集合。

    必须在 ``require_agent_credential`` 之后调用（它注入
    ``request.state.agent_api_key_id``）；查不到 key 行 → 401 fail closed
    （语义对齐 ``require_project_scope``）。
    """
    key_id = getattr(request.state, "agent_api_key_id", None)
    if key_id is None:
        raise AgentApiError(ErrorCode.AGENT_AUTH_FAILED, reason="token_invalid")
    db = SessionLocal()
    try:
        key = db.get(AgentApiKey, key_id)
        if key is None:
            raise AgentApiError(ErrorCode.AGENT_AUTH_FAILED, reason="token_invalid")
        scope = key.project_scope or SCOPE_ALL
    finally:
        db.close()
    if scope == SCOPE_ALL:
        return None
    return _parse_scope(scope)


def _audit_kwargs(request: Request, idempotency_key: str | None) -> dict[str, Any]:
    """写审计归因（operator=NULL；agent_id / agent_name / idempotency_key）。"""
    return {
        "agent_id": getattr(request.state, "agent_id", None),
        "agent_name": getattr(request.state, "agent_label", None),
        "idempotency_key": idempotency_key,
        "request": request,
    }


def _resolve_idempotency_key(
    request: Request, body: AgentCrawlResultRequest
) -> str | None:
    """幂等键：body 字段优先，缺省回退 ``Idempotency-Key`` 头。

    两者都给且不一致 → 400（否则会出现「body 用 A 去重、审计记 B」的歧义）。
    header 按既有 agent 写域口径校验非空且 ≤64 字符。
    """
    header = request.headers.get("idempotency-key")
    if header is not None:
        header = header.strip()
        if not header:
            raise AgentApiError(
                ErrorCode.VALIDATION_FAILED,
                human_message="Idempotency-Key 不能为空字符串",
            )
        if len(header) > MAX_IDEMPOTENCY_KEY_LENGTH:
            raise AgentApiError(
                ErrorCode.VALIDATION_FAILED,
                human_message=(
                    f"Idempotency-Key 长度不能超过 {MAX_IDEMPOTENCY_KEY_LENGTH} 字符"
                ),
            )
    body_key = (body.idempotency_key or "").strip() or None
    if header and body_key and header != body_key:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            human_message="请求体 idempotency_key 与 Idempotency-Key 头不一致",
            agent_hint="两处只保留一处，或传相同的值后重试",
        )
    return body_key or header or None


def _find_run(
    db: Session, target_id: int, idempotency_key: str | None
) -> AmazonReviewCrawlRun | None:
    """按幂等键查既有 run（仅用于如实告知 ``replayed``；去重本身由服务层保证）。"""
    if idempotency_key is None:
        return None
    return db.execute(
        select(AmazonReviewCrawlRun).where(
            AmazonReviewCrawlRun.target_id == target_id,
            AmazonReviewCrawlRun.idempotency_key == idempotency_key,
        )
    ).scalar_one_or_none()


def _to_rating(capture: AgentRatingCapture | None) -> RatingCapture | None:
    if capture is None:
        return None
    return RatingCapture(
        average_rating=capture.average_rating,
        rating_count=capture.rating_count,
        review_count=capture.review_count,
        star_percentages=(
            tuple(capture.star_percentages)
            if capture.star_percentages is not None
            else None
        ),
        star_counts=(
            tuple(capture.star_counts) if capture.star_counts is not None else None
        ),
        star_count_quality=capture.star_count_quality,
    )


def _to_reviews(
    captures: list[AgentReviewCapture] | None,
) -> list[ReviewCapture] | None:
    """``None`` / ``[]`` / ``[...]`` 三种语义原样传给服务层（不可合并）。"""
    if captures is None:
        return None
    return [
        ReviewCapture(
            review_key=item.review_key,
            id_confidence=item.id_confidence,
            rating=item.rating,
            title=item.title,
            body=item.body,
            reviewer_id=item.reviewer_id,
            reviewer_name=item.reviewer_name,
            review_date=item.review_date,
            verified_purchase=item.verified_purchase,
            helpful_count=item.helpful_count,
        )
        for item in captures
    ]


# ============================================================
# R1 GET /targets（读，不落操作审计）
# ============================================================


@review_tracking_router.get("/targets")
def list_targets(
    request: Request,
    marketplace: str | None = Query(default=None, max_length=2),
    kind: str | None = Query(default=None),
    project_id: int | None = Query(default=None, gt=0),
    limit: int = Query(default=200, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_read_db_session),
) -> dict:
    """R1 当前 active 采集目标 + 抓取规则常量。

    * 只返回 ``is_active=true`` 的目标（组停用 / 外部目标停用后不再采集）；
    * 内部目标按 key 的 ``project_scope`` 过滤；**外部目标跨项目可见**
      （``project_id`` 为空，见模块 docstring）；
    * ``?project_id=`` 不在凭据范围 → 403 ``AGENT_PROJECT_OUT_OF_SCOPE``
      （显式报错而不是静默返回空列表，便于 Agent 自纠配置）；
    * ``asin`` 对内部目标是**组代表 ASIN**、对外部目标是竞品 ASIN——形态一致，
      Agent 不需要分支解析；
    * ``last_run`` 是该目标最近一次 run（含 failed），供采集侧判断
      「今天是否已经跑过」，批量一次查询无 N+1。
    """
    if kind is not None and kind not in _TARGET_KINDS:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            human_message=f"kind 必须是 {sorted(_TARGET_KINDS)} 之一，收到 {kind!r}",
        )
    scoped_ids = _key_project_scope(request)
    if project_id is not None and scoped_ids is not None and project_id not in scoped_ids:
        raise AgentApiError(
            ErrorCode.AGENT_PROJECT_OUT_OF_SCOPE,
            reason="project_not_in_scope",
        )

    stmt = select(AmazonReviewTarget).where(AmazonReviewTarget.is_active.is_(True))
    if scoped_ids is not None:
        stmt = stmt.where(
            or_(
                AmazonReviewTarget.kind == "external_asin",
                AmazonReviewTarget.project_id.in_(scoped_ids),
            )
        )
    if project_id is not None:
        stmt = stmt.where(AmazonReviewTarget.project_id == project_id)
    if marketplace is not None:
        stmt = stmt.where(AmazonReviewTarget.marketplace == marketplace.strip().upper())
    if kind is not None:
        stmt = stmt.where(AmazonReviewTarget.kind == kind)

    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    targets = db.scalars(
        stmt.order_by(AmazonReviewTarget.id).limit(limit).offset(offset)
    ).all()

    target_ids = [int(target.id) for target in targets]
    external_shop_ids = _active_external_shop_ids(db, targets)
    last_runs = _last_runs(db, target_ids)

    return agent_ok(
        {
            "items": [
                {
                    "target_id": int(target.id),
                    "kind": target.kind,
                    "group_id": int(target.group_id) if target.group_id is not None else None,
                    "project_id": int(target.project_id) if target.project_id is not None else None,
                    "marketplace": target.marketplace,
                    "asin": target.asin,
                    "display_name": target.display_name,
                    "external_shop_ids": external_shop_ids.get(int(target.id), []),
                    "last_run": last_runs.get(int(target.id)),
                }
                for target in targets
            ],
            "total": int(total),
            "crawl_rules": CRAWL_RULES,
        }
    )


def _active_external_shop_ids(
    db: Session,
    targets: Sequence[AmazonReviewTarget],
) -> dict[int, list[int]]:
    """外部目标的 active 店铺关联（内部目标恒空，省一次查询）。"""
    external_ids = [int(t.id) for t in targets if t.kind == "external_asin"]
    if not external_ids:
        return {}
    rows = db.execute(
        select(
            AmazonReviewExternalLink.target_id, AmazonReviewExternalLink.shop_id
        )
        .where(
            AmazonReviewExternalLink.target_id.in_(external_ids),
            AmazonReviewExternalLink.is_active.is_(True),
        )
        .order_by(AmazonReviewExternalLink.shop_id)
    ).all()
    grouped: dict[int, list[int]] = {target_id: [] for target_id in external_ids}
    for target_id, shop_id in rows:
        grouped.setdefault(int(target_id), []).append(int(shop_id))
    return grouped


def _last_runs(db: Session, target_ids: list[int]) -> dict[int, dict[str, Any]]:
    """每个目标最近一次 run（按 ``started_at`` 倒序取首条，含 failed）。

    用 ``row_number()`` 在库内取每组首条，只把每个目标 1 行拉回 Python——
    目标范围内累计 run 会按「每日一次 × target 数 × 年数」增长（500 个 target
    跑一年即十几万行），不能全量拉回来去重。
    """
    if not target_ids:
        return {}
    ranked = (
        select(
            AmazonReviewCrawlRun.target_id.label("target_id"),
            AmazonReviewCrawlRun.id.label("run_id"),
            AmazonReviewCrawlRun.status.label("status"),
            AmazonReviewCrawlRun.started_at.label("started_at"),
            func.row_number()
            .over(
                partition_by=AmazonReviewCrawlRun.target_id,
                order_by=(
                    AmazonReviewCrawlRun.started_at.desc(),
                    AmazonReviewCrawlRun.id.desc(),
                ),
            )
            .label("rn"),
        )
        .where(AmazonReviewCrawlRun.target_id.in_(target_ids))
        .subquery()
    )
    rows = db.execute(
        select(
            ranked.c.target_id, ranked.c.run_id, ranked.c.status, ranked.c.started_at
        ).where(ranked.c.rn == 1)
    ).all()
    return {
        int(target_id): {
            "run_id": int(run_id),
            "status": status,
            "started_at": started_at.isoformat() if started_at else None,
        }
        for target_id, run_id, status, started_at in rows
    }


def _latest_started_at(db: Session, target_id: int) -> datetime | None:
    """该 target 已提交 run 中最大的 ``started_at``（无 run → ``None``）。

    ``started_at`` 落库时就等于调用方给的 ``captured_at``，所以它也就是「最近一次
    采集时间」，用于 W1 的乱序护栏。
    """
    return db.scalar(
        select(func.max(AmazonReviewCrawlRun.started_at)).where(
            AmazonReviewCrawlRun.target_id == target_id
        )
    )


# ============================================================
# W1 POST /targets/{target_id}/runs（写，不 confirm）
# ============================================================


@review_tracking_router.post(
    "/targets/{target_id}/runs",
    dependencies=[Depends(require_agent_write_rate_limit)],
)
def submit_crawl_result(
    request: Request,
    target_id: int,
    body: AgentCrawlResultRequest,
    db: Session = Depends(get_primary_db_session),
) -> dict:
    """W1 提交一次采集结果（``record_crawl_result`` 薄封装，服务层零改造）。

    * 目标不存在 / 已停用 → 404 ``RESOURCE_NOT_FOUND``（停用组不再采集，避免结果
      写到已退役的组上）；
    * 内部目标不在凭据 ``project_scope`` → 403 ``AGENT_PROJECT_OUT_OF_SCOPE``
      （与 404 **可区分**：403 表示目标存在但无权，404 表示不存在 / 已停用；
      这是有意的「可自纠」取舍，与其它写域一致）；
    * ``captured_at`` 早于该目标最近一次 run → 409
      ``REVIEW_TRACKING_CAPTURE_OUT_OF_ORDER``（乱序提交会覆盖当前态评论 / 误判
      疑似移除，见模块 docstring 的「提交顺序护栏」）；幂等重放不受此限；
    * 请求体语义校验失败（服务层 ``IngestionError``）→ 400 ``VALIDATION_FAILED``；
    * 同幂等键重复提交 → 返回首次 ``run_id`` 且 ``replayed=true``，不新增行、
      不写审计（重放不是写）；并发路径由服务层 savepoint + 重查保证唯一。
      ``capture_date`` 一律取**已持久化 run 的** ``started_at`` 推业务日，
      不用本次 payload 的 ``captured_at``（否则重放会把首次 run 的 status
      和重试 payload 的日期拼在一起，调用方会误以为那天有快照）。
    """
    idempotency_key = _resolve_idempotency_key(request, body)

    target = db.get(AmazonReviewTarget, target_id)
    if target is None or not target.is_active:
        raise AgentApiError(
            ErrorCode.RESOURCE_NOT_FOUND,
            human_message=f"目标 {target_id} 不存在或已停用",
        )
    if target.project_id is not None:
        # 内部目标：严格按凭据项目范围（403 语义与其它写域一致）。
        require_project_scope(int(target.project_id), request)

    existing = _find_run(db, target_id, idempotency_key)
    if existing is None:
        latest_started_at = _latest_started_at(db, target_id)
        if latest_started_at is not None and body.captured_at < latest_started_at:
            raise AgentApiError(
                ErrorCode.REVIEW_TRACKING_CAPTURE_OUT_OF_ORDER,
                reason="captured_at_before_latest_run",
                human_message=(
                    f"captured_at {body.captured_at.isoformat()} 早于该目标最近一次"
                    f"采集时间 {latest_started_at.isoformat()}"
                ),
                details={"latest_started_at": latest_started_at.isoformat()},
            )

    try:
        result = record_crawl_result(
            db,
            target_id=target_id,
            captured_at=body.captured_at,
            status=body.status,
            rating=_to_rating(body.rating),
            reviews=_to_reviews(body.reviews),
            is_complete_list=body.is_complete_list,
            idempotency_key=idempotency_key,
            asin_scraped=body.asin_scraped,
            source=body.source or DEFAULT_SOURCE,
            error_message=body.error_message,
        )
        replayed = existing is not None
        # 一律用已持久化 run 的 started_at 推业务日：重放（incl. 并发命中）时不能
        # 用本次 payload 的 captured_at，否则 run_id/status 与 capture_date 跨次拼接。
        run = db.get(AmazonReviewCrawlRun, result.run_id)
        capture_date = (
            business_date(run.started_at) if run is not None else result.capture_date
        )
        if not replayed:
            append_operation_audit_log(
                db,
                action="review_tracking.crawl_run",
                target_type="amazon_review_crawl_run",
                target_id=result.run_id,
                operator=None,
                after={
                    "target_id": target_id,
                    "kind": target.kind,
                    "status": body.status,
                    "capture_date": capture_date.isoformat(),
                    "is_complete_list": body.is_complete_list,
                    "reviews_seen": (
                        len(body.reviews) if body.reviews is not None else None
                    ),
                    "ratings_captured": body.rating is not None,
                    "asin_scraped": body.asin_scraped,
                },
                **_audit_kwargs(request, idempotency_key),
            )
        db.commit()
    except IngestionError as exc:
        db.rollback()
        message = str(exc)
        if "target not found" in message:
            raise AgentApiError(
                ErrorCode.RESOURCE_NOT_FOUND,
                human_message=f"目标 {target_id} 不存在",
            ) from None
        raise AgentApiError(ErrorCode.VALIDATION_FAILED, human_message=message) from None
    except Exception:
        db.rollback()
        logger.exception("review_tracking crawl run persistence failed")
        raise

    run = db.get(AmazonReviewCrawlRun, result.run_id)
    return agent_ok(
        {
            "target_id": result.target_id,
            "run_id": result.run_id,
            "status": run.status if run is not None else body.status,
            "capture_date": (
                business_date(run.started_at)
                if run is not None
                else result.capture_date
            ).isoformat(),
            "snapshot_updated": result.snapshot_updated,
            "reviews_upserted": result.reviews_upserted,
            "reviews_suspected_removed": result.reviews_suspected_removed,
            "replayed": replayed,
        },
        idempotency_key=idempotency_key,
    )
