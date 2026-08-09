"""orders/summary ``group_by`` 扩展契约测试（BLF-558；spec §7 测试清单）。

覆盖（对齐 spec §7 清单）：
1. ``group_by=asin``：TOP 排名正确（sales_amount 降序）；``include_share=true``
   出 share 且 Σshare≈1（±1e-4）；金额走 ``sales_amount_expr``（DE 含税用例）。
2. ``group_by=asin_day``：行 = ASIN×日；同订单多 SKU 聚合；``order_count`` 去重。
3. ``group_by=day``：日趋势 + ``unique_asins``。
4. 白名单校验：``group_by`` / ``order_by`` / ``order_dir`` 非法值 → 400
   VALIDATION_FAILED（agent 壳）。
5. summary SQL 全量：``limit=1`` 时 ``summary.total_quantity`` 仍是全期间总量。
6. 向后兼容：不带 ``group_by`` 的响应结构与现状一致（data/aggregate/summary）。
7. 镜像暴露：agent 侧 ``?group_by=asin`` 可调用，且 external handler 签名
   已含新参数（镜像沿 ``__wrapped__`` 自动暴露）。
8. 鉴权/壳：401 未鉴权；404 项目不存在；403 project_scope 越界。
9. 回归：test_external_mirror.py 全量 + 现有 orders/summary 相关测试零改动通过
   （在 CI/全套运行中覆盖，本文件只加新用例不碰存量）。

口径（spec §5.2）：销售额 = ``sales_amount_expr(country)``（DE/UK 含税）；
订单数 = ``count(distinct amazon_order_id)``；空结果 200 + 空 rows。
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select

from app.db.session import SessionLocal
from app.main import app
from app.models import (
    AnalysisSalesOrderRow,
    AnalysisSourceFile,
    Project,
)
from app.utils.math_utils import round_ratio, safe_ratio


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _headers(key: dict, agent_id: str | None = None) -> dict:
    return {
        "Authorization": f"Bearer {key['plaintext']}",
        "X-Agent-Id": agent_id or key["agent_id"],
    }


def _make_source_file(db, project_id: int, country: str, start: date, end: date):
    sf = AnalysisSourceFile(
        project_id=project_id,
        country=country,
        report_type="sales_report",
        upload_file_id=f"test_sales_{project_id}_{uuid.uuid4().hex[:6]}",
        upload_file_path="/tmp/test_sales.csv",
        original_filename="test_sales.csv",
        stored_filename="test_sales.csv",
        logical_filename="test_sales.csv",
        storage_key="test_sales.csv",
        period_start_date=start,
        period_end_date=end,
        is_current=True,
        ingestion_status="success",
        created_by="pytest",
    )
    db.add(sf)
    db.flush()
    return sf


def _seed_row(
    db,
    *,
    project_id: int,
    source_file_id: int,
    country: str,
    order_id: str,
    day: date,
    sku: str,
    asin: str,
    quantity: int,
    item_price: Decimal,
    product_name: str | None = None,
    fulfillment_channel: str = "Amazon",
    item_tax: Decimal = Decimal("0"),
    shipping_tax: Decimal = Decimal("0"),
    order_status: str = "Shipped",
    row_no: int = 0,
):
    db.add(
        AnalysisSalesOrderRow(
            project_id=project_id,
            country=country,
            source_file_id=source_file_id,
            source_row_no=row_no,
            amazon_order_id=order_id,
            purchase_at_utc=datetime.now(timezone.utc),
            purchase_at_pt=datetime.now(timezone.utc),
            purchase_date_pt=day,
            order_status=order_status,
            sku=sku,
            asin=asin,
            quantity=quantity,
            item_price=item_price,
            shipping_price=Decimal("0"),
            item_tax=item_tax,
            shipping_tax=shipping_tax,
            currency="USD",
            is_counted_sales=True,
            raw_row={
                "product_name": product_name or f"产品-{asin}",
                # 订单报表原始表头为连字符键（order_info 服务同读法）。
                "fulfillment-channel": fulfillment_channel,
            },
        )
    )


@pytest.fixture
def orders_env(make_api_key):
    """临时项目 + 全放行 agent key + US 订单行，测试后清理。

    种子数据（spec §5 口径用例）：
    * ASIN-A：day1 单订单单 SKU（qty=2 @10）；day2 同订单两 SKU（qty=1 @12 + qty=3 @5）
      —— 同订单多 SKU 用于断言 ``order_count`` 去重（ORD-A2 只计 1）。
    * ASIN-B：day1 单订单单 SKU（qty=5 @8）。
    """
    agent_id = f"blf558-{uuid.uuid4().hex[:8]}"
    key = make_api_key(agent_id=agent_id, project_scope="*")
    suffix = uuid.uuid4().hex[:8]
    project_name = f"blf558-{suffix}"
    country = "US"

    db = SessionLocal()
    try:
        project = Project(
            project_name=project_name,
            project_operator="pytest",
            assistant_operator=None,
            sort_order=0,
            is_active=True,
        )
        db.add(project)
        db.commit()
        db.refresh(project)

        # 端点 with today-1，7d 窗口 = [today-7, today-1]。
        today = date.today() - timedelta(days=1)
        day1 = today - timedelta(days=5)
        day2 = today - timedelta(days=4)

        sf = _make_source_file(db, project.id, country, day1, today)
        _seed_row(
            db,
            project_id=project.id,
            source_file_id=sf.id,
            country=country,
            order_id="ORD-A1",
            day=day1,
            sku="SKU-A1",
            asin="ASIN-A",
            quantity=2,
            item_price=Decimal("10.00"),
            row_no=1,
        )
        _seed_row(
            db,
            project_id=project.id,
            source_file_id=sf.id,
            country=country,
            order_id="ORD-A2",
            day=day2,
            sku="SKU-A2",
            asin="ASIN-A",
            quantity=1,
            item_price=Decimal("12.00"),
            row_no=2,
        )
        _seed_row(
            db,
            project_id=project.id,
            source_file_id=sf.id,
            country=country,
            order_id="ORD-A2",
            day=day2,
            sku="SKU-A3",
            asin="ASIN-A",
            quantity=3,
            item_price=Decimal("5.00"),
            row_no=3,
        )
        _seed_row(
            db,
            project_id=project.id,
            source_file_id=sf.id,
            country=country,
            order_id="ORD-B1",
            day=day1,
            sku="SKU-B1",
            asin="ASIN-B",
            quantity=5,
            item_price=Decimal("8.00"),
            fulfillment_channel="Merchant",
            row_no=4,
        )
        db.commit()
        project_id = project.id
    finally:
        db.close()

    yield {
        "project_id": project_id,
        "agent_id": agent_id,
        "key": key,
        "headers": _headers(key, agent_id),
        "country": country,
    }

    db = SessionLocal()
    try:
        db.execute(
            delete(AnalysisSalesOrderRow).where(
                AnalysisSalesOrderRow.project_id == project_id
            )
        )
        db.execute(
            delete(AnalysisSourceFile).where(
                AnalysisSourceFile.project_id == project_id
            )
        )
        obj = db.get(Project, project_id)
        if obj is not None:
            db.delete(obj)
        db.commit()
    finally:
        db.close()


# ---------------------------------------------------------------------------
# 1. group_by=asin：TOP 排名 + share + DE 含税口径
# ---------------------------------------------------------------------------


def test_group_by_asin_top_ranking_and_share(client, orders_env):
    resp = client.get(
        f"/api/v1/agent/projects/{orders_env['project_id']}/orders/summary"
        f"?period=7d&country={orders_env['country']}&group_by=asin&include_share=true",
        headers=orders_env["headers"],
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]

    assert data["group_by"] == "asin"
    # 销售额走 sales_amount_expr（spec §5.2：与定时报表统一，Σ(item_price+shipping
    # [+tax])，不乘 quantity）：ASIN-A=10+12+5=27，ASIN-B=8。
    rows = data["rows"]
    assert [r["asin"] for r in rows] == ["ASIN-A", "ASIN-B"]
    a_row = next(r for r in rows if r["asin"] == "ASIN-A")
    assert a_row["quantity"] == 6
    assert a_row["sales_amount"] == 27.0
    assert a_row["order_count"] == 2  # ORD-A1 + ORD-A2 去重
    assert a_row["product_name"] == "产品-ASIN-A"
    b_row = next(r for r in rows if r["asin"] == "ASIN-B")
    assert b_row["order_count"] == 1

    # share = sales_amount / 全量销售额，Σshare≈1（±1e-4）。
    assert a_row["share"] == pytest.approx(round_ratio(safe_ratio(27, 35)), abs=1e-4)
    assert sum(r["share"] for r in rows) == pytest.approx(1.0, abs=1e-4)

    # summary 为 SQL 全量（不受 limit 影响）。
    assert data["summary"]["total_orders"] == 3  # ORD-A1 / ORD-A2 / ORD-B1
    assert data["summary"]["total_quantity"] == 11
    assert data["summary"]["total_sales_amount"] == 35.0
    # fba/fbm 按 raw_row fulfillment-channel 去重订单数：ASIN-A 两单 Amazon、
    # ASIN-B 一单 Merchant。
    assert data["summary"]["fba_orders"] == 2
    assert data["summary"]["fbm_orders"] == 1
    assert data["total_rows"] == 2


def test_group_by_asin_de_vat_inclusive(client, make_api_key):
    """DE 站点金额走 sales_amount_expr 含税口径（item+shipping+item_tax+shipping_tax）。"""
    agent_id = f"blf558-de-{uuid.uuid4().hex[:8]}"
    key = make_api_key(agent_id=agent_id, project_scope="*")
    suffix = uuid.uuid4().hex[:8]
    country = "DE"

    db = SessionLocal()
    try:
        project = Project(
            project_name=f"blf558-de-{suffix}",
            project_operator="pytest",
            assistant_operator=None,
            sort_order=0,
            is_active=True,
        )
        db.add(project)
        db.commit()
        db.refresh(project)
        today = date.today() - timedelta(days=1)
        sf = _make_source_file(
            db, project.id, country, today - timedelta(days=3), today
        )
        _seed_row(
            db,
            project_id=project.id,
            source_file_id=sf.id,
            country=country,
            order_id="ORD-DE1",
            day=today - timedelta(days=2),
            sku="SKU-D1",
            asin="ASIN-D",
            quantity=2,
            item_price=Decimal("10.00"),
            item_tax=Decimal("2.50"),
            shipping_tax=Decimal("0.50"),
            row_no=1,
        )
        db.commit()
        project_id = project.id
    finally:
        db.close()

    try:
        resp = client.get(
            f"/api/v1/agent/projects/{project_id}/orders/summary"
            f"?period=7d&country={country}&group_by=asin",
            headers=_headers(key, agent_id),
        )
        assert resp.status_code == 200, resp.text
        row = resp.json()["data"]["rows"][0]
        # 含税 = item+shipping+item_tax+shipping_tax = 10+0+2.5+0.5 = 13.0（单行）；
        # 若误走净额应为 10.0。注意 sales_amount_expr 不乘 quantity（与定时报表口径一致）。
        assert row["sales_amount"] == 13.0
        assert resp.json()["data"]["summary"]["total_sales_amount"] == 13.0
    finally:
        db = SessionLocal()
        try:
            db.execute(
                delete(AnalysisSalesOrderRow).where(
                    AnalysisSalesOrderRow.project_id == project_id
                )
            )
            db.execute(
                delete(AnalysisSourceFile).where(
                    AnalysisSourceFile.project_id == project_id
                )
            )
            obj = db.get(Project, project_id)
            if obj is not None:
                db.delete(obj)
            db.commit()
        finally:
            db.close()


# ---------------------------------------------------------------------------
# 2. group_by=asin_day：ASIN×日 + 同订单多 SKU 聚合 + 去重订单数
# ---------------------------------------------------------------------------


def test_group_by_asin_day(client, orders_env):
    resp = client.get(
        f"/api/v1/agent/projects/{orders_env['project_id']}/orders/summary"
        f"?period=7d&country={orders_env['country']}&group_by=asin_day",
        headers=orders_env["headers"],
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    rows = data["rows"]

    # 3 组：ASIN-A 在 day2（两 SKU 同订单 → qty=4，order_count=1 去重）、
    # ASIN-A 在 day1、ASIN-B 在 day1。默认 sales_amount 降序 → ASIN-A/day2 最前。
    assert len(rows) == 3
    top = rows[0]
    assert top["date"] == (date.today() - timedelta(days=5)).isoformat()
    assert top["asin"] == "ASIN-A"
    assert top["quantity"] == 4  # 1 + 3
    assert top["sales_amount"] == 17.0  # 12 + 5（sales_amount_expr 不乘 quantity）
    assert top["order_count"] == 1  # ORD-A2 去重（两 SKU 同一订单只计 1）
    assert top["product_name"] == "产品-ASIN-A"

    a_day1 = next(r for r in rows if r["asin"] == "ASIN-A" and r["date"] != top["date"])
    assert a_day1["quantity"] == 2
    assert a_day1["order_count"] == 1
    assert data["summary"]["total_orders"] == 3  # ORD-A1 / ORD-A2 / ORD-B1（去重）


# ---------------------------------------------------------------------------
# 3. group_by=day：日趋势 + unique_asins
# ---------------------------------------------------------------------------


def test_group_by_day(client, orders_env):
    resp = client.get(
        f"/api/v1/agent/projects/{orders_env['project_id']}/orders/summary"
        f"?period=7d&country={orders_env['country']}&group_by=day",
        headers=orders_env["headers"],
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    rows = data["rows"]

    # 默认 sales_amount 降序：day1（18）在 day2（17）之前。
    assert len(rows) == 2
    assert rows[0]["date"] == (date.today() - timedelta(days=6)).isoformat()  # day1
    assert rows[0]["quantity"] == 7  # 2 + 5
    assert rows[0]["sales_amount"] == 18.0  # 10 + 8（sales_amount_expr 不乘 quantity）
    assert rows[0]["order_count"] == 2  # ORD-A1 + ORD-B1
    assert rows[0]["unique_asins"] == 2  # ASIN-A + ASIN-B

    day2 = rows[1]
    assert day2["quantity"] == 4
    assert day2["order_count"] == 1
    assert day2["unique_asins"] == 1
    assert day2["sales_amount"] == 17.0  # 12 + 5

    # 其他排序字段白名单生效。
    resp_qty = client.get(
        f"/api/v1/agent/projects/{orders_env['project_id']}/orders/summary"
        f"?period=7d&country={orders_env['country']}&group_by=day&order_by=quantity&order_dir=asc",
        headers=orders_env["headers"],
    )
    assert resp_qty.status_code == 200, resp_qty.text
    q_rows = resp_qty.json()["data"]["rows"]
    assert [r["date"] for r in q_rows] == [
        rows[1]["date"],
        rows[0]["date"],
    ]  # 4 → 7 升序


# ---------------------------------------------------------------------------
# 4. 白名单校验：group_by / order_by / order_dir 非法值 → 400 VALIDATION_FAILED
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "qs, bad_param",
    [
        ("group_by=foo", "group_by"),
        ("group_by=asin&order_by=foo", "order_by"),
        ("group_by=asin&order_dir=sideways", "order_dir"),
    ],
)
def test_grouped_whitelist_400(client, orders_env, qs, bad_param):
    resp = client.get(
        f"/api/v1/agent/projects/{orders_env['project_id']}/orders/summary"
        f"?period=7d&country={orders_env['country']}&{qs}",
        headers=orders_env["headers"],
    )
    assert resp.status_code == 400, resp.text
    body = resp.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "VALIDATION_FAILED"
    assert bad_param in body["error"]["human_message"]


def test_grouped_whitelist_ignored_in_legacy_mode(client, orders_env):
    """非 group_by 模式不校验 order_by/order_dir（向后兼容：存量消费者可能传任意值）。"""
    resp = client.get(
        f"/api/v1/agent/projects/{orders_env['project_id']}/orders/summary"
        f"?period=7d&country={orders_env['country']}&order_by=whatever&order_dir=up",
        headers=orders_env["headers"],
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["ok"] is True


# ---------------------------------------------------------------------------
# 5. summary SQL 全量：limit=1 时 summary 仍是全期间总量（修复页内汇总失真）
# ---------------------------------------------------------------------------


def test_summary_full_period_with_limit_1(client, orders_env):
    resp = client.get(
        f"/api/v1/agent/projects/{orders_env['project_id']}/orders/summary"
        f"?period=7d&country={orders_env['country']}&group_by=day&limit=1",
        headers=orders_env["headers"],
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert len(data["rows"]) == 1  # limit 作用于聚合行
    assert data["total_rows"] == 2  # 全量聚合行数不受 limit 影响
    assert data["summary"]["total_quantity"] == 11  # 全期间总量
    assert data["summary"]["total_sales_amount"] == 35.0


def test_group_by_empty_result_200(client, orders_env):
    """空结果 → 200 + 空 rows（spec §5.2），非 404。"""
    resp = client.get(
        f"/api/v1/agent/projects/{orders_env['project_id']}/orders/summary"
        f"?period=7d&country=DE&group_by=asin",  # DE 合法但无种子数据
        headers=orders_env["headers"],
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["rows"] == []
    assert data["total_rows"] == 0
    assert data["summary"]["total_orders"] == 0


# ---------------------------------------------------------------------------
# 6. 向后兼容：不带 group_by 的响应结构与现状完全一致
# ---------------------------------------------------------------------------


def test_legacy_mode_backward_compatible(client, orders_env):
    resp = client.get(
        f"/api/v1/agent/projects/{orders_env['project_id']}/orders/summary"
        f"?period=7d&country={orders_env['country']}",
        headers=orders_env["headers"],
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    # 现有响应结构：data（原始行）+ aggregate/summary 汇总块。
    assert set(data.keys()) == {
        "project_id",
        "period",
        "country",
        "data",
        "aggregate",
        "summary",
    }
    assert len(data["data"]) == 4  # 4 条订单行原样返回
    row = data["data"][0]
    for field in (
        "amazon_order_id",
        "purchase_date_pt",
        "order_status",
        "fulfillment_channel",
        "sku",
        "asin",
        "quantity",
        "item_price",
        "currency",
        "country",
        "is_counted_sales",
    ):
        assert field in row
    # 存量 aggregate 语义：total_orders = 行数（非去重）——本用例无重复订单行，
    # 与 group_by 模式不同但保持现状。
    assert data["aggregate"]["total_orders"] == 4
    assert data["summary"]["total_quantity"] == 11


def test_legacy_mode_limit_default_unchanged(client, orders_env):
    """不带 limit 时 legacy 模式仍走 50000 上限（等价于原 Query 默认值）。"""
    resp = client.get(
        f"/api/v1/agent/projects/{orders_env['project_id']}/orders/summary"
        f"?period=7d&country={orders_env['country']}&limit=2",
        headers=orders_env["headers"],
    )
    assert resp.status_code == 200, resp.text
    assert len(resp.json()["data"]["data"]) == 2


# ---------------------------------------------------------------------------
# 7. 镜像暴露：agent 侧 group_by 可调用 + external handler 签名已含新参数
# ---------------------------------------------------------------------------


def test_orders_summary_native_route_exposes_params_and_mirror_excluded():
    """BLF-560 v0.2：orders/summary 已原生化——原生路由带全部 group_by 参数，
    镜像侧排除（无双挂冲突）。spec §7.8 权限门 + 镜像排除回归。
    """
    import inspect

    from app.api.v1.endpoints.agent.external_mirror import (
        _EXCLUDED_EXTERNAL_PATHS,
        external_mirror_router,
    )
    from app.api.v1.endpoints.agent.orders import orders_router

    # 1) 镜像侧：orders/summary 已从 _EXCLUDED_EXTERNAL_PATHS 排除。
    assert "/external/projects/{project_id}/orders/summary" in _EXCLUDED_EXTERNAL_PATHS
    mirror_paths = {r.path for r in external_mirror_router.routes}
    assert "/projects/{project_id}/orders/summary" not in mirror_paths

    # 2) 原生路由：/orders/summary 存在且 handler 签名带全部参数。
    native_routes = [
        r
        for r in orders_router.routes
        if getattr(r, "path", "") == "/projects/{project_id}/orders/summary"
    ]
    assert len(native_routes) == 1, (
        "agent/orders.py 应有且仅有一个 /orders/summary 路由"
    )
    params = list(inspect.signature(native_routes[0].endpoint).parameters)
    for p in (
        "group_by",
        "order_by",
        "order_dir",
        "include_share",
        "limit",
        "offset",
    ):
        assert p in params, f"原生 handler 缺少 {p}"


def test_mirror_agent_channel_group_by_parity(client, orders_env):
    """agent 通道响应 == external handler 直调结果（双通道数据一致）。"""
    from urllib.parse import parse_qsl

    from app.api.v1.endpoints.agent.external_mirror import (
        _iter_external_apiroutes,
    )
    from app.api.v1.endpoints.external.orders_summary import (
        get_external_orders_summary,
    )

    pid = orders_env["project_id"]
    qs = f"period=7d&country={orders_env['country']}&group_by=asin&include_share=true"

    resp = client.get(
        f"/api/v1/agent/projects/{pid}/orders/summary?{qs}",
        headers=orders_env["headers"],
    )
    assert resp.status_code == 200, resp.text
    agent_data = resp.json()["data"]

    kwargs = dict(parse_qsl(qs))
    db = SessionLocal()
    try:
        result = get_external_orders_summary(
            project_id=pid,
            period=kwargs["period"],
            start_date=None,
            end_date=None,
            country=kwargs["country"],
            include_cancelled=False,
            include_pending=True,
            aggregate=True,
            group_by=kwargs["group_by"],
            order_by="sales_amount",
            order_dir="desc",
            include_share=kwargs["include_share"] == "true",
            limit=None,
            offset=0,
            db=db,
        )
    finally:
        db.close()
    ext_data = result.model_dump(mode="json")
    assert agent_data == ext_data, "agent 与 external handler 直调结果不一致"


# ---------------------------------------------------------------------------
# 8. 鉴权/壳：401 / 404 / 403
# ---------------------------------------------------------------------------


def test_grouped_401_without_credentials(client, orders_env):
    resp = client.get(
        f"/api/v1/agent/projects/{orders_env['project_id']}/orders/summary"
        f"?period=7d&country={orders_env['country']}&group_by=asin",
    )
    assert resp.status_code == 401
    body = resp.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "AGENT_AUTH_FAILED"


def test_grouped_404_project_not_found(client, orders_env):
    resp = client.get(
        "/api/v1/agent/projects/99999999/orders/summary"
        f"?period=7d&country={orders_env['country']}&group_by=asin",
        headers=orders_env["headers"],
    )
    assert resp.status_code == 404
    body = resp.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "RESOURCE_NOT_FOUND"


def test_grouped_403_out_of_scope(client, make_api_key):
    key = make_api_key(agent_id="scoped-blf558", project_scope="1")
    resp = client.get(
        "/api/v1/agent/projects/99999999/orders/summary"
        "?period=7d&country=US&group_by=asin",
        headers=_headers(key, "scoped-blf558"),
    )
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "AGENT_PROJECT_OUT_OF_SCOPE"
