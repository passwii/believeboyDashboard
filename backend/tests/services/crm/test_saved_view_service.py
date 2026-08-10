"""保存视图服务单元测试（Stage5-3，BLF-589）。

覆盖 saved_view_service：
- validate_filters：白名单字段/运算符/嵌套/值形状（复用 filter_engine）
- list_views：own+shared 可见性、entity_type 过滤、他人个人视图不可见
- create_view：owner 回填、is_shared 非 admin 403、filters ValueError
- update_view：owner/共享权限、不可见 → None、promote 仅 admin
- delete_view：owner/共享权限、不可见 → None
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from app.models.crm import CrmSavedView
from app.schemas.crm import SavedViewCreate, SavedViewUpdate
from app.services.crm import saved_view_service as svc

USER_A = "00000000-0000-0000-0000-00000000000a"
USER_B = "00000000-0000-0000-0000-00000000000b"


def _create_payload(**overrides):
    payload = dict(
        name="我关注的客户",
        entity_type="customer",
        scope="mine",
        keyword=None,
        filters=[{"field": "status", "op": "eq", "value": "active"}],
        sort_by="updated_at",
        sort_order="desc",
        is_shared=False,
    )
    payload.update(overrides)
    return SavedViewCreate(**payload)


def _make(db, user_id=USER_A, **overrides) -> CrmSavedView:
    view = svc.create_view(
        db,
        _create_payload(**overrides),
        user_id=user_id,
        is_admin=bool(overrides.get("is_shared")),
        commit=False,
    )
    db.flush()
    return view


# ─── validate_filters ─────────────────────────────────────────────────────────


def test_validate_filters_none_and_empty_ok():
    svc.validate_filters(None, "customer")
    svc.validate_filters([], "lead")


def test_validate_filters_valid_customer():
    svc.validate_filters(
        [
            {"field": "status", "op": "eq", "value": "active"},
            {"field": "annualRevenue", "op": "between", "value": [100, 1000]},
        ],
        "customer",
    )


def test_validate_filters_nested_and_or_ok():
    svc.validate_filters(
        [
            {
                "or": [
                    {"field": "status", "op": "eq", "value": "active"},
                    {"field": "rating", "op": "in", "value": ["A", "B"]},
                ]
            }
        ],
        "customer",
    )


def test_validate_filters_unknown_field_raises():
    with pytest.raises(ValueError, match="筛选字段"):
        svc.validate_filters(
            [{"field": "no_such", "op": "eq", "value": "x"}], "customer"
        )


def test_validate_filters_unknown_operator_raises():
    with pytest.raises(ValueError, match="运算符"):
        svc.validate_filters(
            [{"field": "status", "op": "regex", "value": "x"}], "customer"
        )


def test_validate_filters_lead_rejects_customer_field():
    with pytest.raises(ValueError, match="筛选字段"):
        svc.validate_filters([{"field": "rating", "op": "eq", "value": "A"}], "lead")


def test_validate_filters_bad_between_shape_raises():
    with pytest.raises((ValueError, TypeError)):
        svc.validate_filters(
            [{"field": "annualRevenue", "op": "between", "value": "oops"}], "customer"
        )


# ─── create_view ──────────────────────────────────────────────────────────────


def test_create_backfills_owner(db_session):
    view = _make(db_session, user_id=USER_A)
    assert view.owner_id == USER_A
    assert view.is_shared is False
    assert view.filters == [{"field": "status", "op": "eq", "value": "active"}]


def test_create_shared_by_non_admin_403(db_session):
    with pytest.raises(HTTPException) as exc:
        svc.create_view(
            db_session,
            _create_payload(is_shared=True),
            user_id=USER_A,
            is_admin=False,
            commit=False,
        )
    assert exc.value.status_code == 403


def test_create_shared_by_admin_ok(db_session):
    view = svc.create_view(
        db_session,
        _create_payload(is_shared=True),
        user_id=USER_A,
        is_admin=True,
        commit=False,
    )
    assert view.is_shared is True


def test_create_invalid_filters_valueerror(db_session):
    with pytest.raises(ValueError):
        svc.create_view(
            db_session,
            _create_payload(filters=[{"field": "no_such", "op": "eq", "value": "x"}]),
            user_id=USER_A,
            is_admin=False,
            commit=False,
        )


# ─── list_views / get_view ────────────────────────────────────────────────────


def test_list_own_only(db_session):
    _make(db_session, user_id=USER_A, name="A1")
    _make(db_session, user_id=USER_B, name="B1")

    rows = svc.list_views(db_session, user_id=USER_A)
    assert [r["name"] for r in rows] == ["A1"]


def test_list_includes_shared(db_session):
    _make(db_session, user_id=USER_A, name="个人")
    _make(db_session, user_id=USER_B, name="B共享", is_shared=True)

    rows = svc.list_views(db_session, user_id=USER_A)
    names = {r["name"] for r in rows}
    assert names == {"个人", "B共享"}


def test_list_entity_filter(db_session):
    _make(db_session, user_id=USER_A, name="客户视图", entity_type="customer")
    _make(db_session, user_id=USER_A, name="线索视图", entity_type="lead")

    rows = svc.list_views(db_session, user_id=USER_A, entity_type="customer")
    assert [r["name"] for r in rows] == ["客户视图"]


def test_get_own_view(db_session):
    view = _make(db_session, user_id=USER_A)
    assert svc.get_view(db_session, view.id, USER_A) is not None
    assert svc.get_view(db_session, view.id, USER_B) is None  # 不泄露


def test_get_shared_view(db_session):
    view = _make(db_session, user_id=USER_B, is_shared=True)
    assert svc.get_view(db_session, view.id, USER_A) is not None


# ─── update_view ──────────────────────────────────────────────────────────────


def test_update_owner_ok(db_session):
    view = _make(db_session, user_id=USER_A, name="原")
    updated = svc.update_view(
        db_session,
        view.id,
        SavedViewUpdate(name="新"),
        user_id=USER_A,
        is_admin=False,
        commit=False,
    )
    assert updated.name == "新"


def test_update_others_personal_none(db_session):
    view = _make(db_session, user_id=USER_B)
    assert (
        svc.update_view(
            db_session,
            view.id,
            SavedViewUpdate(name="x"),
            user_id=USER_A,
            is_admin=False,
            commit=False,
        )
        is None
    )


def test_update_shared_by_operator_403(db_session):
    view = _make(db_session, user_id=USER_B, is_shared=True)
    with pytest.raises(HTTPException) as exc:
        svc.update_view(
            db_session,
            view.id,
            SavedViewUpdate(name="x"),
            user_id=USER_A,
            is_admin=False,
            commit=False,
        )
    assert exc.value.status_code == 403


def test_update_shared_by_admin_ok(db_session):
    view = _make(db_session, user_id=USER_B, is_shared=True)
    updated = svc.update_view(
        db_session,
        view.id,
        SavedViewUpdate(name="admin改"),
        user_id=USER_A,
        is_admin=True,
        commit=False,
    )
    assert updated.name == "admin改"


def test_update_promote_requires_admin(db_session):
    view = _make(db_session, user_id=USER_A)
    with pytest.raises(HTTPException) as exc:
        svc.update_view(
            db_session,
            view.id,
            SavedViewUpdate(is_shared=True),
            user_id=USER_A,
            is_admin=False,
            commit=False,
        )
    assert exc.value.status_code == 403

    updated = svc.update_view(
        db_session,
        view.id,
        SavedViewUpdate(is_shared=True),
        user_id=USER_A,
        is_admin=True,
        commit=False,
    )
    assert updated.is_shared is True


def test_update_invalid_filters_valueerror(db_session):
    view = _make(db_session, user_id=USER_A)
    with pytest.raises(ValueError):
        svc.update_view(
            db_session,
            view.id,
            SavedViewUpdate(filters=[{"field": "no_such", "op": "eq", "value": "x"}]),
            user_id=USER_A,
            is_admin=False,
            commit=False,
        )


# ─── delete_view ──────────────────────────────────────────────────────────────


def test_delete_owner_ok(db_session):
    view = _make(db_session, user_id=USER_A)
    deleted = svc.delete_view(db_session, view.id, USER_A, is_admin=False)
    assert deleted is not None
    assert db_session.get(CrmSavedView, view.id) is None


def test_delete_others_personal_none(db_session):
    view = _make(db_session, user_id=USER_B)
    assert svc.delete_view(db_session, view.id, USER_A, is_admin=False) is None


def test_delete_shared_by_admin_ok(db_session):
    view = _make(db_session, user_id=USER_B, is_shared=True)
    assert svc.delete_view(db_session, view.id, USER_A, is_admin=True) is not None


def test_delete_shared_by_operator_403(db_session):
    view = _make(db_session, user_id=USER_B, is_shared=True)
    with pytest.raises(HTTPException) as exc:
        svc.delete_view(db_session, view.id, USER_A, is_admin=False)
    assert exc.value.status_code == 403
