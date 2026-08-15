"""用户专属 API Key（BLF-711 C2 方案）。

桌面端 GUI 直连后端，无法像网页端那样由 Vercel 代理自动附加主 key，
因此登录成功后按账号下发一把独立 key（``blf_`` 前缀）。只存
SHA-256 hash 不存明文——DB 泄露 ≠ key 泄露；明文仅在登录 / 管理员
轮换时返回一次。

每个用户至多一行（``user_id`` unique）：登录即轮换（旧 key 立即失效、
下发新 key），无历史版本（hash-only 无法回显旧明文，且轮换本身就该
让旧 key 失效）。吊销用 ``revoked_at`` 时间戳标记（非软删，便于审计）。

``user_id`` 关联 ``user_accounts.id``（原生 UUID，见 ``psql \\d user_accounts``）。
应用层无 ``user_accounts`` ORM 模型（全仓经原生 SQL 访问），模型层不声明
FK（SQLAlchemy 无法解析未映射表），FK 仅建在 Alembic 迁移里（schema 层
仍强制引用完整性 + 级联删除）；表自身主键按仓库约定用 ``Integer``。

House style 对齐 ``agent_api_key.py``：``Mapped`` 注解、带 server default
的时区感知时间戳。
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Index, Integer, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class UserApiKey(Base):
    __tablename__ = "user_api_keys"
    __table_args__ = (
        # 登录鉴权路径按 hash 精确反查（每次请求只查一次）
        Index("idx_uak_key_hash", "key_hash", unique=True),
        # 管理员按用户吊销/轮换
        Index("idx_uak_user_id", "user_id", unique=True),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # 关联 user_accounts.id（BLF-711：每个账号一把独立 key；UUID 主键）
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        nullable=False,
    )
    # SHA-256 hex digest（64 字符）——唯一，鉴权路径按它反查。
    key_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    # 短前缀（如 ``blf_ab12cd34``，前 12 位）：日志/管理列表里区分 key 而不泄露密钥。
    key_prefix: Mapped[str] = mapped_column(String(24), nullable=False)
    # 吊销时间（NULL = 有效）。登录轮换 / 管理员吊销时写入。
    revoked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # 当前 key 的签发时间（轮换时刷新为当下）。
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
