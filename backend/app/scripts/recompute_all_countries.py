"""
批量重计算所有站点所有月份的佣金记录。

用于在修改汇率转换逻辑后重新计算历史数据。

Usage:
    python -m app.scripts.recompute_all_countries --start=2025-01 --end=2026-12
    python -m app.scripts.recompute_all_countries --months=2026-01 --dry-run
"""
import argparse
import sys
from datetime import datetime
from decimal import Decimal

from sqlalchemy import func, select, text

from app.db.session import SessionLocal
from app.services.system_management.commission.recompute import recompute_commission_records
from app.models.commission_project_month import CommissionProjectMonth


def batch_recompute_all(
    db,
    start_year_month: str | None = None,
    end_year_month: str | None = None,
    specific_months: list[str] | None = None,
    dry_run: bool = False,
):
    """批量重计算所有站点所有月份

    Args:
        db: 数据库会话
        start_year_month: 起始月份（包含），格式 YYYY-MM
        end_year_month: 结束月份（包含），格式 YYYY-MM
        specific_months: 指定月份列表（优先于范围过滤）
        dry_run: 如果为 True，只打印将要执行的操作，不实际执行
    """
    now = datetime.now()

    # 获取所有有数据的月份
    months_stmt = select(func.distinct(CommissionProjectMonth.report_month))
    all_months = db.execute(months_stmt).scalars().all()

    # 确定要处理的月份
    if specific_months:
        filtered_months = [m for m in all_months if m in specific_months]
    elif start_year_month and end_year_month:
        filtered_months = [m for m in all_months if start_year_month <= m <= end_year_month]
    elif start_year_month:
        filtered_months = [m for m in all_months if m >= start_year_month]
    elif end_year_month:
        filtered_months = [m for m in all_months if m <= end_year_month]
    else:
        filtered_months = sorted(all_months)

    if not filtered_months:
        print("No months to process")
        return []

    print(f"Found {len(filtered_months)} months to process: {filtered_months[:5]}..." if len(filtered_months) > 5 else f"Found {len(filtered_months)} months to process: {filtered_months}")

    results = []
    countries = ("US", "UK", "DE")

    for month in filtered_months:
        for country in countries:
            if dry_run:
                print(f"[DRY-RUN] Would recompute {month} / {country}")
                results.append({"month": month, "country": country, "status": "dry_run"})
                continue

            try:
                print(f"Recomputing {month} / {country}...", end=" ")
                sys.stdout.flush()
                counts = recompute_commission_records(db, month, now, country)
                print(f"OK (projects={counts[0]}, records={counts[1]}, locked={counts[2]})")
                results.append({"month": month, "country": country, "status": "success", **counts})
            except ValueError as e:
                print(f"ERROR: {e}")
                results.append({"month": month, "country": country, "status": "error", "message": str(e)})
            except Exception as e:
                print(f"ERROR: {type(e).__name__}: {e}")
                results.append({"month": month, "country": country, "status": "error", "message": f"{type(e).__name__}: {e}"})

    return results


def main():
    parser = argparse.ArgumentParser(description="批量重计算佣金记录")
    parser.add_argument("--start", help="起始月份，格式 YYYY-MM")
    parser.add_argument("--end", help="结束月份，格式 YYYY-MM")
    parser.add_argument("--months", nargs="+", help="指定月份列表（可多次使用）")
    parser.add_argument("--dry-run", action="store_true", help="只打印操作，不实际执行")
    args = parser.parse_args()

    # 参数验证
    if args.months:
        specific_months = args.months
    else:
        specific_months = None

    db = SessionLocal()
    try:
        if args.dry_run:
            print("=== DRY RUN MODE ===")
        print(f"Start: {args.start or 'earliest'}, End: {args.end or 'latest'}")
        print(f"Specific months: {specific_months}")
        print()

        results = batch_recompute_all(
            db,
            start_year_month=args.start,
            end_year_month=args.end,
            specific_months=specific_months,
            dry_run=args.dry_run,
        )

        # 统计结果
        success_count = sum(1 for r in results if r["status"] == "success")
        error_count = sum(1 for r in results if r["status"] == "error")
        print()
        print(f"=== Summary ===")
        print(f"Total operations: {len(results)}")
        print(f"Success: {success_count}")
        print(f"Errors: {error_count}")

        if error_count > 0:
            print("\nErrors:")
            for r in results:
                if r["status"] == "error":
                    print(f"  {r['month']} / {r['country']}: {r.get('message', 'Unknown error')}")

        if error_count > 0 and not args.dry_run:
            sys.exit(1)

    finally:
        db.close()


if __name__ == "__main__":
    main()