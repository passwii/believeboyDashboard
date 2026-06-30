"""Tests for P1 endpoint patches: subscription DELETE (LEAK-001) + user DELETE (LEAK-005).

Both endpoints follow the same pattern:
  1. Capture R2 keys BEFORE DB delete (orphan prevention)
  2. DB delete + commit
  3. Post-commit sync try_delete_file_from_r2() for each captured key
  4. On failure -> record_delete_failure() (dead-letter; never raise)

Tests focus on the helper functions and the cleanup logic, mocking R2 calls.
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

# Make backend/ importable
import os, sys
BACKEND = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if BACKEND not in sys.path:
    sys.path.insert(0, BACKEND)


# ===========================================================================
# LEAK-001: subscription DELETE -> cleans delivery_log R2 keys
# ===========================================================================

# Importing the module imports sqlalchemy ORM at module level; skip if it
# requires DB connectivity (it doesn't for these helpers, but be safe).
from app.services.scheduled_report.subscription_service import (  # noqa: E402
    _collect_subscription_r2_keys,
    _cleanup_r2_keys,
    delete_subscription,
)


def test_collect_subscription_r2_keys_deduplicates():
    """Same key in multiple rows should appear once in the result set."""
    fake_session = MagicMock()
    fake_session.execute.return_value.all.return_value = [
        ("screenshot/k1.png", "thumb/k1.png"),
        ("screenshot/k1.png", "thumb/k1.png"),  # duplicate
        ("screenshot/k2.png", None),
        (None, "thumb/k3.png"),
        (None, None),
    ]
    keys = _collect_subscription_r2_keys(fake_session, 42)
    assert keys == {"screenshot/k1.png", "thumb/k1.png", "screenshot/k2.png", "thumb/k3.png"}


def test_collect_subscription_r2_keys_strips_whitespace():
    """Whitespace-only / surrounding whitespace keys are treated as missing."""
    fake_session = MagicMock()
    fake_session.execute.return_value.all.return_value = [
        ("  k1.png  ", " k1_thumb.png"),
        ("", " "),
    ]
    keys = _collect_subscription_r2_keys(fake_session, 42)
    assert keys == {"k1.png", "k1_thumb.png"}


def test_cleanup_r2_keys_calls_r2_for_each_key():
    """Every captured key must be passed to try_delete_file_from_r2."""
    fake_settings = MagicMock()
    settings_p = patch("app.services.scheduled_report.subscription_service.get_settings",
                       return_value=fake_settings)
    fake_try = MagicMock(return_value=MagicMock(success=True))

    with settings_p, \
         patch("app.services.scheduled_report.subscription_service.try_delete_file_from_r2",
               fake_try):
        _cleanup_r2_keys({"k1", "k2", "k3"},
                         source="subscription_delete",
                         context={"subscription_id": 42})

    called_keys = sorted(call.args[1] for call in fake_try.call_args_list)
    assert called_keys == ["k1", "k2", "k3"]


def test_cleanup_r2_keys_failure_writes_dead_letter():
    """try_delete_file_from_r2 returning success=False must write dead-letter."""
    fake_settings = MagicMock()
    settings_p = patch("app.services.scheduled_report.subscription_service.get_settings",
                       return_value=fake_settings)

    failed_result = MagicMock(success=False, error_class="ClientError",
                              error_message="AccessDenied")
    fake_try = MagicMock(return_value=failed_result)
    fake_record = MagicMock()

    with settings_p, \
         patch("app.services.scheduled_report.subscription_service.try_delete_file_from_r2",
               fake_try), \
         patch("app.services.scheduled_report.subscription_service.record_delete_failure",
               fake_record):
        _cleanup_r2_keys({"k1"}, source="subscription_delete",
                         context={"subscription_id": 99})

    # Verify dead-letter was called
    fake_record.assert_called_once()
    call_args = fake_record.call_args
    assert call_args.kwargs["source"] == "subscription_delete"
    assert call_args.kwargs["context"] == {"subscription_id": 99}
    assert call_args.args[0] == "k1"
    assert call_args.args[1] is failed_result


def test_cleanup_r2_keys_continues_after_failure():
    """Failure on one key must not stop cleanup of subsequent keys."""
    fake_settings = MagicMock()
    settings_p = patch("app.services.scheduled_report.subscription_service.get_settings",
                       return_value=fake_settings)

    fake_try = MagicMock(side_effect=[
        MagicMock(success=True),
        MagicMock(success=False, error_class="ClientError", error_message="x"),
        MagicMock(success=True),
    ])
    fake_record = MagicMock()

    with settings_p, \
         patch("app.services.scheduled_report.subscription_service.try_delete_file_from_r2",
               fake_try), \
         patch("app.services.scheduled_report.subscription_service.record_delete_failure",
               fake_record):
        _cleanup_r2_keys({"k1", "k2", "k3"},
                         source="subscription_delete",
                         context={})

    # All 3 keys attempted
    assert fake_try.call_count == 3
    # Only 1 dead-letter
    fake_record.assert_called_once()


def test_cleanup_r2_keys_no_keys_is_noop():
    """Empty keyset -> no R2 calls, no dead-letters."""
    fake_settings = MagicMock()
    fake_try = MagicMock()
    fake_record = MagicMock()

    with patch("app.services.scheduled_report.subscription_service.get_settings",
               return_value=fake_settings), \
         patch("app.services.scheduled_report.subscription_service.try_delete_file_from_r2",
               fake_try), \
         patch("app.services.scheduled_report.subscription_service.record_delete_failure",
               fake_record):
        _cleanup_r2_keys(set(), source="x", context={})

    fake_try.assert_not_called()
    fake_record.assert_not_called()


# ===========================================================================
# LEAK-005: user DELETE -> cleans avatar R2
# ===========================================================================

from app.api.v1.endpoints.users import (  # noqa: E402
    _avatar_url_to_key,
    _cleanup_user_avatar_r2,
)


def test_avatar_url_to_key_vacuous():
    assert _avatar_url_to_key(None) is None
    assert _avatar_url_to_key("") is None
    assert _avatar_url_to_key(123) is None  # type: ignore[arg-type]


def test_avatar_url_to_key_extracts_r2_path():
    assert _avatar_url_to_key(
        "https://bucket.believeboy.com/avatars/u123/abc.jpg"
    ) == "avatars/u123/abc.jpg"


# ---------------------------------------------------------------------------
# _cleanup_user_avatar_r2
# ---------------------------------------------------------------------------

def test_user_avatar_r2_cleanup_success():
    fake_try = MagicMock(return_value=MagicMock(success=True))
    fake_record = MagicMock()

    with patch("app.api.v1.endpoints.users.try_delete_file_from_r2", fake_try), \
         patch("app.api.v1.endpoints.users.record_delete_failure", fake_record):
        _cleanup_user_avatar_r2("avatars/u1/p.png",
                                context={"user_id": "u1"})

    fake_try.assert_called_once()
    args, kwargs = fake_try.call_args
    assert args[1] == "avatars/u1/p.png"
    assert kwargs["log_failure"] is False
    fake_record.assert_not_called()


def test_user_avatar_r2_cleanup_failure_writes_dead_letter():
    """Cleanup failure writes to r2_delete_failures with source='user_delete'."""
    failed = MagicMock(success=False, error_class="ClientError",
                       error_message="denied")

    with patch("app.api.v1.endpoints.users.try_delete_file_from_r2",
               return_value=failed), \
         patch("app.api.v1.endpoints.users.record_delete_failure") as fake_record:
        _cleanup_user_avatar_r2("avatars/u1/p.png",
                                context={"user_id": "u1"})

    fake_record.assert_called_once()
    kwargs = fake_record.call_args.kwargs
    assert kwargs["source"] == "user_delete"
    assert kwargs["context"] == {"user_id": "u1"}
    assert fake_record.call_args.args[0] == "avatars/u1/p.png"
    assert fake_record.call_args.args[1] is failed


def test_user_avatar_r2_cleanup_never_raises():
    """If R2 throws some unexpected error, cleanup itself must not crash the request."""
    with patch("app.api.v1.endpoints.users.try_delete_file_from_r2",
               side_effect=RuntimeError("unexpected")), \
         patch("app.api.v1.endpoints.users.record_delete_failure"):
        # Should not raise
        _cleanup_user_avatar_r2("x", context={})

    # record_delete_failure was NOT called (we don't even try to record an
    # exception that wasn't a typed R2 failure).
