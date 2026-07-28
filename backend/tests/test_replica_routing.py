"""Tests for the BEL-55-P5 / BEL-73 read replica routing layer.

Coverage:
- `database_read_url` blank → `get_read_db()` returns a primary session.
- `database_read_url` set + `force_primary()` not active → `get_read_db()`
  returns the read session.
- `database_read_url` set + `force_primary()` active → `get_read_db()`
  returns a primary session even when the replica is configured.
- `get_primary_db()` always sets `_force_primary` so a subsequent
  `get_read_db()` call inside the same request stays on primary.
- The `before_flush` guard raises on ORM writes against a read session.
- The circuit breaker: 5 consecutive failures → `is_breaker_open()` True;
  after `replica_cooldown_seconds` elapses, the breaker returns to
  half-open (False).
- `record_replica_success()` clears the breaker counter.
- `force_primary()` is a no-op (does not raise) and resets after exit.

We use SQLite for the actual session binding (no Postgres required) and
mock `pool_pre_ping` indirectly via the `_build_read_engine` factory being
patched in tests. This is the same pattern as the existing in-memory
SQLite tests in `tests/services/`.
"""

from __future__ import annotations

import time
from typing import Any
from unittest.mock import patch

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from app.core.config import Settings
from app.db import replica as replica_module
from app.db import session as session_module
from app.db.replica import (
    _build_read_engine,
    _force_primary,
    get_breaker_snapshot,
    is_breaker_open,
    record_replica_failure,
    record_replica_success,
    reset_breaker,
)
from app.db.session import (
    ReadSessionLocal,
    force_primary,
    get_primary_db,
    get_read_db,
)


def _settings(
    *,
    read_url: str = "",
    db_read_pool_size: int = 5,
    db_read_max_overflow: int = 5,
) -> Settings:
    return Settings(
        _env_file=None,
        database_url="postgresql+psycopg://x:x@localhost:5432/x",
        database_read_url=read_url,
        redis_host="localhost",
        redis_port=6379,
        redis_db=0,
        db_read_pool_size=db_read_pool_size,
        db_read_max_overflow=db_read_max_overflow,
    )


def _sqlite_engine() -> Any:
    return create_engine("sqlite:///:memory:", future=True)


@pytest.fixture(autouse=True)
def _reset_breaker():
    """Reset breaker + force_primary marker between tests."""
    reset_breaker()
    _force_primary.set(False)
    yield
    reset_breaker()
    _force_primary.set(False)


# ---------------------------------------------------------------------------
# Engine construction
# ---------------------------------------------------------------------------
def test_build_read_engine_returns_none_when_url_blank() -> None:
    with patch.object(session_module, "settings", _settings(read_url="")):
        assert _build_read_engine() is None


def test_build_read_engine_returns_engine_when_url_set() -> None:
    """`_build_read_engine` reads settings via `get_settings()`; we patch
    that function (not the module-level `settings` attribute)."""
    fake_settings = _settings(
        read_url="postgresql+psycopg://x:x@replica:5432/x",
        db_read_pool_size=20,
        db_read_max_overflow=20,
    )
    with patch("app.db.replica.get_settings", return_value=fake_settings):
        engine = _build_read_engine()
    assert engine is not None
    # Pool sizes from config should be applied.
    assert engine.pool.size() == 20
    assert engine.pool._max_overflow == 20  # type: ignore[attr-defined]


def test_build_read_engine_includes_idle_in_txn_timeout() -> None:
    """The read engine should carry `idle_in_transaction_session_timeout` so
    a long-lived read transaction on the replica doesn't block VACUUM
    (BEL-73 risk R6).

    We spy on `app.db.replica.create_engine` to capture the connect_args
    dict that `_build_read_engine` constructed.
    """
    fake_settings = _settings(read_url="postgresql+psycopg://x:x@replica:5432/x")

    captured: dict[str, object] = {}

    def _spy_create_engine(url, **kwargs):
        captured.update(kwargs)
        # Return a fresh engine built without our spy to keep things
        # working if downstream code tries to use it.
        return _sqlite_engine()

    with patch("app.db.replica.create_engine", side_effect=_spy_create_engine):
        with patch("app.db.replica.get_settings", return_value=fake_settings):
            from app.db.replica import _build_read_engine as helper

            helper()
    assert "connect_args" in captured
    connect_args = captured["connect_args"]
    assert "options" in connect_args
    opts = connect_args["options"]
    assert "statement_timeout=120s" in opts
    assert "idle_in_transaction_session_timeout=60s" in opts


# ---------------------------------------------------------------------------
# get_read_db routing
# ---------------------------------------------------------------------------
def test_get_read_db_returns_primary_when_replica_not_configured() -> None:
    """Backward compat: blank DATABASE_READ_URL → reads still go to primary."""
    fake_settings = _settings(read_url="")
    with patch("app.db.replica.get_settings", return_value=fake_settings):
        with patch.object(session_module, "read_engine", None):
            with patch.object(session_module, "ReadSessionLocal", None):
                gen = get_read_db()
                db = next(gen)
                # The bound engine is the primary one.
                assert db.get_bind() is session_module.engine
                gen.close()


def test_get_read_db_returns_read_session_when_replica_configured() -> None:
    sqlite = _sqlite_engine()
    read_session_factory = sessionmaker(
        bind=sqlite, autoflush=False, autocommit=False, future=True
    )
    with patch.object(session_module, "read_engine", sqlite):
        with patch.object(session_module, "ReadSessionLocal", read_session_factory):
            with patch.object(replica_module, "is_breaker_open", lambda: False):
                with patch.object(replica_module, "_force_primary", _force_primary):
                    gen = get_read_db()
                    db = next(gen)
                    assert db.get_bind() is sqlite
                    gen.close()


def test_get_read_db_falls_back_to_primary_when_force_primary_set() -> None:
    """`force_primary()` pins the current context to primary reads."""
    sqlite = _sqlite_engine()
    read_session_factory = sessionmaker(
        bind=sqlite, autoflush=False, autocommit=False, future=True
    )
    primary_engine = _sqlite_engine()
    primary_factory = sessionmaker(
        bind=primary_engine, autoflush=False, autocommit=False, future=True
    )

    with patch.object(session_module, "engine", primary_engine):
        with patch.object(session_module, "SessionLocal", primary_factory):
            with patch.object(session_module, "read_engine", sqlite):
                with patch.object(
                    session_module, "ReadSessionLocal", read_session_factory
                ):
                    with patch.object(replica_module, "is_breaker_open", lambda: False):
                        with force_primary():
                            gen = get_read_db()
                            db = next(gen)
                            # Should be primary, not read.
                            assert db.get_bind() is primary_engine
                            gen.close()


def test_force_primary_context_manager_resets_marker() -> None:
    """force_primary() is balanced — marker is reset after the with-block."""
    with force_primary():
        assert _force_primary.get() is True
    assert _force_primary.get() is False


def test_get_primary_db_sets_force_primary_marker() -> None:
    """`get_primary_db()` is an async generator; FastAPI detects it via
    `inspect.isasyncgenfunction` and drives it through
    `asynccontextmanager` + `enter_async_context`. This test exercises
    the same path: drive the gen manually inside an asyncio task, with
    the marker on, then close it cleanly.
    """
    import asyncio

    primary_factory = sessionmaker(
        bind=_sqlite_engine(), autoflush=False, autocommit=False, future=True
    )
    with patch.object(session_module, "SessionLocal", primary_factory):

        async def _drive() -> None:
            gen = get_primary_db()
            db = await gen.__anext__()
            try:
                # Inside the gen, the marker is True.
                assert _force_primary.get() is True
            finally:
                await gen.aclose()

        asyncio.run(_drive())
    # After the gen closes, the marker is reset.
    assert _force_primary.get() is False


def test_get_primary_db_async_dep_works_under_fastapi_path() -> None:
    """BEL-126 regression: `get_primary_db` is an async generator
    (no `@asynccontextmanager`) so `inspect.isasyncgenfunction` is True
    and FastAPI's `solve_generator` routes it through
    `asynccontextmanager(call)()` + `enter_async_context` (no thread
    copy, no cross-context reset).

    The previous sync-contextmanager shape triggered
    `ValueError: Token was created in a different Context` on
    `PATCH /api/v1/shipment-schedules/{id}` because
    `contextmanager_in_threadpool` ran `__enter__` and `__exit__` in
    two separate `anyio.to_thread.run_sync` calls (each its own
    `contextvars.copy_context()` snapshot).
    """
    import asyncio
    import contextlib
    import inspect

    # Sanity: the function is detected as an async generator, so
    # FastAPI's `is_async_gen_callable` returns True and the request
    # will route through the async path, not the broken sync-cm path.
    assert inspect.isasyncgenfunction(get_primary_db)
    # And it is NOT a sync contextmanager (which would route through
    # `contextmanager_in_threadpool` and trigger the original bug).
    assert not inspect.isgeneratorfunction(get_primary_db)

    primary_factory = sessionmaker(
        bind=_sqlite_engine(), autoflush=False, autocommit=False, future=True
    )
    with patch.object(session_module, "SessionLocal", primary_factory):

        async def _drive() -> None:
            # This mirrors what FastAPI does for an async gen dep:
            # wrap with `asynccontextmanager`, then `enter_async_context`.
            cm = contextlib.asynccontextmanager(get_primary_db)()
            db = await cm.__aenter__()
            try:
                # Inside the request handler, the marker is set.
                assert _force_primary.get() is True
            finally:
                # Exit runs in the same async task context as enter;
                # the token is still valid here.
                await cm.__aexit__(None, None, None)

        asyncio.run(_drive())

    # After the request finishes, the marker is reset to default.
    assert _force_primary.get() is False


def test_get_primary_db_via_contextmanager_in_threadpool_raises() -> None:
    """BEL-126 documentation: confirm the OLD path (sync contextmanager
    driven via `contextmanager_in_threadpool`) still raises the
    cross-context `ValueError`. This is the failure mode we are
    guarding against by switching to async gen.
    """
    import asyncio
    from contextlib import contextmanager

    from fastapi.concurrency import contextmanager_in_threadpool

    @contextmanager
    def _sync_cm():
        from app.db.replica import _force_primary as marker

        token = marker.set(True)
        try:
            yield None
        finally:
            marker.reset(token)

    async def _drive() -> None:
        cm = contextmanager_in_threadpool(_sync_cm())
        await cm.__aenter__()
        # The exit is what raises when the inner cm's `reset` is
        # called from a `copy_context()` that does not own the token.
        with pytest.raises(ValueError, match="different Context"):
            await cm.__aexit__(None, None, None)

    asyncio.run(_drive())


def test_force_primary_resets_marker_after_with_block() -> None:
    """BEL-126: `force_primary()` is still a sync contextmanager, but
    its `__exit__` is now safe under cross-context reset (the value
    will be cleaned up when the request Context ends).
    """
    with force_primary():
        assert _force_primary.get() is True
    assert _force_primary.get() is False


def test_force_primary_swallows_cross_context_reset() -> None:
    """BEL-126: if `force_primary()` is used inside a sync function that
    is later driven by `anyio.to_thread.run_sync` (so `__exit__` ends
    up in a different `copy_context()`), the cross-context `reset`
    raises `ValueError`. The fix swallows it; the value will be
    released when the Context the `set` ran in is torn down.
    """
    import anyio
    import asyncio

    cm = force_primary()
    cm.__enter__()
    try:
        assert _force_primary.get() is True

        # Drive the exit through anyio's threadpool. anyio runs sync
        # callables in a `copy_context()` snapshot that is NOT the
        # one `__enter__` ran in. The old code raised `ValueError`
        # here; the new code swallows it.
        async def _drive_exit() -> None:
            await anyio.to_thread.run_sync(cm.__exit__, None, None, None)

        asyncio.run(_drive_exit())
    finally:
        # Reset the marker in the current (test) context so the
        # autouse fixture's assertion on cleanup passes.
        _force_primary.set(False)


# ---------------------------------------------------------------------------
# before_flush guard
# ---------------------------------------------------------------------------
def test_before_flush_guard_raises_on_read_session() -> None:
    """Adding an ORM object to a read-routed session raises RuntimeError on flush.

    This is the fail-loud safety net for misrouted writes (e.g. someone
    switches a write handler to `get_read_db_session` by accident).
    """
    from sqlalchemy import Column, Integer

    from app.db.session import Base

    class _Tiny(Base):
        __tablename__ = "tiny_for_guard_test"
        id = Column(Integer, primary_key=True)

    engine = _sqlite_engine()
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    # The guard is installed per-session. We exercise it directly:
    db = factory()
    try:
        session_module._install_read_session_guard(db)
        with pytest.raises(RuntimeError, match="read-routed session attempted a flush"):
            db.add(_Tiny(id=1))
            db.flush()
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Circuit breaker
# ---------------------------------------------------------------------------
def test_breaker_starts_closed() -> None:
    assert is_breaker_open() is False
    assert get_breaker_snapshot()["consecutive_failures"] == 0


def test_breaker_opens_after_threshold_failures() -> None:
    for _ in range(5):
        record_replica_failure()
    assert is_breaker_open() is True
    assert get_breaker_snapshot()["consecutive_failures"] == 5


def test_breaker_resets_after_cooldown(monkeypatch) -> None:
    """After `replica_cooldown_seconds` elapses, the breaker returns to
    half-open (returns False so the next request tries the replica)."""
    # Lower the cooldown so the test doesn't have to sleep 30s.
    # We patch the module-level state directly.
    with patch.object(replica_module, "_consecutive_failures", 5):
        with patch.object(replica_module, "_last_failure_ts", time.monotonic() - 100):
            # Cooldown (default 30) has elapsed → breaker is half-open.
            assert is_breaker_open() is False


def test_record_replica_success_clears_counter() -> None:
    for _ in range(3):
        record_replica_failure()
    assert get_breaker_snapshot()["consecutive_failures"] == 3
    record_replica_success()
    assert get_breaker_snapshot()["consecutive_failures"] == 0
    assert is_breaker_open() is False


def test_breaker_resets_via_helper() -> None:
    record_replica_failure()
    record_replica_failure()
    reset_breaker()
    assert get_breaker_snapshot()["consecutive_failures"] == 0
    assert is_breaker_open() is False
