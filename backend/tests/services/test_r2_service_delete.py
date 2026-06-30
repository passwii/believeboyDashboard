"""Unit tests for P0.2: R2DeleteResult + try_delete_file_from_r2 + bool shim.

Coverage:
- empty / None key → success=True (vacuous)
- success path → R2DeleteResult(success=True)
- ClientError / BotoCoreError / OSError → success=False + correct error_class
- delete_file_from_r2 (bool shim) still works for legacy callers
- key=None / empty string 不调用 boto3 (avoid HEAD/DELETE charge on non-keys)
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import (
    BotoCoreError,
    ClientError,
    EndpointConnectionError,
)

from app.core.config import get_settings
from app.services.r2_service import (
    R2DeleteResult,
    delete_file_from_r2,
    try_delete_file_from_r2,
)


@pytest.fixture
def fake_boto_client() -> MagicMock:
    """Provide a mocked boto3 S3 client and force ``_r2_client`` to point at it."""
    client = MagicMock()
    with patch("app.services.r2_service._r2_client", client):
        yield client
    return client


# ---------------------------------------------------------------------------
# Vacuous cases
# ---------------------------------------------------------------------------

def test_delete_vacuous_empty_key(fake_boto_client):
    """Empty-string key is treated as no-op."""
    s = get_settings()
    r = try_delete_file_from_r2(s, "", log_failure=False)
    assert isinstance(r, R2DeleteResult)
    assert r.success is True
    assert r.key == ""
    assert r.error_class is None
    fake_boto_client.delete_object.assert_not_called()


def test_delete_vacuous_none_key(fake_boto_client):
    """None key is treated as no-op (legacy bool path)."""
    s = get_settings()
    # bool shim returns True (vacuous)
    assert delete_file_from_r2(s, None, log_failure=False) is True
    fake_boto_client.delete_object.assert_not_called()


# ---------------------------------------------------------------------------
# Success path
# ---------------------------------------------------------------------------

def test_delete_success_returns_true_for_bool_shim(fake_boto_client):
    fake_boto_client.delete_object.return_value = {}
    s = get_settings()
    assert delete_file_from_r2(s, "a/b/c.png", log_failure=False) is True


def test_delete_success_returns_typed_result(fake_boto_client):
    fake_boto_client.delete_object.return_value = {"DeleteMarker": False}
    s = get_settings()
    r = try_delete_file_from_r2(s, "a/b/c.png", log_failure=False)
    assert r.success is True
    assert r.key == "a/b/c.png"
    assert r.error_class is None
    assert r.error_message is None


def test_delete_calls_boto3_with_correct_args(fake_boto_client):
    fake_boto_client.delete_object.return_value = {}
    s = get_settings()
    try_delete_file_from_r2(s, "products/x.jpg", log_failure=False)
    fake_boto_client.delete_object.assert_called_once()
    kwargs = fake_boto_client.delete_object.call_args.kwargs
    assert kwargs["Bucket"] == s.r2_bucket_name
    assert kwargs["Key"] == "products/x.jpg"


# ---------------------------------------------------------------------------
# Failure paths
# ---------------------------------------------------------------------------

def test_delete_client_error_returns_false_via_bool_shim(fake_boto_client):
    fake_boto_client.delete_object.side_effect = ClientError(
        {"Error": {"Code": "AccessDenied", "Message": "denied"}}, "delete_object"
    )
    s = get_settings()
    assert delete_file_from_r2(s, "x.png", log_failure=False) is False


def test_delete_client_error_classification(fake_boto_client):
    fake_boto_client.delete_object.side_effect = ClientError(
        {"Error": {"Code": "AccessDenied", "Message": "denied"}}, "delete_object"
    )
    s = get_settings()
    r = try_delete_file_from_r2(s, "x.png", log_failure=False)
    assert r.success is False
    assert r.error_class == "ClientError"
    assert "AccessDenied" in r.error_message
    assert r.key == "x.png"


def test_delete_botocore_error_classification(fake_boto_client):
    fake_boto_client.delete_object.side_effect = EndpointConnectionError(
        endpoint_url="https://r2.example.com"
    )
    s = get_settings()
    r = try_delete_file_from_r2(s, "x.png", log_failure=False)
    assert r.success is False
    assert r.error_class == "EndpointConnectionError"


def test_delete_oserror_classification(fake_boto_client):
    fake_boto_client.delete_object.side_effect = OSError("connection reset")
    s = get_settings()
    r = try_delete_file_from_r2(s, "x.png", log_failure=False)
    assert r.success is False
    assert r.error_class == "OSError"
    assert "connection reset" in r.error_message


def test_delete_other_exception_propagates(fake_boto_client):
    """Non-IO/ClientError exceptions still propagate (assertion bug should crash)."""
    fake_boto_client.delete_object.side_effect = RuntimeError("oops")
    s = get_settings()
    with pytest.raises(RuntimeError, match="oops"):
        try_delete_file_from_r2(s, "x.png", log_failure=False)


# ---------------------------------------------------------------------------
# Logging behavior
# ---------------------------------------------------------------------------

def test_delete_logs_failure_by_default(fake_boto_client):
    fake_boto_client.delete_object.side_effect = ClientError(
        {"Error": {"Code": "NoSuchKey", "Message": "missing"}}, "delete_object"
    )
    s = get_settings()
    with patch("app.services.r2_service.logger") as lg:
        try_delete_file_from_r2(s, "x.png")  # log_failure default True
    assert lg.warning.called
    assert "x.png" in str(lg.warning.call_args)


def test_delete_no_log_when_log_failure_false(fake_boto_client):
    fake_boto_client.delete_object.side_effect = ClientError(
        {"Error": {"Code": "NoSuchKey", "Message": "missing"}}, "delete_object"
    )
    s = get_settings()
    with patch("app.services.r2_service.logger") as lg:
        try_delete_file_from_r2(s, "x.png", log_failure=False)
    assert not lg.warning.called


# ---------------------------------------------------------------------------
# R2DeleteResult frozen dataclass
# ---------------------------------------------------------------------------

def test_delete_result_is_frozen():
    """R2DeleteResult is immutable to prevent accidental mutation in transit."""
    r = R2DeleteResult(success=True, key="x")
    with pytest.raises((AttributeError, TypeError)):
        r.success = False  # type: ignore[misc]
