"""projects 表新增 country 站点列（默认美国站 US）

Revision ID: 261
Revises: 260
Create Date: 2026-09-03 10:24:57.360665
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "261"
down_revision: Union[str, None] = "260"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "projects",
        sa.Column(
            "country",
            sa.String(length=2),
            nullable=False,
            server_default="US",
        ),
    )


def downgrade() -> None:
    op.drop_column("projects", "country")
