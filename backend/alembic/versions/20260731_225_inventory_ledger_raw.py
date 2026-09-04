"""inventory ledger raw 表

Revision ID: 225
Revises: 224
Create Date: 2026-07-31
"""

from alembic import op
import sqlalchemy as sa

revision = "225"
down_revision = "224"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "inventory_ledger_raw",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("project_id", sa.Integer(), nullable=False),
        sa.Column(
            "report_month",
            sa.Date(),
            nullable=False,
            comment="YYYY-MM-01, ETL partition key",
        ),
        sa.Column("date", sa.Date(), nullable=False, comment="Business date from CSV"),
        sa.Column("fnsku", sa.String(20), nullable=True),
        sa.Column("asin", sa.String(15), nullable=True),
        sa.Column("msku", sa.String(30), nullable=False),
        sa.Column("title", sa.String(500), nullable=True),
        sa.Column(
            "disposition",
            sa.String(20),
            nullable=False,
            comment="SELLABLE / CUSTOMER_DAMAGED / CARRIER_DAMAGED / WAREHOUSE_DAMAGED",
        ),
        sa.Column(
            "location", sa.String(10), nullable=False, comment="FBA warehouse code"
        ),
        sa.Column("starting_balance", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "in_transit_between", sa.Integer(), nullable=False, server_default="0"
        ),
        sa.Column("receipts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "customer_shipments", sa.Integer(), nullable=False, server_default="0"
        ),
        sa.Column("customer_returns", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("vendor_returns", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "warehouse_transfer_io", sa.Integer(), nullable=False, server_default="0"
        ),
        sa.Column("found", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("lost", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("damaged", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("disposed", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("other_events", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("ending_balance", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("unknown_events", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("store", sa.String(50), nullable=True),
        sa.Column(
            "loaded_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.UniqueConstraint(
            "project_id",
            "report_month",
            "date",
            "msku",
            "disposition",
            "location",
            name="uq_ledger_natural_key",
        ),
    )
    op.create_index(
        "idx_ledger_project_month",
        "inventory_ledger_raw",
        ["project_id", "report_month"],
    )
    op.create_index(
        "idx_ledger_project_month_msku",
        "inventory_ledger_raw",
        ["project_id", "report_month", "msku"],
    )
    op.create_index(
        "idx_ledger_project_month_location",
        "inventory_ledger_raw",
        ["project_id", "report_month", "location"],
    )


def downgrade() -> None:
    op.drop_index(
        "idx_ledger_project_month_location", table_name="inventory_ledger_raw"
    )
    op.drop_index("idx_ledger_project_month_msku", table_name="inventory_ledger_raw")
    op.drop_index("idx_ledger_project_month", table_name="inventory_ledger_raw")
    op.drop_table("inventory_ledger_raw")
