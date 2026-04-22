import base64
from urllib.parse import unquote

from fastapi import Depends
from fastapi import Header
from sqlalchemy.orm import Session

from app.core.security import require_api_key
from app.db.session import get_db


DbSession = Session


def get_db_session(db: Session = Depends(get_db)) -> Session:
    return db


def protected(_: None = Depends(require_api_key)) -> None:
    return None


def _decode_header_value(value: str) -> str:
    if not value:
        return value
    # Try base64 first (front-end encoding for non-ASCII)
    try:
        decoded = base64.b64decode(value).decode('utf-8')
        return decoded
    except Exception:
        pass
    # Fall back to URL decoding
    return unquote(value).strip()


def get_request_operator(x_operator: str | None = Header(default=None, alias='X-Operator')) -> str | None:
    if x_operator is None:
        return None
    value = _decode_header_value(x_operator)
    return value[:255] if value else None


def get_request_is_admin(x_is_admin: str | None = Header(default=None, alias='X-Is-Admin')) -> bool:
    if x_is_admin is None:
        return False
    return x_is_admin.strip().lower() in {'1', 'true', 'yes', 'on'}


def get_request_role_type(x_role_type: str | None = Header(default=None, alias='X-Role-Type')) -> str | None:
    if x_role_type is None:
        return None
    value = _decode_header_value(x_role_type)
    return value[:32] if value else None