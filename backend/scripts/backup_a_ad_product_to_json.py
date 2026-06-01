"""
备份 analysis_source_files(ad_product_report) + analysis_ad_product_rows 到 JSON。

Step 8 A 表下线的最后一次保险。备份后可从 JSON 还原 A 表数据（如果将来需要）。

用法：
  python -m scripts.backup_a_ad_product_to_json
  -> 生成 /Users/damon/DamonProjects/believeboyDashboard/backend/tmp_backup/a_ad_product_backup.json
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from sqlalchemy import select

import app.models  # noqa: F401
from app.db.session import SessionLocal
from app.models import AnalysisAdProductRow, AnalysisSourceFile


def backup() -> dict:
    with SessionLocal() as s:
        files = s.execute(
            select(AnalysisSourceFile)
            .where(AnalysisSourceFile.report_type == 'ad_product_report')
        ).scalars().all()
        # 行按 source_file_id 分组
        file_ids = [f.id for f in files]
        rows = []
        if file_ids:
            rows = s.execute(
                select(AnalysisAdProductRow)
                .where(AnalysisAdProductRow.source_file_id.in_(file_ids))
            ).scalars().all()
        # 序列化
        files_dump = []
        for f in files:
            files_dump.append({
                'id': f.id,
                'project_id': f.project_id,
                'report_type': f.report_type,
                'country': f.country,
                'report_date': f.report_date.isoformat() if f.report_date else None,
                'period_start_date': f.period_start_date.isoformat() if f.period_start_date else None,
                'period_end_date': f.period_end_date.isoformat() if f.period_end_date else None,
                'version': f.version,
                'is_current': f.is_current,
                'superseded_at': f.superseded_at.isoformat() if f.superseded_at else None,
                'upload_file_id': f.upload_file_id,
                'upload_file_path': f.upload_file_path,
                'original_filename': f.original_filename,
                'stored_filename': f.stored_filename,
                'logical_filename': f.logical_filename,
                'file_size_bytes': f.file_size_bytes,
                'file_sha256': f.file_sha256,
                'ingestion_status': f.ingestion_status,
                'ingestion_error': f.ingestion_error,
                'row_count_total': f.row_count_total,
                'row_count_included': f.row_count_included,
                'created_by': f.created_by,
                'created_at': f.created_at.isoformat() if f.created_at else None,
                'updated_at': f.updated_at.isoformat() if f.updated_at else None,
            })
        rows_dump = []
        for r in rows:
            rows_dump.append({
                'id': r.id,
                'source_file_id': r.source_file_id,
                'source_row_no': r.source_row_no,
                'sku': r.sku,
                'asin': r.asin,
                'impressions': r.impressions,
                'clicks': r.clicks,
                'spend': str(r.spend) if r.spend is not None else None,
                'sales_7d': str(r.sales_7d) if r.sales_7d is not None else None,
                'orders_7d': r.orders_7d,
                'scope_status': r.scope_status,
                'scope_reason': r.scope_reason,
                'raw_row': r.raw_row,
                'created_at': r.created_at.isoformat() if r.created_at else None,
            })

        out_dir = ROOT / 'tmp_backup'
        out_dir.mkdir(exist_ok=True)
        out_path = out_dir / 'a_ad_product_backup.json'
        out_path.write_text(json.dumps({
            'backup_at': datetime.now(timezone.utc).isoformat(),
            'files_count': len(files_dump),
            'rows_count': len(rows_dump),
            'files': files_dump,
            'rows': rows_dump,
        }, ensure_ascii=False, indent=2), encoding='utf-8')
        return {
            'files': len(files_dump),
            'rows': len(rows_dump),
            'path': str(out_path),
            'size_mb': out_path.stat().st_size / 1024 / 1024,
        }


def main() -> int:
    print('备份 A 表 ad_product_report 数据...', flush=True)
    res = backup()
    print('=== 结果 ===')
    for k, v in res.items():
        print(f'  {k}: {v}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
