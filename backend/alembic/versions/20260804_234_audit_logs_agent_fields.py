"""operation_audit_logs add agent_id and idempotency_key

Revision ID: 234
Revises: 233
Create Date: 2026-08-04

Agent API 设计稿 §4.2：agent 发起的写操作归因走 agent_id 列
（operator 保持 NULL），idempotency_key 留痕便于事后追溯重放。
"""

import sqlalchemy as sa
from alembic import op

revision = "234"
down_revision = "233"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "operation_audit_logs",
        sa.Column("agent_id", sa.String(length=128), nullable=True),
    )
    op.add_column(
        "operation_audit_logs",
        sa.Column("idempotency_key", sa.String(length=64), nullable=True),
    )
    op.create_index("idx_oal_agent_id", "operation_audit_logs", ["agent_id"])


def downgrade() -> None:
    op.drop_index("idx_oal_agent_id", table_name="operation_audit_logs")
    op.drop_column("operation_audit_logs", "idempotency_key")
    op.drop_column("operation_audit_logs", "agent_id")
