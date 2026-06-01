"""
回填 ad_upload_files 中由 migrate_ad_product_to_upload 创建的文件的 is_current / superseded_at，
使其与 analysis_source_files 一致。

问题：迁移时 is_current 写死 True，丢失了 A 表"同一报告多次上传"的版本历史。
此脚本逐行修复，不会删除任何已迁移数据。

用法：
  python -m scripts.backfill_ad_upload_is_current --dry-run
  python -m scripts.backfill_ad_upload_is_current
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from sqlalchemy import select

import app.models  # noqa: F401
from app.db.session import SessionLocal
from app.models import AdUploadFile, AnalysisSourceFile


MIGRATION_CREATED_BY = 'migrate_ad_product_to_upload'


def backfill(dry_run: bool) -> dict:
    fixed = 0
    already_ok = 0
    not_found_in_a = 0
    with SessionLocal() as s:
        c_files = s.execute(
            select(AdUploadFile)
            .where(AdUploadFile.created_by == MIGRATION_CREATED_BY)
            .where(AdUploadFile.report_type == 'ad_promoted_product_report')
        ).scalars().all()
        print(f'待回填 C 文件: {len(c_files)}')
        for c_f in c_files:
            a_f = s.execute(
                select(AnalysisSourceFile)
                .where(
                    AnalysisSourceFile.project_id == c_f.project_id,
                    AnalysisSourceFile.country == c_f.country,
                    AnalysisSourceFile.period_start_date == c_f.period_start_date,
                    AnalysisSourceFile.period_end_date == c_f.period_end_date,
                    AnalysisSourceFile.version == c_f.version,
                    AnalysisSourceFile.report_type == 'ad_product_report',
                )
            ).scalar_one_or_none()
            if not a_f:
                not_found_in_a += 1
                continue
            if c_f.is_current == a_f.is_current and c_f.superseded_at == a_f.superseded_at:
                already_ok += 1
                continue
            if not dry_run:
                c_f.is_current = a_f.is_current
                c_f.superseded_at = a_f.superseded_at
            fixed += 1
        if not dry_run:
            s.commit()
    return {
        'total': len(c_files),
        'fixed': fixed,
        'already_ok': already_ok,
        'not_found_in_a': not_found_in_a,
        'dry_run': dry_run,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='回填 ad_upload_files is_current / superseded_at')
    parser.add_argument('--dry-run', action='store_true', default=True)
    parser.add_argument('--write', action='store_true')
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    do_write = args.write
    mode = 'WRITE' if do_write else 'DRY-RUN'
    print(f'[{mode}] 回填 is_current / superseded_at ...', flush=True)
    res = backfill(dry_run=not do_write)
    print('=== 结果 ===')
    for k, v in res.items():
        print(f'  {k}: {v}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
