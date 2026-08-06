"""new_product_calculations 加溯源列 source / observed_at（BLF-451 D1 拍板 = A）

Revision ID: 237
Revises: 236
Create Date: 2026-08-06 16:09:46.042073

BLF-451 新品测算 Agent API 的 D1 决策（已拍板 = 加列）：``new_product_calculations``
之前无 ``source`` / ``observed_at``（溯源仅靠审计表）。加列后 agent W1 写入声明
采集渠道，快照行自身可溯源，对齐店铺域（迁移 229 同款语义）。

1. ``source``（String(32), nullable）—— 写入来源。
   agent 通道取值 ``{agent_listing_pull, agent_review_scrape, agent_market_research,
   external_api}``；存量行 / 内部端点保持 NULL（不强填，避免 backfill 语义误判）。
2. ``observed_at``（DateTime(timezone=True), nullable）—— 观测时刻。
   agent 写入缺省后端取 now()；NULL 兼容存量行与内部端点。

为什么 nullable 不加 NOT NULL：本表 upsert 语义 + 内部端点（人工写入）不传溯源
字段，加 NOT NULL 需要 backfill 占位值，会污染语义；nullable + 应用层写入时填充
即可（与迁移 229 的强制 backfill 不同——那是 append-only 时间序列需要每行时间戳，
这里是 upsert 快照 + 审计表兜底溯源）。
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "237"
down_revision: Union[str, None] = "236"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "new_product_calculations",
        sa.Column(
            "source",
            sa.String(length=32),
            nullable=True,
            comment=(
                "写入来源：agent_listing_pull / agent_review_scrape / "
                "agent_market_research / external_api（agent 通道必填；"
                "内部端点与存量行为 NULL）"
            ),
        ),
    )
    op.add_column(
        "new_product_calculations",
        sa.Column(
            "observed_at",
            sa.DateTime(timezone=True),
            nullable=True,
            comment="观测时刻；agent 写入缺省后端取 now()",
        ),
    )


def downgrade() -> None:
    op.drop_column("new_product_calculations", "observed_at")
    op.drop_column("new_product_calculations", "source")
