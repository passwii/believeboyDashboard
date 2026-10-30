"""Idempotently seed reference data required by backend pytest.

The persistent local test DB is cloned with ``pg_dump --schema-only``; data
inserts performed inside Alembic migrations are therefore absent. CI builds the
same schema from migrations, where those inserts exist. This script gives both
paths one idempotent seed step without duplicating the frozen migration data.
"""

from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path
from typing import Any

from sqlalchemy import text

ROOT = Path(__file__).resolve().parents[1]
VERSIONS_DIR = ROOT / "alembic" / "versions"
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _load_env_files() -> None:
    for name, override in ((".env", False), (".env.test", True)):
        path = ROOT / name
        if not path.exists():
            continue
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            if override or key.strip() not in os.environ:
                os.environ[key.strip()] = value.strip().strip('"').strip("'")


_load_env_files()


def _load_frozen_seed(module_name: str, filename: str, attr: str) -> Any:
    path = VERSIONS_DIR / filename
    spec = importlib.util.spec_from_file_location(module_name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return getattr(module, attr)


def _ensure_tables(engine) -> None:
    from app.db.session import Base
    from app.models.crm import CrmCategory, CrmCustomerCategory
    from app.models.project_workflow_template import (
        WorkflowTemplate,
        WorkflowTemplateTask,
        WorkflowTemplateTaskAttachment,
        WorkflowTemplateTaskContent,
    )

    Base.metadata.create_all(
        engine,
        tables=[
            CrmCategory.__table__,
            CrmCustomerCategory.__table__,
            WorkflowTemplate.__table__,
            WorkflowTemplateTask.__table__,
            WorkflowTemplateTaskContent.__table__,
            WorkflowTemplateTaskAttachment.__table__,
        ],
        checkfirst=True,
    )


def _seed_categories(conn) -> None:
    categories = _load_frozen_seed(
        "_seed_crm_categories_252",
        "20260808_252_crm_categories.py",
        "SEED_CATEGORIES",
    )
    for index, name in enumerate(categories):
        conn.execute(
            text(
                "insert into crm_categories (name, sort_order) "
                "values (:name, :sort_order) "
                "on conflict (name) do nothing"
            ),
            {"name": name, "sort_order": index},
        )


def _seed_workflow_templates(conn) -> None:
    templates = _load_frozen_seed(
        "_seed_workflow_templates_276",
        "20261005_276_project_launch_template_customization.py",
        "_SEED_TEMPLATES",
    )
    for template in templates:
        conn.execute(
            text(
                "insert into workflow_templates "
                "(key, kind, title, description, sort_order) "
                "values (:key, :kind, :title, null, :sort_order) "
                "on conflict (key) do nothing"
            ),
            {
                "key": template["key"],
                "kind": template["kind"],
                "title": template["title"],
                "sort_order": template["sort_order"],
            },
        )
        template_id = conn.execute(
            text("select id from workflow_templates where key = :key"),
            {"key": template["key"]},
        ).scalar_one()
        task_count = conn.execute(
            text(
                "select count(*) from workflow_template_tasks "
                "where template_id = :template_id"
            ),
            {"template_id": template_id},
        ).scalar_one()
        if task_count:
            continue

        for index, (title, description, attachment_key) in enumerate(
            template["tasks"]
        ):
            conn.execute(
                text(
                    "insert into workflow_template_tasks "
                    "(template_id, title, description, sort_order, "
                    "attachment_key, duration_days) "
                    "values (:template_id, :title, :description, :sort_order, "
                    ":attachment_key, null)"
                ),
                {
                    "template_id": template_id,
                    "title": title,
                    "description": description,
                    "sort_order": index,
                    "attachment_key": attachment_key,
                },
            )


def seed_reference_data(engine) -> None:
    _ensure_tables(engine)
    with engine.begin() as conn:
        _seed_categories(conn)
        _seed_workflow_templates(conn)


def main() -> int:
    from app.db.session import engine

    seed_reference_data(engine)
    print("Test reference data ready (CRM categories + workflow templates).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
