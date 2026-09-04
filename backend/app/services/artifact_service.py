"""Artifact Service - 统一的云存储工件服务

提供 Cloudflare R2 存储的统一封装，确保：
- URL 构建逻辑一致（考虑自定义域名）
- 中文路径处理统一
- 临时文件自动清理
"""

from __future__ import annotations

import re
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import BinaryIO, Generator
from urllib.parse import quote, unquote, urlparse

from app.core.config import Settings, get_settings
from app.services.r2_service import (
    check_file_exists,
    delete_file_from_r2,
    download_file_to_path,
    get_r2_client,
    upload_file_to_r2,
)


class ArtifactService:
    """统一的云存储工件服务"""

    # 显式注册的 R2 key 字段（用于孤立文件追踪 & ORM hook）
    # 格式: (model_class_name, field_name)
    # 这些是 anchor，绝大部分 *_r2_key 列会自动发现（见 all_r2_key_columns()）
    REGISTERED_R2_FIELDS: list[tuple[str, str]] = [
        ("MonthlyReport", "summary_pdf_r2_key"),
        ("PlatformRevenue", "screenshot_r2_key"),
    ]

    # 不规则命名的 key 列（不以 _r2_key 结尾，需要白名单显式收纳）
    # 例如 InspectionScreenshot 直接叫 r2_key / thumbnail_key
    # 例如 ScheduledReportDeliveryLog 缩略图叫 screenshot_r2_thumb_key
    _IRREGULAR_KEY_COLUMNS: list[tuple[str, str]] = [
        ("InspectionScreenshot", "r2_key"),
        ("InspectionScreenshot", "thumbnail_key"),
        ("ScheduledReportDeliveryLog", "screenshot_r2_thumb_key"),
    ]

    @classmethod
    def discover_r2_key_columns(cls) -> list[tuple[str, str]]:
        """扫描所有 ORM model，返回所有以 _r2_key 结尾的列 (model_name, field_name)。

        自动发现的设计目的：新加 R2 列不用手动改注册表，只要命名符合约定就被纳入。
        返回的 key 是排序去重后的。

        注意：SQLAlchemy 2.0 的 Base.registry 只持有已被 import 的 mapper。
        所以此处显式 import app.models 以确保所有模型都已注册。
        """
        from app.db.session import Base  # noqa: F401
        import app.models  # noqa: F401  确保所有 model class 已被 import 过

        result: set[tuple[str, str]] = set()
        for mapper in Base.registry.mappers:
            cls_obj = mapper.class_
            for col in mapper.columns:
                if col.key.endswith("_r2_key"):
                    result.add((cls_obj.__name__, col.key))
        return sorted(result)

    @classmethod
    def all_r2_key_columns(cls) -> list[tuple[str, str]]:
        """返回所有需要被清理的 R2 key 列 = 自动发现 + 显式 anchor + 不规则命名白名单。

        用于：
        - cleanup_r2_orphaned_files.py 的引用集合
        - P2 阶段 r2_lifecycle.py 的 ORM hook
        """
        auto = cls.discover_r2_key_columns()
        merged = set(auto) | set(cls.REGISTERED_R2_FIELDS) | set(cls._IRREGULAR_KEY_COLUMNS)
        return sorted(merged)

    @classmethod
    def extract_image_r2_keys(cls, images: list | None) -> set[str]:
        """从 note_images 风格的 dict 列表里抽出所有 r2_key / thumbnail_key。

        用于 ORM hook 处理 JSON 内嵌 R2 key (e.g. exchange_rates.note_images)。
        返回 set[str]，key 顺序不保证。
        空字符串 / 全空白 / 非字符串被视为缺失。
        """
        result: set[str] = set()
        if not images:
            return result
        for img in images:
            if not isinstance(img, dict):
                continue
            for k in (img.get("r2_key"), img.get("thumbnail_key")):
                if isinstance(k, str):
                    k_stripped = k.strip()
                    if k_stripped:
                        result.add(k_stripped)
        return result

    @staticmethod
    def build_public_url(key: str) -> str:
        """
        构建 R2 公开访问 URL。

        优先使用 r2_public_url（自定义域名），否则使用 r2_endpoint_url/bucket_name。
        自动对 key 进行 URL 编码以保留中文等 Unicode 字符。

        Args:
            key: R2 对象 key

        Returns:
            公开访问 URL
        """
        settings = get_settings()
        base = settings.r2_public_url or f"{settings.r2_endpoint_url}/{settings.r2_bucket_name}"
        return f"{base}/{quote(key, safe='/')}"

    @staticmethod
    def extract_key_from_url(url: str, settings: Settings | None = None) -> str | None:
        """
        从 R2 URL 提取 key。

        支持的 URL 格式：
        - https://cdn.example.com/bucket/key
        - https://cdn.example.com/key (使用 r2_public_url 时)
        - https://bucket.r2.cloudflarestorage.com/bucket/key
        - /bucket/key (相对路径)

        Args:
            url: R2 公开 URL
            settings: 可选的 settings 实例

        Returns:
            提取的 key，或 None（如果无法解析）
        """
        if settings is None:
            settings = get_settings()

        # 如果已经只是 key（没有斜杠），直接返回
        if not url.startswith("http") and not url.startswith("/"):
            return url

        extracted_key: str | None = None

        # Pattern 1: r2_public_url（自定义域名）
        if settings.r2_public_url and url.startswith(settings.r2_public_url):
            extracted_key = url[len(settings.r2_public_url) :].lstrip("/")

        # Pattern 2: R2 endpoint with bucket
        if extracted_key is None and settings.r2_bucket_name:
            bucket_prefix = f"{settings.r2_bucket_name}/"
            if bucket_prefix in url:
                parts = url.split(bucket_prefix)
                if len(parts) == 2:
                    extracted_key = parts[1]

        # Pattern 3: 通过 urlparse 提取 path
        if extracted_key is None:
            parsed = urlparse(url)
            path = parsed.path
            if path.startswith("/"):
                path = path[1:]
            # 如果路径看起来像有效的 key（有斜杠或文件扩展名）
            if "/" in path or "." in path:
                extracted_key = path

        # 解码 URL 编码的字符（e.g. %E9%93%A8%E5%AF%8C -> 魁宝）
        if extracted_key:
            return unquote(extracted_key)

        return None

    @staticmethod
    def sanitize_key(key: str) -> str:
        """
        清理 S3 key 中的不安全字符。

        S3 key 支持 Unicode（包括中文），我们只移除控制字符。
        保留中文和其他 Unicode 字符进行 URL 编码。

        Args:
            key: 原始 key

        Returns:
            清理后的 key
        """
        # 移除控制字符 (0x00-0x1f and 0x7f)
        key = re.sub(r"[\x00-\x1f\x7f]", "", key)
        # 规范化空白字符为单个空格
        key = re.sub(r"\s+", " ", key)
        # 去除首尾空白
        return key.strip()

    @staticmethod
    def decode_key(key: str) -> str:
        """
        解码 URL 编码的 key。

        从 R2 下载时，存储的 key 是原始 Unicode，但 URL 中是编码的。
        此方法将编码的 key 解码为原始形式。

        Args:
            key: URL 编码的 key (e.g. %E9%93%A8%E5%AF%8C)

        Returns:
            解码后的 key (e.g. 魁宝)
        """
        return unquote(key)

    @staticmethod
    def encode_key(key: str) -> str:
        """
        对 key 进行 URL 编码。

        用于在 URL 中安全传输含中文的 key。

        Args:
            key: 原始 key (e.g. 魁宝)

        Returns:
            URL 编码后的 key (e.g. %E9%93%A8%E5%AF%8C)
        """
        return quote(key, safe="/")

    @staticmethod
    def check_exists(key: str, settings: Settings | None = None) -> bool:
        """检查 R2 中的文件是否存在"""
        if settings is None:
            settings = get_settings()
        return check_file_exists(settings, key)

    @staticmethod
    def delete(key: str, settings: Settings | None = None) -> bool:
        """从 R2 删除文件"""
        if settings is None:
            settings = get_settings()
        return delete_file_from_r2(settings, key)

    @staticmethod
    def download(key: str, dest_path: Path, settings: Settings | None = None) -> bool:
        """下载 R2 文件到指定路径"""
        if settings is None:
            settings = get_settings()
        return download_file_to_path(settings, key, dest_path)

    @staticmethod
    def upload(
        file_data: BinaryIO,
        filename: str,
        project_slug: str,
        file_type: str,
        content_type: str = "application/octet-stream",
        settings: Settings | None = None,
    ) -> dict:
        """
        上传文件到 R2。

        Args:
            file_data: 文件数据流
            filename: 文件名
            project_slug: 项目 slug（用于路径组织）
            file_type: 文件类型（用于路径组织）
            content_type: MIME 类型
            settings: 可选的 settings 实例

        Returns:
            包含 key, url, bucket, size 的字典
        """
        if settings is None:
            settings = get_settings()
        return upload_file_to_r2(
            settings, file_data, filename, project_slug, file_type, content_type
        )

    @staticmethod
    @contextmanager
    def download_to_temp(
        key: str, suffix: str = ".tmp", settings: Settings | None = None
    ) -> Generator[Path, None, None]:
        """
        下载 R2 文件到临时文件，退出时自动清理。

        使用 context manager 确保使用后自动删除临时文件：
            with ArtifactService.download_to_temp(key, ".pdf") as temp_path:
                # 使用 temp_path 处理 PDF
            # 临时文件自动删除

        Args:
            key: R2 对象 key
            suffix: 临时文件后缀（默认 .tmp）
            settings: 可选的 settings 实例

        Yields:
            临时文件路径

        Raises:
            FileNotFoundError: 下载失败时抛出
        """
        if settings is None:
            settings = get_settings()

        temp_file = tempfile.NamedTemporaryFile(suffix=suffix, delete=True)
        temp_path = Path(temp_file.name)
        temp_file.close()

        try:
            success = download_file_to_path(settings, key, temp_path)
            if not success:
                raise FileNotFoundError(f"Failed to download from R2: {key}")
            yield temp_path
        finally:
            temp_path.unlink(missing_ok=True)

    @staticmethod
    def resolve_path(url_or_key: str, settings: Settings | None = None) -> Path:
        """
        从 URL 或 key 解析本地文件路径。

        支持：
        - R2 URL（下载到临时文件）
        - 本地绝对路径
        - 相对路径（相对于 backend 目录）

        Args:
            url_or_key: R2 URL 或文件路径
            settings: 可选的 settings 实例

        Returns:
            本地文件路径

        Raises:
            FileNotFoundError: 文件不存在时抛出
        """
        if settings is None:
            settings = get_settings()

        # 如果是 URL，从 R2 下载
        if url_or_key.startswith("http"):
            key = ArtifactService.extract_key_from_url(url_or_key, settings)
            if key is None:
                raise ValueError(f"Cannot extract key from URL: {url_or_key}")
            # 使用 download_to_temp 自动清理
            with ArtifactService.download_to_temp(key, settings=settings) as temp_path:
                return temp_path

        # 本地文件路径
        path = Path(url_or_key)

        # 绝对路径且存在
        if path.is_absolute() and path.exists():
            return path

        # 相对于 backend 目录
        backend_dir = Path(__file__).resolve().parents[2]
        absolute_path = backend_dir / url_or_key
        if absolute_path.exists():
            return absolute_path

        raise FileNotFoundError(f"File not found: {url_or_key}")