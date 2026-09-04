"""add ai_messages.model and ai_chat_token_usage_snapshots

Revision ID: 228
Revises: 227
Create Date: 2026-08-02

BEL-379 token-usage 统计层（前端 Seth 已落地 UI，本迁移提供数据源）：

1. ``ai_messages.model`` 列：当前 model 只在 SSE 事件中传给客户端、未落库，
   无法按 model 聚合。新增 nullable String(64)，backfill 已有行为 'unknown'。
   新写入由 V2 ``_prepare_conversation_turn``（``ai_chat_v2._first_request_stream``
   调用，详见 ``api/v1/endpoints/ai_chat_v2.py:117``）从
   ``payload.model or 'unknown'`` 写入。**不**加单独索引 —— Celery 任务按
   ``created_at`` 范围扫 + GROUP BY model，单列索引收益低、写放大高。

2. ``ai_chat_token_usage_snapshots`` 表：每日 03:15 CST 由 Celery
   ``ai_chat_token_usage.refresh_daily`` 按 (user_id × data_date × model) 写
   聚合快照，供 ``GET /api/v1/ai/usage/stats`` 读端点消费。

   - 主键 id INTEGER（与 alert_rule.py 屋风一致）
   - 唯一键 (user_id, data_date, model) —— 增量 upsert 友好
   - (user_id, data_date) 索引 —— 范围扫描
   - message_count / conversation_count 为「当日」口径，区间求和时
     message_count 准确，conversation_count 是 ∑ 每日 distinct-conv（单日
     等于真实 distinct，跨日为上界；stats 端点有字段语义注释）
   - 不做 user_id 外键（与 ``ai_conversations.user_id`` 对齐，避免耦合 users 表）
   - data_date 为 CST(Asia/Shanghai) 日期，与 Celery beat timezone 一致
"""

from alembic import op
import sqlalchemy as sa


revision = "228"
down_revision = "227"
branch_labels = None
depends_on = None


UNKNOWN_MODEL_SENTINEL = "unknown"


def upgrade() -> None:
    # 1) ai_messages.model：先加列（nullable 兼容历史），再 backfill，最后 NOT NULL
    with op.batch_alter_table("ai_messages") as batch_op:
        batch_op.add_column(
            sa.Column(
                "model",
                sa.String(length=64),
                nullable=True,
                comment=(
                    "实际使用的模型标识；'unknown' 表示历史未记录或解析失败。"
                    "聚合按 (user_id × data_date × model) 切分。"
                ),
            )
        )
    # backfill：历史行没有 model 信息，置为 'unknown' 哨兵，避免聚合漏掉
    op.execute(
        f"UPDATE ai_messages SET model = '{UNKNOWN_MODEL_SENTINEL}' WHERE model IS NULL"
    )
    with op.batch_alter_table("ai_messages") as batch_op:
        batch_op.alter_column(
            "model", nullable=False, server_default=UNKNOWN_MODEL_SENTINEL
        )

    # 2) ai_chat_token_usage_snapshots
    op.create_table(
        "ai_chat_token_usage_snapshots",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column(
            "user_id",
            sa.BigInteger(),
            nullable=False,
            comment="请求 X-User-Id 注入；与 ai_conversations.user_id 同源",
        ),
        sa.Column(
            "data_date",
            sa.Date(),
            nullable=False,
            comment="CST(Asia/Shanghai) 日期：当日 00:00–次日 00:00 累计的 token 写入此行",
        ),
        sa.Column(
            "model",
            sa.String(length=64),
            nullable=False,
            comment="模型标识；'unknown' 表示历史未记录的 message",
        ),
        sa.Column(
            "prompt_tokens",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
        sa.Column(
            "completion_tokens",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
        sa.Column(
            "total_tokens",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
        sa.Column(
            "message_count",
            sa.Integer(),
            nullable=False,
            server_default="0",
            comment="当日该 (user, model) 下的消息条数；区间求和 = 真实消息数",
        ),
        sa.Column(
            "conversation_count",
            sa.Integer(),
            nullable=False,
            server_default="0",
            comment="当日该 (user, model) 下 distinct conversation 数；区间求和为上界",
        ),
        sa.Column(
            "data_version",
            sa.Integer(),
            nullable=False,
            server_default="1",
            comment="数据版本号；upsert 每次 +1，便于审计",
        ),
        sa.Column(
            "computed_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "user_id",
            "data_date",
            "model",
            name="uq_ai_chat_token_usage_user_date_model",
        ),
    )
    op.create_index(
        "idx_ai_chat_token_usage_user_date",
        "ai_chat_token_usage_snapshots",
        ["user_id", "data_date"],
    )


def downgrade() -> None:
    op.drop_index(
        "idx_ai_chat_token_usage_user_date", table_name="ai_chat_token_usage_snapshots"
    )
    op.drop_table("ai_chat_token_usage_snapshots")
    with op.batch_alter_table("ai_messages") as batch_op:
        batch_op.drop_column("model")
