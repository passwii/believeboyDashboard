"""Backfill country field for existing PT1 and PT1 Detail records.

This migration populates the country field for existing AnalysisPT1Calculation
and AnalysisPTSKUDetail records based on the source files used in each calculation.

Revision ID: 20260505_115
Revises: 20260505_114
Create Date: 2026-05-05 16:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '20260505_115'
down_revision: Union[str, None] = '20260505_114'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    # Skip if tables don't exist
    if not inspector.has_table('analysis_pt1_calculation'):
        return
    if not inspector.has_table('analysis_pt_sku_details'):
        return

    # Check if country column already exists and has non-null values
    pt1_cols = [col['name'] for col in inspector.get_columns('analysis_pt1_calculation')]
    detail_cols = [col['name'] for col in inspector.get_columns('analysis_pt_sku_details')]

    if 'country' not in pt1_cols or 'country' not in detail_cols:
        return

    # Count existing records with country set
    result = bind.execute(sa.text(
        "SELECT COUNT(*) FROM analysis_pt1_calculation WHERE country IS NOT NULL"
    ))
    pt1_with_country = result.scalar()

    result = bind.execute(sa.text(
        "SELECT COUNT(*) FROM analysis_pt_sku_details WHERE country IS NOT NULL"
    ))
    details_with_country = result.scalar()

    # If both tables already have country populated, skip
    if pt1_with_country > 0 and details_with_country > 0:
        print(f"Country already populated: {pt1_with_country} PT1 records, {details_with_country} Detail records")
        return

    print(f"Backfilling country for PT1 and Detail records...")

    # Backfill PT1 country from source files
    # Determine country from the source files used in each PT1 calculation
    # All source files for a given PT1 period should have the same country
    op.execute(sa.text("""
        UPDATE analysis_pt1_calculation p1
        SET country = COALESCE(
            (
                SELECT asf.country
                FROM analysis_source_files asf
                JOIN analysis_business_rows abr ON abr.source_file_id = asf.id
                JOIN analysis_pt_sku_details apd ON LOWER(apd.sku) = LOWER(abr.asin)
                WHERE apd.pt1_calculation_id = p1.id
                LIMIT 1
            ),
            (
                SELECT asf.country
                FROM analysis_source_files asf
                JOIN analysis_payment_rows apr ON apr.source_file_id = asf.id
                JOIN analysis_pt_sku_details apd ON LOWER(apd.sku) = LOWER(apr.sku)
                WHERE apd.pt1_calculation_id = p1.id
                LIMIT 1
            ),
            (
                SELECT asf.country
                FROM analysis_source_files asf
                JOIN analysis_ad_product_rows aapr ON aapr.source_file_id = asf.id
                JOIN analysis_pt_sku_details apd ON LOWER(apd.sku) = LOWER(aapr.sku)
                WHERE apd.pt1_calculation_id = p1.id
                LIMIT 1
            ),
            'US'
        )
        WHERE p1.country IS NULL OR p1.country = ''
    """))

    # Backfill Detail country from PT1
    op.execute(sa.text("""
        UPDATE analysis_pt_sku_details d
        SET country = p1.country
        FROM analysis_pt1_calculation p1
        WHERE d.pt1_calculation_id = p1.id
        AND (d.country IS NULL OR d.country = '')
    """))

    # Verify counts
    result = bind.execute(sa.text(
        "SELECT COUNT(*) FROM analysis_pt1_calculation WHERE country IS NOT NULL"
    ))
    pt1_count = result.scalar()

    result = bind.execute(sa.text(
        "SELECT COUNT(*) FROM analysis_pt_sku_details WHERE country IS NOT NULL"
    ))
    details_count = result.scalar()

    print(f"Backfill complete: {pt1_count} PT1 records, {details_count} Detail records with country")


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not inspector.has_table('analysis_pt1_calculation'):
        return
    if not inspector.has_table('analysis_pt_sku_details'):
        return

    # Clear country values
    op.execute(sa.text(
        "UPDATE analysis_pt_sku_details SET country = NULL"
    ))
    op.execute(sa.text(
        "UPDATE analysis_pt1_calculation SET country = NULL"
    ))
    print("Country values cleared for downgrade")
