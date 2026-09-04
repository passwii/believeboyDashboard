"""Add shipment_batch to shipment_schedules

Revision ID: 20260710_207
Revises: 20260710_206
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20260710_207"
down_revision = "20260710_206"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "shipment_schedules",
        sa.Column("shipment_batch", sa.String(length=100), nullable=True),
    )
    op.create_index(
        "idx_shipment_schedules_batch",
        "shipment_schedules",
        ["shipment_batch"],
    )


def downgrade() -> None:
    op.drop_index("idx_shipment_schedules_batch", table_name="shipment_schedules")
    op.drop_column("shipment_schedules", "shipment_batch")
