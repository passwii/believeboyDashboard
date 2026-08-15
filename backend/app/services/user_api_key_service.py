"""用户专属 API Key 服务（BLF-711 C2 方案）。

职责：
* ``ensure_user_api_key`` —— 登录成功路径：轮换（旧 key 立即失效 + 下发新 key）
  并返回明文一次。hash-only 存储下无法回显旧明文，所以"已有 key"的语义
  是"再发一把新的"，天然满足每次登录都能拿到可用 key（桌面端换机/清 Keychain
  后重登即自愈，无需管理员介入）。
* ``resolve_user_key`` —— ``require_api_key`` 鉴权路径：按 hash 反查，
  ``revoked`` 状态明确区分（吊销后的 key 一律 403，即便已换新）。
* ``revoke_user_key`` / ``rotate_user_key`` —— 管理员吊销/轮换端点。

安全要点：
* 只存 SHA-256 hash，明文只在生成瞬间返回一次；
* 主 key（``settings.api_key``）永不参与本表——web / Agent 外部调用零影响；
* 登录限流（auth.py：IP 10 次/15min）约束了轮换写放大。
"""

from __future__ import annotations

import hashlib
import secrets
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.user_api_key import UserApiKey

# 可读前缀，方便日志/管理界面区分用户 key（对齐 agent key 的 ``bbx_`` 风格）。
KEY_PREFIX = "blf_"
# 密钥部分随机字节数（32 → 43 个 url-safe 字符）。
KEY_SECRET_BYTES = 32


def _normalize_user_id(user_id: str | uuid.UUID) -> uuid.UUID:
    """统一入参形态为 ``uuid.UUID``（auth 传的是 ``user_accounts.id::text``）。"""
    if isinstance(user_id, uuid.UUID):
        return user_id
    return uuid.UUID(str(user_id))


def hash_key(plaintext: str) -> str:
    """SHA-256 hex digest —— 存储与鉴权反查用的唯一形态。"""
    return hashlib.sha256(plaintext.encode("utf-8")).hexdigest()


def generate_key() -> tuple[str, str, str]:
    """返回 ``(plaintext, key_hash, key_prefix)`` 一把全新 key。"""
    plaintext = f"{KEY_PREFIX}{secrets.token_urlsafe(KEY_SECRET_BYTES)}"
    # 前缀取前 12 位（如 ``blf_ab12cd34``）：可识别不泄露密钥尾部。
    return plaintext, hash_key(plaintext), plaintext[:12]


@dataclass
class UserKeyVerdict:
    """鉴权路径的匹配结论。"""

    status: str  # "ok" | "revoked" | "not_found"
    user_id: str | None = None
    key_id: int | None = None

    @property
    def ok(self) -> bool:
        return self.status == "ok"


def ensure_user_api_key(
    db: Session, user_id: str | uuid.UUID
) -> tuple[UserApiKey, str]:
    """登录成功路径：为该用户签发（或轮换）专属 key，返回 (记录, 明文)。

    hash-only 存储决定了这里必然是"轮换"语义——旧 key 的明文无法回显，
    而每次登录都应下发一把可用 key（否则桌面端清 Keychain 后重登会卡死）。
    轮换即旧 key 立即失效：单用户同时只在最近一次登录的客户端持有有效 key，
    泄露面最小；已被吊销的 key 在下次登录时自动自愈。
    """
    user_uuid = _normalize_user_id(user_id)
    plaintext, key_hash, key_prefix = generate_key()
    row = db.scalars(select(UserApiKey).where(UserApiKey.user_id == user_uuid)).first()
    if row is None:
        row = UserApiKey(
            user_id=user_uuid,
            key_hash=key_hash,
            key_prefix=key_prefix,
            revoked_at=None,
        )
        db.add(row)
    else:
        row.key_hash = key_hash
        row.key_prefix = key_prefix
        row.revoked_at = None
        row.created_at = datetime.now(timezone.utc)
    db.flush()  # 让 caller 的事务决定 commit/rollback
    return row, plaintext


def resolve_user_key(db: Session, candidate: str) -> UserKeyVerdict:
    """鉴权路径：按 hash 精确反查（每次请求最多一次）。

    判定顺序：``not_found → revoked``。命中且未吊销即放行。
    """
    row = db.scalars(
        select(UserApiKey).where(UserApiKey.key_hash == hash_key(candidate))
    ).first()
    if row is None:
        return UserKeyVerdict(status="not_found")
    if row.revoked_at is not None:
        return UserKeyVerdict(status="revoked", user_id=str(row.user_id), key_id=row.id)
    return UserKeyVerdict(status="ok", user_id=str(row.user_id), key_id=row.id)


def revoke_user_key(db: Session, user_id: str | uuid.UUID) -> UserApiKey | None:
    """管理员吊销：写入 revoked_at（幂等，未找到返回 None）。"""
    row = db.scalars(
        select(UserApiKey).where(UserApiKey.user_id == _normalize_user_id(user_id))
    ).first()
    if row is None:
        return None
    row.revoked_at = datetime.now(timezone.utc)
    db.flush()
    return row


def rotate_user_key(
    db: Session, user_id: str | uuid.UUID
) -> tuple[UserApiKey, str] | None:
    """管理员轮换：吊销旧 key 并签发新 key，返回 (记录, 明文) 一次。

    与 ``ensure_user_api_key`` 同语义（覆盖同一行），返回明文仅供本次展示。
    未找到记录返回 None（由端点 404）——补发 key 的自然路径是登录下发
    （FK 指向 user_accounts，无真实用户的 user_id 无法建行）。
    """
    user_uuid = _normalize_user_id(user_id)
    plaintext, key_hash, key_prefix = generate_key()
    row = db.scalars(select(UserApiKey).where(UserApiKey.user_id == user_uuid)).first()
    if row is None:
        return None
    row.key_hash = key_hash
    row.key_prefix = key_prefix
    row.revoked_at = None
    row.created_at = datetime.now(timezone.utc)
    db.flush()
    return row, plaintext
