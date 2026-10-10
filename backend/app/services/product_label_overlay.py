"""产品标签文案叠加（工具箱 / 产品标签制作）。

在已上传的单页产品标签 PDF 上，用透明文字图层追加「文案」与可选的
「Made In China」两段内容，然后与原件合并输出。原件只存在于内存里，
磁盘上的上传文件不会被改动。

实现要点（全部走纯 Python，无系统 CLI 依赖）：

- 页面尺寸：``pypdf`` 的 ``MediaBox`` / ``CropBox``
  （替代 spec 里的 ``pdfinfo``）。
- 词级坐标：``pdfplumber.extract_words(extra_attrs=["size"])``，坐标是
  **左上原点、y 向下**（替代 spec 里的 ``pdftotext -bbox``）。
- 文字图层：``reportlab`` canvas（左下原点、y 向上）。
- 合并：``pypdf`` 的 ``PageObject.merge_page()``。

坐标系换算（spec §2）：``baseline_y = H − (行 top + 0.75 × 字号)``。

锚点识别只依赖相对关系，不硬编码绝对坐标：

===== ================== ============================================
层    锚点               识别方式 / 兜底
===== ================== ============================================
L1    页面               页数 ≠ 1 / 带页面旋转 / CropBox 有偏移 → 拒绝处理
L2    FNSKU 行           ``^X00[0-9A-Z]{7}$`` 全页唯一命中；不中 → 最上面一行
L3    商品名块           FNSKU 行之后的全部行；全页只有一行 → 该行整体
L3′   插入点             商品名块 ``max(top + 字号)``（最后一行底边）
L3″   左对齐             商品名块 ``min(x0)``
===== ================== ============================================

任一硬条件不满足（页数≠1 / 带旋转 / 提不到文本 / 商品名块为空 / 插不下 /
文案超宽 / 底部安全边距不足）一律 fail closed 抛 :class:`LabelError`，
绝不静默出图。
"""

from __future__ import annotations

import io
import re
from dataclasses import dataclass
from statistics import median
from typing import Any

# ── 版式常量（spec §3）─────────────────────────────────────────────────────
# 两处跨块间距：商品名块 → 文案，以及 文案 → Made In China。
# 用固定 pt 而非 em：文案字号取自标签自身的商品名字号，实测标签普遍是
# 8pt，6pt 正好落在 spec 推荐的 0.75em 视觉区间（明显分断但不脱节）。
GAP_PT = 6.0
# 预留符号仅为兼容旧调用；实际块间距按商品名字号相对计算。
LINE_ADVANCE_EM = 1.2
# 底部安全边距：先按建议值 4mm 校验，不满足则退到硬底 3mm，再不行就拒绝。
BOTTOM_MARGIN_TARGET_MM = 4.0
BOTTOM_MARGIN_HARD_MM = 3.0
# 右侧安全边距。
SIDE_MARGIN_MM = 3.0

MAX_TEXT_LINES = 3
MAX_TEXT_CHARS = 200

# 商品名字号的合理区间。超出即视为异常标签（例如整页只有图形或字号被
# 缩放成不可读的值），fail closed 而不是把字号硬拉到某个默认值——
# 静默改字号会让文案与标签原有信息脱节。
MIN_FONT_SIZE = 5.0
MAX_FONT_SIZE = 20.0
FALLBACK_FONT_SIZE = 8.0

MM_TO_PT = 72.0 / 25.4

# 正文字体：文案约定为英文/拉丁，Helvetica 是 reportlab 内置字体，
# 无需嵌入字体文件。
BODY_FONT = "Helvetica"

# L2 锚点：Amazon FNSKU。全页唯一命中才采信。
_FNSKU_RE = re.compile(r"^X00[0-9A-Z]{7}$")

# 两个库对同一页的尺寸读数允许的偏差（pt）。超过即说明有一方读错了
# 页面框，继续叠加会错位。
_SIZE_TOLERANCE_PT = 0.5


class LabelError(Exception):
    """标签处理失败。消息是面向用户的中文说明，由端点映射成 400。"""


@dataclass(frozen=True)
class TextLine:
    """一行文本（左上原点坐标）。"""

    text: str
    x0: float
    x1: float
    top: float
    size: float

    @property
    def bottom(self) -> float:
        """行底边（降部）。pdfplumber 实测 ``bottom == top + size``。"""
        return self.top + self.size


@dataclass(frozen=True)
class PlacedLine:
    """待绘制的一行：reportlab 坐标（左下原点）。"""

    text: str
    x: float
    baseline: float
    size: float
    top: float

    @property
    def bottom(self) -> float:
        return self.top + self.size


@dataclass(frozen=True)
class Placement:
    """排版结果。"""

    lines: tuple[PlacedLine, ...]
    bottom_margin_pt: float
    warnings: tuple[str, ...]


def _mm(value_mm: float) -> float:
    return value_mm * MM_TO_PT


# ── L1：页面框 ────────────────────────────────────────────────────────────


def extract_page_frame(pdf_bytes: bytes) -> tuple[bytes, float, float]:
    """读单页页面框，返回 ``(base_bytes, width, height)``。

    ``base_bytes`` 目前恒等于入参（不做任何改写），保留返回值是为了让调用
    方只读一次字节；将来若要支持旋转页，改写点在这里。
    """
    from pypdf import PdfReader

    try:
        reader = PdfReader(io.BytesIO(pdf_bytes))
    except Exception as exc:  # noqa: BLE001 — 统一转成面向用户的中文错误
        raise LabelError("无法解析该 PDF，请确认文件未损坏。") from exc

    if len(reader.pages) != 1:
        raise LabelError(
            f"仅支持单页产品标签，该文件有 {len(reader.pages)} 页。"
            "请先拆分成单个标签再上传。"
        )

    page = reader.pages[0]

    # /Rotate ≠ 0 时，pypdf 的页面框是未旋转的原始坐标，pdfplumber 却按旋转
    # 后的方向给尺寸与坐标，两个库对不上；而 reportlab 画出的图层是叠加在
    # 页面自身坐标系的，一旦方向不一致就会整体错位。产品标签实际都是正向
    # 打印，与其猜坐标不如明确拒绝（spec 的 fail closed 原则）。
    rotation = page.get("/Rotate") or 0
    try:
        rotation = int(rotation) % 360
    except (TypeError, ValueError):
        rotation = 0
    if rotation:
        raise LabelError(
            f"该 PDF 带 {rotation}° 页面旋转，叠加会错位，暂不支持。"
            "请在 PDF 工具里先把页面「另存为」正向版本再上传。"
        )

    cropbox = page.cropbox
    left = float(cropbox.left)
    bottom = float(cropbox.bottom)
    width = float(cropbox.width)
    height = float(cropbox.height)

    if width <= 0 or height <= 0:
        raise LabelError("该 PDF 的页面尺寸异常，无法处理。")

    # 先验证页面框，再核对 MediaBox。pypdf 的 ``transfer_rotation_to_content``
    # 不在这里用：带 Rotate 的源文件会让 pdfplumber 读出旋转后尺寸，而 pypdf
    # 的 MediaBox 仍是原始方向，两个坐标框会不一致，静默烘焙反而会错位。
    if abs(left) > _SIZE_TOLERANCE_PT or abs(bottom) > _SIZE_TOLERANCE_PT:
        raise LabelError(
            "该 PDF 的页面框原点不在左下角（CropBox 有偏移），"
            "叠加会导致错位，暂不支持。"
        )

    return pdf_bytes, width, height


# ── L2 / L3：文字行与锚点 ─────────────────────────────────────────────────


def extract_lines(pdf_bytes: bytes, *, expect_size: tuple[float, float]) -> list[TextLine]:
    """提取全页文字行，并与 ``expect_size`` 核对尺寸。

    行聚合容差 = ``0.5 × 字号``（spec ①），字号取行内各词的中位数。
    """
    import pdfplumber

    try:
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            if len(pdf.pages) != 1:
                raise LabelError("仅支持单页产品标签。")
            page = pdf.pages[0]

            # 尺寸核对（替代 spec 的 pdfinfo 核对）：两个库对同一页的
            # 读数必须一致，否则后面算出来的插入点一定是错的。
            expected_w, expected_h = expect_size
            if (
                abs(float(page.width) - expected_w) > _SIZE_TOLERANCE_PT
                or abs(float(page.height) - expected_h) > _SIZE_TOLERANCE_PT
            ):
                raise LabelError(
                    "页面尺寸读取不一致，无法可靠定位插入点，请换一个标签文件重试。"
                )

            words = page.extract_words(extra_attrs=["size"])
    except LabelError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise LabelError("无法从该 PDF 提取文字，请确认是文字型标签而非纯图片。") from exc

    if not words:
        raise LabelError(
            "该 PDF 提取不到任何文字（可能是纯图片标签），无法定位插入点。"
        )

    return _group_words_into_lines(words)


def _group_words_into_lines(words: list[dict[str, Any]]) -> list[TextLine]:
    """按 ``top`` 聚行，容差 ``0.5 × 字号``。

    实现细节：pdfplumber 的 ``top`` 已是左上原点（y 向下），排序后自顶向下
    扫一遍；一个词归入当前行当且仅当它与当前行参考 top 的距离不超过当前行
    字号的 0.5 倍。容差随字号走，标签改版或字号变化都不会让聚合失效。
    """
    ordered = sorted(words, key=lambda w: (float(w["top"]), float(w["x0"])))
    groups: list[list[dict[str, Any]]] = []
    group_sizes: list[float] = []

    for word in ordered:
        size = _word_size(word)
        if not groups:
            groups.append([word])
            group_sizes.append(size)
            continue

        reference_top = float(groups[-1][0]["top"])
        tolerance = 0.5 * group_sizes[-1]
        if abs(float(word["top"]) - reference_top) <= tolerance:
            groups[-1].append(word)
            group_sizes[-1] = median([_word_size(w) for w in groups[-1]])
        else:
            groups.append([word])
            group_sizes.append(size)

    lines: list[TextLine] = []
    for group in groups:
        group.sort(key=lambda w: float(w["x0"]))
        text = " ".join(str(w["text"]) for w in group).strip()
        if not text:
            continue
        size = median([_word_size(w) for w in group])
        lines.append(
            TextLine(
                text=text,
                x0=min(float(w["x0"]) for w in group),
                x1=max(float(w["x1"]) for w in group),
                top=min(float(w["top"]) for w in group),
                size=size,
            )
        )
    return lines


def _word_size(word: dict[str, Any]) -> float:
    try:
        size = float(word["size"])
    except (KeyError, TypeError, ValueError):
        return FALLBACK_FONT_SIZE
    return size if size > 0 else FALLBACK_FONT_SIZE


def find_fnsku_line_index(lines: list[TextLine]) -> int | None:
    """L2：返回 FNSKU 行的下标；不唯一命中或未命中返回 ``None``。

    除整行文本外，也检查去掉空格的整行（有些标签把 FNSKU 拆成多个词，
    例如 ``X004 ABCDEFG``）。
    """
    matches = [
        index
        for index, line in enumerate(lines)
        if _line_looks_like_fnsku(line)
    ]
    if len(matches) == 1:
        return matches[0]
    return None


def _line_looks_like_fnsku(line: TextLine) -> bool:
    candidates = [line.text.strip().upper(), line.text.replace(" ", "").strip().upper()]
    return any(_FNSKU_RE.match(candidate) for candidate in candidates)


def resolve_product_block(lines: list[TextLine]) -> list[TextLine]:
    """L3：定位商品名块。

    若 FNSKU 行唯一命中，取其后的文本行；若未命中/不唯一，优先从最早
    的左对齐内容行取商品名（Amazon 标签的偏移 FNSKU 条码常居中而非锚点），
    仍无法区分时再兜底用页面最上面一行。全页只有一行则该行整体当作商品名块。
    """
    if not lines:
        raise LabelError("该 PDF 提取不到任何文字，无法定位插入点。")
    if len(lines) == 1:
        return lines

    fnsku_index = find_fnsku_line_index(lines)
    if fnsku_index is not None:
        block = lines[fnsku_index + 1 :]
    else:
        left_edge = min(line.x0 for line in lines)
        left_aligned = [
            index
            for index, line in enumerate(lines)
            if abs(line.x0 - left_edge) <= _SIZE_TOLERANCE_PT
        ]
        first_left_aligned = left_aligned[0] if left_aligned else 0
        # 商品名块允许首行由短标题/左对齐，而其后才是更靠右缩进的内容；
        # 从最早左对齐行开始比「跳过最上面居中的 FNSKU」更稳。
        block = lines[first_left_aligned:]

    if not block:
        raise LabelError(
            "商品名块为空（FNSKU 行之后没有可定位的内容），无法确定插入点。"
        )
    return block


# ── 几何：算出待绘制的行 ──────────────────────────────────────────────────


def normalize_text_lines(raw: str) -> list[str]:
    """把输入文案拆成最多 ``MAX_TEXT_LINES`` 行，逐行去首尾空白、丢空行。"""
    lines = [line.strip() for line in (raw or "").splitlines()]
    return [line for line in lines if line][:MAX_TEXT_LINES]


def resolve_placement(
    block: list[TextLine],
    width: float,
    height: float,
    text_lines: list[str],
    *,
    made_in_china: bool,
) -> Placement:
    """纯几何：算出文案块与 Made In China 的绘制位置。

    无 I/O、无第三方库，便于单测。
    """
    from reportlab.pdfbase.pdfmetrics import stringWidth

    if not block:
        raise LabelError("商品名块为空，无法确定插入点。")

    size = median([line.size for line in block])
    if not MIN_FONT_SIZE <= size <= MAX_FONT_SIZE:
        raise LabelError(
            f"商品名字号异常（{size:.1f}pt），不在可处理的 "
            f"{MIN_FONT_SIZE:.0f}–{MAX_FONT_SIZE:.0f}pt 区间内。"
        )

    # L3′：插入点取商品名块「最后一行」的底边。商品名会折行，取第一行会
    # 把文案插进商品名中间。
    insert_bottom = max(line.bottom for line in block)
    # L3″：左对齐取商品名块的左边界。
    x_left = min(line.x0 for line in block)
    available_width = width - x_left - _mm(SIDE_MARGIN_MM)
    if available_width <= 0:
        raise LabelError("标签可用宽度不足，无法写入文案。")

    # 用户确认两处段间距均为 6pt：商品名末行 → 首条新增内容，以及文案末行
    # → Made In China。小尺寸标签空间不足时，仅缩小新增字号（不低于 6pt），
    # 6pt 间距保持不变；若仍不满足 3mm 底边安全距离则 fail closed。
    warnings: list[str] = []
    available_bottom = height - _mm(BOTTOM_MARGIN_HARD_MM)
    row_size = size
    remaining = available_bottom - insert_bottom

    def required_height(font_size: float) -> float:
        if not text_lines and not made_in_china:
            return 0.0
        labels_height = 0.0
        if text_lines:
            labels_height += font_size
            if len(text_lines) > 1:
                labels_height += (len(text_lines) - 1) * LINE_ADVANCE_EM * font_size
            if made_in_china:
                labels_height += GAP_PT + font_size
        else:
            labels_height += font_size
        return GAP_PT + labels_height

    if required_height(row_size) > remaining:
        min_size = 6.0
        while row_size > min_size and required_height(row_size) > remaining:
            row_size = max(min_size, row_size - 0.1)
        if required_height(row_size) > remaining:
            raise LabelError(
                f"标签底部空间不足：商品名结束于 {insert_bottom:.1f}pt，"
                f"新增内容在最小 {min_size:.0f}pt 字号和两个 6pt 段间距下仍需 "
                f"{required_height(min_size):.1f}pt，页面硬边距内仅余 {remaining:.1f}pt。"
                "请缩短文案或选用更大的标签。"
            )
        warnings.append(
            f"标签空间较紧：新增文案字号从 {size:.1f}pt 缩至 {row_size:.1f}pt；"
            f"两处段间距保持 {GAP_PT:.1f}pt。"
        )

    placed: list[PlacedLine] = []

    def baseline_for(top: float) -> float:
        return height - (top + 0.75 * row_size)

    def append(text: str, top: float) -> None:
        baseline = height - (top + 0.75 * row_size)
        needed = stringWidth(text, BODY_FONT, row_size)
        if needed > available_width:
            raise LabelError(
                f"文案「{text}」过宽：需要 {needed:.1f}pt，"
                f"标签可用宽度仅 {available_width:.1f}pt。请缩短文案或改用更小的标签。"
            )
        placed.append(
            PlacedLine(
                text=text,
                x=x_left,
                baseline=baseline,
                size=row_size,
                top=top,
            )
        )

    # 第一处为商品名末行到首条新增行的 6pt，第二处为文案到 Made In China
    # 的 6pt；文案块内部换行用 1.2em。
    for index, text in enumerate(text_lines):
        top = (
            insert_bottom + GAP_PT
            if index == 0
            else placed[-1].top + LINE_ADVANCE_EM * row_size
        )
        append(text, top)

    if made_in_china:
        top = placed[-1].bottom + GAP_PT if placed else insert_bottom + GAP_PT
        append("Made In China", top)

    if not placed:
        raise LabelError("请至少填写「文案」或勾选「Made In China」。")

    final_bottom = max(line.bottom for line in placed)
    bottom_margin = height - final_bottom

    if bottom_margin < _mm(BOTTOM_MARGIN_HARD_MM):
        raise LabelError(
            f"插入后底部只剩 {bottom_margin:.2f}pt "
            f"（{bottom_margin / MM_TO_PT:.2f}mm），低于 {BOTTOM_MARGIN_HARD_MM:.0f}mm "
            "硬性安全边距，热敏机边缘会裁字。请减少文案行数或换用更大的标签。"
        )
    if bottom_margin < _mm(BOTTOM_MARGIN_TARGET_MM):
        warnings.append(
            f"底部安全边距 {bottom_margin / MM_TO_PT:.2f}mm，"
            f"低于建议的 {BOTTOM_MARGIN_TARGET_MM:.0f}mm，请确认打印机边缘不会裁字。"
        )

    return Placement(
        lines=tuple(placed),
        bottom_margin_pt=bottom_margin,
        warnings=tuple(warnings),
    )


# ── 图层：reportlab 透明文字层 + pypdf 合并 ────────────────────────────────


def build_overlay_pdf(width: float, height: float, lines: tuple[PlacedLine, ...]) -> bytes:
    """画一层透明文字图层（不画背景，天然透明）。"""
    from reportlab.pdfgen import canvas

    buffer = io.BytesIO()
    page = canvas.Canvas(buffer, pagesize=(width, height))
    for line in lines:
        page.setFont(BODY_FONT, line.size)
        page.drawString(line.x, line.baseline, line.text)
    page.save()
    return buffer.getvalue()


def merge_overlay(base_bytes: bytes, overlay_bytes: bytes) -> bytes:
    """把图层合并到原件页面上，返回新的 PDF 字节。"""
    from pypdf import PdfReader, PdfWriter

    reader = PdfReader(io.BytesIO(base_bytes))
    overlay = PdfReader(io.BytesIO(overlay_bytes))
    writer = PdfWriter()
    writer.add_page(reader.pages[0])
    writer.pages[0].merge_page(overlay.pages[0])
    buffer = io.BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


# ── 校验：产物自检 ────────────────────────────────────────────────────────


def verify_output(
    pdf_bytes: bytes,
    *,
    expect_size: tuple[float, float],
    added_texts: list[str],
) -> None:
    """spec 第 7 步：页数 / 尺寸 / 文本 / 边界 / 底部安全边距。"""
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(pdf_bytes))
    if len(reader.pages) != 1:
        raise LabelError("产物页数异常，已中止。")

    page = reader.pages[0]
    expected_w, expected_h = expect_size
    if (
        abs(float(page.cropbox.width) - expected_w) > _SIZE_TOLERANCE_PT
        or abs(float(page.cropbox.height) - expected_h) > _SIZE_TOLERANCE_PT
    ):
        raise LabelError("产物页面尺寸与原件不一致，已中止。")

    lines = extract_lines(pdf_bytes, expect_size=expect_size)
    haystack = " ".join(line.text for line in lines).upper()
    for text in added_texts:
        if text.upper() not in haystack:
            raise LabelError(f"产物中未检出新增文案「{text}」，已中止。")

    lowest = max(line.bottom for line in lines)
    if expected_h - lowest < _mm(BOTTOM_MARGIN_HARD_MM):
        raise LabelError("产物底部安全边距不足，已中止。")
    if max(line.x1 for line in lines) > expected_w:
        raise LabelError("产物内容超出页面右边界，已中止。")


# ── 编排 ──────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class OverlayResult:
    pdf_bytes: bytes
    warnings: tuple[str, ...]
    added_lines: tuple[str, ...]


def generate(
    pdf_bytes: bytes,
    *,
    text: str,
    made_in_china: bool,
) -> OverlayResult:
    """主入口：给单页标签 PDF 叠加文案。

    Raises:
        LabelError: 任一硬条件不满足。调用方应映射为 400。
    """
    if len(text or "") > MAX_TEXT_CHARS:
        raise LabelError(f"文案过长，请控制在 {MAX_TEXT_CHARS} 字以内。")

    text_lines = normalize_text_lines(text)
    if not text_lines and not made_in_china:
        raise LabelError("请至少填写「文案」或勾选「Made In China」。")

    base_bytes, width, height = extract_page_frame(pdf_bytes)
    lines = extract_lines(base_bytes, expect_size=(width, height))
    block = resolve_product_block(lines)

    placement = resolve_placement(
        block, width, height, text_lines, made_in_china=made_in_china
    )

    overlay_bytes = build_overlay_pdf(width, height, placement.lines)
    merged = merge_overlay(base_bytes, overlay_bytes)

    added_texts = [line.text for line in placement.lines]
    verify_output(merged, expect_size=(width, height), added_texts=added_texts)

    return OverlayResult(
        pdf_bytes=merged,
        warnings=placement.warnings,
        added_lines=tuple(added_texts),
    )
