"""crm reclaim settings — 公海回收按价值差异化 (P9-3, BLF-541)

Revision ID: 248
Revises: 245
Create Date: 2026-08-09

P9-3 公海回收按价值差异化（BLF-541）：
- ``crm_reclaim_settings``：单行配置表（id=1 固定行），按 P6a 价值档位
  差异化公海回收：
  - ``exempt_ratings``（默认 "A"）：永不回收的档位（roadmap 文案 S/A 中
    S 档在 P6a 不存在，实际最高档 = A）。
  - ``rating_b_days`` / ``rating_c_days``（默认 7）：B/C 档 N 天无跟进回收
    （roadmap P9.2「B/C 7 天回」）。
  - ``rating_d_days``（默认 NULL）：D 档未显式配置时回落
    ``settings.crm_sea_reclaim_days``（保持 P3a 现有行为不变）。
- 线索无价值评分（P6a rating 仅客户表），回收策略维持原样（全局阈值）。

注：revision 248 挂在当前 main head 245 下（单链）；PR #196（BLF-540）的
246 尚未合入，若后续合并会产生双 head，按 BEL-492 在 main 侧执行
``alembic merge heads`` 合回单链。
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "248"
down_revision: Union[str, None] = "245"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not inspector.has_table("crm_reclaim_settings"):
        op.create_table(
            "crm_reclaim_settings",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column(
                "exempt_ratings",
                sa.String(64),
                nullable=False,
                server_default="A",
            ),
            sa.Column(
                "rating_b_days",
                sa.Integer(),
                nullable=True,
                server_default="7",
            ),
            sa.Column(
                "rating_c_days",
                sa.Integer(),
                nullable=True,
                server_default="7",
            ),
            # D 档默认 NULL → 回落 settings.crm_sea_reclaim_days（P3a 现状）
            sa.Column("rating_d_days", sa.Integer(), nullable=True),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.func.now(),
            ),
            sa.Column(
                "updated_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.func.now(),
            ),
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if inspector.has_table("crm_reclaim_settings"):
        op.drop_table("crm_reclaim_settings")
