"""add trigram indexes for product_costs fuzzy search

Revision ID: 20260225_002
Revises: 20260224_001
Create Date: 2026-02-25 00:00:00.000000
"""

from typing import Sequence, Union

from alembic import op


revision: str = '20260225_002'
down_revision: Union[str, None] = '20260224_001'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute('create extension if not exists pg_trgm;')
    op.execute(
        """
        create index if not exists idx_product_costs_project_name_trgm
        on public.product_costs using gin (project_name gin_trgm_ops);

        create index if not exists idx_product_costs_sku_trgm
        on public.product_costs using gin (sku gin_trgm_ops);

        create index if not exists idx_product_costs_asin_trgm
        on public.product_costs using gin (asin gin_trgm_ops);
        """
    )


def downgrade() -> None:
    op.execute('drop index if exists public.idx_product_costs_asin_trgm;')
    op.execute('drop index if exists public.idx_product_costs_sku_trgm;')
    op.execute('drop index if exists public.idx_product_costs_project_name_trgm;')
