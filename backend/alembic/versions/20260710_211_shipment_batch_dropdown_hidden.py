"""add shipment_batch_dropdown_hidden table

Revision ID: 20260710_210
Revises: 20260710_209
Create Date: 2026-07-10 21:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260710_210"
down_revision: Union[str, None] = "20260710_209"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    dialect = bind.dialect.name
    now_default = sa.text("CURRENT_TIMESTAMP") if dialect == "sqlite" else sa.func.now()

    if "shipment_batch_dropdown_hidden" not in inspector.get_table_names():
        op.create_table(
            "shipment_batch_dropdown_hidden",
            sa.Column(
                "id",
                sa.BigInteger().with_variant(sa.Integer(), "sqlite"),
                primary_key=True,
                autoincrement=True,
            ),
            sa.Column("operator", sa.String(length=255), nullable=False),
            sa.Column(
                "project_id",
                sa.BigInteger().with_variant(sa.Integer(), "sqlite"),
                nullable=False,
            ),
            sa.Column("country", sa.String(length=8), nullable=False),
            sa.Column("shipment_batch", sa.String(length=100), nullable=False),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=now_default,
            ),
            sa.ForeignKeyConstraint(
                ["project_id"], ["projects.id"], ondelete="CASCADE"
            ),
            sa.UniqueConstraint(
                "operator",
                "project_id",
                "country",
                "shipment_batch",
                name="uq_shipment_batch_dropdown_hidden_scope",
            ),
        )
        op.create_index(
            "ix_shipment_batch_dropdown_hidden_operator",
            "shipment_batch_dropdown_hidden",
            ["operator"],
            unique=False,
        )
        op.create_index(
            "ix_shipment_batch_dropdown_hidden_project",
            "shipment_batch_dropdown_hidden",
            ["project_id"],
            unique=False,
        )


def downgrade() -> None:
    op.drop_index(
        "ix_shipment_batch_dropdown_hidden_project",
        table_name="shipment_batch_dropdown_hidden",
    )
    op.drop_index(
        "ix_shipment_batch_dropdown_hidden_operator",
        table_name="shipment_batch_dropdown_hidden",
    )
    op.drop_table("shipment_batch_dropdown_hidden")
