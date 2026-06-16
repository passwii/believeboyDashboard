from contextlib import contextmanager

from sqlalchemy import create_engine, event
from sqlalchemy.exc import DisconnectionError, OperationalError
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from app.core.config import get_settings
from app.db.replica import (
    _build_read_engine,
    _force_primary,
    is_breaker_open,
    record_replica_failure,
    record_replica_success,
)


class Base(DeclarativeBase):
    pass


settings = get_settings()

database_url_lower = settings.database_url.lower()

# 根据数据库类型设置连接参数
connect_args = {
    'connect_timeout': 60,
    'options': '-c statement_timeout=120s',
}
if 'sslmode=require' in database_url_lower or 'supabase.co' in database_url_lower:
    connect_args['sslmode'] = 'require'

engine = create_engine(
    settings.database_url,
    future=True,
    pool_pre_ping=True,
    pool_recycle=1800,
    pool_timeout=10,
    pool_size=20,
    max_overflow=20,
    pool_use_lifo=True,
    connect_args=connect_args
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)


# ---------------------------------------------------------------------------
# BEL-55-P5 / BEL-73: read-replica engine, session factory, and dependencies.
# ---------------------------------------------------------------------------
# `read_engine` is None when `database_read_url` is not configured — in that
# case `get_read_db()` simply hands back a primary session (the backward-
# compatible behavior required by BEL-73 验收 2).
read_engine = _build_read_engine()
ReadSessionLocal = (
    sessionmaker(bind=read_engine, autoflush=False, autocommit=False, future=True)
    if read_engine is not None
    else None
)


def _install_read_session_guard(session) -> None:
    """Install a `before_flush` guard that forbids writes on a read-routed session.

    SQLAlchemy 2.0 can issue INSERT/UPDATE/DELETE on a SELECT via autoflush
    of dirty objects in the identity map. We forbid that explicitly so a
    misrouted write surfaces as a clear RuntimeError instead of silently
    writing to a hot-standby (which would fail anyway, but with a less
    actionable error).
    """
    @event.listens_for(session, "before_flush")
    def _block_writes(sess, flush_context, instances):  # noqa: ANN001
        raise RuntimeError(
            "BEL-73: read-routed session attempted a flush "
            "(INSERT/UPDATE/DELETE). Use Depends(get_primary_db) for "
            "endpoints that write, or wrap the call site in force_primary()."
        )


@contextmanager
def force_primary():
    """Pin the current context to primary reads.

    Use this in service code that follows a write in the same request
    (e.g. INSERT then SELECT for the response payload) so the read sees
    the just-committed row rather than waiting for WAL replay.
    """
    token = _force_primary.set(True)
    try:
        yield
    finally:
        _force_primary.reset(token)


def get_primary_db():
    """Primary-only dependency. Sets `_force_primary` for the duration of the request.

    Use for write endpoints or write-after-read scenarios.
    """
    db = SessionLocal()
    token = _force_primary.set(True)
    try:
        yield db
    finally:
        _force_primary.reset(token)
        db.close()


def get_read_db():
    """Read-routed dependency.

    Falls back to the primary engine when:
    - `database_read_url` is blank (replica not configured)
    - `_force_primary` is set (request is pinned to primary)
    - the circuit breaker is open (replica is known to be flaky)
    - the read engine raises OperationalError / DisconnectionError on the
      first statement (mid-request failover — keep the request alive)
    """
    if read_engine is None or _force_primary.get() or is_breaker_open():
        # No replica configured / not allowed to use replica: hand back a
        # primary session. Do NOT set _force_primary here so nested
        # get_read_db() calls inside the same request still get primary
        # (which is what we want — the request is on primary).
        db = SessionLocal()
        try:
            yield db
        finally:
            db.close()
        return

    db = ReadSessionLocal()
    _install_read_session_guard(db)
    try:
        yield db
    except (OperationalError, DisconnectionError) as exc:
        # Mid-request failover: the breaker was closed when we opened the
        # session, but the read engine just failed. Trip the breaker and
        # try the same request against the primary so the user gets 200.
        record_replica_failure()
        logger.warning(
            "BEL-73: read engine failed mid-request, falling back to primary: %s",
            exc,
        )
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
        db.close()
        primary_db = SessionLocal()
        try:
            yield primary_db
        finally:
            primary_db.close()
        return
    finally:
        try:
            db.close()
        except Exception:  # noqa: BLE001
            pass
    # Reached only on a clean exit: clear the breaker.
    record_replica_success()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
