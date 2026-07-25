"""contact_service TDD tests — CRUD / single-primary / list-by-customer."""

from __future__ import annotations

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.models.crm import CrmContact, CrmCustomer
from app.schemas.crm import ContactCreate, ContactUpdate
from app.services.crm.contact_service import (
    create_contact,
    delete_contact,
    list_contacts,
    update_contact,
)


# ── helpers ──────────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _clean_crm_tables(db_session):
    """服务层会 commit，跨测试/跨运行会留脏数据；每个测试前清空 CRM 表。

    依赖 db_session 以继承“无 TEST_DATABASE_URL 则 skip”保护；
    清理用独立 session + commit（db_session 会回滚，清不掉已提交行）。
    """
    from app.db.session import SessionLocal

    s = SessionLocal()
    try:
        s.execute(text("delete from crm_follows"))
        s.execute(text("delete from crm_opportunities"))
        s.execute(text("delete from crm_contacts"))
        s.execute(text("delete from crm_leads"))
        s.execute(text("delete from crm_customers"))
        s.commit()
    finally:
        s.close()
    yield


def _seed_customer(db: Session, name: str = "Acme") -> CrmCustomer:
    c = CrmCustomer(name=name)
    db.add(c)
    db.flush()
    return c


def _seed_contact(
    db: Session, customer_id: int, name: str, is_primary: bool = False, **kw
) -> CrmContact:
    ct = CrmContact(customer_id=customer_id, name=name, is_primary=is_primary, **kw)
    db.add(ct)
    db.flush()
    return ct


def _primaries(db: Session, customer_id: int) -> list[CrmContact]:
    return [c for c in list_contacts(db, customer_id) if c.is_primary]


# ── create ───────────────────────────────────────────────────────────────────


class TestCreate:
    def test_create_first_contact_auto_primary(self, db_session: Session):
        c = _seed_customer(db_session)
        ct = create_contact(db_session, c.id, ContactCreate(name="First"))
        assert ct is not None
        assert ct.name == "First"
        assert ct.is_primary is True  # 首个联系人自动成为主联系人

    def test_create_second_contact_not_primary(self, db_session: Session):
        c = _seed_customer(db_session)
        create_contact(db_session, c.id, ContactCreate(name="First"))
        ct = create_contact(db_session, c.id, ContactCreate(name="Second"))
        assert ct is not None
        assert ct.is_primary is False

    def test_create_explicit_primary_demotes_others(self, db_session: Session):
        c = _seed_customer(db_session)
        first = create_contact(db_session, c.id, ContactCreate(name="First"))
        assert first.is_primary is True
        second = create_contact(
            db_session, c.id, ContactCreate(name="Second", is_primary=True)
        )
        assert second.is_primary is True
        db_session.refresh(first)
        assert first.is_primary is False  # 旧主被取消
        assert len(_primaries(db_session, c.id)) == 1

    def test_create_missing_customer_returns_none(self, db_session: Session):
        assert create_contact(db_session, 999999, ContactCreate(name="X")) is None

    def test_create_deleted_customer_returns_none(self, db_session: Session):
        c = _seed_customer(db_session)
        c.is_deleted = True
        db_session.flush()
        assert create_contact(db_session, c.id, ContactCreate(name="X")) is None


# ── list ─────────────────────────────────────────────────────────────────────


class TestList:
    def test_list_orders_primary_first(self, db_session: Session):
        c = _seed_customer(db_session)
        _seed_contact(db_session, c.id, name="A", is_primary=False)
        _seed_contact(db_session, c.id, name="B", is_primary=False)
        p = _seed_contact(db_session, c.id, name="P", is_primary=True)
        rows = list_contacts(db_session, c.id)
        assert rows[0].id == p.id  # primary 排最前
        assert len(rows) == 3

    def test_list_scoped_to_customer(self, db_session: Session):
        c1 = _seed_customer(db_session, name="C1")
        c2 = _seed_customer(db_session, name="C2")
        _seed_contact(db_session, c1.id, name="In1")
        _seed_contact(db_session, c2.id, name="In2")
        rows = list_contacts(db_session, c1.id)
        assert [r.name for r in rows] == ["In1"]


# ── update ───────────────────────────────────────────────────────────────────


class TestUpdate:
    def test_update_fields(self, db_session: Session):
        c = _seed_customer(db_session)
        ct = create_contact(db_session, c.id, ContactCreate(name="Old", phone="1"))
        updated, summary = update_contact(
            db_session, ct.id, ContactUpdate(name="New", phone="2")
        )
        assert updated is not None
        assert updated.name == "New"
        assert updated.phone == "2"
        assert summary is not None
        assert "姓名" in summary and "Old→New" in summary
        assert "电话" in summary and "1→2" in summary

    def test_update_set_primary_demotes_others(self, db_session: Session):
        c = _seed_customer(db_session)
        first = create_contact(db_session, c.id, ContactCreate(name="First"))
        second = create_contact(db_session, c.id, ContactCreate(name="Second"))
        assert first.is_primary is True
        update_contact(db_session, second.id, ContactUpdate(is_primary=True))
        db_session.refresh(first)
        db_session.refresh(second)
        assert second.is_primary is True
        assert first.is_primary is False
        assert len(_primaries(db_session, c.id)) == 1

    def test_update_missing_returns_none_tuple(self, db_session: Session):
        updated, summary = update_contact(db_session, 999999, ContactUpdate(name="X"))
        assert updated is None
        assert summary is None

    def test_update_no_real_change_returns_none_summary(self, db_session: Session):
        """P5-1: patch 与 before 实际无变化时，summary 必须返回 None。"""
        c = _seed_customer(db_session)
        ct = create_contact(db_session, c.id, ContactCreate(name="Sam", phone="1"))
        # 只传同值 name，不传 phone（exclude_unset 排除），应该无变化
        updated, summary = update_contact(db_session, ct.id, ContactUpdate(name="Sam"))
        assert updated is not None
        assert summary is None


# ── delete ───────────────────────────────────────────────────────────────────


class TestDelete:
    def test_delete_physical(self, db_session: Session):
        c = _seed_customer(db_session)
        ct = create_contact(db_session, c.id, ContactCreate(name="Del"))
        assert delete_contact(db_session, ct.id) is True
        assert list_contacts(db_session, c.id) == []

    def test_delete_primary_promotes_earliest_remaining(self, db_session: Session):
        c = _seed_customer(db_session)
        first = create_contact(db_session, c.id, ContactCreate(name="First"))  # primary
        second = create_contact(db_session, c.id, ContactCreate(name="Second"))
        third = create_contact(db_session, c.id, ContactCreate(name="Third"))
        assert first.is_primary is True
        assert delete_contact(db_session, first.id) is True
        db_session.refresh(second)
        db_session.refresh(third)
        assert second.is_primary is True  # 最早剩余者升为主
        assert third.is_primary is False

    def test_delete_non_primary_keeps_primary(self, db_session: Session):
        c = _seed_customer(db_session)
        first = create_contact(db_session, c.id, ContactCreate(name="First"))  # primary
        second = create_contact(db_session, c.id, ContactCreate(name="Second"))
        assert delete_contact(db_session, second.id) is True
        db_session.refresh(first)
        assert first.is_primary is True

    def test_delete_missing_returns_false(self, db_session: Session):
        assert delete_contact(db_session, 999999) is False
