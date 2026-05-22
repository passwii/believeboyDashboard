"""R2 key builder for product analysis results.

Provides utility functions for building consistent R2 keys
following the project-based path structure.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from app.services.artifact_service import ArtifactService


@dataclass
class ProductAnalysisR2Key:
    """Represents an R2 key for product analysis storage."""

    project_slug: str
    report_type: str  # e.g., "product-analysis"
    task_id: int
    filename: str

    @property
    def key(self) -> str:
        """Full R2 key path."""
        return f"{self.project_slug}/{self.report_type}/{self.task_id}/{self.filename}"

    @property
    def folder(self) -> str:
        """Folder path without filename."""
        return f"{self.project_slug}/{self.report_type}/{self.task_id}"


def build_product_analysis_result_key(
    project_name: str,
    task_id: int,
    filename: str,
) -> ProductAnalysisR2Key:
    """
    Build R2 key for product analysis result file.

    Args:
        project_name: Project name (will be sanitized for key)
        task_id: Task/Job ID
        filename: Result filename (e.g., "result.xlsx")

    Returns:
        ProductAnalysisR2Key with key, folder, and component properties

    Example:
        >>> key = build_product_analysis_result_key("我的项目", 123, "result.xlsx")
        >>> key.key
        '我的项目/product-analysis/123/result.xlsx'
        >>> key.folder
        '我的项目/product-analysis/123'
    """
    # Sanitize project name for R2 key
    project_slug = ArtifactService.sanitize_key(project_name)

    return ProductAnalysisR2Key(
        project_slug=project_slug,
        report_type="product-analysis",
        task_id=task_id,
        filename=filename,
    )


def upload_product_analysis_result(
    result_content: bytes,
    project_name: str,
    task_id: int,
    filename: str = "result.xlsx",
    settings=None,
) -> dict:
    """
    Upload product analysis result to R2.

    Args:
        result_content: File content as bytes
        project_name: Project name
        task_id: Task/Job ID
        filename: Result filename
        settings: Optional Settings instance

    Returns:
        dict with key, url, bucket, size
    """
    import io

    r2_key = build_product_analysis_result_key(project_name, task_id, filename)
    file_data = io.BytesIO(result_content)

    return ArtifactService.upload(
        file_data=file_data,
        filename=filename,
        project_slug=r2_key.project_slug,
        file_type=f"product-analysis/{task_id}",
        content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        settings=settings,
    )


def get_result_r2_url(
    project_name: str,
    task_id: int,
    filename: str = "result.xlsx",
) -> str:
    """
    Get public URL for product analysis result file.

    Args:
        project_name: Project name
        task_id: Task/Job ID
        filename: Result filename

    Returns:
        Public R2 URL
    """
    r2_key = build_product_analysis_result_key(project_name, task_id, filename)
    return ArtifactService.build_public_url(r2_key.key)


def resolve_result_path(
    result_path: str | None = None,
    result_r2_key: str | None = None,
    result_r2_url: str | None = None,
) -> Path | None:
    """
    Resolve result file path from various sources.

    Priority:
    1. Local path (if exists)
    2. R2 key (download to temp)
    3. R2 URL (download to temp)

    Args:
        result_path: Local file path
        result_r2_key: R2 object key
        result_r2_url: R2 public URL

    Returns:
        Path object if file exists, None otherwise
    """
    # Try local path first
    if result_path:
        path = Path(result_path)
        if path.exists():
            return path

    # Try R2 key
    if result_r2_key:
        try:
            with ArtifactService.download_to_temp(result_r2_key, suffix=".xlsx") as temp_path:
                return temp_path
        except FileNotFoundError:
            pass

    # Try R2 URL
    if result_r2_url:
        key = ArtifactService.extract_key_from_url(result_r2_url)
        if key:
            try:
                with ArtifactService.download_to_temp(key, suffix=".xlsx") as temp_path:
                    return temp_path
            except FileNotFoundError:
                pass

    return None