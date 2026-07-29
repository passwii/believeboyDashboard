"""HTML → PNG screenshot using Playwright (headless Chromium).

Screenshots are post-processed with rounded-corner masking so that when viewed
on a mobile device the phone's own rounded bezel does not clip content.
"""

from __future__ import annotations

import base64
import io
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

# 邮件模板：桌面版 850px + padding；截图版 400px（手机端优化）
_DESKTOP_VIEWPORT_WIDTH = 900
_MOBILE_VIEWPORT_WIDTH = 420  # 手机竖屏宽度，截图专用
_VIEWPORT_HEIGHT = 800  # 初始高度，full_page=True 会自动扩展
# 手机端截图缩放倍率。
# 2x：420 CSS px → 840 物理 px，邮件客户端主流尺寸下清晰，Retina 屏略可
#      见毛刺但邮件系统自身会压缩，可接受。
# 4x：420 CSS px → 1680 物理 px，理论上覆盖 iPhone 15 Pro Max @3x。
#      但在 1.9 GiB / 2 核 VPS 上 SwiftShader 软渲染 + ECharts + full_page
#      会导致 GPU 进程长驻 400-500 MiB D 状态几分钟不出结果（2026-07-29
#      scheduled_report dispatch_one 卡死的根因）。
#      物理像素翻 4 倍，软渲染时间 5-10x，2 核 CPU 直接打满；chrome 进程
#      还互相等 IO pipe，永远无法自然完成。
#      ⇒ VPS / 2 核小机器结构性约束 = 2x，4x 仅在 4 核 / 4 GB+ 部署上启用。
_MOBILE_SCALE_FACTOR = 2
_ROUNDED_RADIUS = 30  # 与 420px 宽度成比例（原来 100/900 ≈ 30/420）

# 邮件 logo 本地副本（与 dash.believeboy.com/logo-email.png 同源）
# 截图渲染时优先用本地 base64 data URI，避免外网慢请求触发 networkidle 超时
_DEFAULT_LOGO_URL = "https://dash.believeboy.com/logo-email.png"
# screenshot.py 在 backend/app/services/scheduled_report/，向上 4 层到项目根
_REPO_ROOT = Path(__file__).resolve().parents[4]
_LOCAL_LOGO_FILE = _REPO_ROOT / "frontend" / "public" / "logo-email.png"

_logo_data_uri_cache: str | None = None
_logo_data_uri_attempted: bool = False


def _load_logo_data_uri() -> str | None:
    """读取本地 logo-email.png，转为 base64 data URI（结果缓存）。

    Returns:
        data URI 字符串（如 "data:image/png;base64,iVBOR..."），文件缺失/读取失败时返回 None。
    """
    global _logo_data_uri_cache, _logo_data_uri_attempted
    if _logo_data_uri_attempted:
        return _logo_data_uri_cache
    _logo_data_uri_attempted = True
    try:
        if not _LOCAL_LOGO_FILE.exists():
            logger.warning(
                "本地 logo 文件不存在: %s，将回退到外网 URL", _LOCAL_LOGO_FILE
            )
            return None
        b64 = base64.b64encode(_LOCAL_LOGO_FILE.read_bytes()).decode("ascii")
        _logo_data_uri_cache = f"data:image/png;base64,{b64}"
        logger.info(
            "已加载本地 logo data URI（%d 字节）", _LOCAL_LOGO_FILE.stat().st_size
        )
        return _logo_data_uri_cache
    except Exception as e:
        logger.warning("读取本地 logo 失败: %s，将回退到外网 URL", e)
        return None


def get_logo_src_for_screenshot() -> str:
    """截图模式下的 logo src：优先本地 data URI，缺失则回退外网 URL。"""
    return _load_logo_data_uri() or _DEFAULT_LOGO_URL


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
        scale: 设备缩放因子（默认 2x，生成 840px 物理宽度，Retina 清晰）。

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

    browser = None
    try:
        with sync_playwright() as p:
            # 6afa78e1（2026-07-21）的稳定 launch 配置基础上，追加资源限制参数：
            # 不要加 --single-process（playwright 官方说不推荐生产用，易 deadlock）
            # 不要加 --disable-gpu（会让 ECharts/SVG/Canvas 走软渲染，CPU 慢 5-10x）
            # 不要显式 channel='chrome-headless-shell'（playwright 1.55+ headless 已是默认行为）
            #
            # 2026-07-28 事故后追加的资源限制（Chrome 148 在 2核/2GB VPS 打满 CPU）：
            # --renderer-process-limit=2  限制渲染进程数（默认按核数 spawn，2核=2个）
            # --disable-dev-shm-usage     /dev/shm 太小（VPS 通常 64MB），改用 /tmp
            # --disable-background-networking  禁止后台网络活动（更新检查等）
            # --disable-extensions / --disable-sync / --metrics-recording-only  减少后台开销
            # --mute-audio / --no-first-run  跳过无关初始化
            browser = p.chromium.launch(
                headless=True,
                args=[
                    "--renderer-process-limit=2",
                    "--disable-dev-shm-usage",
                    "--disable-background-networking",
                    "--disable-extensions",
                    "--disable-sync",
                    "--metrics-recording-only",
                    "--mute-audio",
                    "--no-first-run",
                ],
            )
            page = browser.new_page(
                viewport={"width": width, "height": _VIEWPORT_HEIGHT},
                device_scale_factor=scale,
            )

            # 拦截所有外部网络请求，避免外网 logo/CDN 拖慢渲染 / 触发 networkidle 超时
            # HTML 中 <img> 已带 onerror 隐藏逻辑，拦截后页面布局不受影响
            def _block_external(route):
                url = route.request.url
                if url.startswith("data:") or url.startswith("about:"):
                    route.continue_()
                else:
                    route.abort()

            page.route("**/*", _block_external)

            page.set_content(html, wait_until="networkidle")
            # 等待字体渲染 + 布局稳定（6afa78e1 用的 500ms，覆盖复杂表格渲染）
            page.wait_for_timeout(500)
            # 保留防御性 timeout=120_000（playwright 默认 30s 偏紧）— 这个是 0d8b697a 引入的，
            # 和 launch 参数简化无关，防御性超时不应去掉。
            png_bytes = page.screenshot(full_page=True, type="png", timeout=120_000)
    except Exception as e:
        # 2026-07-29: 任何异常 / 超时路径都必须确保 chrome 子进程被清理。
        # celery soft_time_limit=300 SIGKILL worker 子进程时，python 进程立即
        # 被杀，browser.close() 不会执行 → chrome 子进程成为孤儿，靠 cgroup
        # OOM / 手动 systemctl restart 释放，会卡 5+ 分钟。
        # 把关闭逻辑放到 finally 块，无论异常 / 超时 / SIGKILL 都能立即释放。
        logger.error("截图生成失败: %s", e)
        return None
    finally:
        # 双保险：成功路径在 with 块退出时 playwright 会自动关；异常路径
        # 这里手动 close。注意 playwright 的 close 是 best-effort，如果
        # chromium 子进程本身 D 状态，close 也会 hang，但 at least 我们调用了。
        if browser is not None:
            try:
                browser.close()
            except Exception as close_err:
                logger.warning(
                    "browser.close() 失败（chromium 可能仍残留）: %s", close_err
                )

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
        email_params["attachments"] = [
            {
                "filename": email_attachment_name,
                "content": base64.b64encode(png_bytes).decode("ascii"),
                "content_type": "image/png",
            }
        ]

        # ── R2 上传（完整尺寸 2x 图）───────────────────────
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
        logger.info(
            "完整截图已上传到 R2: key=%s url=%s", full_result["key"], full_result["url"]
        )

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
        logger.info(
            "缩略图已上传到 R2: key=%s url=%s", thumb_result["key"], thumb_result["url"]
        )

        # ── 回写 report_data，供 dispatcher 同步到 delivery log ─
        report_data["screenshot_r2_key"] = full_result["key"]
        report_data["screenshot_r2_url"] = full_result["url"]
        report_data["screenshot_r2_thumb_key"] = thumb_result["key"]
        report_data["screenshot_r2_thumb_url"] = thumb_result["url"]
    except Exception as e:
        logger.warning("截图上传到 R2 失败（邮件已发送）: %s", e)
