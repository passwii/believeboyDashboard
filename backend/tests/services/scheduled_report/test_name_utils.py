"""Tests for app.services.scheduled_report._name_utils.

Multi-project subscriptions concatenate project names like
``"店铺A, 店铺B, 店铺C, ..."``. These helpers cap the resulting email
subject segment and attachment filename segment to length-safe values.
"""
from __future__ import annotations

from app.services.scheduled_report._name_utils import (
    FILENAME_MAX_LEN,
    SUBJECT_MAX_LEN,
    sanitize_filename_segment,
    truncate_project_name_for_subject,
)


# ---------------------------------------------------------------------------
# truncate_project_name_for_subject
# ---------------------------------------------------------------------------


def test_truncate_short_unchanged():
    assert truncate_project_name_for_subject("店铺A") == "店铺A"


def test_truncate_exact_boundary_unchanged():
    name = "A" * SUBJECT_MAX_LEN
    assert truncate_project_name_for_subject(name) == name


def test_truncate_over_limit_gets_ellipsis():
    name = "店铺" * 50  # 100 字符
    out = truncate_project_name_for_subject(name)
    assert len(out) == SUBJECT_MAX_LEN
    assert out.endswith("…")


def test_truncate_chinese_stays_under_limit():
    name = "中" * 200
    out = truncate_project_name_for_subject(name)
    assert len(out) == SUBJECT_MAX_LEN
    assert out.endswith("…")


def test_truncate_realistic_25_projects():
    """25 个项目名（各 12 字符）合计 ~325 字符，应被截断。"""
    name = ", ".join(f"店铺-{i:02d}" for i in range(25))
    assert len(name) > SUBJECT_MAX_LEN
    out = truncate_project_name_for_subject(name)
    assert len(out) == SUBJECT_MAX_LEN
    assert out.endswith("…")


# ---------------------------------------------------------------------------
# sanitize_filename_segment
# ---------------------------------------------------------------------------


def test_sanitize_short_unchanged():
    assert sanitize_filename_segment("店铺A") == "店铺A"


def test_sanitize_replaces_windows_bad_chars():
    assert sanitize_filename_segment("foo/bar\\baz:qux") == "foo_bar_baz_qux"
    assert sanitize_filename_segment('a*b?c"d<e>f|g') == "a_b_c_d_e_f_g"


def test_sanitize_replaces_control_chars():
    """控制字符与其它非法字符一样，被替换为 _。"""
    assert sanitize_filename_segment("foo\r\n\tbar") == "foo___bar"


def test_sanitize_strips_leading_trailing_whitespace():
    assert sanitize_filename_segment("  店铺A  ") == "店铺A"


def test_sanitize_over_limit_gets_ellipsis():
    name = "A" * (FILENAME_MAX_LEN + 10)
    out = sanitize_filename_segment(name)
    assert len(out) == FILENAME_MAX_LEN
    assert out.endswith("…")


def test_sanitize_realistic_combined():
    """模拟 daily 邮件附件名中的 project_name 段：含逗号 + 大量字符。"""
    name = ", ".join(f"Store-{i}" for i in range(30))
    out = sanitize_filename_segment(name)
    # 逗号是合法字符，保留
    assert "," in out
    assert len(out) <= FILENAME_MAX_LEN


def test_sanitize_realistic_with_bad_chars():
    """项目名真的带 ``/``（不应该出现但万一）：应被替换。"""
    out = sanitize_filename_segment("店铺/A, 店铺/B")
    assert "/" not in out
    assert out == "店铺_A, 店铺_B"