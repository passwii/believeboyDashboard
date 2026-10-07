"""BLF-839 今日出单流端点集成测试。

覆盖 ``GET /api/v1/order-info/live-stream``：

* 鉴权：非 admin 缺 X-Operator → 401（与 order-info 其他端点同规则）；
* 口径：只取 is_counted_sales、排除 Cancelled、窗口=站点本地今天；
  销售行按 BEL-348 行级 upsert 可见，不依赖 is_current 指针；
* 去重：同一订单多 SKU 行合并为一条事件（金额/数量求和）；
* 排序：按组内最晚 purchase_at_utc 倒序；limit 生效；
* 权限：非 admin 无权限项目返回空列表，admin 放行；
* 字段契约：id/title/time_label 对齐前端 LiveStreamItem 插槽（PR #425）。

走真实测试库（无 TEST_DATABASE_URL 自动 skip，见根 conftest）。
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, time, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.core.config import get_settings
from app.utils.country import get_today_for_country


@pytest.fixture
def client() -> TestClient:
    from app.main import app

    return TestClient(app)


_TEST_PROJECT_RE = r"^.*-TEST-.+$"


def _admin_headers() -> dict[str, str]:
    return {
        "X-API-Key": get_settings().api_key,
        "X-Is-Admin": "true",
        "X-Operator": "pytest-admin",
    }


def _operator_headers(operator: str | None = None) -> dict[str, str]:
    headers = {
        "X-API-Key": get_settings().api_key,
        "X-Is-Admin": "false",
    }
    if operator is not None:
        headers["X-Operator"] = operator
    return headers


def _cleanup_test_projects() -> None:
    from app.db.session import SessionLocal

    s = SessionLocal()
    try:
        dirty = (
            s.execute(
                text("SELECT id FROM projects WHERE project_name ~* :re"),
                {"re": _TEST_PROJECT_RE},
            )
            .scalars()
            .all()
        )
        if not dirty:
            return
        s.execute(
            text("DELETE FROM analysis_sales_order_rows WHERE project_id = ANY(:ids)"),
            {"ids": list(dirty)},
        )
        s.execute(
            text("DELETE FROM analysis_source_files WHERE project_id = ANY(:ids)"),
            {"ids": list(dirty)},
        )
        s.execute(
            text("DELETE FROM projects WHERE id = ANY(:ids)"),
            {"ids": list(dirty)},
        )
        s.commit()
    finally:
        s.close()


@pytest.fixture(autouse=True)
def _auto_cleanup():
    """清理本文件产生的 *-TEST-* 项目数据（前后都清，防残留互相污染）。"""
    _cleanup_test_projects()
    yield
    _cleanup_test_projects()


# ===== 种子 helpers（对齐 test_report_builder_sales_rowlevel 的写法） =====


def _make_source(db, *, project_id: int, version: int, is_current: bool):
    from app.models import AnalysisSourceFile

    today = get_today_for_country("US")
    sf = AnalysisSourceFile(
        project_id=project_id,
        report_type="sales_report",
        country="UK",
        report_date=today,
        period_start_date=today,
        period_end_date=today,
        snapshot_at=None,
        version=version,
        is_current=is_current,
        superseded_at=None,
        upload_file_id=f"upload-sales-{uuid.uuid4().hex[:8]}",
        upload_file_path="/tmp/sales.tsv",
        original_filename="sales.tsv",
        stored_filename="sales.tsv",
        logical_filename="sales.tsv",
        storage_key=f"web_upload/sales/{project_id}/{today}",
        ingestion_status="success",
        row_count_total=0,
        row_count_included=0,
    )
    db.add(sf)
    db.flush()
    return sf


def _row_dict(
    *,
    project_id: int,
    source_file_id: int,
    order_id: str,
    sku: str = "SKU-A",
    qty: int = 1,
    item_price: str = "18.99",
    purchased_at: time = time(12, 0),
    counted: bool = True,
    status: str = "Shipped",
    purchase_date: date | None = None,
):
    from app.models.product_analysis_source import AnalysisSalesOrderRow

    pt_day = purchase_date or get_today_for_country("US")
    pt_hour = (purchased_at.hour - 7) % 24  # UTC→PT 粗略偏移（种子数据够用）
    return AnalysisSalesOrderRow(
        project_id=project_id,
        source_file_id=source_file_id,
        source_row_no=1,
        amazon_order_id=order_id,
        purchase_at_utc=datetime.combine(pt_day, purchased_at, tzinfo=timezone.utc),
        purchase_at_pt=datetime.combine(pt_day, time(pt_hour)),
        purchase_date_pt=pt_day,
        order_status=status,
        country="UK",
        sku=sku,
        asin="ASIN1",
        quantity=qty,
        item_price=item_price,
        shipping_price="0.00",
        item_tax="0.00",
        shipping_tax="0.00",
        currency="GBP",
        is_counted_sales=counted,
        status_rule_version=1,
        raw_row={},
    )


def _make_project(db) -> int:
    from app.models.project import Project

    p = Project(
        project_name=f"PH-TEST-{uuid.uuid4().hex[:10]}", sort_order=0, is_active=False
    )
    db.add(p)
    db.commit()
    db.refresh(p)
    return int(p.id)


def _add_rows(db, rows) -> None:
    db.add_all(rows)
    db.commit()


def _seed_standard_fixture(db) -> int:
    """订单 A（两行多 SKU，金额求和）+ 订单 B（更晚）；另插旧日期 /
    未计入 / Cancelled 三类应被排除的行。返回 project_id。"""
    pid = _make_project(db)
    sf = _make_source(db, project_id=pid, version=1, is_current=True)

    yesterday = date.fromordinal(get_today_for_country("US").toordinal() - 1)
    _add_rows(
        db,
        [
            _row_dict(
                project_id=pid,
                source_file_id=sf.id,
                order_id="026-AAAAAA-AAAAAA",
                sku="SKU-A",
                qty=2,
                purchased_at=time(10, 0),
            ),
            _row_dict(
                project_id=pid,
                source_file_id=sf.id,
                order_id="026-AAAAAA-AAAAAA",
                sku="SKU-B",
                qty=1,
                purchased_at=time(11, 0),
            ),
            _row_dict(
                project_id=pid,
                source_file_id=sf.id,
                order_id="026-BBBBBB-BBBBBB",
                qty=1,
                purchased_at=time(12, 0),
            ),
            _row_dict(
                project_id=pid,
                source_file_id=sf.id,
                order_id="026-OLDDAY-000000",
                purchase_date=yesterday,
            ),
            _row_dict(
                project_id=pid,
                source_file_id=sf.id,
                order_id="026-NOTCNT-000000",
                counted=False,
            ),
            _row_dict(
                project_id=pid,
                source_file_id=sf.id,
                order_id="026-CANCEL-000000",
                status="Cancelled",
            ),
        ],
    )
    return pid


# ===== 测试 =====


def test_live_stream_requires_operator_header(client):
    res = client.get("/api/v1/order-info/live-stream", headers=_operator_headers())
    assert res.status_code == 401


def test_live_stream_empty_for_project_without_rows(client, db_session):
    pid = _make_project(db_session)

    res = client.get(
        "/api/v1/order-info/live-stream",
        params={"project_ids": pid},
        headers=_admin_headers(),
    )
    assert res.status_code == 200
    assert res.json() == []


def test_live_stream_dedup_sorts_and_filters(client, db_session):
    pid = _seed_standard_fixture(db_session)

    res = client.get(
        "/api/v1/order-info/live-stream",
        params={"project_ids": pid},
        headers=_admin_headers(),
    )
    assert res.status_code == 200
    items = res.json()

    # 只剩 A（去重后一条）+ B；旧日期 / 未计入 / Cancelled 被排除；B 更晚在前
    assert [it["id"] for it in items] == [
        f"{pid}:026-BBBBBB-BBBBBB",
        f"{pid}:026-AAAAAA-AAAAAA",
    ]

    b, a = items
    # 最小集字段对齐前端 LiveStreamItem 插槽
    assert {"id", "title", "time_label"} <= set(b.keys())
    assert b["title"] == "订单 #026-BBBBBB-BBBBBB · GBP 18.99"
    assert b["time_label"] == "20:00"  # 12:00 UTC → 北京 20:00
    assert b["occurred_at"].endswith("+00:00")

    # 多 SKU 行合并：金额求和（UK 含税口径 = net+tax，此处 tax=0）、数量求和
    assert a["amount"] == pytest.approx(37.98)  # 两行各 18.99
    assert a["quantity"] == 3  # 2 + 1
    assert "026-AAAAAA-AAAAAA" in a["title"]


def test_live_stream_includes_rows_from_superseded_source_versions(client, db_session):
    """BEL-348: is_current 不再维护销售行可见性，false source 里的订单也必须可见。"""
    pid = _make_project(db_session)
    v1 = _make_source(db_session, project_id=pid, version=1, is_current=False)
    v2 = _make_source(db_session, project_id=pid, version=2, is_current=True)
    _add_rows(
        db_session,
        [
            _row_dict(
                project_id=pid, source_file_id=v1.id, order_id="026-OLDVER-000000"
            ),
            _row_dict(
                project_id=pid, source_file_id=v2.id, order_id="026-CURRNT-000000"
            ),
        ],
    )

    res = client.get(
        "/api/v1/order-info/live-stream",
        params={"project_ids": pid},
        headers=_admin_headers(),
    )
    assert res.status_code == 200
    ids = [it["id"] for it in res.json()]
    assert set(ids) == {
        f"{pid}:026-OLDVER-000000",
        f"{pid}:026-CURRNT-000000",
    }


def test_live_stream_limit_returns_newest(client, db_session):
    pid = _make_project(db_session)
    sf = _make_source(db_session, project_id=pid, version=1, is_current=True)
    _add_rows(
        db_session,
        [
            _row_dict(
                project_id=pid,
                source_file_id=sf.id,
                order_id=f"026-LIMT{i:02d}-000000",
                purchased_at=time(9 + i, 0),
            )
            for i in range(3)
        ],
    )

    res = client.get(
        "/api/v1/order-info/live-stream",
        params={"project_ids": pid, "limit": 2},
        headers=_admin_headers(),
    )
    assert res.status_code == 200
    items = res.json()
    assert len(items) == 2
    # 最新两条：11 点、10 点
    assert items[0]["id"].endswith("026-LIMT02-000000")
    assert items[1]["id"].endswith("026-LIMT01-000000")


def test_live_stream_scopes_non_admin_to_accessible_projects(client, db_session):
    """非 admin + 无权限项目 → 空列表；admin 同参数能看到数据。"""
    pid = _seed_standard_fixture(db_session)

    res_op = client.get(
        "/api/v1/order-info/live-stream",
        params={"project_ids": pid},
        headers=_operator_headers(operator="pytest-nobody"),
    )
    assert res_op.status_code == 200
    assert res_op.json() == []

    res_admin = client.get(
        "/api/v1/order-info/live-stream",
        params={"project_ids": pid},
        headers=_admin_headers(),
    )
    assert res_admin.status_code == 200
    assert len(res_admin.json()) >= 1
