"""回填巡检与凭据域审计 operation_type

Revision ID: 279
Revises: 278
Create Date: 2026-10-08 16:00:45.562780
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa



# revision identifiers, used by Alembic.
revision: str = '279'
down_revision: Union[str, None] = '278'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Stored audit paths include /api/v1/agent, so match the domain route
    # fragment anywhere in the path. Only classify legacy NULL values.
    bind = op.get_bind()
    bind.execute(
        sa.text(
            "UPDATE agent_api_audit_log "
            "SET operation_type = :operation_type "
            "WHERE operation_type IS NULL AND path LIKE :path_pattern"
        ),
        {
            "operation_type": "platform_inspection",
            "path_pattern": "%/platform-inspection%",
        },
    )
    bind.execute(
        sa.text(
            "UPDATE agent_api_audit_log "
            "SET operation_type = :operation_type "
            "WHERE operation_type IS NULL AND path LIKE :path_pattern"
        ),
        {
            "operation_type": "agent_provisioning",
            "path_pattern": "%/provisioning%",
        },
    )


def downgrade() -> None:
    # Backfilled classifications are historical data and are not reversible.
    pass
