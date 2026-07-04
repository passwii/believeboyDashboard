"""Move 7.2 payment + inventory files from processed/ back to project root
for re-processing by the old (db-session) daemon.

Builds plan by SHA-matching processed/ files against the 7.2 ingest audit
log SHAs. Use --apply to actually move.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import sys
from pathlib import Path

BACKEND = "/Users/damon/DamonProjects/believeboyDashboard/backend"
sys.path.insert(0, BACKEND)
os.environ.setdefault(
    "DATABASE_URL",
    open("/Users/damon/DamonProjects/believeboyDashboard/backend/.env")
    .read()
    .split("PROD_DATABASE_URL=", 1)[1]
    .split("\n", 1)[0]
    .strip(),
)

from sqlalchemy import create_engine, text

WATCH_ROOT = Path("/Users/damon/Documents/RPA")
PROJECTS = [
    "博朗姆", "金石", "弥森", "卡斯摩", "创酷", "吕沃", "铨富",
    "骏成", "华洋泛航", "玥涵", "博智1店", "博智2店", "犀牛", "瑞迪特",
]
SUPPORTED_EXTS = {".txt", ".csv", ".xlsx"}


def _fetch_target_shas(engine) -> dict[str, set[str]]:
    """Return {report_type: {sha, ...}} from operation_audit_logs 7.2 18:00+."""
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT DISTINCT (al.after_json->>'file_sha256') AS sha,
                   (al.after_json->>'report_type') AS rt
            FROM operation_audit_logs al
            WHERE al.action = 'auto_report.ingest'
              AND (al.after_json->>'report_type') IN ('payment_report', 'inventory_report')
              AND al.created_at >= '2026-07-02 18:00:00+08'
              AND al.created_at <  '2026-07-03 00:00:00+08'
        """)).fetchall()
        out: dict[str, set[str]] = {"payment_report": set(), "inventory_report": set()}
        for sha, rt in rows:
            if sha and rt in out:
                out[rt].add(sha)
        return out


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="actually move files")
    parser.add_argument("--watch-root", type=Path, default=WATCH_ROOT)
    args = parser.parse_args()

    watch_root: Path = args.watch_root
    engine = create_engine(os.environ["DATABASE_URL"])
    target_shas = _fetch_target_shas(engine)
    target_payment = target_shas["payment_report"]
    target_inventory = target_shas["inventory_report"]
    print(
        f"target SHAs from audit log: payment={len(target_payment)} "
        f"inventory={len(target_inventory)}\n"
    )

    matches: list[dict] = []
    for project in PROJECTS:
        proc = watch_root / project / "processed"
        if not proc.is_dir():
            continue
        for path in proc.rglob("*"):
            if not path.is_file() or path.suffix.lower() not in SUPPORTED_EXTS:
                continue
            if path.name in {"replay_july2_to_root.py"}:
                continue
            try:
                sha = _sha256(path)
            except Exception as e:
                print(f"  ERR sha {path}: {e}")
                continue
            if sha in target_payment:
                matches.append({"path": path, "project": project, "sha": sha, "rt": "payment_report"})
            elif sha in target_inventory:
                matches.append({"path": path, "project": project, "sha": sha, "rt": "inventory_report"})

    seen: set[str] = set()
    plan: list[tuple[Path, Path, str, str, str]] = []
    duplicates: list[Path] = []
    for m in matches:
        if m["sha"] in seen:
            duplicates.append(m["path"])
            continue
        seen.add(m["sha"])
        dest = m["path"].parent.parent / m["path"].name
        plan.append((m["path"], dest, m["project"], m["sha"], m["rt"]))

    print(f"=== {len(plan)} files to move ===\n")
    for src, dest, project, sha, rt in plan:
        print(f"  [{rt:<15}] {src.name}")
        print(f"     from: {src}")
        print(f"     to:   {dest}")
        print(f"     sha:  {sha[:12]}")
    if duplicates:
        print(f"\n⚠️  {len(duplicates)} file(s) have same SHA as already-planned (skip):")
        for d in duplicates:
            print(f"     - {d}")

    matched_payment = sum(1 for _, _, _, _, rt in plan if rt == "payment_report")
    matched_inventory = sum(1 for _, _, _, _, rt in plan if rt == "inventory_report")
    print("\n=== Summary ===")
    print(f"  payment_report:    planned {matched_payment} / target {len(target_payment)}")
    print(f"  inventory_report:  planned {matched_inventory} / target {len(target_inventory)}")
    missing_payment = target_payment - {m[3] for m in plan if m[4] == "payment_report"}
    missing_inventory = target_inventory - {m[3] for m in plan if m[4] == "inventory_report"}
    if missing_payment:
        print(f"  ⚠️  payment missing {len(missing_payment)}:")
        for s in missing_payment:
            print(f"     {s}")
    if missing_inventory:
        print(f"  ⚠️  inventory missing {len(missing_inventory)}:")
        for s in missing_inventory:
            print(f"     {s}")

    if not args.apply:
        print("\n(dry-run — pass --apply to actually move files)")
        return 0

    moved = 0
    for src, dest, project, sha, rt in plan:
        if dest.exists():
            print(f"  ⚠ dest already exists, skip: {dest}")
            continue
        try:
            shutil.move(str(src), str(dest))
            moved += 1
            print(f"  ✓ {src.name} → {dest.parent.name}/")
        except Exception as e:
            print(f"  ✗ {src.name}: {e}", file=sys.stderr)

    print(f"\nMoved {moved}/{len(plan)} file(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
