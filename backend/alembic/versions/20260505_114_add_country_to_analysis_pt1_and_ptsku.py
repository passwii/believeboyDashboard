"""add_country_to_analysis_pt1_and_ptsku

Revision ID: 20260505_114
Revises: 20260429_113
Create Date: 2026-05-05 15:09:46.432180

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

BIGINT_SQLITE = sa.BigInteger().with_variant(sa.Integer(), 'sqlite')

# revision identifiers, used by Alembic.
revision: str = '20260505_114'
down_revision: Union[str, None] = '20260504_114'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    # Add country to analysis_pt1_calculation if not exists
    if not inspector.has_table('analysis_pt1_calculation'):
        # Table doesn't exist yet, let the model handle creation
        return

    columns = [col['name'] for col in inspector.get_columns('analysis_pt1_calculation')]
    if 'country' not in columns:
        op.add_column('analysis_pt1_calculation',
            sa.Column('country', sa.String(length=2), nullable=True, server_default=sa.text("'US'"))
        )
        op.execute("UPDATE analysis_pt1_calculation SET country = 'US' WHERE country IS NULL")
        op.alter_column('analysis_pt1_calculation', 'country', nullable=False)

    # Add index
    try:
        op.create_index('idx_analysis_pt1_country', 'analysis_pt1_calculation', ['country'])
    except:
        pass

    # Note: The unique constraint change is handled by the model via alembic's batch operations
    # in future migrations if needed. For now, we add the column.

    # Add country to analysis_pt_sku_details if not exists
    if not inspector.has_table('analysis_pt_sku_details'):
        return

    columns = [col['name'] for col in inspector.get_columns('analysis_pt_sku_details')]
    if 'country' not in columns:
        op.add_column('analysis_pt_sku_details',
            sa.Column('country', sa.String(length=2), nullable=True, server_default=sa.text("'US'"))
        )
        # Backfill country from analysis_pt1_calculation
        op.execute("""
            UPDATE analysis_pt_sku_details d
            SET country = p.country
            FROM analysis_pt1_calculation p
            WHERE d.pt1_calculation_id = p.id
        """)
        op.alter_column('analysis_pt_sku_details', 'country', nullable=False)

    # Add composite index for pt1+country lookups
    try:
        op.create_index('idx_analysis_pt_sku_details_pt1_country',
                       'analysis_pt_sku_details',
                       ['pt1_calculation_id', 'country'])
    except:
        pass


def downgrade() -> None:
    op.drop_index('idx_analysis_pt_sku_details_pt1_country',
                  table_name='analysis_pt_sku_details')
    op.drop_index('idx_analysis_pt1_country',
                  table_name='analysis_pt1_calculation')
    op.drop_column('analysis_pt_sku_details', 'country')
    op.drop_column('analysis_pt1_calculation', 'country')
