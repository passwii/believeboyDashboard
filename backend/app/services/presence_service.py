from datetime import datetime
from typing import Any

from app.core.config import get_settings
from app.services import infra as redis_service


DEFAULT_AVATAR_URL = "/avatars/default.svg"


def upsert_presence(
    db: Any = None,
    *,
    user_id: str,
    display_name: str,
    email: str | None,
    avatar_url: str | None,
    current_path: str,
    current_page_title: str,
) -> None:
    settings = get_settings()
    if not settings.redis_host:
        return

    redis_service.set_user_presence(
        user_id=user_id,
        display_name=display_name,
        email=email,
        avatar_url=avatar_url or DEFAULT_AVATAR_URL,
        current_path=current_path,
        current_page_title=current_page_title,
    )


def list_active_presence(
    db: Any = None,
    *,
    current_user_id: str | None,
    stale_after_seconds: int = 90,
) -> list[dict[str, Any]]:
    settings = get_settings()
    if not settings.redis_host:
        return []

    safe_seconds = max(30, min(stale_after_seconds, 300))
    items = redis_service.get_all_presence(stale_after_seconds=safe_seconds)

    return [
        {
            "user_id": str(item["user_id"]),
            "display_name": str(item["display_name"]),
            "email": item.get("email"),
            "avatar_url": item.get("avatar_url") or DEFAULT_AVATAR_URL,
            "current_path": str(item["current_path"]),
            "current_page_title": str(item["current_page_title"]),
            "last_seen_at": str(item["last_seen_at"]),
            "is_current_user": current_user_id is not None
            and str(item["user_id"]) == current_user_id,
        }
        for item in items
    ]
