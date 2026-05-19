"""add country to commission tables

Revision ID: 126
Revises: 125
Create Date: 2026-05-19
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

# revision identifiers
revision: str = '126'
down_revision: str = '125'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Add country column to commission_project_months
    op.add_column('commission_project_months', sa.Column('country', sa.String(2), nullable=False, server_default='US'))
    op.execute("UPDATE commission_project_months SET country = 'US' WHERE country IS NULL")

    # Drop old unique constraint
    op.drop_constraint('commission_project_months_unique_month_project', 'commission_project_months', type_='unique')

    # Add new unique constraint with country
    op.create_unique_constraint(
        'commission_project_months_unique_month_project_country',
        'commission_project_months',
        ['report_month', 'project_id', 'country']
    )

    # Add check constraint for country values
    op.create_check_constraint(
        'ck_commission_project_months_country',
        'commission_project_months',
        "country IN ('US', 'UK', 'DE')"
    )

    # Add index on country
    op.create_index('idx_commission_project_months_country', 'commission_project_months', ['country'])

    # Add country column to commission_records
    op.add_column('commission_records', sa.Column('country', sa.String(2), nullable=False, server_default='US'))
    op.execute("UPDATE commission_records SET country = 'US' WHERE country IS NULL")

    # Drop old unique constraint
    op.drop_constraint('commission_records_unique_month_project_person_category', 'commission_records', type_='unique')

    # Add new unique constraint with country
    op.create_unique_constraint(
        'commission_records_unique_month_project_person_country',
        'commission_records',
        ['report_month', 'project_id', 'country', 'person_name', 'income_category']
    )

    # Add check constraint for country values
    op.create_check_constraint(
        'ck_commission_records_country',
        'commission_records',
        "country IN ('US', 'UK', 'DE')"
    )

    # Add index on country
    op.create_index('idx_commission_records_country', 'commission_records', ['country'])


def downgrade() -> None:
    op.drop_index('idx_commission_records_country', table_name='commission_records')
    op.drop_index('idx_commission_project_months_country', table_name='commission_project_months')
    op.drop_constraint('ck_commission_records_country', 'commission_records', type_='check')
    op.drop_constraint('commission_records_unique_month_project_person_country', 'commission_records', type_='unique')
    op.drop_column('commission_records', 'country')
    op.drop_constraint('ck_commission_project_months_country', 'commission_project_months', type_='check')
    op.drop_constraint('commission_project_months_unique_month_project_country', 'commission_project_months', type_='unique')
    op.drop_column('commission_project_months', 'country')