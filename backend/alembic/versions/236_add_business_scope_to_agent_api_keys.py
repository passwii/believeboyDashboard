"""add business_scope to agent_api_keys

Revision ID: 236
Revises: 235
Create Date: 2026-08-06 08:59:50.632600

BLF-448：业务域授权维度。语义与 project_scope 对齐：
'*' = 全业务域放行（存量 key 兼容，行为不变），否则 ',' 分隔的域 code
白名单（如 shipments,shop_calculations）。校验见 app/api/agent/scope.py
require_business_scope。
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "236"
down_revision: Union[str, None] = "235"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "agent_api_keys",
        sa.Column(
            "business_scope",
            sa.String(length=255),
            nullable=False,
            server_default="*",
        ),
    )


def downgrade() -> None:
    op.drop_column("agent_api_keys", "business_scope")
