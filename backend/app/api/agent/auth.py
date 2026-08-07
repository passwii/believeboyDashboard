"""Agent 命名空间鉴权依赖（设计稿 §2）。

只认 ``Authorization: Bearer <key_secret>`` + ``X-Agent-Id``；
X-API-Key / ?api_key= / ?skip_auth=true / master key 一律不接受
（设计稿 §2.1 对照表）——agent 是服务端消费者，契约保持最窄。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from fastapi import Request

from app.api.agent.errors import AgentApiError, ErrorCode
from app.db.session import SessionLocal
from app.services.agent import key_service

logger = logging.getLogger(__name__)

REASON_TOKEN_INVALID = "token_invalid"
REASON_TOKEN_EXPIRED = "token_expired"
REASON_TOKEN_REVOKED = "token_revoked"
REASON_AGENT_MISMATCH = "agent_id_mismatch"

_STATUS_TO_REASON = {
    "not_found": REASON_TOKEN_INVALID,
    "expired": REASON_TOKEN_EXPIRED,
    "revoked": REASON_TOKEN_REVOKED,
    "agent_mismatch": REASON_AGENT_MISMATCH,
}


@dataclass
class AgentCredential:
    key_id: int
    agent_id: str
    label: str


def _extract_bearer(request: Request) -> str | None:
    authorization = request.headers.get("authorization")
    if not authorization or not authorization.lower().startswith("bearer "):
        return None
    token = authorization[len("bearer ") :].strip()
    return token or None


def require_agent_credential(request: Request) -> AgentCredential:
    """校验 Bearer + X-Agent-Id；通过后注入 request.state。"""
    token = _extract_bearer(request)
    if token is None:
        raise AgentApiError(ErrorCode.AGENT_AUTH_FAILED, reason=REASON_TOKEN_INVALID)
    agent_id = (request.headers.get("x-agent-id") or "").strip()
    if not agent_id:
        raise AgentApiError(
            ErrorCode.AGENT_AUTH_FAILED, reason=REASON_AGENT_MISMATCH
        )

    db = SessionLocal()
    try:
        verdict = key_service.resolve_key_for_agent(db, token, agent_id=agent_id)
        if verdict.ok:
            if verdict.changed:
                db.commit()
            else:
                db.rollback()  # 丢弃节流窗口内的 last_used_at 改动
            request.state.agent_id = agent_id
            # 「名称」即 label（BLF-471）：写操作审计落库时快照 label 作为显示名。
            request.state.agent_label = verdict.key.label
            request.state.agent_api_key_id = verdict.key.id
            return AgentCredential(
                key_id=verdict.key.id,
                agent_id=agent_id,
                label=verdict.key.label,
            )
        db.rollback()
        reason = _STATUS_TO_REASON.get(verdict.status, REASON_TOKEN_INVALID)
        raise AgentApiError(ErrorCode.AGENT_AUTH_FAILED, reason=reason)
    except AgentApiError:
        raise
    except Exception:  # noqa: BLE001 — agent 通道 fail closed
        logger.exception("agent API key resolution failed")
        db.rollback()
        raise AgentApiError(
            ErrorCode.AGENT_AUTH_FAILED, reason=REASON_TOKEN_INVALID
        ) from None
    finally:
        db.close()
