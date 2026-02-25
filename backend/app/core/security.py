from fastapi import Depends, Header, HTTPException, status

from app.core.config import Settings, get_settings


async def require_api_key(
    x_api_key: str | None = Header(default=None, alias='X-API-Key'),
    settings: Settings = Depends(get_settings),
) -> None:
    if not x_api_key:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail='Missing API key')
    if x_api_key != settings.api_key:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail='Invalid API key')
