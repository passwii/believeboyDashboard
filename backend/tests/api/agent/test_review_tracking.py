"""Agent 评论追踪采集域路由测试（BLF-1378，阶段 D）。

覆盖：

* R1 ``GET /api/v1/agent/review-tracking/targets``——只返回 active 目标、
  ``project_scope`` 过滤内部目标 + 外部目标跨项目可见、``?project_id=`` 越权 403、
  ``?marketplace=`` / ``?kind=`` 过滤与分页、``crawl_rules`` 常量、
  ``external_shop_ids`` 只含 active link、``last_run`` 取最近一次。
* W1 ``POST .../targets/{target_id}/runs``——成功落 run/snapshot/reviews、
  同幂等键重放不新增行、body 与 header 幂等键冲突 400、``failed`` 只落 run、
  两连缺失判疑似移除、形态校验 400、目标不存在/停用 404、项目越权 403、
  审计归因（agent_id / idempotency_key / operator=NULL）且重放不新增审计行。
* 鉴权/错误壳：未鉴权 401；缺业务域 403；``KNOWN_BUSINESS_DOMAINS`` 含
  ``review_tracking``。

数据隔离：每个测试自建 Project / SkuRecord / 评论共享组（连带 internal target），
结束后按 FK 顺序清理；外部目标按 (marketplace, asin) 全仓唯一，用随机 ASIN 隔离。
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select

from app.api.agent.scope import KNOWN_BUSINESS_DOMAINS
from app.constants.amazon_review_crawl_rules import CRAWL_RULES
from app.db.session import SessionLocal
from app.main import app
from app.models import Project, ProjectShop, SkuRecord
from app.models.agent_api_key import AgentApiKey  # noqa: F401  (make_api_key 自清理)
from app.models.amazon_review_tracking import (
    AmazonReviewCrawlRun,
    AmazonReviewExternalLink,
    AmazonReviewGroup,
    AmazonReviewGroupMember,
    AmazonReviewRatingSnapshot,
    AmazonReviewReview,
    AmazonReviewTarget,
)
from app.services.amazon_review_external_service import register_external_target
from app.services.amazon_review_ingestion_service import BUSINESS_TZ
from app.services.amazon_review_tracking_service import create_group
from app.services.audit_log_service import query_operation_audit_log

TARGETS_URL = "/api/v1/agent/review-tracking/targets"

pytestmark = pytest.mark.usefixtures("db_session")


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture(autouse=True)
def _reset_agent_rate_limit():
    from app.api.agent.rate_limit import agent_read_limiter, agent_write_limiter

    agent_read_limiter.reset()
    agent_write_limiter.reset()
    yield
    agent_read_limiter.reset()
    agent_write_limiter.reset()


@pytest.fixture
def rt_env():
    """隔离的采集环境：1 项目 + 1 SKU + 1 评论共享组（连带 internal target）。

    agent 鉴权/范围依赖会另开 SessionLocal，所以数据必须 **commit**（不能只
    flush）；清理见 fixture 尾部，按 FK 顺序删。
    """
    suffix = uuid.uuid4().hex[:8]
    db = SessionLocal()
    try:
        project = Project(
            project_name=f"rt-{suffix}",
            project_operator="pytest",
            sort_order=940100,
            is_active=True,
        )
        db.add(project)
        db.flush()
        sku = SkuRecord(
            project_id=project.id,
            project_name=project.project_name,
            sku=f"rt-sku-{suffix}",
            asin=f"B0{suffix.upper()}",
            country="US",
            fob_unit_cost=0,
            sort_order=940100,
            is_active=True,
        )
        db.add(sku)
        db.flush()
        group = create_group(
            db,
            project_id=project.id,
            marketplace="US",
            name=f"rt-group-{suffix}",
            member_ids=[sku.id],
            representative_id=sku.id,
        )
        db.flush()
        target = db.execute(
            select(AmazonReviewTarget).where(AmazonReviewTarget.group_id == group.id)
        ).scalar_one()
        db.commit()
        env = {
            "suffix": suffix,
            "project_id": int(project.id),
            "group_id": int(group.id),
            "target_id": int(target.id),
            "asin": target.asin,
        }
    finally:
        db.close()

    yield env

    db = SessionLocal()
    try:
        target_ids = list(
            db.scalars(
                select(AmazonReviewTarget.id).where(
                    (AmazonReviewTarget.project_id == env["project_id"])
                    | (AmazonReviewTarget.asin.like(f"B0{env['suffix'].upper()}%"))
                )
            ).all()
        )
        if target_ids:
            db.execute(
                delete(AmazonReviewRatingSnapshot).where(
                    AmazonReviewRatingSnapshot.target_id.in_(target_ids)
                )
            )
            db.execute(
                delete(AmazonReviewReview).where(
                    AmazonReviewReview.target_id.in_(target_ids)
                )
            )
            db.execute(
                delete(AmazonReviewCrawlRun).where(
                    AmazonReviewCrawlRun.target_id.in_(target_ids)
                )
            )
            db.execute(
                delete(AmazonReviewExternalLink).where(
                    AmazonReviewExternalLink.target_id.in_(target_ids)
                )
            )
            db.execute(
                delete(AmazonReviewTarget).where(AmazonReviewTarget.id.in_(target_ids))
            )
        db.execute(
            delete(AmazonReviewGroupMember).where(
                AmazonReviewGroupMember.group_id == env["group_id"]
            )
        )
        db.execute(
            delete(AmazonReviewGroup).where(AmazonReviewGroup.id == env["group_id"])
        )
        db.execute(delete(SkuRecord).where(SkuRecord.project_id == env["project_id"]))
        db.execute(delete(ProjectShop).where(ProjectShop.project_id == env["project_id"]))
        db.execute(delete(Project).where(Project.id == env["project_id"]))
        db.commit()
    finally:
        db.close()


@pytest.fixture
def external_target(rt_env):
    """外部竞品目标（跨项目可见），带一条 active shop 关联。"""
    suffix = uuid.uuid4().hex[:8]
    db = SessionLocal()
    try:
        shop = ProjectShop(
            project_id=rt_env["project_id"],
            country="US",
            shop_id=f"rt-shop-{suffix}",
            shop_name=f"rt-shop-{suffix}",
        )
        db.add(shop)
        db.flush()
        target = register_external_target(
            db,
            marketplace="US",
            asin=f"B0{suffix.upper()}",
            shop_id=shop.id,
            display_name=f"competitor-{suffix}",
        )
        db.commit()
        env = {
            "target_id": int(target.id),
            "asin": target.asin,
            "shop_id": int(shop.id),
        }
    finally:
        db.close()

    yield env

    db = SessionLocal()
    try:
        db.execute(
            delete(AmazonReviewRatingSnapshot).where(
                AmazonReviewRatingSnapshot.target_id == env["target_id"]
            )
        )
        db.execute(
            delete(AmazonReviewReview).where(
                AmazonReviewReview.target_id == env["target_id"]
            )
        )
        db.execute(
            delete(AmazonReviewCrawlRun).where(
                AmazonReviewCrawlRun.target_id == env["target_id"]
            )
        )
        db.execute(
            delete(AmazonReviewExternalLink).where(
                AmazonReviewExternalLink.target_id == env["target_id"]
            )
        )
        db.execute(
            delete(AmazonReviewTarget).where(AmazonReviewTarget.id == env["target_id"])
        )
        db.commit()
    finally:
        db.close()


def _make_headers(
    make_api_key,
    *,
    agent_id: str | None = None,
    business_scope: str = "review_tracking",
    project_scope: str = "*",
) -> tuple[str, dict]:
    agent_id = agent_id or f"rt-{uuid.uuid4().hex[:8]}"
    key = make_api_key(
        agent_id=agent_id,
        business_scope=business_scope,
        project_scope=project_scope,
    )
    return agent_id, {
        "Authorization": f"Bearer {key['plaintext']}",
        "X-Agent-Id": agent_id,
    }


def _captured_at(*, minutes_ago: float = 0) -> str:
    """相对当前时刻的**过去**时间（ISO 8601，tz-aware）。

    与 ``captured_at`` 相关的用例一律用它，不写硬编码绝对时间：绝对时间今天可能是
    “几小时后”（撞 ``captured_at`` 的未来上限），明天就变成过去——用例必须与墙钟无关。
    """
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).isoformat()


def _future_captured_at(*, hours: float) -> str:
    """相对当前时刻的未来时间（用于验证未来上限）。"""
    return (datetime.now(timezone.utc) + timedelta(hours=hours)).isoformat()


def _business_date_iso(iso_captured_at: str) -> str:
    """按业务时区（Asia/Shanghai）推 ISO 日期，与 ``business_date()`` 同口径。"""
    parsed = datetime.fromisoformat(iso_captured_at)
    return parsed.astimezone(BUSINESS_TZ).date().isoformat()


def _run_body(**overrides) -> dict:
    body = {
        "captured_at": "2026-10-19T09:30:00+08:00",
        "status": "success",
        "rating": {
            "average_rating": 4.3,
            "rating_count": 128,
            "review_count": 96,
            "star_percentages": [7.0, 3.0, 6.0, 20.0, 64.0],
            "star_count_quality": "estimated",
        },
        "reviews": [
            {
                "review_key": "R1F90C6R6GV8L6",
                "id_confidence": "original",
                "rating": 5,
                "title": "好用",
                "body": "……",
                "review_date": "2026-10-10",
                "verified_purchase": True,
                "helpful_count": 3,
            }
        ],
        "is_complete_list": True,
    }
    body.update(overrides)
    return body


def _runs_url(target_id: int) -> str:
    return f"{TARGETS_URL}/{target_id}/runs"


def _count_rows(db, model, **where) -> int:
    stmt = select(model)
    for key, value in where.items():
        stmt = stmt.where(getattr(model, key) == value)
    return len(db.scalars(stmt).all())


# ============================================================
# 鉴权 / 域门禁
# ============================================================


class TestAuthShell:
    def test_no_credentials_401_shell(self, client):
        resp = client.get(TARGETS_URL)
        assert resp.status_code == 401, resp.text
        body = resp.json()
        assert body["ok"] is False
        assert body["error"]["code"] == "AGENT_AUTH_FAILED"

    def test_missing_business_scope_403(self, client, make_api_key, rt_env):
        _agent_id, headers = _make_headers(make_api_key, business_scope="shipments")
        resp = client.get(TARGETS_URL, headers=headers)
        assert resp.status_code == 403, resp.text
        assert resp.json()["error"]["code"] == "AGENT_BUSINESS_OUT_OF_SCOPE"

    def test_unknown_path_falls_back_to_404(self, client, make_api_key):
        """新路由必须注册在兜底路由之前，否则被静默吞成 404 壳。"""
        _agent_id, headers = _make_headers(make_api_key)
        resp = client.get(
            "/api/v1/agent/review-tracking/not-a-route", headers=headers
        )
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"

    def test_known_business_domains_contains_domain(self):
        assert "review_tracking" in KNOWN_BUSINESS_DOMAINS


# ============================================================
# R1 GET /targets
# ============================================================


class TestListTargets:
    def _items(self, client, headers, **params) -> dict:
        # ``BLF_test`` 是持久库，历史目标会持续累积（可超过单页上限 500）；
        # 要稳定命中本测试新建的目标，查询时带 ``project_id`` 把范围收到本测试项目。
        resp = client.get(TARGETS_URL, params={"limit": 500, **params}, headers=headers)
        assert resp.status_code == 200, resp.text
        return resp.json()["data"]

    def test_returns_active_target_with_representative_asin(
        self, client, make_api_key, rt_env
    ):
        _agent_id, headers = _make_headers(make_api_key)
        data = self._items(client, headers, project_id=rt_env["project_id"])
        assert data["crawl_rules"] == CRAWL_RULES
        assert data["crawl_rules"]["business_timezone"] == "Asia/Shanghai"
        item = next(
            i for i in data["items"] if i["target_id"] == rt_env["target_id"]
        )
        assert item["kind"] == "internal_group"
        assert item["group_id"] == rt_env["group_id"]
        assert item["project_id"] == rt_env["project_id"]
        assert item["marketplace"] == "US"
        # 内部目标的 asin = 组代表 ASIN（与外部目标同形态，Agent 不用分支）
        assert item["asin"] == rt_env["asin"]
        assert item["external_shop_ids"] == []
        assert item["last_run"] is None

    def test_inactive_target_excluded(self, client, make_api_key, rt_env):
        db = SessionLocal()
        try:
            target = db.get(AmazonReviewTarget, rt_env["target_id"])
            assert target is not None
            target.is_active = False
            db.commit()
        finally:
            db.close()
        _agent_id, headers = _make_headers(make_api_key)
        data = self._items(client, headers)
        assert all(i["target_id"] != rt_env["target_id"] for i in data["items"])

    def test_project_scope_filters_internal_but_keeps_external(
        self, client, make_api_key, rt_env, external_target
    ):
        # 白名单指向另一个项目 → 本项目内部目标不可见；外部目标仍可见（跨项目口径）
        other_project = f"{rt_env['project_id'] + 900000}"
        _agent_id, headers = _make_headers(make_api_key, project_scope=other_project)
        data = self._items(client, headers)
        ids = {i["target_id"] for i in data["items"]}
        assert rt_env["target_id"] not in ids
        external = next(
            i for i in data["items"] if i["target_id"] == external_target["target_id"]
        )
        assert external["kind"] == "external_asin"
        assert external["project_id"] is None
        assert external["external_shop_ids"] == [external_target["shop_id"]]

    def test_project_id_query_out_of_scope_403(self, client, make_api_key, rt_env):
        _agent_id, headers = _make_headers(
            make_api_key, project_scope=str(rt_env["project_id"] + 900000)
        )
        resp = client.get(
            TARGETS_URL, params={"project_id": rt_env["project_id"]}, headers=headers
        )
        assert resp.status_code == 403, resp.text
        assert resp.json()["error"]["code"] == "AGENT_PROJECT_OUT_OF_SCOPE"

    def test_marketplace_and_kind_filters(self, client, make_api_key, rt_env):
        _agent_id, headers = _make_headers(make_api_key)
        data = self._items(
            client, headers, kind="internal_group", marketplace="US"
        )
        items = data["items"]
        assert all(i["kind"] == "internal_group" for i in items)
        assert all(i["marketplace"] == "US" for i in items)
        assert rt_env["target_id"] in {i["target_id"] for i in items}

    def test_invalid_kind_400(self, client, make_api_key, rt_env):
        _agent_id, headers = _make_headers(make_api_key)
        resp = client.get(TARGETS_URL, params={"kind": "nope"}, headers=headers)
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "VALIDATION_FAILED"

    def test_pagination_and_total(self, client, make_api_key, rt_env):
        _agent_id, headers = _make_headers(make_api_key)
        resp = client.get(
            TARGETS_URL,
            params={"project_id": rt_env["project_id"], "limit": 1, "offset": 0},
            headers=headers,
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["total"] == 1
        assert len(data["items"]) == 1

    def test_last_run_is_latest(self, client, make_api_key, rt_env):
        _agent_id, headers = _make_headers(make_api_key)
        first = client.post(
            _runs_url(rt_env["target_id"]),
            json=_run_body(captured_at="2026-10-18T09:30:00+08:00"),
            headers=headers,
        )
        assert first.status_code == 200, first.text
        second = client.post(
            _runs_url(rt_env["target_id"]),
            json=_run_body(captured_at="2026-10-19T09:30:00+08:00"),
            headers=headers,
        )
        assert second.status_code == 200, second.text

        item = next(
            i
            for i in self._items(
                client, headers, project_id=rt_env["project_id"]
            )["items"]
            if i["target_id"] == rt_env["target_id"]
        )
        assert item["last_run"]["run_id"] == second.json()["data"]["run_id"]
        assert item["last_run"]["status"] == "success"
        assert item["last_run"]["started_at"].startswith("2026-10-19")


# ============================================================
# W1 POST /targets/{target_id}/runs
# ============================================================


class TestSubmitCrawlResult:
    def test_success_writes_run_snapshot_reviews(self, client, make_api_key, rt_env):
        agent_id, headers = _make_headers(make_api_key)
        resp = client.post(
            _runs_url(rt_env["target_id"]),
            json=_run_body(idempotency_key="run-1"),
            headers=headers,
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["target_id"] == rt_env["target_id"]
        assert data["run_id"] > 0
        assert data["status"] == "success"
        assert data["capture_date"] == "2026-10-19"  # Asia/Shanghai 业务日
        assert data["snapshot_updated"] is True
        assert data["reviews_upserted"] == 1
        assert data["reviews_suspected_removed"] == 0
        assert data["replayed"] is False

        db = SessionLocal()
        try:
            run = db.get(AmazonReviewCrawlRun, data["run_id"])
            assert run is not None
            assert run.status == "success"
            # source 缺省值用于区分 Agent 采集渠道
            assert run.ratings_captured is True
            assert run.reviews_seen == 1
            snapshot = db.execute(
                select(AmazonReviewRatingSnapshot).where(
                    AmazonReviewRatingSnapshot.target_id == rt_env["target_id"]
                )
            ).scalar_one()
            assert snapshot.capture_date.isoformat() == "2026-10-19"
            assert snapshot.star_count_quality == "estimated"
            assert snapshot.average_rating is not None
            assert float(snapshot.average_rating) == 4.3
            review = db.execute(
                select(AmazonReviewReview).where(
                    AmazonReviewReview.target_id == rt_env["target_id"]
                )
            ).scalar_one()
            assert review.review_key == "R1F90C6R6GV8L6"
            assert review.visibility_status == "visible"
            assert review.id_confidence == "original"

            logs = query_operation_audit_log(
                db,
                target_type="amazon_review_crawl_run",
                target_id=str(data["run_id"]),
            )
            assert logs, "写操作必须落审计行"
            log = logs[0]
            assert log.action == "review_tracking.crawl_run"
            assert log.agent_id == agent_id
            assert log.idempotency_key == "run-1"
            assert log.operator is None
            after = log.after_json or {}
            assert isinstance(after, dict), "审计 after_json 必须是对象"
            assert after["target_id"] == rt_env["target_id"]
            assert after["capture_date"] == "2026-10-19"
        finally:
            db.close()

    def test_replay_same_idempotency_key_is_noop(self, client, make_api_key, rt_env):
        _agent_id, headers = _make_headers(make_api_key)
        body = _run_body(idempotency_key="run-dup")
        first = client.post(_runs_url(rt_env["target_id"]), json=body, headers=headers)
        second = client.post(_runs_url(rt_env["target_id"]), json=body, headers=headers)
        assert first.status_code == 200, first.text
        assert second.status_code == 200, second.text
        assert first.json()["data"]["run_id"] == second.json()["data"]["run_id"]
        assert first.json()["data"]["replayed"] is False
        assert second.json()["data"]["replayed"] is True
        assert second.json()["data"]["snapshot_updated"] is False
        assert second.json()["data"]["reviews_upserted"] == 0

        db = SessionLocal()
        try:
            assert (
                _count_rows(
                    db, AmazonReviewCrawlRun, target_id=rt_env["target_id"]
                )
                == 1
            )
            # 重放不写审计（重放不是写）
            logs = query_operation_audit_log(
                db,
                target_type="amazon_review_crawl_run",
                target_id=str(first.json()["data"]["run_id"]),
            )
            assert len(logs) == 1
        finally:
            db.close()

    def test_header_idempotency_key_used_when_body_absent(
        self, client, make_api_key, rt_env
    ):
        _agent_id, headers = _make_headers(make_api_key)
        headers = {**headers, "Idempotency-Key": "header-key"}
        body = _run_body()
        first = client.post(_runs_url(rt_env["target_id"]), json=body, headers=headers)
        second = client.post(_runs_url(rt_env["target_id"]), json=body, headers=headers)
        assert first.status_code == 200, first.text
        assert second.status_code == 200, second.text
        assert first.json()["data"]["run_id"] == second.json()["data"]["run_id"]
        assert second.json()["data"]["replayed"] is True

    def test_body_and_header_idempotency_conflict_400(
        self, client, make_api_key, rt_env
    ):
        _agent_id, headers = _make_headers(make_api_key)
        headers = {**headers, "Idempotency-Key": "header-key"}
        resp = client.post(
            _runs_url(rt_env["target_id"]),
            json=_run_body(idempotency_key="body-key"),
            headers=headers,
        )
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "VALIDATION_FAILED"

    def test_failed_status_only_writes_run(self, client, make_api_key, rt_env):
        _agent_id, headers = _make_headers(make_api_key)
        body = _run_body(
            status="failed",
            error_message="页面 503",
            idempotency_key="run-failed",
        )
        resp = client.post(_runs_url(rt_env["target_id"]), json=body, headers=headers)
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["snapshot_updated"] is False
        assert data["reviews_upserted"] == 0

        db = SessionLocal()
        try:
            assert (
                _count_rows(db, AmazonReviewCrawlRun, target_id=rt_env["target_id"])
                == 1
            )
            assert (
                _count_rows(
                    db, AmazonReviewRatingSnapshot, target_id=rt_env["target_id"]
                )
                == 0
            )
            assert (
                _count_rows(db, AmazonReviewReview, target_id=rt_env["target_id"]) == 0
            )
            run = db.get(AmazonReviewCrawlRun, data["run_id"])
            assert run is not None
            assert run.status == "failed"
            assert run.error_message == "页面 503"
        finally:
            db.close()

    def test_two_consecutive_complete_misses_mark_suspected_removed(
        self, client, make_api_key, rt_env
    ):
        agent_id, headers = _make_headers(make_api_key)
        first = client.post(
            _runs_url(rt_env["target_id"]),
            json=_run_body(captured_at="2026-10-17T09:30:00+08:00"),
            headers=headers,
        )
        assert first.status_code == 200, first.text

        # 第 1 次完整列表未见该评论 → missing_streak=1，仍 visible
        miss1 = client.post(
            _runs_url(rt_env["target_id"]),
            json=_run_body(
                captured_at="2026-10-18T09:30:00+08:00", reviews=[]
            ),
            headers=headers,
        )
        assert miss1.status_code == 200, miss1.text
        assert miss1.json()["data"]["reviews_suspected_removed"] == 0

        # 第 2 次 → missing_streak=2，疑似移除
        miss2 = client.post(
            _runs_url(rt_env["target_id"]),
            json=_run_body(
                captured_at="2026-10-19T09:30:00+08:00", reviews=[]
            ),
            headers=headers,
        )
        assert miss2.status_code == 200, miss2.text
        assert miss2.json()["data"]["reviews_suspected_removed"] == 1

        db = SessionLocal()
        try:
            review = db.execute(
                select(AmazonReviewReview).where(
                    AmazonReviewReview.target_id == rt_env["target_id"]
                )
            ).scalar_one()
            assert review.visibility_status == "suspected_removed"
            assert review.missing_streak == 2
            assert review.first_seen_at <= review.last_seen_at
            assert agent_id  # 归因无异常即可
        finally:
            db.close()

    def test_target_not_found_404(self, client, make_api_key, rt_env):
        _agent_id, headers = _make_headers(make_api_key)
        resp = client.post(
            _runs_url(rt_env["target_id"] + 9000000),
            json=_run_body(),
            headers=headers,
        )
        assert resp.status_code == 404, resp.text
        assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"

    def test_inactive_target_404(self, client, make_api_key, rt_env):
        db = SessionLocal()
        try:
            target = db.get(AmazonReviewTarget, rt_env["target_id"])
            assert target is not None
            target.is_active = False
            db.commit()
        finally:
            db.close()
        _agent_id, headers = _make_headers(make_api_key)
        resp = client.post(
            _runs_url(rt_env["target_id"]), json=_run_body(), headers=headers
        )
        assert resp.status_code == 404, resp.text
        assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"

    def test_project_out_of_scope_403(self, client, make_api_key, rt_env):
        _agent_id, headers = _make_headers(
            make_api_key, project_scope=str(rt_env["project_id"] + 900000)
        )
        resp = client.post(
            _runs_url(rt_env["target_id"]), json=_run_body(), headers=headers
        )
        assert resp.status_code == 403, resp.text
        assert resp.json()["error"]["code"] == "AGENT_PROJECT_OUT_OF_SCOPE"

    def test_external_target_writable_cross_project(
        self, client, make_api_key, external_target
    ):
        _agent_id, headers = _make_headers(make_api_key, project_scope="999999")
        resp = client.post(
            _runs_url(external_target["target_id"]),
            json=_run_body(asin_scraped=external_target["asin"]),
            headers=headers,
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["data"]["snapshot_updated"] is True

    @pytest.mark.parametrize(
        ("overrides", "expected_code"),
        [
            # naive captured_at（服务层也会挡，schema 层先给字段级错误）
            ({"captured_at": "2026-10-19T09:30:00"}, "VALIDATION_FAILED"),
            # star_percentages 长度必须 5
            ({"rating": {"star_percentages": [1.0, 2.0, 3.0, 4.0]}}, "VALIDATION_FAILED"),
            # 星级超范围
            ({"reviews": [{"review_key": "R1", "id_confidence": "original", "rating": 6}]}, "VALIDATION_FAILED"),
            # status 非法
            ({"status": "部分成功"}, "VALIDATION_FAILED"),
            # 均分超范围
            ({"rating": {"average_rating": 5.5}}, "VALIDATION_FAILED"),
            # 未知字段（extra=forbid，防拼错字段静默丢失）
            ({"review": []}, "VALIDATION_FAILED"),
        ],
    )
    def test_shape_validation_400(
        self, client, make_api_key, rt_env, overrides, expected_code
    ):
        _agent_id, headers = _make_headers(make_api_key)
        resp = client.post(
            _runs_url(rt_env["target_id"]), json=_run_body(**overrides), headers=headers
        )
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == expected_code

    def test_empty_header_idempotency_key_400(self, client, make_api_key, rt_env):
        _agent_id, headers = _make_headers(make_api_key)
        headers = {**headers, "Idempotency-Key": "  "}
        resp = client.post(
            _runs_url(rt_env["target_id"]), json=_run_body(), headers=headers
        )
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "VALIDATION_FAILED"

    # ------------------------------------------------------------
    # 复审修复（BLF-1378 复审 3 条必须修复项）
    # ------------------------------------------------------------

    def test_out_of_order_capture_409_does_not_roll_back_current_state(
        self, client, make_api_key, rt_env
    ):
        """较新的结果先落库后，补采更旧的 → 409，当前态正文 / last_seen_at 不倒退。"""
        _agent_id, headers = _make_headers(make_api_key)
        newest = _run_body(
            captured_at="2026-10-19T09:30:00+08:00",
            reviews=[
                {
                    "review_key": "R1",
                    "id_confidence": "original",
                    "rating": 5,
                    "body": "新内容",
                }
            ],
        )
        first = client.post(_runs_url(rt_env["target_id"]), json=newest, headers=headers)
        assert first.status_code == 200, first.text

        stale = _run_body(
            captured_at="2026-10-01T09:30:00+08:00",
            reviews=[
                {
                    "review_key": "R1",
                    "id_confidence": "original",
                    "rating": 5,
                    "body": "旧内容",
                }
            ],
        )
        resp = client.post(_runs_url(rt_env["target_id"]), json=stale, headers=headers)
        assert resp.status_code == 409, resp.text
        error = resp.json()["error"]
        assert error["code"] == "REVIEW_TRACKING_CAPTURE_OUT_OF_ORDER"
        assert error["details"]["latest_started_at"].startswith("2026-10-19")

        db = SessionLocal()
        try:
            review = db.execute(
                select(AmazonReviewReview).where(
                    AmazonReviewReview.target_id == rt_env["target_id"]
                )
            ).scalar_one()
            # 当前态没有被旧数据覆盖
            assert review.body == "新内容"
            assert review.last_seen_at.isoformat().startswith("2026-10-19")
            # 被拒的提交不落 run
            assert (
                _count_rows(db, AmazonReviewCrawlRun, target_id=rt_env["target_id"]) == 1
            )
        finally:
            db.close()

    def test_out_of_order_complete_list_does_not_advance_missing_streak(
        self, client, make_api_key, rt_env
    ):
        """陈旧完整列表缺 R1 → 409，missing_streak 不 +1、不产出疑似移除。"""
        _agent_id, headers = _make_headers(make_api_key)
        seen = client.post(
            _runs_url(rt_env["target_id"]),
            json=_run_body(captured_at="2026-10-17T09:30:00+08:00"),
            headers=headers,
        )
        assert seen.status_code == 200, seen.text
        miss = client.post(
            _runs_url(rt_env["target_id"]),
            json=_run_body(captured_at="2026-10-18T09:30:00+08:00", reviews=[]),
            headers=headers,
        )
        assert miss.status_code == 200, miss.text

        stale_miss = client.post(
            _runs_url(rt_env["target_id"]),
            json=_run_body(captured_at="2026-09-01T09:30:00+08:00", reviews=[]),
            headers=headers,
        )
        assert stale_miss.status_code == 409, stale_miss.text
        assert (
            stale_miss.json()["error"]["code"]
            == "REVIEW_TRACKING_CAPTURE_OUT_OF_ORDER"
        )

        db = SessionLocal()
        try:
            review = db.execute(
                select(AmazonReviewReview).where(
                    AmazonReviewReview.target_id == rt_env["target_id"]
                )
            ).scalar_one()
            assert review.missing_streak == 1
            assert review.visibility_status == "visible"
        finally:
            db.close()

    def test_same_day_later_rerun_allowed(self, client, make_api_key, rt_env):
        """同日更晚的 captured_at（重跑）不受顺序护栏限制。"""
        _agent_id, headers = _make_headers(make_api_key)
        earlier = _captured_at(minutes_ago=120)
        later = _captured_at(minutes_ago=30)
        first = client.post(
            _runs_url(rt_env["target_id"]),
            json=_run_body(captured_at=earlier),
            headers=headers,
        )
        second = client.post(
            _runs_url(rt_env["target_id"]),
            json=_run_body(captured_at=later),
            headers=headers,
        )
        assert first.status_code == 200, first.text
        assert second.status_code == 200, second.text
        # 同日重跑确实更新了当天快照（不是空过）
        assert second.json()["data"]["snapshot_updated"] is True

    def test_replay_skips_order_guard(self, client, make_api_key, rt_env):
        """幂等重放即使 captured_at 更早也照常返回首次 run（重放不是写）。"""
        _agent_id, headers = _make_headers(make_api_key)
        old_captured_at = _captured_at(minutes_ago=90)
        body = _run_body(captured_at=old_captured_at, idempotency_key="replay-old")
        first = client.post(_runs_url(rt_env["target_id"]), json=body, headers=headers)
        assert first.status_code == 200, first.text
        newer = client.post(
            _runs_url(rt_env["target_id"]),
            json=_run_body(captured_at=_captured_at(minutes_ago=30)),
            headers=headers,
        )
        assert newer.status_code == 200, newer.text

        replay = client.post(_runs_url(rt_env["target_id"]), json=body, headers=headers)
        assert replay.status_code == 200, replay.text
        data = replay.json()["data"]
        assert data["replayed"] is True
        assert data["run_id"] == first.json()["data"]["run_id"]
        # 重放返回首次 run 的业务日，不是更晚那次
        assert data["capture_date"] == _business_date_iso(old_captured_at)

    def test_replay_returns_capture_date_of_first_run(
        self, client, make_api_key, rt_env
    ):
        """重试 payload 换了 captured_at，响应日期仍取已持久化 run 的 started_at。"""
        _agent_id, headers = _make_headers(make_api_key)
        first_captured_at = _captured_at(minutes_ago=120)
        first = client.post(
            _runs_url(rt_env["target_id"]),
            json=_run_body(captured_at=first_captured_at, idempotency_key="k-1"),
            headers=headers,
        )
        assert first.status_code == 200, first.text
        first_date = _business_date_iso(first_captured_at)
        assert first.json()["data"]["capture_date"] == first_date

        retry = client.post(
            _runs_url(rt_env["target_id"]),
            json=_run_body(
                captured_at=_captured_at(minutes_ago=20), idempotency_key="k-1"
            ),
            headers=headers,
        )
        assert retry.status_code == 200, retry.text
        data = retry.json()["data"]
        assert data["replayed"] is True
        assert data["run_id"] == first.json()["data"]["run_id"]
        assert data["capture_date"] == first_date

    def test_blank_body_idempotency_key_400(self, client, make_api_key, rt_env):
        """body 里全空白的幂等键必须 400，不能静默降级成 None（假幂等）。"""
        _agent_id, headers = _make_headers(make_api_key)
        for _ in range(2):
            resp = client.post(
                _runs_url(rt_env["target_id"]),
                json=_run_body(idempotency_key="   "),
                headers=headers,
            )
            assert resp.status_code == 400, resp.text
            assert resp.json()["error"]["code"] == "VALIDATION_FAILED"

        db = SessionLocal()
        try:
            assert (
                _count_rows(db, AmazonReviewCrawlRun, target_id=rt_env["target_id"]) == 0
            )
        finally:
            db.close()

    def test_audit_reviews_seen_null_vs_zero(self, client, make_api_key, rt_env):
        """审计 reviews_seen：未抓评论 → null，抓到空列表 → 0（类型一致）。"""
        _agent_id, headers = _make_headers(make_api_key)
        no_reviews = client.post(
            _runs_url(rt_env["target_id"]),
            json=_run_body(
                captured_at="2026-10-18T09:30:00+08:00",
                reviews=None,
                is_complete_list=False,
            ),
            headers=headers,
        )
        assert no_reviews.status_code == 200, no_reviews.text
        empty_list = client.post(
            _runs_url(rt_env["target_id"]),
            json=_run_body(captured_at="2026-10-19T09:30:00+08:00", reviews=[]),
            headers=headers,
        )
        assert empty_list.status_code == 200, empty_list.text

        db = SessionLocal()
        try:
            null_log = query_operation_audit_log(
                db,
                target_type="amazon_review_crawl_run",
                target_id=str(no_reviews.json()["data"]["run_id"]),
            )
            zero_log = query_operation_audit_log(
                db,
                target_type="amazon_review_crawl_run",
                target_id=str(empty_list.json()["data"]["run_id"]),
            )
            assert (null_log[0].after_json or {})["reviews_seen"] is None
            assert (zero_log[0].after_json or {})["reviews_seen"] == 0
        finally:
            db.close()

    # 第二轮复审（BLF-1378 第 2 次 @-back）：护栏不得造成永久锁死
    # ------------------------------------------------------------

    def test_failed_run_does_not_raise_watermark(self, client, make_api_key, rt_env):
        """``failed`` 不写当前态 → 不抬高水位，之后更早的成功提交照常 200。

        真实的采集器路径：09:31 首次尝试失败，重试成功但按**计划采集时刻**
        09:30 上报。若水位把 failed 算进去，这条路径会被 409 永久挡住。
        """
        _agent_id, headers = _make_headers(make_api_key)
        failed = client.post(
            _runs_url(rt_env["target_id"]),
            json=_run_body(
                captured_at=_captured_at(minutes_ago=60),
                status="failed",
                rating=None,
                reviews=None,
                is_complete_list=False,
                error_message="页面 503",
            ),
            headers=headers,
        )
        assert failed.status_code == 200, failed.text

        # 重试成功，按更早的计划采集时刻上报 → 必须放行
        retry = client.post(
            _runs_url(rt_env["target_id"]),
            json=_run_body(captured_at=_captured_at(minutes_ago=90)),
            headers=headers,
        )
        assert retry.status_code == 200, retry.text
        assert retry.json()["data"]["status"] == "success"
        assert retry.json()["data"]["snapshot_updated"] is True

        db = SessionLocal()
        try:
            # 两次 run 都落库（failed 只落 run，不写快照 / 评论）
            assert (
                _count_rows(db, AmazonReviewCrawlRun, target_id=rt_env["target_id"])
                == 2
            )
            review = db.execute(
                select(AmazonReviewReview).where(
                    AmazonReviewReview.target_id == rt_env["target_id"]
                )
            ).scalar_one()
            assert review.visibility_status == "visible"
        finally:
            db.close()

    def test_failed_run_in_future_does_not_lock_target(
        self, client, make_api_key, rt_env
    ):
        """未来时间的 ``failed`` 既被上限拒掉，也不会（即使落库）抬高水位。"""
        _agent_id, headers = _make_headers(make_api_key)
        rejected = client.post(
            _runs_url(rt_env["target_id"]),
            json=_run_body(
                captured_at=_future_captured_at(hours=72),
                status="failed",
                rating=None,
                reviews=None,
                is_complete_list=False,
                error_message="页面 503",
            ),
            headers=headers,
        )
        assert rejected.status_code == 400, rejected.text
        assert rejected.json()["error"]["reason"] == "captured_at_in_future"

        db = SessionLocal()
        try:
            assert (
                _count_rows(db, AmazonReviewCrawlRun, target_id=rt_env["target_id"])
                == 0
            )
        finally:
            db.close()

    def test_future_captured_at_rejected_without_writes(
        self, client, make_api_key, rt_env
    ):
        """``captured_at`` 超出未来上限 → 400，且不落 run / 快照 / 评论。

        不设上限的后果是永久锁死：水位被抬到未来后，该 target 之后所有真实采集
        全部 409 直到墙上时钟追上，而产品内没有删 run / 重置水位的入口。
        """
        _agent_id, headers = _make_headers(make_api_key)
        resp = client.post(
            _runs_url(rt_env["target_id"]),
            json=_run_body(captured_at=_future_captured_at(hours=24 * 220)),
            headers=headers,
        )
        assert resp.status_code == 400, resp.text
        error = resp.json()["error"]
        assert error["code"] == "VALIDATION_FAILED"
        assert error["reason"] == "captured_at_in_future"
        assert error["details"]["max_future_seconds"] > 0
        assert "时钟" in error["agent_hint"]

        db = SessionLocal()
        try:
            assert (
                _count_rows(db, AmazonReviewCrawlRun, target_id=rt_env["target_id"])
                == 0
            )
            assert (
                _count_rows(
                    db, AmazonReviewRatingSnapshot, target_id=rt_env["target_id"]
                )
                == 0
            )
            assert (
                _count_rows(db, AmazonReviewReview, target_id=rt_env["target_id"]) == 0
            )
        finally:
            db.close()

    def test_captured_at_within_future_tolerance_accepted(
        self, client, make_api_key, rt_env
    ):
        """轻微时钟漂移（上限内）照常收录，不误杀正常采集。"""
        _agent_id, headers = _make_headers(make_api_key)
        resp = client.post(
            _runs_url(rt_env["target_id"]),
            json=_run_body(captured_at=_future_captured_at(hours=0.5)),
            headers=headers,
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["data"]["snapshot_updated"] is True

    def test_replay_of_future_captured_at_still_400(self, client, make_api_key, rt_env):  # noqa: E501
        """未来上限是输入合法性，不是守卫重放的写护栏：重放同样 400。"""
        _agent_id, headers = _make_headers(make_api_key)
        body = _run_body(
            captured_at=_future_captured_at(hours=48), idempotency_key="future-key"
        )
        first = client.post(_runs_url(rt_env["target_id"]), json=body, headers=headers)
        assert first.status_code == 400, first.text
        # 重放同一（非法）请求体依旧 400，不能默默返回首次 run
        replay = client.post(_runs_url(rt_env["target_id"]), json=body, headers=headers)
        assert replay.status_code == 400, replay.text
        db = SessionLocal()
        try:
            assert (
                _count_rows(db, AmazonReviewCrawlRun, target_id=rt_env["target_id"])
                == 0
            )
        finally:
            db.close()

    def _seed_future_run(self, target_id: int, *, hours_ahead: float) -> None:
        """直接写入一条未来 run，模拟旧版本已把脏数据写进来的现场。"""
        started_at = datetime.now(timezone.utc) + timedelta(hours=hours_ahead)
        db = SessionLocal()
        try:
            db.add(
                AmazonReviewCrawlRun(
                    target_id=target_id,
                    started_at=started_at,
                    finished_at=started_at,
                    status="success",
                    is_complete_list=False,
                    ratings_captured=False,
                )
            )
            db.commit()
        finally:
            db.close()

    def test_out_of_order_hint_mentions_clock_when_watermark_in_future(
        self, client, make_api_key, rt_env
    ):
        """水位在上限窗口内落在未来 → 提示核对时钟/等待自愈，不引导伪造更晚时间。"""
        _agent_id, headers = _make_headers(make_api_key)
        # 30 分钟对应上一次时间略超容差被接收的现场（旧版本行为）
        self._seed_future_run(rt_env["target_id"], hours_ahead=0.5)

        resp = client.post(
            _runs_url(rt_env["target_id"]),
            json=_run_body(captured_at=_captured_at(minutes_ago=10)),
            headers=headers,
        )
        assert resp.status_code == 409, resp.text
        error = resp.json()["error"]
        assert error["code"] == "REVIEW_TRACKING_CAPTURE_OUT_OF_ORDER"
        hint = error["agent_hint"]
        # 关键：不能是「请用更晚的时间重试」——那会写出更远的未来
        assert "时钟" in hint
        assert "不要" in hint
        assert "晚于 details.latest_started_at 的 captured_at 重试" not in hint

    def test_far_future_legacy_watermark_is_ignored_and_self_heals(
        self, client, make_api_key, rt_env
    ):
        """旧版本留下的超容差未来水位不计入护栏——真实采集能自己恢复，不会永久锁死。

        旧版本没有未来上限，可能已把一条 2027 年的 run 写进库；若不排除它，
        这个 target 会一直 409 到 2027，而产品内没有删 run / 重置水位的入口。
        """
        _agent_id, headers = _make_headers(make_api_key)
        self._seed_future_run(rt_env["target_id"], hours_ahead=24 * 200)

        resp = client.post(
            _runs_url(rt_env["target_id"]),
            json=_run_body(captured_at=_captured_at(minutes_ago=10)),
            headers=headers,
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["data"]["snapshot_updated"] is True

        db = SessionLocal()
        try:
            # 脏 run 仍在库（可见、可清理），但它没有阻挡真实写入
            assert (
                _count_rows(db, AmazonReviewCrawlRun, target_id=rt_env["target_id"])
                == 2
            )
            review = db.execute(
                select(AmazonReviewReview).where(
                    AmazonReviewReview.target_id == rt_env["target_id"]
                )
            ).scalar_one()
            assert review.visibility_status == "visible"
        finally:
            db.close()

    def test_normal_out_of_order_keeps_later_time_hint(
        self, client, make_api_key, rt_env
    ):
        """水位在过去（真正乱序）时保留「用当天更晚的时间点重跑」提示。"""
        _agent_id, headers = _make_headers(make_api_key)
        first = client.post(
            _runs_url(rt_env["target_id"]),
            json=_run_body(captured_at=_captured_at(minutes_ago=30)),
            headers=headers,
        )
        assert first.status_code == 200, first.text
        stale = client.post(
            _runs_url(rt_env["target_id"]),
            json=_run_body(captured_at=_captured_at(minutes_ago=180)),
            headers=headers,
        )
        assert stale.status_code == 409, stale.text
        hint = stale.json()["error"]["agent_hint"]
        assert "晚于" in hint
        assert "时钟" not in hint
