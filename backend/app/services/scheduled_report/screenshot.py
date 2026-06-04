"""HTML → PNG screenshot using Playwright (headless Chromium).

Screenshots are post-processed with rounded-corner masking so that when viewed
on a mobile device the phone's own rounded bezel does not clip content.
"""

from __future__ import annotations

import io
import logging

logger = logging.getLogger(__name__)

# 邮件模板：桌面版 850px + padding；截图版 400px（手机端优化）
_DESKTOP_VIEWPORT_WIDTH = 900
_MOBILE_VIEWPORT_WIDTH = 420  # 手机竖屏宽度，截图专用
_VIEWPORT_HEIGHT = 800  # 初始高度，full_page=True 会自动扩展
# 手机端截图：4x 保证 Retina 超清（420 CSS px → 1680 物理 px）
# 覆盖 iPhone 15 Pro Max（430 CSS @ 3x = 1290px）等高端设备，无毛刺
_MOBILE_SCALE_FACTOR = 4
_ROUNDED_RADIUS = 30  # 与 420px 宽度成比例（原来 100/900 ≈ 30/420）


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
    width: int = _MOBILE_VIEWPORT_WIDTH,
    scale: int = _MOBILE_SCALE_FACTOR,
) -> bytes | None:
    """将 HTML 字符串渲染为 PNG 截图，并自动添加手机圆角蒙版。

    Args:
        html: 要渲染的完整 HTML 文档。
        width: CSS 视口宽度（默认 420px，手机竖屏宽度）。
        scale: 设备缩放因子（默认 4x，生成 1680px 物理宽度，Retina 超清）。

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


def process_screenshot_and_upload(
    screenshot_html: str,
    report_data: dict,
    email_params: dict,
    *,
    project_name: str,
    email_attachment_name: str,
    frequency: str,
    country: str = "US",
) -> None:
    """HTML 截图 → 邮件附件 → R2 full + thumb → 回写 report_data。

    封装完整管道：html_to_png → base64 邮件附件 →
    R2 完整尺寸上传 → 缩略图生成 → R2 缩略图上传 →
    将截图 URL 回写到 report_data，供 dispatcher 更新 delivery log。

    所有异常内部捕获并 warning 日志——失败不阻断邮件发送。

    Args:
        screenshot_html: 待截图的完整 HTML（不含摘要，纯数据展示版本）。
        report_data:   报告数据 dict，回写 screenshot_r2_url 等字段到此对象。
        email_params:  Resend 邮件参数字典，attachments 字段会被原地修改。
        project_name:  项目名称，用于 R2 文件夹划分。
        email_attachment_name: 邮件附件的文件名（含后缀，如 "每日报告_项目A_2025-01-15.png"）。
        frequency:     推送频率 "daily" | "weekly" | "monthly"，用于 R2 文件名前缀。
        country:       国家站点代码，默认 "US"。
    """
    import base64
    import io as _io
    from datetime import datetime
    from app.core.config import get_settings
    from app.services.r2_service import upload_bytes_to_r2
    from app.services.upload_service import _safe_project_folder_name
    from PIL import Image as PILImage

    png_bytes = html_to_png(screenshot_html)
    if not png_bytes:
        return

    try:
        # ── 邮件附件 ──────────────────────────────────────
        email_params["attachments"] = [{
            "filename": email_attachment_name,
            "content": base64.b64encode(png_bytes).decode("ascii"),
            "content_type": "image/png",
        }]

        # ── R2 上传（完整尺寸 3x 图）───────────────────────
        settings = get_settings()
        project_slug = _safe_project_folder_name(project_name)
        report_date = report_data.get("report_date", "")
        ts = datetime.now().strftime("%Y%m%dT%H%M%S")
        r2_filename = f"{report_date}_{frequency}_{country}_{ts}.png"

        full_result = upload_bytes_to_r2(
            settings=settings,
            data=png_bytes,
            filename=r2_filename,
            project_slug=project_slug,
            file_type="scheduled-reports/full",
            content_type="image/png",
        )
        logger.info("完整截图已上传到 R2: key=%s url=%s", full_result["key"], full_result["url"])

        # ── 缩略图（缩小至 1x：420px 宽）───────────────────
        img = PILImage.open(_io.BytesIO(png_bytes)).convert("RGBA")
        w, h = img.size
        thumb_w, thumb_h = w // _MOBILE_SCALE_FACTOR, h // _MOBILE_SCALE_FACTOR
        thumb_img = img.resize((thumb_w, thumb_h), PILImage.LANCZOS)
        thumb_buffer = _io.BytesIO()
        thumb_img.save(thumb_buffer, format="PNG")
        thumb_bytes = thumb_buffer.getvalue()

        thumb_filename = f"{report_date}_{frequency}_{country}_{ts}_thumb.png"
        thumb_result = upload_bytes_to_r2(
            settings=settings,
            data=thumb_bytes,
            filename=thumb_filename,
            project_slug=project_slug,
            file_type="scheduled-reports/thumb",
            content_type="image/png",
        )
        logger.info("缩略图已上传到 R2: key=%s url=%s", thumb_result["key"], thumb_result["url"])

        # ── 回写 report_data，供 dispatcher 同步到 delivery log ─
        report_data["screenshot_r2_key"] = full_result["key"]
        report_data["screenshot_r2_url"] = full_result["url"]
        report_data["screenshot_r2_thumb_key"] = thumb_result["key"]
        report_data["screenshot_r2_thumb_url"] = thumb_result["url"]
    except Exception as e:
        logger.warning("截图上传到 R2 失败（邮件已发送）: %s", e)
