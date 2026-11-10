#!/usr/bin/env python3
"""Create a new Goose SQL migration with a timestamped filename.

Usage:
    python3 backend-go/scripts/new_go_migration.py add_customer_tag

The file is created under backend-go/internal/migrations/sql/ as
YYYYMMDDHHMMSS_<slug>.sql. Edit the Up/Down blocks, then run
backend-go/scripts/check_go_migrations.py.
"""

from __future__ import annotations

import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MIGRATION_DIR = ROOT / "backend-go" / "internal" / "migrations" / "sql"
SLUG_RE = re.compile(r"^[a-z0-9_]+$")

TEMPLATE = """-- +goose Up
-- +goose StatementBegin
-- TODO: write forward migration
-- +goose StatementEnd

-- +goose Down
-- TODO: write rollback, or document why this migration is irreversible
"""


def main() -> None:
    if len(sys.argv) != 2 or not SLUG_RE.match(sys.argv[1]):
        print("usage: new_go_migration.py <lower_snake_case_slug>", file=sys.stderr)
        raise SystemExit(2)
    slug = sys.argv[1]
    MIGRATION_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    path = MIGRATION_DIR / f"{stamp}_{slug}.sql"
    if path.exists():
        print(f"refusing to overwrite {path}", file=sys.stderr)
        raise SystemExit(1)
    path.write_text(TEMPLATE, encoding="utf-8")
    print(path.relative_to(ROOT))


if __name__ == "__main__":
    main()
