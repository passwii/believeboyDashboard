"""共享查询 ``query_current_return_rows`` 回归（退货分析口径唯一真相源）。

背景：同一个「当前生效退货行」查询曾在三处各写一份（fallback / snapshot /
Agent raw），Agent 那份漏了 ``is_current`` 过滤，口径已经漂移。本测试锁死
共享函数的语义，并用「与分析 summary 对账」防止再次漂移。

种子数据统一走 ``return_row_factories``（与 HTTP 层测试共用一份，防漂移）。
"""

from __future__ import annotations

import uuid
from datetime import date, timedelta

import pytest
from return_row_factories import (
    default_return_window,
    purge_project_return_data,
    seed_return_row,
    seed_return_source,
)
from sqlalchemy import text

from app.db.session import SessionLocal
from app.services.analysis.return_analysis import (
    build_return_analysis,
    query_current_return_rows,
)


@pytest.fixture()
def db_session():
    session = SessionLocal()
    try:
        yield session
    finally:
        session.rollback()
        session.close()


@pytest.fixture()
def test_project(db_session):
    """独占测试项目 + 显式 teardown（对齐 test_feedback_dedup 模式）。"""
    from app.models import Project

    project = Project(
        project_name=f"shared-return-rows {uuid.uuid4().hex[:8]}",
        sort_order=0,
        is_active=False,
    )
    db_session.add(project)
    db_session.commit()
    db_session.refresh(project)
    pid = project.id
    try:
        yield pid
    finally:
        purge_project_return_data(db_session, pid)


def test_returns_only_current_source_file_rows(db_session, test_project):
    """非 current 的旧版本源文件行必须排除（Agent raw 端点曾漏掉这条）。"""
    start, end = default_return_window()
    d = date.today() - timedelta(days=1)
    current = seed_return_source(
        db_session, test_project, tag="cur", is_current=True, version=1
    )
    stale = seed_return_source(
        db_session, test_project, tag="old", is_current=False, version=2
    )
    seed_return_row(
        db_session,
        source_file_id=current.id,
        project_id=test_project,
        order_id="O-CUR",
        sku="S-1",
        return_date=d,
        license_plate="LP-CUR",
        row_no=1,
    )
    seed_return_row(
        db_session,
        source_file_id=stale.id,
        project_id=test_project,
        order_id="O-OLD",
        sku="S-1",
        return_date=d,
        license_plate="LP-OLD",
        row_no=1,
    )

    rows = query_current_return_rows(
        db_session, project_id=test_project, country="US", start_date=start, end_date=end
    )

    assert [r.order_id for r in rows] == ["O-CUR"]


def test_excludes_out_of_range_and_other_country(db_session, test_project):
    """日期范围外与别的国家的行都不出现。"""
    start, end = default_return_window()
    d = date.today() - timedelta(days=1)
    sf_us = seed_return_source(db_session, test_project, tag="us")
    sf_de = seed_return_source(db_session, test_project, tag="de", country="DE")
    seed_return_row(
        db_session,
        source_file_id=sf_us.id,
        project_id=test_project,
        order_id="O-IN",
        sku="S-1",
        return_date=d,
        license_plate="LP-1",
        row_no=1,
    )
    seed_return_row(
        db_session,
        source_file_id=sf_us.id,
        project_id=test_project,
        order_id="O-BEFORE",
        sku="S-1",
        return_date=date.fromisoformat(start) - timedelta(days=1),
        license_plate="LP-2",
        row_no=2,
    )
    seed_return_row(
        db_session,
        source_file_id=sf_us.id,
        project_id=test_project,
        order_id="O-AFTER",
        sku="S-1",
        return_date=date.fromisoformat(end) + timedelta(days=1),
        license_plate="LP-3",
        row_no=3,
    )
    seed_return_row(
        db_session,
        source_file_id=sf_de.id,
        project_id=test_project,
        country="DE",
        order_id="O-DE",
        sku="S-1",
        return_date=d,
        license_plate="LP-4",
        row_no=1,
    )

    rows = query_current_return_rows(
        db_session, project_id=test_project, country="US", start_date=start, end_date=end
    )

    assert [r.order_id for r in rows] == ["O-IN"]


def test_sku_filter(db_session, test_project):
    """传 sku 只回该 SKU；不传回全部。"""
    start, end = default_return_window()
    d = date.today() - timedelta(days=1)
    sf = seed_return_source(db_session, test_project, tag="sku")
    seed_return_row(
        db_session,
        source_file_id=sf.id,
        project_id=test_project,
        order_id="O-A",
        sku="SKU-A",
        return_date=d,
        license_plate="LP-A",
        row_no=1,
    )
    seed_return_row(
        db_session,
        source_file_id=sf.id,
        project_id=test_project,
        order_id="O-B",
        sku="SKU-B",
        return_date=d,
        license_plate="LP-B",
        row_no=2,
    )

    filtered = query_current_return_rows(
        db_session,
        project_id=test_project,
        country="US",
        start_date=start,
        end_date=end,
        sku="SKU-A",
    )
    everything = query_current_return_rows(
        db_session, project_id=test_project, country="US", start_date=start, end_date=end
    )

    assert [r.order_id for r in filtered] == ["O-A"]
    assert {r.sku for r in everything} == {"SKU-A", "SKU-B"}


def test_ordering_is_return_date_then_id(db_session, test_project):
    """排序确定性：return_date 升序，同日按 id 升序（导出可复现的前提）。

    鉴别力：只按 ``return_date`` 排序时，Postgres 对同日行返回的是**物理
    （堆 / TID）顺序**，而普通插入的物理顺序恒等于 id 顺序 —— 那样即使删掉
    ``queries.py`` 里的 ``AnalysisReturnRow.id.asc()`` 兜底，断言照样成立。

    所以这里让两者刻意相反：``O-LATE-1`` 先插（拿到更小的 id），随后原值重写
    一次（MVCC 下 UPDATE 会生成新的行版本、物理上挪到 ``O-LATE-2`` 之后），
    于是同日两行的物理顺序是 ``[O-LATE-2, O-LATE-1]``，只有 id 兜底才能得到
    期望的 ``[O-LATE-1, O-LATE-2]``。``source_row_no`` 同步按物理顺序编排。
    """
    start, end = default_return_window()
    end_date = date.today() - timedelta(days=1)
    earlier = end_date - timedelta(days=1)
    sf = seed_return_source(db_session, test_project, tag="ord")
    # 故意先插较晚的两行，验证结果不是插入顺序
    seed_return_row(
        db_session,
        source_file_id=sf.id,
        project_id=test_project,
        order_id="O-LATE-1",
        sku="S-1",
        return_date=end_date,
        license_plate="LP-L1",
        row_no=2,
    )
    seed_return_row(
        db_session,
        source_file_id=sf.id,
        project_id=test_project,
        order_id="O-LATE-2",
        sku="S-1",
        return_date=end_date,
        license_plate="LP-L2",
        row_no=1,
    )
    seed_return_row(
        db_session,
        source_file_id=sf.id,
        project_id=test_project,
        order_id="O-EARLY",
        sku="S-1",
        return_date=earlier,
        license_plate="LP-E1",
        row_no=3,
    )
    # 重写 O-LATE-1：让它的行版本落到 O-LATE-2 之后（物理顺序与 id 顺序解耦）
    db_session.execute(
        text(
            "UPDATE analysis_return_rows SET customer_comments = :comment "
            "WHERE project_id = :pid AND order_id = 'O-LATE-1'"
        ),
        {"comment": "ordering-tiebreak-probe", "pid": test_project},
    )
    db_session.commit()

    rows = query_current_return_rows(
        db_session, project_id=test_project, country="US", start_date=start, end_date=end
    )

    assert [r.order_id for r in rows] == ["O-EARLY", "O-LATE-1", "O-LATE-2"]


def test_parity_with_analysis_summary_total_quantity(db_session, test_project):
    """对账：共享查询 quantity 合计 == 分析 summary.total_quantity（防口径漂移）。"""
    start, end = default_return_window()
    d = date.today() - timedelta(days=1)
    sf = seed_return_source(db_session, test_project, tag="parity")
    seed_return_row(
        db_session,
        source_file_id=sf.id,
        project_id=test_project,
        order_id="O-1",
        sku="S-1",
        return_date=d,
        license_plate="LP-1",
        row_no=1,
        quantity=2,
    )
    seed_return_row(
        db_session,
        source_file_id=sf.id,
        project_id=test_project,
        order_id="O-2",
        sku="S-2",
        return_date=d,
        license_plate="LP-2",
        row_no=2,
        quantity=3,
    )

    rows = query_current_return_rows(
        db_session, project_id=test_project, country="US", start_date=start, end_date=end
    )
    analysis = build_return_analysis(
        db_session,
        project_id=test_project,
        country="US",
        start_date=start,
        end_date=end,
    )
    # build_return_analysis 会把 ORM 对象的 return_date 就地改成 str（历史行为），
    # rollback 丢弃这处脏状态，避免 teardown 的 DELETE 触发 autoflush 写坏列。
    # 种子数据是已提交的，rollback 不会丢。
    db_session.rollback()

    assert sum(r.quantity for r in rows) == 5
    assert sum(r.quantity for r in rows) == analysis.summary.total_quantity
