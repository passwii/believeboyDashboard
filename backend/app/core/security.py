from fastapi import Depends, Header, HTTPException, Query, status

from app.core.config import Settings, get_settings


async def require_api_key(
    x_api_key: str | None = Header(default=None, alias='X-API-Key'),
    authorization: str | None = Header(default=None, alias='Authorization'),
    # Last-resort fallback: `?api_key=` query param. Vercel/edge server-to-server
    # `fetch()` strips custom AND standard auth headers (X-API-Key, Authorization)
    # from outgoing requests, but query params are part of the URL and survive.
    # The frontend proxy appends this so defense-in-depth survives header stripping.
    api_key: str | None = Query(default=None, alias='api_key'),
    settings: Settings = Depends(get_settings),
) -> None:
    candidates: list[str] = []
    if authorization and authorization.lower().startswith('bearer '):
        token = authorization[len('Bearer '):].strip()
        if token:
            candidates.append(token)
    if x_api_key:
        candidates.append(x_api_key)
    if api_key:
        candidates.append(api_key)

    if not candidates:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail='Missing API key')
    for key in candidates:
        if key == settings.api_key:
            return
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail='Invalid API key')
