"""
r2_cache_purge_check.py — 排查 R2 自定义域名上的 Cloudflare 边缘缓存残留（BLF-1418）

背景
----
R2 自定义域名（线上 ``bucket.believeboy.com``）会对**部分**对象启用 Cloudflare
边缘缓存（响应带 ``cf-cache-status: HIT`` + ``age`` + ``cache-control: max-age=120``）。
删除源站对象**不会**立刻让边缘副本消失 —— 边缘仍会继续吐旧内容，直到缓存条目过期
或被 purge。

实测（2026-10-20，线上）：
- ``crm-proposals/*``  → ``cf-cache-status: DYNAMIC``（HTML，不缓存）→ 删源站即刻生效。
- ``db-backups/*.tar.gz``（146MB，``application/octet-stream``）→ ``HIT`` + ``age`` 持续增长
  → **删源站后仍可下载**，且 ``age`` 超过 ``max-age=120`` 也不过期（边缘持续 revalidate 后再缓存）。

⚠️ 结论：对象已从 origin 删除 ≠ 公开不可下载。**必须做一次 Cloudflare 边缘 purge**。

本脚本（只读诊断，不改任何东西）：
- 列出公开桶里敏感前缀的对象；
- 对每个 URL 同时发 HEAD（走 origin）与 GET（走边缘缓存），对比状态码与
  ``cf-cache-status`` / ``age``；
- 标出「origin 已 404 但 GET 仍 200」= **边缘缓存残留，需要 purge**。

真正执行 purge 需要 Cloudflare API token（Zone → Cache Purge），本仓库没有该凭据，
故只提供诊断 + 精确的 purge 目标清单。

用法：
  cd backend
  .venv/bin/python scripts/r2_cache_purge_check.py
  .venv/bin/python scripts/r2_cache_purge_check.py --prefix db-backups/
"""

from __future__ import annotations

import argparse
import sys
import urllib.error
import urllib.request
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))
# 脚本被拷到别处运行时，补上当前工作目录保证 `import app` 可解析。
_CWD = str(Path.cwd())
if _CWD not in sys.path:
    sys.path.insert(0, _CWD)

import boto3  # noqa: E402
from botocore.config import Config  # noqa: E402

from app.core.config import get_settings  # noqa: E402

try:
    from app.services.r2_service import PRIVATE_KEY_PREFIXES
except ImportError:  # pragma: no cover - 代码未部署时
    # 与 app/services/r2_service.py 的 PRIVATE_KEY_PREFIXES 保持一致。
    # 注意 var/ 是 pgBackRest 的 repo1-path=/var/lib/pgbackrest/backups 去开头
    # 斜杠后的首段（不是 backups/）。
    PRIVATE_KEY_PREFIXES = frozenset({"crm-proposals", "db-backups", "var"})


def _client(settings):
    return boto3.client(
        "s3",
        endpoint_url=settings.r2_endpoint_url,
        aws_access_key_id=settings.r2_access_key_id,
        aws_secret_access_key=settings.r2_secret_access_key,
        region_name=settings.r2_region or "auto",
        config=Config(signature_version="s3v4"),
    )


def _list(client, bucket: str, prefix: str) -> list[str]:
    out: list[str] = []
    paginator = client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            out.append(obj["Key"])
    return out


def _probe(url: str, method: str) -> tuple[int, dict[str, str]]:
    """发一个请求，返回 (状态码, 关键响应头)。

    **不加 Range 头**：带 Range 的请求会被 Cloudflare 边缘直接判 403（实测），
    那样就看不到「边缘还在吐旧内容」的真实状态（会误报成没残留）。
    GET 会完整下载响应，因此只读一个分块就关连接，避免拉完 153MB。
    """
    req = urllib.request.Request(url, method=method)
    # 必须带一个普通客户端 UA：Cloudflare 边缘会对 python-urllib 的默认 UA 直接返
    # 403（实测），那样会**误判成「没有缓存残留」**（假阴性，正是这个脚本要抓的东西）。
    req.add_header("User-Agent", "curl/8.7.1")
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            headers = {k.lower(): v for k, v in resp.headers.items()}
            if method == "GET":
                # 只读一个分块，确认能拿到内容即退出（不下载完 153MB）
                try:
                    next(resp)
                except StopIteration:
                    pass
            return resp.status, headers
    except urllib.error.HTTPError as exc:
        return exc.code, {k.lower(): v for k, v in (exc.headers or {}).items()}
    except Exception as exc:  # noqa: BLE001 - 诊断脚本，吞掉网络异常
        return 0, {"error": type(exc).__name__}


def _keys_from_db(prefixes: list[str]) -> list[str]:
    """从数据库推导历史上传过的敏感 key（即使已从 origin 删除）。

    客户方案的 R2 key 存在 ``crm_proposal_versions.raw_r2_key`` /
    ``adapted_r2_key`` —— 方案被删后 DB 行也没了，但**边缘缓存可能还在吐旧内容**。
    这就是「origin 已删 ≠ 公开不可下载」的来源。

    删掉的对象 origin list 不出来，只能靠 DB 历史或显式清单补齐，
    否则诊断脚本会输出「✅ 没有残留」这个**危险的假阴性**。
    """
    out: set[str] = set()
    if not any(p.startswith("crm-proposals/") for p in prefixes):
        return sorted(out)
    try:
        from sqlalchemy import select

        from app.db.session import SessionLocal
        from app.models.crm import CrmProposalVersion
    except Exception:  # noqa: BLE001 - 诊断脚本，DB 不可用时降级
        return sorted(out)
    try:
        with SessionLocal() as db:
            rows = db.execute(
                select(CrmProposalVersion.raw_r2_key, CrmProposalVersion.adapted_r2_key)
            ).all()
        for raw_key, adapted_key in rows:
            for key in (raw_key, adapted_key):
                if key and any(key.startswith(p) for p in prefixes):
                    out.add(key)
    except Exception:  # noqa: BLE001 - 诊断脚本，DB 不可用时降级
        return sorted(out)
    return sorted(out)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="排查 R2 自定义域名上的 Cloudflare 边缘缓存残留（BLF-1418）",
    )
    parser.add_argument(
        "--prefix",
        action="append",
        default=None,
        help=f"要检查的 key 前缀（可重复）。默认全部敏感前缀: {sorted(PRIVATE_KEY_PREFIXES)}",
    )
    parser.add_argument(
        "--key",
        action="append",
        default=None,
        help=(
            "要额外检查的 R2 key（可重复）。用于检查**已从 origin 删除**、"
            "但可能仍被边缘缓存的对象（如已删的备份）。"
            "不接受这个参数时，脚本无法发现 origin 已删的对象 → 会输出假阴性。"
        ),
    )
    parser.add_argument(
        "--url",
        action="append",
        default=None,
        help="要额外检查的完整 URL（可重复）。优先于 --key。",
    )
    args = parser.parse_args()

    settings = get_settings()
    base = settings.r2_public_url or (
        f"{settings.r2_endpoint_url}/{settings.r2_bucket_name}"
    )
    client = _client(settings)
    prefixes = args.prefix or [f"{p}/" for p in sorted(PRIVATE_KEY_PREFIXES)]

    print("=" * 72)
    print("BLF-1418 · R2 边缘缓存残留检查")
    print("=" * 72)
    print(f"公开桶  : {settings.r2_bucket_name}")
    print(f"公开域名: {base}")
    print()

    need_purge: list[str] = []
    # origin 已删但边缘可能仍缓存的 key，三个来源合并：
    #   (A) DB 历史（客户方案的 raw/adapted key）
    #   (B) --key 显式清单（已删的备份等 DB 里没有的）
    #   (C) --url 显式清单（完整 URL）
    db_keys = _keys_from_db(prefixes)
    explicit_keys = list(args.key or [])
    explicit_urls = list(args.url or [])
    if db_keys:
        print(f"[DB] 从 crm_proposal_versions 推导到 {len(db_keys)} 个历史 key")
    if explicit_keys:
        print(f"[--key] 额外指定 {len(explicit_keys)} 个 key")
    if explicit_urls:
        print(f"[--url] 额外指定 {len(explicit_urls)} 个 URL")
    print()

    def _probe_and_report(url: str) -> None:
        head_code, _ = _probe(url, "HEAD")
        get_code, get_hdr = _probe(url, "GET")
        cache = get_hdr.get("cf-cache-status", "?")
        age = get_hdr.get("age", "-")
        flag = ""
        if head_code in (403, 404) and get_code == 200:
            flag = "  ← ⚠️ 边缘缓存残留，必须 purge"
            need_purge.append(url)
        elif cache == "HIT":
            flag = "  ← 边缘已缓存（origin 仍在，删 origin 后会残留）"
            need_purge.append(url)
        print(f"  HEAD={head_code} GET={get_code} cache={cache} age={age}\n    {url}{flag}")

    seen_urls: set[str] = set()
    for prefix in prefixes:
        origin_keys = _list(client, settings.r2_bucket_name, prefix)
        # origin 里已删、但边缘可能仍缓存的历史 key（origin 删了不代表边缘没了）
        known = [k for k in db_keys if k.startswith(prefix)]
        keys = sorted(set(origin_keys) | set(known))
        print(
            f"[{prefix}] 待检查 {len(keys)} 个 URL"
            f"（origin 现有 {len(origin_keys)} 个，DB 历史 {len(known)} 个）"
        )
        for key in keys:
            url = f"{base}/{key}"
            seen_urls.add(url)
            _probe_and_report(url)
        print()

    # 显式指定的 key / URL（可能是任意前缀，如已删的备份）
    extra: list[str] = []
    for key in explicit_keys:
        extra.append(key if key.startswith("http") else f"{base}/{key}")
    extra.extend(explicit_urls)
    if extra:
        print("[显式指定]")
        for url in extra:
            if url in seen_urls:
                continue
            seen_urls.add(url)
            _probe_and_report(url)
        print()

    print("=" * 72)
    if need_purge:
        print("需要 Cloudflare 边缘 purge 的 URL：")
        for url in need_purge:
            print(f"  {url}")
        print()
        print("执行方式（需 Cloudflare API token，Zone → Caching → Cache Purge → Purge by URL）：")
        print("  Dashboard: https://dash.cloudflare.com/<zone>/believeboy.com/caching/cache-purge")
        print("  API      : POST https://api.cloudflare.com/client/v4/zones/<zone_id>/purge_cache")
        print('             {"files": ["<上面的 URL>"]}')
    else:
        print("✅ 没有检测到边缘缓存残留。")
    print("=" * 72)
    return 0


if __name__ == "__main__":
    sys.exit(main())
