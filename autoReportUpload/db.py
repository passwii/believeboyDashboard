"""Database connection for the auto-report-upload service."""

from __future__ import annotations

import logging
import os
import time
from pathlib import Path
from typing import Generator

from sqlalchemy import create_engine, text
from sqlalchemy.exc import DBAPIError, OperationalError
from sqlalchemy.orm import Session, sessionmaker

from config import DATABASE_URL  # noqa: E402

logger = logging.getLogger("autorun.db")

engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=True,
    pool_size=5,
    max_overflow=10,
    pool_recycle=1800,  # 30 min — refresh connections before PostgreSQL kills them
    pool_timeout=30,   # wait up to 30s for a connection from pool
    connect_args={"connect_timeout": 10},  # initial connection timeout
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)

# ── Health check ────────────────────────────────────────────────────────────────


def check_db_health(max_attempts: int = 3, base_delay: float = 2.0) -> bool:
    """Ping the database; returns True if healthy. Retries with exponential backoff."""
    for attempt in range(1, max_attempts + 1):
        try:
            with engine.connect() as conn:
                conn.execute(text("SELECT 1"))
            return True
        except (DBAPIError, OperationalError) as exc:
            logger.warning(
                f"[DB 健康检查] 尝试 {attempt}/{max_attempts} 失败: {exc}"
            )
            if attempt < max_attempts:
                delay = base_delay * (2 ** (attempt - 1))
                logger.info(f"[DB 健康检查] {delay:.1f}s 后重试...")
                time.sleep(delay)
    return False


def reconnect_engine() -> None:
    """Dispose current engine pool and create a fresh one (call after network recovery)."""
    global engine, SessionLocal
    logger.info("[DB] 重建连接池...")
    engine.dispose()
    engine = create_engine(
        DATABASE_URL,
        pool_pre_ping=True,
        pool_size=5,
        max_overflow=10,
        pool_recycle=1800,
        pool_timeout=30,
        connect_args={"connect_timeout": 10},
    )
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    logger.info("[DB] 连接池已重建")


# ── Session helpers ────────────────────────────────────────────────────────────


def get_db() -> Generator[Session, None, None]:
    """Yield a DB session; caller is responsible for closing."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def get_db_session_with_retry(
    max_attempts: int = 3,
    base_delay: float = 2.0,
) -> tuple[Session | None, bool]:
    """
    Return (session, needs_reconnect).
    If connection fails after retries, needs_reconnect=True so caller can ask for a new session.
    """
    for attempt in range(1, max_attempts + 1):
        try:
            session = SessionLocal()
            # Verify the session is usable with a lightweight query
            session.execute(text("SELECT 1"))
            return session, False
        except (DBAPIError, OperationalError) as exc:
            logger.warning(f"[DB Session] 获取会话 {attempt}/{max_attempts} 失败: {exc}")
            if attempt < max_attempts:
                delay = base_delay * (2 ** (attempt - 1))
                logger.info(f"[DB Session] {delay:.1f}s 后重试...")
                time.sleep(delay)
            else:
                # All attempts failed — signal caller to reconnect
                return None, True
    return None, True


def get_db_session() -> Session:
    """Return a single DB session (for non-context-manager use)."""
    return SessionLocal()
