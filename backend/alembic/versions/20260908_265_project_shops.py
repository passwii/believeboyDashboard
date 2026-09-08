"""创建项目与真实店铺 ID 的映射表（BLF-990）。"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "265"
down_revision: Union[str, None] = "264"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "project_shops",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column(
            "project_id",
            sa.BigInteger().with_variant(sa.Integer(), "sqlite"),
            nullable=False,
        ),
        sa.Column("country", sa.String(length=2), nullable=False),
        sa.Column("shop_id", sa.String(length=64), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["project_id"], ["projects.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.CheckConstraint(
            "country in ('US', 'DE', 'UK')", name="ck_project_shops_country"
        ),
        sa.CheckConstraint(
            "length(trim(shop_id)) > 0", name="ck_project_shops_shop_id_nonempty"
        ),
        sa.UniqueConstraint(
            "project_id", "country", name="uq_project_shops_project_country"
        ),
        sa.UniqueConstraint("shop_id", name="uq_project_shops_shop_id"),
    )
    op.create_index(
        "idx_project_shops_project_country",
        "project_shops",
        ["project_id", "country"],
    )


def downgrade() -> None:
    op.drop_index(
        "idx_project_shops_project_country", table_name="project_shops"
    )
    op.drop_table("project_shops")
