"""R2 Cloudflare Storage Service

Provides S3-compatible storage using Cloudflare R2.
"""

from __future__ import annotations

import io
from pathlib import Path
from typing import BinaryIO
from urllib.parse import quote

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from app.core.config import Settings


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


def delete_file_from_r2(settings: Settings, key: str) -> bool:
    """Delete a file from R2 storage."""
    client = get_r2_client(settings)
    try:
        client.delete_object(
            Bucket=settings.r2_bucket_name,
            Key=key,
        )
        return True
    except ClientError:
        return False


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
    """
    from app.core.config import get_settings

    if settings is None:
        settings = get_settings()

    # If it's already just a key (no slashes with bucket), return as-is
    if not url.startswith('http') and not url.startswith('/'):
        return url

    from urllib.parse import unquote

    extracted_key = None

    # Try to extract key based on known patterns
    # Pattern 1: Custom public URL
    if settings.r2_public_url and url.startswith(settings.r2_public_url):
        extracted_key = url[len(settings.r2_public_url):].lstrip('/')

    # Pattern 2: R2 endpoint with bucket
    if extracted_key is None and settings.r2_bucket_name:
        suffix = f"{settings.r2_bucket_name}/"
        if suffix in url:
            parts = url.split(suffix)
            if len(parts) == 2:
                extracted_key = parts[1]

    # Decode URL-encoded characters (e.g., %E9%93%A8%E5%AF%8C -> 魁宝)
    if extracted_key:
        return unquote(extracted_key)

    return None