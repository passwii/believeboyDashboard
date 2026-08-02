from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.session import Base


class AIConversation(Base):
    """AI Chat 会话表。

    归属：`user_id` 来自请求的 `X-User-Id` header（外层 proxy 注入）。
    service 层 `get_conversation_or_404` 强制校验归属；不匹配返回 404
    （不暴露存在性，与 `get_message_or_404` 一致）。`user_id` 为 NULL
    的历史会话不会被任何用户看到，等价于"老数据隐藏"。
    """

    __tablename__ = "ai_conversations"

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"),
        primary_key=True,
        autoincrement=True,
    )
    user_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True, index=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False, default="新对话")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )
    total_prompt_tokens: Mapped[int] = mapped_column(Integer, default=0)
    total_completion_tokens: Mapped[int] = mapped_column(Integer, default=0)
    total_tokens: Mapped[int] = mapped_column(Integer, default=0)

    messages: Mapped[list["AIMessage"]] = relationship(
        back_populates="conversation",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="AIMessage.created_at",
    )


class AIMessage(Base):
    """AI Chat 消息表。

    归属由所属 `AIConversation.user_id` 派生（不再单独存 user_id），
    隔离校验在 service 层 `get_conversation_or_404` 集中完成。
    """

    __tablename__ = "ai_messages"

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"),
        primary_key=True,
        autoincrement=True,
    )
    conversation_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"),
        ForeignKey("ai_conversations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    role: Mapped[str] = mapped_column(String(32), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    search_sources: Mapped[str | None] = mapped_column(Text, nullable=True)
    # [BEL-81.B] 联网搜索的时间范围标签：day|week|month|year|all 之一。
    # 用于历史消息回放时在搜索卡片上方渲染时间范围 chip。
    search_time_range: Mapped[str | None] = mapped_column(String(16), nullable=True)
    is_complete: Mapped[bool] = mapped_column(default=False)
    prompt_tokens: Mapped[int] = mapped_column(Integer, default=0)
    completion_tokens: Mapped[int] = mapped_column(Integer, default=0)
    total_tokens: Mapped[int] = mapped_column(Integer, default=0)
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # [BEL-379] 模型标识：聚合按 (user × data_date × model) 切分；'unknown' 为历史 backfill 哨兵。
    # 写入路径：V2 ``_prepare_conversation_turn``（``ai_chat_v2._first_request_stream``）
    # 从 ``payload.model`` 注入；V1 非流式 POST 端点已随 BEL-379.B3-a 删除。
    model: Mapped[str] = mapped_column(
        String(64), nullable=False, default="unknown", server_default="unknown"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    conversation: Mapped[AIConversation] = relationship(back_populates="messages")


class AIChatTokenUsageSnapshot(Base):
    """AI Chat token 用量每日聚合快照（BEL-379 统计层）。

    每日 03:15 CST 由 ``app.celery_tasks.ai_chat_token_usage_refresh.refresh_daily``
    按 ``(user_id, data_date, model)`` 增量 upsert 写入；供
    ``GET /api/v1/ai/usage/stats`` 端点消费，避免在线实时聚合。

    设计要点：
    - 主键 id INTEGER（与 alert_rule.py / analysis_return_aggregates 屋风一致）
    - 唯一键 (user_id, data_date, model) —— Celery 重跑幂等
    - data_date 为 CST(Asia/Shanghai) 日期，与 Celery beat timezone 对齐
    - 不做 user_id 外键（与 ai_conversations.user_id 一致，避免耦合）
    - conversation_count 为「当日 distinct conv」；区间求和时为上界
      （同一 conv 跨多日会被多次计入），stats 端点有字段语义注释
    """

    __tablename__ = "ai_chat_token_usage_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(BigInteger, nullable=False, index=True)
    data_date = mapped_column(Date, nullable=False)
    model: Mapped[str] = mapped_column(String(64), nullable=False)
    prompt_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    completion_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    message_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    conversation_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    data_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    computed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
