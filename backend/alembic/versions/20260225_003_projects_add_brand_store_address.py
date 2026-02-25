"""add brand_name and store_address to projects

Revision ID: 20260225_003
Revises: 20260225_002
Create Date: 2026-02-25 14:05:00
"""

from alembic import op

# revision identifiers, used by Alembic.
revision = '20260225_003'
down_revision = '20260225_002'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        do $$
        begin
          if exists (
            select 1
            from information_schema.tables
            where table_schema = 'public' and table_name = 'projects'
          ) then
            alter table public.projects add column if not exists brand_name text;
            alter table public.projects add column if not exists store_address text;
          end if;
        end $$;
        """
    )


def downgrade() -> None:
    op.execute(
        """
        do $$
        begin
          if exists (
            select 1
            from information_schema.tables
            where table_schema = 'public' and table_name = 'projects'
          ) then
            alter table public.projects drop column if exists brand_name;
            alter table public.projects drop column if exists store_address;
          end if;
        end $$;
        """
    )
