"""客户方案 service 纯函数单测（无 DB / 无 R2）。

覆盖：下载文件名后缀（HTML / PDF）、版本格式判定（扩展名硬口径）。
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.services.crm import proposal_service as svc


def test_build_download_filename_html_and_raw():
    assert svc.build_download_filename("客户方案A", 2) == "客户方案A-v2.html"
    assert (
        svc.build_download_filename("客户方案A", 2, raw=True)
        == "客户方案A-v2-原始.html"
    )


def test_build_download_filename_pdf_has_no_raw_suffix():
    assert (
        svc.build_download_filename("客户方案A", 2, file_format="pdf")
        == "客户方案A-v2.pdf"
    )
    # PDF 没有适配产物，raw 不产生「-原始」后缀
    assert (
        svc.build_download_filename("客户方案A", 2, raw=True, file_format="pdf")
        == "客户方案A-v2.pdf"
    )


def test_build_download_filename_sanitizes_title():
    assert svc.build_download_filename("<报价>&", 1) == "报价-v1.html"


@pytest.mark.parametrize(
    ("filename", "content_type", "expected"),
    [
        ("v1.pdf", "application/octet-stream", "pdf"),
        ("v1.html", "text/html", "html"),
        ("", "application/pdf", "pdf"),
        ("", "", "html"),
    ],
)
def test_version_file_format(filename, content_type, expected):
    version = SimpleNamespace(original_filename=filename, content_type=content_type)
    assert svc.version_file_format(version) == expected
