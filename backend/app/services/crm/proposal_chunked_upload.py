"""CRM 方案分段上传的临时存储（本地磁盘，不碰 R2）。

设计约束（2026-10-21）：
- 为解决 Vercel 函数约 4.5MB 请求体硬上限，前端把大文件（HTML / PDF）按 3MB
  分段上传；
- 分段落在 ``settings.upload_root/_crm_proposal_tmp/<upload_id>/``，finalize
  合并后再走**现有** ``upload_bytes_to_r2``；
- 不引入 presigned URL、不改 R2 桶、不改其他上传模块、不新增 DB 表；
- 每个 ``upload_id`` 是 ``uuid4().hex``，meta.json 绑定 owner，TTL 2 小时。

并发假设：线上 API 以 ``--workers 1`` 运行（见 deploy/systemd），同一进程内
顺序写盘即可。若未来多实例，需要把临时目录换成共享存储（NFS/Redis/S3）。

分段按字节合并，格式无关：PDF 与 HTML 走同一条链路；扩展名校验与
``proposal_render_service`` 同一口径（这里提前把关，避免白传字节）。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import HTTPException, status

from app.services.crm import proposal_render_service as render

#: 单段大小。3MB 远低于 Vercel 函数 4.5MB 请求体上限，留足头/边界余量。
CHUNK_SIZE = 3 * 1024 * 1024

#: 未 finalize 的临时目录保留时长。超过后由 ``cleanup_expired`` 删除。
UPLOAD_TTL_SECONDS = 2 * 60 * 60

_UPLOAD_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_ROOT_NAME = "_crm_proposal_tmp"


def _root(settings) -> Path:
    root = Path(settings.upload_root) / _ROOT_NAME
    root.mkdir(parents=True, exist_ok=True)
    return root


def _upload_dir(settings, upload_id: str) -> Path:
    if not _UPLOAD_ID_RE.match(upload_id or ""):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="非法 upload_id"
        )
    return _root(settings) / upload_id


def _meta_path(settings, upload_id: str) -> Path:
    return _upload_dir(settings, upload_id) / "meta.json"


def _read_meta(settings, upload_id: str) -> dict:
    path = _meta_path(settings, upload_id)
    if not path.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="上传会话不存在或已过期",
        )
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:  # pragma: no cover - 损坏文件属异常路径
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="上传会话不存在或已过期",
        ) from exc


def _write_meta(settings, upload_id: str, meta: dict) -> None:
    path = _meta_path(settings, upload_id)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def _assert_owner(meta: dict, owner_id: str | None, is_admin: bool) -> None:
    if is_admin:
        return
    current = (owner_id or "").strip() or None
    if not current or meta.get("owner_id") != current:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Not the upload owner"
        )


def _assert_not_expired(meta: dict) -> None:
    expires_at = meta.get("expires_at")
    if not expires_at:
        return
    try:
        expires = datetime.fromisoformat(expires_at)
    except ValueError:
        return
    if expires <= datetime.now(timezone.utc):
        raise HTTPException(
            status_code=status.HTTP_410_GONE, detail="上传会话已过期"
        )


def read_meta(
    settings,
    upload_id: str,
    *,
    owner_id: str | None,
    is_admin: bool = False,
) -> dict:
    """读取 meta 并校验 owner / TTL（供 finalize 幂等返回用）。"""
    meta = _read_meta(settings, upload_id)
    _assert_owner(meta, owner_id, is_admin)
    _assert_not_expired(meta)
    return meta


def init_upload(
    settings,
    *,
    owner_id: str | None,
    filename: str,
    size: int,
    content_type: str | None,
    title: str | None,
    proposal_type: str | None,
    customer_id: int | None,
    change_note: str | None,
    proposal_id: int | None = None,
) -> dict:
    """创建一次分段上传会话，返回 meta（含 upload_id / chunk 信息）。"""
    if size <= 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="文件为空"
        )
    if size > settings.crm_proposal_max_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail=f"文件超过 {settings.crm_proposal_max_bytes} 字节上限",
        )

    ext = Path(filename or "").suffix.lower()
    if ext not in render.PROPOSAL_EXTS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="不支持的文件类型：仅接受单个 HTML（.html / .htm）或 PDF（.pdf）文件",
        )

    cleanup_expired(settings)

    upload_id = uuid.uuid4().hex
    upload_dir = _upload_dir(settings, upload_id)
    upload_dir.mkdir(parents=True, exist_ok=False)

    total_chunks = (size + CHUNK_SIZE - 1) // CHUNK_SIZE
    now = datetime.now(timezone.utc)
    meta = {
        "upload_id": upload_id,
        "owner_id": (owner_id or "").strip() or None,
        "filename": (filename or "proposal.html")[:255],
        "size": size,
        "content_type": render.normalize_content_type(filename, content_type)[:64],
        "title": title,
        "proposal_type": proposal_type,
        "customer_id": customer_id,
        "change_note": change_note,
        "proposal_id": proposal_id,
        "chunk_size": CHUNK_SIZE,
        "total_chunks": total_chunks,
        "status": "pending",
        "created_at": now.isoformat(),
        "expires_at": (now + timedelta(seconds=UPLOAD_TTL_SECONDS)).isoformat(),
        "proposal_id_final": None,
        "version_no": None,
    }
    _write_meta(settings, upload_id, meta)
    return meta


def write_chunk(
    settings,
    upload_id: str,
    index: int,
    data: bytes,
    *,
    owner_id: str | None,
    is_admin: bool = False,
) -> int:
    """写入一段。重复写同一 index 为幂等覆盖（便于前端重试）。"""
    meta = _read_meta(settings, upload_id)
    _assert_owner(meta, owner_id, is_admin)
    _assert_not_expired(meta)
    if meta.get("status") != "pending":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="上传会话已结束"
        )
    total_chunks = int(meta["total_chunks"])
    if index < 0 or index >= total_chunks:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="分段序号越界"
        )
    if len(data) > CHUNK_SIZE:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail="单个分段超过 3MB",
        )
    expected = min(CHUNK_SIZE, int(meta["size"]) - index * CHUNK_SIZE)
    if len(data) != expected:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="分段大小与声明不一致",
        )

    (_upload_dir(settings, upload_id) / f"{index:05d}.part").write_bytes(data)
    return len(data)


def assemble(
    settings,
    upload_id: str,
    *,
    owner_id: str | None,
    is_admin: bool = False,
) -> tuple[bytes, dict]:
    """按序合并全部分段，返回 ``(raw_bytes, meta)``。

    合并成功后把状态置 ``assembling``，避免同一会话被重复 finalize。
    """
    meta = _read_meta(settings, upload_id)
    _assert_owner(meta, owner_id, is_admin)
    _assert_not_expired(meta)
    if meta.get("status") == "finalized":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="该上传已收尾"
        )
    if meta.get("status") != "pending":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="上传会话状态异常"
        )

    parts = sorted(_upload_dir(settings, upload_id).glob("*.part"))
    if len(parts) != int(meta["total_chunks"]):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="分段不完整"
        )

    buffer = bytearray()
    for part in parts:
        buffer += part.read_bytes()
    if len(buffer) != int(meta["size"]):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="合并后大小与声明不一致",
        )

    meta["status"] = "assembling"
    _write_meta(settings, upload_id, meta)
    return bytes(buffer), meta


def mark_finalized(
    settings, upload_id: str, *, proposal_id: int, version_no: int
) -> None:
    """标记收尾成功并删除分段文件（meta 保留到 TTL，便于幂等查询）。"""
    meta = _read_meta(settings, upload_id)
    meta["status"] = "finalized"
    meta["proposal_id_final"] = proposal_id
    meta["version_no"] = version_no
    _write_meta(settings, upload_id, meta)
    for part in _upload_dir(settings, upload_id).glob("*.part"):
        part.unlink(missing_ok=True)


def cleanup_expired(settings, now: datetime | None = None) -> int:
    """删除过期/损坏的临时目录，返回删除数量。"""
    now = now or datetime.now(timezone.utc)
    root = _root(settings)
    removed = 0
    for directory in root.iterdir():
        if not directory.is_dir() or not _UPLOAD_ID_RE.match(directory.name):
            continue
        meta_file = directory / "meta.json"
        expires: datetime | None = None
        if meta_file.exists():
            try:
                meta = json.loads(meta_file.read_text(encoding="utf-8"))
                raw_expires = meta.get("expires_at")
                if raw_expires:
                    expires = datetime.fromisoformat(raw_expires)
            except (OSError, ValueError):
                expires = None
        if expires is None or expires <= now:
            shutil.rmtree(directory, ignore_errors=True)
            removed += 1
    return removed
