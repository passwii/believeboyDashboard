#!/usr/bin/env python3
"""
Delete single-day PT1 records for specific projects (铨富 and 玥涵).

These single-day periods (2026-05-01 and 2026-05-02) are anomalous and should be
removed because they break the weekly reporting structure.

Usage:
    python scripts/delete_single_day_pt1_records.py [--dry-run]
"""

import argparse
import sys
from datetime import date

sys.path.insert(0, ".")

from app.db.session import SessionLocal
from app.models import AnalysisPT1Calculation, AnalysisPTSKUDetail, Project
from sqlalchemy import select, and_


def main():
    parser = argparse.ArgumentParser(description="Delete single-day PT1 records")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be deleted without actually deleting",
    )
    args = parser.parse_args()

    db = SessionLocal()

    try:
        # Find the target projects
        projects = db.execute(
            select(Project).where(
                Project.project_name.like("%铨富%") | Project.project_name.like("%玥涵%")
            )
        ).scalars().all()

        if not projects:
            print("No projects found matching 铨富 or 玥涵")
            return

        project_ids = [p.id for p in projects]
        print(f"Found projects: {[(p.id, p.project_name) for p in projects]}")
        print(f"Project IDs: {project_ids}")
        print()

        # Find single-day PT1 records (where start_date == end_date)
        single_day_records = db.execute(
            select(AnalysisPT1Calculation).where(
                and_(
                    AnalysisPT1Calculation.project_id.in_(project_ids),
                    AnalysisPT1Calculation.report_start_date
                    == AnalysisPT1Calculation.report_end_date,
                    AnalysisPT1Calculation.is_current.is_(True),
                )
            )
        ).scalars().all()

        if not single_day_records:
            print("No single-day PT1 records found")
            return

        print(f"Found {len(single_day_records)} single-day PT1 records:")
        for r in single_day_records:
            print(f"  ID={r.id}, project_id={r.project_id}, start={r.report_start_date}, end={r.report_end_date}, version={r.version}")

        # Also find non-current single-day records that might be orphaned
        orphaned_records = db.execute(
            select(AnalysisPT1Calculation).where(
                and_(
                    AnalysisPT1Calculation.project_id.in_(project_ids),
                    AnalysisPT1Calculation.report_start_date
                    == AnalysisPT1Calculation.report_end_date,
                    AnalysisPT1Calculation.is_current.is_(False),
                )
            )
        ).scalars().all()

        if orphaned_records:
            print(f"\nAlso found {len(orphaned_records)} orphaned non-current single-day records:")
            for r in orphaned_records:
                print(f"  ID={r.id}, project_id={r.project_id}, start={r.report_start_date}, end={r.report_end_date}, version={r.version}")

        all_to_delete = single_day_records + orphaned_records

        # Count associated SKU detail records
        pt1_ids = [r.id for r in all_to_delete]
        detail_counts = {}
        for pt1_id in pt1_ids:
            count = db.execute(
                select(AnalysisPTSKUDetail).where(
                    AnalysisPTSKUDetail.pt1_calculation_id == pt1_id
                )
            ).scalars().all()
            detail_counts[pt1_id] = len(count)

        total_details = sum(detail_counts.values())
        print(f"\nTotal records to delete: {len(all_to_delete)} PT1 records + {total_details} SKU detail records")

        if args.dry_run:
            print("\n[Dry run] Would delete the following:")
            for r in all_to_delete:
                print(f"  DELETE AnalysisPT1Calculation WHERE id={r.id}")
                print(f"    (CASCADE would also delete {detail_counts[r.id]} AnalysisPTSKUDetail records)")
            print("\n[Dry run] No actual changes made.")
        else:
            # Mark non-current as superseded first, then delete all
            print("\nDeleting records...")

            for r in all_to_delete:
                # Count details before deletion
                details = db.execute(
                    select(AnalysisPTSKUDetail).where(
                        AnalysisPTSKUDetail.pt1_calculation_id == r.id
                    )
                ).scalars().all()

                for detail in details:
                    db.delete(detail)
                db.delete(r)
                print(f"  Deleted PT1 ID={r.id} (and {len(details)} detail records)")

            db.commit()
            print(f"\nSuccessfully deleted {len(all_to_delete)} PT1 records and {total_details} SKU detail records")

    except Exception as e:
        db.rollback()
        print(f"Error: {e}")
        raise
    finally:
        db.close()


if __name__ == "__main__":
    main()
