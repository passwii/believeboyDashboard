"""Database connection for the auto-report-upload service."""

import os
from pathlib import Path
from typing import Generator

from dotenv import load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

# Load .env from the same directory as this file
_env_path = Path(__file__).parent / ".env"
load_dotenv(_env_path)

# Import config so that ENV is evaluated and defaults are set before we read DB url
from config import DATABASE_URL  # noqa: E402

engine = create_engine(DATABASE_URL, pool_pre_ping=True, pool_size=5)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


def get_db() -> Generator[Session, None, None]:
    """Yield a DB session; caller is responsible for closing."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def get_db_session() -> Session:
    """Return a single DB session (for non-context-manager use)."""
    return SessionLocal()
