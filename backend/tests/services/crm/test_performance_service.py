"""dashboard_service P8 业绩看板 tests — BLF-519。

覆盖：
- get_performance_board scope=mine：本人指标 + 我的排名（不泄露他人，ranking 空）
- scope=all（仅管理员）：全局合计 + 全员排名表 + 权限墙（非 admin → 403）
- 指标口径：本月新增客户 / 转化数 / 跟进数 / 任务完成率（done/(done+open)，cancelled 排除）
- 排名主键 sort_by（转化/新增/跟进/完成率）与并列次序
时间口径：Asia/Shanghai（与现有 dashboard 约定一致）。
"""

from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from fastapi import HTTPException
from sqlalchemy import text

from app.models.crm import CrmCustomer, CrmFollow, CrmLead, CrmTask
from app.services.crm import dashboard_service
from app.services.crm.dashboard_service import get_performance_board

SH = ZoneInfo("Asia/Shanghai")

# 固定「现在」= 2026-07-24 10:00 上海时间；本月 = 2026-07
NOW = datetime(2026, 7, 24, 10, 0, 0, tzinfo=SH)
MONTH_START = datetime(2026, 7, 1, 0, 0, 0, tzinfo=SH)
MONTH_LABEL = "2026-07"


# ── 三个「人」的 id ──────────────────────────────────────────────────────────
# ⚠️ 这里**不能写死 UUID**：`backend-go/cmd/seedtestaccounts` 用数据库默认的
# `gen_random_uuid()` 建账号，**每个测试库的账号 id 都不一样**。
# 写死的历史 UUID 只在"当年那个库"里存在，换个库（CI 的全新库 / 新同事的机器）
# 就对不上 → `_active_user_roster` 认不出这个人 → 业绩指标全 0、排名错位。
#
# 所以改成**按 email 从库里查真实 id**（seed 脚本保证这三个账号存在）。
# 名字也要对上：排名 tiebreak 按姓名 codepoint，测试里的排名期望依赖
# 「测试招商 < 测试管理员 < 测试运营」的顺序。
@pytest.fixture
def _seeded_accounts(db_session, settings):
    """按 email 取三个种子账号的真实 id（admin / operator / businessdev）。

    名字按「测试管理员 / 测试运营 / 测试招商」对应：
    ranking tiebreak 按姓名 codepoint，测试里的排名期望依赖
    「测试招商 < 测试管理员 < 测试运营」这个顺序。
    """
    wanted = {
        settings.test_admin_email.lower(): "admin",
        settings.test_operator_email.lower(): "operator",
        settings.test_businessdev_email.lower(): "businessdev",
    }
    rows = db_session.execute(
        text(
            "select email, id::text as id, name from public.user_accounts "
            "where is_active = true"
        )
    ).mappings().all()
    by_email = {r["email"].lower(): (r["id"], r["name"]) for r in rows}

    out = {}
    missing = []
    for email, role in wanted.items():
        if email not in by_email:
            missing.append(email)
        else:
            out[role] = by_email[email]
    if missing:
        pytest.fail(
            f"测试账号缺失: {missing} —— 先跑 `python backend-go/cmd/seedtestaccounts`"
        )
    return out


@pytest.fixture
def admin_id(_seeded_accounts):
    """测试管理员的真实 id。"""
    return _seeded_accounts["admin"][0]


@pytest.fixture
def op1_id(_seeded_accounts):
    """测试运营的真实 id。"""
    return _seeded_accounts["operator"][0]


@pytest.fixture
def op2_id(_seeded_accounts):
    """测试招商的真实 id。"""
    return _seeded_accounts["businessdev"][0]


@pytest.fixture(autouse=True)
def _clean_crm_tables(db_session):
    from app.db.session import SessionLocal

    s = SessionLocal()
    try:
        s.execute(
            text(
                "truncate crm_audit_logs, crm_follows, crm_contacts, "
                "crm_tasks, crm_leads, crm_customers restart identity cascade"
            )
        )
        s.commit()
    finally:
        s.close()
    yield


def _mk_customer(db, **kw):
    kw.setdefault("created_at", NOW)
    c = CrmCustomer(**kw)
    db.add(c)
    db.commit()
    db.refresh(c)
    return c


def _mk_lead(db, **kw):
    kw.setdefault("created_at", NOW)
    lead = CrmLead(**kw)
    db.add(lead)
    db.commit()
    db.refresh(lead)
    return lead


def _mk_follow(db, **kw):
    kw.setdefault("created_at", NOW)
    kw.setdefault("entity_type", "lead")
    kw.setdefault("entity_id", 1)
    kw.setdefault("type", "note")
    kw.setdefault("content", "x")
    f = CrmFollow(**kw)
    db.add(f)
    db.commit()
    db.refresh(f)
    return f


def _mk_task(db, **kw):
    kw.setdefault("created_at", NOW)
    kw.setdefault("status", "pending")
    kw.setdefault("title", "T")
    t = CrmTask(**kw)
    db.add(t)
    db.commit()
    db.refresh(t)
    return t


# =====================================================================
# 权限
# =====================================================================


def test_scope_mine_allowed_for_non_admin(db_session, op1_id):
    # 非管理员看自己 → 允许（员工看自己）
    board = get_performance_board(
        db_session, user_id=op1_id, is_admin=False, scope="mine", now=NOW
    )
    assert board.scope == "mine"
    assert board.month == MONTH_LABEL
    assert board.ranking == []


def test_scope_all_requires_admin(db_session, op1_id):
    with pytest.raises(HTTPException) as exc:
        get_performance_board(
            db_session, user_id=op1_id, is_admin=False, scope="all", now=NOW
        )
    assert exc.value.status_code == 403


# =====================================================================
# scope=mine：个人指标 + 我的排名
# =====================================================================


def test_mine_metrics_and_rank(db_session, op1_id, op2_id):
    _mk_customer(db_session, name="C1", owner_id=op1_id)
    _mk_customer(db_session, name="C2", owner_id=op1_id)
    _mk_customer(db_session, name="C其他", owner_id=op2_id)
    _mk_lead(
        db_session,
        name="L1",
        status="converted",
        owner_id=op1_id,
        converted_at=MONTH_START + timedelta(days=2),
    )
    _mk_follow(db_session, created_by=op1_id)
    _mk_follow(db_session, created_by=op1_id)
    _mk_task(
        db_session,
        owner_id=op1_id,
        status="done",
        completed_at=MONTH_START + timedelta(days=1),
    )
    _mk_task(db_session, owner_id=op1_id, status="pending")

    board = get_performance_board(
        db_session, user_id=op1_id, is_admin=False, scope="mine", now=NOW
    )
    m = board.mine
    assert m.new_customers == 2
    assert m.converted_count == 1
    assert m.follow_count == 2
    assert m.completion_rate == pytest.approx(0.5)  # 1 done / (1 done + 1 open)
    assert board.total_users == 3
    assert board.my_rank == 1  # 转化数第一 → 并列比新增 → OP1 领先
    assert board.ranking == []  # 员工只见自己


def test_mine_zero_metrics_when_no_data(db_session, op2_id):
    board = get_performance_board(
        db_session, user_id=op2_id, is_admin=False, scope="mine", now=NOW
    )
    m = board.mine
    assert m.new_customers == 0
    assert m.converted_count == 0
    assert m.follow_count == 0
    assert m.completion_rate is None
    # 三人全 0 转化 → 按姓名 tiebreak（测试招商的 codepoint 最小 → rank 1）
    assert board.my_rank == 1
    assert board.total_users == 3


# =====================================================================
# scope=all：全局合计 + 排名表
# =====================================================================


def test_all_global_and_ranking(db_session, op1_id, op2_id, admin_id):
    # OP1：2 客户 / 1 转化 / 2 跟进 / 完成率 0.5
    _mk_customer(db_session, name="C1", owner_id=op1_id)
    _mk_customer(db_session, name="C2", owner_id=op1_id)
    _mk_lead(
        db_session,
        name="L1",
        status="converted",
        owner_id=op1_id,
        converted_at=MONTH_START + timedelta(days=2),
    )
    _mk_follow(db_session, created_by=op1_id)
    _mk_follow(db_session, created_by=op1_id)
    _mk_task(
        db_session,
        owner_id=op1_id,
        status="done",
        completed_at=MONTH_START + timedelta(days=1),
    )
    _mk_task(db_session, owner_id=op1_id, status="pending")

    # OP2：1 客户 / 0 转化 / 1 跟进 / 完成率 None
    _mk_customer(db_session, name="C3", owner_id=op2_id)
    _mk_follow(db_session, created_by=op2_id)

    # 全局额外有：无主客户（公海）+ 上月客户 + 已删除客户 → 不计本月全局
    _mk_customer(db_session, name="公海", owner_id=None)
    _mk_customer(
        db_session,
        name="上月",
        owner_id=op1_id,
        created_at=MONTH_START - timedelta(days=1),
    )
    _mk_customer(db_session, name="已删", owner_id=op1_id, is_deleted=True)

    board = get_performance_board(
        db_session, user_id=admin_id, is_admin=True, scope="all", now=NOW
    )
    # 全局合计：4 本月客户（OP1×2 + OP2×1 + 公海×1）/ 1 转化 / 3 跟进 / done 1 + open 1
    g = board.global_metrics
    assert g.new_customers == 4
    assert g.converted_count == 1
    assert g.follow_count == 3
    assert g.completion_rate == pytest.approx(0.5)

    # 排名表：3 人，OP1 转化第一 → rank1；OP2 全 0（但有新增）→ 转化相同比新增 → rank2
    assert len(board.ranking) == 3
    r1, r2, r3 = board.ranking
    assert r1.owner_id == op1_id and r1.rank == 1
    assert r1.new_customers == 2 and r1.converted_count == 1 and r1.follow_count == 2
    assert r1.completion_rate == pytest.approx(0.5)
    # OP2：转化 0、新增 1 > 管理员（转化 0、新增 0）→ rank2
    assert r2.owner_id == op2_id and r2.rank == 2
    assert r2.new_customers == 1 and r2.converted_count == 0
    assert r2.completion_rate is None
    assert r3.owner_id == admin_id and r3.rank == 3

    # admin 本人的 mine 指标（无数据）
    assert board.mine.new_customers == 0
    assert board.my_rank == 3


def test_all_ranking_sort_by_new_customers(db_session, op1_id, op2_id, admin_id):
    # OP2 新增客户多但转化少：按转化默认 OP1 前；按新增 OP2 前
    _mk_customer(db_session, name="C1", owner_id=op1_id)
    _mk_lead(
        db_session,
        name="L1",
        status="converted",
        owner_id=op1_id,
        converted_at=MONTH_START + timedelta(days=1),
    )
    _mk_customer(db_session, name="C2", owner_id=op2_id)
    _mk_customer(db_session, name="C3", owner_id=op2_id)

    board_conv = get_performance_board(
        db_session, user_id=admin_id, is_admin=True, scope="all", now=NOW
    )
    assert board_conv.ranking[0].owner_id == op1_id

    board_new = get_performance_board(
        db_session,
        user_id=admin_id,
        is_admin=True,
        scope="all",
        sort_by="new_customers",
        now=NOW,
    )
    assert board_new.ranking[0].owner_id == op2_id


def test_month_param_scopes_to_that_month(db_session, op1_id):
    # 6 月的数据不影响 7 月看板
    jun_start = datetime(2026, 6, 1, tzinfo=SH)
    _mk_customer(db_session, name="C上月", owner_id=op1_id, created_at=jun_start)
    _mk_customer(
        db_session,
        name="C本月",
        owner_id=op1_id,
        created_at=MONTH_START + timedelta(days=1),
    )

    board = get_performance_board(
        db_session, user_id=op1_id, is_admin=False, scope="mine", now=NOW
    )
    assert board.mine.new_customers == 1

    board_jun = get_performance_board(
        db_session,
        user_id=op1_id,
        is_admin=False,
        scope="mine",
        month="2026-06",
        now=NOW,
    )
    assert board_jun.month == "2026-06"
    assert board_jun.mine.new_customers == 1


def test_month_param_invalid_raises_value_error(db_session, op1_id):
    with pytest.raises(ValueError):
        get_performance_board(
            db_session,
            user_id=op1_id,
            is_admin=False,
            scope="mine",
            month="2026-13",
            now=NOW,
        )


def test_invalid_sort_by_raises_value_error(db_session, admin_id):
    with pytest.raises(ValueError):
        get_performance_board(
            db_session,
            user_id=admin_id,
            is_admin=True,
            scope="all",
            sort_by="bogus",
            now=NOW,
        )


def test_ranking_sort_by_completion_rate_none_last(db_session, op1_id, op2_id, admin_id):
    # OP1 完成率 1.0（done 1 / open 0）；OP2 完成率 0.5；管理员 None（无任务）
    _mk_task(
        db_session,
        owner_id=op1_id,
        status="done",
        completed_at=MONTH_START + timedelta(days=1),
    )
    _mk_task(
        db_session,
        owner_id=op2_id,
        status="done",
        completed_at=MONTH_START + timedelta(days=1),
    )
    _mk_task(db_session, owner_id=op2_id, status="pending")

    board = get_performance_board(
        db_session,
        user_id=admin_id,
        is_admin=True,
        scope="all",
        sort_by="completion_rate",
        now=NOW,
    )
    assert board.ranking[0].owner_id == op1_id  # 1.0
    assert board.ranking[0].completion_rate == 1.0
    assert board.ranking[1].owner_id == op2_id  # 0.5
    assert board.ranking[1].completion_rate == 0.5
    # None（无任务）排最后，即使姓名 codepoint 最小
    assert board.ranking[2].owner_id == admin_id
    assert board.ranking[2].completion_rate is None
