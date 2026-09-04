"""inspection_reports 新增 country 站点列，唯一键改为 (period_id, project_id, country)

Revision ID: 262
Revises: 261
Create Date: 2026-09-03 19:49:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "262"
down_revision: Union[str, None] = "261"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. 加 country 列（默认 US，对齐 projects 表 country 默认值）
    op.add_column(
        "inspection_reports",
        sa.Column(
            "country",
            sa.String(length=2),
            nullable=False,
            server_default="US",
        ),
    )
    # 2. 旧唯一键改为 (period_id, project_id, country)
    op.drop_constraint(
        "uq_inspection_reports_period_project", "inspection_reports", type_="unique"
    )
    op.create_unique_constraint(
        "uq_inspection_reports_period_project_country",
        "inspection_reports",
        ["period_id", "project_id", "country"],
    )
    # 3. 加索引加速按国家过滤
    op.create_index(
        "idx_inspection_reports_project_country",
        "inspection_reports",
        ["project_id", "country"],
    )


def downgrade() -> None:
    op.drop_index("idx_inspection_reports_project_country", table_name="inspection_reports")
    op.drop_constraint(
        "uq_inspection_reports_period_project_country",
        "inspection_reports",
        type_="unique",
    )
    op.create_unique_constraint(
        "uq_inspection_reports_period_project",
        "inspection_reports",
        ["period_id", "project_id"],
    )
    op.drop_column("inspection_reports", "country")
