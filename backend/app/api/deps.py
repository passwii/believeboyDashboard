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


def get_request_operator(x_operator: str | None = Header(default=None, alias='X-Operator')) -> str | None:
    if x_operator is None:
        return None
    value = unquote(x_operator).strip()
    if not value:
        return None
    return value[:255]


def get_request_is_admin(x_is_admin: str | None = Header(default=None, alias='X-Is-Admin')) -> bool:
    if x_is_admin is None:
        return False
    return x_is_admin.strip().lower() in {'1', 'true', 'yes', 'on'}
