"""Tests for app.schemas.scheduled_report project_ids normalization.

Covers the multi-project subscription validation introduced for project
scope multi-select:
- "" / "*" / "15" / "15,4,8" round-trip identically.
- Dedup + order-preserve.
- Reject non-numeric / non-positive / oversized lists.
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.schemas.scheduled_report import (
    SubscriptionCreate,
    SubscriptionUpdate,
    TestEmailRequest,
)


# ---------------------------------------------------------------------------
# SubscriptionCreate
# ---------------------------------------------------------------------------


def test_create_project_ids_star_passthrough():
    sub = SubscriptionCreate(email="a@b.com", frequency="daily", project_ids="*")
    assert sub.project_ids == "*"


def test_create_project_ids_empty_normalized_to_star():
    sub = SubscriptionCreate(email="a@b.com", frequency="daily", project_ids="")
    assert sub.project_ids == "*"


def test_create_project_ids_single_value_kept():
    sub = SubscriptionCreate(email="a@b.com", frequency="daily", project_ids="15")
    assert sub.project_ids == "15"


def test_create_project_ids_comma_list_kept():
    sub = SubscriptionCreate(
        email="a@b.com", frequency="daily", project_ids="15,4,8"
    )
    assert sub.project_ids == "15,4,8"


def test_create_project_ids_dedup_preserve_order():
    sub = SubscriptionCreate(
        email="a@b.com", frequency="daily", project_ids="8,15,8,4,15"
    )
    assert sub.project_ids == "8,15,4"


def test_create_project_ids_strip_whitespace():
    sub = SubscriptionCreate(
        email="a@b.com", frequency="daily", project_ids=" 15 , 4 ,8 "
    )
    assert sub.project_ids == "15,4,8"


def test_create_project_ids_reject_non_numeric():
    with pytest.raises(ValidationError) as excinfo:
        SubscriptionCreate(
            email="a@b.com", frequency="daily", project_ids="15,abc,8"
        )
    assert "正整数" in str(excinfo.value)


def test_create_project_ids_reject_zero_and_negative():
    with pytest.raises(ValidationError):
        SubscriptionCreate(
            email="a@b.com", frequency="daily", project_ids="15,0,8"
        )
    with pytest.raises(ValidationError):
        SubscriptionCreate(
            email="a@b.com", frequency="daily", project_ids="15,-4,8"
        )


def test_create_project_ids_reject_oversized():
    too_many = ",".join(str(i) for i in range(1, 102))  # 101 个
    with pytest.raises(ValidationError) as excinfo:
        SubscriptionCreate(
            email="a@b.com", frequency="daily", project_ids=too_many
        )
    assert "最多选择" in str(excinfo.value)


def test_create_project_ids_accept_exactly_max():
    exactly_max = ",".join(str(i) for i in range(1, 101))  # 100 个
    sub = SubscriptionCreate(
        email="a@b.com", frequency="daily", project_ids=exactly_max
    )
    assert len(sub.project_ids.split(",")) == 100


# ---------------------------------------------------------------------------
# SubscriptionUpdate
# ---------------------------------------------------------------------------


def test_update_project_ids_none_is_passthrough():
    """Update 中 project_ids=None 表示未提交，应原样放行（ORM 跳过）。"""
    sub = SubscriptionUpdate(email="a@b.com")
    assert sub.project_ids is None


def test_update_project_ids_empty_normalized_to_star():
    sub = SubscriptionUpdate(email="a@b.com", project_ids="")
    assert sub.project_ids == "*"


def test_update_project_ids_normalized_when_present():
    sub = SubscriptionUpdate(
        email="a@b.com", project_ids="15,15, 4"
    )
    assert sub.project_ids == "15,4"


def test_update_project_ids_reject_non_numeric():
    with pytest.raises(ValidationError):
        SubscriptionUpdate(email="a@b.com", project_ids="abc")


# ---------------------------------------------------------------------------
# TestEmailRequest
# ---------------------------------------------------------------------------


def test_test_email_request_project_ids_normalized():
    req = TestEmailRequest(email="a@b.com", project_ids="15, 15 ,4")
    assert req.project_ids == "15,4"


def test_test_email_request_default_star():
    req = TestEmailRequest(email="a@b.com")
    assert req.project_ids == "*"