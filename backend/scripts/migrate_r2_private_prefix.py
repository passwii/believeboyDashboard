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
  - ``--delete`` 只删**已成功复制**到私有桶的对象（先验证目标存在 + 大小一致 +
    整文件 SHA-256 一致），避免删源失联。
  - **任何**写操作都要求私有桶已配置且与公开桶不同名（否则「源」与「副本」
    分不清，会把唯一副本删光）。
  - ``--delete`` 删掉 origin 后会输出**待 purge 的 URL 清单**：R2 自定义域名对
    部分对象启用 Cloudflare 边缘缓存，删 origin ≠ 公开不可下载，**必须再 purge**。

运行（VPS 上，prod .env 提供 R2 凭证）：
  cd /root/believeboyDashboard/backend
  .venv/bin/python scripts/migrate_r2_private_prefix.py --dry-run
  .venv/bin/python scripts/migrate_r2_private_prefix.py --copy --execute
  .venv/bin/python scripts/migrate_r2_private_prefix.py --delete --execute --confirm-delete
  # → 按脚本输出的 URL 清单做一次 Cloudflare 边缘 purge，再用
  #   scripts/r2_cache_purge_check.py --key <key> 复查

回滚
----
``--delete`` 之后若需回滚：**先**跑 ``--copy-back``（它要求私有桶仍配置着，
因为脚本要知道从哪个桶恢复），**再**考虑要不要清 ``R2_PRIVATE_BUCKET_NAME``。
清早了会让回滚无从下手（脚本不知道源桶）。

``--copy-back`` 默认**同时删掉私有桶里的副本** —— 回滚就是回到迁移前状态，
私有桶不该留下没人能找到的孤儿（后续清掉 R2_PRIVATE_BUCKET_NAME 后，
删方案只会清公开桶那份，私有桶那份既不在任何清理脚本的扫描范围里、也没有
死信记录 → 变成谁也找不到的孤儿）。确实要保留时用 ``--keep-private``。

前提是公开桶的自定义域名仍指向它。
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
    # 注意：pgBackRest 的仓库前缀（var/lib/pgbackrest/backups）**不在**本表 ——
    # 它走自己的 repo1-s3-* 配置、不经应用层路由，单独由 is_pgbackrest_key 判定。
    PRIVATE_KEY_PREFIXES = frozenset({"crm-proposals", "db-backups"})
    # 客户方案按精确布局匹配（crm-proposals/{数字}/v{数字}/{文件名}），
    # 其余按前缀匹配 —— 与 app/services/r2_service.py 一致。
    PRIVATE_KEY_LAYOUTS = (
        "db-backups/pgbackrest/",
        "var/lib/pgbackrest/backups/",
    )


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
    parser.add_argument(
        "--keep-private",
        action="store_true",
        help=(
            "--copy-back 时保留私有桶里的副本（默认会删：回滚 = 回到迁移前状态，"
            "私有桶不该留下没人能找到的孤儿）"
        ),
    )
    parser.add_argument("--delete", action="store_true", help="删除公开桶里的副本")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="只报告将做什么，不做任何改动（等价于不加 --execute）",
    )
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

    # --dry-run 与 --execute 矛盾：--dry-run 的承诺是「不做任何改动」，
    # 而 --execute 是「真动手」。两者同时给时，--dry-run 必须胜出
    # （否则 --delete --dry-run --execute --confirm-delete 会真删）。
    if args.dry_run and args.execute:
        print("--dry-run 与 --execute 矛盾：按 --dry-run 处理（不做任何改动）")
        args.execute = False

    # --dry-run 单独用 = 「只看不改」的预检：默认列出各敏感前缀在公开桶里的对象。
    # 没给任何动作时，把它当成隐式的「只读列举」，而不是 argparse 报错。
    if args.dry_run and not (args.copy or args.copy_back or args.delete):
        args.copy = False
        args.copy_back = False
        args.delete = False
        args.list_only = True
    else:
        args.list_only = False
        if not (args.copy or args.copy_back or args.delete):
            parser.error(
                "至少指定一个动作：--copy / --copy-back / --delete\n"
                "（只看不改就直接用 --dry-run，或用这些动作但**不加** --execute）"
            )

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
    #
    # 注意 --copy-back 也要这个守卫：回滚的前提就是「私有桶仍然配着」——
    # 若先把 R2_PRIVATE_BUCKET_NAME 清掉，脚本根本不知道该从哪个桶恢复。
    if not isolated:
        print(
            "错误：私有桶未配置（R2_PRIVATE_BUCKET_NAME 为空或与公开桶同名）。\n"
            "      **任何**写操作（--copy / --copy-back / --delete）都要求私有桶先配置好，\n"
            "      否则脚本无从判断「源」与「副本」谁是谁，会误删唯一副本。\n"
            "      回滚（--copy-back）也必须在**私有桶仍配置着**的时候做：\n"
            "      先跑 --copy-back，再考虑要不要清 R2_PRIVATE_BUCKET_NAME。\n"
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
    # 失败计数：复制 / 删除 / 回滚任一对象失败都必须**让命令失败**。
    # 旧实现只 print 警告然后 continue，末尾照样打「完成。」并 return 0 ——
    # 操作者（或自动化）会把「敏感对象没拷过去 / 公开副本没删掉」当成迁移成功。
    copy_failures = 0
    delete_failures = 0
    purge_targets: list[str] = []
    public_base = settings.r2_public_url or (
        f"{settings.r2_endpoint_url}/{settings.r2_bucket_name}"
    )

    for prefix in prefixes:
        # --copy-back 是**回滚**路径：源在私有桶（--delete 已把公开桶清空），
        # 所以必须列私有桶；否则公开桶已空 → 循环 0 条 → 什么都 restore 不回来。
        # --list_only（--dry-run 单独用）列公开桶 —— 预检要看的是「公开桶里有什么」。
        if args.copy_back:
            source_bucket = private_bucket
        elif args.list_only:
            source_bucket = public_bucket
        else:
            source_bucket = public_bucket
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
                    # 只比大小**不够**（BLF-1418 review 修）：私有桶里若已有一份
                    # 同名但**内容不同、恰好同大小**的对象（比如上一次跑崩了、
                    # 或有人手工放过东西），只比大小就会永久跳过它 → 迁移**无法自愈**：
                    # 后续 --delete 会因 SHA-256 不一致而拒绝删源，重跑 --copy 又
                    # 继续跳过 → 只能人工去私有桶删掉那份才能修好。
                    # → 比内容（整文件 SHA-256；ETag 对 multipart 不可直接比）。
                    if args.execute:
                        src_hash = _sha256(client, public_bucket, key)
                        dst_hash = _sha256(client, private_bucket, key)
                        if src_hash == dst_hash:
                            print("      私有桶已存在且内容一致 → 跳过")
                            skipped += 1
                            continue
                        print("      私有桶已有同名但内容不同 → 覆盖重拷")
                    else:
                        print("      私有桶已存在且大小一致（执行时会校验内容）→ 将跳过")
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
                    copy_failures += 1
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
                    copy_failures += 1
                    continue
                print("      已复制回公开桶 ✓")
                copied += 1
                # 回滚 = 回到迁移前状态 → 私有桶里的副本也该删掉。
                # 否则：副本留在私有桶，之后操作者按文档清掉 R2_PRIVATE_BUCKET_NAME
                # → 删方案只会删公开桶那份（私有桶那份不在任何清理脚本的扫描
                # 范围里，孤立文件清理脚本只扫公开桶）→ 变成谁也找不到的孤儿。
                if not args.keep_private:
                    client.delete_object(Bucket=private_bucket, Key=key)
                    print("      已删除私有桶副本 ✓")

            if args.delete:
                # 安全阀 1：私有桶里必须存在同 key 对象
                head = _head(client, private_bucket, key)
                if not head:
                    print("      !! 私有桶无此对象 → 拒绝删除源（保持公开副本以免丢数据）")
                    delete_failures += 1
                    continue
                # 安全阀 2：大小一致
                if head.get("ContentLength") != obj["size"]:
                    print("      !! 私有桶副本大小不一致 → 拒绝删除源")
                    delete_failures += 1
                    continue
                # 安全阀 3：内容一致（整文件 SHA-256；ETag 对 multipart 不可直接比）
                if args.execute:
                    src_hash = _sha256(client, public_bucket, key)
                    dst_hash = _sha256(client, private_bucket, key)
                    if src_hash != dst_hash:
                        print("      !! 私有桶副本内容不一致 → 拒绝删除源")
                        delete_failures += 1
                        continue
                    print(f"      内容校验通过 (sha256={src_hash[:16]}…)")
                if not args.execute:
                    print("      [DRY-RUN] 将删除公开桶副本")
                    continue
                client.delete_object(Bucket=public_bucket, Key=key)
                print("      已删除公开桶副本 ✓")
                deleted += 1
                # 删掉 origin **不等于**公开不可下载：R2 自定义域名对部分对象
                # （如 application/octet-stream 的大文件）会启用 Cloudflare 边缘缓存，
                # 边缘副本在 purge 前仍可被匿名下载。必须把 purge 目标记下来。
                purge_targets.append(f"{public_base}/{key}")
        print()

    print("=" * 68)
    print(
        f"对象 {total_objects} 个 / {total_bytes / 1024 / 1024:.2f} MB"
        f" | 复制 {copied} | 删除 {deleted} | 跳过 {skipped}"
    )
    if purge_targets:
        print()
        print("⚠️  以下 URL 刚删除了 origin 副本，但**边缘缓存可能仍在吐旧内容**：")
        for url in purge_targets:
            print(f"  {url}")
        print()
        print("必须做一次 Cloudflare 边缘 purge（否则匿名仍可下载）：")
        print("  Dashboard: https://dash.cloudflare.com/<zone>/<domain>/caching/cache-purge")
        print("             → Purge by URL → 粘上面这些 URL")
        print("  API      : POST https://api.cloudflare.com/client/v4/zones/<zone_id>/purge_cache")
        print('             {"files": [<上面这些 URL>]}')
        print("  复查     : .venv/bin/python scripts/r2_cache_purge_check.py --key <key> ...")
    if not args.execute:
        print("DRY-RUN 结束：未做任何改动。去掉 --execute 才会真正执行。")
    else:
        print("完成。")
    print("=" * 68)

    # 有对象没处理成功 → **命令必须失败**（非零退出）。
    # 旧实现只 print 警告就 return 0，操作者/自动化会把「敏感对象没拷过去」
    # 或「公开副本没删掉」当成迁移成功 —— 那正是这个 P0 最不能出的错。
    if copy_failures or delete_failures:
        print()
        print(f"✗ 迁移未完全成功：复制失败 {copy_failures} 个，删除失败 {delete_failures} 个。")
        if delete_failures:
            print("  删除失败的对象**仍留在公开桶**，仍可被匿名下载 —— 需处理后重跑。")
        if copy_failures:
            print("  复制失败的对象**没有私有副本**，未受保护。")
        print("=" * 68)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
