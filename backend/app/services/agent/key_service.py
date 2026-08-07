"""Agent API key service（BEL-377 api_key_service 挪入，见设计稿 §11）。

Credential management + verification for the ``/api/v1/agent/*`` namespace
（过渡期同时覆盖 ``/api/v1/external/*``）. Keys are generated with
``secrets`` and stored as SHA-256 hashes; the plaintext is returned exactly
once at creation.

Verification is deliberately tolerant of ordering: ``resolve_key`` returns
the first stored key whose hash matches any candidate and reports *why* it
is not usable (revoked / expired) so the caller can emit a precise 401.
"""

from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.agent_api_key import AgentApiKey

# Human-friendly prefix so operators can recognise an agent key in logs.
KEY_PREFIX = "bbx_"
# Bytes of randomness for the secret portion (32 → 43 url-safe chars).
KEY_SECRET_BYTES = 32


def hash_key(plaintext: str) -> str:
    """SHA-256 hex digest used for storage and lookup."""
    return hashlib.sha256(plaintext.encode("utf-8")).hexdigest()


def generate_key() -> tuple[str, str, str]:
    """Return ``(plaintext, key_hash, key_prefix)`` for a brand-new key."""
    plaintext = f"{KEY_PREFIX}{secrets.token_urlsafe(KEY_SECRET_BYTES)}"
    # Prefix shows the label-bearing head of the key without leaking the
    # secret tail (first 12 chars, e.g. ``bbx_ab12cd34``).
    return plaintext, hash_key(plaintext), plaintext[:12]


@dataclass
class KeyVerdict:
    """Outcome of matching candidate secrets against stored keys."""

    status: str  # "ok" | "expired" | "revoked" | "not_found"
    key: AgentApiKey | None = None

    @property
    def ok(self) -> bool:
        return self.status == "ok"


@dataclass
class AgentKeyVerdict:
    """agent 通道单候选解析结果（与 external 的 KeyVerdict 区分）。"""

    status: str  # "ok" | "expired" | "revoked" | "not_found" | "agent_mismatch"
    key: AgentApiKey | None = None
    # last_used_at 是否被本次 stamped（caller 决定 commit/rollback）
    changed: bool = False

    @property
    def ok(self) -> bool:
        return self.status == "ok"


LAST_USED_THROTTLE_SECONDS = 60


def resolve_key_for_agent(
    db: Session,
    candidate: str,
    *,
    agent_id: str,
    now: datetime | None = None,
) -> AgentKeyVerdict:
    """agent 通道解析：严格 agent_id 绑定 + last_used_at 节流。

    与 ``resolve_key``（external 通道、多候选、每次 stamp）不同：
    * ``agent_id IS NULL`` 的存量 key 一律 agent_mismatch（设计稿 §2.2 行为矩阵）；
    * 距上次 stamp 不足 60s 跳过更新，避免高频读造成热写。

    返回前将 row ``expunge`` 成 detached 快照（列属性已加载）——caller 关闭
    会话后仍可安全读 ``verdict.key``；stamp 先 flush 进当前事务，
    commit/rollback 仍由 caller 决定。

    判定顺序（BLF-468）：``not_found → deleted → revoked → expired →
    agent_mismatch``。已删除 Key 落入 ``not_found``（无认证机会），且
    先于 revoked 判定——防止删除后被误激活的 Key 复活认证。
    """
    now = now or datetime.now(timezone.utc)
    row = db.scalars(
        select(AgentApiKey).where(AgentApiKey.key_hash == hash_key(candidate))
    ).first()
    if row is None:
        return AgentKeyVerdict(status="not_found")
    # 已删除 Key 永不认证（BLF-468），先于 revoked 判定
    if row.deleted_at is not None:
        db.expunge(row)
        return AgentKeyVerdict(status="not_found", key=row)
    if row.is_revoked:
        db.expunge(row)
        return AgentKeyVerdict(status="revoked", key=row)
    if row.expires_at is not None:
        expires = row.expires_at
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=timezone.utc)
        if expires <= now:
            db.expunge(row)
            return AgentKeyVerdict(status="expired", key=row)
    if row.agent_id is None or row.agent_id != agent_id:
        db.expunge(row)
        return AgentKeyVerdict(status="agent_mismatch", key=row)

    changed = False
    last = row.last_used_at
    if last is not None and last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    if last is None or (now - last).total_seconds() >= LAST_USED_THROTTLE_SECONDS:
        row.last_used_at = now
        db.flush()  # stamp 写入当前事务；caller commit 才落库
        changed = True
    db.expunge(row)
    return AgentKeyVerdict(status="ok", key=row, changed=changed)


def create_api_key(
    db: Session,
    *,
    label: str,
    created_by: str,
    scope: str = "read",
    project_scope: str = "*",
    business_scope: str = "*",
    expires_at: datetime | None = None,
    agent_id: str | None = None,
) -> tuple[AgentApiKey, str]:
    """Create a key and return ``(record, plaintext)``.

    The plaintext is only available here — the stored row holds the hash.
    ``agent_id`` 非空即"Agent 凭据"（必须与调用时的 X-Agent-Id 头一致）；
    留空为存量 external 语义。``project_scope`` 为项目范围白名单
    （"," 分隔 project_id；"*" = 全部，即本任务启用前的存量语义）；
    ``business_scope`` 为业务域范围白名单（"," 分隔域 code；"*" = 全部）；
    ``label`` 即「名称」，也是 Agent 的中文显示名（BLF-471：运营对接时在
    「名称」字段写好对应名称，日志与前端按 label 展示）。
    校验逻辑见 ``app/api/agent/scope.py``。Caller commits.
    """
    plaintext, key_hash, key_prefix = generate_key()
    record = AgentApiKey(
        key_hash=key_hash,
        key_prefix=key_prefix,
        label=label[:128],
        scope=scope[:64],
        project_scope=(project_scope or "*")[:255],
        business_scope=(business_scope or "*")[:255],
        expires_at=expires_at,
        created_by=created_by[:128],
        agent_id=agent_id[:128] if agent_id else None,
    )
    db.add(record)
    db.flush()  # populate record.id before the caller commits
    return record, plaintext


def list_api_keys(db: Session, *, include_deleted: bool = False) -> list[AgentApiKey]:
    """All keys, newest first (admin list view).

    BLF-468：默认隐藏已删除 Key（``deleted_at IS NOT NULL``）；传
    ``include_deleted=True`` 审计/回溯全量。
    """
    stmt = select(AgentApiKey).order_by(AgentApiKey.created_at.desc())
    if not include_deleted:
        stmt = stmt.where(AgentApiKey.deleted_at.is_(None))
    return list(db.scalars(stmt))


def list_agent_keys(db: Session) -> list[AgentApiKey]:
    """仅绑定了 agent_id 的 key，最新在前。"""
    return list(
        db.scalars(
            select(AgentApiKey)
            .where(AgentApiKey.agent_id.is_not(None))
            .order_by(AgentApiKey.created_at.desc())
        )
    )


def get_api_key(db: Session, key_id: int) -> AgentApiKey | None:
    return db.get(AgentApiKey, key_id)


def revoke_api_key(db: Session, key_id: int) -> AgentApiKey | None:
    """Soft-revoke a key（idempotent，已删除 Key 返 None）。Caller commits.

    术语重命名（BLF-468）：语义即"停用 / Deactivate"，原 ``/revoke`` 端点保留
    为兼容别名；新前端统一走 ``/deactivate``。
    """
    record = db.get(AgentApiKey, key_id)
    if record is None:
        return None
    # 已删除 Key 不允许重新启用后再停用——防止绕过删除保护（BLF-468 安全红线）
    if record.deleted_at is not None:
        return None
    record.is_revoked = True
    return record


def activate_api_key(db: Session, key_id: int) -> AgentApiKey | None:
    """取消停用（BLF-468）。幂等；已删除 Key 返 None。

    Caller commits。返回的 ``is_revoked=False``。
    """
    record = db.get(AgentApiKey, key_id)
    if record is None:
        return None
    # 已删除 Key 不能激活——避免复活一个已删除的 Key 重新认证（设计稿 §5.3）
    if record.deleted_at is not None:
        return None
    record.is_revoked = False
    return record


def delete_api_key(db: Session, key_id: int) -> AgentApiKey | None:
    """软删除 Key（BLF-468，幂等）。

    返回首次置 ``deleted_at`` 的行；若 Key 已是已删除状态，仍返回该行（调用方
    可据此区分 200 vs 204）。不存在 Key 返 None。Caller commits。
    """
    record = db.get(AgentApiKey, key_id)
    if record is None:
        return None
    if record.deleted_at is None:
        record.deleted_at = datetime.now(timezone.utc)
    return record


def resolve_key(db: Session, candidates: list[str]) -> KeyVerdict:
    """Match candidate secrets to a stored key and classify the result.

    On a usable match the key's ``last_used_at`` is stamped (dirty on the
    session — caller commits). Revoked / expired keys are reported with
    their specific status so the API layer can return a clear 401.

    判定顺序（BLF-468）：``not_found → deleted → revoked → expired``。已删除
    Key 永不认证，且先于 revoked——避免删除后误激活复活。
    """
    if not candidates:
        return KeyVerdict(status="not_found")

    hashes = [hash_key(c) for c in candidates]
    # Deterministic precedence: earliest-created key wins if two candidates
    # happen to match (they won't in practice — hashes are unique).
    rows = list(
        db.scalars(
            select(AgentApiKey)
            .where(AgentApiKey.key_hash.in_(hashes))
            .order_by(AgentApiKey.id.asc())
        )
    )
    if not rows:
        return KeyVerdict(status="not_found")

    key = rows[0]
    # 已删除 Key 不认证（BLF-468），先于 revoked 判定
    if key.deleted_at is not None:
        return KeyVerdict(status="not_found", key=key)
    if key.is_revoked:
        return KeyVerdict(status="revoked", key=key)
    if key.expires_at is not None:
        expires = key.expires_at
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=timezone.utc)
        if expires <= datetime.now(timezone.utc):
            return KeyVerdict(status="expired", key=key)

    key.last_used_at = datetime.now(timezone.utc)
    return KeyVerdict(status="ok", key=key)
