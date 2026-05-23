"""HTML → PNG screenshot using Playwright (headless Chromium).

Screenshots are post-processed with rounded-corner masking so that when viewed
on a mobile device the phone's own rounded bezel does not clip content.
"""

from __future__ import annotations

import io
import logging

logger = logging.getLogger(__name__)

# 邮件模板最大宽度 680px + 两侧 padding
_VIEWPORT_WIDTH = 720
_VIEWPORT_HEIGHT = 800  # 初始高度，full_page=True 会自动扩展
# Retina 缩放因子：2x 保证手机端截图清晰（720 CSS px → 1440 物理 px）
_DEVICE_SCALE_FACTOR = 2
_ROUNDED_RADIUS = 100


def _apply_rounded_corners(png_bytes: bytes, radius: int = _ROUNDED_RADIUS) -> bytes:
    from PIL import Image, ImageDraw

    img = Image.open(io.BytesIO(png_bytes)).convert("RGBA")
    w, h = img.size

    mask = Image.new("L", (w, h), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle([(0, 0), (w - 1, h - 1)], radius=radius, fill=255)

    rgba = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    rgba.paste(img, mask=mask)

    out = io.BytesIO()
    rgba.save(out, format="PNG")
    return out.getvalue()


def html_to_png(
    html: str,
    width: int = _VIEWPORT_WIDTH,
    scale: int = _DEVICE_SCALE_FACTOR,
) -> bytes | None:
    """将 HTML 字符串渲染为 PNG 截图，并自动添加手机圆角蒙版。

    Args:
        html: 要渲染的完整 HTML 文档。
        width: CSS 视口宽度（默认 720px）。
        scale: 设备缩放因子（默认 2x，生成 Retina 级别清晰度）。

    Returns:
        PNG 字节数据（含透明圆角），失败时返回 None（不阻断邮件发送）。
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        logger.warning(
            "playwright 未安装，跳过截图。"
            "安装方式: pip install playwright && playwright install chromium"
        )
        return None

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(
                viewport={"width": width, "height": _VIEWPORT_HEIGHT},
                device_scale_factor=scale,
            )
            page.set_content(html, wait_until="networkidle")
            # 等待字体渲染 + 布局稳定（提高到 500ms 确保复杂表格渲染完成）
            page.wait_for_timeout(500)
            png_bytes = page.screenshot(full_page=True, type="png")
            browser.close()
    except Exception as e:
        logger.error("截图生成失败: %s", e)
        return None

    try:
        png_bytes = _apply_rounded_corners(png_bytes)
    except Exception as e:
        logger.warning("圆角蒙版生成失败（截图仍将发送）: %s", e)

    return png_bytes
