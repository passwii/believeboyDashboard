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
import hashlib
import os
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))
# 脚本被拷到 /tmp 等其它位置运行时，__file__ 相对路径会指错位置；
# 补上当前工作目录（backend/）保证 `import app` 仍能解析。
_CWD = str(Path.cwd())
if _CWD not in sys.path:
    sys.path.insert(0, _CWD)

import boto3  # noqa: E402
from botocore.config import Config  # noqa: E402

from app.core.config import get_settings  # noqa: E402

try:
    from app.services.r2_service import PRIVATE_KEY_PREFIXES
except ImportError:  # pragma: no cover - 脚本被拷到别处 / 代码未部署时
    # 本脚本可能在代码部署前先跑（只需前缀列表，不依赖新代码）。
    # 与 app/services/r2_service.py 的 PRIVATE_KEY_PREFIXES 保持一致。
    PRIVATE_KEY_PREFIXES = frozenset({"crm-proposals", "db-backups", "backups"})


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


def _sha256(client, bucket: str, key: str) -> str:
    """整流读取算 SHA-256（对象级完整性校验）。

    不能只看 ETag：R2 对 multipart 上传的对象返回 ``<md5>-<part数>`` 形式
    的 ETag（与整文件摘要不同），直接比 ETag 会误判「不一致」。
    这里算整文件 SHA-256，两份副本同法计算后逐一比对。
    """
    h = hashlib.sha256()
    body = client.get_object(Bucket=bucket, Key=key)["Body"]
    try:
        while True:
            chunk = body.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
    finally:
        close = getattr(body, "close", None)
        if callable(close):
            close()
    return h.hexdigest()


def _private_bucket_from_env_file() -> str:
    """从 backend/.env 读 R2_PRIVATE_BUCKET_NAME（代码尚未部署时用）。

    线上跑的 Settings 类可能还没有这个字段（pydantic 会忽略未知 env），
    因此这里直接解析 .env 文件，保证迁移脚本可以**先于**代码部署执行。
    """
    env_path = Path("/root/believeboyDashboard/backend/.env")
    if not env_path.exists():
        env_path = BACKEND / ".env"
    if not env_path.exists():
        return ""
    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        if key.strip() == "R2_PRIVATE_BUCKET_NAME":
            return val.strip().strip('"').strip("'")
    return ""


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
    # 私有桶名：优先用新代码的派生属性；代码尚未部署时从 env / .env 读
    # （迁移可以先于代码部署跑）。
    private_bucket = (
        getattr(settings, "r2_private_bucket_resolved", None)
        or os.environ.get("R2_PRIVATE_BUCKET_NAME", "").strip()
        or _private_bucket_from_env_file()
        or settings.r2_bucket_name
    )
    isolated = getattr(settings, "r2_private_bucket_isolated", None)
    if isolated is None:
        _env_name = (
            os.environ.get("R2_PRIVATE_BUCKET_NAME", "").strip()
            or _private_bucket_from_env_file()
        )
        isolated = bool(_env_name) and _env_name != settings.r2_bucket_name

    # 隔离守卫：**任何**写操作前都必须确认私有桶已配置且与公开桶不同名。
    # 旧实现漏了 args.delete：私有桶未配置时 private_bucket 回落到公开桶，
    # 三重安全阀就变成「公开桶对象跟自己比大小、跟自己比 SHA-256」→ 全过，
    # --delete 直接把**唯一副本**删光（与脚本声明的「先确认私有副本存在才删源」相反）。
    if not isolated:
        print(
            "错误：私有桶未配置（R2_PRIVATE_BUCKET_NAME 为空或与公开桶同名）。\n"
            "      **任何**写操作（--copy / --copy-back / --delete）都要求私有桶先配置好，\n"
            "      否则脚本无从判断「源」与「副本」谁是谁，会误删唯一副本。\n"
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
        # --copy-back 是**回滚**路径：源在私有桶（--delete 已把公开桶清空），
        # 所以必须列私有桶；否则公开桶已空 → 循环 0 条 → 什么都 restore 不回来。
        source_bucket = private_bucket if args.copy_back else public_bucket
        objects = _list(client, source_bucket, prefix)
        print(f"[{prefix}] {source_bucket} 里 {len(objects)} 个对象")
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
                # 回滚也要校验：复制后确认公开桶确实有同 key 对象且大小一致
                head = _head(client, public_bucket, key)
                if not head or head.get("ContentLength") != obj["size"]:
                    print("      !! 回滚复制后校验失败")
                    continue
                print("      已复制回公开桶 ✓")
                copied += 1

            if args.delete:
                # 安全阀 1：私有桶里必须存在同 key 对象
                head = _head(client, private_bucket, key)
                if not head:
                    print("      !! 私有桶无此对象 → 拒绝删除源（保持公开副本以免丢数据）")
                    continue
                # 安全阀 2：大小一致
                if head.get("ContentLength") != obj["size"]:
                    print("      !! 私有桶副本大小不一致 → 拒绝删除源")
                    continue
                # 安全阀 3：内容一致（整文件 SHA-256；ETag 对 multipart 不可直接比）
                if args.execute:
                    src_hash = _sha256(client, public_bucket, key)
                    dst_hash = _sha256(client, private_bucket, key)
                    if src_hash != dst_hash:
                        print("      !! 私有桶副本内容不一致 → 拒绝删除源")
                        continue
                    print(f"      内容校验通过 (sha256={src_hash[:16]}…)")
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
