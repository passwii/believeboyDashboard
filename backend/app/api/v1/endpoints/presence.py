from datetime import datetime, timezone
from urllib.parse import unquote

from fastapi import APIRouter, Depends, Header, Query
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, protected
from app.schemas.presence import PresenceHeartbeatRequest, PresenceResponse
from app.services.presence_service import list_active_presence, upsert_presence

router = APIRouter(
    prefix="/system-management/presence",
    tags=["presence"],
    dependencies=[Depends(protected)],
)


def get_request_user_id(
    x_user_id: str | None = Header(default=None, alias="X-User-Id"),
) -> str | None:
    value = (x_user_id or "").strip()
    return value[:255] if value else None


def get_request_user_name(
    x_user_name: str | None = Header(default=None, alias="X-User-Name"),
) -> str | None:
    value = unquote((x_user_name or "")).strip()
    return value[:255] if value else None


def get_request_user_email(
    x_user_email: str | None = Header(default=None, alias="X-User-Email"),
) -> str | None:
    value = unquote((x_user_email or "")).strip()
    return value[:255] if value else None


def _get_server_time(db: Session | None) -> str:
    if db is not None:
        try:
            return str(db.execute(text("select current_timestamp")).scalar_one())
        except Exception:
            pass
    return datetime.now(timezone.utc).isoformat()


@router.post("/heartbeat", response_model=PresenceResponse)
def heartbeat(
    payload: PresenceHeartbeatRequest,
    db: Session = Depends(get_db_session),
    user_id: str | None = Depends(get_request_user_id),
    user_name: str | None = Depends(get_request_user_name),
    user_email: str | None = Depends(get_request_user_email),
) -> PresenceResponse:
    if user_id and user_name:
        upsert_presence(
            db,
            user_id=user_id,
            display_name=user_name,
            email=user_email,
            avatar_url=None,
            current_path=payload.current_path,
            current_page_title=payload.current_page_title,
        )

    return PresenceResponse(
        server_time=_get_server_time(db),
        items=list_active_presence(db, current_user_id=user_id, stale_after_seconds=90),
    )


@router.get("", response_model=PresenceResponse)
def get_presence(
    stale_after_seconds: int = Query(default=90, ge=30, le=300),
    db: Session = Depends(get_db_session),
    user_id: str | None = Depends(get_request_user_id),
) -> PresenceResponse:
    return PresenceResponse(
        server_time=_get_server_time(db),
        items=list_active_presence(
            db, current_user_id=user_id, stale_after_seconds=stale_after_seconds
        ),
    )
