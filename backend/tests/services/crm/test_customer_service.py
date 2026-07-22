"""customer_service TDD tests — CRUD / scope / batch / sea / primary contact join."""
from __future__ import annotations

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.models.crm import CrmContact, CrmCustomer
from app.schemas.crm import CustomerCreate, CustomerUpdate
from app.services.crm.customer_service import (
    batch_move_to_sea,
    batch_transfer,
    claim_from_sea,
    create_customer,
    delete_customer,
    get_customer,
    list_customers,
    update_customer,
)


# ── helpers ──────────────────────────────────────────────────────────────────

def _seed_customer(db: Session, name: str = "Acme", owner_id: int | None = 1, **kw) -> CrmCustomer:
    c = CrmCustomer(name=name, owner_id=owner_id, created_by=owner_id, **kw)
    db.add(c)
    db.flush()
    return c


def _seed_contact(db: Session, customer_id: int, name: str, is_primary: bool = False, **kw) -> CrmContact:
    ct = CrmContact(customer_id=customer_id, name=name, is_primary=is_primary, **kw)
    db.add(ct)
    db.flush()
    return ct


# ── CRUD ─────────────────────────────────────────────────────────────────────

class TestCreate:
    def test_create_returns_item_with_owner_default(self, db_session: Session):
        payload = CustomerCreate(name="NewCo")
        item = create_customer(db_session, payload, user_id="42")
        assert item is not None
        assert item.name == "NewCo"
        assert item.owner_id == 42  # 默认归创建人
        assert item.created_by == 42

    def test_create_explicit_owner(self, db_session: Session):
        payload = CustomerCreate(name="OwnedCo", owner_id=7)
        item = create_customer(db_session, payload, user_id="42")
        assert item.owner_id == 7

    def test_create_no_user(self, db_session: Session):
        payload = CustomerCreate(name="AnonCo")
        item = create_customer(db_session, payload, user_id=None)
        assert item.owner_id is None
        assert item.created_by is None


class TestGet:
    def test_get_existing(self, db_session: Session):
        c = _seed_customer(db_session, name="GetMe", owner_id=1)
        item = get_customer(db_session, c.id)
        assert item is not None
        assert item.name == "GetMe"

    def test_get_deleted_returns_none(self, db_session: Session):
        c = _seed_customer(db_session, name="Gone")
        c.is_deleted = True
        db_session.flush()
        assert get_customer(db_session, c.id) is None

    def test_get_missing_returns_none(self, db_session: Session):
        assert get_customer(db_session, 999999) is None


class TestUpdate:
    def test_update_fields(self, db_session: Session):
        c = _seed_customer(db_session, name="Old")
        item = update_customer(db_session, c.id, CustomerUpdate(name="New", rating="A"))
        assert item is not None
        assert item.name == "New"
        assert item.rating == "A"

    def test_update_missing_returns_none(self, db_session: Session):
        assert update_customer(db_session, 999999, CustomerUpdate(name="X")) is None


class TestDelete:
    def test_soft_delete(self, db_session: Session):
        c = _seed_customer(db_session, name="Del")
        assert delete_customer(db_session, c.id) is True
        db_session.refresh(c)
        assert c.is_deleted is True

    def test_delete_missing_returns_false(self, db_session: Session):
        assert delete_customer(db_session, 999999) is False


# ── scope ────────────────────────────────────────────────────────────────────

class TestScope:
    def test_scope_mine(self, db_session: Session):
        _seed_customer(db_session, name="Mine", owner_id=10)
        _seed_customer(db_session, name="Other", owner_id=20)
        items, total = list_customers(db_session, user_id="10", scope="mine")
        assert total == 1
        assert items[0].name == "Mine"

    def test_scope_all(self, db_session: Session):
        _seed_customer(db_session, name="A1", owner_id=10)
        _seed_customer(db_session, name="A2", owner_id=20)
        items, total = list_customers(db_session, user_id="10", scope="all")
        assert total >= 2

    def test_scope_sea(self, db_session: Session):
        _seed_customer(db_session, name="InSea", owner_id=None)
        _seed_customer(db_session, name="Owned", owner_id=1)
        items, total = list_customers(db_session, user_id="1", scope="sea")
        names = [i.name for i in items]
        assert "InSea" in names
        assert "Owned" not in names

    def test_keyword_filter(self, db_session: Session):
        _seed_customer(db_session, name="UniqueXYZ")
        items, total = list_customers(db_session, user_id=None, scope="all", keyword="UniqueXYZ")
        assert total == 1
        assert items[0].name == "UniqueXYZ"


# ── batch ────────────────────────────────────────────────────────────────────

class TestBatch:
    def test_batch_transfer(self, db_session: Session):
        c1 = _seed_customer(db_session, name="B1", owner_id=1)
        c2 = _seed_customer(db_session, name="B2", owner_id=1)
        count = batch_transfer(db_session, [c1.id, c2.id], to_owner_id=99)
        assert count == 2
        db_session.refresh(c1)
        assert c1.owner_id == 99

    def test_batch_move_to_sea(self, db_session: Session):
        c1 = _seed_customer(db_session, name="S1", owner_id=5)
        count = batch_move_to_sea(db_session, [c1.id])
        assert count == 1
        db_session.refresh(c1)
        assert c1.owner_id is None


# ── claim from sea ───────────────────────────────────────────────────────────

class TestClaim:
    def test_claim_success(self, db_session: Session):
        c = _seed_customer(db_session, name="SeaCo", owner_id=None)
        item = claim_from_sea(db_session, c.id, user_id="77")
        assert item is not None
        assert item.owner_id == 77

    def test_claim_owned_returns_none(self, db_session: Session):
        c = _seed_customer(db_session, name="NotSea", owner_id=1)
        assert claim_from_sea(db_session, c.id, user_id="77") is None

    def test_claim_no_user_returns_none(self, db_session: Session):
        c = _seed_customer(db_session, name="SeaNoUser", owner_id=None)
        assert claim_from_sea(db_session, c.id, user_id=None) is None


# ── primary contact join ─────────────────────────────────────────────────────

class TestPrimaryContactJoin:
    def test_primary_contact_fields(self, db_session: Session):
        c = _seed_customer(db_session, name="WithContact")
        _seed_contact(db_session, c.id, name="Primary", is_primary=True,
                      phone="123", email="p@x.com")
        _seed_contact(db_session, c.id, name="Secondary", is_primary=False)
        item = get_customer(db_session, c.id)
        assert item.contact_name == "Primary"
        assert item.contact_phone == "123"
        assert item.contact_email == "p@x.com"

    def test_no_primary_falls_back_to_earliest(self, db_session: Session):
        c = _seed_customer(db_session, name="NoPrimary")
        _seed_contact(db_session, c.id, name="First", is_primary=False)
        _seed_contact(db_session, c.id, name="Second", is_primary=False)
        item = get_customer(db_session, c.id)
        assert item.contact_name == "First"  # 最早一条

    def test_no_contact_fields_none(self, db_session: Session):
        c = _seed_customer(db_session, name="NoContact")
        item = get_customer(db_session, c.id)
        assert item.contact_name is None
        assert item.contact_phone is None

    def test_list_includes_contact(self, db_session: Session):
        c = _seed_customer(db_session, name="ListContact")
        _seed_contact(db_session, c.id, name="LC", is_primary=True, phone="999")
        items, _ = list_customers(db_session, user_id=None, scope="all", keyword="ListContact")
        assert items[0].contact_name == "LC"
        assert items[0].contact_phone == "999"
