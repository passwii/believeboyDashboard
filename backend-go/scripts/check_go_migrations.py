#!/usr/bin/env python3
"""Validate the Goose migration set and the frozen Alembic cutover.

The Alembic history is archived at revision 285. Any change to
backend/alembic/versions (including adding a file) must be deliberate:
update FROZEN_ALEMBIC_MANIFEST_SHA256 and the docs together.

Run from repo root or any directory:
    python3 backend-go/scripts/check_go_migrations.py
Exit code 0 = valid; 1 = invalid.
"""

from __future__ import annotations

import hashlib
import re
import sys
from pathlib import Path

BASELINE_FILE = "00001_baseline.sql"
BASELINE_SHA256 = "5be4057c6286d2b024c562486a32fbd9ba02961a8ab76ab271d717659e23b2a2"
FROZEN_ALEMBIC_REVISION = "285"
FROZEN_ALEMBIC_MANIFEST_SHA256 = (
    "82150ebc66d4da4cc6e6e6a9855449c346a7bc3ceaff246d629e149b9e03d33b"
)
FUTURE_NAME_RE = re.compile(r"^(\d{14})_[a-z0-9_]+(\.sql)$")

ROOT = Path(__file__).resolve().parents[2]
MIGRATION_DIR = ROOT / "backend-go" / "internal" / "migrations" / "sql"
ALEMBIC_DIR = ROOT / "backend" / "alembic" / "versions"


def fail(message: str) -> None:
    print(f"ERROR: {message}", file=sys.stderr)
    raise SystemExit(1)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def validate_migrations() -> None:
    if not MIGRATION_DIR.is_dir():
        fail(f"migration directory missing: {MIGRATION_DIR}")

    files = sorted(MIGRATION_DIR.glob("*.sql"), key=lambda p: p.name)
    if not files:
        fail("no Goose migrations found")

    baseline = MIGRATION_DIR / BASELINE_FILE
    if not baseline.is_file():
        fail(f"baseline migration missing: {BASELINE_FILE}")
    if sha256(baseline) != BASELINE_SHA256:
        fail(
            f"{BASELINE_FILE} was modified; the cutover baseline is frozen. "
            "Add a new Go migration instead."
        )

    seen: dict[int, str] = {}
    for path in files:
        version_text = path.name.split("_", 1)[0]
        if not version_text.isdigit():
            fail(f"invalid migration filename (missing numeric prefix): {path.name}")
        version = int(version_text)
        if path.name == BASELINE_FILE:
            if version != 1:
                fail("baseline must be version 1")
        else:
            match = FUTURE_NAME_RE.match(path.name)
            if not match or version <= 1:
                fail(
                    f"future migration must be named YYYYMMDDHHMMSS_slug.sql "
                    f"and use version > 1: {path.name}"
                )
        if version in seen:
            fail(f"duplicate migration version {version}: {seen[version]} and {path.name}")
        seen[version] = path.name

        text = path.read_text(encoding="utf-8")
        if "-- +goose Up" not in text:
            fail(f"{path.name} is missing '-- +goose Up'")
        if "-- +goose Down" not in text:
            fail(f"{path.name} is missing '-- +goose Down'")

    print(
        f"OK: {len(files)} Goose migration(s), baseline version 1, "
        f"latest version {max(seen)}"
    )


def validate_alembic_frozen() -> None:
    if not ALEMBIC_DIR.is_dir():
        fail(f"Alembic archive missing: {ALEMBIC_DIR}")
    files = sorted(ALEMBIC_DIR.glob("*.py"), key=lambda p: p.name)
    if not files:
        fail("Alembic archive is empty")
    manifest = "".join(
        p.name + "\0" + hashlib.sha256(p.read_bytes()).hexdigest() + "\n"
        for p in files
    )
    digest = hashlib.sha256(manifest.encode()).hexdigest()
    if digest != FROZEN_ALEMBIC_MANIFEST_SHA256:
        fail(
            "backend/alembic/versions changed after the Goose cutover. "
            f"Expected manifest {FROZEN_ALEMBIC_MANIFEST_SHA256}, got {digest}. "
            "Alembic is frozen at revision 285; create a Goose migration instead."
        )
    print(
        f"OK: Alembic archive frozen at revision {FROZEN_ALEMBIC_REVISION} "
        f"({len(files)} files)"
    )


def main() -> None:
    validate_migrations()
    validate_alembic_frozen()


if __name__ == "__main__":
    main()
