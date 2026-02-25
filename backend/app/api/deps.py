from fastapi import Depends
from sqlalchemy.orm import Session

from app.core.security import require_api_key
from app.db.session import get_db


DbSession = Session


def get_db_session(db: Session = Depends(get_db)) -> Session:
    return db


def protected(_: None = Depends(require_api_key)) -> None:
    return None
