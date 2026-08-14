#!/usr/bin/env python3
"""生成 BelieveBoy GUI 的应用图标（AppIcon.icns）。

macOS Big Sur 风格：蓝渐变圆角方块 + 白色柱状图/上升箭头（Dashboard 语义）。
- 输出：gui/assets/AppIcon.icns（1024px 源 + iconutil 打包）
- 依赖：Pillow（仅生成时需要，bundle.sh 运行时不需要）

用法：python3 gui/scripts/make-icon.py
"""

import os
import shutil
import subprocess

from PIL import Image, ImageDraw

# 品牌色（frontend/app/globals.css --primary: 214 89% 43%）
TOP = (13, 110, 199)  # 亮蓝
BOTTOM = (6, 72, 140)  # 深蓝
WHITE = (255, 255, 255)

HERE = os.path.dirname(os.path.abspath(__file__))
GUI_DIR = os.path.dirname(HERE)
ICONSET_DIR = os.path.join(GUI_DIR, "assets", "AppIcon.iconset")
ICNS_PATH = os.path.join(GUI_DIR, "assets", "AppIcon.icns")

SIZE = 1024
RADIUS = 185  # Big Sur 圆角约 22% 边长


def hex_to_rgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))


def lerp(a: tuple, b: tuple, t: float) -> tuple:
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def draw_bars(draw: ImageDraw, x0: int, y0: int, w: int, h: int, gap: int) -> None:
    """白色圆角柱状图（4 根，高度递增）+ 顶部上升箭头。"""
    bar_w = (w - gap * 3) // 4
    heights = [0.42, 0.58, 0.74, 0.92]
    xs = [x0 + i * (bar_w + gap) for i in range(4)]
    for x, frac in zip(xs, heights):
        bw, bh = bar_w, int(h * frac)
        r = bw // 3
        draw.rounded_rectangle([x, y0 + h - bh, x + bw, y0 + h], radius=r, fill=WHITE)

    # 上升趋势箭头（右上角，两段折线 + 箭头）
    ax0, ay0 = x0 + bar_w + gap, y0 + int(h * 0.62)
    ax1, ay1 = x0 + 2 * (bar_w + gap), y0 + int(h * 0.42)
    ax2, ay2 = x0 + 3 * (bar_w + gap) + bar_w, y0 + int(h * 0.22)
    stroke = max(18, bar_w // 4)
    draw.line([(ax0, ay0), (ax1, ay1)], fill=WHITE, width=stroke)
    # 箭头（第二段右端）
    tip = (ax2 + stroke * 2, ay2 - stroke)
    draw.line([(ax1, ay1), (ax2, ay2)], fill=WHITE, width=stroke)
    a_len = stroke * 3
    draw.polygon(
        [
            tip,
            (ax2, ay2),
            (ax2 + stroke * 2, ay2 + stroke * 2),
        ],
        fill=WHITE,
    )


def render_1024() -> Image.Image:
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # 圆角方块裁剪蒙版
    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, SIZE - 1, SIZE - 1], radius=RADIUS, fill=255
    )

    # 垂直蓝渐变底
    bg = Image.new("RGB", (SIZE, SIZE))
    bg_draw = ImageDraw.Draw(bg)
    for y in range(SIZE):
        t = y / (SIZE - 1)
        bg_draw.line([(0, y), (SIZE, y)], fill=lerp(TOP, BOTTOM, t))

    # 顶光（左上高光，增加质感）
    glow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse(
        [-SIZE // 3, -SIZE // 3, SIZE // 1.6, SIZE // 1.6],
        fill=(255, 255, 255, 38),
    )

    img.paste(bg, (0, 0), mask)
    img.alpha_composite(glow)
    img = Image.composite(img, Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0)), mask)

    # 图表区域（居中偏左，留白右上角放箭头）
    cx, cy = SIZE // 2, SIZE // 2
    chart_w, chart_h = 460, 340
    x0 = cx - chart_w // 2
    y0 = cy - chart_h // 2
    draw = ImageDraw.Draw(img)
    draw_bars(draw, x0, y0, chart_w, chart_h, gap=26)
    return img


def make_iconset(img: Image.Image) -> None:
    if os.path.exists(ICONSET_DIR):
        shutil.rmtree(ICONSET_DIR)
    os.makedirs(ICONSET_DIR)
    for size in [16, 32, 128, 256, 512]:
        resized = img.resize((size, size), Image.LANCZOS)
        resized.save(os.path.join(ICONSET_DIR, f"icon_{size}x{size}.png"))
        resized.save(os.path.join(ICONSET_DIR, f"icon_{size}x{size}@2x.png"))
    # 1024 只作为 512@2x
    img.save(os.path.join(ICONSET_DIR, "icon_512x512@2x.png"))


def main() -> None:
    img = render_1024()
    make_iconset(img)
    subprocess.run(["iconutil", "-c", "icns", ICONSET_DIR, "-o", ICNS_PATH], check=True)
    shutil.rmtree(ICONSET_DIR)
    print(f"OK: {ICNS_PATH} ({os.path.getsize(ICNS_PATH)} bytes)")


if __name__ == "__main__":
    main()
