"""客户方案 service（BLF proposal 模块）。

层级：``crm_customers`` → ``crm_proposals`` → ``crm_proposal_versions``。
文件不是独立一层——它是版本的载荷（``raw_r2_key`` / ``adapted_r2_key``），
因为输入约束是「单个 HTML」，一个版本恒等于一个文件。

职责分工（与设计一致）：
- R2 只负责「存」和「发」（字节仓库）；
- 本 service 负责编排：落库 + 上传 + 版本链 + 权限前置校验（权限判定在端点层，
  与原 CRM 惯例一致，见 services/crm/permissions.py）；
- 解析/适配在 ``proposal_render_service``（上传时一次，结果冻结）。

写操作默认 ``commit=False``（仅 flush），由端点统一 commit，
与 CRM P5-6 的「业务写入 + 审计写入原子化」口径一致。
"""

from __future__ import annotations

import logging
from collections.abc import Iterator

from fastapi import HTTPException, UploadFile, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.models.crm import (
    CrmCustomer,
    CrmProposal,
    CrmProposalStatus,
    CrmProposalType,
    CrmProposalVersion,
)
from app.schemas.crm import (
    ProposalItem,
    ProposalVersionItem,
)
from app.services.crm import proposal_render_service as render
from app.services.r2_service import (
    iter_file_from_r2,
    try_delete_file_from_r2,
    upload_bytes_to_r2,
)

logger = logging.getLogger(__name__)

# R2 key 前缀（字节仓库的可读分组；不放客户名/标题，避免改名导致 key 漂移）
R2_PROJECT_SLUG = "crm-proposals"

# 筛选白名单（防注入：未知字段直接 ValueError → 端点转 400）
PROPOSAL_FILTER_FIELDS = ("status", "proposal_type", "customer_id", "owner_id")
# 排序白名单
PROPOSAL_SORT_FIELDS = ("updated_at", "created_at", "title", "current_version_no")

DEFAULT_PAGE_SIZE = 20
MAX_PAGE_SIZE = 100


# ---------------------------------------------------------------------------
# 解码（原文可能不是 UTF-8——中文 HTML 常见 gb2312/gb18030）
# ---------------------------------------------------------------------------


def _decode_html(data: bytes) -> str:
    """把上传的 HTML 字节解成 str。

    顺序：文档自带 ``charset=`` → utf-8 → gb18030 → utf-8(errors=replace)。
    适配产物一律以 UTF-8 重新编码后冻结，因此查看/下载不需要再猜编码。
    """
    head = data[:4096].decode("latin-1", errors="ignore")
    marker = "charset="
    lower = head.lower()
    idx = lower.find(marker)
    if idx != -1:
        rest = head[idx + len(marker) :].strip().strip("\"'")
        charset = rest.split(";")[0].split(">")[0].split()[0].strip().strip("\"'")
        if charset:
            try:
                return data.decode(charset)
            except (LookupError, UnicodeDecodeError):
                pass
    for codec in ("utf-8", "gb18030"):
        try:
            return data.decode(codec)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


# ---------------------------------------------------------------------------
# R2 编排
# ---------------------------------------------------------------------------


def _upload_version_objects(
    *,
    settings: Settings,
    proposal_id: int,
    version_no: int,
    raw_bytes: bytes,
    adapted_bytes: bytes,
    raw_content_type: str,
) -> tuple[str, str]:
    """上传 raw + adapted 两份对象，返回 ``(raw_key, adapted_key)``。

    key 布局：``crm-proposals/{proposal_id}/v{version_no}/raw.html`` /
    ``.../adapted.html``（版本隔离，旧对象永不被覆盖）。
    """
    folder = f"{proposal_id}/v{version_no}"
    raw_result = upload_bytes_to_r2(
        settings,
        raw_bytes,
        "raw.html",
        project_slug=R2_PROJECT_SLUG,
        file_type=folder,
        content_type=raw_content_type or "text/html",
    )
    adapted_result = upload_bytes_to_r2(
        settings,
        adapted_bytes,
        "adapted.html",
        project_slug=R2_PROJECT_SLUG,
        file_type=folder,
        content_type="text/html; charset=utf-8",
    )
    return raw_result["key"], adapted_result["key"]


def _require_r2(settings: Settings) -> None:
    if not settings.r2_enabled:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="云存储未配置，请联系管理员",
        )


def _sanitize_title(raw: str | None, *, fallback: str) -> str:
    """标题清洗：去控制字符 + HTML 语义字符，clamp 200。

    与 page_render_service.sanitize_title 同款口径（标题可能进 <title>）。
    """
    import re

    cleaned = re.sub(r"[\x00-\x1f\x7f<>&]", "", raw or "").strip()
    if not cleaned:
        stem = fallback.rsplit("/", 1)[-1]
        stem = stem.rsplit(".", 1)[0] if "." in stem else stem
        cleaned = re.sub(r"[\x00-\x1f\x7f<>&]", "", stem).strip() or "未命名方案"
    return cleaned[:200]


# ---------------------------------------------------------------------------
# 读
# ---------------------------------------------------------------------------


def _user_names_map(db: Session, ids: set[str]) -> dict[str, str]:
    from sqlalchemy import text

    if not ids:
        return {}
    rows = db.execute(
        text("select id, name from public.user_accounts where id = any(:ids)"),
        {"ids": list(ids)},
    ).all()
    return {str(r[0]): r[1] for r in rows}


def _customer_names_map(db: Session, ids: set[int]) -> dict[int, str]:
    if not ids:
        return {}
    rows = db.execute(
        select(CrmCustomer.id, CrmCustomer.name).where(CrmCustomer.id.in_(ids))
    ).all()
    return {r[0]: r[1] for r in rows}


def _version_to_item(
    version: CrmProposalVersion, user_names: dict[str, str]
) -> ProposalVersionItem:
    return ProposalVersionItem(
        id=version.id,
        version_no=version.version_no,
        original_filename=version.original_filename,
        content_type=version.content_type,
        file_size=version.file_size,
        change_note=version.change_note,
        created_by=version.created_by,
        created_by_name=user_names.get(version.created_by)
        if version.created_by
        else None,
        created_at=version.created_at,
    )


def _to_item(
    proposal: CrmProposal,
    *,
    version_count: int,
    user_names: dict[str, str],
    customer_names: dict[int, str],
) -> ProposalItem:
    return ProposalItem(
        id=proposal.id,
        title=proposal.title,
        proposal_type=proposal.proposal_type,
        status=proposal.status,
        customer_id=proposal.customer_id,
        customer_name=customer_names.get(proposal.customer_id)
        if proposal.customer_id
        else None,
        owner_id=proposal.owner_id,
        owner_name=user_names.get(proposal.owner_id) if proposal.owner_id else None,
        current_version_no=proposal.current_version_no,
        version_count=version_count,
        created_by=proposal.created_by,
        created_at=proposal.created_at,
        updated_at=proposal.updated_at,
    )


def _version_counts(db: Session, proposal_ids: list[int]) -> dict[int, int]:
    if not proposal_ids:
        return {}
    rows = db.execute(
        select(CrmProposalVersion.proposal_id, func.count())
        .where(CrmProposalVersion.proposal_id.in_(proposal_ids))
        .group_by(CrmProposalVersion.proposal_id)
    ).all()
    return {r[0]: int(r[1]) for r in rows}


def get_proposal_orm(db: Session, proposal_id: int) -> CrmProposal | None:
    """原始 ORM 对象（权限校验 / 写操作）。"""
    return db.execute(
        select(CrmProposal).where(CrmProposal.id == proposal_id)
    ).scalar_one_or_none()


def list_versions(db: Session, proposal_id: int) -> list[ProposalVersionItem]:
    """版本链（新→旧）。"""
    rows = (
        db.execute(
            select(CrmProposalVersion)
            .where(CrmProposalVersion.proposal_id == proposal_id)
            .order_by(CrmProposalVersion.version_no.desc())
        )
        .scalars()
        .all()
    )
    user_names = _user_names_map(db, {v.created_by for v in rows if v.created_by})
    return [_version_to_item(v, user_names) for v in rows]


def get_proposal(db: Session, proposal_id: int) -> ProposalItem | None:
    proposal = get_proposal_orm(db, proposal_id)
    if proposal is None:
        return None
    counts = _version_counts(db, [proposal.id])
    user_names = _user_names_map(
        db, {p for p in (proposal.owner_id, proposal.created_by) if p}
    )
    customer_names = _customer_names_map(
        db, {proposal.customer_id} if proposal.customer_id else set()
    )
    return _to_item(
        proposal,
        version_count=counts.get(proposal.id, 0),
        user_names=user_names,
        customer_names=customer_names,
    )


def get_version(
    db: Session, proposal_id: int, version_no: int
) -> CrmProposalVersion | None:
    return db.execute(
        select(CrmProposalVersion).where(
            CrmProposalVersion.proposal_id == proposal_id,
            CrmProposalVersion.version_no == version_no,
        )
    ).scalar_one_or_none()


def get_latest_version(
    db: Session, proposal_id: int
) -> CrmProposalVersion | None:
    return db.execute(
        select(CrmProposalVersion)
        .where(CrmProposalVersion.proposal_id == proposal_id)
        .order_by(CrmProposalVersion.version_no.desc())
        .limit(1)
    ).scalar_one_or_none()


def list_proposals(
    db: Session,
    *,
    user_id: str | None,
    scope: str = "mine",
    filters: dict | None = None,
    keyword: str | None = None,
    sort_by: str = "updated_at",
    sort_order: str = "desc",
    page: int = 1,
    page_size: int = DEFAULT_PAGE_SIZE,
    is_admin: bool = False,
) -> tuple[list[ProposalItem], int]:
    """列表：keyword + 白名单筛选 + 白名单排序 + 分页。

    scope：mine=owner_id==当前用户；all=不加 owner 过滤（端点层已 resolve_scope 降级）。
    """
    cur = (user_id or "").strip() or None
    stmt = select(CrmProposal)
    count_stmt = select(func.count()).select_from(CrmProposal)

    conditions = []
    if scope == "mine":
        conditions.append(CrmProposal.owner_id == cur)

    filters = filters or {}
    for key, value in filters.items():
        if value is None or value == "":
            continue
        if key not in PROPOSAL_FILTER_FIELDS:
            raise ValueError(f"不支持的筛选字段: {key}")
        # 白名单已校验，getattr 取的是 ORM 列对象，非字符串拼接 SQL。
        conditions.append(getattr(CrmProposal, key) == value)

    if keyword:
        conditions.append(CrmProposal.title.ilike(f"%{keyword}%"))

    for cond in conditions:
        stmt = stmt.where(cond)
        count_stmt = count_stmt.where(cond)

    if sort_by not in PROPOSAL_SORT_FIELDS:
        raise ValueError(f"不支持的排序字段: {sort_by}")
    order_col = getattr(CrmProposal, sort_by)
    stmt = stmt.order_by(order_col.asc() if sort_order == "asc" else order_col.desc())

    page = max(1, page)
    page_size = min(max(1, page_size), MAX_PAGE_SIZE)
    stmt = stmt.limit(page_size).offset((page - 1) * page_size)

    rows = list(db.execute(stmt).scalars().all())
    total = int(db.execute(count_stmt).scalar_one())

    counts = _version_counts(db, [r.id for r in rows])
    user_names = _user_names_map(
        db,
        {
            uid
            for r in rows
            for uid in (r.owner_id, r.created_by)
            if uid
        },
    )
    customer_names = _customer_names_map(
        db, {r.customer_id for r in rows if r.customer_id}
    )
    items = [
        _to_item(
            r,
            version_count=counts.get(r.id, 0),
            user_names=user_names,
            customer_names=customer_names,
        )
        for r in rows
    ]
    return items, total


# ---------------------------------------------------------------------------
# 写
# ---------------------------------------------------------------------------


def _assert_customer_visible(
    db: Session, customer_id: int | None, *, user_id: str | None, is_admin: bool
) -> None:
    """关联客户校验：不存在/已删 → 404；非管理员不得挂到别人的客户 → 403。

    客户是软删，故这里显式过滤 ``is_deleted``。
    """
    if customer_id is None:
        return
    customer = db.execute(
        select(CrmCustomer).where(
            CrmCustomer.id == customer_id, CrmCustomer.is_deleted.is_(False)
        )
    ).scalar_one_or_none()
    if customer is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Customer not found"
        )
    if not is_admin and customer.owner_id not in (user_id, None):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Not the customer owner"
        )


def create_proposal(
    db: Session,
    *,
    file: UploadFile,
    title: str | None,
    proposal_type: str,
    customer_id: int | None,
    user_id: str | None,
    is_admin: bool,
    settings: Settings,
    commit: bool = False,
) -> tuple[ProposalItem, ProposalVersionItem, list[str]]:
    """建方案 + 首版（v1）。校验 → 落库 → 上传 R2 → 建版本。

    顺序保证：先 flush 拿到 proposal.id（决定 R2 key），再上传；
    任一步失败由端点 rollback，不会留下半截记录。
    """
    _require_r2(settings)
    if proposal_type not in (
        CrmProposalType.ONBOARDING,
        CrmProposalType.OPERATION,
        CrmProposalType.QUOTATION,
        CrmProposalType.OTHER,
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="无效的方案类型"
        )

    _assert_customer_visible(db, customer_id, user_id=user_id, is_admin=is_admin)

    ext, raw_bytes = render.validate_html_upload(
        file, max_bytes=settings.crm_proposal_max_bytes
    )
    raw_text = _decode_html(raw_bytes)
    warnings = [
        f"检测到相对引用 {ref}：方案只保存单个 HTML，该引用在查看时不可达，"
        "建议内联或改为绝对地址"
        for ref in render.find_unreachable_refs(raw_text)
    ]
    adapted_text = render.adapt_html(raw_text)
    adapted_bytes = adapted_text.encode("utf-8")

    owner_id = (user_id or "").strip() or None
    proposal = CrmProposal(
        title=_sanitize_title(title, fallback=file.filename or "未命名方案"),
        proposal_type=proposal_type,
        status=CrmProposalStatus.DRAFT,
        customer_id=customer_id,
        owner_id=owner_id,
        current_version_no=0,
        created_by=owner_id,
    )
    db.add(proposal)
    db.flush()  # 拿 proposal.id，用于拼 R2 key

    raw_key, adapted_key = _upload_version_objects(
        settings=settings,
        proposal_id=proposal.id,
        version_no=1,
        raw_bytes=raw_bytes,
        adapted_bytes=adapted_bytes,
        raw_content_type=(file.content_type or "").lower(),
    )

    version = CrmProposalVersion(
        proposal_id=proposal.id,
        version_no=1,
        raw_r2_key=raw_key,
        adapted_r2_key=adapted_key,
        adapted_sha256=render.sha256_hex(adapted_bytes),
        original_filename=(file.filename or f"proposal.{ext.lstrip('.')}")[:255],
        content_type=(file.content_type or "text/html")[:64],
        file_size=len(raw_bytes),
        change_note="初始版本",
        created_by=owner_id,
    )
    db.add(version)
    proposal.current_version_no = 1
    db.flush()

    if commit:
        db.commit()

    item = get_proposal(db, proposal.id)
    assert item is not None
    version_item = _version_to_item(version, _user_names_map(db, {owner_id} if owner_id else set()))
    return item, version_item, warnings


def add_version(
    db: Session,
    proposal: CrmProposal,
    *,
    file: UploadFile,
    change_note: str | None,
    user_id: str | None,
    settings: Settings,
    commit: bool = False,
) -> tuple[ProposalVersionItem, list[str]]:
    """给已有方案追加新版本（append-only：旧版本与旧 R2 对象都不动）。"""
    _require_r2(settings)
    ext, raw_bytes = render.validate_html_upload(
        file, max_bytes=settings.crm_proposal_max_bytes
    )
    raw_text = _decode_html(raw_bytes)
    warnings = [
        f"检测到相对引用 {ref}：方案只保存单个 HTML，该引用在查看时不可达，"
        "建议内联或改为绝对地址"
        for ref in render.find_unreachable_refs(raw_text)
    ]
    adapted_bytes = render.adapt_html(raw_text).encode("utf-8")

    next_no = (proposal.current_version_no or 0) + 1
    creator = (user_id or "").strip() or None

    raw_key, adapted_key = _upload_version_objects(
        settings=settings,
        proposal_id=proposal.id,
        version_no=next_no,
        raw_bytes=raw_bytes,
        adapted_bytes=adapted_bytes,
        raw_content_type=(file.content_type or "").lower(),
    )

    version = CrmProposalVersion(
        proposal_id=proposal.id,
        version_no=next_no,
        raw_r2_key=raw_key,
        adapted_r2_key=adapted_key,
        adapted_sha256=render.sha256_hex(adapted_bytes),
        original_filename=(file.filename or f"proposal.{ext.lstrip('.')}")[:255],
        content_type=(file.content_type or "text/html")[:64],
        file_size=len(raw_bytes),
        change_note=(change_note or "").strip()[:500] or None,
        created_by=creator,
    )
    db.add(version)
    proposal.current_version_no = next_no
    db.flush()

    if commit:
        db.commit()

    user_names = _user_names_map(db, {creator} if creator else set())
    return _version_to_item(version, user_names), warnings


def update_proposal(
    db: Session,
    proposal: CrmProposal,
    *,
    data: dict,
    user_id: str | None,
    is_admin: bool,
    commit: bool = False,
) -> ProposalItem:
    """部分更新：title / proposal_type / status / customer_id。"""
    if "customer_id" in data:
        _assert_customer_visible(
            db, data["customer_id"], user_id=user_id, is_admin=is_admin
        )
    for key in ("title", "proposal_type", "status", "customer_id"):
        if key in data:
            value = data[key]
            if key == "title" and value is not None:
                value = _sanitize_title(value, fallback="未命名方案")
            setattr(proposal, key, value)
    db.flush()
    if commit:
        db.commit()
    item = get_proposal(db, proposal.id)
    assert item is not None
    return item


def delete_proposal(
    db: Session,
    proposal: CrmProposal,
    *,
    settings: Settings,
    commit: bool = False,
) -> None:
    """删方案：先尽力删掉全部版本的 R2 对象，再删行（版本随 FK CASCADE 走）。

    R2 删除失败不阻断（登记 r2_delete_failures 由 try_delete_file_from_r2 处理），
    避免对象存储抖动卡死业务删除。
    """
    keys = (
        db.execute(
            select(
                CrmProposalVersion.raw_r2_key, CrmProposalVersion.adapted_r2_key
            ).where(CrmProposalVersion.proposal_id == proposal.id)
        )
        .all()
    )
    for raw_key, adapted_key in keys:
        try_delete_file_from_r2(settings, raw_key, log_failure=True)
        try_delete_file_from_r2(settings, adapted_key, log_failure=True)
    db.delete(proposal)
    db.flush()
    if commit:
        db.commit()


# ---------------------------------------------------------------------------
# 读内容 / 下载
# ---------------------------------------------------------------------------


def read_version_text(
    version: CrmProposalVersion, *, settings: Settings, raw: bool = False
) -> str:
    """把某个版本读成 str（预览用）。

    适配产物恒为 UTF-8；raw 分支沿用原编码，交给调用方处理（预览默认读 adapted）。
    """
    key = version.raw_r2_key if raw else version.adapted_r2_key
    data = b"".join(iter_file_from_r2(settings, key))
    if raw:
        return _decode_html(data)
    return data.decode("utf-8", errors="replace")


def iter_version_bytes(
    version: CrmProposalVersion, *, settings: Settings, raw: bool = False
) -> Iterator[bytes]:
    """流式读取某个版本（下载用；每次请求都过鉴权，不签发免鉴权 URL）。"""
    key = version.raw_r2_key if raw else version.adapted_r2_key
    return iter_file_from_r2(settings, key)


def build_download_filename(
    proposal_title: str, version_no: int, *, raw: bool = False
) -> str:
    """下载文件名：``<标题>-v<N>.html`` / ``<标题>-v<N>-原始.html``。

    Content-Disposition 由端点按 RFC 5987 编码（中文标题不能裸进 header）。
    """
    safe_title = _sanitize_title(proposal_title, fallback="方案")
    suffix = "-原始" if raw else ""
    return f"{safe_title}-v{version_no}{suffix}.html"


__all__ = [
    "PROPOSAL_FILTER_FIELDS",
    "PROPOSAL_SORT_FIELDS",
    "add_version",
    "build_download_filename",
    "create_proposal",
    "delete_proposal",
    "get_latest_version",
    "get_proposal",
    "get_proposal_orm",
    "get_version",
    "iter_version_bytes",
    "list_proposals",
    "list_versions",
    "read_version_text",
    "update_proposal",
]
