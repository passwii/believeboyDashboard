"""orders/summary 多站点聚合 + 权限门契约测试（BLF-560；spec v0.2 §7.4/§7.5/§7.8）。

覆盖（对齐 spec v0.2 §7 清单中的 v0.2 增量项）：

1. **多站点 ``country=US,DE``（§7.4）**：行按 (group 维度 × country) 分组且带
   ``country``/``currency``；``summary.by_country`` 各站金额独立（US=$ / DE=€
   不混加）；``total_orders``/``total_quantity`` 跨站求和正确；顶层
   ``total_sales_amount``/``currency`` 为 None（不做跨币种求和）。
2. **share 按国家（§7.4）**：``group_by=asin&include_share=true`` 时
   Σshare(同国家) = 1（±1e-4），跨国家不混算。
3. **白名单校验（§7.5）**：多站点含非法国家 → 400 ``VALIDATION_FAILED``；
   legacy 模式多站点 → 400（多站点聚合仅支持 group_by 模式）。
4. **权限门（§7.8）**：原生路由挂 ``business_scope("orders")``——key 无
   ``orders`` 域 → 403 ``AGENT_BUSINESS_OUT_OF_SCOPE``；``business_scope="*"``
   → 放行；``business_scope="orders"`` → 放行。
5. **单站点回归锁（§7.4）**：``country=US`` 单站点行为与 v0.1 一致（顶层金额/
   币种保留，``by_country`` 含单站子块）。

口径（spec §5.2）：销售额 = ``sales_amount_expr(country)``（DE/UK 含税）；
订单数 = ``count(distinct amazon_order_id)``；多站点金额按国家独立结算。
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete

from app.db.session import SessionLocal
from app.main import app
from app.models import (
    AnalysisSalesOrderRow,
    AnalysisSourceFile,
    Project,
)


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _headers(key: dict, agent_id: str | None = None) -> dict:
    return {
        "Authorization": f"Bearer {key['plaintext']}",
        "X-Agent-Id": agent_id or key["agent_id"],
    }


def _seed_row(
    db,
    *,
    project_id: int,
    source_file_id: int,
    country: str,
    currency: str,
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
            order_status="Shipped",
            sku=sku,
            asin=asin,
            quantity=quantity,
            item_price=item_price,
            shipping_price=Decimal("0"),
            item_tax=item_tax,
            shipping_tax=shipping_tax,
            currency=currency,
            is_counted_sales=True,
            raw_row={
                "product_name": product_name or f"产品-{asin}",
                "fulfillment-channel": fulfillment_channel,
            },
        )
    )


@pytest.fixture
def multisite_env(make_api_key):
    """临时项目 + 全放行 agent key + US/DE 双站点订单行，测试后清理。

    种子数据（spec §7.4 口径用例）：
    * US：ASIN-A 1 单（qty=2 @10，USD）；ASIN-B 1 单（qty=5 @8，USD，FBM）。
    * DE：ASIN-A 1 单（qty=3 @10 + tax 2.5，EUR）——DE 含税口径。
    """
    agent_id = f"blf560-{uuid.uuid4().hex[:8]}"
    key = make_api_key(agent_id=agent_id, project_scope="*")
    suffix = uuid.uuid4().hex[:8]

    db = SessionLocal()
    try:
        project = Project(
            project_name=f"blf560-{suffix}",
            project_operator="pytest",
            assistant_operator=None,
            sort_order=0,
            is_active=True,
        )
        db.add(project)
        db.commit()
        db.refresh(project)
        pid = project.id

        today = date.today() - timedelta(days=1)
        day1 = today - timedelta(days=3)
        for country, currency in (("US", "USD"), ("DE", "EUR")):
            sf = AnalysisSourceFile(
                project_id=pid,
                country=country,
                report_type="sales_report",
                upload_file_id=f"test_sales_{pid}_{country}_{uuid.uuid4().hex[:6]}",
                upload_file_path="/tmp/test_sales.csv",
                original_filename="test_sales.csv",
                stored_filename="test_sales.csv",
                logical_filename="test_sales.csv",
                storage_key="test_sales.csv",
                period_start_date=today - timedelta(days=7),
                period_end_date=today,
                is_current=True,
                ingestion_status="success",
                created_by="pytest",
            )
            db.add(sf)
            db.flush()
            if country == "US":
                _seed_row(
                    db,
                    project_id=pid,
                    source_file_id=sf.id,
                    country=country,
                    currency=currency,
                    order_id="ORD-US1",
                    day=day1,
                    sku="SKU-A",
                    asin="ASIN-A",
                    quantity=2,
                    item_price=Decimal("10.00"),
                    row_no=1,
                )
                _seed_row(
                    db,
                    project_id=pid,
                    source_file_id=sf.id,
                    country=country,
                    currency=currency,
                    order_id="ORD-US2",
                    day=day1,
                    sku="SKU-B",
                    asin="ASIN-B",
                    quantity=5,
                    item_price=Decimal("8.00"),
                    fulfillment_channel="Merchant",
                    row_no=2,
                )
            else:
                _seed_row(
                    db,
                    project_id=pid,
                    source_file_id=sf.id,
                    country=country,
                    currency=currency,
                    order_id="ORD-DE1",
                    day=day1,
                    sku="SKU-A",
                    asin="ASIN-A",
                    quantity=3,
                    item_price=Decimal("10.00"),
                    item_tax=Decimal("2.50"),
                    row_no=1,
                )
        db.commit()
    finally:
        db.close()

    yield {
        "project_id": pid,
        "agent_id": agent_id,
        "key": key,
        "headers": _headers(key, agent_id),
    }

    db = SessionLocal()
    try:
        db.execute(
            delete(AnalysisSalesOrderRow).where(AnalysisSalesOrderRow.project_id == pid)
        )
        db.execute(
            delete(AnalysisSourceFile).where(AnalysisSourceFile.project_id == pid)
        )
        obj = db.get(Project, pid)
        if obj is not None:
            db.delete(obj)
        db.commit()
    finally:
        db.close()


# ---------------------------------------------------------------------------
# 1. 多站点 country=US,DE：行分组 × country + by_country 金额独立
# ---------------------------------------------------------------------------


def test_multisite_group_by_asin_country_split(client, multisite_env):
    resp = client.get(
        f"/api/v1/agent/projects/{multisite_env['project_id']}/orders/summary"
        "?period=7d&country=US,DE&group_by=asin",
        headers=multisite_env["headers"],
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]

    assert data["country"] == "US,DE"
    assert data["countries"] == ["US", "DE"]

    # 行 = (ASIN × country)：US ASIN-A / US ASIN-B / DE ASIN-A，共 3 行。
    rows = data["rows"]
    assert len(rows) == 3
    assert data["total_rows"] == 3

    us_a = next(r for r in rows if r["country"] == "US" and r["asin"] == "ASIN-A")
    us_b = next(r for r in rows if r["country"] == "US" and r["asin"] == "ASIN-B")
    de_a = next(r for r in rows if r["country"] == "DE" and r["asin"] == "ASIN-A")
    assert us_a["currency"] == "USD"
    assert us_a["sales_amount"] == 10.0
    assert us_b["currency"] == "USD"
    assert us_b["sales_amount"] == 8.0
    # DE 含税：item+shipping+item_tax+shipping_tax = 10+0+2.5+0 = 12.5。
    assert de_a["currency"] == "EUR"
    assert de_a["sales_amount"] == 12.5

    # summary.by_country：各站金额独立，不做跨币种求和。
    summary = data["summary"]
    assert summary["total_sales_amount"] is None  # 跨币种不可加
    assert summary["currency"] is None
    assert summary["total_orders"] == 3  # US 2 + DE 1
    assert summary["total_quantity"] == 10  # US 7 + DE 3
    by_country = summary["by_country"]
    assert by_country["US"] == {
        "currency": "USD",
        "total_sales_amount": 18.0,
        "total_orders": 2,
        "total_quantity": 7,
    }
    assert by_country["DE"] == {
        "currency": "EUR",
        "total_sales_amount": 12.5,
        "total_orders": 1,
        "total_quantity": 3,
    }
    # fba/fbm 为无量纲计数，跨站点合计（US FBA 1 + DE FBA 1；US FBM 1）。
    assert summary["fba_orders"] == 2
    assert summary["fbm_orders"] == 1


def test_multisite_share_per_country(client, multisite_env):
    """share 按国家内结算：Σshare(同国家) = 1（spec §5.1/§7.4）。"""
    resp = client.get(
        f"/api/v1/agent/projects/{multisite_env['project_id']}/orders/summary"
        "?period=7d&country=US,DE&group_by=asin&include_share=true",
        headers=multisite_env["headers"],
    )
    assert resp.status_code == 200, resp.text
    rows = resp.json()["data"]["rows"]

    us_rows = [r for r in rows if r["country"] == "US"]
    de_rows = [r for r in rows if r["country"] == "DE"]
    assert sum(r["share"] for r in us_rows) == pytest.approx(1.0, abs=1e-4)
    assert sum(r["share"] for r in de_rows) == pytest.approx(1.0, abs=1e-4)
    # US: ASIN-A 10/18；DE: ASIN-A 12.5/12.5 = 1.0。
    de_a = next(r for r in de_rows if r["asin"] == "ASIN-A")
    assert de_a["share"] == pytest.approx(1.0, abs=1e-4)


def test_multisite_asin_day_and_day(client, multisite_env):
    """group_by=asin_day / day：行按 (维度 × country) 分组。"""
    resp = client.get(
        f"/api/v1/agent/projects/{multisite_env['project_id']}/orders/summary"
        "?period=7d&country=US,DE&group_by=asin_day",
        headers=multisite_env["headers"],
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["total_rows"] == 3
    assert {r["country"] for r in data["rows"]} == {"US", "DE"}

    resp_day = client.get(
        f"/api/v1/agent/projects/{multisite_env['project_id']}/orders/summary"
        "?period=7d&country=US,DE&group_by=day",
        headers=multisite_env["headers"],
    )
    assert resp_day.status_code == 200, resp_day.text
    day_data = resp_day.json()["data"]
    assert day_data["total_rows"] == 2  # (day × country)
    us_day = next(r for r in day_data["rows"] if r["country"] == "US")
    de_day = next(r for r in day_data["rows"] if r["country"] == "DE")
    assert us_day["unique_asins"] == 2
    assert de_day["unique_asins"] == 1
    assert us_day["currency"] == "USD"
    assert de_day["currency"] == "EUR"


def test_multisite_legacy_mode_400(client, multisite_env):
    """多站点聚合仅 group_by 模式支持——legacy（原始行）多站点 → 400。"""
    resp = client.get(
        f"/api/v1/agent/projects/{multisite_env['project_id']}/orders/summary"
        "?period=7d&country=US,DE",
        headers=multisite_env["headers"],
    )
    assert resp.status_code == 400, resp.text
    body = resp.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "VALIDATION_FAILED"
    assert "group_by" in body["error"]["human_message"]


# ---------------------------------------------------------------------------
# 3. 白名单校验：多站点含非法国家 → 400
# ---------------------------------------------------------------------------


def test_multisite_invalid_country_400(client, multisite_env):
    resp = client.get(
        f"/api/v1/agent/projects/{multisite_env['project_id']}/orders/summary"
        "?period=7d&country=US,XX&group_by=asin",
        headers=multisite_env["headers"],
    )
    assert resp.status_code == 400, resp.text
    body = resp.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "VALIDATION_FAILED"
    assert "country" in body["error"]["human_message"]


def test_single_country_regression_lock(client, multisite_env):
    """单站点 country=US 行为与 v0.1 一致（顶层金额/币种保留 + by_country 单站）。"""
    resp = client.get(
        f"/api/v1/agent/projects/{multisite_env['project_id']}/orders/summary"
        "?period=7d&country=US&group_by=asin",
        headers=multisite_env["headers"],
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["country"] == "US"
    assert data["countries"] == ["US"]
    summary = data["summary"]
    assert summary["total_sales_amount"] == 18.0
    assert summary["currency"] == "USD"
    assert summary["by_country"]["US"]["total_sales_amount"] == 18.0
    # 行仍带 country/currency（v0.2 增量字段）。
    assert all(r["country"] == "US" for r in data["rows"])


# ---------------------------------------------------------------------------
# 4. 权限门：business_scope("orders")
# ---------------------------------------------------------------------------


def test_business_scope_403_without_orders(client, make_api_key):
    """key 无 orders 域 → 403 AGENT_BUSINESS_OUT_OF_SCOPE。"""
    key = make_api_key(agent_id="blf560-noorders", business_scope="shipments")
    resp = client.get(
        "/api/v1/agent/projects/1/orders/summary?period=7d&country=US&group_by=asin",
        headers=_headers(key, "blf560-noorders"),
    )
    assert resp.status_code == 403, resp.text
    body = resp.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "AGENT_BUSINESS_OUT_OF_SCOPE"


def test_business_scope_allows_orders(client, multisite_env, make_api_key):
    """key business_scope 含 orders → 放行（200）。"""
    key = make_api_key(agent_id="blf560-withorders", business_scope="shipments,orders")
    resp = client.get(
        f"/api/v1/agent/projects/{multisite_env['project_id']}/orders/summary"
        "?period=7d&country=US&group_by=asin",
        headers=_headers(key, "blf560-withorders"),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["ok"] is True


def test_business_scope_star_allows(client, multisite_env):
    """存量 key business_scope=\"*\" → 放行（兼容）。"""
    resp = client.get(
        f"/api/v1/agent/projects/{multisite_env['project_id']}/orders/summary"
        "?period=7d&country=US&group_by=asin",
        headers=multisite_env["headers"],
    )
    assert resp.status_code == 200, resp.text


def test_business_scope_403_even_with_project_scope(client, make_api_key):
    """business_scope 校验在 project_scope 之前：无 orders 域 → 403 业务域错误。"""
    key = make_api_key(
        agent_id="blf560-scope-both", business_scope="shipments", project_scope="1"
    )
    resp = client.get(
        "/api/v1/agent/projects/99999999/orders/summary?period=7d&country=US&group_by=asin",
        headers=_headers(key, "blf560-scope-both"),
    )
    assert resp.status_code == 403, resp.text
    assert resp.json()["error"]["code"] == "AGENT_BUSINESS_OUT_OF_SCOPE"
