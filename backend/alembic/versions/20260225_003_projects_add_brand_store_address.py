"""add brand_name and store_address to projects

Revision ID: 20260225_003
Revises: 20260225_002
Create Date: 2026-02-25 14:05:00
"""

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = '20260225_003'
down_revision = '20260225_002'
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if bind.dialect.name == 'sqlite':
        if inspector.has_table('projects'):
            existing = {column['name'] for column in inspector.get_columns('projects')}
            if 'brand_name' not in existing:
                op.add_column('projects', sa.Column('brand_name', sa.Text(), nullable=True))
            if 'store_address' not in existing:
                op.add_column('projects', sa.Column('store_address', sa.Text(), nullable=True))
        return
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
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if bind.dialect.name == 'sqlite':
        if not inspector.has_table('projects'):
            return
        existing = {column['name'] for column in inspector.get_columns('projects')}
        if 'brand_name' in existing:
            op.drop_column('projects', 'brand_name')
        if 'store_address' in existing:
            op.drop_column('projects', 'store_address')
        return
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
