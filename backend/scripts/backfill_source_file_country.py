from __future__ import annotations

import argparse
import sys
from collections import Counter, defaultdict
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from sqlalchemy import inspect, select
from sqlalchemy.orm import Session

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import app.models  # noqa: F401  # ensure model metadata is registered
from app.db.session import SessionLocal, engine
from app.models import (
    AnalysisAdRow,
    AnalysisBusinessRow,
    AnalysisPaymentRow,
    AnalysisSalesOrderRow,
    AnalysisSourceFile,
    DailyAdProduct,
    DailySalesOrder,
    DailySourceFile,
    ProductCost,
    Project,
)

ALLOWED_COUNTRIES = {'US', 'DE', 'UK'}


@dataclass
class SourceDecision:
    source_kind: str
    source_id: int
    project_name: str
    report_type: str
    period_label: str
    current_country: str
    inferred_country: str | None
    reason: str
    evidence_counts: dict[str, int]
    ambiguous_rows: int
    unknown_rows: int
    row_count: int
    conflict: bool = False


@dataclass
class Stats:
    scanned: int = 0
    updated: int = 0
    unchanged: int = 0
    skipped_no_inference: int = 0
    skipped_conflict: int = 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Backfill country on analysis/daily source files using product_cost mappings.')
    parser.add_argument('--project', type=str, default=None, help='Only process one project_name.')
    parser.add_argument('--report-type', type=str, default=None, help='Only process one report_type.')
    parser.add_argument('--date-from', type=_parse_date, default=None, help='Inclusive date filter, YYYY-MM-DD.')
    parser.add_argument('--date-to', type=_parse_date, default=None, help='Inclusive date filter, YYYY-MM-DD.')
    parser.add_argument('--apply', action='store_true', help='Write changes to the database. Default is dry-run.')
    parser.add_argument(
        '--fallback-single-country',
        action='store_true',
        help='If a project only has one product_cost country, use it when row evidence is empty.',
    )
    parser.add_argument(
        '--fallback-default-country',
        type=str,
        default=None,
        help='Fallback country for unresolved rows, e.g. US. Omit to skip unresolved sources.',
    )
    parser.add_argument('--limit', type=int, default=None, help='Only inspect the first N source files after filtering.')
    return parser.parse_args()


def _parse_date(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f'Invalid date: {value}') from exc


def _normalize_identity(value: str | None) -> str:
    return (value or '').strip().upper()


def _normalize_country(value: str | None) -> str | None:
    normalized = (value or '').strip().upper()
    return normalized if normalized in ALLOWED_COUNTRIES else None


def _ensure_tables_exist() -> None:
    inspector = inspect(engine)
    required = {'analysis_source_files', 'daily_source_files', 'product_costs'}
    missing = [name for name in required if not inspector.has_table(name)]
    if missing:
        raise RuntimeError(
            f'Missing tables: {", ".join(sorted(missing))}. '
            'Run `alembic upgrade head` before executing this script.'
        )


def _load_project_mappings(db: Session) -> dict[int, dict[str, object]]:
    rows = db.execute(
        select(Project.id, Project.project_name, ProductCost.sku, ProductCost.asin, ProductCost.country)
        .join(ProductCost, ProductCost.project_name == Project.project_name)
    ).all()

    result: dict[int, dict[str, object]] = {}
    for project_id, project_name, sku, asin, country in rows:
        normalized_country = _normalize_country(country)
        if normalized_country is None:
            continue
        item = result.setdefault(
            int(project_id),
            {
                'project_name': project_name,
                'sku_map': defaultdict(set),
                'asin_map': defaultdict(set),
                'project_countries': set(),
            },
        )
        item['project_countries'].add(normalized_country)
        normalized_sku = _normalize_identity(sku)
        normalized_asin = _normalize_identity(asin)
        if normalized_sku:
            item['sku_map'][normalized_sku].add(normalized_country)
        if normalized_asin:
            item['asin_map'][normalized_asin].add(normalized_country)
    return result


def _iter_analysis_sources(
    db: Session,
    *,
    project_name: str | None,
    report_type: str | None,
    date_from: date | None,
    date_to: date | None,
    limit: int | None,
) -> list[AnalysisSourceFile]:
    stmt = select(AnalysisSourceFile).join(Project, Project.id == AnalysisSourceFile.project_id)
    if project_name:
        stmt = stmt.where(Project.project_name == project_name)
    if report_type:
        stmt = stmt.where(AnalysisSourceFile.report_type == report_type)
    if date_from is not None:
        stmt = stmt.where(
            (AnalysisSourceFile.period_start_date.is_not(None) & (AnalysisSourceFile.period_start_date >= date_from))
            | (AnalysisSourceFile.snapshot_at.is_not(None))
        )
    if date_to is not None:
        stmt = stmt.where(
            (AnalysisSourceFile.period_start_date.is_not(None) & (AnalysisSourceFile.period_start_date <= date_to))
            | (AnalysisSourceFile.snapshot_at.is_not(None))
        )
    stmt = stmt.order_by(AnalysisSourceFile.project_id.asc(), AnalysisSourceFile.id.asc())
    if limit:
        stmt = stmt.limit(limit)
    return db.execute(stmt).scalars().all()


def _iter_daily_sources(
    db: Session,
    *,
    project_name: str | None,
    report_type: str | None,
    date_from: date | None,
    date_to: date | None,
    limit: int | None,
) -> list[DailySourceFile]:
    stmt = select(DailySourceFile).join(Project, Project.id == DailySourceFile.project_id)
    if project_name:
        stmt = stmt.where(Project.project_name == project_name)
    if report_type:
        stmt = stmt.where(DailySourceFile.report_type == report_type)
    if date_from is not None:
        stmt = stmt.where(DailySourceFile.report_date >= date_from)
    if date_to is not None:
        stmt = stmt.where(DailySourceFile.report_date <= date_to)
    stmt = stmt.order_by(DailySourceFile.project_id.asc(), DailySourceFile.id.asc())
    if limit:
        stmt = stmt.limit(limit)
    return db.execute(stmt).scalars().all()


def _map_country_token(value: str | None) -> str | None:
    normalized = (value or '').strip().upper()
    if not normalized:
        return None
    direct = {
        'US': 'US',
        'USA': 'US',
        'AMAZON.COM': 'US',
        'DE': 'DE',
        'GERMANY': 'DE',
        'AMAZON.DE': 'DE',
        'UK': 'UK',
        'GB': 'UK',
        'UNITED KINGDOM': 'UK',
        'AMAZON.CO.UK': 'UK',
        '德国': 'DE',
        '美国': 'US',
        '英国': 'UK',
    }
    if normalized in direct:
        return direct[normalized]
    if normalized.endswith('.DE'):
        return 'DE'
    if normalized.endswith('.COM'):
        return 'US'
    if normalized.endswith('.CO.UK'):
        return 'UK'
    return None


def _map_currency_token(value: str | None) -> str | None:
    normalized = (value or '').strip().upper()
    return {
        'USD': 'US',
        'US$': 'US',
        'EUR': 'DE',
        'GBP': 'UK',
    }.get(normalized)


def _row_hint_countries(raw_row: dict | None) -> set[str]:
    if not isinstance(raw_row, dict):
        return set()

    result: set[str] = set()
    for key, value in raw_row.items():
        text_key = str(key).strip().lower()
        text_value = None if value is None else str(value).strip()
        if not text_value:
            continue
        if text_key in {'currency', '货币'}:
            mapped = _map_currency_token(text_value)
            if mapped:
                result.add(mapped)
            continue
        if text_key in {'marketplace', '国家/地区', 'country/region', 'sales-channel', 'ship-country'}:
            mapped = _map_country_token(text_value)
            if mapped:
                result.add(mapped)
    return result


def _analysis_rows(db: Session, source: AnalysisSourceFile) -> Iterable[tuple[str | None, str | None, dict | None]]:
    model_map = {
        'business_report': AnalysisBusinessRow,
        'payment_report': AnalysisPaymentRow,
        'ad_report': AnalysisAdRow,
        'sales_report': AnalysisSalesOrderRow,
    }
    if source.report_type == 'inventory_report':
        from app.models import InventorySnapshotRow

        rows = db.execute(
            select(InventorySnapshotRow.sku, InventorySnapshotRow.asin, InventorySnapshotRow.raw_row)
            .where(InventorySnapshotRow.source_file_id == source.id)
        ).all()
        return [(sku, asin, raw_row) for sku, asin, raw_row in rows]

    model = model_map.get(source.report_type)
    if model is None:
        return []
    if source.report_type == 'business_report':
        rows = db.execute(
            select(AnalysisBusinessRow.asin, AnalysisBusinessRow.raw_row).where(AnalysisBusinessRow.source_file_id == source.id)
        ).all()
        return [(None, asin, raw_row) for asin, raw_row in rows]
    rows = db.execute(select(model.sku, model.asin, model.raw_row).where(model.source_file_id == source.id)).all()
    return [(sku, asin, raw_row) for sku, asin, raw_row in rows]


def _daily_rows(db: Session, source: DailySourceFile) -> Iterable[tuple[str | None, str | None, dict | None]]:
    if source.report_type == 'sales_report':
        rows = db.execute(
            select(DailySalesOrder.sku, DailySalesOrder.asin, DailySalesOrder.raw_row).where(DailySalesOrder.source_file_id == source.id)
        ).all()
        return [(sku, asin, raw_row) for sku, asin, raw_row in rows]
    rows = db.execute(
        select(DailyAdProduct.sku, DailyAdProduct.asin, DailyAdProduct.raw_row).where(DailyAdProduct.source_file_id == source.id)
    ).all()
    return [(sku, asin, raw_row) for sku, asin, raw_row in rows]


def _infer_country(
    rows: Iterable[tuple[str | None, str | None, dict | None]],
    *,
    sku_map: dict[str, set[str]],
    asin_map: dict[str, set[str]],
    project_countries: set[str],
    fallback_single_country: bool,
    fallback_default_country: str | None,
) -> tuple[str | None, str, dict[str, int], int, int, int]:
    evidence = Counter()
    ambiguous_rows = 0
    unknown_rows = 0
    row_count = 0

    for sku, asin, raw_row in rows:
        row_count += 1
        countries = _row_hint_countries(raw_row)
        normalized_sku = _normalize_identity(sku)
        normalized_asin = _normalize_identity(asin)
        mapping_countries = set()
        if normalized_sku:
            mapping_countries.update(sku_map.get(normalized_sku, set()))
        if normalized_asin:
            mapping_countries.update(asin_map.get(normalized_asin, set()))

        if not countries:
            countries = mapping_countries

        if not countries:
            unknown_rows += 1
            continue
        if len(countries) > 1:
            ambiguous_rows += 1
            continue
        evidence[next(iter(countries))] += 1

    if len(evidence) == 1:
        country = next(iter(evidence))
        return country, 'row_evidence_unique', dict(evidence), ambiguous_rows, unknown_rows, row_count

    if len(evidence) > 1:
        ranked = evidence.most_common()
        top_country, top_count = ranked[0]
        second_count = ranked[1][1]
        if top_count > second_count:
            return top_country, 'row_evidence_dominant', dict(evidence), ambiguous_rows, unknown_rows, row_count

    if fallback_single_country and len(project_countries) == 1:
        country = next(iter(project_countries))
        return country, 'project_single_country_fallback', dict(evidence), ambiguous_rows, unknown_rows, row_count

    if fallback_default_country:
        return fallback_default_country, 'default_country_fallback', dict(evidence), ambiguous_rows, unknown_rows, row_count

    return None, 'no_reliable_inference', dict(evidence), ambiguous_rows, unknown_rows, row_count


def _analysis_period_label(source: AnalysisSourceFile) -> str:
    if source.report_type == 'inventory_report':
        return source.snapshot_at.isoformat() if source.snapshot_at else 'snapshot:unknown'
    if source.period_start_date and source.period_end_date:
        return f'{source.period_start_date.isoformat()}..{source.period_end_date.isoformat()}'
    return 'period:unknown'


def _daily_period_label(source: DailySourceFile) -> str:
    return source.report_date.isoformat()


def _has_analysis_conflict(db: Session, source: AnalysisSourceFile, inferred_country: str) -> bool:
    other = db.execute(
        select(AnalysisSourceFile.id).where(
            AnalysisSourceFile.project_id == source.project_id,
            AnalysisSourceFile.report_type == source.report_type,
            AnalysisSourceFile.country == inferred_country,
            AnalysisSourceFile.period_start_date == source.period_start_date,
            AnalysisSourceFile.period_end_date == source.period_end_date,
            AnalysisSourceFile.version == source.version,
            AnalysisSourceFile.id != source.id,
        )
    ).first()
    return other is not None


def _has_daily_conflict(db: Session, source: DailySourceFile, inferred_country: str) -> bool:
    other = db.execute(
        select(DailySourceFile.id).where(
            DailySourceFile.project_id == source.project_id,
            DailySourceFile.report_type == source.report_type,
            DailySourceFile.country == inferred_country,
            DailySourceFile.report_date == source.report_date,
            DailySourceFile.version == source.version,
            DailySourceFile.id != source.id,
        )
    ).first()
    return other is not None


def _build_decisions(
    db: Session,
    *,
    fallback_single_country: bool,
    fallback_default_country: str | None,
    project_name: str | None,
    report_type: str | None,
    date_from: date | None,
    date_to: date | None,
    limit: int | None,
) -> list[tuple[object, SourceDecision]]:
    project_mappings = _load_project_mappings(db)
    decisions: list[tuple[object, SourceDecision]] = []

    for source in _iter_analysis_sources(
        db,
        project_name=project_name,
        report_type=report_type,
        date_from=date_from,
        date_to=date_to,
        limit=limit,
    ):
        mapping = project_mappings.get(int(source.project_id), {})
        inferred_country, reason, evidence_counts, ambiguous_rows, unknown_rows, row_count = _infer_country(
            _analysis_rows(db, source),
            sku_map=mapping.get('sku_map', {}),
            asin_map=mapping.get('asin_map', {}),
            project_countries=mapping.get('project_countries', set()),
            fallback_single_country=fallback_single_country,
            fallback_default_country=fallback_default_country,
        )
        conflict = bool(inferred_country) and _has_analysis_conflict(db, source, inferred_country)
        decisions.append(
            (
                source,
                SourceDecision(
                    source_kind='analysis',
                    source_id=int(source.id),
                    project_name=str(mapping.get('project_name') or source.project_id),
                    report_type=source.report_type,
                    period_label=_analysis_period_label(source),
                    current_country=source.country,
                    inferred_country=inferred_country,
                    reason=reason,
                    evidence_counts=evidence_counts,
                    ambiguous_rows=ambiguous_rows,
                    unknown_rows=unknown_rows,
                    row_count=row_count,
                    conflict=conflict,
                ),
            )
        )

    for source in _iter_daily_sources(
        db,
        project_name=project_name,
        report_type=report_type,
        date_from=date_from,
        date_to=date_to,
        limit=limit,
    ):
        mapping = project_mappings.get(int(source.project_id), {})
        inferred_country, reason, evidence_counts, ambiguous_rows, unknown_rows, row_count = _infer_country(
            _daily_rows(db, source),
            sku_map=mapping.get('sku_map', {}),
            asin_map=mapping.get('asin_map', {}),
            project_countries=mapping.get('project_countries', set()),
            fallback_single_country=fallback_single_country,
            fallback_default_country=fallback_default_country,
        )
        conflict = bool(inferred_country) and _has_daily_conflict(db, source, inferred_country)
        decisions.append(
            (
                source,
                SourceDecision(
                    source_kind='daily',
                    source_id=int(source.id),
                    project_name=str(mapping.get('project_name') or source.project_id),
                    report_type=source.report_type,
                    period_label=_daily_period_label(source),
                    current_country=source.country,
                    inferred_country=inferred_country,
                    reason=reason,
                    evidence_counts=evidence_counts,
                    ambiguous_rows=ambiguous_rows,
                    unknown_rows=unknown_rows,
                    row_count=row_count,
                    conflict=conflict,
                ),
            )
        )

    return decisions


def _print_decision(decision: SourceDecision) -> None:
    evidence = ', '.join(f'{country}:{count}' for country, count in sorted(decision.evidence_counts.items())) or '-'
    print(
        f'[{decision.source_kind}] id={decision.source_id} project={decision.project_name} '
        f'type={decision.report_type} period={decision.period_label} '
        f'country {decision.current_country} -> {decision.inferred_country or "SKIP"} '
        f'reason={decision.reason} rows={decision.row_count} unknown={decision.unknown_rows} '
        f'ambiguous={decision.ambiguous_rows} evidence={evidence}'
        + (' conflict=yes' if decision.conflict else '')
    )


def main() -> int:
    args = parse_args()
    fallback_default_country = _normalize_country(args.fallback_default_country)
    if args.fallback_default_country and fallback_default_country is None:
        raise SystemExit('fallback default country must be one of: US, DE, UK')

    _ensure_tables_exist()

    with SessionLocal() as db:
        decisions = _build_decisions(
            db,
            fallback_single_country=args.fallback_single_country,
            fallback_default_country=fallback_default_country,
            project_name=args.project,
            report_type=args.report_type,
            date_from=args.date_from,
            date_to=args.date_to,
            limit=args.limit,
        )

        stats = Stats()
        for source, decision in decisions:
            stats.scanned += 1
            if decision.inferred_country is None:
                stats.skipped_no_inference += 1
                _print_decision(decision)
                continue
            if decision.conflict:
                stats.skipped_conflict += 1
                _print_decision(decision)
                continue
            if decision.current_country == decision.inferred_country:
                stats.unchanged += 1
                continue
            _print_decision(decision)
            if args.apply:
                source.country = decision.inferred_country
                stats.updated += 1
            else:
                stats.updated += 1

        if args.apply:
            db.commit()
        else:
            db.rollback()

    mode = 'apply' if args.apply else 'dry-run'
    print(
        f'summary mode={mode} scanned={stats.scanned} would_update={stats.updated} '
        f'unchanged={stats.unchanged} skipped_no_inference={stats.skipped_no_inference} '
        f'skipped_conflict={stats.skipped_conflict}'
    )
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
