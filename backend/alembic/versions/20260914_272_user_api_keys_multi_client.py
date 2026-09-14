"""user_api_keys 一账号多把 key：加 client_id、唯一约束改为 (user_id, client_id)（BLF-1059）

Revision ID: 272
Revises: 271
Create Date: 2026-09-14 21:00:00.000000

BLF-711 的 ``user_api_keys`` 是"一账号一行"（``user_id`` unique），登录即覆盖式
轮换：网页端与桌面端共用同一把 key → 任一端登录都把另一端顶掉（表现为 403，
用户被迫反复重登）。用户已拍板升级为「一账号多把 key」。

本迁移拆掉 ``user_id`` 唯一约束、按设备槽分区：

* 加 ``client_id``（``String(64)`` ``NOT NULL`` ``server_default='default'``）——
  存量行全部落 ``default`` 槽（网页端/老构建的槽），故迁移本身不使任何已发出的
  key 失效；
* **drop** unique ``idx_uak_user_id``；
* 建 unique ``idx_uak_user_client(user_id, client_id)``——槽内仍是"一把有效 key"，
  槽间互不影响；
* 建**非唯一** ``idx_uak_user_id``——管理面按用户吊销/轮换全部设备仍走这条索引。

鉴权路径（``resolve_user_key`` 按 ``key_hash`` 反查）零改动，401/403 语义不变。

``downgrade`` 的取舍（生产会真的跑回滚，这条必须诚实）：回建 ``user_id`` 唯一
索引前必须先给同账号多行去重，本迁移保留**每账号最新的一把、删除其余行**
（撤销的旧设备行无明文可恢复，无法回填）；因此**回滚会让该账号除最新设备外的
所有设备手里的 key 失效，需要重新登录才能拿到可用 key** —— 不是一次无害操作。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "272"
down_revision: str | None = "271"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # 存量行落 default 槽：迁移不改变任何已发出 key 的有效性。
    op.add_column(
        "user_api_keys",
        sa.Column(
            "client_id",
            sa.String(64),
            nullable=False,
            server_default="default",
        ),
    )
    # 先拆唯一约束，才能让同一 user_id 有多行。
    op.drop_index("idx_uak_user_id", table_name="user_api_keys")
    op.create_index(
        "idx_uak_user_client",
        "user_api_keys",
        ["user_id", "client_id"],
        unique=True,
    )
    # 管理面按用户吊销全部设备用：非唯一。
    op.create_index("idx_uak_user_id", "user_api_keys", ["user_id"], unique=False)


def downgrade() -> None:
    # 回建 user_id 唯一索引前必须去重：每账号保留最新一把（created_at 最新，
    # 同刻用 id 兜底），其余行删除。
    # 取舍：删除的行只存 hash，无法恢复；回滚后除最新设备外，其它设备的 key
    # 全部失效 → 用户需要重新登录。这条回滚不是无害操作（见模块 docstring）。
    op.execute(
        """
        DELETE FROM user_api_keys AS u
        USING (
            SELECT id,
                   row_number() OVER (
                       PARTITION BY user_id
                       ORDER BY created_at DESC NULLS LAST, id DESC
                   ) AS rn
            FROM user_api_keys
        ) AS ranked
        WHERE u.id = ranked.id AND ranked.rn > 1
        """
    )
    op.drop_index("idx_uak_user_client", table_name="user_api_keys")
    op.drop_index("idx_uak_user_id", table_name="user_api_keys")
    op.create_index("idx_uak_user_id", "user_api_keys", ["user_id"], unique=True)
    op.drop_column("user_api_keys", "client_id")
