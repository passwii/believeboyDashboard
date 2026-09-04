"""crm 操作审计日志表（P4）

Revision ID: 220
Revises: 219
Create Date: 2026-07-25 00:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "220"
down_revision: Union[str, None] = "219"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_TABLE = "crm_audit_logs"

# (索引名, 列)
_INDEXES = [
    ("idx_cal_entity", ["entity_type", "entity_id"]),
    ("idx_cal_actor", ["actor_id"]),
    ("idx_cal_created", ["created_at"]),
]


def _has_index(inspector: sa.Inspector, index_name: str) -> bool:
    return index_name in {idx["name"] for idx in inspector.get_indexes(_TABLE)}


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table(_TABLE):
        op.create_table(
            _TABLE,
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column("entity_type", sa.String(length=20), nullable=False),
            sa.Column("entity_id", sa.Integer(), nullable=False),
            sa.Column("action", sa.String(length=30), nullable=False),
            sa.Column("actor_id", sa.String(length=36), nullable=True),
            sa.Column("summary", sa.Text(), nullable=True),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=sa.text("now()"),
                nullable=False,
            ),
            sa.PrimaryKeyConstraint("id"),
        )
    for index_name, columns in _INDEXES:
        if not _has_index(inspector, index_name):
            op.create_index(index_name, _TABLE, columns)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    for index_name, _columns in _INDEXES:
        if inspector.has_table(_TABLE) and _has_index(inspector, index_name):
            op.drop_index(index_name, table_name=_TABLE)
    if inspector.has_table(_TABLE):
        op.drop_table(_TABLE)
