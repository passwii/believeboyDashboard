"""Markdown/HTML page-render endpoints.

Layout: a single router WITHOUT router-level `protected`, so the public
read endpoint (GET /public/{id}) can sit alongside the authed ones without
inheriting an API-key gate.

- POST   /upload                — authed, multipart upload → R2 + DB
- GET    /history               — authed, owner-scoped paginated list
- DELETE /{page_id}             — authed, owner-scoped (404 for non-owners)
- GET    /public/{page_id}      — public (only API key + rate limit), metadata only
"""
from __future__ import annotations

from fastapi import (
    APIRouter,
    Depends,
    Form,
    HTTPException,
    Query,
    Request,
    UploadFile,
    File,
)
from fastapi.responses import JSONResponse
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from sqlalchemy.orm import Session

from app.api.deps import (
    get_primary_db_session,
    get_read_db_session,
    get_request_operator,
    get_request_user_id,
    protected,
)
from app.core.config import Settings, get_settings
from app.core.security import require_api_key
from app.schemas.page_render import (
    PageRenderHistoryResponse,
    PageRenderPublicResponse,
    UploadedPageResponse,
)
from app.services import page_render_service
from app.services.audit_log_service import append_operation_audit_log


router = APIRouter(prefix="/page-render", tags=["page-render"])

# A fresh Limiter per module is fine — slowapi shares state via app.state.limiter.
_limiter = Limiter(key_func=get_remote_address, default_limits=[])


def _resolve_owner_user_id(user_id: str | None) -> int:
    """X-User-Id is injected by the Next proxy. Fall back to 0 when missing
    (defensive — should never happen behind the proxy)."""
    if user_id and user_id.isdigit():
        return int(user_id)
    return 0


@router.post(
    "/upload",
    response_model=UploadedPageResponse,
    status_code=201,
    dependencies=[Depends(protected)],
)
def upload(
    request: Request,
    file: UploadFile = File(...),
    title: str | None = Form(default=None),
    db: Session = Depends(get_primary_db_session),
    settings: Settings = Depends(get_settings),
    operator: str | None = Depends(get_request_operator),
    user_id: str | None = Depends(get_request_user_id),
):
    owner_user_id = _resolve_owner_user_id(user_id)

    try:
        page = page_render_service.save_uploaded_page(
            db=db,
            settings=settings,
            file=file,
            owner_user_id=owner_user_id,
            title=title,
        )
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 — surface as 500 with audit
        append_operation_audit_log(
            db,
            action="page_render.upload",
            target_type="uploaded_page",
            target_id=None,
            operator=operator,
            result="failure",
            error_message=str(exc),
            request=request,
        )
        db.rollback()
        raise HTTPException(status_code=500, detail="上传失败") from exc

    append_operation_audit_log(
        db,
        action="page_render.upload",
        target_type="uploaded_page",
        target_id=page.id,
        operator=operator,
        request=request,
    )
    db.commit()
    return UploadedPageResponse.model_validate(page, from_attributes=True)


@router.get(
    "/history",
    response_model=PageRenderHistoryResponse,
    dependencies=[Depends(protected)],
)
def history(
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_read_db_session),
    user_id: str | None = Depends(get_request_user_id),
):
    owner_user_id = _resolve_owner_user_id(user_id)
    rows = page_render_service.list_user_pages(db, owner_user_id, limit, offset)
    total = page_render_service.count_user_pages(db, owner_user_id)
    return PageRenderHistoryResponse(
        items=[UploadedPageResponse.model_validate(r, from_attributes=True) for r in rows],
        total=total,
    )


@router.delete(
    "/{page_id}",
    status_code=204,
    dependencies=[Depends(protected)],
)
def delete_page(
    page_id: str,
    request: Request,
    db: Session = Depends(get_primary_db_session),
    settings: Settings = Depends(get_settings),
    operator: str | None = Depends(get_request_operator),
    user_id: str | None = Depends(get_request_user_id),
):
    page = page_render_service.get_page_by_id(db, page_id)
    if not page:
        raise HTTPException(status_code=404, detail="页面不存在")

    owner_user_id = _resolve_owner_user_id(user_id)
    if page.owner_user_id != owner_user_id:
        # Treat foreign access as not-found to avoid leaking record existence.
        raise HTTPException(status_code=404, detail="页面不存在")

    page_render_service.delete_uploaded_page(db=db, settings=settings, page=page)
    append_operation_audit_log(
        db,
        action="page_render.delete",
        target_type="uploaded_page",
        target_id=page_id,
        operator=operator,
        request=request,
    )
    db.commit()
    return None


# ---------- Public endpoint (no user context, API key + rate limit only) ----------

@router.get(
    "/public/{page_id}",
    response_model=PageRenderPublicResponse,
    dependencies=[Depends(require_api_key)],
)
@_limiter.limit("30/minute")
def public_page(
    request: Request,  # required by slowapi's @limiter.limit
    page_id: str,
    db: Session = Depends(get_read_db_session),
    settings: Settings = Depends(get_settings),
):
    page = page_render_service.get_page_by_id(db, page_id)
    if not page:
        raise HTTPException(status_code=404, detail="页面不存在")
    return PageRenderPublicResponse(
        id=page.id,
        title=page.title,
        source_format=page.source_format,
        public_url=page.public_url,
    )


__all__ = ["router"]