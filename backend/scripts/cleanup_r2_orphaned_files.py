"""
R2 Storage Cleanup Script

用于清理 Cloudflare R2 中不再被数据库引用的孤立文件。

使用方法:
    # Dry-run (不删除，只报告)
    python scripts/cleanup_r2_orphaned_files.py --dry-run

    # 执行删除
    python scripts/cleanup_r2_orphaned_files.py

    # 指定项目清理
    python scripts/cleanup_r2_orphaned_files.py --project "My Store"

    # 查看帮助
    python scripts/cleanup_r2_orphaned_files.py --help
"""

import argparse
from collections import defaultdict
from datetime import datetime, timedelta, timezone

import boto3
from botocore.config import Config
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.services.r2_service import is_private_key

#: 私有桶孤儿清理的**安全年龄下限**（天）。
#:
#: 方案上传是「先写 R2 对象 → 再插 crm_proposal_versions 行」，所以一个
#: 并发的清理可能看到一个**刚上传、还没有 DB 行**的对象。不设下限时
#: （``--min-age`` 默认 0 → cutoff 为 None → 过滤整个失效）这类对象会被
#: 立刻删掉，随后提交的那行版本就读不出内容。
#:
#: 公开桶那轮不受影响（它只删真正的商店级陈旧文件）。
PRIVATE_ORPHAN_MIN_AGE_DAYS = 1


def get_r2_client(settings: Settings):
    """创建 R2 S3 客户端"""
    return boto3.client(
        's3',
        endpoint_url=settings.r2_endpoint_url,
        aws_access_key_id=settings.r2_access_key_id,
        aws_secret_access_key=settings.r2_secret_access_key,
        region_name=settings.r2_region or 'auto',
        config=Config(signature_version='s3v4'),
    )


def list_all_r2_files(client, bucket: str) -> set[str]:
    """列出 R2 bucket 中的所有文件 key"""
    all_keys = set()
    paginator = client.get_paginator('list_objects_v2')

    for page in paginator.paginate(Bucket=bucket):
        if 'Contents' in page:
            for obj in page['Contents']:
                all_keys.add(obj['Key'])

    return all_keys


def collect_referenced_keys(db: Session, project_slug: str | None = None) -> set[str]:
    """
    从数据库收集所有被引用的 R2 文件 key

    Returns:
        所有被业务引用的 R2 key 集合
    """
    from app.models import (
        MonthlyReport,
        PlatformRevenue,
        ScheduledReportDeliveryLog,
    )

    referenced = set()

    # 1. MonthlyReport 的 summary_pdf_r2_key
    monthly_query = select(MonthlyReport.summary_pdf_r2_key)
    if project_slug:
        monthly_query = monthly_query.where(MonthlyReport.project_name == project_slug)
    for row in db.execute(monthly_query).scalars():
        if row:
            referenced.add(row)

    # 2. PlatformRevenue 的 screenshot_r2_key
    pr_query = select(PlatformRevenue.screenshot_r2_key)
    if project_slug:
        pr_query = pr_query.where(PlatformRevenue.project_name == project_slug)
    for row in db.execute(pr_query).scalars():
        if row:
            referenced.add(row)

    # 3. ScheduledReportDeliveryLog 的 screenshot_r2_key / screenshot_r2_thumb_key
    #    （定时报告截图，full + thumb 都反向引用，否则会被误判为孤儿而删除）
    srdl_query = select(
        ScheduledReportDeliveryLog.screenshot_r2_key,
        ScheduledReportDeliveryLog.screenshot_r2_thumb_key,
    )
    for k_main, k_thumb in db.execute(srdl_query).all():
        for row in (k_main, k_thumb):
            if row:
                referenced.add(row)

    # 4. ExchangeRate thumbnail (通过前端生成路径)
    # thumbnail 路径格式: {project}/exchange-rate-thumb/{filename}
    # 这部分由 exchange_rates 端点动态生成，需要单独处理

    # 5. CrmProposalVersion 的 raw_r2_key / adapted_r2_key（BLF-1418）
    #    客户方案对象现在落在**私有桶**，方案上传中途失败会留下没有 DB 行的
    #    孤儿（补偿删除只能覆盖「同一次上传内」的部分失败；跨请求的失败
    #    仍会漏）。私有桶必须被单独扫一遍才能发现它们。
    from app.models.crm import CrmProposalVersion

    cpv_query = select(
        CrmProposalVersion.raw_r2_key, CrmProposalVersion.adapted_r2_key
    )
    for raw_key, adapted_key in db.execute(cpv_query).all():
        for key in (raw_key, adapted_key):
            if key:
                referenced.add(key)

    return referenced


def collect_local_files_references(db: Session, settings: Settings, project_slug: str | None = None) -> set[str]:
    """
    收集本地路径引用的文件，这些文件通常也在 R2 存有副本。

    注意：此函数用于追踪可能同步到 R2 的本地文件引用。
    如果系统已经完全迁移到 R2，此函数的实用性有限。

    Returns:
        本地文件路径集合（需要转换为 R2 key）
    """
    from app.models import AnalysisSourceFile, MonthlyReport

    local_paths = set()

    # 简化：只收集所有本地路径，不再做复杂的项目过滤
    # 因为 project_slug 参数在这个上下文中难以准确应用

    # AnalysisSourceFile.upload_file_path - 本地缓存路径
    for row in db.execute(select(AnalysisSourceFile.upload_file_path)).scalars():
        if row:
            local_paths.add(row)

    # AnalysisPT1Calculation.result_file_path - 本地缓存路径
    # （注：result_file_path 属于 AnalysisPT1Calculation，不是 AnalysisSourceFile；
    #  原代码写错了类，运行到这一行会 AttributeError —— 连带整个清理脚本崩溃。）
    from app.models.product_analysis_source import AnalysisPT1Calculation

    for row in db.execute(select(AnalysisPT1Calculation.result_file_path)).scalars():
        if row:
            local_paths.add(row)

    # MonthlyReport.transaction_file_path
    for row in db.execute(select(MonthlyReport.transaction_file_path)).scalars():
        if row:
            local_paths.add(row)

    return local_paths


def local_path_to_r2_key(local_path: str, settings: Settings) -> str | None:
    """
    将本地文件路径转换为 R2 key

    本地路径格式: {UPLOAD_ROOT}/{project_slug}/{file_type}/{filename}
    R2 key 格式: {project_slug}/{file_type}/{filename}
    """
    upload_root = str(settings.upload_root)
    if local_path.startswith(upload_root):
        relative = local_path[len(upload_root):].lstrip('/')
        return relative
    return None


def find_orphaned_files(
    db: Session,
    settings: Settings,
    r2_client,
    project_slug: str | None = None,
) -> list[dict]:
    """
    找出 R2 中孤立文件（未被数据库引用）

    Returns:
        [{'key': str, 'size': int, 'last_modified': datetime, 'reason': str}, ...]
    """
    print("[1/4] 列出 R2 中的所有文件...")
    all_r2_keys = list_all_r2_files(r2_client, settings.r2_bucket_name)
    print(f"      R2 中共有 {len(all_r2_keys)} 个文件")

    # BLF-1418：**私有桶也要扫**。客户方案对象落在私有桶，方案上传中途失败
    # 会留下没有 DB 行的孤儿（补偿删除只覆盖「同一次上传内」的部分失败）。
    # 只扫公开桶 → 私有桶里的孤儿永远发现不了 → 永久堆积。
    private_keys: set[str] = set()
    private_bucket = ""
    if settings.r2_private_bucket_isolated:
        private_bucket = settings.r2_private_bucket_resolved
        private_keys = list_all_r2_files(r2_client, private_bucket)
        print(f"      私有桶 {private_bucket} 中共有 {len(private_keys)} 个文件")

    print("[2/4] 收集数据库中被引用的 R2 key...")
    referenced_keys = collect_referenced_keys(db, project_slug)
    print(f"      找到 {len(referenced_keys)} 个被引用的 R2 key")

    print("[3/4] 收集本地路径引用的文件（可能同步到 R2）...")
    local_references = collect_local_files_references(db, settings, project_slug)

    # 转换本地路径为 R2 key
    r2_keys_from_local = set()
    for local_path in local_references:
        r2_key = local_path_to_r2_key(local_path, settings)
        if r2_key:
            r2_keys_from_local.add(r2_key)
    print(f"      从本地路径找到 {len(r2_keys_from_local)} 个 R2 key")

    # 合并所有被引用的 key
    all_referenced = referenced_keys | r2_keys_from_local

    print("[4/4] 分析孤立文件...")
    orphaned = []
    for key in all_r2_keys:
        # 检查是否被引用。优先级 (避免 line 184-187 原版的括号 bug)：
        #   (A) key 已经被 DB 反查到
        #   (B) key 出现在本地路径反查里 (本地 cache 路径 -> R2 key)
        # 否则 -> orphan
        is_referenced = key in all_referenced or key in r2_keys_from_local

        # BLF-1418：敏感前缀（当前 = 客户方案）**一律不删**。
        # 这些对象含报价与客户信息，存放在私有桶；本脚本只扫公开桶，
        # 无法反查私有桶的引用关系 → 误判为孤儿并删除会造成不可恢复的数据丢失。
        # 私有桶的清理由业务代码（proposal_service.delete_proposal）负责。
        if is_private_key(key):
            continue

        if not is_referenced:
            # 获取文件元数据
            try:
                response = r2_client.head_object(
                    Bucket=settings.r2_bucket_name,
                    Key=key
                )
                orphaned.append({
                    'key': key,
                    'size': response.get('ContentLength', 0),
                    'last_modified': response.get('LastModified'),
                    'storage_class': response.get('StorageClass', 'STANDARD'),
                })
            except Exception as e:
                orphaned.append({
                    'key': key,
                    'size': 0,
                    'last_modified': None,
                    'error': str(e),
                })

    return orphaned


def find_private_orphaned_files(
    db: Session,
    settings: Settings,
    r2_client,
) -> list[dict]:
    """找私有桶里**没有 DB 引用**的客户方案对象（上传失败留下的孤儿）。

    ⚠️ **只处理 ``crm-proposals/`` 前缀**（BLF-1418 review 修）：
    私有桶是**共享桶**，里面还有 ``db-backups/``（数据库备份）与 pgBackRest 的
    ``var/lib/pgbackrest/backups/...`` 仓库 —— 它们**没有** crm_proposal_versions
    引用，但它们是**有效数据**（备份 + WAL 归档），有独立的保留策略
    （``repo1-retention-full=7``），不由本脚本管。全桶扫会把它们全判成孤儿删掉。

    判定依据：``crm_proposal_versions.raw_r2_key`` / ``adapted_r2_key``。

    Returns:
        [{'key': str, 'size': int, 'last_modified': datetime, 'bucket': str}, ...]
    """
    if not settings.r2_private_bucket_isolated:
        return []
    private_bucket = settings.r2_private_bucket_resolved
    all_keys = list_all_r2_files(r2_client, private_bucket)
    referenced = collect_referenced_keys(db)

    orphaned: list[dict] = []
    for key in all_keys:
        # 只管客户方案前缀 —— 其它前缀（db-backups / var/…）有各自的保留策略
        if not key.startswith("crm-proposals/"):
            continue
        if key in referenced:
            continue
        try:
            response = r2_client.head_object(Bucket=private_bucket, Key=key)
            orphaned.append({
                'key': key,
                'size': response.get('ContentLength', 0),
                'last_modified': response.get('LastModified'),
                'storage_class': response.get('StorageClass', 'STANDARD'),
                'bucket': private_bucket,
            })
        except Exception as e:  # noqa: BLE001 - 审计脚本，吞掉单对象异常
            orphaned.append({
                'key': key,
                'size': 0,
                'last_modified': None,
                'error': str(e),
                'bucket': private_bucket,
            })
    return orphaned


def format_size(size_bytes: int) -> str:
    """格式化文件大小"""
    size: float = float(size_bytes)
    for unit in ['B', 'KB', 'MB', 'GB']:
        if size < 1024:
            return f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} TB"


def print_orphaned_summary(orphaned: list[dict], show_details: bool = False):
    """打印孤立文件汇总"""
    total_size = sum(f.get('size', 0) for f in orphaned)

    print(f"\n{'='*60}")
    print("孤立文件清理报告")
    print(f"{'='*60}")
    print(f"总计: {len(orphaned)} 个孤立文件")
    print(f"总大小: {format_size(total_size)}")
    print()

    # 按文件夹分组
    by_folder = defaultdict(list)
    for f in orphaned:
        parts = f['key'].split('/')
        folder = '/'.join(parts[:-1]) if len(parts) > 1 else '(root)'
        by_folder[folder].append(f)

    print("按文件夹分布:")
    for folder, files in sorted(by_folder.items(), key=lambda x: -len(x[1])):
        folder_size = sum(f.get('size', 0) for f in files)
        print(f"  {folder}/: {len(files)} 个文件 ({format_size(folder_size)})")

    if show_details:
        print("\n详细列表 (前 50 个):")
        for i, f in enumerate(sorted(orphaned, key=lambda x: x['key'])[:50]):
            mod_time = f.get('last_modified', '')
            if mod_time:
                mod_time = mod_time.strftime('%Y-%m-%d')
            print(f"  [{i+1:3}] {mod_time:10} {format_size(f.get('size', 0)):>8}  {f['key']}")

        if len(orphaned) > 50:
            print(f"  ... 还有 {len(orphaned) - 50} 个文件")


def delete_orphaned_files(r2_client, bucket: str, orphaned: list[dict], dry_run: bool = True):
    """删除孤立文件"""
    if dry_run:
        print("\n[DRY-RUN 模式] 不会实际删除文件")
        return

    print(f"\n开始删除 {len(orphaned)} 个孤立文件...")
    deleted = 0
    failed = 0

    for f in orphaned:
        try:
            r2_client.delete_object(Bucket=bucket, Key=f['key'])
            deleted += 1
            if deleted % 10 == 0:
                print(f"  已删除 {deleted}/{len(orphaned)}...")
        except Exception as e:
            failed += 1
            print(f"  删除失败: {f['key']} - {e}")

    print(f"\n删除完成: {deleted} 成功, {failed} 失败")


def _print_config() -> int:
    """--config-print:打印脚本将扫哪些 prefix 和列,审计后退出。

    不连数据库，不连 R2，纯静态扫描 ORM 模型。
    """
    print("=" * 60)
    print("R2 cleanup script config print")
    print("=" * 60)

    # Bucket / endpoint 配置
    from app.core.config import get_settings
    settings = get_settings()
    print("\n[Bucket]")
    print(f"  bucket_name    : {settings.r2_bucket_name}")
    print(f"  endpoint_url   : {settings.r2_endpoint_url}")
    print(f"  public_url     : {settings.r2_public_url}")
    print(f"  r2_enabled     : {settings.r2_enabled}")

    # ORM 自动发现的 R2 key 列
    from app.services.artifact_service import ArtifactService
    cols = ArtifactService.all_r2_key_columns()
    print(f"\n[Discovered R2 key columns] ({len(cols)} total)")
    for model, col in cols:
        print(f"  - {model}.{col}")

    # R2 prefix 推算（基于业务已知的 prefix 模式）
    print("\n[Known R2 prefixes] (heuristic, may not be complete)")
    prefixes = [
        "monthly_reports/*",
        "platform-revenue/*/payment_screenshot/*",
        "exchange-rate-notes/{images,thumbs}/*",
        "inspection-screenshots/*",
        "fnsku-labels/*",
        "product-images/*",
        "product-thumbs/*",
        "avatars/*",
        "scheduled-reports/{full,thumb}/*",
        "product-analysis/*/*",
        # pgBackRest (自管，不动)
        "pgbackrest/*",
    ]
    for p in prefixes:
        print(f"  - {p}")

    print("\n[Behavior]")
    print("  default action : DRY-RUN (only lists). Pass --execute to actually delete.")
    print("  batch delete   : sequential delete_object (slow but simple)")
    print("  run again next : use --project / --min-age to scope")
    print()
    return 0


def main():
    parser = argparse.ArgumentParser(
        description='清理 R2 存储中的孤立文件',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  %(prog)s                                  # 默认：列出将被清理的文件，但不动手
  %(prog)s --execute                        # 真的要删除！会要求交互确认
  %(prog)s --execute --yes                  # 自动确认（cron 用）
  %(prog)s --config-print                   # 只打印将扫描哪些 prefix/列，退出
  %(prog)s --project "My Store"             # 只清理特定项目
  %(prog)s --min-age 30 --execute           # 只清理 30 天以上的，且真删
        """
    )
    # 默认安全：不带 --execute 时只报告。
    parser.add_argument(
        '--execute', '-x',
        action='store_true',
        default=False,
        help='真删除（必须显式指定）。默认（不带此 flag）只输出报告。'
    )
    parser.add_argument(
        '--dry-run', '-n',
        action='store_true',
        default=True,  # 默认 dry-run=True 是为了安全；--execute 会覆盖为 False
        help='只报告，不删除（默认行为，无需指定）。'
    )
    parser.add_argument(
        '--yes', '-y',
        action='store_true',
        default=False,
        help='跳过交互确认（仅在 --execute 时有效；cron 用）。'
    )
    parser.add_argument(
        '--project', '-p',
        help='只清理指定项目的文件（按 project_name 过滤）'
    )
    parser.add_argument(
        '--min-age',
        type=int,
        default=0,
        help='只清理 N 天前的文件（避免删除最近上传的）'
    )
    parser.add_argument(
        '--details',
        action='store_true',
        help='显示详细文件列表'
    )
    parser.add_argument(
        '--config-print',
        action='store_true',
        help='只打印脚本将扫描哪些 prefix / 表 / 列，立刻退出。供运维审计。'
    )

    args = parser.parse_args()

    # --execute 自动把 --dry-run 关掉
    if args.execute:
        args.dry_run = False

    # --config-print: 不连数据库，只打印脚本将扫哪些 prefix / 列,立刻退出
    if args.config_print:
        return _print_config()

    # 加载配置
    from app.core.config import get_settings
    settings = get_settings()

    if not settings.r2_enabled:
        print("错误: R2 存储未启用，请检查 .env 配置")
        return 1

    # 初始化数据库
    engine = create_engine(settings.database_url)
    db = Session(engine)

    try:
        # 创建 R2 客户端
        r2_client = get_r2_client(settings)

        # 查找孤立文件
        orphaned = find_orphaned_files(db, settings, r2_client, args.project)

        # 按时间过滤
        # cutoff 必须是 **timezone-aware**：boto3 返回的 LastModified 带 tzinfo
        # （R2 给的是 UTC），拿 naive 的 datetime.now() 去比会抛
        # TypeError: can't compare offset-naive and offset-aware datetimes
        # （BLF-1418 review 修 —— 那会让私有桶那轮直接崩掉，什么都报不出来）。
        cutoff = None
        if args.min_age > 0:
            cutoff = datetime.now(timezone.utc) - timedelta(days=args.min_age)
            orphaned = [
                f for f in orphaned
                if f.get('last_modified') is None or f['last_modified'] < cutoff
            ]
            print(f"\n过滤 {args.min_age} 天前的文件后: {len(orphaned)} 个文件")

        # 打印汇总
        print_orphaned_summary(orphaned, args.details)

        # 确认删除（只在 --execute 时弹）
        if orphaned and not args.dry_run:
            print(f"\n{'!'*60}")
            print(f"即将真删 {len(orphaned)} 个孤立文件。")
            if not args.yes:
                confirm = input("确认删除？输入 'yes' 继续，其它任意键取消: ")
                if confirm.lower() != 'yes':
                    print("取消删除")
                    return 0
            else:
                print("(已通过 --yes 跳过交互确认)")

        # 执行删除
        delete_orphaned_files(r2_client, settings.r2_bucket_name, orphaned, args.dry_run)

        # BLF-1418：私有桶的孤儿（客户方案上传失败残留）单独一轮。
        # 单独确认是因为它删的是**敏感数据**，且判定依据是另一套 DB 引用
        # （crm_proposal_versions）—— 与公开桶那轮不是一回事。
        private_orphaned = find_private_orphaned_files(db, settings, r2_client)
        # 同样的 --min-age 保护要作用在私有桶这一轮（BLF-1418 review 修）：
        # 方案上传是「先写 R2 对象、再插 crm_proposal_versions 行」，所以一个
        # 并发的清理可能看到一个**刚上传、还没有 DB 行**的对象 → 立刻删掉 →
        # 随后提交的那行版本就读不出来了。
        #
        # 私有桶这一轮还要求一个**安全下限**（默认 1 天）：不加 --min-age 时
        # cutoff 是 None → 过滤整个失效 → 刚上传的对象会被立刻删掉。
        # 公开桶那轮不受影响（它只删真正的商店级陈旧文件）。
        private_min_age = max(args.min_age, PRIVATE_ORPHAN_MIN_AGE_DAYS)
        private_cutoff = datetime.now(timezone.utc) - timedelta(days=private_min_age)
        before = len(private_orphaned)
        private_orphaned = [
            f for f in private_orphaned
            if f.get('last_modified') is None or f['last_modified'] < private_cutoff
        ]
        if before != len(private_orphaned):
            print(
                f"\n[私有桶] 按 {private_min_age} 天的安全下限过滤："
                f"{before} → {len(private_orphaned)} 个"
            )
        if private_orphaned:
            print(f"\n[私有桶] {settings.r2_private_bucket_resolved} 中有 "
                  f"{len(private_orphaned)} 个无 DB 引用的对象")
            for f in private_orphaned:
                print(f"  - {f['key']}  ({format_size(f.get('size', 0))})")
            if not args.dry_run:
                if not args.yes:
                    confirm = input(
                        "确认删除这些私有桶孤儿？输入 'yes' 继续，其它任意键取消: "
                    )
                    if confirm.lower() != 'yes':
                        print("取消删除")
                        return 0
                else:
                    print("(已通过 --yes 跳过交互确认)")
                delete_orphaned_files(
                    r2_client,
                    settings.r2_private_bucket_resolved,
                    private_orphaned,
                    args.dry_run,
                )

    finally:
        db.close()

    return 0


if __name__ == '__main__':
    exit(main())