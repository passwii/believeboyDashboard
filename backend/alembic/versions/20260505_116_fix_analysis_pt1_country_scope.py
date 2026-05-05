"""Fix PT1 country scope and backfill historical weekly analysis country.

Revision ID: 20260505_116
Revises: 20260505_115
Create Date: 2026-05-05 20:30:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '20260505_116'
down_revision: Union[str, None] = '20260505_115'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_index(inspector: sa.Inspector, table_name: str, index_name: str) -> bool:
    return any(index.get('name') == index_name for index in inspector.get_indexes(table_name))


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not inspector.has_table('analysis_pt1_calculation'):
        return
    if not inspector.has_table('analysis_pt_sku_details'):
        return
    if not inspector.has_table('analysis_source_files'):
        return

    op.execute(sa.text("""
        UPDATE analysis_pt1_calculation p1
        SET country = COALESCE(
            (
                SELECT asf.country
                FROM analysis_source_files asf
                WHERE asf.project_id = p1.project_id
                  AND asf.country IN ('US', 'DE', 'UK')
                  AND (
                    (
                      asf.period_start_date IS NOT NULL
                      AND asf.period_end_date IS NOT NULL
                      AND asf.period_start_date <= p1.report_end_date
                      AND asf.period_end_date >= p1.report_start_date
                    )
                    OR (
                      asf.report_date IS NOT NULL
                      AND asf.report_date BETWEEN p1.report_start_date AND p1.report_end_date
                    )
                  )
                ORDER BY
                  CASE
                    WHEN asf.period_start_date = p1.report_start_date
                     AND asf.period_end_date = p1.report_end_date THEN 0
                    WHEN asf.report_date BETWEEN p1.report_start_date AND p1.report_end_date THEN 1
                    ELSE 2
                  END,
                  asf.is_current DESC,
                  asf.created_at DESC,
                  asf.id DESC
                LIMIT 1
            ),
            p1.country,
            'US'
        )
    """))

    op.execute(sa.text("""
        UPDATE analysis_pt_sku_details d
        SET country = p1.country
        FROM analysis_pt1_calculation p1
        WHERE d.pt1_calculation_id = p1.id
          AND d.country IS DISTINCT FROM p1.country
    """))

    if _has_index(inspector, 'analysis_pt1_calculation', 'idx_analysis_pt1_project_period'):
        op.drop_index('idx_analysis_pt1_project_period', table_name='analysis_pt1_calculation')
    if _has_index(inspector, 'analysis_pt1_calculation', 'idx_analysis_pt1_project_period_current'):
        op.drop_index('idx_analysis_pt1_project_period_current', table_name='analysis_pt1_calculation')
    if not _has_index(inspector, 'analysis_pt1_calculation', 'idx_analysis_pt1_project_country_period'):
        op.create_index(
            'idx_analysis_pt1_project_country_period',
            'analysis_pt1_calculation',
            ['project_id', 'country', 'report_start_date', 'report_end_date'],
        )
    if not _has_index(inspector, 'analysis_pt1_calculation', 'idx_analysis_pt1_project_country_period_current'):
        op.create_index(
            'idx_analysis_pt1_project_country_period_current',
            'analysis_pt1_calculation',
            ['project_id', 'country', 'report_start_date', 'report_end_date', 'is_current'],
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if inspector.has_table('analysis_pt1_calculation'):
        if _has_index(inspector, 'analysis_pt1_calculation', 'idx_analysis_pt1_project_country_period_current'):
            op.drop_index('idx_analysis_pt1_project_country_period_current', table_name='analysis_pt1_calculation')
        if _has_index(inspector, 'analysis_pt1_calculation', 'idx_analysis_pt1_project_country_period'):
            op.drop_index('idx_analysis_pt1_project_country_period', table_name='analysis_pt1_calculation')
        if not _has_index(inspector, 'analysis_pt1_calculation', 'idx_analysis_pt1_project_period'):
            op.create_index(
                'idx_analysis_pt1_project_period',
                'analysis_pt1_calculation',
                ['project_id', 'report_start_date', 'report_end_date'],
            )
        if not _has_index(inspector, 'analysis_pt1_calculation', 'idx_analysis_pt1_project_period_current'):
            op.create_index(
                'idx_analysis_pt1_project_period_current',
                'analysis_pt1_calculation',
                ['project_id', 'report_start_date', 'report_end_date', 'is_current'],
            )
