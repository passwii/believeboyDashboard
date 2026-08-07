"""add agent_name to agent_api_keys and operation_audit_logs (BLF-471)

Revision ID: 240
Revises: 239
Create Date: 2026-08-07

Agent 接入管理可读性（BLF-471）：运营/管理员看的是 Agent 的中文名而非英文
ID。``agent_api_keys.agent_name`` 在创建凭据时由管理员填写（英文 agent_id
的对应中文名），读侧访问日志经 join 还原；``operation_audit_logs.agent_name``
在写操作落库时快照写入（该表无 api_key_id 可 join，必须随行留存），保证
Agent 写操作日志也能显示中文名。

两列均为可空：存量行/未填名的行回退显示 agent_id 本身。
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "240"
down_revision: Union[str, None] = "239"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "agent_api_keys",
        sa.Column("agent_name", sa.String(length=128), nullable=True),
    )
    op.add_column(
        "operation_audit_logs",
        sa.Column("agent_name", sa.String(length=128), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("operation_audit_logs", "agent_name")
    op.drop_column("agent_api_keys", "agent_name")
