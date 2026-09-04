import base64
from urllib.parse import unquote

from fastapi import Depends
from fastapi import Header
from sqlalchemy.orm import Session

from app.core.security import require_api_key
from app.db.session import get_db, get_primary_db, get_read_db


DbSession = Session


def get_db_session(db: Session = Depends(get_db)) -> Session:
    return db


def get_read_db_session(db: Session = Depends(get_read_db)) -> Session:
    """Read-routed session. Use for pure-GET handlers (BEL-55-P5 / BEL-73).

    When `database_read_url` is blank this transparently returns a primary
    session, so endpoints can adopt it without breaking the no-replica path.
    """
    return db


def get_primary_db_session(db: Session = Depends(get_primary_db)) -> Session:
    """Primary-only session. Use for write handlers and write-after-read."""
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


def get_request_operator(
    x_operator: str | None = Header(default=None, alias='X-Operator'),
    x_user_name: str | None = Header(default=None, alias='X-User-Name'),
) -> str | None:
    raw_value = x_operator if x_operator is not None else x_user_name
    if raw_value is None:
        return None
    value = _decode_header_value(raw_value)
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


def get_request_user_id(
    x_user_id: str | None = Header(default=None, alias='X-User-Id'),
) -> str | None:
    """Read the authenticated user id from the proxy-injected ``X-User-Id`` header.

    Returns None when missing so individual endpoints can decide whether to
    raise 401 (vs. treating it as anonymous, e.g. health checks).
    """
    if x_user_id is None:
        return None
    value = _decode_header_value(x_user_id)
    return value[:64] if value else None
