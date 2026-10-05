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
_r2_client: boto3.client | None = None


def get_r2_client(settings: Settings) -> boto3.client:
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

    # Get file size before upload
    current_pos = file_data.tell()
    file_data.seek(0, 2)  # Seek to end
    size = file_data.tell()
    file_data.seek(current_pos)  # Reset to original position

    # Upload
    client.upload_fileobj(
        file_data,
        settings.r2_bucket_name,
        key,
        ExtraArgs={
            'ContentType': content_type,
        },
    )

    # Generate public URL using custom domain if configured, otherwise R2 endpoint
    base = settings.r2_public_url or f"{settings.r2_endpoint_url}/{settings.r2_bucket_name}"
    # URL-encode the key for the public URL (preserves Unicode by percent-encoding)
    public_url = f"{base}/{quote(key, safe='/')}"

    return {
        'key': key,
        'url': public_url,
        'bucket': settings.r2_bucket_name,
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
    try:
        client.delete_object(Bucket=settings.r2_bucket_name, Key=key)
        return R2DeleteResult(success=True, key=key)
    except (ClientError, BotoCoreError, OSError) as exc:
        if log_failure:
            logger.warning(
                "[r2] delete failed key=%s err=%s",
                key,
                exc.__class__.__name__,
                exc_info=True,
            )
        return R2DeleteResult(
            success=False,
            key=key,
            error_class=exc.__class__.__name__,
            error_message=str(exc),
        )


def get_file_url(settings: Settings, key: str) -> str:
    """Get the public URL for a file in R2."""
    base = settings.r2_public_url or f"{settings.r2_endpoint_url}/{settings.r2_bucket_name}"
    return f"{base}/{quote(key, safe='/')}"


def generate_presigned_url(
    settings: Settings,
    key: str,
    expires_in: int = 3600,
) -> str:
    """Generate a presigned URL for private files."""
    client = get_r2_client(settings)
    return client.generate_presigned_url(
        'get_object',
        Params={
            'Bucket': settings.r2_bucket_name,
            'Key': key,
        },
        ExpiresIn=expires_in,
    )


def check_file_exists(settings: Settings, key: str) -> bool:
    """Check if a file exists in R2."""
    client = get_r2_client(settings)
    try:
        client.head_object(
            Bucket=settings.r2_bucket_name,
            Key=key,
        )
        return True
    except ClientError:
        return False


def download_file_to_path(settings: Settings, key: str, dest_path: Path) -> bool:
    """Download a file from R2 to a local path."""
    client = get_r2_client(settings)
    try:
        client.download_file(
            settings.r2_bucket_name,
            key,
            str(dest_path),
        )
        return True
    except ClientError:
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
    """
    client = get_r2_client(settings)
    response = client.get_object(Bucket=settings.r2_bucket_name, Key=key)
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
