"""项目启动台 P2：模板持久化 + 节点内容/附件 + 阶段排期（BLF-1237，revision 276）。

新增 6 张表：
- ``workflow_templates`` / ``workflow_template_tasks``：模板与模板节点（管理员维护）。
- ``workflow_template_task_contents`` / ``workflow_template_task_attachments``：模板节点的多条内容与多个附件。
- ``project_workflow_task_contents`` / ``project_workflow_task_attachments``：项目节点的多条内容与多个附件。

P1 表追加可空列（不改既有数据、不改既有约束）：
- ``project_workflows.start_date``：流程排期锚点。
- ``project_workflow_tasks.duration_days`` / ``start_date`` / ``end_date``：阶段工期与起止日期。

并把 P1 的两份硬编码模板（``store-launch-v1`` / ``product-womens-swimwear-v1``）
逐字种进新表，保证 P1 的 6 个接口契约与既有项目数据零破坏。

种子字面量**冻结在本文件内**，不 import 应用代码：应用代码会演进，
迁移必须自包含（否则旧迁移会随业务代码改动而失效）。
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = '276'
down_revision: str | None = '275'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# ---------------------------------------------------------------------------
# P1 模板种子（与 revision 275 上线时的 project_workflow_templates.py 逐字一致）
# ---------------------------------------------------------------------------

_STORE_LAUNCH = {
    'key': 'store-launch-v1',
    'kind': 'store_launch',
    'title': '店铺启动',
    'sort_order': 0,
    'tasks': (
        (
            '店铺注册资料收集',
            '按《亚马逊_注册信息收集表》收集主体、法人、地址、联系方式等注册资料，'
            '汇总回传后进入注册流程。',
            'amazon_registration_form',
        ),
        (
            '万里汇收款账户注册',
            '按《万里汇海外收款注册流程》完成海外收款账户注册，'
            '并回填账户主体与账号信息。',
            'worldfirst_registration_guide',
        ),
        (
            '店铺业务审核',
            '完成卖家平台业务审核（身份/视频验证等），直至审核通过。',
            None,
        ),
        (
            '品牌备案',
            '提交品牌备案（Brand Registry）并跟进平台审核结果。',
            None,
        ),
        (
            'UPC 注册豁免',
            '申请 GTIN/UPC 豁免，避免上架时强制使用外部条码。',
            None,
        ),
        (
            '收款账户后台绑定验证',
            '在卖家后台绑定万里汇收款账户并完成小额验证。',
            None,
        ),
    ),
}

_WOMENS_SWIMWEAR = {
    'key': 'product-womens-swimwear-v1',
    'kind': 'product_development',
    'title': '女士泳衣',
    'sort_order': 1,
    'tasks': (
        ('产品选款对接', '与供应商确认款式、版型、面料与目标成本，锁定选款方向。', None),
        ('产品打样对接', '确认打样尺寸与工艺要求，跟进打样进度并评审样衣。', None),
        ('产品包装设计', '输出包装结构与视觉设计稿，完成内部与业务方确认。', None),
        ('产品吊卡设计', '输出吊卡文案与视觉设计稿，完成确认并交付供应商。', None),
        ('产品洗标', '确认洗标内容（成分、洗涤说明、产地）与样式要求。', None),
        (
            '完整款打样、打包与邮寄',
            '完成完整款打样、包装打包并邮寄，作为量产前的最终确认。',
            None,
        ),
    ),
}

_SEED_TEMPLATES = (_STORE_LAUNCH, _WOMENS_SWIMWEAR)


def _seed_p1_templates() -> None:
    """Idempotently insert the two P1 templates and their nodes.

    先查后插（不依赖 ``ON CONFLICT``），PostgreSQL 与 SQLite 行为一致；
    重复执行 upgrade 不会产生重复行。``duration_days`` 一律留空——
    P1 没有定义工期，不在这里替业务方编造计划数据。
    """
    bind = op.get_bind()
    for template in _SEED_TEMPLATES:
        existing = bind.execute(
            sa.text('SELECT id FROM workflow_templates WHERE key = :key'),
            {'key': template['key']},
        ).scalar()
        if existing is not None:
            continue

        bind.execute(
            sa.text(
                'INSERT INTO workflow_templates (key, kind, title, description, sort_order) '
                'VALUES (:key, :kind, :title, NULL, :sort_order)'
            ),
            {
                'key': template['key'],
                'kind': template['kind'],
                'title': template['title'],
                'sort_order': template['sort_order'],
            },
        )
        template_id = bind.execute(
            sa.text('SELECT id FROM workflow_templates WHERE key = :key'),
            {'key': template['key']},
        ).scalar()

        for index, (title, description, attachment_key) in enumerate(template['tasks']):
            bind.execute(
                sa.text(
                    'INSERT INTO workflow_template_tasks '
                    '(template_id, title, description, sort_order, attachment_key, duration_days) '
                    'VALUES (:template_id, :title, :description, :sort_order, :attachment_key, NULL)'
                ),
                {
                    'template_id': template_id,
                    'title': title,
                    'description': description,
                    'sort_order': index,
                    'attachment_key': attachment_key,
                },
            )


def upgrade() -> None:
    # ------------------------------------------------------------------
    # 模板层
    # ------------------------------------------------------------------
    op.create_table(
        'workflow_templates',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('key', sa.String(length=80), nullable=False),
        sa.Column('kind', sa.String(length=32), nullable=False),
        sa.Column('title', sa.String(length=160), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('sort_order', sa.Integer(), nullable=False, server_default='0'),
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
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('key', name='uq_workflow_templates_key'),
        sa.CheckConstraint(
            "kind IN ('store_launch', 'product_development')",
            name='workflow_templates_kind_check',
        ),
    )
    op.create_index(
        'ix_workflow_templates_kind_sort',
        'workflow_templates',
        ['kind', 'sort_order'],
    )

    op.create_table(
        'workflow_template_tasks',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('template_id', sa.Integer(), nullable=False),
        sa.Column('title', sa.String(length=160), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('sort_order', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('attachment_key', sa.String(length=64), nullable=True),
        sa.Column('duration_days', sa.Integer(), nullable=True),
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
            ['template_id'], ['workflow_templates.id'], ondelete='CASCADE'
        ),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(
        'ix_workflow_template_tasks_template_sort',
        'workflow_template_tasks',
        ['template_id', 'sort_order'],
    )

    op.create_table(
        'workflow_template_task_contents',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('template_task_id', sa.Integer(), nullable=False),
        sa.Column('title', sa.String(length=160), nullable=True),
        sa.Column('body', sa.Text(), nullable=False),
        sa.Column('sort_order', sa.Integer(), nullable=False, server_default='0'),
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
            ['template_task_id'], ['workflow_template_tasks.id'], ondelete='CASCADE'
        ),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(
        'ix_workflow_template_task_contents_task_sort',
        'workflow_template_task_contents',
        ['template_task_id', 'sort_order'],
    )

    op.create_table(
        'workflow_template_task_attachments',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('template_task_id', sa.Integer(), nullable=False),
        sa.Column('r2_key', sa.String(length=512), nullable=False),
        sa.Column('filename', sa.String(length=256), nullable=False),
        sa.Column('content_type', sa.String(length=128), nullable=False),
        sa.Column('file_size', sa.Integer(), nullable=False),
        sa.Column('uploader', sa.String(length=255), nullable=True),
        sa.Column(
            'created_at',
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ['template_task_id'], ['workflow_template_tasks.id'], ondelete='CASCADE'
        ),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(
        'ix_workflow_template_task_attachments_task',
        'workflow_template_task_attachments',
        ['template_task_id'],
    )

    # ------------------------------------------------------------------
    # 项目层：P1 表追加可空列（既有行不动）
    # ------------------------------------------------------------------
    op.add_column(
        'project_workflows',
        sa.Column('start_date', sa.Date(), nullable=True),
    )
    op.add_column(
        'project_workflow_tasks',
        sa.Column('duration_days', sa.Integer(), nullable=True),
    )
    op.add_column(
        'project_workflow_tasks',
        sa.Column('start_date', sa.Date(), nullable=True),
    )
    op.add_column(
        'project_workflow_tasks',
        sa.Column('end_date', sa.Date(), nullable=True),
    )

    op.create_table(
        'project_workflow_task_contents',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('task_id', sa.Integer(), nullable=False),
        sa.Column('title', sa.String(length=160), nullable=True),
        sa.Column('body', sa.Text(), nullable=False),
        sa.Column('sort_order', sa.Integer(), nullable=False, server_default='0'),
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
            ['task_id'], ['project_workflow_tasks.id'], ondelete='CASCADE'
        ),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(
        'ix_project_workflow_task_contents_task_sort',
        'project_workflow_task_contents',
        ['task_id', 'sort_order'],
    )

    op.create_table(
        'project_workflow_task_attachments',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('task_id', sa.Integer(), nullable=False),
        sa.Column('r2_key', sa.String(length=512), nullable=False),
        sa.Column('filename', sa.String(length=256), nullable=False),
        sa.Column('content_type', sa.String(length=128), nullable=False),
        sa.Column('file_size', sa.Integer(), nullable=False),
        sa.Column('uploader', sa.String(length=255), nullable=True),
        sa.Column('origin', sa.String(length=16), nullable=False, server_default='upload'),
        sa.Column(
            'created_at',
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ['task_id'], ['project_workflow_tasks.id'], ondelete='CASCADE'
        ),
        sa.PrimaryKeyConstraint('id'),
        sa.CheckConstraint(
            "origin IN ('upload', 'template')",
            name='project_workflow_task_attachments_origin_check',
        ),
    )
    op.create_index(
        'ix_project_workflow_task_attachments_task',
        'project_workflow_task_attachments',
        ['task_id'],
    )

    _seed_p1_templates()


def downgrade() -> None:
    op.drop_index(
        'ix_project_workflow_task_attachments_task',
        table_name='project_workflow_task_attachments',
    )
    op.drop_table('project_workflow_task_attachments')
    op.drop_index(
        'ix_project_workflow_task_contents_task_sort',
        table_name='project_workflow_task_contents',
    )
    op.drop_table('project_workflow_task_contents')

    op.drop_column('project_workflow_tasks', 'end_date')
    op.drop_column('project_workflow_tasks', 'start_date')
    op.drop_column('project_workflow_tasks', 'duration_days')
    op.drop_column('project_workflows', 'start_date')

    op.drop_index(
        'ix_workflow_template_task_attachments_task',
        table_name='workflow_template_task_attachments',
    )
    op.drop_table('workflow_template_task_attachments')
    op.drop_index(
        'ix_workflow_template_task_contents_task_sort',
        table_name='workflow_template_task_contents',
    )
    op.drop_table('workflow_template_task_contents')
    op.drop_index(
        'ix_workflow_template_tasks_template_sort',
        table_name='workflow_template_tasks',
    )
    op.drop_table('workflow_template_tasks')
    op.drop_index('ix_workflow_templates_kind_sort', table_name='workflow_templates')
    op.drop_table('workflow_templates')
