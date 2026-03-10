from __future__ import annotations

import argparse
import sys
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from sqlalchemy import and_, exists, inspect, select
from sqlalchemy.orm import Session

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import app.models  # noqa: F401  # ensure model metadata is registered
from app.db.session import SessionLocal, engine
from app.models import (
    AnalysisAdRow,
    AnalysisSalesOrderRow,
    AnalysisSourceFile,
    DailyAdProduct,
    DailySalesOrder,
    DailySourceFile,
    Project,
)


@dataclass
class MigrationStats:
    source_files_seen: int = 0
    source_files_copied: int = 0
    source_files_skipped: int = 0
    sales_rows_copied: int = 0
    ad_rows_copied: int = 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description='Migrate historical daily sales/ad records from analysis_* tables into daily_* tables.'
    )
    parser.add_argument('--project', type=str, default=None, help='Only migrate one project_name.')
    parser.add_argument('--date-from', type=_parse_date, default=None, help='Inclusive report start date, YYYY-MM-DD.')
    parser.add_argument('--date-to', type=_parse_date, default=None, help='Inclusive report end date, YYYY-MM-DD.')
    parser.add_argument('--dry-run', action='store_true', help='Preview only, do not write changes.')
    parser.add_argument(
        '--overwrite',
        action='store_true',
        help='If the target daily_source_files row already exists, replace it and its child rows.',
    )
    return parser.parse_args()


def _parse_date(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f'Invalid date: {value}') from exc


def _ensure_daily_tables_exist() -> None:
    inspector = inspect(engine)
    missing = [name for name in ('daily_source_files', 'daily_sales_order', 'daily_ad_product') if not inspector.has_table(name)]
    if missing:
        raise RuntimeError(
            f'Missing tables: {", ".join(missing)}. '
            'Run `alembic upgrade head` before executing this migration script.'
        )


def _iter_legacy_daily_sources(
    db: Session,
    *,
    project_name: str | None,
    date_from: date | None,
    date_to: date | None,
) -> Iterable[AnalysisSourceFile]:
    sales_exists_same_date = exists(
        select(1).where(
            AnalysisSourceFile.project_id == AnalysisSourceFile.project_id,
        )
    )
    sales_alias = AnalysisSourceFile.__table__.alias('sales_daily')

    ad_has_matching_sales = exists(
        select(1)
        .select_from(sales_alias)
        .where(
            sales_alias.c.project_id == AnalysisSourceFile.project_id,
            sales_alias.c.report_type == 'sales_report',
            sales_alias.c.period_start_date == AnalysisSourceFile.period_start_date,
            sales_alias.c.period_end_date == AnalysisSourceFile.period_end_date,
        )
    )

    stmt = (
        select(AnalysisSourceFile)
        .where(
            AnalysisSourceFile.report_type.in_(('sales_report', 'ad_report')),
            AnalysisSourceFile.period_start_date.is_not(None),
            AnalysisSourceFile.period_end_date.is_not(None),
            AnalysisSourceFile.period_start_date == AnalysisSourceFile.period_end_date,
        )
        .where(
            (AnalysisSourceFile.report_type == 'sales_report')
            | ((AnalysisSourceFile.report_type == 'ad_report') & ad_has_matching_sales)
        )
        .order_by(
            AnalysisSourceFile.project_id.asc(),
            AnalysisSourceFile.report_type.asc(),
            AnalysisSourceFile.period_start_date.asc(),
            AnalysisSourceFile.version.asc(),
            AnalysisSourceFile.id.asc(),
        )
    )
    if project_name:
        stmt = stmt.join(Project, Project.id == AnalysisSourceFile.project_id).where(Project.project_name == project_name)
    if date_from is not None:
        stmt = stmt.where(AnalysisSourceFile.period_start_date >= date_from)
    if date_to is not None:
        stmt = stmt.where(AnalysisSourceFile.period_start_date <= date_to)
    return db.execute(stmt).scalars().all()


def _find_existing_daily_source(
    db: Session,
    *,
    project_id: int,
    report_type: str,
    report_date: date,
    version: int,
) -> DailySourceFile | None:
    return db.execute(
        select(DailySourceFile).where(
            DailySourceFile.project_id == project_id,
            DailySourceFile.report_type == report_type,
            DailySourceFile.report_date == report_date,
            DailySourceFile.version == version,
        )
    ).scalars().first()


def _delete_existing_daily_source(db: Session, target: DailySourceFile) -> None:
    db.delete(target)
    db.flush()


def _copy_source_file(legacy: AnalysisSourceFile) -> DailySourceFile:
    report_date = legacy.period_start_date
    if report_date is None:
        raise ValueError(f'legacy source {legacy.id} missing report_date')
    return DailySourceFile(
        project_id=legacy.project_id,
        report_type=legacy.report_type,
        report_date=report_date,
        version=legacy.version,
        is_current=legacy.is_current,
        superseded_at=legacy.superseded_at,
        upload_file_id=legacy.upload_file_id,
        upload_file_path=legacy.upload_file_path,
        original_filename=legacy.original_filename,
        stored_filename=legacy.stored_filename,
        logical_filename=legacy.logical_filename,
        storage_key=_to_daily_storage_key(legacy.storage_key),
        file_size_bytes=legacy.file_size_bytes,
        file_sha256=legacy.file_sha256,
        ingestion_status=legacy.ingestion_status,
        ingestion_error=legacy.ingestion_error,
        row_count_total=legacy.row_count_total,
        row_count_included=legacy.row_count_included,
        created_by=legacy.created_by,
        created_at=legacy.created_at,
        updated_at=legacy.updated_at,
    )


def _to_daily_storage_key(storage_key: str | None) -> str:
    value = (storage_key or '').strip()
    if value.startswith('daily/'):
        return value
    if value.startswith('analysis/'):
        return 'daily/' + value[len('analysis/'):]
    return value


def _copy_sales_rows(db: Session, *, legacy_source_id: int, daily_source_id: int) -> int:
    rows = db.execute(
        select(AnalysisSalesOrderRow)
        .where(AnalysisSalesOrderRow.source_file_id == legacy_source_id)
        .order_by(AnalysisSalesOrderRow.source_row_no.asc(), AnalysisSalesOrderRow.id.asc())
    ).scalars().all()
    payload = [
        DailySalesOrder(
            source_file_id=daily_source_id,
            source_row_no=row.source_row_no,
            amazon_order_id=row.amazon_order_id,
            purchase_at_utc=row.purchase_at_utc,
            purchase_at_pt=row.purchase_at_pt,
            purchase_date_pt=row.purchase_date_pt,
            order_status=row.order_status,
            sku=row.sku,
            asin=row.asin,
            quantity=row.quantity,
            item_price=row.item_price,
            currency=row.currency,
            is_counted_sales=row.is_counted_sales,
            status_rule_version=row.status_rule_version,
            raw_row=row.raw_row,
            created_at=row.created_at,
        )
        for row in rows
    ]
    if payload:
        db.add_all(payload)
        db.flush()
    return len(payload)


def _copy_ad_rows(db: Session, *, legacy_source_id: int, daily_source_id: int) -> int:
    rows = db.execute(
        select(AnalysisAdRow)
        .where(AnalysisAdRow.source_file_id == legacy_source_id)
        .order_by(AnalysisAdRow.source_row_no.asc(), AnalysisAdRow.id.asc())
    ).scalars().all()
    payload = [
        DailyAdProduct(
            source_file_id=daily_source_id,
            source_row_no=row.source_row_no,
            sku=row.sku,
            asin=row.asin,
            impressions=row.impressions,
            clicks=row.clicks,
            spend=row.spend,
            sales_7d=row.sales_7d,
            orders_7d=row.orders_7d,
            scope_status=row.scope_status,
            scope_reason=row.scope_reason,
            raw_row=row.raw_row,
            created_at=row.created_at,
        )
        for row in rows
    ]
    if payload:
        db.add_all(payload)
        db.flush()
    return len(payload)


def migrate_history(
    db: Session,
    *,
    project_name: str | None,
    date_from: date | None,
    date_to: date | None,
    dry_run: bool,
    overwrite: bool,
) -> MigrationStats:
    stats = MigrationStats()
    legacy_sources = list(
        _iter_legacy_daily_sources(
            db,
            project_name=project_name,
            date_from=date_from,
            date_to=date_to,
        )
    )

    for legacy in legacy_sources:
        stats.source_files_seen += 1
        report_date = legacy.period_start_date
        if report_date is None:
            stats.source_files_skipped += 1
            print(f'SKIP source_id={legacy.id} missing report_date')
            continue

        existing = _find_existing_daily_source(
            db,
            project_id=legacy.project_id,
            report_type=legacy.report_type,
            report_date=report_date,
            version=legacy.version,
        )
        if existing is not None and not overwrite:
            stats.source_files_skipped += 1
            print(
                'SKIP '
                f'source_id={legacy.id} report_type={legacy.report_type} report_date={report_date} '
                f'version={legacy.version} reason=target_exists'
            )
            continue

        if existing is not None and overwrite and not dry_run:
            _delete_existing_daily_source(db, existing)

        if dry_run:
            if legacy.report_type == 'sales_report':
                row_count = db.execute(
                    select(AnalysisSalesOrderRow).where(AnalysisSalesOrderRow.source_file_id == legacy.id)
                ).scalars().all()
                stats.sales_rows_copied += len(row_count)
            else:
                row_count = db.execute(
                    select(AnalysisAdRow).where(AnalysisAdRow.source_file_id == legacy.id)
                ).scalars().all()
                stats.ad_rows_copied += len(row_count)
            stats.source_files_copied += 1
            print(
                'DRY-RUN '
                f'source_id={legacy.id} report_type={legacy.report_type} report_date={report_date} version={legacy.version}'
            )
            continue

        target = _copy_source_file(legacy)
        db.add(target)
        db.flush()

        if legacy.report_type == 'sales_report':
            stats.sales_rows_copied += _copy_sales_rows(db, legacy_source_id=legacy.id, daily_source_id=target.id)
        else:
            stats.ad_rows_copied += _copy_ad_rows(db, legacy_source_id=legacy.id, daily_source_id=target.id)

        stats.source_files_copied += 1
        print(
            'COPIED '
            f'source_id={legacy.id} -> daily_source_id={target.id} '
            f'report_type={legacy.report_type} report_date={report_date} version={legacy.version}'
        )

    return stats


def main() -> int:
    args = parse_args()
    session = SessionLocal()
    try:
        _ensure_daily_tables_exist()
        stats = migrate_history(
            session,
            project_name=(args.project or '').strip() or None,
            date_from=args.date_from,
            date_to=args.date_to,
            dry_run=bool(args.dry_run),
            overwrite=bool(args.overwrite),
        )
        if args.dry_run:
            session.rollback()
        else:
            session.commit()
    except Exception as exc:  # noqa: BLE001
        session.rollback()
        print(f'Migration failed: {exc}', file=sys.stderr)
        return 1
    finally:
        session.close()

    print(
        'Migration finished. '
        f'source_files_seen={stats.source_files_seen}, '
        f'source_files_copied={stats.source_files_copied}, '
        f'source_files_skipped={stats.source_files_skipped}, '
        f'sales_rows_copied={stats.sales_rows_copied}, '
        f'ad_rows_copied={stats.ad_rows_copied}, '
        f'dry_run={args.dry_run}'
    )
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
