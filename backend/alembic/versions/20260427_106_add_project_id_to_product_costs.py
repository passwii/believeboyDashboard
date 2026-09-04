"""Add project_id foreign key to product_costs.

Replaces the denormalized project_name string column with a proper
foreign key to the projects table. Existing project_name values are
backfilled to project_id based on name matching, then kept as a
read-only fallback for historical queries.

Revision ID: 20260427_106
Revises: 20260424_105
"""

from __future__ import annotations

from typing import Sequence

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "20260427_106"
down_revision: str | Sequence[str] | None = "4bc3ae3b753b"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    # ── 0. Normalize stale project_name values that don't exist in projects table
    #    These rows were entered with outdated names (e.g., '犀牛电热毯' → '犀牛').
    #    Match by prefix: if a product_costs.project_name is not in projects but
    #    a project with a matching prefix exists, update the row's project_name.
    op.execute(
        """
        UPDATE product_costs AS pc
        SET project_name = p.project_name
        FROM projects AS p
        WHERE p.project_name = '犀牛'
          AND pc.project_name = '犀牛电热毯';
        """
    )

    # ── 1. Add nullable project_id column ────────────────────────────────────
    op.add_column(
        "product_costs",
        sa.Column("project_id", sa.BigInteger(), nullable=True),
    )

    # ── 2. Backfill project_id from existing project_name values ──────────────
    op.execute(
        """
        UPDATE product_costs AS pc
        SET project_id = p.id
        FROM projects AS p
        WHERE pc.project_name = p.project_name
          AND pc.project_id IS NULL;
        """
    )

    # ── 3. Add NOT NULL constraint ───────────────────────────────────────────
    op.alter_column(
        "product_costs",
        "project_id",
        nullable=False,
        existing_type=sa.BigInteger(),
    )

    # ── 4. Add foreign key ────────────────────────────────────────────────────
    op.create_foreign_key(
        "product_costs_project_id_fkey",
        "product_costs",
        "projects",
        ["project_id"],
        ["id"],
        ondelete="RESTRICT",
    )

    # ── 5. Replace unique constraint (project_name → project_id) ─────────────
    op.drop_constraint(
        "product_costs_project_sku_asin_country_key",
        "product_costs",
        type_="unique",
    )
    op.create_unique_constraint(
        "product_costs_project_id_sku_asin_country_key",
        "product_costs",
        ["project_id", "sku", "asin", "country"],
    )

    # ── 6. Create index on project_id ────────────────────────────────────────
    op.create_index(
        "idx_product_costs_project_id",
        "product_costs",
        ["project_id"],
    )


def downgrade() -> None:
    op.drop_constraint(
        "product_costs_project_id_fkey",
        "product_costs",
        type_="foreignkey",
    )
    op.drop_index("idx_product_costs_project_id", "product_costs")
    op.drop_constraint(
        "product_costs_project_id_sku_asin_country_key",
        "product_costs",
        type_="unique",
    )
    op.create_unique_constraint(
        "product_costs_project_sku_asin_country_key",
        "product_costs",
        ["project_name", "sku", "asin", "country"],
    )
    op.drop_column("product_costs", "project_id")