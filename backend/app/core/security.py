from fastapi import Depends, Header, HTTPException, Query, status

from app.core.config import Settings, get_settings
from app.db.session import SessionLocal
from app.services.user_api_key_service import resolve_user_key


async def require_api_key(
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
    authorization: str | None = Header(default=None, alias="Authorization"),
    # Last-resort fallback: `?api_key=` query param. Vercel/edge server-to-server
    # `fetch()` strips custom AND standard auth headers (X-API-Key, Authorization)
    # from outgoing requests, but query params are part of the URL and survive.
    # The frontend proxy appends this so defense-in-depth survives header stripping.
    api_key: str | None = Query(default=None, alias="api_key"),
    settings: Settings = Depends(get_settings),
) -> None:
    candidates: list[str] = []
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization[len("Bearer ") :].strip()
        if token:
            candidates.append(token)
    if x_api_key:
        candidates.append(x_api_key)
    if api_key:
        candidates.append(api_key)

    if not candidates:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing API key"
        )

    # 主 key 永远可用（web / Agent 外部调用方零影响）——最热路径，不碰 DB：
    # 即使数据库故障，网页端（代理附加主 key）依然可用。
    for key in candidates:
        if key == settings.api_key:
            return

    # BLF-711：登录按账号下发的专属 key（blf_ 前缀，只存 hash）。只有主 key
    # 未命中时才开会话查表（对齐 external_security.py 的延迟开会话模式），
    # 命中但已吊销 → 403（与无效 key 同语义）。DB 异常 fail closed（403）。
    db = SessionLocal()
    try:
        for key in candidates:
            verdict = resolve_user_key(db, key)
            if verdict.ok:
                return
            if verdict.status == "revoked":
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN, detail="Invalid API key"
                )
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Invalid API key"
        )
    finally:
        db.close()

    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid API key")
