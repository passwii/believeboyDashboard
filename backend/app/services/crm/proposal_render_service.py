"""客户方案 HTML 解析 / 适配（BLF proposal 模块）。

职责边界（与设计一致）：
- R2 只负责「存」和「发」；本模块负责**解析**与**适配**（R2 没有计算能力）。
- 适配只在**上传那一刻**发生一次，结果冻结进 R2；查看 / 下载读冻结产物，不重算
  → 保证「所见即所下载」。

适配做什么（刻意保持轻量，零新依赖）：
1. 校验扩展名 / 大小 / 非空（.html / .htm）；
2. 探测「不可达的相对引用」（``./a.css`` / ``assets/x.js``）——项目只存单个
   HTML，这些引用存下来必然 404，需要提示用户改自包含，但不阻断；
3. 规范化文档骨架：补 ``<!DOCTYPE>`` / ``<html>`` / ``<meta charset>`` /
   ``<meta viewport>``；
4. 注入本项目设计令牌（globals.css 的色板 / 圆角 / 字体 + 暗色），并给出
   ``body`` 基线（画布色、字体、内边距）。注入位置固定在 ``<head>`` **开头**，
   这样文档自身的 ``<style>`` 会覆盖我们的基线——**尊重原设计，只兜底不缺省**。

刻意不做：
- 不把 HTML 编译成 React/TSX（会丢 HTML 真源，违背「下载仍是单个 HTML」）；
- 不内联外链资源（要发网络请求 + SSRF 风险，收益低）；
- 不 sanitize 掉 ``<script>``（会破坏文档功能）——安全性由**渲染侧的
  sandbox iframe** 承担（见 frontend/app/p/[id]/page-renderer.tsx 同款范式）。
"""

from __future__ import annotations

import hashlib
import re
from html.parser import HTMLParser

from fastapi import HTTPException, UploadFile, status

HTML_EXTS = {".html", ".htm"}

# 设计令牌单一来源：与 frontend/app/globals.css 的 :root / .dark 对齐（精选子集）。
# 只带「画布 / 文字 / 强调 / 分割线 / 圆角 / 字体」这些跨文档通用的令牌，
# 避免把 dashboard 专属的 sidebar / chart 变量塞进访客文档。
_THEME_STYLE_ID = "bb-proposal-theme"
_HEAD_OPEN_RE = re.compile(r"<head\b[^>]*>", re.IGNORECASE)
_HTML_OPEN_RE = re.compile(r"<html\b[^>]*>", re.IGNORECASE)
_DOCTYPE_RE = re.compile(r"<!doctype\b", re.IGNORECASE)
_CHARSET_RE = re.compile(r"<meta[^>]+charset", re.IGNORECASE)
_VIEWPORT_RE = re.compile(r"<meta[^>]+name=[\"']?viewport", re.IGNORECASE)
_EXISTING_THEME_RE = re.compile(rf"id=[\"']{_THEME_STYLE_ID}[\"']", re.IGNORECASE)

# 相对引用探测：这些前缀/形态指向同目录兄弟文件，单文件存储下必然 404。
_ABSOLUTE_REF_RE = re.compile(
    r"^(?:[a-z][a-z0-9+.-]*:|//|#)", re.IGNORECASE
)


def sha256_hex(data: bytes) -> str:
    """版本内容指纹（完整性核对 / 去重）。"""
    return hashlib.sha256(data).hexdigest()


def _format_from_ext(ext: str) -> str | None:
    return "html" if ext in HTML_EXTS else None


def validate_html_upload(
    file: UploadFile, *, max_bytes: int
) -> tuple[str, bytes]:
    """校验扩展名 / 大小 / 非空，返回 ``(ext, content)``。

    扩展名是硬约束（MIME 只做软校验——浏览器经常把 .html 报成
    application/octet-stream）。与 page_render_service 同款口径。
    """
    filename = file.filename or ""
    ext = filename[filename.rfind(".") :].lower() if "." in filename else ""
    if _format_from_ext(ext) is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="不支持的文件类型：仅接受单个 HTML 文件（.html / .htm）",
        )

    if max_bytes <= 0:
        max_bytes = 5 * 1024 * 1024

    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = file.file.read(64 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise HTTPException(
                status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                detail=f"文件超过 {max_bytes} 字节上限",
            )
        chunks.append(chunk)

    if total == 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="文件为空",
        )

    return ext, b"".join(chunks)


class _RefCollector(HTMLParser):
    """收集 ``href`` / ``src`` 属性值（用于相对引用探测）。"""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.refs: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        for name, value in attrs:
            if name.lower() in ("href", "src") and value:
                self.refs.append(value.strip())

    handle_startendtag = handle_starttag  # 自闭合标签同样处理


def find_unreachable_refs(html: str) -> list[str]:
    """返回文档里指向「同目录兄弟文件」的相对引用（去重、保持出现顺序）。

    这些引用在单 HTML 存储下必然 404（如 ``<link href="./style.css">``）；
    外链（http/https）、``data:``、锚点 ``#`` 不算。仅作**提示**，不阻断上传。
    """
    parser = _RefCollector()
    try:
        parser.feed(html)
    except Exception:  # noqa: BLE001 —— 畸形 HTML 不应让上传失败
        return []

    found: list[str] = []
    seen: set[str] = set()
    for ref in parser.refs:
        if not ref or _ABSOLUTE_REF_RE.match(ref):
            continue
        # 形如 "a.css" / "./a.css" / "../a.css" / "assets/a.js"
        if ref in seen:
            continue
        seen.add(ref)
        found.append(ref)
    return found


def _build_head_block() -> str:
    """要插入 ``<head>`` 开头的骨架 meta + 主题样式。"""
    return (
        '<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        f'<style id="{_THEME_STYLE_ID}">\n{_THEME_CSS}\n</style>\n'
    )


def adapt_html(raw: str) -> str:
    """把上传的单个 HTML 适配成「在 dashboard 里看着原生」的单个 HTML。

    幂等：已注入过主题样式的文档不会被重复注入。
    """
    if _EXISTING_THEME_RE.search(raw):
        return raw

    # 已补齐骨架 meta 的情况下，只补主题样式；否则整块注入 head 开头。
    block = _build_head_block()

    head_match = _HEAD_OPEN_RE.search(raw)
    if head_match:
        adapted = f"{raw[: head_match.end()]}\n{block}{raw[head_match.end() :]}"
    else:
        html_match = _HTML_OPEN_RE.search(raw)
        if html_match:
            adapted = f"{raw[: html_match.end()]}\n<head>\n{block}</head>{raw[html_match.end() :]}"
        else:
            # 片段（无 <html>）：包一层完整文档，保留原内容作为 body。
            adapted = (
                '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n'
                f"{block}</head>\n<body>\n{raw}\n</body>\n</html>\n"
            )

    # 补 DOCTYPE（有 <html> 但缺 doctype 时，避免怪异模式）
    if not _DOCTYPE_RE.search(adapted):
        adapted = "<!DOCTYPE html>\n" + adapted

    # 仅在缺失时补 charset / viewport（幂等所需，顺序无关）
    if not _CHARSET_RE.search(adapted):
        adapted = adapted.replace(
            "<head>", '<head><meta charset="utf-8">', 1
        )
    if not _VIEWPORT_RE.search(adapted):
        adapted = adapted.replace(
            "<head>",
            '<head><meta name="viewport" content="width=device-width, initial-scale=1">',
            1,
        )
    return adapted


# ---------------------------------------------------------------------------
# 主题令牌（与 frontend/app/globals.css 对齐的精选子集）
#
# 说明：iframe 是独立文档，无法继承父页面的 .dark class，故同时支持
#   - prefers-color-scheme（默认跟随系统）
#   - html[data-bb-theme="light|dark"]（查看侧可强制；不影响冻结的下载产物）
# ---------------------------------------------------------------------------
_THEME_CSS = """\
:root {
  --bb-background: 210 28% 97%;
  --bb-foreground: 214 18% 16%;
  --bb-card: 0 0% 100%;
  --bb-muted: 210 22% 94%;
  --bb-muted-foreground: 215 12% 42%;
  --bb-border: 214 22% 84%;
  --bb-primary: 214 89% 43%;
  --bb-primary-foreground: 210 40% 98%;
  --bb-radius: 0.75rem;
  --bb-font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto,
    "Helvetica Neue", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei",
    sans-serif;
}
html[data-bb-theme="dark"] {
  --bb-background: 224 3% 7%;
  --bb-foreground: 220 22% 96%;
  --bb-card: 224 3% 16%;
  --bb-muted: 224 3% 14%;
  --bb-muted-foreground: 224 5% 72%;
  --bb-border: 224 4% 24%;
  --bb-primary: 222 100% 68%;
  --bb-primary-foreground: 228 40% 12%;
}
@media (prefers-color-scheme: dark) {
  html:not([data-bb-theme="light"]) {
    --bb-background: 224 3% 7%;
    --bb-foreground: 220 22% 96%;
    --bb-card: 224 3% 16%;
    --bb-muted: 224 3% 14%;
    --bb-muted-foreground: 224 5% 72%;
    --bb-border: 224 4% 24%;
    --bb-primary: 222 100% 68%;
    --bb-primary-foreground: 228 40% 12%;
  }
}
html {
  color-scheme: light;
}
html[data-bb-theme="dark"] {
  color-scheme: dark;
}
@media (prefers-color-scheme: dark) {
  html:not([data-bb-theme="light"]) {
    color-scheme: dark;
  }
}
/* 基线：放在 head 最前，文档自身的 <style> 会覆盖它——尊重原设计，只兜底。 */
body {
  margin: 0;
  padding: 32px;
  max-width: 1080px;
  margin-inline: auto;
  background: hsl(var(--bb-background));
  color: hsl(var(--bb-foreground));
  font-family: var(--bb-font);
  font-size: 15px;
  line-height: 1.7;
  -webkit-font-smoothing: antialiased;
}
a { color: hsl(var(--bb-primary)); }
img, svg, video, canvas, table { max-width: 100%; }
table { border-collapse: collapse; }
hr { border: 0; border-top: 1px solid hsl(var(--bb-border)); }
@media (max-width: 640px) {
  body { padding: 16px; }
}
"""


__all__ = [
    "HTML_EXTS",
    "adapt_html",
    "find_unreachable_refs",
    "sha256_hex",
    "validate_html_upload",
]
