"""Agent Provisioning 域路由（BLF-843）：Agent 自助签发凭据。

``/api/v1/agent/provisioning/keys`` 一组 CRUD 路由，由持有
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

BLF-987：扩展编辑能力——``PATCH /api/v1/agent/provisioning/keys/{key_id}`` 与
``GET /api/v1/agent/provisioning/keys`` 列表，由 provisioner Agent 直接操作
已有 key 的 ``project_scope`` / ``business_scope``，即刻生效。
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
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
from app.models.project import Project
from app.schemas.agent_api_key import (
    AgentProvisionKeyEditRequest,
    AgentProvisionKeyRequest,
)
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
    # BLF-885 P0：scope 校验（预览阶段即拦，走 VALIDATION_FAILED + details）。
    # business_scope 未知域 → 拒绝；project_scope 逐片段校验 + 存在性校验。
    from app.api.agent.scope import KNOWN_BUSINESS_DOMAINS  # 延迟导入防循环

    if not biz:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            human_message="business_scope 不能为空",
            details=[{"loc": ["business_scope"], "msg": "不能为空"}],
        )
    unknown_domains = sorted(biz - KNOWN_BUSINESS_DOMAINS)
    if unknown_domains:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            human_message=f"business_scope 含未知域 code: {', '.join(unknown_domains)}",
            details=[
                {"loc": ["business_scope"], "msg": f"未知域 code: {c}"}
                for c in unknown_domains
            ],
        )
    # project_scope：逐片段校验（非空、整数字面量、正整数）
    raw_parts = [p.strip() for p in (req.project_scope or "").split(",")]
    # 过滤后的空片段视为校验失败（与 "*" 的空串归一不同：自助路径显式白名单不得为空）
    non_empty = [p for p in raw_parts if p]
    if not non_empty:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            human_message="project_scope 不能为空或全空片段",
            details=[{"loc": ["project_scope"], "msg": "不能为空"}],
        )
    invalid_parts: list[str] = []
    project_ids: list[int] = []
    for part in non_empty:
        try:
            pid = int(part)
        except ValueError:
            invalid_parts.append(part)
            continue
        if pid <= 0:
            invalid_parts.append(part)
            continue
        project_ids.append(pid)
    if invalid_parts:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            human_message=f"project_scope 含非法片段: {', '.join(invalid_parts)}",
            details=[
                {"loc": ["project_scope"], "msg": f"非法片段: {p}"}
                for p in invalid_parts
            ],
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
        # BLF-885 P0：project_scope 存在性校验（正整数片段已校验，此处查库）。
        # 2026-08-29 跟进：可用性 = 存在 且 is_active（停产/归档项目与不存在
        # 同样拒绝）；报错附的「可用项目列表」也只列 active——引导签发方向
        # 与实际可用集合一致，避免把 19 行全量（含 6 行停产）当成可选项。
        if project_ids:
            existing_rows = db.execute(
                select(Project.id, Project.is_active).where(
                    Project.id.in_(project_ids)
                )
            ).all()
            active_ids = {r[0] for r in existing_rows if r[1]}
            invalid_ids = sorted(set(project_ids) - active_ids)
            if invalid_ids:
                # 附可用项目列表（仅 active，P2 增强点 2，同时服务验收用例2）
                available = list(
                    db.scalars(
                        select(Project.id)
                        .where(Project.is_active.is_(True))
                        .order_by(Project.id)
                    ).all()
                )
                raise AgentApiError(
                    ErrorCode.VALIDATION_FAILED,
                    human_message=(
                        f"project_scope 含不存在或已停用的项目 id: "
                        f"{', '.join(map(str, invalid_ids))}；"
                        f"可用项目 id: {', '.join(map(str, available)) if available else '无'}"
                    ),
                    details=[
                        {
                            "loc": ["project_scope"],
                            "msg": f"不存在或已停用的项目 id: {m}",
                        }
                        for m in invalid_ids
                    ],
                )
        # BLF-885 P1：唯一性对齐 key_service 的“有效”定义（未删除且未停用且未过期）。
        # 停用/过期不再阻塞同 agent_id 重签；只有同 agent_id 的有效 key 才拒绝。
        candidates = list(
            db.scalars(
                select(AgentApiKey).where(
                    AgentApiKey.agent_id == req.agent_id,
                    AgentApiKey.deleted_at.is_(None),
                )
            ).all()
        )
        now_ts = datetime.now(timezone.utc)
        has_effective = False
        for cand in candidates:
            if cand.is_revoked:
                continue
            if cand.expires_at is not None:
                exp = cand.expires_at
                if exp.tzinfo is None:
                    exp = exp.replace(tzinfo=timezone.utc)
                if exp <= now_ts:
                    continue
            has_effective = True
            break
        if has_effective:
            raise AgentApiError(
                ErrorCode.VALIDATION_FAILED,
                human_message=f"agent_id {req.agent_id!r} 已存在有效凭据，请先停用或删除旧 key 后再签发",
            )
    finally:
        db.close()


def _preview(body: dict, request: Request) -> dict:
    """confirm 预览摘要：目标 agent_id / scopes / 有效期 + 人类可读对照（P2）。"""
    req = _parse_request(body)
    note = (
        "将为目标 agent 签发一张新凭据；明文 key 仅在本次响应返回一次"
        if req.expires_at is None
        else "将为目标 agent 签发一张新凭据（有到期时间）；明文 key 仅在本次响应返回一次"
    )
    preview: dict = {
        "action": "agent_key.create",
        "target_agent_id": req.agent_id,
        "label": req.label,
        "project_scope": req.project_scope,
        "business_scope": req.business_scope,
        "item_key": req.item_key,
        "expires_at": req.expires_at.isoformat() if req.expires_at else None,
        "note": note,
    }
    # P2：project_scope_display 人类可读对照（失败静默不影响预览）
    try:
        pids: list[int] = []
        for part in (req.project_scope or "").split(","):
            part = part.strip()
            if not part:
                continue
            try:
                pid = int(part)
                if pid > 0:
                    pids.append(pid)
            except ValueError:
                continue
        if pids:
            db = SessionLocal()
            try:
                rows = db.execute(
                    select(Project.id, Project.project_name).where(Project.id.in_(pids))
                ).all()
                id_to_name = {r[0]: r[1] for r in rows}
                preview["project_scope_display"] = ",".join(
                    id_to_name.get(pid, f"#{pid}") for pid in pids
                )
            finally:
                db.close()
    except Exception:  # noqa: BLE001 — 预览增强不阻塞主流程
        pass
    return preview


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


def _parse_edit_request(body: dict) -> AgentProvisionKeyEditRequest:
    """解析编辑请求体为 schema 实例；失败抛 VALIDATION_FAILED（带字段明细）。"""
    try:
        return AgentProvisionKeyEditRequest(**body)
    except ValidationError as exc:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            details=[
                {"loc": [str(p) for p in err.get("loc", [])], "msg": err.get("msg")}
                for err in exc.errors()
            ],
        ) from None


def _validate_edit(body: dict, request: Request) -> None:
    """编辑业务校验（先于 confirm 签发 token；短路不生成 token）。"""
    value = request.headers.get("idempotency-key")
    if value is not None and (len(value) == 0 or len(value) > 64):
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            human_message="Idempotency-Key 必须为非空字符串且不超过 64 字符",
        )

    req = _parse_edit_request(body)

    # 安全红线：禁止通配 scope（最小权限）
    if (req.project_scope or "").strip() == _SCOPE_ALL:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            human_message="编辑禁止 '*' 通配 project_scope：必须是显式白名单",
        )
    if (req.business_scope or "").strip() == _SCOPE_ALL:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            human_message="编辑禁止 '*' 通配 business_scope：必须是显式白名单",
        )

    # 校验 business_scope 域 code 合法性
    if req.business_scope is not None:
        from app.api.agent.scope import KNOWN_BUSINESS_DOMAINS  # 延迟导入防循环

        biz = {p.strip() for p in req.business_scope.split(",") if p.strip()}
        if not biz:
            raise AgentApiError(
                ErrorCode.VALIDATION_FAILED,
                human_message="business_scope 不能为空",
                details=[{"loc": ["business_scope"], "msg": "不能为空"}],
            )
        unknown_domains = sorted(biz - KNOWN_BUSINESS_DOMAINS)
        if unknown_domains:
            raise AgentApiError(
                ErrorCode.VALIDATION_FAILED,
                human_message=f"business_scope 含未知域 code: {', '.join(unknown_domains)}",
                details=[
                    {"loc": ["business_scope"], "msg": f"未知域 code: {c}"}
                    for c in unknown_domains
                ],
            )

    # 校验 project_scope 片段合法性
    if req.project_scope is not None:
        raw_parts = [p.strip() for p in req.project_scope.split(",")]
        non_empty = [p for p in raw_parts if p]
        if not non_empty:
            raise AgentApiError(
                ErrorCode.VALIDATION_FAILED,
                human_message="project_scope 不能为空或全空片段",
                details=[{"loc": ["project_scope"], "msg": "不能为空"}],
            )
        invalid_parts: list[str] = []
        project_ids: list[int] = []
        for part in non_empty:
            try:
                pid = int(part)
            except ValueError:
                invalid_parts.append(part)
                continue
            if pid <= 0:
                invalid_parts.append(part)
                continue
            project_ids.append(pid)
        if invalid_parts:
            raise AgentApiError(
                ErrorCode.VALIDATION_FAILED,
                human_message=f"project_scope 含非法片段: {', '.join(invalid_parts)}",
                details=[
                    {"loc": ["project_scope"], "msg": f"非法片段: {p}"}
                    for p in invalid_parts
                ],
            )
        # project_scope 存在性校验
        db = SessionLocal()
        try:
            if project_ids:
                existing_rows = db.execute(
                    select(Project.id, Project.is_active).where(
                        Project.id.in_(project_ids)
                    )
                ).all()
                active_ids = {r[0] for r in existing_rows if r[1]}
                invalid_ids = sorted(set(project_ids) - active_ids)
                if invalid_ids:
                    available = list(
                        db.scalars(
                            select(Project.id)
                            .where(Project.is_active.is_(True))
                            .order_by(Project.id)
                        ).all()
                    )
                    raise AgentApiError(
                        ErrorCode.VALIDATION_FAILED,
                        human_message=(
                            f"project_scope 含不存在或已停用的项目 id: "
                            f"{', '.join(map(str, invalid_ids))}；"
                            f"可用项目 id: {', '.join(map(str, available)) if available else '无'}"
                        ),
                        details=[
                            {
                                "loc": ["project_scope"],
                                "msg": f"不存在或已停用的项目 id: {m}",
                            }
                            for m in invalid_ids
                        ],
                    )
        finally:
            db.close()


def _preview_edit(body: dict, request: Request) -> dict:
    """confirm 预览摘要：编辑后的 scopes + label。"""
    req = _parse_edit_request(body)
    preview: dict = {
        "action": "agent_key.update",
        "label": req.label,
        "project_scope": req.project_scope,
        "business_scope": req.business_scope,
        "item_key": req.item_key,
        "note": "将更新目标 key 的权限与业务范围；编辑即刻生效",
    }
    return preview


@provisioning_router.get("", dependencies=[Depends(require_agent_write_rate_limit)])
async def list_agent_keys(
    db: Session = Depends(get_primary_db_session),
) -> dict:
    """列出所有绑定了 agent_id 的 Key（最新靠前）。"""
    keys = key_service.list_agent_keys(db)
    return agent_ok(
        [
            {
                "id": k.id,
                "key_prefix": k.key_prefix,
                "label": k.label,
                "scope": k.scope,
                "project_scope": k.project_scope,
                "business_scope": k.business_scope,
                "agent_id": k.agent_id,
                "item_key": k.item_key,
                "is_revoked": k.is_revoked,
                "expires_at": k.expires_at.isoformat() if k.expires_at else None,
                "created_at": k.created_at.isoformat() if k.created_at else None,
                "last_used_at": k.last_used_at.isoformat() if k.last_used_at else None,
            }
            for k in keys
        ]
    )


@provisioning_router.patch(
    "/{key_id}",
    dependencies=[Depends(require_agent_write_rate_limit)],
)
@require_confirmation(
    action="agent_key.update",
    build_preview=_preview_edit,
    validate=_validate_edit,
)
async def update_agent_key(
    request: Request,
    db: Session = Depends(get_primary_db_session),
) -> dict:
    """编辑现有 agent 凭据的权限与业务范围（BLF-987）。

    PATCH 语义：仅更新显式传入的字段（label / project_scope / business_scope / item_key）。
    编辑即刻生效——鉴权路径（scope.py）每请求实时读列，无需重建凭据。
    已删除 Key 不可编辑（404）。
    """
    key_id = int(request.path_params["key_id"])
    body = json.loads(await request.body() or b"{}")
    req = _parse_edit_request(body)

    record = key_service.update_api_key(
        db,
        key_id,
        label=req.label,
        project_scope=req.project_scope,
        business_scope=req.business_scope,
        item_key=req.item_key,
    )
    if record is None:
        raise AgentApiError(
            ErrorCode.RESOURCE_NOT_FOUND,
            human_message="API key not found",
        )

    append_operation_audit_log(
        db,
        action="api_key.update",
        target_type="agent_api_key",
        target_id=record.id,
        operator=None,
        after={
            "label": record.label,
            "project_scope": record.project_scope,
            "business_scope": record.business_scope,
            "item_key": record.item_key,
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
            "scope": record.scope,
            "project_scope": record.project_scope,
            "business_scope": record.business_scope,
            "agent_id": record.agent_id,
            "item_key": record.item_key,
            "is_revoked": record.is_revoked,
            "expires_at": record.expires_at.isoformat() if record.expires_at else None,
            "created_at": record.created_at.isoformat() if record.created_at else None,
            "last_used_at": record.last_used_at.isoformat() if record.last_used_at else None,
        },
        idempotency_key=request.headers.get("idempotency-key") or None,
    )
