from __future__ import annotations

import importlib
import uuid
from datetime import datetime, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import delete, select

from app.api.deps import get_primary_db_session, get_read_db_session
from app.api.v1.endpoints import amazon_review_tracking as endpoint
from app.db.session import SessionLocal
from app.models import Project
from app.models.amazon_review_tracking import (
    AmazonReviewExternalLink,
    AmazonReviewTarget,
)
from app.models.project_shop import ProjectShop

# 直接 import 该新模块会被本地 LSP 的陈旧索引误报（pyright CLI 校验为 0 error）。
# 动态导入拿到真实模块对象，既能 monkeypatch 内部查找函数，又不触发该噪声。
service = importlib.import_module("app.services.amazon_review_external_service")

EXTERNAL_TARGETS_URL = "/api/v1/amazon-review-tracking/external-targets"


@pytest.fixture
def admin_headers(admin_headers):
    """Root-conftest auth headers + an internal session id (see ops test)."""
    return {**admin_headers, "X-Session-Id": "external-test-session"}


@pytest.fixture
def operator_headers(operator_headers):
    return {**operator_headers, "X-Session-Id": "external-test-session"}


@pytest.fixture
def businessdev_headers(businessdev_headers):
    return {**businessdev_headers, "X-Session-Id": "external-test-session"}


@pytest.fixture
def client(db_session, monkeypatch):
    """TestClient over the review-tracking router with a shared test session."""
    monkeypatch.setattr(endpoint, "validate_session", lambda user_id, session_id: True)
    app = FastAPI()
    app.include_router(endpoint.router, prefix="/api/v1")
    app.dependency_overrides[get_primary_db_session] = lambda: db_session
    app.dependency_overrides[get_read_db_session] = lambda: db_session
    return TestClient(app, raise_server_exceptions=False)


def _shop(db_session):
    # 建专属 project：API 会 commit，复用首个 active project 会在重复跑时
    # 撞 uq_project_shops_project_country（project_id, country 唯一）。
    project = Project(
        project_name=f"ext-{uuid.uuid4().hex[:8]}", sort_order=930200, is_active=True
    )
    db_session.add(project)
    db_session.flush()
    shop = ProjectShop(project_id=project.id, country="US", shop_id=f"ext-{uuid.uuid4().hex[:8]}",
                       shop_name=f"ext-{uuid.uuid4().hex[:8]}")
    db_session.add(shop)
    db_session.flush()
    return shop


def _asin() -> str:
    return f"B0{uuid.uuid4().hex[:8].upper()}"


def _register(client, headers, *, asin, shop_id, display_name=None):
    payload = {"marketplace": "US", "asin": asin, "shop_id": shop_id}
    if display_name is not None:
        payload["display_name"] = display_name
    return client.post(EXTERNAL_TARGETS_URL, json=payload, headers=headers)


def _commit_seed(*, with_link: bool) -> dict:
    """独立 session 提交一条既有 (marketplace, asin) 外部目标（可含一条已关联链接）。

    模拟「并发下另一方已先提交」的状态，供 savepoint 恢复测试复用。
    """
    db = SessionLocal()
    try:
        project = Project(project_name=f"ext-seed-{uuid.uuid4().hex[:8]}", sort_order=930300, is_active=True)
        db.add(project)
        db.flush()
        shop = ProjectShop(project_id=project.id, country="US", shop_id=f"ext-{uuid.uuid4().hex[:8]}",
                           shop_name=f"ext-{uuid.uuid4().hex[:8]}")
        db.add(shop)
        db.flush()
        asin = _asin()
        target = AmazonReviewTarget(kind="external_asin", marketplace="US", asin=asin,
                                    display_name=asin, is_active=True)
        db.add(target)
        db.flush()
        link_id = None
        if with_link:
            link = AmazonReviewExternalLink(target_id=target.id, shop_id=shop.id, is_active=True,
                                            added_at=datetime.now(timezone.utc))
            db.add(link)
            db.flush()
            link_id = link.id
        db.commit()
        return {"project_id": project.id, "shop_id": shop.id, "asin": asin,
                "target_id": target.id, "link_id": link_id}
    finally:
        db.close()


def _cleanup_seed(seed: dict) -> None:
    db = SessionLocal()
    try:
        db.execute(delete(AmazonReviewExternalLink).where(
            AmazonReviewExternalLink.target_id == seed["target_id"]))
        db.execute(delete(AmazonReviewTarget).where(AmazonReviewTarget.id == seed["target_id"]))
        db.execute(delete(ProjectShop).where(ProjectShop.id == seed["shop_id"]))
        db.execute(delete(Project).where(Project.id == seed["project_id"]))
        db.commit()
    finally:
        db.close()


def test_register_external_target_and_relink_restores_history(client, admin_headers, db_session):
    shop = _shop(db_session)
    asin = _asin()
    created = _register(client, admin_headers, asin=asin, shop_id=shop.id)
    assert created.status_code == 201
    body = created.json()
    assert body["kind"] == "external_asin" and [link["shop_id"] for link in body["links"]] == [shop.id]
    target_id = body["id"]
    first_link_id = body["links"][0]["id"]

    removed = client.delete(
        f"/api/v1/amazon-review-tracking/targets/{target_id}/external-links/{first_link_id}",
        headers=admin_headers)
    assert removed.status_code == 200 and removed.json()["is_active"] is False

    again = _register(client, admin_headers, asin=asin, shop_id=shop.id)
    assert again.status_code == 201 and again.json()["id"] == target_id
    active = [link for link in again.json()["links"] if link["is_active"]]
    assert [link["shop_id"] for link in active] == [shop.id]
    # (a) 软删后重加复用同一 link 行，而不是新建
    assert active[0]["id"] == first_link_id


def test_register_reactivates_inactive_target(client, admin_headers, db_session):
    shop = _shop(db_session)
    asin = _asin()
    first = _register(client, admin_headers, asin=asin, shop_id=shop.id)
    assert first.status_code == 201
    target_id = first.json()["id"]

    # 无停用端点：直接置 is_active=False 模拟目标被停用
    target = db_session.get(AmazonReviewTarget, target_id)
    target.is_active = False
    db_session.commit()

    revived = _register(client, admin_headers, asin=asin, shop_id=shop.id)
    assert revived.status_code == 201
    assert revived.json()["id"] == target_id and revived.json()["is_active"] is True


def test_link_same_target_to_multiple_shops(client, admin_headers, db_session):
    shop_a = _shop(db_session)
    shop_b = _shop(db_session)
    asin = _asin()
    created = _register(client, admin_headers, asin=asin, shop_id=shop_a.id)
    assert created.status_code == 201
    target_id = created.json()["id"]

    second = client.post(
        f"/api/v1/amazon-review-tracking/targets/{target_id}/external-links",
        json={"shop_id": shop_b.id}, headers=admin_headers)
    assert second.status_code == 201 and second.json()["shop_id"] == shop_b.id

    listed = client.get(EXTERNAL_TARGETS_URL, headers=admin_headers)
    assert listed.status_code == 200
    item = next(entry for entry in listed.json() if entry["id"] == target_id)
    assert sorted(link["shop_id"] for link in item["links"]) == sorted([shop_a.id, shop_b.id])


def test_write_endpoints_reject_non_admin(client, admin_headers, operator_headers, businessdev_headers, db_session):
    shop = _shop(db_session)
    payload = {"marketplace": "US", "asin": _asin(), "shop_id": shop.id}
    assert client.post(EXTERNAL_TARGETS_URL, json=payload, headers=operator_headers).status_code == 403
    assert client.post(EXTERNAL_TARGETS_URL, json=payload, headers=businessdev_headers).status_code == 403
    # 管理员可写
    assert client.post(EXTERNAL_TARGETS_URL, json=payload, headers=admin_headers).status_code == 201


def test_external_link_write_endpoints_require_admin(client, admin_headers, operator_headers,
                                                     businessdev_headers, db_session):
    shop = _shop(db_session)
    created = _register(client, admin_headers, asin=_asin(), shop_id=shop.id)
    assert created.status_code == 201
    target_id = created.json()["id"]
    link_id = created.json()["links"][0]["id"]
    add_url = f"/api/v1/amazon-review-tracking/targets/{target_id}/external-links"
    del_url = f"{add_url}/{link_id}"

    # 非管理员：新增链接 403
    assert client.post(add_url, json={"shop_id": shop.id}, headers=operator_headers).status_code == 403
    assert client.post(add_url, json={"shop_id": shop.id}, headers=businessdev_headers).status_code == 403
    # 非管理员：删除链接 403
    assert client.delete(del_url, headers=operator_headers).status_code == 403
    assert client.delete(del_url, headers=businessdev_headers).status_code == 403
    # 管理员：新增 + 删除均成功
    assert client.post(add_url, json={"shop_id": shop.id}, headers=admin_headers).status_code == 201
    assert client.delete(del_url, headers=admin_headers).status_code == 200


def test_list_external_targets_validates_pagination(client, admin_headers):
    url = EXTERNAL_TARGETS_URL
    assert client.get(url, params={"limit": 0}, headers=admin_headers).status_code == 422
    assert client.get(url, params={"limit": 1001}, headers=admin_headers).status_code == 422
    assert client.get(url, params={"offset": -1}, headers=admin_headers).status_code == 422
    assert client.get(url, params={"limit": 1, "offset": 0}, headers=admin_headers).status_code == 200


def test_list_external_targets_pagination_slices_by_id(client, admin_headers, db_session):
    shop = _shop(db_session)
    created_ids = []
    for _ in range(3):
        resp = _register(client, admin_headers, asin=_asin(), shop_id=shop.id)
        assert resp.status_code == 201
        created_ids.append(resp.json()["id"])

    url = EXTERNAL_TARGETS_URL
    full_ids = [item["id"] for item in
                client.get(url, params={"limit": 1000}, headers=admin_headers).json()]
    assert full_ids == sorted(full_ids)  # 确定性：id 升序
    assert len(full_ids) >= 3 and set(created_ids) <= set(full_ids)

    # 逐页拉取（每页 2 条），拼接后应等于全集：不重、不漏、顺序一致
    paged_ids: list[int] = []
    offset = 0
    while True:
        page = client.get(url, params={"limit": 2, "offset": offset}, headers=admin_headers).json()
        paged_ids.extend(item["id"] for item in page)
        if len(page) < 2:
            break
        offset += 2
    assert paged_ids == full_ids


def test_register_normalizes_display_name_and_validates_asin(client, admin_headers, db_session):
    shop = _shop(db_session)
    asin = _asin()
    padded = _register(client, admin_headers, asin=f"  {asin.lower()}  ", shop_id=shop.id,
                       display_name="  Competitor A  ")
    assert padded.status_code == 201
    assert padded.json()["asin"] == asin and padded.json()["display_name"] == "Competitor A"

    blank_name = _register(client, admin_headers, asin=_asin(), shop_id=shop.id, display_name="   ")
    assert blank_name.status_code == 201 and blank_name.json()["display_name"] == blank_name.json()["asin"]

    bad_asin = _register(client, admin_headers, asin="B0X", shop_id=shop.id)
    assert bad_asin.status_code == 422


def test_register_reuses_target_after_concurrent_conflict(monkeypatch, db_session):
    """savepoint 恢复：首个 select 查不到 → 插入撞唯一约束 → 复用既有行，外层事务仍可用。"""
    seed = _commit_seed(with_link=False)
    try:
        real_find = service._find_target
        calls = {"n": 0}

        def first_miss(db, marketplace, asin):
            calls["n"] += 1
            if calls["n"] == 1:
                return None  # 模拟并发：另一 session 已提交，但本次首个 select 查不到
            return real_find(db, marketplace, asin)

        monkeypatch.setattr(service, "_find_target", first_miss)

        target = service.register_external_target(
            db_session, marketplace="US", asin=seed["asin"], display_name=seed["asin"])
        db_session.flush()

        assert target.id == seed["target_id"]
        assert calls["n"] >= 2
        # 外层事务未被并发冲突破坏，仍可继续查询
        found = db_session.execute(
            select(AmazonReviewTarget).where(AmazonReviewTarget.id == seed["target_id"])
        ).scalar_one()
        assert found is not None and found.marketplace == "US" and found.asin == seed["asin"]
    finally:
        db_session.rollback()  # 先释放 db_session 持有的行锁，避免 cleanup 的独立 session 阻塞
        _cleanup_seed(seed)


def test_upsert_link_reuses_link_after_concurrent_conflict(monkeypatch, db_session):
    """savepoint 恢复：链接并发插入冲突时复用既有行。"""
    seed = _commit_seed(with_link=True)
    try:
        real_find = service._find_link
        calls = {"n": 0}

        def first_miss(db, target_id, shop_id):
            calls["n"] += 1
            if calls["n"] == 1:
                return None
            return real_find(db, target_id, shop_id)

        monkeypatch.setattr(service, "_find_link", first_miss)

        link = service.add_external_link(db_session, target_id=seed["target_id"], shop_id=seed["shop_id"])
        db_session.flush()

        assert link.id == seed["link_id"] and link.is_active is True
        assert calls["n"] >= 2
        assert db_session.get(AmazonReviewExternalLink, seed["link_id"]).is_active is True
    finally:
        db_session.rollback()  # 先释放 db_session 持有的行锁，避免 cleanup 的独立 session 阻塞
        _cleanup_seed(seed)


def test_external_requires_admin_and_rejects_bad_shop(client, admin_headers):
    assert client.post(EXTERNAL_TARGETS_URL,
                       json={"marketplace": "US", "asin": "B0X"}).status_code == 401
    bad = client.post(EXTERNAL_TARGETS_URL,
                      json={"marketplace": "US", "asin": _asin(), "shop_id": 999999999},
                      headers=admin_headers)
    assert bad.status_code == 422
