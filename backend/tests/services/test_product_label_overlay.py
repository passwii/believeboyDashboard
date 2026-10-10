"""真实 60 × 40mm Amazon 标签样本的回归测试。

样本：ops682-犀牛-31SKU-商品标签-60x40/products-ETB-FLSP-5060BEG.pdf
由用户 2026-10-09 提供。它是单页、60.226 × 40.150mm，含偏移居中的 FNSKU
以及两行折行商品名（第二行在 x=18pt 左对齐）。

样本 PDF 不提交进仓库；通过 ``BELIEVEBOY_PRODUCT_LABEL_FIXTURE`` 环境变量
指定本地路径时才启用真实文件用例。常规 CI / 本地测试仍使用同结构的合成 fixture。
"""

from __future__ import annotations

import io
import os
from pathlib import Path

import pytest
from pypdf import PdfReader
from reportlab.pdfgen import canvas

from app.services import product_label_overlay as M

FNSKU = "X004ABCDEF"


# ---------- helpers ----------


def make_label(
    *,
    width: float = 4 * 72,
    height: float = 6 * 72,
    lines: list[tuple[float, float, str]] | None = None,
    extra_pages: int = 0,
    rotate: int = 0,
) -> bytes:
    """现场生成一个单页标签 PDF。lines 是 (left, top, text)，左上原点。"""
    if lines is None:
        lines = [
            (18.0, 79.9, FNSKU),
            (18.0, 100.0, "Wireless Bluetooth Earbuds"),
            (18.0, 110.0, "with Charging Case"),
        ]

    buf = io.BytesIO()
    page = canvas.Canvas(buf, pagesize=(width, height))
    for left, top, text in lines:
        size = 9.0 if text.startswith("X00") else 8.0
        page.setFont("Helvetica", size)
        page.drawString(left, height - top - size, text)
    for _ in range(extra_pages):
        page.showPage()
        page.setFont("Helvetica", 8)
        page.drawString(18, height - 100, "second page")
    if rotate:
        page.setPageRotation(rotate)
    page.save()
    return buf.getvalue()


def frame_of(pdf_bytes: bytes) -> tuple[float, float]:
    _, width, height = M.extract_page_frame(pdf_bytes)
    return width, height


def lines_of(pdf_bytes: bytes) -> list[M.TextLine]:
    width, height = frame_of(pdf_bytes)
    return M.extract_lines(pdf_bytes, expect_size=(width, height))


# ---------- L1 页面 ----------


def test_rejects_multi_page():
    pdf = make_label(extra_pages=2)
    with pytest.raises(M.LabelError, match="仅支持单页"):
        M.extract_page_frame(pdf)


def test_rejects_corrupt_pdf():
    with pytest.raises(M.LabelError, match="无法解析"):
        M.extract_page_frame(b"not a pdf at all")


def test_rejects_rotated_page():
    """带页面旋转的标签坐标方向与图层不一致，必须 fail closed 而不是猜。"""
    pdf = make_label(rotate=90)
    with pytest.raises(M.LabelError, match="页面旋转"):
        M.extract_page_frame(pdf)


def test_rejects_shifted_cropbox():
    """CropBox 原点不在左下角 → 叠加会错位，必须 fail closed。"""
    reader = PdfReader(io.BytesIO(make_label()))
    from pypdf import PdfWriter

    writer = PdfWriter()
    writer.add_page(reader.pages[0])
    page = writer.pages[0]
    page.cropbox.lower_left = (5, 5)
    page.cropbox.upper_right = (288, 432)
    buf = io.BytesIO()
    writer.write(buf)

    with pytest.raises(M.LabelError, match="原点不在左下角"):
        M.extract_page_frame(buf.getvalue())


# ---------- L2 / L3 锚点 ----------


def test_groups_words_into_lines_by_tolerance():
    """同一行内的多个词要聚成一行；容差随字号走（0.5 × 字号）。"""
    pdf = make_label(
        lines=[
            (18.0, 79.9, FNSKU),
            (18.0, 100.0, "Wireless"),
            (60.0, 100.0, "Earbuds"),
        ]
    )
    lines = lines_of(pdf)
    assert "Wireless Earbuds" in [line.text for line in lines]
    assert len(lines) == 2


def test_fnsku_line_detected_uniquely():
    assert M.find_fnsku_line_index(lines_of(make_label())) == 0


def test_fnsku_missing_falls_back_to_top_line():
    pdf = make_label(
        lines=[
            (18.0, 60.0, "Product Name Line One"),
            (18.0, 70.0, "Product Name Line Two"),
        ]
    )
    lines = lines_of(pdf)
    assert M.find_fnsku_line_index(lines) is None
    block = M.resolve_product_block(lines)
    assert [line.text for line in block] == ["Product Name Line One", "Product Name Line Two"]


def test_ambiguous_fnsku_falls_back_to_top_line():
    pdf = make_label(
        lines=[
            (18.0, 60.0, FNSKU),
            (18.0, 70.0, "Product Name"),
            (18.0, 80.0, FNSKU),
        ]
    )
    lines = lines_of(pdf)
    assert M.find_fnsku_line_index(lines) is None
    assert [line.text for line in M.resolve_product_block(lines)] == [FNSKU, "Product Name", FNSKU]


def test_single_line_page_is_whole_block():
    lines = lines_of(make_label(lines=[(18.0, 60.0, FNSKU)]))
    assert [line.text for line in M.resolve_product_block(lines)] == [FNSKU]


def test_empty_block_fails_closed():
    pdf = make_label(lines=[(18.0, 60.0, "Product Name Line One"), (18.0, 70.0, FNSKU)])
    lines = lines_of(pdf)
    assert M.find_fnsku_line_index(lines) == 1
    with pytest.raises(M.LabelError, match="商品名块为空"):
        M.resolve_product_block(lines)


def test_insert_point_uses_last_line_not_first():
    lines = lines_of(make_label())
    block = M.resolve_product_block(lines)
    placement = M.resolve_placement(block, 288, 432, ["Hello"], made_in_china=False)
    assert placement.lines[0].top >= max(line.bottom for line in block)
    assert placement.lines[0].x == min(line.x0 for line in block)


# ---------- gap / 字号 / 安全边距 ----------


def _label_block(top: float = 100.0, size: float = 8.0) -> list[M.TextLine]:
    return [M.TextLine(text="Name", x0=18, x1=80, top=top, size=size)]


def test_both_segment_gaps_are_six_points():
    block = [
        M.TextLine(text="Name A", x0=18, x1=80, top=100, size=8),
        M.TextLine(text="Name B", x0=18, x1=80, top=110, size=8),
    ]
    placement = M.resolve_placement(block, 288, 432, ["Line One", "Line Two"], made_in_china=True)
    assert placement.lines[0].top - max(line.bottom for line in block) == pytest.approx(6.0)
    assert placement.lines[1].top - placement.lines[0].top == pytest.approx(1.2 * 8)
    assert placement.lines[2].top - placement.lines[1].bottom == pytest.approx(6.0)


def test_baseline_conversion_matches_spec():
    placement = M.resolve_placement(_label_block(), 288, 432, ["Hello"], made_in_china=False)
    line = placement.lines[0]
    assert line.baseline == pytest.approx(432 - (line.top + 0.75 * line.size))


def test_bottom_margin_hard_limit_fails_closed():
    with pytest.raises(M.LabelError, match="底部空间不足|安全边距"):
        M.resolve_placement(_label_block(top=190), 288, 200, ["Line One", "Line Two"], made_in_china=True)


def test_bottom_margin_between_3_and_4mm_warns_but_passes():
    top = 200.0
    height = top + 8 + 6 + 8 + 3.5 * M.MM_TO_PT
    placement = M.resolve_placement(_label_block(top=top), 288, height, ["Line One"], made_in_china=False)
    assert any("安全边距" in warning for warning in placement.warnings)


def test_text_too_wide_fails_closed():
    with pytest.raises(M.LabelError, match="过宽"):
        M.resolve_placement(_label_block(), 120, 432, ["A" * 60], made_in_china=False)


def test_abnormal_font_size_fails_closed():
    with pytest.raises(M.LabelError, match="字号异常"):
        M.resolve_placement(_label_block(size=1.5), 288, 432, ["Hello"], made_in_china=False)


def test_requires_some_content():
    with pytest.raises(M.LabelError, match="至少填写"):
        M.resolve_placement(_label_block(), 288, 432, [], made_in_china=False)


def test_normalize_text_lines_trims_and_caps():
    assert M.normalize_text_lines("  A  \n\n  B  \nC\nD") == ["A", "B", "C"]


# ---------- 端到端合成标签 ----------


def test_generate_end_to_end_preserves_frame_and_adds_text():
    pdf = make_label()
    width, height = frame_of(pdf)
    result = M.generate(pdf, text="Designed in California", made_in_china=True)
    assert frame_of(result.pdf_bytes) == (width, height)

    output_lines = lines_of(result.pdf_bytes)
    texts = [line.text for line in output_lines]
    assert FNSKU in texts
    assert "Designed in California" in texts
    assert "Made In China" in texts
    original_lines = lines_of(pdf)
    # 合成标签 FNSKU 与商品名左侧边界相同，商品名块从 FNSKU 后开始；
    # 左对齐块对照可明确取商品名最后一行（不是条码行）。
    product_lines = original_lines[1:]
    added = next(line for line in output_lines if line.text == "Designed in California")
    # font bbox 与 Helvetica ascent 略有差异，抽取后的顶边误差保持在 0.4pt 内。
    assert added.top - max(line.bottom for line in product_lines) == pytest.approx(M.GAP_PT, abs=0.4)


def test_generate_rejects_oversize_text():
    with pytest.raises(M.LabelError, match="过长"):
        M.generate(make_label(), text="x" * (M.MAX_TEXT_CHARS + 1), made_in_china=False)


def test_generate_rejects_image_only_pdf():
    buf = io.BytesIO()
    page = canvas.Canvas(buf, pagesize=(288, 432))
    page.rect(10, 10, 100, 100, fill=1)
    page.save()
    with pytest.raises(M.LabelError, match="提取不到任何文字"):
        M.generate(buf.getvalue(), text="Hello", made_in_china=False)


# ---------- 用户提供的真实 60 × 40mm 标签 ----------


_REAL_SAMPLE = os.getenv("BELIEVEBOY_PRODUCT_LABEL_FIXTURE")
if _REAL_SAMPLE:
    _REAL_PDF = Path(_REAL_SAMPLE)
else:
    _DEFAULT_REAL_PDF = Path(
        "/Users/damon/Downloads/ops682-犀牛-31SKU-商品标签-60x40/"
        "products-ETB-FLSP-5060BEG.pdf"
    )
    _REAL_PDF = _DEFAULT_REAL_PDF if _DEFAULT_REAL_PDF.exists() else None


@pytest.mark.skipif(_REAL_PDF is None, reason="未配置用户提供的真实 60 × 40mm PDF 样本")
def test_user_sample_60x40mm_adds_copy_and_made_in_china_with_safe_bottom_margin():
    """真实样本中 FNSKU 居中、商品名左对齐折行，必须选左对齐块作锚点。"""
    assert _REAL_PDF is not None
    source = _REAL_PDF.read_bytes()
    original_page = PdfReader(io.BytesIO(source)).pages[0]
    width, height = float(original_page.mediabox.width), float(original_page.mediabox.height)
    assert width == pytest.approx(170.72, abs=0.1)
    assert height == pytest.approx(113.81, abs=0.1)

    result = M.generate(source, text="Designed in California", made_in_china=True)
    output_reader = PdfReader(io.BytesIO(result.pdf_bytes))
    page = output_reader.pages[0]
    assert len(output_reader.pages) == 1
    assert float(page.mediabox.width) == pytest.approx(width, abs=0.1)
    assert float(page.mediabox.height) == pytest.approx(height, abs=0.1)

    original_lines = M.extract_lines(source, expect_size=(width, height))
    lines = M.extract_lines(result.pdf_bytes, expect_size=(width, height))
    texts = [line.text for line in lines]
    assert "X0057UYDR5" in texts
    assert "Home Blanket" in texts
    assert "Designed in California" in texts
    assert "Made In China" in texts

    product_bottom = max(
        line.bottom for line in original_lines if abs(line.x0 - 18.0) <= 0.5
    )
    # CropBox/MediaBox 的原始尺寸以 2 位小数记录，会在 pypdf 合并往返时
    # 产生 < 0.3pt 的 bbox 浮点量化误差；按 0.4pt 公差核对 6pt 设计值。
    added = [line for line in lines if line.text in {"Designed in California", "Made In China"}]
    assert added[0].top - product_bottom == pytest.approx(M.GAP_PT, abs=0.4)
    assert added[1].top - added[0].bottom == pytest.approx(M.GAP_PT, abs=0.4)
    assert all(line.x0 == pytest.approx(18.0, abs=0.5) for line in added)
    bottom_margin = height - max(line.bottom for line in added)
    assert bottom_margin >= 3 * M.MM_TO_PT
    assert any("字号" in warning for warning in result.warnings)


def test_real_sample_without_copy_still_generates_made_in_china_only():
    """真实 60x40 样本的复选框单独使用也能出图。"""
    if _REAL_PDF is None:
        pytest.skip("未配置用户提供的真实 60 × 40mm PDF 样本")
    result = M.generate(_REAL_PDF.read_bytes(), text="", made_in_china=True)
    texts = [line.text for line in lines_of(result.pdf_bytes)]
    assert "Made In China" in texts


def test_short_product_name_without_fnsku_uses_left_aligned_anchor():
    """没有 FNSKU 时，优先从最早左对齐内容行定位商品名。"""
    lines = [
        M.TextLine(text="Centered code", x0=62.57, x1=108.15, top=51.9, size=8),
        M.TextLine(text="Short name", x0=18.0, x1=58.0, top=63.9, size=8),
        M.TextLine(text="Second line", x0=18.0, x1=58.0, top=71.9, size=8),
    ]
    assert M.find_fnsku_line_index(lines) is None
    assert [line.text for line in M.resolve_product_block(lines)] == ["Short name", "Second line"]
