"""customer_service TDD tests — CRUD / scope / batch / sea / primary contact join."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app.models.crm import CrmContact, CrmCustomer
from app.schemas.crm import CustomerCreate, CustomerSeaImportRow, CustomerUpdate
from app.services.crm.customer_service import (
    batch_move_to_sea,
    batch_transfer,
    claim_from_sea,
    create_customer,
    delete_customer,
    get_customer,
    import_customers_to_sea,
    list_customers,
    update_customer,
)

# 用户 id 是 UUID 字符串（user_accounts.id）；以下为本测试用的假 UUID。
ALICE = "11111111-1111-1111-1111-111111111111"
BOB = "22222222-2222-2222-2222-222222222222"
CAROL = "33333333-3333-3333-3333-333333333333"


# ── helpers ──────────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _clean_crm_tables(db_session):
    """服务层（create_customer 等）会 commit，跨测试/跨运行会留下脏数据。

    每个测试前清空 CRM 表，保证 scope/count 断言确定、不受历史脏行影响。
    依赖 db_session 以继承“无 TEST_DATABASE_URL 则 skip”保护；
    清理用独立 session + commit（db_session 会回滚，清不掉已提交行）。
    """
    from app.db.session import SessionLocal

    s = SessionLocal()
    try:
        s.execute(text("delete from crm_follows"))
        s.execute(text("delete from crm_contacts"))
        s.execute(text("delete from crm_leads"))
        s.execute(text("delete from crm_customers"))
        s.commit()
    finally:
        s.close()
    yield


def _seed_customer(
    db: Session, name: str = "Acme", owner_id: str | None = ALICE, **kw
) -> CrmCustomer:
    c = CrmCustomer(name=name, owner_id=owner_id, created_by=owner_id, **kw)
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


# ── CRUD ─────────────────────────────────────────────────────────────────────


class TestCreate:
    def test_create_returns_item_with_owner_default(self, db_session: Session):
        payload = CustomerCreate(name="NewCo")
        item = create_customer(db_session, payload, user_id=ALICE)
        assert item is not None
        assert item.name == "NewCo"
        assert item.owner_id == ALICE  # 默认归创建人
        assert item.created_by == ALICE

    def test_create_explicit_owner(self, db_session: Session):
        payload = CustomerCreate(name="OwnedCo", owner_id=BOB)
        item = create_customer(db_session, payload, user_id=ALICE)
        assert item.owner_id == BOB

    def test_create_no_user(self, db_session: Session):
        payload = CustomerCreate(name="AnonCo")
        item = create_customer(db_session, payload, user_id=None)
        assert item.owner_id is None
        assert item.created_by is None


class TestGet:
    def test_get_existing(self, db_session: Session):
        c = _seed_customer(db_session, name="GetMe", owner_id=ALICE)
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
        _seed_customer(db_session, name="Mine", owner_id=ALICE)
        _seed_customer(db_session, name="Other", owner_id=BOB)
        items, total = list_customers(db_session, user_id=ALICE, scope="mine")
        assert total == 1
        assert items[0].name == "Mine"

    def test_scope_all(self, db_session: Session):
        _seed_customer(db_session, name="A1", owner_id=ALICE)
        _seed_customer(db_session, name="A2", owner_id=BOB)
        items, total = list_customers(db_session, user_id=ALICE, scope="all")
        assert total >= 2

    def test_scope_sea(self, db_session: Session):
        _seed_customer(db_session, name="InSea", owner_id=None)
        _seed_customer(db_session, name="Owned", owner_id=ALICE)
        items, total = list_customers(db_session, user_id=ALICE, scope="sea")
        names = [i.name for i in items]
        assert "InSea" in names
        assert "Owned" not in names

    def test_keyword_filter(self, db_session: Session):
        _seed_customer(db_session, name="UniqueXYZ")
        items, total = list_customers(
            db_session, user_id=None, scope="all", keyword="UniqueXYZ"
        )
        assert total == 1
        assert items[0].name == "UniqueXYZ"


# ── batch ────────────────────────────────────────────────────────────────────


class TestBatch:
    def test_batch_transfer(self, db_session: Session):
        c1 = _seed_customer(db_session, name="B1", owner_id=ALICE)
        c2 = _seed_customer(db_session, name="B2", owner_id=ALICE)
        count = batch_transfer(db_session, [c1.id, c2.id], to_owner_id=CAROL)
        assert count == 2
        db_session.refresh(c1)
        assert c1.owner_id == CAROL

    def test_batch_move_to_sea(self, db_session: Session):
        c1 = _seed_customer(db_session, name="S1", owner_id=BOB)
        count = batch_move_to_sea(db_session, [c1.id])
        assert count == 1
        db_session.refresh(c1)
        assert c1.owner_id is None


# ── claim from sea ───────────────────────────────────────────────────────────


class TestClaim:
    def test_claim_success(self, db_session: Session):
        c = _seed_customer(db_session, name="SeaCo", owner_id=None)
        item = claim_from_sea(db_session, c.id, user_id=BOB)
        assert item is not None
        assert item.owner_id == BOB

    def test_claim_owned_returns_none(self, db_session: Session):
        c = _seed_customer(db_session, name="NotSea", owner_id=ALICE)
        assert claim_from_sea(db_session, c.id, user_id=BOB) is None

    def test_claim_no_user_returns_none(self, db_session: Session):
        c = _seed_customer(db_session, name="SeaNoUser", owner_id=None)
        assert claim_from_sea(db_session, c.id, user_id=None) is None


# ── owner_name join（BLF-1441：显示名只取 full_name）────────────────────────


class TestOwnerNameJoin:
    def test_owner_name_resolves_from_user_accounts(
        self, db_session: Session, test_admin: dict
    ):
        admin_id = str(test_admin["id"])
        c = _seed_customer(db_session, name="NamedOwner", owner_id=admin_id)
        item = get_customer(db_session, c.id)
        assert item is not None
        assert item.owner_id == admin_id
        # 显示名来源是 full_name（中文姓名），不是登录名 name
        assert item.owner_name == test_admin["full_name"]

    def test_owner_name_ignores_login_name(self, db_session: Session):
        """登录名是英文 handle 时，客户负责人必须显示 full_name 中文姓名。

        BLF-1441 回归：改动前负责人列取的是 ``user_accounts.name``，显示成
        ``DamonROCK``；现在只取 ``full_name``。用临时账号避免动种子账号。
        """
        email = f"blf1441-owner-{uuid.uuid4().hex[:8]}@example.invalid"
        owner_id = db_session.execute(
            text(
                """
                insert into public.user_accounts
                    (name, email, password_hash, full_name, is_active)
                values ('DamonROCK', :email, :h, '纪亚伟', true)
                returning id::text
                """
            ),
            {"email": email, "h": "x" * 24},
        ).scalar_one()
        db_session.commit()
        try:
            c = _seed_customer(db_session, name="LoginNameOwner", owner_id=owner_id)
            item = get_customer(db_session, c.id)
            assert item is not None
            assert item.owner_name == "纪亚伟"
            assert item.owner_name != "DamonROCK"
        finally:
            db_session.execute(
                text("delete from public.user_accounts where email = :email"),
                {"email": email},
            )
            db_session.commit()


# ── primary contact join ─────────────────────────────────────────────────────


class TestPrimaryContactJoin:
    def test_primary_contact_fields(self, db_session: Session):
        c = _seed_customer(db_session, name="WithContact")
        _seed_contact(
            db_session,
            c.id,
            name="Primary",
            is_primary=True,
            phone="123",
            email="p@x.com",
        )
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
        items, _ = list_customers(
            db_session, user_id=None, scope="all", keyword="ListContact"
        )
        assert items[0].contact_name == "LC"
        assert items[0].contact_phone == "999"


# ── 新建客户带联系人（修复丢失联系人 bug）────────────────────────────────────
class TestCreateWithContact:
    def test_create_with_contact_builds_primary_contact(self, db_session: Session):
        payload = CustomerCreate(
            name="带联系人公司",
            contact_name="张三",
            contact_phone="13800000000",
            contact_email="zhang@example.com",
        )
        item = create_customer(db_session, payload, user_id=ALICE)
        assert item.contact_name == "张三"
        assert item.contact_phone == "13800000000"
        ct = (
            db_session.execute(
                select(CrmContact).where(CrmContact.customer_id == item.id)
            )
            .scalars()
            .all()
        )
        assert len(ct) == 1
        assert ct[0].is_primary is True
        assert ct[0].name == "张三"

    def test_create_without_contact_name_creates_no_contact(self, db_session: Session):
        # 只有电话没有联系人姓名 → 不建联系人（contact_name 驱动）
        payload = CustomerCreate(name="无联系人", contact_phone="13900000000")
        item = create_customer(db_session, payload, user_id=ALICE)
        ct = (
            db_session.execute(
                select(CrmContact).where(CrmContact.customer_id == item.id)
            )
            .scalars()
            .all()
        )
        assert ct == []


# ── 公海批量导入 ─────────────────────────────────────────────────────────────
def _row(name="导入客户", **kw):
    return CustomerSeaImportRow(name=name, **kw)


class TestImportToSea:
    def test_happy_path_creates_unowned_customers(self, db_session: Session):
        rows = [_row("客户甲"), _row("客户乙", rating="A", status="signed")]
        result = import_customers_to_sea(db_session, rows, user_id=ALICE)
        assert result["created"] == 2
        assert result["skipped_dupes"] == 0
        assert result["failed"] == []
        custs = (
            db_session.execute(
                select(CrmCustomer).where(CrmCustomer.name.in_(["客户甲", "客户乙"]))
            )
            .scalars()
            .all()
        )
        assert len(custs) == 2
        assert all(c.owner_id is None for c in custs)  # 落公海
        assert all(c.created_by == ALICE for c in custs)

    def test_import_creates_primary_contact(self, db_session: Session):
        result = import_customers_to_sea(
            db_session,
            [_row("带联系人", contact_name="王五", contact_phone="13600000000")],
            user_id=ALICE,
        )
        assert result["created"] == 1
        cust = db_session.execute(
            select(CrmCustomer).where(CrmCustomer.name == "带联系人")
        ).scalar_one()
        ct = db_session.execute(
            select(CrmContact).where(CrmContact.customer_id == cust.id)
        ).scalar_one()
        assert ct.is_primary is True and ct.name == "王五"

    def test_dedup_against_db_by_name_and_phone(self, db_session: Session):
        existing = _seed_customer(db_session, name="已存在", owner_id=None)
        _seed_contact(db_session, existing.id, name="联系人", phone="13500000000")
        db_session.commit()
        result = import_customers_to_sea(
            db_session, [_row("已存在", contact_phone="135-0000-0000")], user_id=ALICE
        )  # norm 后相同
        assert result["created"] == 0
        assert result["skipped_dupes"] == 1

    def test_dedup_within_batch(self, db_session: Session):
        result = import_customers_to_sea(
            db_session, [_row("重复甲"), _row("重复甲"), _row("重复甲")], user_id=ALICE
        )
        assert result["created"] == 1
        assert result["skipped_dupes"] == 2

    def test_same_name_different_phone_not_dupe(self, db_session: Session):
        existing = _seed_customer(db_session, name="同名公司", owner_id=None)
        _seed_contact(db_session, existing.id, name="c", phone="111")
        db_session.commit()
        result = import_customers_to_sea(
            db_session, [_row("同名公司", contact_phone="222")], user_id=ALICE
        )  # 电话不同 → 新客户
        assert result["created"] == 1
        assert result["skipped_dupes"] == 0

    def test_validation_failures_reported_not_inserted(self, db_session: Session):
        rows = [
            _row(""),  # 缺名
            _row("坏等级", rating="X"),  # 等级非法
            _row("坏邮箱", contact_name="c", contact_email="not-email"),  # 邮箱非法
            _row("好客户"),  # 合法
        ]
        result = import_customers_to_sea(db_session, rows, user_id=ALICE)
        assert result["created"] == 1
        assert result["skipped_dupes"] == 0
        assert len(result["failed"]) == 3
        reasons = {(f["row"], f["field"]) for f in result["failed"]}
        assert (1, "name") in reasons
        assert (2, "rating") in reasons
        assert (3, "contact_email") in reasons

    def test_import_accepts_self_developed_source(self, db_session: Session):
        """BLF-1408：来源「自主开发」(self_developed) 必须能导入成功，不落「来源无效」。"""
        result = import_customers_to_sea(
            db_session,
            [_row("自主开发客户", source="self_developed")],
            user_id=ALICE,
        )
        assert result["created"] == 1
        assert result["failed"] == []
        cust = db_session.execute(
            select(CrmCustomer).where(CrmCustomer.name == "自主开发客户")
        ).scalar_one()
        assert cust.source == "self_developed"

    def test_import_source_whitelist_covers_all_six_values(self, db_session: Session):
        """BLF-1408：6 个合法来源值全部可导入（回归：新增不得挤掉既有 5 值）。"""
        for src in (
            "referral",
            "exhibition",
            "online_ad",
            "cold_call",
            "self_developed",
            "other",
        ):
            result = import_customers_to_sea(
                db_session, [_row(f"来源客户-{src}", source=src)], user_id=ALICE
            )
            assert result["created"] == 1, f"{src} 应导入成功"
            assert result["failed"] == [], f"{src} 不应报错：{result['failed']}"

    def test_import_rejects_unknown_source(self, db_session: Session):
        """BLF-1408：非法来源仍被拒（白名单不能变成放行一切）。"""
        result = import_customers_to_sea(
            db_session, [_row("瞎写客户", source="瞎写")], user_id=ALICE
        )
        assert result["created"] == 0
        assert len(result["failed"]) == 1
        assert result["failed"][0]["field"] == "source"

    def test_partial_success_single_commit(self, db_session: Session):
        result = import_customers_to_sea(
            db_session, [_row("成A"), _row(""), _row("成B")], user_id=ALICE
        )
        assert result["created"] == 2 and len(result["failed"]) == 1
        cnt = db_session.execute(
            select(func.count(CrmCustomer.id)).where(CrmCustomer.is_deleted.is_(False))
        ).scalar_one()
        assert cnt == 2
