"""inventory_replenishment_settings add target_days (BLF-630 二轮)

Revision ID: 255
Revises: 254
Create Date: 2026-08-11 14:17:52.226683
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "255"
down_revision: Union[str, None] = "254"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # BLF-630 二轮：目标覆盖天数（补货量动态化基准），默认 90 天
    op.add_column(
        "inventory_replenishment_settings",
        sa.Column("target_days", sa.Integer(), nullable=False, server_default="90"),
    )
    op.create_check_constraint(
        "ck_inventory_replenishment_settings_target_days",
        "inventory_replenishment_settings",
        "target_days >= 0",
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_inventory_replenishment_settings_target_days",
        "inventory_replenishment_settings",
        type_="check",
    )
    op.drop_column("inventory_replenishment_settings", "target_days")
