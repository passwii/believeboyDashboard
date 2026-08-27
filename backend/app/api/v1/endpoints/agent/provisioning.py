"""Agent Provisioning 域路由（BLF-843）：Agent 自助签发凭据。

``/api/v1/agent/provisioning/keys`` 一条写路由（POST），由持有
``agent_provisioning`` 业务域 scope 的指定 provisioner Agent 调用：

* 鉴权走命名空间统一的 ``require_agent_credential``（Bearer + X-Agent-Id）；
* 业务域门禁 ``require_business_scope("agent_provisioning")``——业务 key
  没有 provisioning 域就铸不了 key（双向物理隔离，防混淆）；
* 危险写操作两步确认：``@require_confirmation(action="agent_key.create")``
  （预览不落库 → 同 Idempotency-Key + X-Confirm-Token + 同请求体重放才签发）；
* 写桶限流 ``require_agent_write_rate_limit``；
* 审计零改造：照抄 internal 签发路径调 ``append_operation_audit_log``
  （operator=provisioner 的 agent_id，after 快照带目标 agent 信息）。

安全红线（与第一轮评估报告一致）：

* **禁止经此路径签发 ``"*"`` 通配 scope**：``project_scope`` /
  ``business_scope`` 必填显式白名单——从源头保住「每个 agent 业务范围
  不同」的最小权限；provisioner 自身也不受影响（它自己的 scope 由管理页管）。
* 目标 ``agent_id`` 服务端校验格式（``^[a-z0-9][a-z0-9_-]{2,127}$``）+
  唯一性（同 agent_id 已有未删除 key → 拒绝，防重复签发）。
* ``expires_at`` 可选（用户拍板：默认永久有效）；传了则必须晚于当前时刻。
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Request
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.agent.confirm import require_confirmation
from app.api.agent.errors import AgentApiError, ErrorCode
from app.api.agent.rate_limit import require_agent_write_rate_limit
from app.api.agent.response import agent_ok
from app.api.deps import get_primary_db_session
from app.db.session import SessionLocal
from app.models.agent_api_key import AgentApiKey
from app.schemas.agent_api_key import AgentProvisionKeyRequest
from app.services.agent import key_service
from app.services.audit_log_service import append_operation_audit_log

provisioning_router = APIRouter(
    prefix="/provisioning/keys",
    tags=["agent-provisioning"],
)

# 目标 agent_id 命名规范：小写字母/数字开头，允许 - _ ，3~128 字符。
AGENT_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{2,127}$")

#: 通配哨兵值（scope.py 的 SCOPE_ALL；此处是禁止值而非放行值）。
_SCOPE_ALL = "*"


def _parse_request(body: dict):
    """解析请求体为 schema 实例；失败抛 VALIDATION_FAILED（带字段明细）。"""
    try:
        return AgentProvisionKeyRequest(**body)
    except ValidationError as exc:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            details=[
                {"loc": [str(p) for p in err.get("loc", [])], "msg": err.get("msg")}
                for err in exc.errors()
            ],
        ) from None


def _validate(body: dict, request: Request) -> None:
    """业务校验（先于 confirm 签发 token；短路不生成 token）。"""
    value = request.headers.get("idempotency-key")
    if value is not None and (len(value) == 0 or len(value) > 64):
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            human_message="Idempotency-Key 必须为非空字符串且不超过 64 字符",
        )

    req = _parse_request(body)

    # 安全红线：自助签发路径禁止通配 scope（最小权限，防 provisioner 被
    # 诱导后一键放大爆炸半径）。
    if (req.project_scope or "").strip() == _SCOPE_ALL or (
        req.business_scope or ""
    ).strip() == _SCOPE_ALL:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            human_message=(
                "自助签发禁止 '*' 通配 scope：project_scope 与 business_scope "
                "都必须是显式白名单"
            ),
        )
    # 红线 A（BLF-847）：自助签发路径禁止授予 agent_provisioning 域——无论是
    # 单独给还是混在业务域列表里。签发能力（管理 Key）只能由管理员页面签发，
    # 叠加上面的禁 '*' 红线，自复制链（provisioner 铸出第二张签发 key）双向封死。
    biz = {p.strip() for p in (req.business_scope or "").split(",") if p.strip()}
    if "agent_provisioning" in biz:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            human_message=(
                "自助签发禁止授予 agent_provisioning 域：签发能力仅限管理 Key "
                "（全局单例），请通过管理员页面签发"
            ),
        )
    if not AGENT_ID_PATTERN.match(req.agent_id):
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            human_message=(
                "agent_id 格式非法：小写字母/数字开头，仅含 a-z0-9-_，长度 3-128"
            ),
        )
    now = datetime.now(timezone.utc)
    if req.expires_at is not None:
        expires = req.expires_at
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=timezone.utc)
        if expires <= now:
            raise AgentApiError(
                ErrorCode.VALIDATION_FAILED,
                human_message="expires_at 必须晚于当前时刻",
            )

    db = SessionLocal()
    try:
        existing = db.scalars(
            select(AgentApiKey).where(
                AgentApiKey.agent_id == req.agent_id,
                AgentApiKey.deleted_at.is_(None),
            )
        ).first()
        if existing is not None:
            raise AgentApiError(
                ErrorCode.VALIDATION_FAILED,
                human_message=f"agent_id {req.agent_id!r} 已存在有效凭据，请先停用旧 key 或更换标识",
            )
    finally:
        db.close()


def _preview(body: dict, request: Request) -> dict:
    """confirm 预览摘要：目标 agent_id / scopes / 有效期。"""
    req = _parse_request(body)
    note = (
        "将为目标 agent 签发一张新凭据；明文 key 仅在本次响应返回一次"
        if req.expires_at is None
        else "将为目标 agent 签发一张新凭据（有到期时间）；明文 key 仅在本次响应返回一次"
    )
    return {
        "action": "agent_key.create",
        "target_agent_id": req.agent_id,
        "label": req.label,
        "project_scope": req.project_scope,
        "business_scope": req.business_scope,
        "item_key": req.item_key,
        "expires_at": req.expires_at.isoformat() if req.expires_at else None,
        "note": note,
    }


@provisioning_router.post("", dependencies=[Depends(require_agent_write_rate_limit)])
@require_confirmation(
    action="agent_key.create",
    build_preview=_preview,
    validate=_validate,
)
async def provision_agent_key(
    request: Request,
    # 会话边界（review 备忘）：confirm 装饰器只管 Redis token 与请求体解析，
    # 不持有任何 DB 会话；_validate 的临时 SessionLocal() 只在「无 confirm 头」
    # 的预览短路路径上运行，与 handler 不在同一请求里。落库路径的**唯一**
    # 会话就是下面这个 Depends(get_primary_db_session)——请求级 async generator
    # （db/session.py），finally 里必关；与 internal/api_keys.py 同款模式。
    db: Session = Depends(get_primary_db_session),  # noqa: B008 — 对齐既有端点模式
) -> dict:
    """自助签发一张 agent 凭据（confirm 两步后落库，明文仅此一次）。"""
    body = json.loads(await request.body() or b"{}")
    req = _parse_request(body)

    record, plaintext = key_service.create_api_key(
        db,
        label=req.label,
        created_by=getattr(request.state, "agent_id", None) or "agent-provisioner",
        scope="read",
        project_scope=req.project_scope,
        business_scope=req.business_scope,
        expires_at=req.expires_at,
        agent_id=req.agent_id,
        item_key=req.item_key,
    )
    append_operation_audit_log(
        db,
        action="api_key.create",
        target_type="agent_api_key",
        target_id=record.id,
        operator=None,
        after={
            "target_agent_id": record.agent_id,
            "label": record.label,
            "project_scope": record.project_scope,
            "business_scope": record.business_scope,
            "item_key": record.item_key,
            "expires_at": record.expires_at.isoformat() if record.expires_at else None,
            "via": "agent_provisioning",
        },
        agent_id=getattr(request.state, "agent_id", None),
        agent_name=getattr(request.state, "agent_label", None),
        idempotency_key=request.headers.get("idempotency-key") or None,
        request=request,
    )
    db.commit()
    db.refresh(record)
    return agent_ok(
        {
            "id": record.id,
            "key_prefix": record.key_prefix,
            "label": record.label,
            "project_scope": record.project_scope,
            "business_scope": record.business_scope,
            "agent_id": record.agent_id,
            "item_key": record.item_key,
            "expires_at": record.expires_at.isoformat() if record.expires_at else None,
            "plaintext_key": plaintext,
        },
        idempotency_key=request.headers.get("idempotency-key") or None,
    )
