"""crm 价值分档 4 维 score 列（P6a）

给 crm_customers 加 4 个可空 String(1) score 列（ABCD 主观打分）。
rating 字段语义升级为「4 维汇总计算档」但本迁移不动（既有列保留，由应用层逻辑重算）。
纯增量，回滚 = drop columns。
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "223"
down_revision: Union[str, None] = "222"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    for col in ("score_scale", "score_pay", "score_fit", "score_coop"):
        op.add_column(
            "crm_customers", sa.Column(col, sa.String(length=1), nullable=True)
        )


def downgrade() -> None:
    for col in ("score_coop", "score_fit", "score_pay", "score_scale"):
        op.drop_column("crm_customers", col)
