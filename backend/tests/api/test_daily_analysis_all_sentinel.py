"""BLF-915 跟进：``/daily-analysis/all`` 支持 ``project_ids=all`` 哨兵。

背景：首页顶栏 KPI 与 Footer 快报、首页 / 组合总览的 ``daily-analysis/all``
调用方（历史曾由 ``use-header-kpis`` 发起，该 hook 已于 BLF-874 Stage 1 随
顶栏改版下线）以 ``project_ids=all`` 调 ``/daily-analysis/all``，而后端只接受
逗号整数， 48h 内全部 422 → hook 静默降级、KPI 一直显示 ``--``。

本文件覆盖端点新契约：
- ``project_ids=all`` → 解析为调用者可见项目集（admin=全部活跃项目，
  非 admin 按 operator 过滤，与 ``/projects/manage`` 同一套
  ``list_project_items`` / ``list_accessible_project_ids`` 语义）；
- 可见项目集为空 → 200 空聚合（不是 422/500）；
- 非 admin 对不可见项目仍 403（原有 ensure_project_access 语义不变）；
- 逗号整数形式（存量消费方）行为不变，含非法 token 仍 422。
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete

from app.core.config import get_settings
from app.db.session import SessionLocal
from app.main import app
from app.models import AnalysisSalesOrderRow, AnalysisSourceFile, Project


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _auth_headers(is_admin: bool, operator: str | None = None) -> dict[str, str]:
    headers = {
        "X-API-Key": get_settings().api_key,
        "X-Is-Admin": "true" if is_admin else "false",
    }
    if operator is not None:
        headers["X-Operator"] = operator
    return headers


@pytest.fixture
def env():
    """三个项目：P1/P2 属 operator ``blf915-op``，P3 属别的 operator。

    每个项目 US 站种一行订单（sales_amount = item_price + shipping_price，
    US 口径为净额、忽略税列）：
    - P1: 10.00 + 2.50 = 12.50
    - P2: 20.00 + 5.00 = 25.00
    - P3: 40.00 + 10.00 = 50.00
    """
    suffix = uuid.uuid4().hex[:8]
    day = datetime.now(UTC).date() - timedelta(days=10)
    db = SessionLocal()
    pids: dict[str, int] = {}
    try:
        for name, operator in (
            ("p1", "blf915-op"),
            ("p2", "blf915-op"),
            ("p3", "blf915-other"),
        ):
            project = Project(
                project_name=f"blf915-{name}-{suffix}",
                project_operator=operator,
                assistant_operator=None,
                sort_order=0,
                is_active=True,
            )
            db.add(project)
            db.commit()
            db.refresh(project)
            pids[name] = project.id

            sf = AnalysisSourceFile(
                project_id=project.id,
                country="US",
                report_type="sales_report",
                upload_file_id=f"blf915_{name}_{uuid.uuid4().hex[:6]}",
                upload_file_path="/tmp/blf915.csv",
                original_filename="blf915.csv",
                stored_filename="blf915.csv",
                logical_filename="blf915.csv",
                storage_key="blf915.csv",
                period_start_date=day - timedelta(days=1),
                period_end_date=day,
                is_current=True,
                ingestion_status="success",
                created_by="pytest",
            )
            db.add(sf)
            db.flush()

            price = Decimal(
                {"p1": "10.00", "p2": "20.00", "p3": "40.00"}[name]
            )
            shipping = Decimal(
                {"p1": "2.50", "p2": "5.00", "p3": "10.00"}[name]
            )
            db.add(
                AnalysisSalesOrderRow(
                    project_id=project.id,
                    country="US",
                    source_file_id=sf.id,
                    source_row_no=1,
                    amazon_order_id=f"BLF915-{name}-{uuid.uuid4().hex[:8]}",
                    purchase_at_utc=datetime.now(UTC),
                    purchase_at_pt=datetime.now(UTC),
                    purchase_date_pt=day,
                    order_status="Shipped",
                    sku=f"SKU-915-{name.upper()}",
                    asin="B00000000915",
                    quantity=1,
                    item_price=price,
                    shipping_price=shipping,
                    item_tax=Decimal("0.99"),
                    shipping_tax=Decimal("0.01"),
                    currency="USD",
                    is_counted_sales=True,
                    raw_row={"product_name": f"产品-{name}"},
                )
            )
        db.commit()
    finally:
        db.close()

    yield {"pids": pids, "day": day}

    db = SessionLocal()
    try:
        for pid in pids.values():
            db.execute(
                delete(AnalysisSalesOrderRow).where(
                    AnalysisSalesOrderRow.project_id == pid
                )
            )
            db.execute(
                delete(AnalysisSourceFile).where(
                    AnalysisSourceFile.project_id == pid
                )
            )
            obj = db.get(Project, pid)
            if obj is not None:
                db.delete(obj)
        db.commit()
    finally:
        db.close()


def _all_url(day) -> str:
    day_text = day.isoformat()
    return (
        "/api/v1/daily-analysis/all"
        f"?project_ids=all&country=US&start_date={day_text}&end_date={day_text}"
    )


def test_all_sentinel_admin_aggregates_visible_projects(client, env):
    """admin + project_ids=all → 全部活跃项目进聚合（P1+P2+P3 = 87.50）。

    项目集来自 list_project_items(is_admin=True)：本 env 之外库里还有
    其他既有项目，因此断言用「包含三个种子项目之和的下界」而非精确等值。
    """
    resp = client.get(_all_url(env["day"]), headers=_auth_headers(is_admin=True))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["project_breakdown"], "admin 视角应至少包含种子项目"
    seed_ids = set(env["pids"].values())
    assert seed_ids.issubset({int(k) for k in body["project_breakdown"]})
    seed_total = sum(
        block["summary_rows"][0]["sales_amount"]
        for pid, block in body["project_breakdown"].items()
        if int(pid) in seed_ids
    )
    assert seed_total == pytest.approx(87.50)


def test_all_sentinel_non_admin_scopes_to_operator(client, env):
    """非 admin + project_ids=all → 只聚合 operator 可见项目（P1+P2 = 37.50）。

    P3 属其他 operator，不得出现在聚合里（等值断言：可见集是完全确定的）。
    """
    resp = client.get(
        _all_url(env["day"]),
        headers=_auth_headers(is_admin=False, operator="blf915-op"),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    breakdown_ids = {int(k) for k in body["project_breakdown"]}
    p1, p2, p3 = env["pids"]["p1"], env["pids"]["p2"], env["pids"]["p3"]
    assert breakdown_ids == {p1, p2}
    assert p3 not in breakdown_ids
    total = sum(
        block["summary_rows"][0]["sales_amount"]
        for block in body["project_breakdown"].values()
    )
    assert total == pytest.approx(37.50)


def test_all_sentinel_empty_visible_set_returns_empty_aggregate(client, env):
    """operator 名下没有项目 → 200 空聚合（不 422/500，hook 拿到合法响应）。"""
    resp = client.get(
        _all_url(env["day"]),
        headers=_auth_headers(
            is_admin=False, operator=f"blf915-nobody-{uuid.uuid4().hex[:6]}"
        ),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["project_breakdown"] == {}


def test_explicit_ids_still_enforce_access(client, env):
    """逗号整数（存量形式）语义不变：显式请求不可见项目 → 403。"""
    day_text = env["day"].isoformat()
    url = (
        "/api/v1/daily-analysis/all"
        f"?project_ids={env['pids']['p3']}&country=US"
        f"&start_date={day_text}&end_date={day_text}"
    )
    resp = client.get(
        url,
        headers=_auth_headers(is_admin=False, operator="blf915-op"),
    )
    assert resp.status_code == 403, resp.text


def test_invalid_token_still_422(client, env):
    """非 all、非整数的 token → 422（既有校验保留）。"""
    day_text = env["day"].isoformat()
    url = (
        "/api/v1/daily-analysis/all"
        "?project_ids=banana&country=US"
        f"&start_date={day_text}&end_date={day_text}"
    )
    resp = client.get(url, headers=_auth_headers(is_admin=True))
    assert resp.status_code == 422, resp.text


def test_all_sentinel_admin_includes_only_active_projects(client, env):
    """all 解析沿 list_project_items 默认口径：只含活跃项目（inactive 排除）。"""
    db = SessionLocal()
    try:
        p3 = db.get(Project, env["pids"]["p3"])
        assert p3 is not None
        p3.is_active = False
        db.commit()
    finally:
        db.close()

    try:
        resp = client.get(
            _all_url(env["day"]), headers=_auth_headers(is_admin=True)
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert env["pids"]["p3"] not in {
            int(k) for k in body["project_breakdown"]
        }
    finally:
        db = SessionLocal()
        try:
            restore = db.get(Project, env["pids"]["p3"])
            assert restore is not None
            restore.is_active = True
            db.commit()
        finally:
            db.close()
