#!/usr/bin/env python3
"""
Reprocess existing German (DE) payment reports with locale-aware parsing.

Usage:
    python scripts/reprocess_de_payment_reports.py [--dry-run] [--project PROJECT_NAME]

This script:
1. Finds all DE payment reports in the database
2. Re-parses them using the locale-aware reader (shared.payment_locale)
3. Updates the AnalysisPaymentRow records with correctly parsed numeric values

Run with --dry-run to see what would be processed without making changes.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from sqlalchemy import select, delete
from sqlalchemy.orm import Session

import app.models  # noqa: F401  # ensure model metadata is registered
from app.db.session import SessionLocal
from app.models import AnalysisSourceFile, AnalysisPaymentRow
from app.services.payment.locale import read_payment_report_dataframe
from app.utils.parsers import parse_payment_rows


def get_projects_skus_asins(session: Session, project_id: int, country: str = 'DE') -> tuple[set[str], set[str]]:
    """Get known SKUs and ASINs for a project from SkuRecord table."""
    from app.models import SkuRecord, Project
    from sqlalchemy import func

    skus = set()
    asins = set()

    # Get project name
    project = session.execute(
        select(Project.project_name).where(Project.id == project_id)
    ).scalar_one_or_none()

    if not project:
        return skus, asins

    # Get SKUs from SkuRecord for this project and country
    result = session.execute(
        select(SkuRecord.sku, SkuRecord.asin)
        .where(
            SkuRecord.project_name == project,
            SkuRecord.country == country
        )
    )

    for row in result:
        if row[0]:
            skus.add(str(row[0]).strip().upper())
        if row[1]:
            asins.add(str(row[1]).strip().upper())

    return skus, asins


def reprocess_source_file(
    session: Session,
    source: AnalysisSourceFile,
    dry_run: bool = False,
    verbose: bool = False,
) -> dict:
    """Reprocess a single payment report source file."""
    path = Path(source.upload_file_path)

    if not path.exists():
        # Try with absolute path relative to script's root
        alt_path = ROOT / path
        if alt_path.exists():
            path = alt_path
        else:
            return {
                "source_id": source.id,
                "filename": source.original_filename or source.stored_filename,
                "status": "SKIP",
                "reason": f"File not found: {path} (tried: {alt_path})",
            }

    # Get project SKUs and ASINs for scope classification
    skus, asins = get_projects_skus_asins(session, source.project_id, source.country)

    if verbose:
        print(f"  Processing: {source.original_filename or source.stored_filename}")
        print(f"  File path: {path}")
        print(f"  Known SKUs: {len(skus)}, Known ASINs: {len(asins)}")

    try:
        # Use locale-aware reader
        df = read_payment_report_dataframe(path, country=source.country)
        rows, total, included = parse_payment_rows(df, source.id, skus, asins)

        if verbose:
            print(f"  Parsed: {total} rows, {included} included")

        if dry_run:
            return {
                "source_id": source.id,
                "filename": source.original_filename or source.stored_filename,
                "status": "DRY-RUN",
                "rows_total": total,
                "rows_included": included,
            }

        # Delete existing payment rows
        session.execute(
            delete(AnalysisPaymentRow).where(AnalysisPaymentRow.source_file_id == source.id)
        )

        # Insert new rows
        if rows:
            session.execute(AnalysisPaymentRow.__table__.insert(), rows)

        # Update source file stats
        source.row_count_total = total
        source.row_count_included = included
        source.ingestion_status = "success"
        source.ingestion_error = None

        session.commit()

        return {
            "source_id": source.id,
            "filename": source.original_filename or source.stored_filename,
            "status": "SUCCESS",
            "rows_total": total,
            "rows_included": included,
        }

    except Exception as exc:
        session.rollback()
        return {
            "source_id": source.id,
            "filename": source.original_filename or source.stored_filename,
            "status": "ERROR",
            "reason": str(exc),
        }


def main():
    parser = argparse.ArgumentParser(
        description="Reprocess existing DE payment reports with locale-aware parsing"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be processed without making changes",
    )
    parser.add_argument(
        "--project",
        type=str,
        default=None,
        help="Filter by project name (partial match)",
    )
    parser.add_argument(
        "--country",
        type=str,
        default="DE",
        choices=["DE", "US", "UK"],
        help="Country code to reprocess (default: DE)",
    )
    parser.add_argument(
        "--source-id",
        type=int,
        default=None,
        help="Specific source file ID to reprocess",
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Show detailed output",
    )
    args = parser.parse_args()

    session = SessionLocal()

    try:
        # Build query
        query = select(AnalysisSourceFile).where(
            AnalysisSourceFile.report_type == "payment_report",
            AnalysisSourceFile.country == args.country,
            AnalysisSourceFile.ingestion_status == "success",
        )

        if args.project:
            from app.models import Project
            project_result = session.execute(
                select(Project.id).where(Project.project_name.ilike(f"%{args.project}%"))
            )
            project_ids = [row[0] for row in project_result]
            if not project_ids:
                print(f"No projects found matching: {args.project}")
                return 1
            query = query.where(AnalysisSourceFile.project_id.in_(project_ids))

        if args.source_id:
            query = query.where(AnalysisSourceFile.id == args.source_id)

        results = session.execute(query).scalars().all()

        if not results:
            print(f"No payment reports found for country={args.country}")
            if args.project:
                print(f"  (filtered by project: {args.project})")
            return 0

        print(f"Found {len(results)} payment report(s) to reprocess")
        print(f"Country: {args.country}")
        if args.project:
            print(f"Project filter: {args.project}")
        if args.dry_run:
            print("DRY RUN - no changes will be made\n")

        success_count = 0
        error_count = 0
        skip_count = 0

        for source in results:
            result = reprocess_source_file(session, source, dry_run=args.dry_run, verbose=args.verbose)

            status_symbol = {
                "SUCCESS": "✓",
                "DRY-RUN": "○",
                "SKIP": "⚠",
                "ERROR": "✗",
            }.get(result["status"], "?")

            if result["status"] == "SUCCESS":
                success_count += 1
                print(f"{status_symbol} {result['filename']}: {result['rows_included']} rows included")
            elif result["status"] == "DRY-RUN":
                skip_count += 1
                print(f"{status_symbol} {result['filename']}: would process {result['rows_included']} rows")
            elif result["status"] == "SKIP":
                skip_count += 1
                print(f"{status_symbol} {result['filename']}: SKIPPED - {result['reason']}")
            else:
                error_count += 1
                print(f"{status_symbol} {result['filename']}: ERROR - {result['reason']}")

        print(f"\nSummary: {success_count} processed, {skip_count} skipped, {error_count} errors")

        if args.dry_run:
            print("\nRun without --dry-run to apply changes.")

        return 0 if error_count == 0 else 1

    finally:
        session.close()


if __name__ == "__main__":
    sys.exit(main())