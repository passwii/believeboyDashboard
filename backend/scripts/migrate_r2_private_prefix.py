"""
migrate_r2_private_prefix.py — 把敏感前缀的对象从公开桶迁到私有桶（BLF-1418）

背景
----
``R2_BUCKET_NAME``（线上 ``believeboy-dash``）挂在 Cloudflare R2 自定义域名
``bucket.believeboy.com`` 上，**整个桶公开可读** —— 无鉴权、无 Cookie 即可
GET 任意 key，且 key 可枚举（``crm-proposals/{id}/v{n}/raw.html``）。
客户方案含报价与客户信息，因此必须迁到**不挂自定义域名**的私有桶。

本脚本做两件事（可分别执行）：
  1. ``--copy``    把敏感前缀的对象**复制**到私有桶（R2 服务端 copy，不下载到本地）。
  2. ``--delete``  把公开桶里同名的对象**删除**（切断公开可下载的路径）。

安全模型（与仓库其它清理脚本一致）：
  - 默认 DRY-RUN：只报告将要迁/删什么，不动任何数据。
  - ``--execute`` 才真正动手（``--delete`` 额外需要 ``--confirm-delete``）。
  - ``--copy`` 幂等：目标已存在且大小一致 → 跳过。
  - ``--delete`` 只删**已成功复制**到私有桶的对象（先验证目标存在），避免删源失���。

运行（VPS 上，prod .env 提供 R2 凭证）：
  cd /root/believeboyDashboard/backend
  .venv/bin/python scripts/migrate_r2_private_prefix.py --dry-run
  .venv/bin/python scripts/migrate_r2_private_prefix.py --copy --execute
  .venv/bin/python scripts/migrate_r2_private_prefix.py --delete --execute --confirm-delete

回滚
----
``--delete`` 之后若需回滚：把 ``R2_PRIVATE_BUCKET_NAME`` 改回空 / 改回公开桶名，
并用 ``--copy-back`` 把对象复制回公开桶（前提是公开桶的自定义域名仍指向它）。
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

import boto3  # noqa: E402
from botocore.config import Config  # noqa: E402

from app.core.config import get_settings  # noqa: E402
from app.services.r2_service import PRIVATE_KEY_PREFIXES  # noqa: E402


def _client(settings):
    return boto3.client(
        "s3",
        endpoint_url=settings.r2_endpoint_url,
        aws_access_key_id=settings.r2_access_key_id,
        aws_secret_access_key=settings.r2_secret_access_key,
        region_name=settings.r2_region or "auto",
        config=Config(signature_version="s3v4"),
    )


def _list(client, bucket: str, prefix: str) -> list[dict]:
    out: list[dict] = []
    paginator = client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            out.append(
                {
                    "key": obj["Key"],
                    "size": obj.get("Size", 0),
                    "etag": (obj.get("ETag") or "").strip('"'),
                }
            )
    return out


def _head(client, bucket: str, key: str) -> dict | None:
    try:
        return client.head_object(Bucket=bucket, Key=key)
    except Exception:
        return None


def main() -> int:
    parser = argparse.ArgumentParser(
        description="把敏感前缀的对象从公开桶迁到私有桶（BLF-1418）",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
        epilog=(
            "示例:\n"
            "  %(prog)s --dry-run                      # 只报告\n"
            "  %(prog)s --copy --execute               # 复制到私有桶\n"
            "  %(prog)s --delete --execute --confirm-delete  # 删公开桶副本\n"
        ),
    )
    parser.add_argument(
        "--prefix",
        action="append",
        default=None,
        help=f"要迁移的 key 前缀（可重复）。默认全部敏感前缀: {sorted(PRIVATE_KEY_PREFIXES)}",
    )
    parser.add_argument("--copy", action="store_true", help="复制到私有桶")
    parser.add_argument("--copy-back", action="store_true", help="复制回公开桶（回滚用）")
    parser.add_argument("--delete", action="store_true", help="删除公开桶里的副本")
    parser.add_argument(
        "--execute",
        action="store_true",
        help="真正动手（默认 DRY-RUN，只报告）",
    )
    parser.add_argument(
        "--confirm-delete",
        action="store_true",
        help="--delete 的二次确认（必须同时给，否则拒绝删除）",
    )
    args = parser.parse_args()

    if not (args.copy or args.copy_back or args.delete):
        parser.error("至少指定一个动作：--copy / --copy-back / --delete")

    if args.delete and not args.confirm_delete:
        print("拒绝执行：--delete 必须同时给 --confirm-delete（删除不可逆）")
        return 2

    settings = get_settings()
    public_bucket = settings.r2_bucket_name
    private_bucket = settings.r2_private_bucket_resolved

    if not settings.r2_private_bucket_isolated and (args.copy or args.copy_back):
        print(
            "错误：私有桶未配置（R2_PRIVATE_BUCKET_NAME 为空或与公开桶同名）。\n"
            "      先在 .env 里配置一个**不挂自定义域名**的私有桶，再运行本脚本。\n"
            "      提示：本仓库的 R2 凭据可直接创建桶：\n"
            "        aws s3api create-bucket --bucket <新桶名> "
            "--endpoint-url $R2_ENDPOINT_URL\n"
            "        （创建后**不要**给它挂自定义域名 / 开启 r2.dev —— 挂了就不私有了）"
        )
        return 2

    prefixes = args.prefix or [f"{p}/" for p in sorted(PRIVATE_KEY_PREFIXES)]
    client = _client(settings)

    print("=" * 68)
    print("BLF-1418 · R2 敏感前缀迁移")
    print("=" * 68)
    print(f"公开桶  : {public_bucket}")
    print(f"私有桶  : {private_bucket}")
    print(f"前缀    : {', '.join(prefixes)}")
    print(f"模式    : {'EXECUTE' if args.execute else 'DRY-RUN（只报告）'}")
    print()

    total_objects = 0
    total_bytes = 0
    copied = 0
    deleted = 0
    skipped = 0

    for prefix in prefixes:
        objects = _list(client, public_bucket, prefix)
        print(f"[{prefix}] 公开桶里 {len(objects)} 个对象")
        for obj in objects:
            key = obj["key"]
            total_objects += 1
            total_bytes += obj["size"]
            size_mb = obj["size"] / 1024 / 1024
            print(f"  - {key}  ({size_mb:.2f} MB)")

            if args.copy:
                head = _head(client, private_bucket, key)
                if head and head.get("ContentLength") == obj["size"]:
                    print("      私有桶已存在且大小一致 → 跳过")
                    skipped += 1
                    continue
                if not args.execute:
                    print("      [DRY-RUN] 将复制到私有桶")
                    continue
                client.copy_object(
                    Bucket=private_bucket,
                    Key=key,
                    CopySource={"Bucket": public_bucket, "Key": key},
                )
                # 复制后校验目标确实存在且大小一致
                head = _head(client, private_bucket, key)
                if not head or head.get("ContentLength") != obj["size"]:
                    print("      !! 复制后校验失败，跳过删除")
                    continue
                print("      已复制到私有桶 ✓")
                copied += 1

            if args.copy_back:
                if not args.execute:
                    print("      [DRY-RUN] 将复制回公开桶")
                    continue
                client.copy_object(
                    Bucket=public_bucket,
                    Key=key,
                    CopySource={"Bucket": private_bucket, "Key": key},
                )
                print("      已复制回公开桶 ✓")
                copied += 1

            if args.delete:
                # 安全阀：只有目标桶里确实存在同 key 对象时才删源
                head = _head(client, private_bucket, key)
                if not head:
                    print("      !! 私有桶无此对象 → 拒绝删除源（保持公开副本以免丢数据）")
                    continue
                if not args.execute:
                    print("      [DRY-RUN] 将删除公开桶副本")
                    continue
                client.delete_object(Bucket=public_bucket, Key=key)
                print("      已删除公开桶副本 ✓")
                deleted += 1
        print()

    print("=" * 68)
    print(
        f"对象 {total_objects} 个 / {total_bytes / 1024 / 1024:.2f} MB"
        f" | 复制 {copied} | 删除 {deleted} | 跳过 {skipped}"
    )
    if not args.execute:
        print("DRY-RUN 结束：未做任何改动。去掉 --execute 才会真正执行。")
    else:
        print("完成。")
    print("=" * 68)
    return 0


if __name__ == "__main__":
    sys.exit(main())
