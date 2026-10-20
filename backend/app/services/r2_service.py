"""R2 Cloudflare Storage Service

Provides S3-compatible storage using Cloudflare R2.
"""

from __future__ import annotations

import io
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Iterator
from urllib.parse import quote

import boto3
from botocore.client import BaseClient
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

from app.core.config import Settings

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class R2DeleteResult:
    """R2 删除的结构化结果。

    - success=True:对象在 R2 上不存在或被删除。
    - success=False:调用 R2 失败,error_class / error_message 给出原因。
      调用方应把这类结果写入 r2_delete_failures 表等下次重试。

    永不抛错（即使网络挂 / bucket 不可达也只返回 success=False），
    这样可以被 ORM after_commit hook 安全调用。
    """
    success: bool
    key: str
    error_class: str | None = None
    error_message: str | None = None


# Singleton client
# 类型用 botocore.client.BaseClient：``boto3.client`` 是工厂**函数**而非类，
# 不能用作类型注解（boto3.client() 的返回值实际是 BaseClient 子类）。
_r2_client: BaseClient | None = None


def get_r2_client(settings: Settings) -> BaseClient:
    """Get or create R2 S3 client."""
    global _r2_client
    if _r2_client is None:
        _r2_client = boto3.client(
            's3',
            endpoint_url=settings.r2_endpoint_url,
            aws_access_key_id=settings.r2_access_key_id,
            aws_secret_access_key=settings.r2_secret_access_key,
            region_name=settings.r2_region or 'auto',
            config=Config(signature_version='s3v4'),
        )
    return _r2_client


# ---------------------------------------------------------------------------
# 桶选择（BLF-1418）
# ---------------------------------------------------------------------------
#
# ``settings.r2_bucket_name`` 挂在 Cloudflare R2 自定义域名
# ``bucket.believeboy.com`` 上，**整个桶公开可读**；``settings.r2_private_bucket_name``
# 是不挂域名的私有桶，匿名不可读。二者用同一套 S3 凭据访问（同一 R2 账户），
# 所以**只换桶名**就能把对象从「任何人可下载」挪到「只有持凭据的后端能读」。

#: 私有桶里存放敏感对象的 key 前缀（第一段）。
#: 这些前缀下的对象**绝不能**生成公开 URL —— 只能经后端鉴权转发。
#:
#: - ``crm-proposals``：客户方案，含报价与客户信息（key 可枚举）。
#: - ``db-backups``：数据库备份，含用户账号 / 密码哈希 / 业务全量数据
#:   （key 同样可枚举，且支持 Range 分片下载）。
#: - ``var``：pgBackRest 写的备份 / WAL 仓库。pgBackRest 用 S3 repo 时，
#:   key = ``<repo1-path 去开头斜杠>/<stanza>/...``，而
#:   ``repo1-path=/var/lib/pgbackrest/backups`` ⇒ key 以 ``var/`` 开头
#:   （**不是** ``backups/`` —— 那是本地路径的末两段，容易看错）。
#:   纵深防御：pgBackRest 走自己的 ``repo1-s3-*`` 配置、不经应用层的
#:   ``resolve_bucket()`` 路由，所以这条前缀管不到它；但若将来有任何代码把
#:   备份写进应用层 key 空间，这一条能确保它仍被判为敏感、不被拼成公开 URL。
PRIVATE_KEY_PREFIXES: frozenset[str] = frozenset(
    {"crm-proposals", "db-backups", "var"}
)


def resolve_bucket(settings: Settings, key: str) -> str:
    """按 key 决定目标桶：敏感前缀 → 私有桶，其余 → 公开桶。

    私有桶未配置时（``r2_private_bucket_isolated`` 为 False）回落到公开桶，
    行为与 BLF-1418 之前一致 —— 调用方（见 ``is_private_key``）负责拒绝
    「静默降级为公开」，本函数只负责路由。
    """
    if not settings.r2_private_bucket_isolated:
        return settings.r2_bucket_name
    if is_private_key(key):
        return settings.r2_private_bucket_resolved
    return settings.r2_bucket_name


def bucket_candidates(settings: Settings, key: str) -> list[str]:
    """读取时依次尝试的桶（私有桶优先，公开桶兜底）。

    为什么需要兜底：BLF-1418 的迁移分两步——先把对象**复制**到私有桶，
    再删公开桶里的副本。若在「已复制、未删源」的窗口期内，私有桶优先就能
    直接命中新副本；万一某次迁移漏了对象，回落到公开桶仍能读到旧数据，
    不会因为「桶换了」而 404（客户方案是交付物，读不到等于丢单）。
    """
    primary = resolve_bucket(settings, key)
    if not settings.r2_private_bucket_isolated:
        return [primary]
    other = (
        settings.r2_bucket_name
        if primary == settings.r2_private_bucket_resolved
        else settings.r2_private_bucket_resolved
    )
    return [primary, other]


def delete_bucket_candidates(settings: Settings, key: str) -> list[str]:
    """删除时需要清理的桶。

    **只对敏感 key** 清两个桶（私有桶 + 公开桶的迁移旧副本）。
    非敏感 key 只会存在公开桶里（私有桶根本没有它的对象），多删一次只是
    白跑一个 API 调用，没必要。

    为什么敏感 key 必须双桶删除：BLF-1418 的迁移窗口期内，公开桶里还留着
    同一 key 的副本。若此时删方案 → DB 行删了、私有副本删了，**公开桶副本
    还在**；而迁移脚本 ``--delete`` 的安全阀（私有桶无此对象 → 拒绝删源）
    此后永远不会再删它 → 变成永久公开可下载的孤儿。
    """
    if not is_private_key(key):
        return [resolve_bucket(settings, key)]
    if not settings.r2_private_bucket_isolated:
        # 未隔离时（回滚后清掉了私有桶名）也要把私有桶列进来。
        # 否则删方案只删公开桶那份，私有桶里的原件留着 —— 而它没被登记死信
        # （公开桶那次删除成功了），孤立文件清理脚本又只扫公开桶
        # → 私有桶里的副本变成谁也找不到的孤儿。
        # 私有桶名已知就用它；连名字都没了（配置被彻底清空）就只能清公开桶。
        private_name = settings.r2_private_bucket_name.strip()
        if not private_name or private_name == settings.r2_bucket_name:
            return [settings.r2_bucket_name]
        return [settings.r2_bucket_name, private_name]
    return bucket_candidates(settings, key)


def is_private_key(key: str) -> bool:
    """True = 该 key 属于「绝不能公开」的对象（按第一段前缀判定）。

    前导斜杠容错：``/crm-proposals/1/v1/raw.html`` 也算敏感 ——
    否则一个多写的前导 ``/`` 就能让敏感 key 绕开私有桶路由（落到公开桶）。
    """
    if not key:
        return False
    return key.lstrip("/").split("/", 1)[0] in PRIVATE_KEY_PREFIXES


def _sanitize_key(key: str) -> str:
    """Sanitize S3 key to be safe and predictable.

    S3 keys support Unicode characters (including Chinese).
    We only remove control characters and normalize whitespace.
    """
    import re
    # Remove control characters (0x00-0x1f and 0x7f)
    key = re.sub(r'[\x00-\x1f\x7f]', '', key)
    # Normalize whitespace to single spaces
    key = re.sub(r'\s+', ' ', key)
    # Strip leading/trailing whitespace
    key = key.strip()
    return key


def upload_file_to_r2(
    settings: Settings,
    file_data: BinaryIO,
    filename: str,
    project_slug: str,
    file_type: str,
    content_type: str = 'application/octet-stream',
) -> dict:
    """
    Upload a file to R2 storage.

    Returns:
        dict with keys: key, url, bucket, size
    """
    client = get_r2_client(settings)

    # Build key: {project_slug}/{file_type}/{filename}
    key = f"{_sanitize_key(project_slug)}/{_sanitize_key(file_type)}/{_sanitize_key(filename)}"

    # 敏感对象（私有前缀）**绝不写入公开桶**（BLF-1418）。
    # 必须在写入**之前**判定：否则「先写进公开桶、再报错」等于已经泄露。
    # fail-closed：私有桶未配置 → 拒绝写入，而不是静默降级成公开。
    private = is_private_key(key)
    if private and not settings.r2_private_bucket_isolated:
        raise RuntimeError(
            "BLF-1418: 敏感对象不允许写入公开桶 "
            f"(key={key})。请配置 R2_PRIVATE_BUCKET_NAME 指向一个不挂自定义域名的私有桶。"
        )

    # Get file size before upload
    current_pos = file_data.tell()
    file_data.seek(0, 2)  # Seek to end
    size = file_data.tell()
    file_data.seek(current_pos)  # Reset to original position

    # Upload
    bucket = resolve_bucket(settings, key)
    client.upload_fileobj(
        file_data,
        bucket,
        key,
        ExtraArgs={
            'ContentType': content_type,
        },
    )

    if private:
        # 已隔离到私有桶：私有桶没有公开基址，且这类对象只能经后端鉴权转发，
        # 因此**不生成公开 URL**（生成它等于把「不可下载」变成「可下载」）。
        public_url = ''
    else:
        # Generate public URL using custom domain if configured, otherwise R2 endpoint
        base = settings.r2_public_url or f"{settings.r2_endpoint_url}/{settings.r2_bucket_name}"
        # URL-encode the key for the public URL (preserves Unicode by percent-encoding)
        public_url = f"{base}/{quote(key, safe='/')}"

    return {
        'key': key,
        'url': public_url,
        'bucket': bucket,
        'size': size,
    }


def upload_bytes_to_r2(
    settings: Settings,
    data: bytes,
    filename: str,
    project_slug: str,
    file_type: str,
    content_type: str = 'application/octet-stream',
) -> dict:
    """Upload bytes data to R2."""
    return upload_file_to_r2(
        settings,
        io.BytesIO(data),
        filename,
        project_slug,
        file_type,
        content_type,
    )


def delete_file_from_r2(
    settings: Settings,
    key: str,
    *,
    log_failure: bool = True,
) -> bool:
    """Delete a single object from R2. Returns True on success, False on failure.

    行为约定：
    - key 为空字符串 / None：视为 nothing-to-do，返回 True。
    - 捕获 ClientError（4xx）+ BotoCoreError + OSError（网络/超时）。
    - 永不抛错。True/False 都可被业务代码当 bool 用。

    如需详细错误信息（用于写入死信表），请用 try_delete_file_from_r2()。
    """
    return try_delete_file_from_r2(settings, key, log_failure=log_failure).success


def try_delete_file_from_r2(
    settings: Settings,
    key: str,
    *,
    log_failure: bool = True,
) -> R2DeleteResult:
    """Delete a single object from R2. Returns R2DeleteResult with success / error_class.

    行为约定：
    - key 为空字符串 / None：返回 success=True（避免向上抛错）。
    - 捕获 ClientError（4xx）+ BotoCoreError + OSError。
    - 永不抛错。P1 / P2 阶段应使用本接口，以拿到结构化失败原因写入死信表。
    """
    if not key:
        return R2DeleteResult(success=True, key=key or "")

    client = get_r2_client(settings)
    # BLF-1418：敏感 key 要把**两个桶**都删（私有桶 + 公开桶的旧副本）。
    # 只删 resolve_bucket()（私有桶）会漏掉公开副本：迁移窗口期内删方案 →
    # DB 行删了、私有副本删了、**公开桶副本还在**，而迁移脚本 --delete 的
    # 安全阀（私有桶无此对象 → 拒绝删源）此后永远不会再删它 →
    # 变成永久公开可下载的孤儿。
    # S3 删不存在的 key 返 204，天然幂等。
    buckets = delete_bucket_candidates(settings, key)
    last_error: Exception | None = None
    for bucket in buckets:
        try:
            client.delete_object(Bucket=bucket, Key=key)
        except (ClientError, BotoCoreError, OSError) as exc:
            last_error = exc
            if log_failure:
                logger.warning(
                    "[r2] delete failed key=%s bucket=%s err=%s",
                    key,
                    bucket,
                    exc.__class__.__name__,
                    exc_info=True,
                )
    if last_error is not None:
        return R2DeleteResult(
            success=False,
            key=key,
            error_class=last_error.__class__.__name__,
            error_message=str(last_error),
        )
    return R2DeleteResult(success=True, key=key)


def get_file_url(settings: Settings, key: str) -> str:
    """Get the public URL for a file in R2.

    BLF-1418：敏感前缀（私有桶）**不返回公开 URL**（返回空串）——
    公开读的自定义域名只覆盖公开桶，把私有对象的 key 拼成公开 URL 等于
    让任何人可下载。私有对象请用 ``generate_presigned_url()`` 或后端流式转发。
    """
    if is_private_key(key):
        return ""
    base = settings.r2_public_url or f"{settings.r2_endpoint_url}/{settings.r2_bucket_name}"
    return f"{base}/{quote(key, safe='/')}"


def generate_presigned_url(
    settings: Settings,
    key: str,
    expires_in: int = 3600,
) -> str:
    """Generate a presigned URL for private files.

    BLF-1418：桶名按 key 路由（敏感前缀 → 私有桶），因此对私有对象签发的
    预签名 URL 指向私有桶，匿名 + 无签名一律取不到。
    """
    client = get_r2_client(settings)
    return client.generate_presigned_url(
        'get_object',
        Params={
            'Bucket': resolve_bucket(settings, key),
            'Key': key,
        },
        ExpiresIn=expires_in,
    )


def check_file_exists(settings: Settings, key: str) -> bool:
    """Check if a file exists in R2.

    私有桶优先、公开桶兜底（见 ``bucket_candidates``）—— 迁移窗口期内
    对象可能还在旧桶里，不应因为换桶而误报「不存在」。
    """
    client = get_r2_client(settings)
    for bucket in bucket_candidates(settings, key):
        try:
            client.head_object(Bucket=bucket, Key=key)
            return True
        except ClientError:
            continue
    return False


def download_file_to_path(settings: Settings, key: str, dest_path: Path) -> bool:
    """Download a file from R2 to a local path（私有桶优先，公开桶兜底）。"""
    client = get_r2_client(settings)
    for bucket in bucket_candidates(settings, key):
        try:
            client.download_file(bucket, key, str(dest_path))
            return True
        except ClientError:
            continue
    return False


def extract_key_from_url(url: str, settings: Settings | None = None) -> str | None:
    """
    Extract R2 key from a public URL.

    Supports formats:
    - https://cdn.example.com/bucket/key
    - https://bucket.r2.cloudflarestorage.com/bucket/key
    - /bucket/key (relative)

    Note: 此函数保留在 r2_service 中以保持向后兼容。
    新代码应使用 ArtifactService.extract_key_from_url()。
    """
    from app.services.artifact_service import ArtifactService

    return ArtifactService.extract_key_from_url(url, settings)

def iter_file_from_r2(
    settings: Settings,
    key: str,
    chunk_size: int = 1024 * 1024,
) -> Iterator[bytes]:
    """Stream an object from R2 chunk by chunk (BLF-1237).

    项目启动台节点附件的下载走服务端流式：每一次请求都必须过一遍鉴权与项目权限，
    所以不能返回 presigned URL（签发后 TTL 内免鉴权）。``download_to_temp`` +
    ``FileResponse`` 也不行——临时文件在响应真正流式读取之前就被删掉了。

    生成器结束时（含客户端中断）关闭 boto3 StreamingBody，避免连接泄漏。

    BLF-1418：私有桶优先、公开桶兜底（见 ``bucket_candidates``）。
    """
    client = get_r2_client(settings)
    response = None
    last_error: Exception | None = None
    for bucket in bucket_candidates(settings, key):
        try:
            response = client.get_object(Bucket=bucket, Key=key)
            break
        except ClientError as exc:
            last_error = exc
            continue
    if response is None:
        raise (
            last_error
            if last_error is not None
            else ClientError(
                {"Error": {"Code": "NoSuchKey", "Message": key}},
                "GetObject",
            )
        )
    body = response['Body']
    try:
        while True:
            chunk = body.read(chunk_size)
            if not chunk:
                break
            yield chunk
    finally:
        close = getattr(body, 'close', None)
        if callable(close):
            close()
