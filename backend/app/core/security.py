from fastapi import Depends, Header, HTTPException, status

from app.core.config import Settings, get_settings


async def require_api_key(
    x_api_key: str | None = Header(default=None, alias='X-API-Key'),
    authorization: str | None = Header(default=None, alias='Authorization'),
    settings: Settings = Depends(get_settings),
) -> None:
    # Defense-in-depth: also accept `Authorization: Bearer <key>`. Vercel/edge
    # server-to-server fetches may strip the custom `X-API-Key` header, while
    # the standard `Authorization` header is always forwarded by fetch
    # implementations and edge proxies. Existing X-API-Key callers unchanged.
    if authorization and authorization.lower().startswith('bearer '):
        token = authorization[len('Bearer '):].strip()
        if token == settings.api_key:
            return
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail='Invalid API key')
    if not x_api_key:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail='Missing API key')
    if x_api_key != settings.api_key:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail='Invalid API key')
