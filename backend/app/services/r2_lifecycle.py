"""R2 lifecycle helpers.

Two responsibilities live here:

(1) record_delete_failure() — used by P1 endpoint patches and P2 ORM hook
    to persist a failed R2 deletion. Writes to r2_delete_failures in an
    isolated short-lived Session (so it cannot poison the calling tx).

(2) [later P2] ORM event hooks for automatic R2 cleanup on session.deleted /
    session.dirty overwrites of *_r2_key columns. The skeleton below
    documents the design — implementation lands in P2.

Why a single module?
- Keeps P1 and P2 code together so a reviewer sees the whole lifecycle in one
  place (~200 lines, not split across r2_service.py + main.py + 8 endpoints).
- The hook registration MUST happen at app startup, not at module import,
  because listeners attached on the Base class only fire once.
"""
from __future__ import annotations

import logging
from typing import Any

from app.core.config import get_settings
from app.db.session import SessionLocal
from app.models.r2_delete_failure import R2DeleteFailure
from app.services.r2_service import R2DeleteResult

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# (1) record_delete_failure — used by P1 endpoint patches
# ---------------------------------------------------------------------------

def record_delete_failure(
    key: str,
    result: R2DeleteResult,
    *,
    source: str,
    context: dict[str, Any] | None = None,
    created_via_hook: bool = False,
) -> int | None:
    """Write a dead-letter row to r2_delete_failures.

    Args:
        key: the R2 object key we tried (and failed) to delete.
        result: the R2DeleteResult from try_delete_file_from_r2
                (must have success=False).
        source: short tag identifying the caller, e.g.
                'subscription_delete' / 'monthly_delete' /
                'platform_revenue_update' / 'orm_hook' / etc.
                Used for filtering / dashboards.
        context: arbitrary JSON-serializable debug context, e.g.
                 {"row_id": 123, "model": "MonthlyReport", "endpoint": "..."}
        created_via_hook: True when called from P2 ORM after_commit hook,
                False (default) when called by an explicit endpoint patch.

    Returns:
        The id of the inserted row, or None if the insert itself failed
        (the outer caller will see the warning in logs but won't crash).

    IMPORTANT:
    - Uses SessionLocal() (an isolated short-lived session), NOT the caller's
      session. If we used the caller's session, a failure to insert would
      poison the caller's transaction.
    - This function is INTENTIONALLY safe to call from inside or outside a
      session context.
    """
    if result.success:
        logger.debug(
            "[r2] record_delete_failure skipped because result.success=True (key=%s)",
            key,
        )
        return None

    try:
        with SessionLocal() as s:
            row = R2DeleteFailure(
                r2_key=key,
                error_class=result.error_class,
                error_message=result.error_message,
                source=source,
                context_json=context,
                created_via_hook=created_via_hook,
            )
            s.add(row)
            s.commit()
            return row.id
    except Exception:
        # If the dead-letter insert itself fails (e.g. DB down), we MUST NOT
        # raise — that would propagate up to the caller and crash the
        # business endpoint.
        logger.exception(
            "[r2] failed to record R2 delete failure (key=%s source=%s)",
            key, source,
        )
        return None


# ---------------------------------------------------------------------------
# (2) ORM hooks (P2 — stub, real implementation lands in P2)
# ---------------------------------------------------------------------------

def _record_failure_safe(key: str, result: R2DeleteResult, *, source: str, context: dict | None = None) -> None:
    """Internal helper used by P2 hook. Same as record_delete_failure but
    assumes created_via_hook=True since that's the call site's nature."""
    record_delete_failure(
        key,
        result,
        source=source,
        context=context,
        created_via_hook=True,
    )
