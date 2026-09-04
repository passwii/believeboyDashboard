"""delete wrong week1 data for 玥涵 project

Revision ID: 20260324_067
Revises: 20260320_066
Create Date: 2026-03-24 10:30:00.000000
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260324_067"
down_revision: Union[str, None] = "20260320_066"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


PROJECT_NAME = "玥涵"
START_DATE = "2026-02-16"
END_DATE = "2026-03-22"


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    required_tables = {
        "projects",
        "analysis_pt1_calculation",
        "analysis_pt_sku_details",
    }
    if not required_tables.issubset(set(inspector.get_table_names())):
        return

    result = bind.execute(
        sa.text("""
            DELETE FROM analysis_pt1_calculation
            WHERE project_id IN (
                SELECT id FROM projects WHERE project_name = :project_name
            )
            AND report_start_date = :start_date
            AND report_end_date = :end_date
            RETURNING id
        """),
        {
            "project_name": PROJECT_NAME,
            "start_date": START_DATE,
            "end_date": END_DATE,
        },
    )

    deleted_ids = [row[0] for row in result]

    if deleted_ids:
        print(
            f"Deleted {len(deleted_ids)} calculation records for {PROJECT_NAME} "
            f"(period: {START_DATE} to {END_DATE})"
        )


def downgrade() -> None:
    pass
