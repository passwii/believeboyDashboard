"""Replay 7.2 错文件: 从 processed/ 移回项目根目录让 daemon 重识别。

7.2 18-24 点, 20 个 sales_report 文件走了错的 ingest 路径 (daemon
fallback + autoReportUpload-reprocess), 数据错位。fix 部署后, 这些
文件需要让 daemon 重新跑。

工具脚本 (dry-run by default) 把 processed/ 里的 7.2 错文件移回
WATCH_ROOT/<项目>/, 跳过重复 (同名文件出现在多个项目的 processed/
时, 只在源项目里移回, 不复制)。

Usage:
    # dry-run (default): 打印移动计划
    python replay_july2_to_root.py

    # 实际移动
    python replay_july2_to_root.py --apply

    # 自定义 WATCH_ROOT
    python replay_july2_to_root.py --watch-root /custom/path
"""
from __future__ import annotations

import argparse
import shutil
import sys
from collections import defaultdict
from pathlib import Path

# 7.2 错数据的 20 个 source_file id (after SQL fixup 删)
JULY2_BAD_SOURCE_IDS = [
    27758, 27761, 27771, 27773, 27774, 27776, 27778, 27779, 27780,
    27782, 27784, 27786, 27787, 27788, 27789, 27790, 27791, 27792,
    27793, 27794,
]

PROCESSED_SUBDIR = "processed"

PROJECTS = [
    "博朗姆", "金石", "弥森", "卡斯摩", "创酷", "吕沃", "铨富",
    "骏成", "华洋泛航", "玥涵", "博智1店", "博智2店", "犀牛", "瑞迪特",
]


def _connect_db():
    """Lazy import — requires the project's backend venv."""
    backend_dir = str(Path(__file__).parent.parent.parent / "backend")
    if backend_dir not in sys.path:
        sys.path.insert(0, backend_dir)
    from app.db.session import SessionLocal
    return SessionLocal()


def _fetch_bad_filenames(session) -> dict[str, int]:
    """Return {filename: project_id} for the 20 7.2 bad source files.

    Tries two strategies in order:

    1. **analysis_source_files** (pre-fixup): direct lookup.
    2. **HARDCODED_FALLBACK**: 20 (filename, project_id) tuples
       captured from the pre-fixup SELECT, used after the SQL
       fixup has deleted the source rows. We intentionally do NOT
       look at report_upload_logs here because some filenames
       (e.g. ``Orders-2026-07-02_18-03-36.txt``) appear under
       multiple project_ids in the upload log, and that ambiguity
       is exactly what the SQL fixup resolved by anchoring each
       filename to a single canonical project.
    """
    from sqlalchemy import text

    # Strategy 1: direct lookup on analysis_source_files.
    rows = session.execute(
        text(
            "SELECT project_id, original_filename FROM analysis_source_files "
            "WHERE id = ANY(:ids)"
        ),
        {"ids": JULY2_BAD_SOURCE_IDS},
    ).all()
    if rows:
        return {row[1]: int(row[0]) for row in rows}

    # Strategy 2: hardcoded fallback.
    return dict(HARDCODED_FALLBACK)


# Captured from the 2026-07-03 09:55 SELECT against analysis_source_files
# (BEFORE the SQL fixup deleted them). If a future round of 7.2-style
# bad data appears, capture the new mapping and append here. Used as
# the strategy-3 fallback when both source_file and upload_log
# lookups are unavailable.
HARDCODED_FALLBACK: dict[str, int] = {
    "Orders-2026-07-02_14-47-46.txt": 1,   # 铨富
    "Orders-2026-07-02_18-03-29.txt": 1,   # 铨富
    "Orders-2026-07-02_14-47-41.txt": 4,   # 玥涵
    "Orders-2026-07-02_18-03-41.txt": 4,   # 玥涵
    "Orders-2026-07-02_14-49-25.txt": 5,   # 博智1店
    "Orders-2026-07-02_18-05-44.txt": 5,   # 博智1店
    "Orders-2026-07-02_14-49-32.txt": 6,   # 博智2店
    "Orders-2026-07-02_18-05-45.txt": 6,   # 博智2店
    "Orders-2026-07-02_14-49-27.txt": 7,   # 骏成
    "Orders-2026-07-02_18-05-35.txt": 7,   # 骏成
    "Orders-2026-07-02_14-47-39.txt": 8,   # 华洋泛航
    "Orders-2026-07-02_14-48-41.txt": 10,  # 弥森
    "Orders-2026-07-02_14-48-46.txt": 14,  # 卡斯摩
    "Orders-2026-07-02_18-04-35.txt": 15,  # 创酷
    "Orders-2026-07-02_14-48-42.txt": 15,  # 创酷
    "Orders-2026-07-02_18-04-42.txt": 16,  # 吕沃
    "Orders-2026-07-02_14-48-29.txt": 16,  # 吕沃
    "Orders-2026-07-02_14-47-43.txt": 18,  # 犀牛
    "Orders-2026-07-02_18-03-36.txt": 19,  # 博朗姆
    "Orders-2026-07-02_14-47-47.txt": 19,  # 博朗姆
}


def _find_in_processed(watch_root: Path, filename: str) -> list[Path]:
    """Find every processed/ location containing this filename."""
    matches: list[Path] = []
    for project in PROJECTS:
        proc = watch_root / project / PROCESSED_SUBDIR
        if not proc.is_dir():
            continue
        candidate = proc / filename
        if candidate.is_file():
            matches.append(candidate)
    return matches


def _plan_moves(watch_root: Path) -> list[tuple[Path, Path, str, int]]:
    """Build the move plan.

    Returns a list of (source_path, dest_path, original_filename, project_id)
    tuples. For files that exist in multiple projects' processed/ folders
    (e.g. the synthetic `Orders-2026-07-02_18-03-36.txt` that 3 projects
    share), we only keep the first match (preferring the first project
    in PROJECTS list) and warn about the duplicates.
    """
    session = _connect_db()
    try:
        file_to_project = _fetch_bad_filenames(session)
    finally:
        session.close()

    plan: list[tuple[Path, Path, str, int]] = []
    seen: set[str] = set()
    duplicates: list[tuple[str, list[Path]]] = []

    for filename, project_id in file_to_project.items():
        if filename in seen:
            continue
        seen.add(filename)

        locations = _find_in_processed(watch_root, filename)
        if not locations:
            print(f"  ⚠️  {filename}: not found in any processed/ — skipped")
            continue
        if len(locations) > 1:
            duplicates.append((filename, locations))

        # Pick the project whose processed/ contains it. The fixup SQL
        # already pinned the canonical project_id; if a file is shared
        # we move from the FIRST project's processed/ only.
        src = locations[0]
        # Recover project name from src path
        project_name = src.parent.parent.name
        dest = src.parent.parent / filename
        plan.append((src, dest, filename, project_id))

    return plan, duplicates


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Move 7.2 bad files from processed/ back to project root."
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Actually move files (default is dry-run).",
    )
    parser.add_argument(
        "--watch-root",
        type=Path,
        default=Path("/Users/damon/Documents/RPA"),
        help="WATCH_ROOT (default: /Users/damon/Documents/RPA)",
    )
    args = parser.parse_args()

    watch_root: Path = args.watch_root
    if not watch_root.is_dir():
        print(f"❌ WATCH_ROOT does not exist: {watch_root}", file=sys.stderr)
        return 1

    print(f"WATCH_ROOT: {watch_root}")
    print(f"Mode: {'APPLY' if args.apply else 'DRY-RUN'}\n")

    plan, duplicates = _plan_moves(watch_root)

    if not plan:
        print("Nothing to move.")
        return 0

    print(f"Plan: {len(plan)} file(s) to move\n")
    for src, dest, filename, project_id in plan:
        action = "MOVE" if args.apply else "would move"
        print(f"  [{action}] {filename}")
        print(f"     from: {src}")
        print(f"     to:   {dest}")
        print(f"     (project_id={project_id})")

    if duplicates:
        print(f"\n⚠️  {len(duplicates)} filename(s) exist in multiple processed/:")
        for filename, locations in duplicates:
            print(f"   {filename}:")
            for loc in locations:
                print(f"     - {loc}")

    if not args.apply:
        print("\n(dry-run — pass --apply to actually move files)")
        return 0

    moved = 0
    for src, dest, filename, project_id in plan:
        try:
            shutil.move(str(src), str(dest))
            moved += 1
            print(f"  ✓ {filename}")
        except Exception as exc:
            print(f"  ✗ {filename}: {exc}", file=sys.stderr)

    print(f"\nMoved {moved}/{len(plan)} file(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
