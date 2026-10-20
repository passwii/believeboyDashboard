"""客户方案（Proposal）端点：上传 / 解析适配 / 版本管理 / 预览 / 下载。

设计要点（见 docs/superpowers/specs/2026-10-17-crm-proposal-page-design.md）：
- 层级：crm_customers → crm_proposals → crm_proposal_versions；文件是版本的载荷。
- R2 私有桶：预览 / 下载都经后端鉴权后转发（**不签发免鉴权的公开 URL**），
  与工具箱的 page-render（公开桶）刻意不同——客户方案含报价/客户信息。
- 权限沿用 CRM owner/admin（services/crm/permissions.py）。
- 所有写操作走 audit_service.record_log，业务写入与审计同事务 commit。
"""

from __future__ import annotations

import json
from urllib.parse import quote

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    UploadFile,
    status,
)
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.api.deps import (
    get_primary_db_session,
    get_read_db_session,
    get_request_is_admin,
    get_request_user_id,
    protected,
)
from app.core.config import Settings, get_settings
from app.schemas.crm import (
    ProposalContentResponse,
    ProposalDetail,
    ProposalItem,
    ProposalListResponse,
    ProposalUpdate,
    ProposalUploadResponse,
)
from app.services.crm import audit_service, proposal_service
from app.services.crm.permissions import (
    require_owner_or_admin,
    require_proposal_readable,
    resolve_proposal_scope,
)

router = APIRouter(
    prefix="/crm/proposals", tags=["crm-proposals"], dependencies=[Depends(protected)]
)


def _parse_filters(filters: str | None) -> list[dict] | None:
    if not filters:
        return None
    try:
        parsed = json.loads(filters)
    except json.JSONDecodeError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="filters 非法 JSON"
        ) from None
    if not isinstance(parsed, list):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="filters 须为 JSON 数组"
        )
    return parsed


def _flatten_filters(raw: list[dict] | None) -> dict:
    """把 FilterCondition 数组压成「字段 → 值」的等值 dict（只支持 eq）。

    方案列表的筛选面很窄（状态 / 类型 / 客户），不需要 filter_engine 的完整
    表达式引擎；非 eq / 嵌套条件直接 400，避免静默忽略筛选条件。
    """
    flat: dict = {}
    for cond in raw or []:
        if not isinstance(cond, dict) or "field" not in cond:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="方案筛选仅支持 {field, op:'eq', value} 形态",
            )
        if cond.get("op") not in (None, "eq"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail="方案筛选仅支持 eq 运算符"
            )
        flat[str(cond["field"])] = cond.get("value")
    return flat


def _require_proposal(db: Session, proposal_id: int):
    proposal = proposal_service.get_proposal_orm(db, proposal_id)
    if proposal is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="方案不存在")
    return proposal


# ---------- 列表 / 详情 ----------


@router.get("", response_model=ProposalListResponse)
def list_proposals(
    scope: str = Query("all"),
    keyword: str | None = Query(None, max_length=200),
    filters: str | None = Query(None),
    sort_by: str = "updated_at",
    sort_order: str = "desc",
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_read_db_session),
    user_id: str | None = Depends(get_request_user_id),
    is_admin: bool = Depends(get_request_is_admin),
):
    """方案列表：scope=mine/all + 白名单筛选/排序。

    方案域**全员可见**（BLF-1403 / BLF-1410）：非 admin 的 ``scope=all`` **不降级**
    （用 ``resolve_proposal_scope``，不动 CRM 全域的 ``resolve_scope`` 私海保护）；
    ``scope=mine`` 仍只看自己名下（前端「我的 / 全部」切换继续可用）。
    """
    try:
        items, total = proposal_service.list_proposals(
            db,
            user_id=user_id,
            scope=resolve_proposal_scope(scope, is_admin),
            filters=_flatten_filters(_parse_filters(filters)),
            keyword=keyword,
            sort_by=sort_by,
            sort_order=sort_order,
            page=page,
            page_size=page_size,
            is_admin=is_admin,
        )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)
        ) from e
    return ProposalListResponse(items=items, total=total, page=page, page_size=page_size)


@router.get("/{proposal_id}", response_model=ProposalDetail)
def get_proposal(
    proposal_id: int,
    db: Session = Depends(get_read_db_session),
    user_id: str | None = Depends(get_request_user_id),
    is_admin: bool = Depends(get_request_is_admin),
):
    """方案详情：含完整版本链；**全员可读**（方案域只读不设 owner 门禁）。"""
    proposal = _require_proposal(db, proposal_id)
    require_proposal_readable(proposal.owner_id, user_id, is_admin)
    item = proposal_service.get_proposal(db, proposal_id)
    assert item is not None
    return ProposalDetail(
        **item.model_dump(),
        versions=proposal_service.list_versions(db, proposal_id),
    )


# ---------- 上传（首版） ----------


@router.post("", response_model=ProposalUploadResponse, status_code=201)
def create_proposal(
    request: Request,
    file: UploadFile = File(...),
    title: str | None = Form(default=None, max_length=200),
    proposal_type: str = Form(default="other"),
    customer_id: int | None = Form(default=None),
    change_note: str | None = Form(default=None),
    db: Session = Depends(get_primary_db_session),
    settings: Settings = Depends(get_settings),
    user_id: str | None = Depends(get_request_user_id),
    is_admin: bool = Depends(get_request_is_admin),
):
    """新建方案并落首版（v1）：解析 → 适配 → 冻结到 R2（raw + adapted）。"""
    try:
        item, version, warnings = proposal_service.create_proposal(
            db,
            file=file,
            title=title,
            proposal_type=proposal_type,
            customer_id=customer_id,
            user_id=user_id,
            is_admin=is_admin,
            settings=settings,
            commit=False,
        )
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:  # 兜底：回滚半截记录后统一报 500
        db.rollback()
        raise HTTPException(status_code=500, detail=f"方案上传失败：{exc}") from exc

    audit_service.record_log(
        db,
        entity_type="proposal",
        entity_id=item.id,
        action="create",
        actor_id=user_id,
        summary=f"新建客户方案 {item.title}（v1）",
    )
    db.commit()
    return ProposalUploadResponse(proposal=item, version=version, warnings=warnings)


# ---------- 上传（新版本） ----------


@router.post("/{proposal_id}/versions", response_model=ProposalUploadResponse, status_code=201)
def add_version(
    proposal_id: int,
    file: UploadFile = File(...),
    change_note: str | None = Form(default=None, max_length=500),
    db: Session = Depends(get_primary_db_session),
    settings: Settings = Depends(get_settings),
    user_id: str | None = Depends(get_request_user_id),
    is_admin: bool = Depends(get_request_is_admin),
):
    """给已有方案追加新版本（append-only，旧版本与旧 R2 对象不动）。"""
    proposal = _require_proposal(db, proposal_id)
    require_owner_or_admin(proposal.owner_id, user_id, is_admin)

    try:
        version, warnings = proposal_service.add_version(
            db,
            proposal,
            file=file,
            change_note=change_note,
            user_id=user_id,
            settings=settings,
            commit=False,
        )
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        raise HTTPException(status_code=500, detail=f"版本上传失败：{exc}") from exc

    item = proposal_service.get_proposal(db, proposal_id)
    assert item is not None
    audit_service.record_log(
        db,
        entity_type="proposal",
        entity_id=proposal_id,
        action="update",
        actor_id=user_id,
        summary=f"上传方案新版本 v{version.version_no}",
    )
    db.commit()
    return ProposalUploadResponse(proposal=item, version=version, warnings=warnings)


# ---------- 更新 / 删除 ----------


@router.patch("/{proposal_id}", response_model=ProposalItem)
def update_proposal(
    proposal_id: int,
    payload: ProposalUpdate,
    db: Session = Depends(get_primary_db_session),
    user_id: str | None = Depends(get_request_user_id),
    is_admin: bool = Depends(get_request_is_admin),
):
    """改 标题 / 类型 / 状态 / 关联客户；owner/admin 可写。"""
    proposal = _require_proposal(db, proposal_id)
    require_owner_or_admin(proposal.owner_id, user_id, is_admin)

    data = payload.model_dump(exclude_unset=True)
    before = {k: getattr(proposal, k, None) for k in data}
    try:
        item = proposal_service.update_proposal(
            db,
            proposal,
            data=data,
            user_id=user_id,
            is_admin=is_admin,
            commit=False,
        )
    except HTTPException:
        db.rollback()
        raise

    changed = ", ".join(
        f"{k}: {before.get(k)} → {data.get(k)}"
        for k in data
        if before.get(k) != data.get(k)
    )
    audit_service.record_log(
        db,
        entity_type="proposal",
        entity_id=proposal_id,
        action="status" if "status" in data else "update",
        actor_id=user_id,
        summary=f"编辑方案 {item.title}" + (f"（{changed}）" if changed else ""),
    )
    db.commit()
    return item


@router.delete("/{proposal_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_proposal(
    proposal_id: int,
    db: Session = Depends(get_primary_db_session),
    settings: Settings = Depends(get_settings),
    user_id: str | None = Depends(get_request_user_id),
    is_admin: bool = Depends(get_request_is_admin),
):
    """删方案（含全部版本 + 尽力删 R2 对象）；owner/admin 可删。"""
    proposal = _require_proposal(db, proposal_id)
    require_owner_or_admin(proposal.owner_id, user_id, is_admin)
    title = proposal.title
    proposal_service.delete_proposal(db, proposal, settings=settings, commit=False)
    audit_service.record_log(
        db,
        entity_type="proposal",
        entity_id=proposal_id,
        action="delete",
        actor_id=user_id,
        summary=f"删除客户方案 {title}",
    )
    db.commit()


# ---------- 预览 / 下载 ----------


@router.get(
    "/{proposal_id}/versions/{version_no}/content",
    response_model=ProposalContentResponse,
)
def get_version_content(
    proposal_id: int,
    version_no: int,
    raw: bool = Query(False, description="true = 返回原始上传版（未注入主题）"),
    db: Session = Depends(get_read_db_session),
    settings: Settings = Depends(get_settings),
    user_id: str | None = Depends(get_request_user_id),
    is_admin: bool = Depends(get_request_is_admin),
):
    """预览内容：返回 HTML 文本，前端塞进 sandbox iframe 的 srcDoc。

    内容从 R2 读出后经后端鉴权转发——**不返回公开 URL**。
    方案域**全员可读**（BLF-1403 / BLF-1410），故只读不设 owner 门禁。
    """
    proposal = _require_proposal(db, proposal_id)
    require_proposal_readable(proposal.owner_id, user_id, is_admin)
    version = proposal_service.get_version(db, proposal_id, version_no)
    if version is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="版本不存在")
    content = proposal_service.read_version_text(version, settings=settings, raw=raw)
    return ProposalContentResponse(
        proposal_id=proposal_id,
        version_no=version_no,
        title=proposal.title,
        content=content,
    )


@router.get("/{proposal_id}/versions/{version_no}/download")
def download_version(
    proposal_id: int,
    version_no: int,
    raw: bool = Query(False, description="true = 下载原始上传版（交付保真）"),
    db: Session = Depends(get_read_db_session),
    settings: Settings = Depends(get_settings),
    user_id: str | None = Depends(get_request_user_id),
    is_admin: bool = Depends(get_request_is_admin),
):
    """下载某个版本（仍是单个 HTML 文件）。

    默认下载「适配版」（带本项目主题令牌，仍自包含单文件）；
    ``raw=1`` 下载「原始上传版」（保真交付 / 审计）。响应流式转发 + 鉴权。
    方案域**全员可读**（BLF-1403 / BLF-1410），故只读不设 owner 门禁。
    """
    proposal = _require_proposal(db, proposal_id)
    require_proposal_readable(proposal.owner_id, user_id, is_admin)
    version = proposal_service.get_version(db, proposal_id, version_no)
    if version is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="版本不存在")

    filename = proposal_service.build_download_filename(
        proposal.title, version_no, raw=raw
    )
    disposition = (
        f"attachment; filename=\"fallback.html\"; "
        f"filename*=UTF-8''{quote(filename)}"
    )
    return StreamingResponse(
        proposal_service.iter_version_bytes(version, settings=settings, raw=raw),
        media_type="text/html; charset=utf-8",
        headers={
            "Content-Disposition": disposition,
            "Cache-Control": "private, no-store",
        },
    )


__all__ = ["router"]
