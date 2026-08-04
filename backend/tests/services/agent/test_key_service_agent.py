"""agent 通道凭据解析（设计稿 §2.2：严格 agent_id 绑定 + last_used_at 60s 节流）。"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.db.session import SessionLocal
from app.models.agent_api_key import AgentApiKey
from app.services.agent import key_service


@pytest.fixture
def agent_key():
    """一张绑定 agent_id 的 key；测试后清理。"""
    db = SessionLocal()
    try:
        record, plaintext = key_service.create_api_key(
            db, label="svc-test", created_by="pytest", agent_id="svc-agent"
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


def test_ok_and_stamps_first_use(agent_key):
    verdict = _resolve(agent_key["plaintext"])
    assert verdict.ok
    assert verdict.changed is True
    assert verdict.key.agent_id == "svc-agent"


def test_throttle_skips_stamp_within_60s(agent_key):
    first = _resolve(agent_key["plaintext"])
    assert first.changed is True
    second = _resolve(agent_key["plaintext"])
    assert second.ok
    assert second.changed is False


def test_agent_id_mismatch(agent_key):
    verdict = _resolve(agent_key["plaintext"], agent_id="other-agent")
    assert verdict.status == "agent_mismatch"


def test_legacy_key_never_matches_agent_channel():
    db = SessionLocal()
    try:
        record, plaintext = key_service.create_api_key(
            db, label="legacy", created_by="pytest"  # agent_id=None
        )
        db.commit()
        key_id = record.id
    finally:
        db.close()
    try:
        verdict = _resolve(plaintext)
        assert verdict.status == "agent_mismatch"
    finally:
        db = SessionLocal()
        try:
            obj = db.get(AgentApiKey, key_id)
            if obj is not None:
                db.delete(obj)
            db.commit()
        finally:
            db.close()


def test_revoked_and_expired(agent_key):
    db = SessionLocal()
    try:
        record = db.get(AgentApiKey, agent_key["id"])
        record.is_revoked = True
        db.commit()
    finally:
        db.close()
    assert _resolve(agent_key["plaintext"]).status == "revoked"

    db = SessionLocal()
    try:
        record = db.get(AgentApiKey, agent_key["id"])
        record.is_revoked = False
        record.expires_at = datetime.now(timezone.utc) - timedelta(days=1)
        db.commit()
    finally:
        db.close()
    assert _resolve(agent_key["plaintext"]).status == "expired"


def test_unknown_token(agent_key):
    assert _resolve("bbx_nonexistent").status == "not_found"
