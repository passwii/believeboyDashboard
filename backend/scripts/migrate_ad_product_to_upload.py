"""
将 analysis_source_files (report_type='ad_product_report') 迁移到
ad_upload_files (report_type='ad_promoted_product_report')。

设计要点：
- A 老表 raw_row 包含亚马逊原始报告全部字段，无损映射到 C 新表
- A 表 source_row_no 保留到 C 表 source_row_no
- A 表 scope_status / scope_reason 塞入 C 表 raw_row.__meta__，C 表不单列
- 跳过 C 表已存在的 (project_id, country, period_start, period_end, version)
- dry-run 默认开启，写入需显式 --write
- 写入时用 created_by='migrate_ad_product_to_upload' 标识，便于回滚

用法：
  # 干跑（不写库）
  python -m scripts.migrate_ad_product_to_upload --dry-run

  # 限定 project
  python -m scripts.migrate_ad_product_to_upload --dry-run --project-ids 1,15

  # 真实写入
  python -m scripts.migrate_ad_product_to_upload --write --project-ids 15
  python -m scripts.migrate_ad_product_to_upload --write

  # 输出报告到文件
  python -m scripts.migrate_ad_product_to_upload --dry-run --report-path /tmp/mig.json
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from sqlalchemy import func, select
from sqlalchemy.exc import OperationalError

import app.models  # noqa: F401  # ensure model metadata is registered
from app.db.session import SessionLocal
from app.models import (
    AdUploadFile,
    AdUploadPromotedProductRow,
    AnalysisAdProductRow,
    AnalysisSourceFile,
    Project,
)


MIGRATION_CREATED_BY = 'migrate_ad_product_to_upload'
OLD_REPORT_TYPE = 'ad_product_report'
NEW_REPORT_TYPE = 'ad_promoted_product_report'


# A 表 raw_row 中文 key -> C 表英文字段
# raw_row 中若字段缺失或为 None，落库时统一转为 0 / 0.0（对应 C 表的 NOT NULL Numeric/Integer）
RAW_FIELD_MAP: dict[str, str] = {
    '广告活动名称': 'campaign_name',
    '广告组名称': 'ad_group_name',
    '广告SKU': 'ad_sku',
    '广告ASIN': 'ad_asin',
}

# raw_row 中数值字段
RAW_NUM_INT_FIELDS: dict[str, str] = {
    '展示量': 'impressions',
    '点击量': 'clicks',
    '7天总订单数(#)': 'orders_7d',
    '7天总销售量(#)': 'units_7d',
    '7天内广告SKU销售量(#)': 'ad_sku_units_7d',
    '7天内其他SKU销售量(#)': 'other_sku_units_7d',
}

RAW_NUM_FLOAT_FIELDS: dict[str, str] = {
    '点击率 (CTR)': 'ctr',
    '单次点击成本 (CPC)': 'cpc',
    '花费': 'spend',
    '7天总销售额': 'sales_7d',
    '广告投入产出比 (ACOS) 总计': 'acos',
    '总广告投资回报率 (ROAS)': 'roas',
    '7天的转化率': 'cvr_7d',
    '7天内广告SKU销售额': 'ad_sku_sales_7d',
    '7天内其他SKU销售额': 'other_sku_sales_7d',
}


def _parse_date_any(value: Any) -> date | None:
    """raw_row 里的日期字段可能是 '2026-03-03T00:00:00' 这种 ISO 字符串。"""
    if value is None:
        return None
    if isinstance(value, date):
        return value
    s = str(value)
    if 'T' in s:
        s = s.split('T', 1)[0]
    try:
        return date.fromisoformat(s)
    except ValueError:
        return None


def _coerce_int(v: Any) -> int:
    if v is None or v == '':
        return 0
    if isinstance(v, bool):
        return int(v)
    if isinstance(v, int):
        return v
    if isinstance(v, float):
        return int(v)
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return 0


def _coerce_float(v: Any) -> float:
    if v is None or v == '':
        return 0.0
    if isinstance(v, bool):
        return float(int(v))
    if isinstance(v, (int, float, Decimal)):
        return float(v)
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _coerce_str(v: Any) -> str | None:
    if v is None or v == '':
        return None
    s = str(v).strip()
    return s or None


@dataclass
class MappedRow:
    """内存中构造的 C 表行（待落库）。"""
    source_row_no: int
    report_start_date: date
    report_end_date: date
    campaign_name: str | None
    ad_group_name: str | None
    ad_sku: str | None
    ad_asin: str | None
    impressions: int
    clicks: int
    ctr: float
    cpc: float
    spend: float
    sales_7d: float
    acos: float
    roas: float
    orders_7d: int
    units_7d: int
    cvr_7d: float
    ad_sku_units_7d: int
    other_sku_units_7d: int
    ad_sku_sales_7d: float
    other_sku_sales_7d: float
    raw_row: dict


# 反向 mapping：英文字段名 -> raw_row 中的中文 key
_EN_TO_CN: dict[str, str] = {v: k for k, v in RAW_FIELD_MAP.items()}


def map_old_row_to_new(
    old_row: AnalysisAdProductRow,
    old_src: AnalysisSourceFile,
) -> MappedRow:
    """把 A 表的 AnalysisAdProductRow 映射成 C 表行（不依赖 session，可单元测试）。"""
    raw = old_row.raw_row or {}
    meta = {
        '__meta__': {
            'migrated_from': 'analysis_ad_product_rows',
            'old_source_file_id': old_src.id,
            'old_source_row_no': old_row.source_row_no,
            'old_scope_status': old_row.scope_status,
            'old_scope_reason': old_row.scope_reason,
            'migrated_at': datetime.now(timezone.utc).isoformat(),
        }
    }
    # raw_row 保留原始中文 key（不破坏数据），meta 追加
    enriched_raw = {**raw, **meta}

    # 日期：优先用 raw_row 的开始/结束日期，回退到老 AnalysisSourceFile 的 period
    start_date = _parse_date_any(raw.get('开始日期')) or old_src.period_start_date
    end_date = _parse_date_any(raw.get('结束日期')) or old_src.period_end_date

    def _cn(field_en: str) -> str:
        return _EN_TO_CN[field_en]

    return MappedRow(
        source_row_no=old_row.source_row_no,
        report_start_date=start_date,
        report_end_date=end_date,
        campaign_name=_coerce_str(raw.get(_cn('campaign_name'))),
        ad_group_name=_coerce_str(raw.get(_cn('ad_group_name'))),
        ad_sku=_coerce_str(raw.get(_cn('ad_sku'))),
        ad_asin=_coerce_str(raw.get(_cn('ad_asin'))),
        impressions=_coerce_int(raw.get('展示量')),
        clicks=_coerce_int(raw.get('点击量')),
        ctr=_coerce_float(raw.get('点击率 (CTR)')),
        cpc=_coerce_float(raw.get('单次点击成本 (CPC)')),
        spend=_coerce_float(raw.get('花费')),
        sales_7d=_coerce_float(raw.get('7天总销售额')),
        acos=_coerce_float(raw.get('广告投入产出比 (ACOS) 总计')),
        roas=_coerce_float(raw.get('总广告投资回报率 (ROAS)')),
        orders_7d=_coerce_int(raw.get('7天总订单数(#)')),
        units_7d=_coerce_int(raw.get('7天总销售量(#)')),
        cvr_7d=_coerce_float(raw.get('7天的转化率')),
        ad_sku_units_7d=_coerce_int(raw.get('7天内广告SKU销售量(#)')),
        other_sku_units_7d=_coerce_int(raw.get('7天内其他SKU销售量(#)')),
        ad_sku_sales_7d=_coerce_float(raw.get('7天内广告SKU销售额')),
        other_sku_sales_7d=_coerce_float(raw.get('7天内其他SKU销售额')),
        raw_row=enriched_raw,
    )


@dataclass
class MappedFile:
    """内存中构造的 C 表 source_file。"""
    project_id: int
    project_name: str
    country: str
    report_date: date | None
    period_start_date: date
    period_end_date: date
    version: int
    is_current: bool
    superseded_at: Any | None
    old_source_file_id: int
    rows: list[MappedRow] = field(default_factory=list)


@dataclass
class MigrationReport:
    skipped_existing: list[dict] = field(default_factory=list)  # (project, country, period, version) 已存在
    to_migrate: list[MappedFile] = field(default_factory=list)   # 待迁移的文件
    total_spend: float = 0.0
    total_sales_7d: float = 0.0
    total_orders_7d: int = 0
    total_clicks: int = 0
    total_impressions: int = 0
    project_breakdown: dict[int, dict] = field(default_factory=dict)
    field_coverage: dict[str, int] = field(default_factory=dict)
    field_coverage_total: int = 0
    old_files_total: int = 0
    old_rows_total: int = 0
    skipped_existing_rows: int = 0
    existing_in_c_count: int = 0

    def to_dict(self) -> dict:
        return {
            'summary': {
                'old_files_total': self.old_files_total,
                'old_rows_total': self.old_rows_total,
                'existing_in_c_count': self.existing_in_c_count,
                'skipped_existing_files': len(self.skipped_existing),
                'skipped_existing_rows': self.skipped_existing_rows,
                'to_migrate_files': len(self.to_migrate),
                'to_migrate_rows': sum(len(f.rows) for f in self.to_migrate),
                'total_spend': round(self.total_spend, 2),
                'total_sales_7d': round(self.total_sales_7d, 2),
                'total_orders_7d': self.total_orders_7d,
                'total_clicks': self.total_clicks,
                'total_impressions': self.total_impressions,
            },
            'project_breakdown': self.project_breakdown,
            'field_coverage': {
                k: round(v / max(self.field_coverage_total, 1) * 100, 2)
                for k, v in self.field_coverage.items()
            },
            'skipped_existing_sample': self.skipped_existing[:20],
            'to_migrate_sample': [
                {
                    'project_id': f.project_id,
                    'project_name': f.project_name,
                    'country': f.country,
                    'period_start': f.period_start_date.isoformat(),
                    'period_end': f.period_end_date.isoformat(),
                    'version': f.version,
                    'old_source_file_id': f.old_source_file_id,
                    'row_count': len(f.rows),
                }
                for f in self.to_migrate[:20]
            ],
        }


def collect_migration_plan(
    project_ids: list[int] | None,
) -> MigrationReport:
    """dry run 的核心：纯内存生成迁移计划。"""
    report = MigrationReport()

    with SessionLocal() as s:
        # 1. 读 A 表 source files
        stmt = select(AnalysisSourceFile).where(AnalysisSourceFile.report_type == OLD_REPORT_TYPE)
        if project_ids:
            stmt = stmt.where(AnalysisSourceFile.project_id.in_(project_ids))
        stmt = stmt.order_by(AnalysisSourceFile.project_id, AnalysisSourceFile.country, AnalysisSourceFile.period_start_date)
        old_files: list[AnalysisSourceFile] = list(s.scalars(stmt))
        report.old_files_total = len(old_files)
        if not old_files:
            return report

        # 2. 一次性把项目名拉出来
        pids = sorted({f.project_id for f in old_files})
        projects = {p.id: p.project_name for p in s.scalars(select(Project).where(Project.id.in_(pids)))}

        # 3. 一次性把 C 表现有 (project, country, period_start, period_end, version) 拉出来判重
        c_stmt = select(
            AdUploadFile.project_id,
            AdUploadFile.country,
            AdUploadFile.period_start_date,
            AdUploadFile.period_end_date,
            AdUploadFile.version,
        ).where(AdUploadFile.report_type == NEW_REPORT_TYPE)
        if project_ids:
            c_stmt = c_stmt.where(AdUploadFile.project_id.in_(project_ids))
        existing_keys: set[tuple[int, str, date, date, int]] = set()
        for pid, country, ps, pe, ver in s.execute(c_stmt).all():
            existing_keys.add((pid, country, ps, pe, ver))
        report.existing_in_c_count = len(existing_keys)

        # 4. 遍历 A 文件
        for old_src in old_files:
            # 先统计 A 文件行数（无论是否跳过都要算上）
            row_count = s.execute(
                select(func.count(AnalysisAdProductRow.id)).where(AnalysisAdProductRow.source_file_id == old_src.id)
            ).scalar_one()
            report.old_rows_total += row_count

            key = (old_src.project_id, old_src.country, old_src.period_start_date, old_src.period_end_date, old_src.version)
            if key in existing_keys:
                report.skipped_existing.append({
                    'project_id': old_src.project_id,
                    'country': old_src.country,
                    'period_start': old_src.period_start_date.isoformat(),
                    'period_end': old_src.period_end_date.isoformat(),
                    'version': old_src.version,
                    'is_current': old_src.is_current,
                    'old_source_file_id': old_src.id,
                    'old_rows': row_count,
                })
                report.skipped_existing_rows += row_count
                continue

            rows = s.scalars(
                select(AnalysisAdProductRow)
                .where(AnalysisAdProductRow.source_file_id == old_src.id)
                .order_by(AnalysisAdProductRow.source_row_no)
            ).all()
            if not rows:
                continue

            mf = MappedFile(
                project_id=old_src.project_id,
                project_name=projects.get(old_src.project_id, f'project_{old_src.project_id}'),
                country=old_src.country,
                report_date=old_src.report_date,
                period_start_date=old_src.period_start_date,
                period_end_date=old_src.period_end_date,
                version=old_src.version,
                is_current=old_src.is_current,
                superseded_at=old_src.superseded_at,
                old_source_file_id=old_src.id,
            )

            # 字段覆盖率统计
            for r in rows:
                raw = r.raw_row or {}
                report.field_coverage_total += 1
                for k in (*RAW_NUM_INT_FIELDS, *RAW_NUM_FLOAT_FIELDS, *RAW_FIELD_MAP):
                    if k in raw and raw[k] is not None:
                        report.field_coverage[k] = report.field_coverage.get(k, 0) + 1

            file_spend = 0.0
            file_sales = 0.0
            file_orders = 0
            for r in rows:
                mr = map_old_row_to_new(r, old_src)
                mf.rows.append(mr)
                report.total_spend += mr.spend
                report.total_sales_7d += mr.sales_7d
                report.total_orders_7d += mr.orders_7d
                report.total_clicks += mr.clicks
                report.total_impressions += mr.impressions
                file_spend += mr.spend
                file_sales += mr.sales_7d
                file_orders += mr.orders_7d

            report.to_migrate.append(mf)
            pb = report.project_breakdown.setdefault(mf.project_id, {
                'project_name': mf.project_name,
                'files': 0,
                'rows': 0,
                'spend': 0.0,
                'sales_7d': 0.0,
                'orders_7d': 0,
            })
            pb['files'] += 1
            pb['rows'] += len(mf.rows)
            pb['spend'] = round(pb['spend'] + file_spend, 2)
            pb['sales_7d'] = round(pb['sales_7d'] + file_sales, 2)
            pb['orders_7d'] += file_orders

    return report


def execute_migration(
    report: MigrationReport,
    *,
    project_ids: list[int] | None = None,
) -> dict:
    """实际写入 C 表。**每个 file 独立事务**，失败不影响前面的成果。

    已写入 file 用 `created_by=MIGRATION_CREATED_BY` 标识 + (project, country, period, version) 判重。
    重跑时已存在的会被 collect_migration_plan 跳过，所以这个函数本身不需要额外判重。
    """
    inserted_files = 0
    inserted_rows = 0
    errors: list[tuple[int, int, str]] = []  # (old_source_file_id, project_id, error)

    targets = report.to_migrate
    if project_ids:
        targets = [f for f in targets if f.project_id in set(project_ids)]

    total = len(targets)
    last_log_at = 0.0
    import time

    for idx, mf in enumerate(targets, 1):
        try:
            with SessionLocal() as s:
                upload_file = AdUploadFile(
                    project_id=mf.project_id,
                    project_name=mf.project_name,
                    report_type=NEW_REPORT_TYPE,
                    report_label=f'Migrated-Ad-Promoted-Product-{mf.period_start_date.isoformat()}',
                    country=mf.country,
                    report_date=mf.report_date,
                    period_start_date=mf.period_start_date,
                    period_end_date=mf.period_end_date,
                    version=mf.version,
                    # 保留 A 表的 is_current 状态：同一报告多次上传时只有最新版 is_current=True
                    is_current=mf.is_current,
                    superseded_at=mf.superseded_at,
                    upload_file_id=f'migrated_from_analysis:{mf.old_source_file_id}',
                    upload_file_path=f'migrated://analysis_source_files/{mf.old_source_file_id}',
                    original_filename=None,
                    stored_filename=f'migrated_{mf.old_source_file_id}.xlsx',
                    logical_filename=f'migrated-ad-promoted-product-{mf.period_start_date.isoformat()}.xlsx',
                    file_extension='.xlsx',
                    file_size_bytes=None,
                    recognition_status='recognized',
                    ingestion_status='saved',
                    ingestion_error=None,
                    row_count_preview=len(mf.rows),
                    matched_columns=list(RAW_NUM_INT_FIELDS) + list(RAW_NUM_FLOAT_FIELDS) + list(RAW_FIELD_MAP),
                    warnings=[],
                    recognition_payload={'migrated_from': 'analysis_ad_product_rows', 'old_source_file_id': mf.old_source_file_id},
                    created_by=MIGRATION_CREATED_BY,
                )
                s.add(upload_file)
                s.flush()  # 让 upload_file.id 产生
                new_file_id = upload_file.id

                for mr in mf.rows:
                    s.add(AdUploadPromotedProductRow(
                        source_file_id=new_file_id,
                        source_row_no=mr.source_row_no,
                        report_start_date=mr.report_start_date,
                        report_end_date=mr.report_end_date,
                        campaign_name=mr.campaign_name,
                        ad_group_name=mr.ad_group_name,
                        ad_sku=mr.ad_sku,
                        ad_asin=mr.ad_asin,
                        impressions=mr.impressions,
                        clicks=mr.clicks,
                        ctr=mr.ctr,
                        cpc=mr.cpc,
                        spend=mr.spend,
                        sales_7d=mr.sales_7d,
                        acos=mr.acos,
                        roas=mr.roas,
                        orders_7d=mr.orders_7d,
                        units_7d=mr.units_7d,
                        cvr_7d=mr.cvr_7d,
                        ad_sku_units_7d=mr.ad_sku_units_7d,
                        other_sku_units_7d=mr.other_sku_units_7d,
                        ad_sku_sales_7d=mr.ad_sku_sales_7d,
                        other_sku_sales_7d=mr.other_sku_sales_7d,
                        raw_row=mr.raw_row,
                    ))
                s.commit()
                inserted_files += 1
                inserted_rows += len(mf.rows)
        except Exception as exc:
            errors.append((mf.old_source_file_id, mf.project_id, str(exc)))
            print(f'  ❌ 失败: old_sf_id={mf.old_source_file_id} project={mf.project_id}: {exc}', flush=True)
            # 不 raise，继续下一个 file
            continue

        # 进度日志（每 50 个或 1 秒）
        now = time.time()
        if idx % 50 == 0 or now - last_log_at > 2.0 or idx == total:
            pct = idx * 100 / total
            print(f'  [{idx}/{total}] {pct:.1f}% 累计 files={inserted_files} rows={inserted_rows}', flush=True)
            last_log_at = now

    return {
        'inserted_files': inserted_files,
        'inserted_rows': inserted_rows,
        'errors': errors,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description='迁移 analysis_source_files(ad_product_report) → ad_upload_files(ad_promoted_product_report)',
    )
    parser.add_argument('--dry-run', action='store_true', default=True,
                        help='默认 dry-run，只生成报告，不写库。')
    parser.add_argument('--write', action='store_true',
                        help='实际写入 C 表。覆盖 --dry-run。')
    parser.add_argument('--project-ids', type=str, default=None,
                        help='限定 project_id，逗号分隔，如 1,4,15。')
    parser.add_argument('--report-path', type=str, default=None,
                        help='报告 JSON 输出路径。')
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    project_ids = None
    if args.project_ids:
        project_ids = [int(x.strip()) for x in args.project_ids.split(',') if x.strip()]

    do_write = args.write
    mode = 'WRITE' if do_write else 'DRY-RUN'
    print(f'[{mode}] 启动迁移...', flush=True)
    if project_ids:
        print(f'[{mode}] 限定 project_ids: {project_ids}', flush=True)

    try:
        report = collect_migration_plan(project_ids=project_ids)
    except OperationalError as exc:
        print(f'[{mode}] DB 不可达: {exc}', file=sys.stderr)
        return 1

    # 控制台摘要
    s = report.to_dict()['summary']
    print('\n=== 摘要 ===')
    for k, v in s.items():
        print(f'  {k}: {v}')

    if report.skipped_existing:
        print(f'\n=== 跳过 (C 表已存在) ===')
        print(f'  共 {len(report.skipped_existing)} 个 A 文件已迁过，{report.skipped_existing_rows} 行未重复处理。')
    print('\n=== 项目级分布 ===')
    for pid, pb in sorted(report.project_breakdown.items()):
        print(f'  project_id={pid:>3} ({pb["project_name"]:<10}) files={pb["files"]:>4} rows={pb["rows"]:>6} spend={pb["spend"]:>12,.2f} sales={pb["sales_7d"]:>12,.2f} orders={pb["orders_7d"]:>6}')
    print('\n=== 字段覆盖率 (raw_row) ===')
    for k, v in sorted(report.field_coverage.items(), key=lambda x: -x[1]):
        pct = v * 100 / max(report.field_coverage_total, 1)
        print(f'  {k}: {pct:.1f}%  ({v}/{report.field_coverage_total})')

    if args.report_path:
        Path(args.report_path).write_text(json.dumps(report.to_dict(), ensure_ascii=False, indent=2))
        print(f'\n报告已写入: {args.report_path}')

    if not do_write:
        print('\n[DRY-RUN] 结束，未写库。带 --write 实际写入。')
        return 0

    print('\n[WRITE] 开始写入...', flush=True)
    res = execute_migration(report, project_ids=project_ids)
    print(f"\n[WRITE] 完成: files={res['inserted_files']} rows={res['inserted_rows']} errors={len(res['errors'])}")
    if res['errors']:
        print('[WRITE] 失败明细:')
        for old_sf_id, pid, msg in res['errors'][:20]:
            print(f'  - old_sf_id={old_sf_id} project={pid}: {msg}')
        if len(res['errors']) > 20:
            print(f'  ... 还有 {len(res["errors"]) - 20} 个错误')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
