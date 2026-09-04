"""
修复两个数据问题：
1. ad_upload_files 中 ingestion_status='saved' 的行 → 更新为 'success'
2. 补写缺失的 report_upload_logs（ad 上传路径的 OK 文件在旧代码下没有写入 upload log）

用法：
    python scripts/fix_ad_upload_status_and_logs.py [--dry-run]

--dry-run 模式只打印将要执行的变更，不实际写入数据库。

数据库连接优先级：
    1. --local 时使用 backend/.env 里的 DATABASE_URL（应为本地库）
    2. 默认/--prod 时使用 backend/.env 里的 PROD_DATABASE_URL（生产库）
    3. 缺省退出。请勿在源码中硬编码 IP——见 [BEL-75]。
"""

import argparse
import os
import sys
from datetime import date, datetime

from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

DATABASE_URL = os.environ.get("DATABASE_URL", "")

if "--local" in sys.argv:
    DATABASE_URL = os.environ.get("DATABASE_URL", "")
    if not DATABASE_URL:
        print("错误: 本地模式需要 DATABASE_URL 环境变量（或 backend/.env 里有）")
        sys.exit(1)
    print(f"使用本地数据库: {DATABASE_URL.split('@')[-1] if '@' in DATABASE_URL else DATABASE_URL}")
else:
    DATABASE_URL = os.environ.get("PROD_DATABASE_URL", "")
    if not DATABASE_URL:
        print("错误: 生产模式需要 PROD_DATABASE_URL 环境变量（或 backend/.env 里有）。")
        print("  本项目不在源码中硬编码生产端 IP——见 [BEL-75]。")
        sys.exit(1)
    print(f"使用生产数据库: {DATABASE_URL.split('@')[-1] if '@' in DATABASE_URL else DATABASE_URL}")

if not DATABASE_URL:
    print("错误: 未找到 DATABASE_URL")
    sys.exit(1)

engine = create_engine(DATABASE_URL, connect_args={"connect_timeout": 10})


def fix_ingestion_status(conn, dry_run: bool) -> int:
    """将 ad_upload_files 中 ingestion_status='saved' 的行更新为 'success'。"""
    result = conn.execute(
        text("SELECT count(*) FROM ad_upload_files WHERE ingestion_status = 'saved'")
    )
    count = result.scalar_one()
    print(f"\n[修复1] ingestion_status='saved' → 'success': {count} 行")

    if count == 0:
        print("  无需修复")
        return 0

    if dry_run:
        print(f"  [DRY-RUN] 将更新 {count} 行")
        return count

    conn.execute(
        text("UPDATE ad_upload_files SET ingestion_status = 'success' WHERE ingestion_status = 'saved'")
    )
    conn.commit()
    print(f"  已更新 {count} 行")
    return count


def backfill_report_upload_logs(conn, dry_run: bool) -> int:
    """补写缺失的 report_upload_logs。

    对于每个 ad_upload_files 行（is_current=True, ingestion_status='success'），
    如果它对应的 (project_id, report_type, country, upload_date) 在 report_upload_logs 中不存在，
    则创建一条 upload log，upload_date 取 ad_upload_files 各 scope 中最早 created_at 的日期。
    """
    # 找出所有需要补写的 (project_id, report_type, country, upload_date) 组合
    # upload_date = created_at 的日期部分（即 AutoReportUpload 处理该文件的那天）
    result = conn.execute(text("""
        WITH ad_scopes AS (
            SELECT DISTINCT
                af.project_id,
                af.report_type,
                af.country,
                DATE(af.created_at) AS upload_date,
                BOOL_OR(af.row_count_preview > 0) AS has_real_data,
                MAX(af.row_count_preview) AS max_row_count,
                MAX(af.original_filename) AS original_filename
            FROM ad_upload_files af
            WHERE af.is_current = True
              AND af.ingestion_status = 'success'
            GROUP BY af.project_id, af.report_type, af.country, DATE(af.created_at)
        )
        SELECT
            s.project_id,
            s.report_type,
            s.country,
            s.upload_date,
            s.has_real_data,
            s.max_row_count,
            s.original_filename
        FROM ad_scopes s
        WHERE NOT EXISTS (
            SELECT 1 FROM report_upload_logs rul
            WHERE rul.project_id = s.project_id
              AND rul.report_type = s.report_type
              AND rul.country = s.country
              AND rul.upload_date = s.upload_date
        )
        ORDER BY s.upload_date, s.project_id, s.report_type
    """))

    rows = result.fetchall()
    print(f"\n[修复2] 补写缺失的 report_upload_logs: {len(rows)} 条")

    if len(rows) == 0:
        print("  无需补写")
        return 0

    inserted = 0
    for row in rows:
        project_id, report_type, country, upload_date, has_real_data, max_row_count, original_filename = row
        print(f"  + project_id={project_id}, report_type={report_type}, "
              f"country={country}, upload_date={upload_date}, "
              f"has_real_data={has_real_data}, row_count={max_row_count}, "
              f"filename={original_filename}")

        if not dry_run:
            conn.execute(text("""
                INSERT INTO report_upload_logs
                    (project_id, report_type, country, upload_date, has_real_data, row_count, source_file_id, original_filename, created_at)
                VALUES
                    (:project_id, :report_type, :country, :upload_date, :has_real_data, :row_count, NULL, :original_filename, NOW())
            """), {
                "project_id": project_id,
                "report_type": report_type,
                "country": country,
                "upload_date": upload_date,
                "has_real_data": has_real_data,
                "row_count": max_row_count or 0,
                "original_filename": original_filename,
            })
            inserted += 1

    if not dry_run:
        conn.commit()
        print(f"  已插入 {inserted} 条 report_upload_logs")
    else:
        print(f"  [DRY-RUN] 将插入 {len(rows)} 条 report_upload_logs")

    return len(rows)


def verify_fix(conn) -> None:
    """验证修复结果。"""
    # 验证1: saved 行数应为0
    result = conn.execute(
        text("SELECT count(*) FROM ad_upload_files WHERE ingestion_status = 'saved'")
    )
    saved_count = result.scalar_one()
    print(f"\n[验证] ad_upload_files 中 ingestion_status='saved' 的行数: {saved_count}")

    # 验证2: 今天的 upload logs
    today = date.today().isoformat()
    result2 = conn.execute(text("""
        SELECT count(*) FROM report_upload_logs
        WHERE report_type LIKE 'ad_%' AND upload_date = :today
    """), {"today": today})
    today_count = result2.scalar_one()
    print(f"[验证] 今天 ({today}) 的 ad report upload_logs 数量: {today_count}")

    # 验证3: 各日期的 ad upload log 统计
    result3 = conn.execute(text("""
        SELECT upload_date, count(*)
        FROM report_upload_logs
        WHERE report_type LIKE 'ad_%'
        GROUP BY upload_date
        ORDER BY upload_date DESC
        LIMIT 7
    """))
    print("[验证] 近 7 天 ad report upload_logs 统计:")
    for row in result3.fetchall():
        print(f"  {row[0]}: {row[1]} 条")


def main():
    parser = argparse.ArgumentParser(description="修复 ad_upload_files ingestion_status 和补写 report_upload_logs")
    parser.add_argument("--dry-run", action="store_true", help="只打印变更，不实际写入数据库")
    args = parser.parse_args()

    if args.dry_run:
        print("=== DRY-RUN 模式 ===")

    with engine.connect() as conn:
        print("=" * 70)
        print("修复前状态:")
        print("=" * 70)
        verify_fix(conn)

        print("\n" + "=" * 70)
        print("执行修复:")
        print("=" * 70)
        fix_ingestion_status(conn, dry_run=args.dry_run)
        backfill_report_upload_logs(conn, dry_run=args.dry_run)

        if not args.dry_run:
            print("\n" + "=" * 70)
            print("修复后验证:")
            print("=" * 70)
            verify_fix(conn)
        else:
            print("\n=== DRY-RUN 完成，未实际写入数据库 ===")


if __name__ == "__main__":
    main()