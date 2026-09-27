"""Agent API 二进制文件响应 helper。"""

from __future__ import annotations

from collections.abc import Iterable
from urllib.parse import quote

from fastapi.responses import StreamingResponse


def _content_disposition(filename: str) -> str:
    """生成兼容 ASCII header 与 UTF-8 文件名的 RFC 5987 下载头。"""
    safe_filename = "".join(
        "_" if ord(char) < 32 or ord(char) == 127 else char for char in filename
    ).strip()
    if not safe_filename:
        safe_filename = "download"

    ascii_fallback = safe_filename.encode("ascii", "replace").decode("ascii")
    ascii_fallback = (
        ascii_fallback.replace("?", "_")
        .replace('"', "_")
        .replace("\\", "_")
    )
    encoded_filename = quote(safe_filename, safe="")
    return (
        f'attachment; filename="{ascii_fallback}"; '
        f"filename*=UTF-8''{encoded_filename}"
    )


def agent_file_response(
    content: bytes | Iterable[bytes], *, filename: str, media_type: str
) -> StreamingResponse:
    """返回原始文件 body，并设置通用下载头。

    已在内存中的 bytes 以单个 chunk 输出并附 ``Content-Length``；调用方也可传入
    bytes iterable 进行惰性分块，避免将大文件装进 JSON 或额外复制到内存。
    文件型成功响应不得通过 ``agent_ok`` 或 Base64 包装。
    """
    headers = {"Content-Disposition": _content_disposition(filename)}
    if isinstance(content, bytes):
        headers["Content-Length"] = str(len(content))
        body: Iterable[bytes] = (content,)
    else:
        body = content

    return StreamingResponse(body, media_type=media_type, headers=headers)
