"""drop agent_name from agent_api_keys (BLF-471 follow-up)

Revision ID: 241
Revises: 240
Create Date: 2026-08-07

用户反馈：Agent 接入管理页面的「名称」（``agent_api_keys.label``）字段本身就
是中文名，无需额外的 ``agent_name`` 列。运营对接时直接在「名称」上写好对应
名称，日志与后端一律使用 label。故移除 ``agent_api_keys.agent_name``。

``operation_audit_logs.agent_name`` 保留：写操作审计行在落库时快照「名称」
（label）随行留存（该表无 api_key_id 可 join），操作日志管理端按快照显示。
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "241"
down_revision: Union[str, None] = "240"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_column("agent_api_keys", "agent_name")


def downgrade() -> None:
    op.add_column(
        "agent_api_keys",
        sa.Column("agent_name", sa.String(length=128), nullable=True),
    )
