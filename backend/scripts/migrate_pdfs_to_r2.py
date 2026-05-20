#!/usr/bin/env python3
"""
Migrate existing local PDF files to R2 cloud storage.

Usage:
    python migrate_pdfs_to_r2.py [--dry-run] [--delete-local]

Options:
    --dry-run     : Show what would be migrated without actually uploading
    --delete-local: Delete local files after successful R2 upload (requires --verify-first)

Environment:
    Uses DATABASE_URL and R2_* settings from .env file
"""

import sys
import os
from pathlib import Path
import argparse

# Resolve script directory for relative paths
SCRIPT_DIR = Path(__file__).resolve().parent
BACKEND_DIR = SCRIPT_DIR.parent
STORAGE_ROOT = BACKEND_DIR / "storage" / "uploads"

# Add backend to path for imports
sys.path.insert(0, str(BACKEND_DIR))

from app.core.config import get_settings
from app.services.r2_service import get_r2_client, upload_bytes_to_r2, check_file_exists
from app.models import MonthlyReport
from app.db.session import SessionLocal


def find_local_pdfs():
    """Find all PDF files in local storage."""
    if not STORAGE_ROOT.exists():
        print(f"Storage directory not found: {STORAGE_ROOT}")
        return []

    pdfs = list(STORAGE_ROOT.rglob("*.pdf"))
    return sorted(pdfs)


def migrate_pdf(settings, pdf_path, dry_run=False, db=None):
    """
    Migrate a single PDF file to R2.

    Returns:
        dict with keys: success, r2_key, r2_url, error, skip_reason
    """
    try:
        # Get relative path components
        rel_path = pdf_path.relative_to(STORAGE_ROOT)
        parts = rel_path.parts

        project_slug = parts[0] if len(parts) > 0 else "unknown"
        type_folder = parts[1] if len(parts) > 1 else "pdfs"
        filename = parts[-1]

        # Check if already exists in R2
        potential_key = f"{project_slug}/{type_folder}/{filename}"
        if check_file_exists(settings, potential_key):
            return {
                "success": True,
                "r2_key": potential_key,
                "r2_url": f"{settings.r2_endpoint_url}/{settings.r2_bucket_name}/{potential_key}",
                "error": None,
                "skip_reason": "already_in_r2"
            }

        if dry_run:
            return {
                "success": True,
                "r2_key": potential_key,
                "r2_url": None,
                "error": None,
                "skip_reason": "dry_run"
            }

        # Read file content
        with open(pdf_path, 'rb') as f:
            content = f.read()

        # Upload to R2
        result = upload_bytes_to_r2(
            settings,
            content,
            filename,
            project_slug,
            type_folder,
            'application/pdf',
        )

        return {
            "success": True,
            "r2_key": result['key'],
            "r2_url": result['url'],
            "error": None,
            "skip_reason": None
        }

    except Exception as e:
        return {
            "success": False,
            "r2_key": None,
            "r2_url": None,
            "error": str(e),
            "skip_reason": None
        }


def update_database(db, pdf_path, result):
    """Update database records with R2 information."""
    rel_path = pdf_path.relative_to(STORAGE_ROOT)
    filename = rel_path.name  # Get just the filename

    # Find reports that reference this PDF
    # Match by file_id containing part of the filename (UUID or full name)
    filename_without_ext = Path(filename).stem  # Remove extension

    # Try to find by path pattern
    reports = db.query(MonthlyReport).filter(
        (MonthlyReport.summary_pdf_file_path.like(f"%{filename}")) |
        (MonthlyReport.summary_pdf_file_path.like(f"%{rel_path}"))
    ).all()

    # Fallback: search by project name from folder
    project_name = rel_path.parts[0] if rel_path.parts else "unknown"

    if not reports:
        reports = db.query(MonthlyReport).filter(
            MonthlyReport.project_name.like(f"%{project_name}%"),
            MonthlyReport.summary_pdf_file_path.isnot(None)
        ).all()

    updated_count = 0
    for report in reports:
        # Only update if not already migrated
        if not report.summary_pdf_r2_key:
            report.summary_pdf_r2_key = result['r2_key']
            report.summary_pdf_r2_url = result['r2_url']
            # Keep file_id updated for compatibility
            report.summary_pdf_file_id = result['r2_key']
            report.summary_pdf_file_path = result['r2_url']
            updated_count += 1

    if updated_count > 0:
        db.commit()

    return updated_count


def safe_delete_local_file(pdf_path, verify_r2_exists=True, settings=None):
    """
    Safely delete a local file after verifying it's in R2.

    Args:
        pdf_path: Path to local file
        verify_r2_exists: Check R2 first before deleting
        settings: App settings for R2 client

    Returns:
        dict with success status and message
    """
    if not pdf_path.exists():
        return {"success": False, "message": "File does not exist"}

    # Verify file is in R2 by checking R2 key matches
    rel_path = pdf_path.relative_to(STORAGE_ROOT)
    potential_key = str(rel_path).replace('\\', '/')  # Normalize path separator

    if verify_r2_exists and settings:
        r2_key = f"{rel_path.parts[0]}/{rel_path.parts[1] if len(rel_path.parts) > 1 else 'pdfs'}/{rel_path.name}"
        if not check_file_exists(settings, r2_key):
            return {"success": False, "message": f"R2 key not found: {r2_key}"}

    # Delete local file
    try:
        pdf_path.unlink()
        return {"success": True, "message": f"Deleted: {pdf_path}"}
    except Exception as e:
        return {"success": False, "message": f"Delete failed: {e}"}


def main():
    parser = argparse.ArgumentParser(description='Migrate local PDFs to R2 cloud storage')
    parser.add_argument('--dry-run', action='store_true', help='Show what would be migrated')
    parser.add_argument('--delete-local', action='store_true', help='Delete local files after successful upload')
    parser.add_argument('--storage-path', default=None, help='Override storage path (default: ./storage/uploads)')

    args = parser.parse_args()

    # Allow custom storage path
    global STORAGE_ROOT
    if args.storage_path:
        STORAGE_ROOT = Path(args.storage_path)

    # Load settings
    settings = get_settings()

    if not settings.r2_enabled:
        print("ERROR: R2 is not configured. Please check .env settings:")
        print("  - R2_ENDPOINT_URL")
        print("  - R2_ACCESS_KEY_ID")
        print("  - R2_SECRET_ACCESS_KEY")
        print("  - R2_BUCKET_NAME")
        return 1

    # Initialize R2 client
    client = get_r2_client(settings)
    print(f"Connected to R2 bucket: {settings.r2_bucket_name}")
    print(f"Storage path: {STORAGE_ROOT}")
    print()

    # Find PDFs
    pdfs = find_local_pdfs()

    if not pdfs:
        print("No PDF files found in local storage")
        return 0

    print(f"Found {len(pdfs)} PDF files to migrate:\n")

    db = SessionLocal()

    results = {
        "migrated": 0,
        "skipped_r2": 0,
        "skipped_dry_run": 0,
        "errors": 0,
        "deleted": 0,
    }

    for pdf_path in pdfs:
        print(f"Processing: {pdf_path.relative_to(STORAGE_ROOT)}")

        # Migrate to R2
        result = migrate_pdf(settings, pdf_path, dry_run=args.dry_run)

        if result["skip_reason"] == "already_in_r2":
            print(f"  ✓ Already in R2: {result['r2_key']}")
            results["skipped_r2"] += 1

        elif result["skip_reason"] == "dry_run":
            print(f"  → Would upload: {result['r2_key']}")
            results["skipped_dry_run"] += 1

        elif result["success"]:
            print(f"  ✓ Uploaded: {result['r2_key']}")

            # Update database
            if not args.dry_run:
                updated = update_database(db, pdf_path, result)
                print(f"    → Updated {updated} DB records")

            # Safe delete local file
            if args.delete_local and not args.dry_run:
                delete_result = safe_delete_local_file(pdf_path, verify_r2_exists=True, settings=settings)
                if delete_result["success"]:
                    print(f"    → Deleted local: {pdf_path.name}")
                    results["deleted"] += 1
                else:
                    print(f"    ⚠ Delete skipped: {delete_result['message']}")

            results["migrated"] += 1

        else:
            print(f"  ✗ Error: {result['error']}")
            results["errors"] += 1

        print()

    db.close()

    # Summary
    print("=" * 60)
    print("MIGRATION SUMMARY")
    print("=" * 60)
    print(f"  Storage path: {STORAGE_ROOT}")
    print(f"  R2 bucket: {settings.r2_bucket_name}")
    print()
    print(f"  Migrated: {results['migrated']} files")
    print(f"  Already in R2: {results['skipped_r2']} files")
    print(f"  Would migrate (dry-run): {results['skipped_dry_run']} files")
    print(f"  Errors: {results['errors']}")
    if args.delete_local:
        print(f"  Deleted locally: {results['deleted']} files")
    print()

    if args.dry_run:
        print("⚠ DRY RUN MODE - No changes made")
        print("  Run without --dry-run to actually migrate")

    if results['errors'] > 0:
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())