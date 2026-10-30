"""Shared fixtures for ``tests/api`` (BEL-377 external API security).

The external-API feature flags live on the lru-cached ``Settings`` singleton
and the slowapi limiter keeps in-memory state for the whole process, so both
leak across tests unless reset. The autouse fixture below snapshots the flags
and clears the limiter before/after every test in this package — tests are
then free to mutate ``get_settings()`` directly.
"""

from __future__ import annotations

import pytest

_SECURITY_FLAGS = (
    "external_api_require_auth",
    "external_api_allow_skip_auth",
    "external_api_rate_limit_enabled",
    "external_api_rate_limit",
    # 改名后的访问审计配置（设计稿 §11.2）
    "agent_api_audit_enabled",
    "agent_api_audit_retention_days",
    # Agent 通道限流（设计稿 §7.1）
    "agent_api_read_rate_limit",
    "agent_api_write_rate_limit",
)


@pytest.fixture(autouse=True)
def _restore_external_state():
    from app.api.agent.rate_limit import agent_limiter, agent_write_limiter
    from app.api.external_security import external_limiter
    from app.core.config import get_settings

    settings = get_settings()
    snapshot = {name: getattr(settings, name) for name in _SECURITY_FLAGS}
    for limiter in (external_limiter, agent_limiter, agent_write_limiter):
        try:
            limiter.reset()
        except Exception:  # noqa: BLE001 — reset is best-effort
            pass
    yield
    for name, value in snapshot.items():
        setattr(settings, name, value)
    for limiter in (external_limiter, agent_limiter, agent_write_limiter):
        try:
            limiter.reset()
        except Exception:  # noqa: BLE001
            pass


@pytest.fixture(autouse=True)
def _cleanup_agent_audit_tables(request):
    """Only audit-sensitive modules pay for table cleanup.

    Agent 命名空间中间件对每个请求写一条访问日志（``agent_api_audit_log``）；
    写路由落 ``operation_audit_logs``（agent_id 归因行）。只有直接查询这两张表、
    或依赖全局计数的模块需要每次测试前清空；其余约 4/5 的 API 用例不应为它们
    承担额外 Session + DELETE + COMMIT。
    """
    if request.node.get_closest_marker("audit_table_isolation") is None:
        yield
        return

    _clear_agent_audit_tables()
    yield


def _clear_agent_audit_tables() -> None:
    from sqlalchemy import delete

    from app.db.session import SessionLocal
    from app.models.agent_api_audit_log import AgentApiAuditLog
    from app.models.operation_audit_log import OperationAuditLog

    db = SessionLocal()
    try:
        db.execute(delete(AgentApiAuditLog))
        db.execute(delete(OperationAuditLog))
        db.commit()
    finally:
        db.close()


@pytest.fixture
def make_api_key():
    """Factory: create a committed DB key; clean up afterwards.

    The auth path opens its own session, so the key must be committed (not
    rolled back) to be visible to it.
    """
    from app.db.session import SessionLocal
    from app.models.agent_api_key import AgentApiKey
    from app.services.agent import key_service

    created_ids: list[int] = []

    def _make(
        *,
        label: str = "test-key",
        expires_at=None,
        revoked: bool = False,
        agent_id: str | None = None,
        project_scope: str = "*",
        business_scope: str = "*",
    ) -> dict:
        db = SessionLocal()
        try:
            record, plaintext = key_service.create_api_key(
                db,
                label=label,
                created_by="pytest",
                expires_at=expires_at,
                agent_id=agent_id,
                project_scope=project_scope,
                business_scope=business_scope,
            )
            if revoked:
                record.is_revoked = True
            db.commit()
            created_ids.append(record.id)
            return {
                "id": record.id,
                "plaintext": plaintext,
                "agent_id": agent_id,
                "project_scope": project_scope,
            }
        finally:
            db.close()

    yield _make

    db = SessionLocal()
    try:
        for key_id in created_ids:
            obj = db.get(AgentApiKey, key_id)
            if obj is not None:
                db.delete(obj)
        db.commit()
    finally:
        db.close()
