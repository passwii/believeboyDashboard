"""rename external_api_audit_log to agent_api_audit_log

Revision ID: 233
Revises: 232
Create Date: 2026-08-04

Agent API 设计稿 §11：访问审计表随命名空间改名。中间件（改名后
agent_api_audit.py）在过渡期同时覆盖 /api/v1/external/* 与
/api/v1/agent/* 两个前缀。
"""

from alembic import op

revision = "233"
down_revision = "232"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.rename_table("external_api_audit_log", "agent_api_audit_log")
    if op.get_bind().dialect.name == "postgresql":
        op.execute("ALTER INDEX idx_eaal_created_at RENAME TO idx_aaal_created_at")
        op.execute("ALTER INDEX idx_eaal_api_key_id RENAME TO idx_aaal_api_key_id")


def downgrade() -> None:
    if op.get_bind().dialect.name == "postgresql":
        op.execute("ALTER INDEX idx_aaal_created_at RENAME TO idx_eaal_created_at")
        op.execute("ALTER INDEX idx_aaal_api_key_id RENAME TO idx_eaal_api_key_id")
    op.rename_table("agent_api_audit_log", "external_api_audit_log")
