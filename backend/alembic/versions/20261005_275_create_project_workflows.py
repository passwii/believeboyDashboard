"""项目启动台流程表（BLF-1234，revision 275）。

创建两张表：
- ``project_workflows``：项目流程实例（单项目至多一条 ``store_launch``）。
- ``project_workflow_tasks``：流程内的有序任务快照。

任务标题/描述/附件键是**创建时的模板快照**，模板后续调整不回写历史数据。
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = '275'
down_revision: str | None = '274'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        'project_workflows',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column(
            'project_id',
            sa.BigInteger().with_variant(sa.Integer(), 'sqlite'),
            nullable=False,
        ),
        sa.Column('kind', sa.String(length=32), nullable=False),
        sa.Column('title', sa.String(length=160), nullable=False),
        sa.Column('template_key', sa.String(length=80), nullable=False),
        sa.Column(
            'created_at',
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            'updated_at',
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.CheckConstraint(
            "kind IN ('store_launch', 'product_development')",
            name='project_workflows_kind_check',
        ),
    )
    op.create_index(
        'ix_project_workflows_project_kind',
        'project_workflows',
        ['project_id', 'kind'],
    )
    op.create_index(
        'uq_project_workflows_store_launch_project_id',
        'project_workflows',
        ['project_id'],
        unique=True,
        postgresql_where=sa.text("kind = 'store_launch'"),
        sqlite_where=sa.text("kind = 'store_launch'"),
    )

    op.create_table(
        'project_workflow_tasks',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('workflow_id', sa.Integer(), nullable=False),
        sa.Column('title', sa.String(length=160), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('sort_order', sa.Integer(), nullable=False),
        sa.Column(
            'status',
            sa.String(length=32),
            server_default='not_started',
            nullable=False,
        ),
        sa.Column('attachment_key', sa.String(length=64), nullable=True),
        sa.Column(
            'created_at',
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            'updated_at',
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ['workflow_id'], ['project_workflows.id'], ondelete='CASCADE'
        ),
        sa.PrimaryKeyConstraint('id'),
        sa.CheckConstraint(
            "status IN ('not_started', 'in_progress', 'waiting_on_partner', 'completed')",
            name='project_workflow_tasks_status_check',
        ),
    )
    op.create_index(
        'ix_project_workflow_tasks_workflow_sort',
        'project_workflow_tasks',
        ['workflow_id', 'sort_order'],
    )


def downgrade() -> None:
    op.drop_index(
        'ix_project_workflow_tasks_workflow_sort',
        table_name='project_workflow_tasks',
    )
    op.drop_table('project_workflow_tasks')
    op.drop_index(
        'uq_project_workflows_store_launch_project_id',
        table_name='project_workflows',
    )
    op.drop_index(
        'ix_project_workflows_project_kind',
        table_name='project_workflows',
    )
    op.drop_table('project_workflows')
