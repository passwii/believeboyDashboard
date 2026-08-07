"""Agent API key（BEL-377 external_api_keys 改名而来，见 Agent API 设计稿 §11）。

``/api/v1/agent/*`` 命名空间的应用层凭据；过渡期同时覆盖
``/api/v1/external/*`` 的存量 key。只存 SHA-256 hash，明文仅在创建时
（``POST /api/v1/internal/api-keys``）返回一次。

House style 对齐 ``alert_rule.py``：``Integer`` 主键、``Mapped`` 注解、
带 server default 的时区感知时间戳。
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, Index, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class AgentApiKey(Base):
    __tablename__ = "agent_api_keys"
    __table_args__ = (
        Index("idx_aak_key_hash", "key_hash", unique=True),
        Index("idx_aak_revoked_expires", "is_revoked", "expires_at"),
        Index("idx_aak_agent_id", "agent_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # SHA-256 hex digest (64 chars) of the plaintext key. Unique — this is
    # what the auth path looks up.
    key_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    # Short non-secret prefix (e.g. ``bbx_ab12cd34``) for display in the
    # admin list so operators can tell keys apart without the secret.
    key_prefix: Mapped[str] = mapped_column(String(24), nullable=False)
    label: Mapped[str] = mapped_column(String(128), nullable=False)
    # Reserved for per-key scope restrictions; P0 不启用校验。
    scope: Mapped[str] = mapped_column(String(64), nullable=False, default="read")
    is_revoked: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_by: Mapped[str] = mapped_column(String(128), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    last_used_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # 绑定的 Agent 稳定标识（业务主键，外部 Agent 平台生成）。
    # 存量 external key 为 NULL → 只能读遗留 /external/* 命名空间。
    agent_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    # Agent 中文显示名（BLF-471）：英文 agent_id 对应的中文名，运营/管理员
    # 在日志与前端查看时使用；未填写（存量）时前端回退显示 agent_id。
    agent_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    # 预留授权范围（设计稿 §9 #2），P0 不强制校验。
    project_scope: Mapped[str] = mapped_column(
        String(255), nullable=False, server_default="*"
    )
    # 业务域授权范围（BLF-448）：'*' 全域放行，或 ',' 分隔的域 code 白名单
    # （如 shipments,shop_calculations）。校验见 app/api/agent/scope.py。
    business_scope: Mapped[str] = mapped_column(
        String(255), nullable=False, server_default="*"
    )
    # 软删除 tombstone（BLF-468）：保留审计轨迹，鉴权判定 not_found 在
    # revoked 之前——已删除 Key 永不认证，即使 is_revoked 被误置回。
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
