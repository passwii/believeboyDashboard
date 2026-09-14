"""Export the FastAPI-generated OpenAPI schema to a JSON file consumed by the frontend.

This script is the **first half** of the "DTO single source of truth" pipeline
(issue BEL-22-3 / BEL-29). The full chain is:

    backend (Pydantic schemas)
        │  make openapi-export   ← THIS SCRIPT
        ▼
    frontend/types/api-generated/openapi.json
        │  pnpm gen:api-types    ← frontend/ scripts/gen-api-types.mjs
        ▼
    frontend/types/api-generated/api.d.ts (TS types, git-tracked)
        │  pnpm gen:api-types --check  ← runs in pnpm build
        ▼
    CI gate: drift = build fails

The output file is committed on purpose — it makes contract changes reviewable
in a PR diff and lets the frontend repo build without booting the backend.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# Project layout: backend/scripts/openapi_export.py
# Resolved targets live in the sibling frontend/ directory.
REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = REPO_ROOT / 'frontend' / 'types' / 'api-generated' / 'openapi.json'


def build_app():
    # Import lazily so the script can be run with a clean PYTHONPATH after
    # `cd backend && pip install -r requirements.txt`.
    from app.main import app  # type: ignore[import-not-found]
    from app.api.v1.lazy_router import preload_all_lazy_groups

    # BLF-657 懒分组：FastAPI 0.139 的 openapi 生成过程中若懒分组才被加载，
    # effective_candidates 缓存失效会重建 route 克隆 → field_mapping 里的旧
    # ModelField 与新克隆对不上，直接抛 KeyError。必须在 app.openapi() 之前
    # 一次性物化全部懒分组（export 与 check 两条路径都走这里）。
    preload_all_lazy_groups()
    return app


def export(out_path: Path) -> dict:
    app = build_app()
    schema = app.openapi()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps(schema, ensure_ascii=False, indent=2, sort_keys=True) + '\n',
        encoding='utf-8',
    )
    return schema


def check(out_path: Path) -> int:
    """Regenerate to a temp buffer and diff against the committed file."""
    app = build_app()
    fresh = app.openapi()
    fresh_text = json.dumps(fresh, ensure_ascii=False, indent=2, sort_keys=True) + '\n'

    if not out_path.exists():
        print(
            f'ERROR: {out_path} does not exist. '
            'Run `make openapi-export` (or `python -m scripts.openapi_export --write`) first.',
            file=sys.stderr,
        )
        return 2

    committed = out_path.read_text(encoding='utf-8')
    if committed == fresh_text:
        print(f'OK: {out_path} matches current OpenAPI schema.')
        return 0

    print(
        f'DRIFT: {out_path} is out of date with the current FastAPI app.\n'
        'Run `make openapi-export` (or `python -m scripts.openapi_export --write`) '
        'and commit the regenerated file.',
        file=sys.stderr,
    )
    return 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        '--out',
        type=Path,
        default=DEFAULT_OUT,
        help=f'Output path for the OpenAPI JSON (default: {DEFAULT_OUT})',
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        '--write',
        action='store_true',
        default=True,
        help='Write the OpenAPI JSON to --out (default behavior).',
    )
    mode.add_argument(
        '--check',
        action='store_true',
        help='Check that --out matches the current schema; non-zero exit on drift.',
    )
    args = parser.parse_args(argv)

    if args.check:
        return check(args.out)
    export(args.out)
    print(f'Wrote OpenAPI schema to {args.out}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
