"""BLF-1078 回归：R1/R2/R3/R4 四条退货分析路由的口径必须互相一致。

生产实测（2026-09-15，窗口 2026-01-01~2026-09-14，10 个 US 项目）发现的缺陷
全部锁死在本文件；每条用例都对应 issue 里一个已证实的问题，用最小反例把修复
语义固定下来（而不是依赖生产数据）。

覆盖：

* P0-1 R2 分子漏算 —— R2 曾读 ``analysis_return_aggregates`` 物化缓存，而
  该表只为「每日任务处理过的 (SKU, 日)」落行；新入库的历史报表要等下次刷新
  才可见（生产：铨富 R2=43 vs R1/R3=66）。现在 R2 与 R1/R3 同读当前生效 raw。
* P0-2 R2 分母漏零退货 SKU —— 只有退货的 SKU 会进分子集合，仅按退货行聚合
  会漏掉「本期零退货」的 SKU 销量（生产：华洋泛航 +2.56pp、犀牛 +0.32pp；
  短窗口下整店分母直接塌陷为 0）。
* P1-3 R1 榜单 20 行静默截断 —— SKU 数 >20 时尾部 SKU 无提示消失
  （生产：犀牛 30 个 SKU 只返回 20 行）。现在返回 ``ranking_truncated`` +
  ``ranking_total_count``。
* P1-4 R4 summary 分母错挂整店 —— 单 SKU 钻取的 ``summary`` 分母是整店销量，
  退货率被稀释十几倍（生产：铨富 MJQ-TR250NM 低估 16 倍）。
* P1-5 无数据被渲染成 0% —— 窗口完全落在退货数据跨度之前时返回
  ``overall_return_rate: 0.0``，与「真实零退货」无法区分
  （生产：犀牛 2025 有 8690 件销售、报 0.0%，但退货数据自 2026-03-28 才开始）。
* P2-6 ``risk_level="no_data"`` 掩藏高退货率长尾 SKU —— 销量样本不足
  （<15）被打成 ``no_data``，而调用方常用 risk_level 过滤高风险 SKU，
  于是 JTZ-M35-78（200%）、SMJ-6x9（53.85%）这类单品被直接滤掉。
  现在另给 ``confidence`` 字段表达「样本量不足」。
* 附带回归：``build_return_analysis`` 曾就地改写 ORM 行的 ``return_date``
  （date → str），污染 session identity map，导致同一 session 后续查询
  （如 R3 raw）抛 ``AttributeError: 'str' object has no attribute 'isoformat'``。
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

import pytest
from sqlalchemy import delete, select

from app.models import (
    AnalysisReturnAggregate,
    AnalysisReturnRow,
    AnalysisSalesOrderRow,
    AnalysisSourceFile,
    Project,
)

D1, D2, D3 = date(2026, 6, 10), date(2026, 6, 11), date(2026, 6, 12)
WIN_START, WIN_END = D1.isoformat(), D3.isoformat()


@pytest.fixture()
def consistency_project(db_session):
    """最小反例基座：一个 SKU 有退货、另一个 SKU 只有销售（零退货）。

    ``SKU-RET``：d1 两笔退货（2 件 × 2 单 = 4 件）；窗口内销售 10+20+40 = 70。
    ``SKU-SALEONLY``：窗口内销售 30 但零退货——正是 P0-2 会漏掉的那部分分母。

    聚合表刻意只写 d1 的退货 SKU（模拟生产：只为有退货的 (SKU, 日) 落行），
    并额外写一条**过期**的 ``SKU-RET`` 聚合行（return_quantity 故意偏小），
    用来证明 R2 不再信任这份缓存。
    """
    project = Project(
        project_name=f"BLF-1078 consistency {D1.isoformat()}",
        sort_order=0,
        is_active=False,  # 测试项目永远 inactive，防止污染生产下拉
    )
    db_session.add(project)
    db_session.commit()
    db_session.refresh(project)
    pid = project.id

    sf_ret = AnalysisSourceFile(
        report_type="return_report",
        is_current=True,
        project_id=pid,
        country="US",
        upload_file_id=f"BLF1078-ret-{pid}",
        upload_file_path=f"return_report/{pid}/test.csv",
        original_filename="return_report.csv",
        stored_filename="return_report.csv",
        logical_filename="return_report.csv",
        storage_key=f"return_report/{pid}/test.csv",
        file_size_bytes=1024,
        file_sha256="deadbeef",
        period_start_date=D1,
        period_end_date=D3,
        snapshot_at=None,
        version=1,
        ingestion_status="success",
    )
    sf_sales = AnalysisSourceFile(
        report_type="sales_report",
        is_current=True,
        project_id=pid,
        country="US",
        upload_file_id=f"BLF1078-sales-{pid}",
        upload_file_path=f"sales_report/{pid}/test.csv",
        original_filename="sales_report.csv",
        stored_filename="sales_report.csv",
        logical_filename="sales_report.csv",
        storage_key=f"sales_report/{pid}/test.csv",
        file_size_bytes=1024,
        file_sha256="deadbeef",
        period_start_date=D1,
        period_end_date=D3,
        snapshot_at=None,
        version=1,
        ingestion_status="success",
    )
    db_session.add_all([sf_ret, sf_sales])
    db_session.flush()

    _pt = timezone(timedelta(hours=-7))

    def _sale(order_id: str, d: date, sku: str, qty: int) -> None:
        _d_utc = datetime(d.year, d.month, d.day, 12, 0, 0, tzinfo=timezone.utc)
        db_session.add(
            AnalysisSalesOrderRow(
                project_id=pid,
                country="US",
                source_file_id=sf_sales.id,
                source_row_no=abs(hash(order_id)) % 100000,
                amazon_order_id=order_id,
                purchase_at_utc=_d_utc,
                purchase_at_pt=_d_utc.astimezone(_pt).replace(tzinfo=None),
                purchase_date_pt=d,
                sku=sku,
                quantity=qty,
                is_counted_sales=True,
                order_status="Shipped",
            )
        )

    # SKU-RET：窗口内销售 70（分散 3 天）
    _sale("RET-O1", D1, "SKU-RET", 10)
    _sale("RET-O2", D2, "SKU-RET", 20)
    _sale("RET-O3", D3, "SKU-RET", 40)
    # SKU-SALEONLY：窗口内销售 30，零退货（P0-2 会漏掉它）
    _sale("SO-1", D1, "SKU-SALEONLY", 30)

    for i in range(2):
        db_session.add(
            AnalysisReturnRow(
                project_id=pid,
                country="US",
                source_file_id=sf_ret.id,
                source_row_no=i + 1,
                return_date=D1,
                sku="SKU-RET",
                order_id=f"RET-O{i + 1}",
                quantity=2,
                detailed_disposition="SELLABLE",
                reason="NOT_AS_DESCRIBED",
                status="Unit returned to inventory",
                original_return_datetime=f"{D1.isoformat()}T00:00:00",
            )
        )
    db_session.commit()

    # 聚合表：只写退货日 d1 的 SKU-RET，且数量故意偏小（4 件真值写成 1）
    # —— R2 若仍读这张表，return_quantity 会是 1 而不是 4（P0-1 锁死点）。
    db_session.add(
        AnalysisReturnAggregate(
            project_id=pid,
            country="US",
            sku="SKU-RET",
            asin="ASIN-RET",
            data_date=D1,
            return_count=1,
            return_quantity=1,
            sales_quantity=10,
            return_rate=10.0,
            reason_top1="NOT_AS_DESCRIBED",
            disposition_top1="SELLABLE",
            dominant_fc_id="PHX6",
            risk_level="warning",
            wilson_lower=1.0,
            computed_at=datetime.now(timezone.utc),
        )
    )
    db_session.commit()

    try:
        yield pid
    finally:
        _cleanup_project(db_session, pid)


def _r1(db, pid: int, **kw):
    from app.services.analysis.return_analysis.analysis import build_return_analysis

    return build_return_analysis(
        db, project_id=pid, country="US", start_date=WIN_START, end_date=WIN_END, **kw
    )


def _r2(db, pid: int, **kw):
    from app.services.external.return_analysis_query import (
        query_return_analysis_aggregate,
    )

    return query_return_analysis_aggregate(
        db,
        project_id=pid,
        country="US",
        date_from=D1,
        date_to=D3,
        order_column=lambda r: r["return_quantity"],
        order_dir="desc",
        limit=500,
        offset=0,
        **kw,
    )


def _r3(db, pid: int):
    from app.models import AnalysisReturnRow as ARR
    from app.services.external.return_analysis_query import query_return_analysis_raw

    return query_return_analysis_raw(
        db,
        project_id=pid,
        country="US",
        date_from=D1,
        date_to=D3,
        order_column=ARR.return_date,
        order_dir="desc",
        limit=5000,
        offset=0,
    )


# ── P0-1：R2 分子与 R1/R3 一致（不再信任物化缓存）────────────────────────


def test_p0_1_r2_numerator_matches_r1_and_r3(consistency_project, db_session):
    pid = consistency_project
    r1 = _r1(db_session, pid)
    rows, _ = _r2(db_session, pid)
    raw, _, _ = _r3(db_session, pid)

    r2_qty = sum(r["return_quantity"] for r in rows)
    assert r2_qty == 4, f"R2 分子必须是 raw 的 4 件，实际 {r2_qty}"
    assert r1.summary.total_quantity == 4
    assert len(raw) == 2
    # 三路口径一致（断言 1）
    assert r1.summary.total_quantity == r2_qty


def test_p0_1_r2_does_not_read_stale_aggregate_cache(
    consistency_project, db_session
):
    """聚合表写的是 1 件、raw 是 4 件 → R2 必须报 4。"""
    pid = consistency_project
    rows, _ = _r2(db_session, pid)
    by_sku = {r["sku"]: r for r in rows}
    assert by_sku["SKU-RET"]["return_quantity"] == 4
    assert by_sku["SKU-RET"]["return_count"] == 2


# ── P0-2：R2 分母含零退货 SKU 的销量 ─────────────────────────────────────


def test_p0_2_r2_denominator_includes_zero_return_skus(
    consistency_project, db_session
):
    pid = consistency_project
    r1 = _r1(db_session, pid)
    rows, _ = _r2(db_session, pid)

    r2_sales = sum(r["sales_quantity"] for r in rows)
    # 70（SKU-RET）+ 30（SKU-SALEONLY 零退货）= 100
    assert r2_sales == 100, f"R2 分母必须含零退货 SKU，期望 100，实际 {r2_sales}"
    assert r1.summary.total_sales_quantity == 100
    assert r2_sales == r1.summary.total_sales_quantity, "R1/R2 分母必须一致"


def test_p0_2_sales_only_sku_present_as_zero_return_row(
    consistency_project, db_session
):
    pid = consistency_project
    rows, _ = _r2(db_session, pid)
    by_sku = {r["sku"]: r for r in rows}
    assert "SKU-SALEONLY" in by_sku, "零退货但有销量的 SKU 必须出现在结果里"
    so = by_sku["SKU-SALEONLY"]
    assert so["return_quantity"] == 0
    assert so["sales_quantity"] == 30
    assert so["return_rate"] == 0.0


def test_p0_2_r2_summary_rate_uses_full_denominator(consistency_project, db_session):
    """R2 summary 退货率 = 4/100 = 4%，而不是只算有退货 SKU 的 4/70 = 5.714%。"""
    from app.services.external.return_analysis_query import (
        build_aggregate_summary,
    )

    pid = consistency_project
    rows, _ = _r2(db_session, pid)
    summary = build_aggregate_summary(rows)
    assert summary["total_sales_quantity"] == 100
    assert summary["total_return_quantity"] == 4
    assert summary["overall_return_rate"] == 4.0


# ── P1-3：榜单截断必须显式告知 ──────────────────────────────────────────


def test_p1_3_ranking_truncation_is_explicit(db_session, monkeypatch):
    """SKU 数 > 上限时返回 ranking_truncated + ranking_total_count。"""
    from app.constants import return_thresholds

    monkeypatch.setattr(return_thresholds, "MAX_RANKING_ROWS", 2)
    # analysis.py 在模块导入时绑定了常量，这里同步替换模块内引用
    from app.services.analysis.return_analysis import analysis as analysis_mod

    monkeypatch.setattr(analysis_mod, "MAX_RANKING_ROWS", 2)

    pid = _insert_many_sku_project(db_session, sku_count=5)
    try:
        r1 = _r1(db_session, pid)
        assert len(r1.ranking_rows) == 2, "榜单按上限截断"
        assert r1.ranking_truncated is True
        assert r1.ranking_total_count == 5
        assert r1.summary.unique_skus == 5
    finally:
        _cleanup_project(db_session, pid)


def test_p1_3_ranking_not_truncated_when_under_limit(consistency_project, db_session):
    r1 = _r1(db_session, consistency_project)
    assert r1.ranking_truncated is False
    assert r1.ranking_total_count == len(r1.ranking_rows) == 1


# ── P1-4：R4 summary 与 ranking_rows 自洽 ───────────────────────────────


def test_p1_4_r4_summary_denominator_is_the_sku(consistency_project, db_session):
    pid = consistency_project
    r4 = _r1(db_session, pid, sku="SKU-RET")

    assert r4.summary.total_sales_quantity == 70, (
        "R4 summary 分母必须是该 SKU 的销量 70，而不是整店 100"
    )
    assert len(r4.ranking_rows) == 1
    top = r4.ranking_rows[0]
    assert r4.summary.total_sales_quantity == top.sales_quantity
    assert r4.summary.overall_return_rate == top.return_rate
    assert r4.summary.overall_return_rate == round(4 * 100.0 / 70, 2)


def test_p1_4_r4_summary_denominator_not_whole_store(consistency_project, db_session):
    """回归锁：整店是 100，该 SKU 是 70，二者必须不同（否则测试无意义）。"""
    pid = consistency_project
    all_skus = _r1(db_session, pid)
    one_sku = _r1(db_session, pid, sku="SKU-RET")
    assert all_skus.summary.total_sales_quantity == 100
    assert one_sku.summary.total_sales_quantity == 70


# ── P1-5：无数据 → null + data_available=false ─────────────────────────


def test_p1_5_no_data_window_is_flagged_not_silently_zero(consistency_project, db_session):
    """窗口完全早于退货数据跨度 → data_available=False + span 可见。

    summary 级 rate 刻意保持非空数值（与内部 Web 路由共用 schema 与缓存，
    前端对它直调 ``.toFixed``）；可区分性由 ``data_available`` 承担，
    而不是把字段置空。调用方必须先看 ``data_available`` 再采信该数字。
    """
    pid = consistency_project
    from app.services.analysis.return_analysis.analysis import build_return_analysis

    r = build_return_analysis(
        db_session,
        project_id=pid,
        country="US",
        start_date="2020-01-01",
        end_date="2020-12-31",
    )
    assert r.summary.total_quantity == 0
    assert r.summary.data_available is False, "无数据必须显式标记，而非报 0% 却不告知"
    assert r.summary.overall_return_rate == 0.0, "summary 级保持非空（跨端兼容）"
    assert r.summary.data_span is not None
    assert r.summary.data_span.min_return_date == D1.isoformat()
    assert r.summary.data_span.max_return_date == D1.isoformat()


def test_p1_5_row_level_rate_distinguishes_no_data(consistency_project, db_session):
    """行级 rate 仍可为空——前端对行级已有 ``sales_quantity > 0`` 守卫。"""
    from app.services.analysis.return_analysis.analysis import _safe_rate

    assert _safe_rate(5, 0) is None, "分母 0 的行级 rate 不得伪装成 0%"
    assert _safe_rate(0, 0) is None
    assert _safe_rate(1, 4) == 25.0


def test_p1_5_covered_window_still_reports_rate(consistency_project, db_session):
    r = _r1(db_session, consistency_project)
    assert r.summary.data_available is True
    assert r.summary.overall_return_rate == round(4 * 100.0 / 100, 2)


# ── P2-6：confidence 与 risk_level 解耦 ────────────────────────────────


def test_p2_6_confidence_flags_low_sample_with_nonzero_rate(
    consistency_project, db_session
):
    """SKU-RET：4 退 / 70 销，分母 ≥15 → confidence=high。"""
    pid = consistency_project
    rows, _ = _r2(db_session, pid)
    by_sku = {r["sku"]: r for r in rows}
    assert by_sku["SKU-RET"]["confidence"] == "high"


def test_p2_6_low_sales_sku_has_low_confidence_and_keeps_rate(
    consistency_project, db_session
):
    """销量 <15 的 SKU：risk_level=no_data 但 return_rate 仍有效 + confidence=low。"""
    pid = consistency_project
    rows, _ = _r2(db_session, pid)
    by_sku = {r["sku"]: r for r in rows}
    so = by_sku["SKU-SALEONLY"]
    assert so["sales_quantity"] == 30
    assert so["confidence"] == "high"
    assert so["risk_level"] == "normal"

    # 销量 <15 的真反例：在 raw 销售层插 13 件（< MIN_SALES_FOR_RISK_LEVEL）
    from app.models import AnalysisSalesOrderRow, AnalysisSourceFile

    sf = db_session.execute(
        select(AnalysisSourceFile).where(
            AnalysisSourceFile.project_id == pid,
            AnalysisSourceFile.report_type == "sales_report",
        )
    ).scalars().first()
    _d = datetime(D2.year, D2.month, D2.day, 12, 0, 0, tzinfo=timezone.utc)
    db_session.add(
        AnalysisSalesOrderRow(
            project_id=pid,
            country="US",
            source_file_id=sf.id,
            source_row_no=999001,
            amazon_order_id="LOW-1",
            purchase_at_utc=_d,
            purchase_at_pt=_d.replace(tzinfo=None),
            purchase_date_pt=D2,
            sku="SKU-LOW",
            quantity=13,
            is_counted_sales=True,
            order_status="Shipped",
        )
    )
    # SKU-LOW 必须也有退货才能进 R2 结果集（R2 由退货行驱动）
    ret_sf = db_session.execute(
        select(AnalysisSourceFile).where(
            AnalysisSourceFile.project_id == pid,
            AnalysisSourceFile.report_type == "return_report",
        )
    ).scalars().first()
    db_session.add(
        AnalysisReturnRow(
            project_id=pid,
            country="US",
            source_file_id=ret_sf.id,
            source_row_no=999001,
            return_date=D2,
            sku="SKU-LOW",
            order_id="LOW-1",
            quantity=3,
            detailed_disposition="SELLABLE",
            reason="OTHER",
            status="Unit returned to inventory",
            original_return_datetime=f"{D2.isoformat()}T00:00:00",
        )
    )
    db_session.commit()

    rows, _ = _r2(db_session, pid)
    low = {r["sku"]: r for r in rows}["SKU-LOW"]
    assert low["sales_quantity"] == 13
    assert low["risk_level"] == "no_data", "样本不足仍归 no_data（枚举语义不变）"
    assert low["confidence"] == "low", "样本量不足改由 confidence 表达"
    assert low["return_rate"] > 0, "有效退货率不得因 no_data 而被抹掉"


# ── 附带回归：不得污染 session identity map ──────────────────────────────


def test_build_return_analysis_does_not_mutate_session_rows(
    consistency_project, db_session
):
    """R1 之后同一 session 再查 R3 不得抛 AttributeError（BLF-1078 附带修复）。"""
    pid = consistency_project
    _r1(db_session, pid)
    raw, _, _ = _r3(db_session, pid)  # 修复前这里抛 'str' object has no attribute 'isoformat'
    assert len(raw) == 2
    assert all(isinstance(r["return_date"], str) for r in raw)


def test_r1_then_r1_again_is_stable(consistency_project, db_session):
    pid = consistency_project
    first = _r1(db_session, pid)
    second = _r1(db_session, pid)
    assert first.summary.total_quantity == second.summary.total_quantity
    assert first.summary.overall_return_rate == second.summary.overall_return_rate


# ── helpers ─────────────────────────────────────────────────────────────


def _insert_many_sku_project(db, *, sku_count: int) -> int:
    """建一个含 ``sku_count`` 个退货 SKU 的项目（用于榜单截断用例）。"""
    project = Project(
        project_name=f"BLF-1078 ranking {sku_count} {date.today().isoformat()}",
        sort_order=0,
        is_active=False,
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    pid = project.id

    sf_ret = AnalysisSourceFile(
        report_type="return_report",
        is_current=True,
        project_id=pid,
        country="US",
        upload_file_id=f"BLF1078-rank-{pid}",
        upload_file_path=f"return_report/{pid}/test.csv",
        original_filename="return_report.csv",
        stored_filename="return_report.csv",
        logical_filename="return_report.csv",
        storage_key=f"return_report/{pid}/test.csv",
        file_size_bytes=1024,
        file_sha256="deadbeef",
        period_start_date=D1,
        period_end_date=D3,
        snapshot_at=None,
        version=1,
        ingestion_status="success",
    )
    db.add(sf_ret)
    db.flush()

    for i in range(sku_count):
        db.add(
            AnalysisReturnRow(
                project_id=pid,
                country="US",
                source_file_id=sf_ret.id,
                source_row_no=i + 1,
                return_date=D1,
                sku=f"SKU-{i:02d}",
                order_id=f"ORD-{i:02d}",
                quantity=1,
                detailed_disposition="SELLABLE",
                reason="OTHER",
                status="Unit returned to inventory",
                original_return_datetime=f"{D1.isoformat()}T00:00:00",
            )
        )
    db.commit()
    return pid


def _cleanup_project(db, pid: int) -> None:
    """按 FK 顺序清理测试项目（ORM delete，不拼 SQL）。"""
    db.expire_all()
    for model in (
        AnalysisReturnAggregate,
        AnalysisReturnRow,
        AnalysisSalesOrderRow,
        AnalysisSourceFile,
    ):
        db.execute(delete(model).where(model.project_id == pid))
    db.execute(delete(Project).where(Project.id == pid))
    db.commit()
