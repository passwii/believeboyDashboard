"""产品标签制作端点（工具箱 / 产品标签制作）。

上传单个产品标签 PDF + 文案，返回叠加好文案的新 PDF。

无状态：不落盘、不写库、不上 R2。上传字节在内存里处理完直接回吐二进制，
磁盘上的原件不会被改动（见 :mod:`app.services.product_label_overlay`）。

无系统 CLI 依赖：原设计的 poppler（``pdftotext`` / ``pdfinfo`` / ``pdftoppm``）
已由 ``pdfplumber`` + ``pypdf`` 等价替代，三者都已在 requirements 里 pin。
"""

from __future__ import annotations

from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response

from app.api.deps import protected
from app.core.config import Settings, get_settings
from app.services import product_label_overlay
from app.services.product_label_overlay import LabelError

router = APIRouter(prefix="/product-label", tags=["product-label"])

_READ_CHUNK_BYTES = 1024 * 1024
_PDF_MAGIC = b"%PDF-"
_MAX_TEXT_CHARS = product_label_overlay.MAX_TEXT_CHARS


def _content_disposition(filename: str) -> str:
    """构造 Content-Disposition，兼容非 ASCII 文件名（RFC 5987）。

    与 ``sku_info._content_disposition`` 同款：HTTP header 必须是 ASCII，
    含中文时裸写 ``filename="..."`` 会让 Starlette 在 latin-1 编码下抛
    ``UnicodeEncodeError``。这里同时给 ASCII 兜底与 ``filename*=UTF-8''``。
    """
    fallback = filename.encode("ascii", "replace").decode("ascii").replace("?", "_")
    return f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{quote(filename, safe='')}"


def _read_upload(file: UploadFile, settings: Settings) -> bytes:
    """按流累计读取上传内容，受 ``max_upload_bytes`` 限制。

    不信任 Content-Length，按实际字节数拦截（与 upload_service 同口径）。
    """
    limit = settings.max_upload_bytes
    buffer = bytearray()
    while True:
        chunk = file.file.read(_READ_CHUNK_BYTES)
        if not chunk:
            break
        buffer.extend(chunk)
        if len(buffer) > limit:
            raise HTTPException(
                status_code=413,
                detail=f"文件超过 {limit // (1024 * 1024)}MB 上限，请压缩后再上传。",
            )
    return bytes(buffer)


def _parse_made_in_china(raw: str) -> bool:
    """前端以 multipart 传字符串，这里做宽松解析（大小写与常见真值都认）。"""
    return (raw or "").strip().lower() in {"1", "true", "yes", "on"}


@router.post(
    "/generate",
    dependencies=[Depends(protected)],
    response_class=Response,
    responses={
        200: {"content": {"application/pdf": {}}, "description": "叠加文案后的 PDF"},
        400: {"description": "标签不可处理（多页 / 无文字 / 插不下 / 文案超宽）"},
    },
)
def generate_product_label(
    file: UploadFile = File(...),
    text: str = Form(default=""),
    made_in_china: str = Form(default=""),
    settings: Settings = Depends(get_settings),
) -> Response:
    """给单页产品标签 PDF 叠加文案，返回新的 PDF。"""
    filename = file.filename or "label.pdf"
    if Path(filename).suffix.lower() != ".pdf":
        raise HTTPException(status_code=400, detail="仅支持 PDF 格式的产品标签。")

    pdf_bytes = _read_upload(file, settings)
    if not pdf_bytes:
        raise HTTPException(status_code=400, detail="上传的文件为空。")
    if not pdf_bytes.startswith(_PDF_MAGIC):
        raise HTTPException(status_code=400, detail="该文件不是有效的 PDF。")

    text = (text or "").strip()
    if len(text) > _MAX_TEXT_CHARS:
        raise HTTPException(
            status_code=400, detail=f"文案过长，请控制在 {_MAX_TEXT_CHARS} 字以内。"
        )

    try:
        result = product_label_overlay.generate(
            pdf_bytes,
            text=text,
            made_in_china=_parse_made_in_china(made_in_china),
        )
    except LabelError as exc:
        # 处理器的中文说明直接透传给前端展示。
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    stem = Path(filename).stem or "label"
    return Response(
        content=result.pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": _content_disposition(f"{stem}-labeled.pdf")},
    )
