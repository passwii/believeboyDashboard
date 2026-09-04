"""Fix return_analysis unique key to allow multi-unit returns

Revision ID: 20260413_092
Revises: 20260413_091
Create Date: 2026-04-13
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "20260413_092"
down_revision: Union[str, None] = "20260413_091"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_constraint(
        "uq_return_record_key",
        "return_analysis_records",
        type_="unique",
    )
    op.create_unique_constraint(
        "uq_return_record_key",
        "return_analysis_records",
        [
            "project_id",
            "country",
            "order_id",
            "sku",
            "original_return_datetime",
            "license_plate_number",
        ],
    )


def downgrade() -> None:
    op.drop_constraint(
        "uq_return_record_key",
        "return_analysis_records",
        type_="unique",
    )
    op.create_unique_constraint(
        "uq_return_record_key",
        "return_analysis_records",
        [
            "project_id",
            "country",
            "order_id",
            "sku",
            "original_return_datetime",
        ],
    )
