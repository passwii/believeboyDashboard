"""删除 user_accounts.operator_name_zh（全局显示名统一收敛到 full_name）

Revision ID: 284
Revises: 283

BLF-1441 的第二轮口径：业务方确认 ``operator_name_zh``（运营名）与
``full_name``（姓名）对使用者是重复字段，全局只保留 ``full_name``。
系统内部的对接标识改用登录名 ``name``（username），不再借用任何中文名。

升级前先把「只有运营名、没有姓名」的账号补成姓名，避免丢显示名；现网快照
里两个有运营名的账号（纪亚伟 / 刘心灵）本来就与 ``full_name`` 相同，所以
这一步对现网是空操作，只是防止其他环境出现数据丢失。

降级时把列加回来并回填 ``full_name``：旧代码的
``coalesce(operator_name_zh, full_name)`` 兜底链因此仍能工作，回滚不会让
项目运营下拉变成空名单。
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "284"
down_revision: str | None = "283"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        update public.user_accounts
        set full_name = nullif(trim(operator_name_zh), ''),
            updated_at = now()
        where nullif(trim(full_name), '') is null
          and nullif(trim(operator_name_zh), '') is not null
        """
    )
    op.drop_column("user_accounts", "operator_name_zh")


def downgrade() -> None:
    op.add_column(
        "user_accounts", sa.Column("operator_name_zh", sa.Text(), nullable=True)
    )
    op.execute(
        """
        update public.user_accounts
        set operator_name_zh = nullif(trim(full_name), '')
        where nullif(trim(full_name), '') is not null
        """
    )
