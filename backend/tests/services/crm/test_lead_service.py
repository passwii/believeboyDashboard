"""lead_service TDD tests — CRUD / scope / keyword / 线索池(transfer/move-pool/claim)."""
from __future__ import annotations

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.models.crm import CrmLead
from app.schemas.crm import LeadCreate, LeadUpdate
from app.services.crm.lead_service import (
    batch_move_to_pool,
    batch_transfer,
    claim_from_pool,
    create_lead,
    get_lead,
    list_leads,
    update_lead,
)

# 用户 id 是 UUID 字符串（user_accounts.id）；以下为本测试用的假 UUID。
ALICE = "11111111-1111-1111-1111-111111111111"
BOB = "22222222-2222-2222-2222-222222222222"
CAROL = "33333333-3333-3333-3333-333333333333"


# ── helpers ──────────────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def _clean_crm_tables(db_session):
    """服务层（create_lead 等）会 commit，跨测试/跨运行会留下脏数据。

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


def _seed_lead(db: Session, name: str = "张三", owner_id: str | None = ALICE, **kw) -> CrmLead:
    lead = CrmLead(name=name, owner_id=owner_id, created_by=owner_id, **kw)
    db.add(lead)
    db.flush()
    return lead


# ── CRUD ─────────────────────────────────────────────────────────────────────

class TestCreate:
    def test_create_returns_item_with_owner_default(self, db_session: Session):
        payload = LeadCreate(name="李四")
        item = create_lead(db_session, payload, user_id=ALICE)
        assert item is not None
        assert item.name == "李四"
        assert item.owner_id == ALICE  # 默认归创建人
        assert item.created_by == ALICE

    def test_create_with_new_fields(self, db_session: Session):
        payload = LeadCreate(
            name="王五",
            company="东莞五金厂",
            source="展会",
            intent="high",
            customer_type="工厂",
            interested_service="AI运营",
        )
        item = create_lead(db_session, payload, user_id=ALICE)
        assert item is not None
        assert item.company == "东莞五金厂"
        assert item.source == "展会"
        assert item.intent == "high"
        assert item.customer_type == "工厂"
        assert item.interested_service == "AI运营"

    def test_create_explicit_owner(self, db_session: Session):
        payload = LeadCreate(name="赵六", owner_id=BOB)
        item = create_lead(db_session, payload, user_id=ALICE)
        assert item.owner_id == BOB

    def test_create_no_user(self, db_session: Session):
        payload = LeadCreate(name="匿名线索")
        item = create_lead(db_session, payload, user_id=None)
        assert item.owner_id is None
        assert item.created_by is None


class TestGet:
    def test_get_existing(self, db_session: Session):
        lead = _seed_lead(db_session, name="取我")
        item = get_lead(db_session, lead.id)
        assert item is not None
        assert item.name == "取我"

    def test_get_deleted_returns_none(self, db_session: Session):
        lead = _seed_lead(db_session, name="已删")
        lead.is_deleted = True
        db_session.flush()
        assert get_lead(db_session, lead.id) is None

    def test_get_missing_returns_none(self, db_session: Session):
        assert get_lead(db_session, 999999) is None


class TestUpdate:
    def test_update_fields(self, db_session: Session):
        lead = _seed_lead(db_session, name="旧名")
        item = update_lead(db_session, lead.id, LeadUpdate(name="新名", intent="high"))
        assert item is not None
        assert item.name == "新名"
        assert item.intent == "high"

    def test_update_status_discarded(self, db_session: Session):
        lead = _seed_lead(db_session, name="弃置")
        item = update_lead(db_session, lead.id, LeadUpdate(status="discarded"))
        assert item is not None
        assert item.status == "discarded"

    def test_update_status_qualified(self, db_session: Session):
        lead = _seed_lead(db_session, name="合格")
        item = update_lead(db_session, lead.id, LeadUpdate(status="qualified"))
        assert item is not None
        assert item.status == "qualified"

    def test_update_missing_returns_none(self, db_session: Session):
        assert update_lead(db_session, 999999, LeadUpdate(name="X")) is None


# ── scope ────────────────────────────────────────────────────────────────────

class TestScope:
    def test_scope_mine(self, db_session: Session):
        _seed_lead(db_session, name="我的线索", owner_id=ALICE)
        _seed_lead(db_session, name="别人线索", owner_id=BOB)
        items, total = list_leads(db_session, user_id=ALICE, scope="mine")
        assert total == 1
        assert items[0].name == "我的线索"

    def test_scope_all(self, db_session: Session):
        _seed_lead(db_session, name="L1", owner_id=ALICE)
        _seed_lead(db_session, name="L2", owner_id=BOB)
        _seed_lead(db_session, name="L3", owner_id=None)
        items, total = list_leads(db_session, user_id=ALICE, scope="all")
        assert total == 3

    def test_scope_sea_is_pool(self, db_session: Session):
        _seed_lead(db_session, name="池中", owner_id=None)
        _seed_lead(db_session, name="已领", owner_id=ALICE)
        items, total = list_leads(db_session, user_id=ALICE, scope="sea")
        names = [i.name for i in items]
        assert "池中" in names
        assert "已领" not in names
        assert total == 1

    def test_keyword_matches_name(self, db_session: Session):
        _seed_lead(db_session, name="独特名字XYZ")
        items, total = list_leads(db_session, user_id=None, scope="all", keyword="独特名字XYZ")
        assert total == 1
        assert items[0].name == "独特名字XYZ"

    def test_keyword_matches_company(self, db_session: Session):
        _seed_lead(db_session, name="某人", company="独特公司ABC")
        items, total = list_leads(db_session, user_id=None, scope="all", keyword="独特公司ABC")
        assert total == 1
        assert items[0].company == "独特公司ABC"

    def test_pagination(self, db_session: Session):
        for i in range(5):
            _seed_lead(db_session, name=f"分页{i}", owner_id=ALICE)
        items, total = list_leads(db_session, user_id=ALICE, scope="mine", page=1, page_size=2)
        assert total == 5
        assert len(items) == 2
        items2, _ = list_leads(db_session, user_id=ALICE, scope="mine", page=3, page_size=2)
        assert len(items2) == 1


# ── 线索池操作 ────────────────────────────────────────────────────────────────

class TestPool:
    def test_batch_transfer(self, db_session: Session):
        l1 = _seed_lead(db_session, name="T1", owner_id=ALICE)
        l2 = _seed_lead(db_session, name="T2", owner_id=ALICE)
        count = batch_transfer(db_session, [l1.id, l2.id], to_owner_id=CAROL)
        assert count == 2
        db_session.refresh(l1)
        assert l1.owner_id == CAROL

    def test_batch_move_to_pool(self, db_session: Session):
        l1 = _seed_lead(db_session, name="P1", owner_id=BOB)
        count = batch_move_to_pool(db_session, [l1.id])
        assert count == 1
        db_session.refresh(l1)
        assert l1.owner_id is None

    def test_claim_success(self, db_session: Session):
        lead = _seed_lead(db_session, name="池线索", owner_id=None)
        item = claim_from_pool(db_session, lead.id, user_id=BOB)
        assert item is not None
        assert item.owner_id == BOB

    def test_claim_owned_returns_none(self, db_session: Session):
        lead = _seed_lead(db_session, name="已被领", owner_id=ALICE)
        assert claim_from_pool(db_session, lead.id, user_id=BOB) is None

    def test_claim_no_user_returns_none(self, db_session: Session):
        lead = _seed_lead(db_session, name="池无用户", owner_id=None)
        assert claim_from_pool(db_session, lead.id, user_id=None) is None


# ── owner_name join + LeadItem 新字段 ─────────────────────────────────────────

class TestOwnerNameJoin:
    def test_owner_name_resolves_from_user_accounts(self, db_session: Session, test_admin: dict):
        admin_id = str(test_admin["id"])
        lead = _seed_lead(db_session, name="有名负责人", owner_id=admin_id)
        item = get_lead(db_session, lead.id)
        assert item is not None
        assert item.owner_id == admin_id
        assert item.owner_name == test_admin["name"]  # 类型匹配后非 None


class TestLeadItemFields:
    def test_item_includes_customer_type_and_interested_service(self, db_session: Session):
        lead = _seed_lead(
            db_session,
            name="字段线索",
            customer_type="贸易商",
            interested_service="代运营",
        )
        item = get_lead(db_session, lead.id)
        assert item is not None
        assert item.customer_type == "贸易商"
        assert item.interested_service == "代运营"

    def test_list_item_includes_new_fields(self, db_session: Session):
        _seed_lead(
            db_session,
            name="列表字段",
            owner_id=ALICE,
            customer_type="同行",
            interested_service="运营服务",
        )
        items, _ = list_leads(db_session, user_id=ALICE, scope="mine", keyword="列表字段")
        assert items[0].customer_type == "同行"
        assert items[0].interested_service == "运营服务"
