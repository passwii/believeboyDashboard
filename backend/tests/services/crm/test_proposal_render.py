"""客户方案上传校验 / HTML 解析适配单测（BLF proposal 模块）。

这些是纯函数测试——不碰 DB、不碰 R2。覆盖：
- 骨架规范化（head 注入位置 / doctype / 片段包裹）
- 幂等（重复适配不叠加）
- 相对引用探测（提示但不断言阻断）
- 编码猜测（utf-8 / gb18030 / 声明 charset）
- 校验（扩展名 / 空文件 / 超限；HTML 与 PDF 同一口径）
- 格式判定 / MIME 归一（PDF 无适配产物）
"""

from __future__ import annotations

import io
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

from app.services.crm import proposal_render_service as render

# ---------- 相对引用探测 ----------


def test_find_unreachable_refs_relative_only():
    html = (
        '<html><head><link href="./style.css" rel="stylesheet"></head>'
        '<body><img src="assets/a.png">'
        '<img src="https://cdn.example/a.png">'
        '<img src="data:image/png;base64,AAA">'
        '<a href="#anchor">x</a>'
        '<script src="//cdn.example/x.js"></script>'
        "</body></html>"
    )
    assert render.find_unreachable_refs(html) == ["./style.css", "assets/a.png"]


def test_find_unreachable_refs_dedupes_preserving_order():
    html = '<img src="a.png"><img src="b.png"><img src="a.png">'
    assert render.find_unreachable_refs(html) == ["a.png", "b.png"]


def test_find_unreachable_refs_tolerates_malformed_html():
    # 截断/畸形 HTML 不应抛异常（探测是 best-effort，仅用于提示）
    assert isinstance(render.find_unreachable_refs("<img src=a.png <div "), list)
    assert isinstance(render.find_unreachable_refs("<<<>>>"), list)


def test_find_unreachable_refs_handles_unquoted_attr():
    assert render.find_unreachable_refs("<img src=a.png><img src=b.png>") == [
        "a.png",
        "b.png",
    ]


# ---------- 适配 ----------


def test_adapt_html_injects_theme_at_head_start():
    raw = "<html><head><title>T</title></head><body><h1>Hi</h1></body></html>"
    out = render.adapt_html(raw)
    assert out.startswith("<!DOCTYPE html>")
    # 主题样式注入在 head 开头：文档自身的 <style>/规则可覆盖我们的基线
    assert out.index("bb-proposal-theme") < out.index("<title>T</title>")
    assert "data-bb-theme" in out


def test_adapt_html_wraps_bare_fragment():
    out = render.adapt_html("<h1>片段</h1>")
    assert "<html" in out and "<head>" in out and "<body>" in out
    assert "<h1>片段</h1>" in out
    assert "bb-proposal-theme" in out


def test_adapt_html_adds_head_when_html_tag_has_none():
    out = render.adapt_html("<html><body>x</body></html>")
    assert "<head>" in out
    assert "bb-proposal-theme" in out
    assert "<body>x</body>" in out


def test_adapt_html_is_idempotent():
    raw = "<html><head></head><body>x</body></html>"
    once = render.adapt_html(raw)
    assert render.adapt_html(once) == once


def test_adapt_html_preserves_original_markup():
    raw = '<html><head></head><body><div class="k">保留</div></body></html>'
    out = render.adapt_html(raw)
    assert '<div class="k">保留</div>' in out


# ---------- 编码 ----------


def test_validate_and_decode_gb18030_via_declared_charset():
    text = "<html><head><meta charset=\"gb2312\"></head><body>中文</body></html>"
    data = text.encode("gb2312")
    assert "中文" in render_proposal_decode(data)


def test_validate_and_decode_utf8():
    data = "<h1>中文</h1>".encode()
    assert render_proposal_decode(data) == "<h1>中文</h1>"


def test_validate_and_decode_gb18030_without_declaration():
    # 无 charset 声明、非 UTF-8 字节 → 回退 gb18030
    data = "中文方案".encode("gb18030")
    assert render_proposal_decode(data) == "中文方案"


def render_proposal_decode(data: bytes) -> str:
    from app.services.crm.proposal_service import _decode_html

    return _decode_html(data)


# ---------- 校验 ----------


def _upload(data: bytes, filename: str, content_type: str = "text/html"):
    f = MagicMock()
    f.filename = filename
    f.content_type = content_type
    f.file = io.BytesIO(data)
    return f


def test_validate_rejects_unsupported_extension():
    with pytest.raises(HTTPException) as e:
        render.validate_html_upload(_upload(b"x", "a.md"), max_bytes=1024)
    assert e.value.status_code == 400
    assert "PDF" in e.value.detail


def test_validate_rejects_empty():
    with pytest.raises(HTTPException) as e:
        render.validate_html_upload(_upload(b"", "a.html"), max_bytes=1024)
    assert e.value.status_code == 400
    assert "为空" in e.value.detail


def test_validate_rejects_oversize():
    with pytest.raises(HTTPException) as e:
        render.validate_html_upload(_upload(b"x" * 2048, "a.html"), max_bytes=1024)
    assert e.value.status_code == 413


def test_validate_accepts_htm_and_soft_mime():
    ext, data = render.validate_html_upload(
        _upload(b"<html></html>", "a.htm", "application/octet-stream"), max_bytes=1024
    )
    assert ext == ".htm"
    assert data == b"<html></html>"


# ---------- PDF 校验 / 格式判定 ----------


def test_validate_accepts_pdf_extension_regardless_of_mime():
    raw = b"%PDF-1.7\n%%EOF\n"
    ext, data = render.validate_html_upload(
        _upload(raw, "报价.PDF", "application/octet-stream"), max_bytes=1024
    )
    assert ext == ".pdf"
    assert data == raw


def test_validate_bytes_accepts_pdf():
    assert (
        render.validate_html_bytes(b"%PDF", filename="v2.pdf", max_bytes=1024)
        == ".pdf"
    )


def test_validate_bytes_rejects_unsupported_extension():
    with pytest.raises(HTTPException) as e:
        render.validate_html_bytes(b"x", filename="v2.md", max_bytes=1024)
    assert e.value.status_code == 400


@pytest.mark.parametrize(
    ("filename", "content_type", "expected"),
    [
        ("a.pdf", "application/octet-stream", "pdf"),
        ("a.PDF", None, "pdf"),
        ("a.html", "application/pdf", "html"),  # 扩展名是硬口径
        ("a.html", "text/html; charset=utf-8", "html"),
        (None, "application/pdf", "pdf"),  # 文件名缺失时才看 MIME
        (None, None, "html"),
        ("noext", "text/html", "html"),
    ],
)
def test_resolve_file_format(filename, content_type, expected):
    assert render.resolve_file_format(filename, content_type) == expected


@pytest.mark.parametrize(
    ("filename", "content_type", "expected"),
    [
        ("a.pdf", "application/octet-stream", "application/pdf"),
        ("a.pdf", None, "application/pdf"),
        ("a.html", "text/html; charset=utf-8", "text/html; charset=utf-8"),
        ("a.html", "application/pdf", "text/html"),
        ("a.html", None, "text/html"),
    ],
)
def test_normalize_content_type(filename, content_type, expected):
    assert render.normalize_content_type(filename, content_type) == expected

