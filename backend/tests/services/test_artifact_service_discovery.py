"""Unit tests for P0.1: ArtifactService auto-discovery of R2 key columns.

Coverage:
- discover_r2_key_columns returns sorted unique pairs for *_r2_key suffixed columns
- all_r2_key_columns merges: discover + REGISTERED_R2_FIELDS + _IRREGULAR_KEY_COLUMNS
- irregular column names (InspectionScreenshot.r2_key / thumbnail_key, etc.) included
- extract_image_r2_keys helper handles dict list of note_images
- nothing matches non-R2 columns (e.g. avatar_url, *_r2_url) — _url ones excluded

Each test is hermetic (no DB / network).
"""
from __future__ import annotations

from app.services.artifact_service import ArtifactService

# ---------------------------------------------------------------------------
# discover_r2_key_columns (auto)
# ---------------------------------------------------------------------------

def test_discover_returns_sorted_unique_pairs():
    cols = ArtifactService.discover_r2_key_columns()
    assert isinstance(cols, list)
    assert len(cols) > 0
    assert cols == sorted(set(cols)), "discover must be sorted and unique"


def test_discover_finds_all_r2_key_suffix_columns():
    """Every model column ending with _r2_key must be in the result."""
    cols = ArtifactService.discover_r2_key_columns()
    # Hand-curated list (matches the auto-discovered set in this codebase).
    expected = {
        ("AnalysisPT1Calculation", "result_r2_key"),
        ("MonthlyReport", "summary_pdf_r2_key"),
        ("PlatformRevenue", "screenshot_r2_key"),
        ("ScheduledReportDeliveryLog", "screenshot_r2_key"),
        ("SkuRecord", "fnsku_label_r2_key"),
        ("SkuRecord", "product_image_r2_key"),
        ("SkuRecord", "product_image_thumbnail_r2_key"),
    }
    actual = set(cols)
    assert expected.issubset(actual), (
        f"missing from auto-discover: {expected - actual}"
    )


# ---------------------------------------------------------------------------
# all_r2_key_columns (merged)
# ---------------------------------------------------------------------------

def test_all_r2_key_columns_includes_irregular_names():
    """InspectionScreenshot uses 'r2_key' / 'thumbnail_key' — must be in merged list."""
    cols = ArtifactService.all_r2_key_columns()
    assert ("InspectionScreenshot", "r2_key") in cols
    assert ("InspectionScreenshot", "thumbnail_key") in cols


def test_all_r2_key_columns_includes_thumb_key():
    """ScheduledReportDeliveryLog has 'screenshot_r2_thumb_key' — must be in list."""
    cols = ArtifactService.all_r2_key_columns()
    assert ("ScheduledReportDeliveryLog", "screenshot_r2_thumb_key") in cols


def test_all_r2_key_columns_excludes_url_columns():
    """*_r2_url columns are URLs (not keys) — must NOT be in registry."""
    cols = ArtifactService.all_r2_key_columns()
    for model, col in cols:
        assert not col.endswith("_url"), (
            f"{model}.{col} is a URL, not a key — should not be in registry"
        )


def test_all_r2_key_columns_count_is_correct():
    """After P2 + 客户方案（283），expect exactly 14 columns."""
    cols = ArtifactService.all_r2_key_columns()
    # Hand-curated exhaustive list:
    expected = [
        ("AnalysisPT1Calculation", "result_r2_key"),
        # 客户方案版本（283）：raw 原始上传 + adapted 注入主题，两份均存 R2
        ("CrmProposalVersion", "adapted_r2_key"),
        ("CrmProposalVersion", "raw_r2_key"),
        ("InspectionScreenshot", "r2_key"),
        ("InspectionScreenshot", "thumbnail_key"),
        ("MonthlyReport", "summary_pdf_r2_key"),
        ("PlatformRevenue", "screenshot_r2_key"),
        # P2 项目启动台节点附件（列名就叫 r2_key，必须显式登记，否则被当孤儿文件删掉）
        ("ProjectWorkflowTaskAttachment", "r2_key"),
        ("ScheduledReportDeliveryLog", "screenshot_r2_key"),
        ("ScheduledReportDeliveryLog", "screenshot_r2_thumb_key"),
        ("SkuRecord", "fnsku_label_r2_key"),
        ("SkuRecord", "product_image_r2_key"),
        ("SkuRecord", "product_image_thumbnail_r2_key"),
        ("WorkflowTemplateTaskAttachment", "r2_key"),
    ]
    assert cols == sorted(expected)


# ---------------------------------------------------------------------------
# extract_image_r2_keys (JSON embedded keys helper)
# ---------------------------------------------------------------------------

def test_extract_image_r2_keys_basic():
    images = [
        {"id": "a", "r2_key": "k1", "thumbnail_key": "t1"},
        {"id": "b", "r2_key": "k2", "thumbnail_key": "t2"},
    ]
    out = ArtifactService.extract_image_r2_keys(images)
    assert out == {"k1", "t1", "k2", "t2"}


def test_extract_image_r2_keys_skips_missing_fields():
    images = [
        {"id": "a", "r2_key": "k1"},          # no thumbnail
        {"id": "b", "thumbnail_key": "t2"},    # no r2_key
        {"id": "c"},                            # neither
    ]
    out = ArtifactService.extract_image_r2_keys(images)
    assert out == {"k1", "t2"}


def test_extract_image_r2_keys_none_safe():
    assert ArtifactService.extract_image_r2_keys(None) == set()
    assert ArtifactService.extract_image_r2_keys([]) == set()


def test_extract_image_r2_keys_skips_non_dict():
    images = [
        {"r2_key": "k1"},
        "not-a-dict",
        None,
        42,
        {"r2_key": "k2"},
    ]
    out = ArtifactService.extract_image_r2_keys(images)  # type: ignore[list-item]
    assert out == {"k1", "k2"}


def test_extract_image_r2_keys_skips_empty_strings():
    images = [
        {"r2_key": "", "thumbnail_key": "t1"},
        {"r2_key": "k2", "thumbnail_key": None},
        {"r2_key": "   ", "thumbnail_key": "t3"},
    ]
    out = ArtifactService.extract_image_r2_keys(images)
    # Empty string and whitespace-only are treated as missing.
    assert out == {"t1", "k2", "t3"}
