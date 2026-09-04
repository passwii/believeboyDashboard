"""create exchange rates table

Revision ID: 20260308_028
Revises: 20260306_027
Create Date: 2026-03-08 11:40:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = '20260308_028'
down_revision: str | None = '20260306_027'
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    now_default = sa.text('CURRENT_TIMESTAMP') if bind.dialect.name == 'sqlite' else sa.func.now()

    if not inspector.has_table('exchange_rates'):
        op.create_table(
            'exchange_rates',
            sa.Column('id', sa.BigInteger().with_variant(sa.Integer(), 'sqlite'), primary_key=True, autoincrement=True),
            sa.Column('currency', sa.String(length=32), nullable=False),
            sa.Column('currency_name', sa.String(length=128), nullable=True),
            sa.Column('year_month', sa.String(length=7), nullable=False),
            sa.Column('rate', sa.Numeric(18, 8), nullable=False),
            sa.Column('description', sa.String(), nullable=True),
            sa.Column('note_images', sa.JSON(), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=now_default),
            sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=now_default),
            sa.CheckConstraint('rate > 0', name='exchange_rates_rate_check'),
            sa.UniqueConstraint('currency', 'year_month', name='exchange_rates_currency_year_month_key'),
        )
    else:
        existing_columns = {column['name'] for column in inspector.get_columns('exchange_rates')}
        if 'currency_name' not in existing_columns:
            op.add_column('exchange_rates', sa.Column('currency_name', sa.String(length=128), nullable=True))
        if 'description' not in existing_columns:
            op.add_column('exchange_rates', sa.Column('description', sa.String(), nullable=True))
        if 'note_images' not in existing_columns:
            op.add_column('exchange_rates', sa.Column('note_images', sa.JSON(), nullable=True))
        if 'created_at' not in existing_columns:
            op.add_column(
                'exchange_rates',
                sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=now_default),
            )
        if 'updated_at' not in existing_columns:
            op.add_column(
                'exchange_rates',
                sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=now_default),
            )

        if bind.dialect.name == 'postgresql':
            bind.execute(
                sa.text(
                    """
                    DO $$
                    BEGIN
                        IF NOT EXISTS (
                            SELECT 1
                            FROM pg_constraint
                            WHERE conname = 'exchange_rates_rate_check'
                        ) THEN
                            ALTER TABLE exchange_rates
                            ADD CONSTRAINT exchange_rates_rate_check CHECK (rate > 0);
                        END IF;
                    END
                    $$;
                    """
                )
            )

    bind.execute(
        sa.text(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS exchange_rates_currency_year_month_key
            ON exchange_rates (currency, year_month)
            """
        )
    )
    bind.execute(
        sa.text(
            """
            CREATE INDEX IF NOT EXISTS ix_exchange_rates_currency
            ON exchange_rates (currency)
            """
        )
    )
    bind.execute(
        sa.text(
            """
            CREATE INDEX IF NOT EXISTS ix_exchange_rates_year_month
            ON exchange_rates (year_month)
            """
        )
    )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if inspector.has_table('exchange_rates'):
        op.drop_index('ix_exchange_rates_year_month', table_name='exchange_rates', if_exists=True)
        op.drop_index('ix_exchange_rates_currency', table_name='exchange_rates', if_exists=True)
        op.drop_index('exchange_rates_currency_year_month_key', table_name='exchange_rates', if_exists=True)
        op.drop_table('exchange_rates')
