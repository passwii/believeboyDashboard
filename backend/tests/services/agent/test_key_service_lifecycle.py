"""Agent API key 生命周期服务层（BLF-468）。

覆盖：
* ``list_api_keys(include_deleted=...)`` 默认隐藏已删除 Key；
* ``activate_api_key`` / ``delete_api_key`` 语义与边界；
* 鉴权加固：``resolve_key`` / ``resolve_key_for_agent`` 把已删除 Key 视为
  ``not_found``，且判定**先于** revoked（防止删除后被误激活的 Key 复活认证）。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.db.session import SessionLocal
from app.models.agent_api_key import AgentApiKey
from app.services.agent import key_service


@pytest.fixture
def agent_key():
    """一张绑定 agent_id 的 key；测试后硬清理（DELETE 清 deleted_at tombstone）。"""
    db = SessionLocal()
    try:
        record, plaintext = key_service.create_api_key(
            db, label="svc-lifecycle", created_by="pytest", agent_id="svc-agent"
        )
        db.commit()
        key_id = record.id
    finally:
        db.close()
    yield {"id": key_id, "plaintext": plaintext}
    db = SessionLocal()
    try:
        obj = db.get(AgentApiKey, key_id)
        if obj is not None:
            db.delete(obj)
        db.commit()
    finally:
        db.close()


def _resolve(plaintext: str, *, agent_id: str = "svc-agent"):
    db = SessionLocal()
    try:
        verdict = key_service.resolve_key_for_agent(db, plaintext, agent_id=agent_id)
        if verdict.ok and verdict.changed:
            db.commit()
        else:
            db.rollback()
        return verdict
    finally:
        db.close()


# ─────────────────────── list_api_keys 默认隐藏已删除 ────────────────────────


class TestListIncludeDeleted:
    def test_default_excludes_deleted(self, agent_key):
        # 删除后默认列表应不再包含该 Key
        db = SessionLocal()
        try:
            key_service.delete_api_key(db, agent_key["id"])
            db.commit()
        finally:
            db.close()

        db = SessionLocal()
        try:
            listed = key_service.list_api_keys(db)
            assert all(k.id != agent_key["id"] for k in listed)
        finally:
            db.close()

    def test_include_deleted_returns_all(self, agent_key):
        db = SessionLocal()
        try:
            key_service.delete_api_key(db, agent_key["id"])
            db.commit()
        finally:
            db.close()

        db = SessionLocal()
        try:
            listed = key_service.list_api_keys(db, include_deleted=True)
            assert any(k.id == agent_key["id"] for k in listed)
            # 列表项带 deleted_at
            match = next(k for k in listed if k.id == agent_key["id"])
            assert match.deleted_at is not None
        finally:
            db.close()


# ─────────────────────── activate / deactivate / delete ──────────────────────


class TestActivate:
    def test_reactivate_revoked_key(self, agent_key):
        db = SessionLocal()
        try:
            key_service.revoke_api_key(db, agent_key["id"])
            db.commit()
            activated = key_service.activate_api_key(db, agent_key["id"])
            db.commit()
            assert activated is not None
            assert activated.is_revoked is False
        finally:
            db.close()

    def test_activate_already_active_is_noop(self, agent_key):
        db = SessionLocal()
        try:
            activated = key_service.activate_api_key(db, agent_key["id"])
            db.commit()
            assert activated is not None
            assert activated.is_revoked is False
        finally:
            db.close()

    def test_activate_deleted_key_returns_none(self, agent_key):
        """BLF-468 安全红线：已删除 Key 不可激活（防止绕过删除保护）。"""
        db = SessionLocal()
        try:
            key_service.delete_api_key(db, agent_key["id"])
            db.commit()
            activated = key_service.activate_api_key(db, agent_key["id"])
            assert activated is None
            db.rollback()
        finally:
            db.close()

    def test_activate_unknown_key_returns_none(self):
        db = SessionLocal()
        try:
            assert key_service.activate_api_key(db, 999_999_999) is None
        finally:
            db.close()


class TestDelete:
    def test_delete_sets_deleted_at(self, agent_key):
        db = SessionLocal()
        try:
            record = key_service.delete_api_key(db, agent_key["id"])
            db.commit()
            assert record is not None
            assert record.deleted_at is not None
        finally:
            db.close()

    def test_delete_is_idempotent(self, agent_key):
        """BLF-468：删除幂等；二次删除仍是 deleted_at 非空（不刷新时间戳）。"""
        db = SessionLocal()
        try:
            first = key_service.delete_api_key(db, agent_key["id"])
            db.commit()
            assert first is not None
            first_ts = first.deleted_at
        finally:
            db.close()

        db = SessionLocal()
        try:
            second = key_service.delete_api_key(db, agent_key["id"])
            db.commit()
            assert second is not None
            assert second.deleted_at == first_ts  # 幂等：不刷新
        finally:
            db.close()

    def test_delete_unknown_key_returns_none(self):
        db = SessionLocal()
        try:
            assert key_service.delete_api_key(db, 999_999_999) is None
        finally:
            db.close()

    def test_revoke_on_deleted_key_returns_none(self, agent_key):
        """BLF-468：已删除 Key 不允许再停用（防止绕过删除保护）。"""
        db = SessionLocal()
        try:
            key_service.delete_api_key(db, agent_key["id"])
            db.commit()
            revoked = key_service.revoke_api_key(db, agent_key["id"])
            assert revoked is None
            db.rollback()
        finally:
            db.close()


# ─────────────────────────── 鉴权加固（核心安全）───────────────────────────


class TestAuthHardening:
    def test_resolve_key_for_agent_treats_deleted_as_not_found(self, agent_key):
        """BLF-468 §5.3：已删除 Key 落入 not_found，**先于** revoked。"""
        db = SessionLocal()
        try:
            key_service.delete_api_key(db, agent_key["id"])
            db.commit()
        finally:
            db.close()

        verdict = _resolve(agent_key["plaintext"])
        assert verdict.status == "not_found"

    def test_resolve_key_treats_deleted_as_not_found(self, agent_key):
        """``resolve_key``（external 通道）同样把已删除 Key 视为 not_found。"""
        db = SessionLocal()
        try:
            key_service.delete_api_key(db, agent_key["id"])
            db.commit()
        finally:
            db.close()

        db = SessionLocal()
        try:
            verdict = key_service.resolve_key(db, [agent_key["plaintext"]])
            assert verdict.status == "not_found"
        finally:
            db.close()

    def test_revoked_then_deleted_still_not_found(self, agent_key):
        """删除优先级高于 revoked——即使 is_revoked=true 也不能复活认证。"""
        db = SessionLocal()
        try:
            record = db.get(AgentApiKey, agent_key["id"])
            record.is_revoked = True
            record.deleted_at = datetime.now(timezone.utc)
            db.commit()
        finally:
            db.close()

        verdict = _resolve(agent_key["plaintext"])
        assert verdict.status == "not_found"

    def test_activate_then_delete_blocks_auth(self, agent_key):
        """完整闭环：revoke → activate（恢复）→ delete（删）→ resolve 应 not_found。"""
        db = SessionLocal()
        try:
            key_service.revoke_api_key(db, agent_key["id"])
            db.commit()
            key_service.activate_api_key(db, agent_key["id"])
            db.commit()
            # 先确认激活后能认证
        finally:
            db.close()
        assert _resolve(agent_key["plaintext"]).ok

        db = SessionLocal()
        try:
            key_service.delete_api_key(db, agent_key["id"])
            db.commit()
        finally:
            db.close()
        # 删除后必须 not_found
        assert _resolve(agent_key["plaintext"]).status == "not_found"

    def test_reactivate_after_expire_still_works(self, agent_key):
        """回归：expired 路径在 deleted_at 为空时仍正常。"""
        db = SessionLocal()
        try:
            record = db.get(AgentApiKey, agent_key["id"])
            record.expires_at = datetime.now(timezone.utc) - timedelta(days=1)
            db.commit()
        finally:
            db.close()
        assert _resolve(agent_key["plaintext"]).status == "expired"
