"""ensure product_costs baseline table exists

Revision ID: 20260224_000
Revises:
Create Date: 2026-02-24 00:00:00.000000
"""

from typing import Sequence, Union

from alembic import op


revision: str = '20260224_000'
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        create table if not exists public.product_costs (
          id bigint generated always as identity primary key,
          project_name text not null,
          sku text not null,
          asin text not null,
          first_leg_unit_cost numeric(12,2) not null default 0 check (first_leg_unit_cost >= 0),
          fob_unit_cost numeric(12,2) not null default 0 check (fob_unit_cost >= 0),
          currency text not null default 'USD',
          source_file text,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          constraint product_costs_project_sku_asin_key unique (project_name, sku, asin)
        );

        create index if not exists idx_product_costs_project_name on public.product_costs(project_name);
        create index if not exists idx_product_costs_sku on public.product_costs(sku);
        create index if not exists idx_product_costs_asin on public.product_costs(asin);
        """
    )


def downgrade() -> None:
    pass
