"""
cleanup_noncurrent_versions.py — 清理冗余的「非 current」版本 / 记录（R2 存储 + 可选 DB 行）

两大类：
  A. MonthlyReport（每月财务核算）
     同一 (project_id, country, report_month) 下，保留 is_current=True 的那一版，
     清理其余历史版本的 R2 文件：
       - 原始 CSV   → resolve_transaction_csv_r2_key() 探测出的 R2 key
       - 汇总 PDF   → summary_pdf_r2_key
  B. ScheduledReportDeliveryLog（定时报告，含每天多次补发）
     同一 (subscription_id, frequency, report_date) 下，保留「当前」一条：
       - 优先 ledger.latest_delivery_log_id 指向的成功行
       - 否则最新 status in (sent, done) 行
       - 否则最新 created_at 行（保留可重试）
     清理其余历史记录的 R2 截图（screenshot_r2_key + screenshot_r2_thumb_key）。

安全模型：
  - 默认 DRY-RUN：只报告将要清理什么（分组数 / 文件数 / 可选字节数），不动任何数据。
  - --delete-r2   真正删除 R2 文件（best-effort），并把对应 DB 列 NULL 掉，消除悬空引用。
  - --delete-rows 额外 DELETE 非 current 的 DB 行：
                   月度会级联删 monthly_report_transactions / pt3 / pt4（真实财务计算数据丢失！）
                   定时会删 delivery_log 行（ledger.latest_delivery_log_id 自动 SET NULL）。
  - --measure     对每个 R2 key 做一次 head_object 累加精确字节数（慢，仅审计用）。

运行（在 VPS 上，prod .env 提供 DATABASE_URL + R2 凭证）：
  cd /root/believeboyDashboard/backend
  .venv/bin/python /tmp/cleanup_noncurrent_versions.py --dry-run
  .venv/bin/python /tmp/cleanup_noncurrent_versions.py --dry-run --measure
  .venv/bin/python /tmp/cleanup_noncurrent_versions.py --scope monthly   --delete-r2
  .venv/bin/python /tmp/cleanup_noncurrent_versions.py --scope scheduled --delete-r2 --delete-rows
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime
from pathlib import Path
from collections import defaultdict

# 把 backend/ 加进 sys.path，让 `from app.xxx import ...` 能跑
# 脚本可能放在 backend/scripts/ 或 /tmp，向上/向 cwd 找含 app/ 的目录
_HERE = Path(__file__).resolve().parent
_CANDIDATES = [_HERE, _HERE.parent, Path.cwd()]
for _c in _CANDIDATES:
    if (_c / "app").is_dir():
        sys.path.insert(0, str(_c))
        break
else:
    sys.path.insert(0, str(_HERE.parent))

from sqlalchemy import create_engine, select, delete, text  # noqa: E402
from sqlalchemy.orm import Session, sessionmaker  # noqa: E402

from app.core.config import get_settings  # noqa: E402
from app.models.monthly_report import MonthlyReport  # noqa: E402
from app.models.scheduled_report import (  # noqa: E402
    ScheduledReportDeliveryLog,
    ScheduledReportLedgerEntry,
    ScheduledReportSubscription,
)


# --------------------------------------------------------------------------- #
# 数据读取
# --------------------------------------------------------------------------- #
def load_monthly_rows(db: Session, project_slug: str | None) -> list[dict]:
    cols = select(
        MonthlyReport.id,
        MonthlyReport.project_id,
        MonthlyReport.project_name,
        MonthlyReport.country,
        MonthlyReport.report_month,
        MonthlyReport.version,
        MonthlyReport.is_current,
        MonthlyReport.transaction_file_id,
        MonthlyReport.transaction_file_path,
        MonthlyReport.summary_pdf_r2_key,
    )
    if project_slug:
        # project_name 可能含中文/空格，按子串匹配（宽松）
        cols = cols.where(MonthlyReport.project_name.ilike(f"%{project_slug}%"))
    rows = db.execute(cols).mappings().all()
    return [dict(r) for r in rows]


def load_scheduled_rows(db: Session) -> tuple[list[dict], dict]:
    logs = db.execute(
        select(
            ScheduledReportDeliveryLog.id,
            ScheduledReportDeliveryLog.subscription_id,
            ScheduledReportDeliveryLog.frequency,
            ScheduledReportDeliveryLog.report_date,
            ScheduledReportDeliveryLog.status,
            ScheduledReportDeliveryLog.triggered_by,
            ScheduledReportDeliveryLog.sent_at,
            ScheduledReportDeliveryLog.created_at,
            ScheduledReportDeliveryLog.screenshot_r2_key,
            ScheduledReportDeliveryLog.screenshot_r2_thumb_key,
        )
    ).mappings().all()
    log_list = [dict(r) for r in logs]

    # ledger: 每个 (sub, freq, date) → latest_delivery_log_id（取第一条指针）
    ledgers = db.execute(
        select(
            ScheduledReportLedgerEntry.subscription_id,
            ScheduledReportLedgerEntry.frequency,
            ScheduledReportLedgerEntry.expected_date,
            ScheduledReportLedgerEntry.latest_delivery_log_id,
        )
    ).mappings().all()
    ledger_pointer: dict[tuple, int | None] = {}
    for le in ledgers:
        key = (le["subscription_id"], le["frequency"], le["expected_date"])
        if le["latest_delivery_log_id"] is not None:
            ledger_pointer[key] = le["latest_delivery_log_id"]
    return log_list, ledger_pointer


# --------------------------------------------------------------------------- #
# keeper 选择
# --------------------------------------------------------------------------- #
def choose_monthly_keeper(rows: list[dict]) -> int:
    current = [r for r in rows if r["is_current"]]
    if current:
        return current[0]["id"]
    # 异常：没有 current → 保留 version 最大的一版
    return max(rows, key=lambda r: r["version"])["id"]


def choose_scheduled_keeper(group_rows: list[dict], ledger_ptr: int | None) -> int:
    by_id = {r["id"]: r for r in group_rows}
    # 1) ledger 指针（仅当它指向成功行）
    if ledger_ptr and ledger_ptr in by_id and by_id[ledger_ptr]["status"] in ("sent", "done"):
        return ledger_ptr
    # 2) 最新成功行
    successful = [r for r in group_rows if r["status"] in ("sent", "done")]
    if successful:
        return max(
            successful,
            key=lambda r: (r["sent_at"] or r["created_at"] or datetime.min),
        )["id"]
    # 3) 最新创建行（保留可重试）
    return max(group_rows, key=lambda r: (r["created_at"] or datetime.min))["id"]


# --------------------------------------------------------------------------- #
# R2 删除 + 列 NULL
# --------------------------------------------------------------------------- #
def delete_r2_key(settings, key: str) -> bool:
    from app.services.r2_service import delete_file_from_r2

    if not key:
        return False
    try:
        delete_file_from_r2(settings, key)
        return True
    except Exception as e:  # best-effort
        print(f"    [r2 fail] {key}: {e}")
        return False


def head_r2_bytes(settings, key: str) -> int:
    import boto3
    from botocore.config import Config

    if not key:
        return 0
    client = boto3.client(
        "s3",
        endpoint_url=settings.r2_endpoint_url,
        aws_access_key_id=settings.r2_access_key_id,
        aws_secret_access_key=settings.r2_secret_access_key,
        region_name=settings.r2_region or "auto",
        config=Config(signature_version="s3v4"),
    )
    try:
        resp = client.head_object(Bucket=settings.r2_bucket_name, Key=key)
        return int(resp.get("ContentLength", 0) or 0)
    except Exception:
        return 0


# --------------------------------------------------------------------------- #
# 月度清理
# --------------------------------------------------------------------------- #
def plan_monthly(db: Session, settings, project_slug: str | None, measure: bool):
    rows = load_monthly_rows(db, project_slug)
    groups: dict[tuple, list[dict]] = defaultdict(list)
    for r in rows:
        groups[(r["project_id"], r["country"], r["report_month"])].append(r)

    plan = []  # list of {group, keeper_id, noncurrent: [row...], keys: [k...]}
    groups_with_dupes = 0
    total_noncurrent = 0
    total_files = 0
    total_bytes = 0

    for gkey, grows in sorted(groups.items(), key=lambda kv: (str(kv[0][0]), kv[0][1], kv[0][2])):
        if len(grows) <= 1:
            continue
        groups_with_dupes += 1
        keeper_id = choose_monthly_keeper(grows)
        noncurrent = [r for r in grows if r["id"] != keeper_id]

        keys_to_reclaim = []
        for r in noncurrent:
            total_noncurrent += 1
            # CSV：用 resolve_transaction_csv_r2_key 探测真实 key
            csv_key = None
            try:
                from app.services.reconciliation_service import resolve_transaction_csv_r2_key
                mr = MonthlyReport(
                    id=r["id"],
                    project_name=r["project_name"],
                    transaction_file_id=r["transaction_file_id"] or "",
                )
                # resolve 需要 report 对象有 project_name + transaction_file_id
                csv_key = resolve_transaction_csv_r2_key(mr, settings)
            except Exception as e:
                print(f"    [csv resolve fail] report {r['id']}: {e}")
            if csv_key:
                keys_to_reclaim.append(("csv", csv_key))
            # PDF
            if r["summary_pdf_r2_key"]:
                keys_to_reclaim.append(("pdf", r["summary_pdf_r2_key"]))

        for _kind, k in keys_to_reclaim:
            total_files += 1
            if measure:
                total_bytes += head_r2_bytes(settings, k)
        plan.append({
            "group": gkey,
            "keeper_id": keeper_id,
            "noncurrent": noncurrent,
            "keys": keys_to_reclaim,
        })

    return {
        "total_rows": len(rows),
        "groups_total": len(groups),
        "groups_with_dupes": groups_with_dupes,
        "total_noncurrent": total_noncurrent,
        "total_files": total_files,
        "total_bytes": total_bytes,
        "plan": plan,
    }


def apply_monthly(db: Session, settings, plan, delete_r2: bool, delete_rows: bool, skip_null: bool = False):
    r2_ok = r2_fail = 0
    nulled = 0
    deleted_rows = 0

    for item in plan["plan"]:
        for r in item["noncurrent"]:
            rid = r["id"]
            # 1) 删 R2 文件 + NULL 列
            if delete_r2:
                csv_key = None
                try:
                    from app.services.reconciliation_service import resolve_transaction_csv_r2_key
                    mr = MonthlyReport(
                        id=rid,
                        project_name=r["project_name"],
                        transaction_file_id=r["transaction_file_id"] or "",
                    )
                    csv_key = resolve_transaction_csv_r2_key(mr, settings)
                except Exception:
                    pass
                if csv_key and delete_r2_key(settings, csv_key):
                    r2_ok += 1
                elif csv_key:
                    r2_fail += 1
                if r["summary_pdf_r2_key"]:
                    if delete_r2_key(settings, r["summary_pdf_r2_key"]):
                        r2_ok += 1
                    else:
                        r2_fail += 1
                # NULL 悬空 R2 列（PDF）—— 仅当未要求 DB 不动
                if not skip_null:
                    db.execute(
                        text(
                            "UPDATE monthly_reports SET summary_pdf_r2_key=NULL, "
                            "summary_pdf_r2_url=NULL WHERE id=:rid"
                        ).bindparams(rid=rid)
                    )
                    nulled += 1
            # 2) 删 DB 行（级联 transactions/pt3/pt4）
            if delete_rows:
                db.execute(delete(MonthlyReport).where(MonthlyReport.id == rid))
                deleted_rows += 1
        db.commit()

    return r2_ok, r2_fail, nulled, deleted_rows


# --------------------------------------------------------------------------- #
# 定时报告清理
# --------------------------------------------------------------------------- #
def plan_scheduled(db: Session, settings, measure: bool):
    rows, ledger_pointer = load_scheduled_rows(db)
    groups: dict[tuple, list[dict]] = defaultdict(list)
    for r in rows:
        groups[(r["subscription_id"], r["frequency"], r["report_date"])].append(r)

    plan = []
    groups_with_dupes = 0
    total_noncurrent = 0
    total_files = 0
    total_bytes = 0

    for gkey, grows in sorted(groups.items(), key=lambda kv: (kv[0][0], kv[0][1], kv[0][2])):
        if len(grows) <= 1:
            continue
        groups_with_dupes += 1
        ptr = ledger_pointer.get(gkey)
        keeper_id = choose_scheduled_keeper(grows, ptr)
        noncurrent = [r for r in grows if r["id"] != keeper_id]

        keys_to_reclaim = []
        for r in noncurrent:
            total_noncurrent += 1
            if r["screenshot_r2_key"]:
                keys_to_reclaim.append(("shot", r["screenshot_r2_key"]))
            if r["screenshot_r2_thumb_key"]:
                keys_to_reclaim.append(("thumb", r["screenshot_r2_thumb_key"]))

        for _kind, k in keys_to_reclaim:
            total_files += 1
            if measure:
                total_bytes += head_r2_bytes(settings, k)
        plan.append({
            "group": gkey,
            "keeper_id": keeper_id,
            "noncurrent": noncurrent,
            "keys": keys_to_reclaim,
        })

    return {
        "total_rows": len(rows),
        "groups_total": len(groups),
        "groups_with_dupes": groups_with_dupes,
        "total_noncurrent": total_noncurrent,
        "total_files": total_files,
        "total_bytes": total_bytes,
        "plan": plan,
    }


def apply_scheduled(db: Session, settings, plan, delete_r2: bool, delete_rows: bool, skip_null: bool = False):
    r2_ok = r2_fail = 0
    nulled = 0
    deleted_rows = 0

    # DB 行删除只针对终态（sent/done/superseded），保留 failed/pending/preparing 可重试
    deletable_status = {"sent", "done", "superseded"}

    for item in plan["plan"]:
        for r in item["noncurrent"]:
            rid = r["id"]
            if delete_r2:
                if r["screenshot_r2_key"] and delete_r2_key(settings, r["screenshot_r2_key"]):
                    r2_ok += 1
                elif r["screenshot_r2_key"]:
                    r2_fail += 1
                if r["screenshot_r2_thumb_key"] and delete_r2_key(settings, r["screenshot_r2_thumb_key"]):
                    r2_ok += 1
                elif r["screenshot_r2_thumb_key"]:
                    r2_fail += 1
                # NULL 悬空 R2 列 —— 仅当未要求 DB 不动
                if not skip_null:
                    db.execute(
                        text(
                            "UPDATE scheduled_report_delivery_logs "
                            "SET screenshot_r2_key=NULL, screenshot_r2_url=NULL, "
                            "screenshot_r2_thumb_key=NULL, screenshot_r2_thumb_url=NULL "
                            "WHERE id=:rid"
                        ).bindparams(rid=rid)
                    )
                    nulled += 1
            if delete_rows and r["status"] in deletable_status:
                db.execute(
                    delete(ScheduledReportDeliveryLog).where(
                        ScheduledReportDeliveryLog.id == rid
                    )
                )
                deleted_rows += 1
        db.commit()

    return r2_ok, r2_fail, nulled, deleted_rows


# --------------------------------------------------------------------------- #
# 报告
# --------------------------------------------------------------------------- #
def fmt_size(n: int) -> str:
    for unit in ["B", "KB", "MB", "GB"]:
        if n < 1024:
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def print_plan(title: str, res: dict, show_samples: int = 10):
    print(f"\n{'='*64}")
    print(f"  {title}")
    print(f"{'='*64}")
    print(f"  DB 总行数            : {res['total_rows']}")
    print(f"  分组总数             : {res['groups_total']}")
    print(f"  有重复(>1)的分组     : {res['groups_with_dupes']}")
    print(f"  非 current 记录数    : {res['total_noncurrent']}")
    print(f"  将回收的 R2 文件数   : {res['total_files']}")
    if res.get("total_bytes"):
        print(f"  将回收的 R2 字节数   : {fmt_size(res['total_bytes'])}")

    if not res["plan"]:
        print("  没有需要清理的内容。")
        return

    print(f"\n  --- 样例分组（前 {min(show_samples, len(res['plan']))} 个）---")
    for item in res["plan"][:show_samples]:
        g = item["group"]
        gstr = "/".join(str(x) for x in g)
        nc = len(item["noncurrent"])
        keys = ", ".join(k for _k, k in item["keys"][:3])
        if len(item["keys"]) > 3:
            keys += f" ...(+{len(item['keys'])-3})"
        print(f"    group={gstr}")
        print(f"      keeper_id={item['keeper_id']}  非current={nc}  keys={keys or '(none)'}")
    if len(res["plan"]) > show_samples:
        print(f"    ... 还有 {len(res['plan']) - show_samples} 个分组")


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #
def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--scope", choices=["monthly", "scheduled", "all"], default="all",
        help="清理范围（默认 all）",
    )
    parser.add_argument("--project", help="只处理该项目（月度用；按 project_name 子串匹配）")
    parser.add_argument("--dry-run", action="store_true", help="只报告，不删（默认行为）")
    parser.add_argument("--delete-r2", action="store_true", help="真正删除 R2 文件并 NULL 对应列")
    parser.add_argument("--skip-null", action="store_true",
                        help="仅删 R2 文件，不对 DB 列做任何 UPDATE（DB 完全不动时使用）")
    parser.add_argument("--delete-rows", action="store_true", help="额外 DELETE 非 current DB 行")
    parser.add_argument("--measure", action="store_true", help="head 每个 key 累加精确字节数（慢）")
    args = parser.parse_args()

    delete_r2 = args.delete_r2
    delete_rows = args.delete_rows
    skip_null = args.skip_null
    is_dry = not (delete_r2 or delete_rows)

    settings = get_settings()
    engine = create_engine(settings.database_url, future=True)
    SessionLocal = sessionmaker(bind=engine, future=True)

    print("=" * 64)
    print("cleanup_noncurrent_versions.py")
    print(f"  scope      = {args.scope}")
    print(f"  project    = {args.project or '(all)'}")
    print(f"  mode       = {'DRY-RUN (report only)' if is_dry else 'EXECUTE'}")
    print(f"  delete_r2  = {delete_r2}")
    print(f"  delete_rows= {delete_rows}")
    print(f"  measure    = {args.measure}")
    print("=" * 64)

    monthly_res = scheduled_res = None

    with SessionLocal() as db:
        if args.scope in ("monthly", "all"):
            monthly_res = plan_monthly(db, settings, args.project, args.measure)
        if args.scope in ("scheduled", "all"):
            scheduled_res = plan_scheduled(db, settings, args.measure)

    if monthly_res:
        print_plan("月度财务核算 MonthlyReport — 非 current 版本", monthly_res)
    if scheduled_res:
        print_plan("定时报告 ScheduledReportDeliveryLog — 非 current 记录", scheduled_res)

    if is_dry:
        print("\n[DRY-RUN] 未做任何修改。加 --delete-r2 / --delete-rows 执行。")
        return 0

    # 二次确认（防误触）
    if delete_rows:
        print("\n" + "!" * 64)
        print("!! 即将 DELETE 非 current DB 行（月度会级联删财务计算数据）!!")
        confirm = input("确认？输入 YES 继续，其它任意键取消: ")
        if confirm.strip() != "YES":
            print("取消。")
            return 0

    with SessionLocal() as db:
        if monthly_res and args.scope in ("monthly", "all") and (delete_r2 or delete_rows):
            r2_ok, r2_fail, nulled, deleted = apply_monthly(
                db, settings, monthly_res, delete_r2, delete_rows, skip_null
            )
            print(f"\n[月度] R2 删除成功={r2_ok} 失败={r2_fail} | NULL列={nulled} | 删DB行={deleted}")
        if scheduled_res and args.scope in ("scheduled", "all") and (delete_r2 or delete_rows):
            r2_ok, r2_fail, nulled, deleted = apply_scheduled(
                db, settings, scheduled_res, delete_r2, delete_rows, skip_null
            )
            print(f"[定时] R2 删除成功={r2_ok} 失败={r2_fail} | NULL列={nulled} | 删DB行={deleted}")

    print("\n完成。可重跑 --dry-run 复核。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
