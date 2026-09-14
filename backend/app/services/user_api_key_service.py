"""用户专属 API Key 服务（BLF-711 C2 方案）。

职责：
* ``ensure_user_api_key`` —— 登录成功路径：**槽内**轮换（同一 ``client_id`` 的
  旧 key 立即失效 + 下发新 key）并返回明文一次。hash-only 存储下无法回显旧明文，
  所以"已有 key"的语义是"再发一把新的"，天然满足每次登录都能拿到可用 key
  （桌面端换机/清 Keychain 后重登即自愈，无需管理员介入）。
* ``resolve_user_key`` —— ``require_api_key`` 鉴权路径：按 hash 反查，
  ``revoked`` 状态明确区分（吊销后的 key 一律 403，即便已换新）。
* ``revoke_user_key`` / ``rotate_user_key`` —— 管理员吊销/轮换端点。

一账号多槽（BLF-1059）：一个账号可有多把 key，按 ``client_id`` 分区；同一槽内
至多一把有效 key（同槽重登 = 轮换），槽间互不影响 —— 这才是"网页端登录不再
顶掉桌面端"的实现口径。不带设备标识的调用方落 ``default`` 槽，语义与拆分前
完全一致（网页端零改动）。

安全要点：
* 只存 SHA-256 hash，明文只在生成瞬间返回一次；
* 主 key（``settings.api_key``）永不参与本表——web / Agent 外部调用零影响；
* 登录限流（auth.py：IP 10 次/15min）约束了轮换写放大。
"""

from __future__ import annotations

import hashlib
import logging
import re
import secrets
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.user_api_key import DEFAULT_CLIENT_ID, UserApiKey

logger = logging.getLogger(__name__)

# 可读前缀，方便日志/管理界面区分用户 key（对齐 agent key 的 ``bbx_`` 风格）。
KEY_PREFIX = "blf_"
# 密钥部分随机字节数（32 → 43 个 url-safe 字符）。
KEY_SECRET_BYTES = 32
# 槽标识列宽（String(64)）——超长直接拒，不做截断（截断会静默制造槽碰撞）。
CLIENT_ID_MAX_LENGTH = 64
# 每账号最多几把**有效** key；超限回收最旧的一把（不拒绝登录，见 _evict_over_limit）。
MAX_ACTIVE_KEYS_PER_USER = 5
# 允许的槽标识字符集：UUID / 主机名 / 安装 id 都在内，又挡住空白与控制字符。
# 用 ``fullmatch`` 而非 ``^...$``：``$`` 在 Python 里能匹配尾随换行前的位置，
# 锚点会让 ``"abc\n"`` 这类值蒙混过关（``\Z`` 才等价于 fullmatch 的语义）。
_CLIENT_ID_RE = re.compile(r"[A-Za-z0-9._:\-]+")


def _normalize_user_id(user_id: str | uuid.UUID) -> uuid.UUID:
    """统一入参形态为 ``uuid.UUID``（auth 传的是 ``user_accounts.id::text``）。"""
    if isinstance(user_id, uuid.UUID):
        return user_id
    return uuid.UUID(str(user_id))


def normalize_client_id(client_id: str | None) -> str:
    """归一设备槽标识：``None`` / ``""`` → ``default``；其余按**原始值**严格校验。

    三条硬规则（BLF-1059 契约：``[A-Za-z0-9._:-]``，≤64 字符）：

    1. **不 strip**：``" mac-install-a "`` 若被归一成 ``mac-install-a``，就等于让
       一个非法标识**别名**到一台合法设备的槽——发错标识的客户端会顶掉真正那台
       设备的 key，且两边都难以察觉（这正是拆分前"互相顶掉"最难排查的形态）。
       含首尾空白 / 内部空白 / 制表符 / 换行等控制字符一律 ``ValueError`` → 400。
    2. **只有 ``None`` 与 ``""`` 走 ``default``**：二者语义上等价于"没带这个
       标识"（网页端代理、拆分前发布的桌面端构建、HTTP 里空 header），必须与
       拆分前行为一致，故保留这条兼容规则。全空白（``"   "``）**不算**——
       它是含空白的非法值（见规则 1），不再被当成"空标识"降级。
    3. **不静默降级**：非法标识若悄悄落到 ``default``，发错标识的设备就会与
       网页端共用一把 key（又回到互相顶掉的老毛病）且难排查；这里直接报错，
       由调用方转 400。长度与列宽（``String(64)``）一致，超长拒绝而非截断——
       截断会让两个不同的设备标识撞成同一槽。
    """
    # 空串 / None = "没带标识" → 缺省槽（兼容规则）。注意：此处**不做** strip，
    # 只看原始值是否为 ""：`" "` 之类的全空白是非法值而不是空值。
    if client_id is None or client_id == "":
        return DEFAULT_CLIENT_ID
    if len(client_id) > CLIENT_ID_MAX_LENGTH or not _CLIENT_ID_RE.fullmatch(client_id):
        raise ValueError(f"invalid client_id: {client_id!r}")
    return client_id


def hash_key(plaintext: str) -> str:
    """SHA-256 hex digest —— 存储与鉴权反查用的唯一形态。"""
    return hashlib.sha256(plaintext.encode("utf-8")).hexdigest()


def generate_key() -> tuple[str, str, str]:
    """返回 ``(plaintext, key_hash, key_prefix)`` 一把全新 key。"""
    plaintext = f"{KEY_PREFIX}{secrets.token_urlsafe(KEY_SECRET_BYTES)}"
    # 前缀取前 12 位（如 ``blf_ab12cd34``）：可识别不泄露密钥尾部。
    return plaintext, hash_key(plaintext), plaintext[:12]


@dataclass
class UserKeyRevokeResult:
    """一次吊销的结果。

    ``matched`` = 选择器命中的全部行（含此前已吊销的，用于区分"没这个槽"与
    "早就吊销了"）；``revoked`` = 本次真正写入 ``revoked_at`` 的行。
    """

    matched: list[UserApiKey] = field(default_factory=list)
    revoked: list[UserApiKey] = field(default_factory=list)

    @property
    def found(self) -> bool:
        """选择器是否命中任何行（端点据此 404）。"""
        return bool(self.matched)


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
    db: Session,
    user_id: str | uuid.UUID,
    client_id: str | None = DEFAULT_CLIENT_ID,
) -> tuple[UserApiKey, str]:
    """登录成功路径：为该账号在 ``client_id`` 槽签发（或槽内轮换）key。

    hash-only 存储决定了这里必然是"轮换"语义——旧 key 的明文无法回显，
    而每次登录都应下发一把可用 key（否则桌面端清 Keychain 后重登会卡死）。
    轮换**只作用于本槽**：同槽重登 → 该设备旧 key 立即失效；其它槽（其它设备、
    或网页端的 ``default`` 槽）手里的 key 继续有效。已被吊销的 key 在下次登录
    时自动自愈（同一行被复用，行数不随登录次数增长）。

    ``client_id`` 缺省 ``default``：不带设备标识的调用方全部落同一槽，行为与
    BLF-1059 拆分前完全一致。
    """
    user_uuid = _normalize_user_id(user_id)
    slot = normalize_client_id(client_id)
    plaintext, key_hash, key_prefix = generate_key()
    row = db.scalars(
        select(UserApiKey).where(
            UserApiKey.user_id == user_uuid, UserApiKey.client_id == slot
        )
    ).first()
    if row is None:
        row = UserApiKey(
            user_id=user_uuid,
            client_id=slot,
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
    _evict_over_limit(db, user_uuid)
    return row, plaintext


def _evict_over_limit(db: Session, user_uuid: uuid.UUID) -> list[UserApiKey]:
    """把该账号的**有效** key 数压回 ``MAX_ACTIVE_KEYS_PER_USER``：撤销最旧的几把。

    回收而不是拒绝登录：拒绝会把用户直接锁在门外（他手里那把 key 还是有效的，
    但新设备永远登录不进来）；回收最旧的一把则"登录一定成功、只有最久没用的
    设备需要重登"。写 revoked_at 而不是删行：保留"谁在何时被回收"的审计轨迹，
    且该设备下次登录时复用这一行（行数不随登录次数增长）。
    """
    active = db.scalars(
        select(UserApiKey)
        .where(UserApiKey.user_id == user_uuid, UserApiKey.revoked_at.is_(None))
        .order_by(UserApiKey.created_at.asc(), UserApiKey.id.asc())
    ).all()
    overflow = len(active) - MAX_ACTIVE_KEYS_PER_USER
    if overflow <= 0:
        return []
    now = datetime.now(timezone.utc)
    evicted = list(active[:overflow])
    for row in evicted:
        row.revoked_at = now
    db.flush()
    logger.info(
        "user API key slot evicted: user_id=%s limit=%d evicted=%s",
        user_uuid,
        MAX_ACTIVE_KEYS_PER_USER,
        [(row.client_id, row.id) for row in evicted],
    )
    return evicted


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


def revoke_user_key(
    db: Session,
    user_id: str | uuid.UUID,
    client_id: str | None = None,
) -> UserKeyRevokeResult:
    """吊销：``client_id=None`` → 该账号**全部设备**；给定则只吊销那一台。

    幂等：已吊销的行保持原 ``revoked_at``（不刷新时间、不重复计入 ``revoked``）。
    选择器命中但全都早已吊销时 ``found`` 仍为真 —— 与拆分前"有行就 200"一致，
    只有"该用户/该槽根本没有 key 行"才 404。
    """
    user_uuid = _normalize_user_id(user_id)
    stmt = select(UserApiKey).where(UserApiKey.user_id == user_uuid)
    if client_id is not None:
        stmt = stmt.where(UserApiKey.client_id == normalize_client_id(client_id))
    matched = db.scalars(stmt).all()
    now = datetime.now(timezone.utc)
    revoked: list[UserApiKey] = []
    for row in matched:
        if row.revoked_at is None:
            row.revoked_at = now
            revoked.append(row)
    db.flush()
    return UserKeyRevokeResult(matched=list(matched), revoked=revoked)


def rotate_user_key(
    db: Session,
    user_id: str | uuid.UUID,
    client_id: str | None = DEFAULT_CLIENT_ID,
) -> tuple[UserApiKey, str] | None:
    """管理员轮换：吊销旧 key 并签发新 key，返回 (记录, 明文) 一次。

    两种粒度：

    * ``client_id`` 给定（缺省 ``default``）→ 只轮换该槽，其它设备不受影响；
      缺省值为 ``default`` 是因为管理面"给这个账号发一把新 key"的历史语义就是
      那把网页端/单 key 时代的主槽。
    * ``client_id=None`` → **一次重置该账号全部设备**：先吊销所有槽，再在
      ``default`` 槽签发新 key（保持 BLF-711 单 key 时代"轮换即旧 key 全失效"
      的语义；端点缺省走这条）。

    该账号从未签发过任何 key 时返回 None（由端点 404）——补发 key 的自然路径是
    登录下发（FK 指向 user_accounts，无真实用户的 user_id 无法建行）。
    """
    user_uuid = _normalize_user_id(user_id)
    if client_id is None:
        existing = db.scalars(
            select(UserApiKey).where(UserApiKey.user_id == user_uuid)
        ).all()
        if not existing:
            return None
        now = datetime.now(timezone.utc)
        for row in existing:
            if row.revoked_at is None:
                row.revoked_at = now
        db.flush()
        return ensure_user_api_key(db, user_uuid, DEFAULT_CLIENT_ID)

    slot = normalize_client_id(client_id)
    plaintext, key_hash, key_prefix = generate_key()
    row = db.scalars(
        select(UserApiKey).where(
            UserApiKey.user_id == user_uuid, UserApiKey.client_id == slot
        )
    ).first()
    if row is None:
        return None
    row.key_hash = key_hash
    row.key_prefix = key_prefix
    row.revoked_at = None
    row.created_at = datetime.now(timezone.utc)
    db.flush()
    return row, plaintext
