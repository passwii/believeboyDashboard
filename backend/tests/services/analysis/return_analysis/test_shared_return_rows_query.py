"""共享查询 ``query_current_return_rows`` 回归（退货分析口径唯一真相源）。

背景：同一个「当前生效退货行」查询曾在三处各写一份（fallback / snapshot /
Agent raw），Agent 那份漏了 ``is_current`` 过滤，口径已经漂移。本测试锁死
共享函数的语义，并用「与分析 summary 对账」防止再次漂移。
"""

from __future__ import annotations

import uuid
from datetime import date, timedelta

import pytest
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
        db_session.expire_all()
        for table in (
            "analysis_return_rows",
            "analysis_sales_order_rows",
            "analysis_source_files",
            "analysis_return_aggregates",
        ):
            db_session.execute(
                text(f"DELETE FROM {table} WHERE project_id = :pid"), {"pid": pid}
            )
        db_session.execute(text("DELETE FROM projects WHERE id = :pid"), {"pid": pid})
        db_session.commit()


def _seed_source(
    db_session,
    project_id: int,
    tag: str,
    *,
    is_current: bool = True,
    version: int = 1,
    country: str = "US",
):
    """建一张 return_report 源文件。

    唯一键是 (project_id, report_type, country, period_start_date,
    period_end_date, version) —— 同国家同周期要建第二张必须换 version。
    """
    from app.models import AnalysisSourceFile

    sf = AnalysisSourceFile(
        project_id=project_id,
        country=country,
        report_type="return_report",
        upload_file_id=f"shared_{tag}_{project_id}",
        upload_file_path=f"/tmp/shared_{tag}.csv",
        original_filename=f"shared_{tag}.csv",
        stored_filename=f"shared_{tag}.csv",
        logical_filename=f"shared_{tag}.csv",
        storage_key=f"shared/{tag}.csv",
        period_start_date=date.today() - timedelta(days=30),
        period_end_date=date.today(),
        is_current=is_current,
        version=version,
        ingestion_status="success",
    )
    db_session.add(sf)
    db_session.commit()
    db_session.refresh(sf)
    return sf


def _add_row(
    db_session,
    *,
    source_file_id: int,
    project_id: int,
    order_id: str,
    sku: str,
    return_date: date,
    license_plate: str,
    row_no: int,
    country: str = "US",
    quantity: int = 1,
):
    from app.models import AnalysisReturnRow

    db_session.add(
        AnalysisReturnRow(
            project_id=project_id,
            country=country,
            source_file_id=source_file_id,
            source_row_no=row_no,
            return_date=return_date,
            order_id=order_id,
            sku=sku,
            quantity=quantity,
            detailed_disposition="SELLABLE",
            reason="NOT_AS_DESCRIBED",
            status="Unit returned to inventory",
            license_plate_number=license_plate,
            original_return_datetime=f"{return_date.isoformat()}T10:00:00+00:00",
        )
    )
    db_session.commit()


def _window() -> tuple[str, str]:
    """近 7 天窗口（与 Agent 测试同口径：昨天为右端点）。"""
    d = date.today() - timedelta(days=1)
    return (d - timedelta(days=6)).isoformat(), d.isoformat()


def test_returns_only_current_source_file_rows(db_session, test_project):
    """非 current 的旧版本源文件行必须排除（Agent raw 端点曾漏掉这条）。"""
    start, end = _window()
    d = date.today() - timedelta(days=1)
    current = _seed_source(db_session, test_project, "cur", is_current=True, version=1)
    stale = _seed_source(db_session, test_project, "old", is_current=False, version=2)
    _add_row(
        db_session,
        source_file_id=current.id,
        project_id=test_project,
        order_id="O-CUR",
        sku="S-1",
        return_date=d,
        license_plate="LP-CUR",
        row_no=1,
    )
    _add_row(
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
    start, end = _window()
    d = date.today() - timedelta(days=1)
    sf_us = _seed_source(db_session, test_project, "us")
    sf_de = _seed_source(db_session, test_project, "de", country="DE")
    _add_row(
        db_session,
        source_file_id=sf_us.id,
        project_id=test_project,
        order_id="O-IN",
        sku="S-1",
        return_date=d,
        license_plate="LP-1",
        row_no=1,
    )
    _add_row(
        db_session,
        source_file_id=sf_us.id,
        project_id=test_project,
        order_id="O-BEFORE",
        sku="S-1",
        return_date=date.fromisoformat(start) - timedelta(days=1),
        license_plate="LP-2",
        row_no=2,
    )
    _add_row(
        db_session,
        source_file_id=sf_us.id,
        project_id=test_project,
        order_id="O-AFTER",
        sku="S-1",
        return_date=date.fromisoformat(end) + timedelta(days=1),
        license_plate="LP-3",
        row_no=3,
    )
    _add_row(
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
    start, end = _window()
    d = date.today() - timedelta(days=1)
    sf = _seed_source(db_session, test_project, "sku")
    _add_row(
        db_session,
        source_file_id=sf.id,
        project_id=test_project,
        order_id="O-A",
        sku="SKU-A",
        return_date=d,
        license_plate="LP-A",
        row_no=1,
    )
    _add_row(
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
    """排序确定性：return_date 升序，同日按 id 升序（导出可复现的前提）。"""
    start, end = _window()
    end_date = date.today() - timedelta(days=1)
    earlier = end_date - timedelta(days=1)
    sf = _seed_source(db_session, test_project, "ord")
    # 故意先插较晚的两行，验证结果不是插入顺序
    _add_row(
        db_session,
        source_file_id=sf.id,
        project_id=test_project,
        order_id="O-LATE-1",
        sku="S-1",
        return_date=end_date,
        license_plate="LP-L1",
        row_no=1,
    )
    _add_row(
        db_session,
        source_file_id=sf.id,
        project_id=test_project,
        order_id="O-LATE-2",
        sku="S-1",
        return_date=end_date,
        license_plate="LP-L2",
        row_no=2,
    )
    _add_row(
        db_session,
        source_file_id=sf.id,
        project_id=test_project,
        order_id="O-EARLY",
        sku="S-1",
        return_date=earlier,
        license_plate="LP-E1",
        row_no=3,
    )

    rows = query_current_return_rows(
        db_session, project_id=test_project, country="US", start_date=start, end_date=end
    )

    assert [r.order_id for r in rows] == ["O-EARLY", "O-LATE-1", "O-LATE-2"]


def test_parity_with_analysis_summary_total_quantity(db_session, test_project):
    """对账：共享查询 quantity 合计 == 分析 summary.total_quantity（防口径漂移）。"""
    start, end = _window()
    d = date.today() - timedelta(days=1)
    sf = _seed_source(db_session, test_project, "parity")
    _add_row(
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
    _add_row(
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
