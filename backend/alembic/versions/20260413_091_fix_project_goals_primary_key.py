"""Fix project_goals primary key sequence

Revision ID: 20260413_091
Revises: 20260412_090
Create Date: 2026-04-13
"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = '20260413_091'
down_revision: Union[str, None] = '20260412_090'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != 'postgresql':
        return

    op.execute(
        """
        CREATE SEQUENCE IF NOT EXISTS project_goals_id_seq;
        """
    )
    op.execute(
        """
        ALTER TABLE project_goals
        ALTER COLUMN id SET DEFAULT nextval('project_goals_id_seq');
        """
    )
    op.execute(
        """
        UPDATE project_goals
        SET id = nextval('project_goals_id_seq')
        WHERE id IS NULL;
        """
    )
    op.execute(
        """
        SELECT setval(
          'project_goals_id_seq',
          COALESCE((SELECT MAX(id) FROM project_goals), 1),
          COALESCE((SELECT MAX(id) IS NOT NULL FROM project_goals), false)
        );
        """
    )
    op.execute(
        """
        ALTER SEQUENCE project_goals_id_seq OWNED BY project_goals.id;
        """
    )
    op.execute(
        """
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conrelid = 'project_goals'::regclass
              AND contype = 'p'
          ) THEN
            ALTER TABLE project_goals
            ADD CONSTRAINT project_goals_pkey PRIMARY KEY (id);
          END IF;
        END $$;
        """
    )


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != 'postgresql':
        return

    op.execute(
        """
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conrelid = 'project_goals'::regclass
              AND conname = 'project_goals_pkey'
          ) THEN
            ALTER TABLE project_goals DROP CONSTRAINT project_goals_pkey;
          END IF;
        END $$;
        """
    )
    op.execute(
        """
        ALTER TABLE project_goals
        ALTER COLUMN id DROP DEFAULT;
        """
    )
    op.execute(
        """
        DROP SEQUENCE IF EXISTS project_goals_id_seq;
        """
    )
