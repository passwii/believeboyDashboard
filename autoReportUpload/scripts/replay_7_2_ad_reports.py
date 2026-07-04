"""Move 7.2 C-table ad_*_report files from 广告Processed/ back to project root."""
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
AD_PROCESSED_SUBDIR = "广告Processed"
SUPPORTED_EXTS = {".xlsx", ".csv", ".txt"}


def _fetch_target_shas(engine) -> dict[str, dict[str, set[tuple[str, str]]]]:
    """Return {report_type: {project_id: {sha, ...}}} from 7.2 audit log."""
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT DISTINCT (al.after_json->>'file_sha256') AS sha,
                   (al.after_json->>'report_type') AS rt,
                   (al.after_json->>'project_id') AS pid
            FROM operation_audit_logs al
            WHERE al.action = 'auto_report.ingest'
              AND (al.after_json->>'report_type') LIKE 'ad_%'
              AND al.created_at >= '2026-07-02 17:00:00+08'
              AND al.created_at <  '2026-07-03 00:00:00+08'
              AND al.after_json->>'file_sha256' IS NOT NULL
        """)).fetchall()
        out: dict[str, dict[str, set]] = {}
        for sha, rt, pid in rows:
            if not sha or not rt or not pid:
                continue
            out.setdefault(rt, {}).setdefault(str(pid), set()).add(sha)
        return out


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _project_name_for_id(pid: str) -> str | None:
    """Look up project name from project_id via SQL (cached lazily)."""
    return None  # we walk all projects, so we don't need this


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--watch-root", type=Path, default=WATCH_ROOT)
    args = parser.parse_args()

    watch_root: Path = args.watch_root
    engine = create_engine(os.environ["DATABASE_URL"])
    target = _fetch_target_shas(engine)
    total_target = sum(len(s) for rt in target.values() for s in rt.values())
    print(f"target SHAs from 7.2 audit: {total_target} across {len(target)} report_types\n")

    matches: list[dict] = []
    for project in PROJECTS:
        proc = watch_root / project / AD_PROCESSED_SUBDIR
        if not proc.is_dir():
            continue
        for path in proc.rglob("*"):
            if not path.is_file() or path.suffix.lower() not in SUPPORTED_EXTS:
                continue
            try:
                sha = _sha256(path)
            except Exception as e:
                print(f"  ERR sha {path}: {e}")
                continue
            for rt, by_pid in target.items():
                for pid_str, sha_set in by_pid.items():
                    if sha in sha_set:
                        matches.append({
                            "path": path, "project": project, "pid": pid_str,
                            "sha": sha, "rt": rt,
                        })
                        break

    seen: set[tuple[str, str, str]] = set()
    plan: list[tuple[Path, Path, dict]] = []
    duplicates: list[Path] = []
    for m in matches:
        key = (m["sha"], m["rt"], m["pid"])
        if key in seen:
            duplicates.append(m["path"])
            continue
        seen.add(key)
        dest = m["path"].parent.parent / m["path"].name
        plan.append((m["path"], dest, m))

    by_rt: dict[str, int] = {}
    for _, _, m in plan:
        by_rt[m["rt"]] = by_rt.get(m["rt"], 0) + 1
    print(f"=== {len(plan)} files to move ===\n")
    for src, dest, m in plan:
        print(f"  [{m['rt']:<32}] {src.name}")
        print(f"     from: {src}")
        print(f"     to:   {dest}")
        print(f"     sha:  {m['sha'][:12]}  pid: {m['pid']}")
    if duplicates:
        print(f"\n⚠️  {len(duplicates)} file(s) duplicate in target (skip):")
        for d in duplicates:
            print(f"     - {d}")

    print("\n=== Summary by report_type ===")
    for rt in sorted(target):
        tgt = sum(len(s) for s in target[rt].values())
        got = by_rt.get(rt, 0)
        flag = "✅" if got >= tgt else f"⚠️  missing {tgt - got}"
        print(f"  {rt:<32} {got}/{tgt}  {flag}")

    matched_total = len(plan)
    missing_total = total_target - matched_total
    if missing_total > 0:
        print(f"\n⚠️  Total missing: {missing_total} (not in processed/ — likely web-uploaded or test fixtures)")

    if not args.apply:
        print("\n(dry-run — pass --apply to actually move files)")
        return 0

    moved = 0
    for src, dest, m in plan:
        if dest.exists():
            print(f"  ⚠ dest already exists, skip: {dest}")
            continue
        try:
            shutil.move(str(src), str(dest))
            moved += 1
        except Exception as e:
            print(f"  ✗ {src.name}: {e}", file=sys.stderr)
    print(f"\nMoved {moved}/{len(plan)} file(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
