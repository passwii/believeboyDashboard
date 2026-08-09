"""sales/summary 旧路径双挂迁移提示测试（BLF-569）。

覆盖（spec v0.3 §7 测试清单）：

1. **旧路径 /orders/summary 行为兼容**：与 /sales/summary 同一实现，响应
   ``data`` 完全一致（数据零漂移）——group_by 模式 / 非 group_by 模式各验一次。
2. **迁移提示头（对齐 BLF-459 v1 双挂先例）**：
   ``Deprecation: true`` + ``Sunset: <_LEGACY_PATH_SUNSET>`` +
   ``Link: </api/v1/agent/projects/{id}/sales/summary>; rel="successor-version"``
   ——新路径 sales/summary **不**带 Deprecation 头（仅旧路径提示）。
3. **旧路径权限门**：挂 business_scope("sales")——key 无 sales 域 → 403
   AGENT_BUSINESS_OUT_OF_SCOPE；``*`` 放行。
4. **旧路径鉴权/壳**：未鉴权 401；项目不存在 404（与 sales/summary 一致）。

口径（spec §5.2）：销售额 = ``sales_amount_expr(country)``；订单数 =
``count(distinct amazon_order_id)``。
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
            item_tax=Decimal("0"),
            shipping_tax=Decimal("0"),
            currency=currency,
            is_counted_sales=True,
            raw_row={"product_name": f"产品-{asin}", "fulfillment-channel": "Amazon"},
        )
    )


@pytest.fixture
def sales_env(make_api_key):
    """临时项目 + 全放行 agent key + US 订单行，测试后清理。"""
    agent_id = f"blf569-{uuid.uuid4().hex[:8]}"
    key = make_api_key(agent_id=agent_id, project_scope="*")
    suffix = uuid.uuid4().hex[:8]

    db = SessionLocal()
    try:
        project = Project(
            project_name=f"blf569-{suffix}",
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
        sf = AnalysisSourceFile(
            project_id=pid,
            country="US",
            report_type="sales_report",
            upload_file_id=f"test_sales_{pid}_{uuid.uuid4().hex[:6]}",
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
        _seed_row(
            db,
            project_id=pid,
            source_file_id=sf.id,
            country="US",
            currency="USD",
            order_id="ORD-M1",
            day=today - timedelta(days=3),
            sku="SKU-M",
            asin="ASIN-M",
            quantity=2,
            item_price=Decimal("10.00"),
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
# 1. 旧路径行为兼容：/orders/summary 与 /sales/summary 数据零漂移
# ---------------------------------------------------------------------------


def test_legacy_path_data_identical_to_sales(client, sales_env):
    """同一请求打到 /orders/summary 与 /sales/summary，data 完全一致。"""
    pid = sales_env["project_id"]
    qs = "period=7d&country=US&group_by=asin&include_share=true"

    legacy = client.get(
        f"/api/v1/agent/projects/{pid}/orders/summary?{qs}",
        headers=sales_env["headers"],
    )
    native = client.get(
        f"/api/v1/agent/projects/{pid}/sales/summary?{qs}",
        headers=sales_env["headers"],
    )
    assert legacy.status_code == 200, legacy.text
    assert native.status_code == 200, native.text
    assert legacy.json()["data"] == native.json()["data"], (
        "旧路径 /orders/summary 与 /sales/summary 数据必须零漂移"
    )


def test_legacy_path_non_grouped_identical(client, sales_env):
    """非 group_by 模式（原始行 + aggregate）同样零漂移。"""
    pid = sales_env["project_id"]
    qs = "period=7d&country=US"

    legacy = client.get(
        f"/api/v1/agent/projects/{pid}/orders/summary?{qs}",
        headers=sales_env["headers"],
    )
    native = client.get(
        f"/api/v1/agent/projects/{pid}/sales/summary?{qs}",
        headers=sales_env["headers"],
    )
    assert legacy.status_code == 200, legacy.text
    assert legacy.json()["data"] == native.json()["data"]


# ---------------------------------------------------------------------------
# 2. 迁移提示头：Deprecation + Sunset + Link successor-version（BLF-459 v1 同款）
# ---------------------------------------------------------------------------


def test_legacy_path_deprecation_headers(client, sales_env):
    """旧路径带 Deprecation/Sunset/Link 迁移提示头；新路径不带。"""
    from app.api.v1.endpoints.agent.sales import _LEGACY_PATH_SUNSET

    pid = sales_env["project_id"]
    qs = "period=7d&country=US&group_by=asin"

    legacy = client.get(
        f"/api/v1/agent/projects/{pid}/orders/summary?{qs}",
        headers=sales_env["headers"],
    )
    native = client.get(
        f"/api/v1/agent/projects/{pid}/sales/summary?{qs}",
        headers=sales_env["headers"],
    )

    # 旧路径：三头齐备，Link 指向新路径 successor。
    assert legacy.headers.get("Deprecation") == "true"
    assert legacy.headers.get("Sunset") == _LEGACY_PATH_SUNSET
    assert legacy.headers.get("Link") == (
        f'</api/v1/agent/projects/{pid}/sales/summary>; rel="successor-version"'
    )

    # 新路径：无 Deprecation 提示头（干净的正式路径）。
    assert "Deprecation" not in native.headers
    assert "Link" not in native.headers


def test_legacy_path_sunset_is_future(client, sales_env):
    """Sunset 必须是一个合法的未来日期（给消费者切换窗口）。"""
    from datetime import date as date_cls

    from app.api.v1.endpoints.agent.sales import _LEGACY_PATH_SUNSET

    parsed = date_cls.fromisoformat(_LEGACY_PATH_SUNSET)
    assert parsed > date_cls.today()


# ---------------------------------------------------------------------------
# 3. 旧路径权限门：business_scope("sales")
# ---------------------------------------------------------------------------


def test_legacy_path_403_without_sales_scope(client, make_api_key):
    """旧路径同样挂 business_scope("sales")：无 sales 域 → 403。"""
    key = make_api_key(agent_id="blf569-legacy-noscope", business_scope="shipments")
    resp = client.get(
        "/api/v1/agent/projects/1/orders/summary?period=7d&country=US&group_by=asin",
        headers=_headers(key, "blf569-legacy-noscope"),
    )
    assert resp.status_code == 403, resp.text
    assert resp.json()["error"]["code"] == "AGENT_BUSINESS_OUT_OF_SCOPE"


def test_legacy_path_star_allows(client, sales_env):
    """存量 key business_scope=\"*\" → 旧路径放行。"""
    resp = client.get(
        f"/api/v1/agent/projects/{sales_env['project_id']}/orders/summary"
        "?period=7d&country=US&group_by=asin",
        headers=sales_env["headers"],
    )
    assert resp.status_code == 200, resp.text


# ---------------------------------------------------------------------------
# 4. 旧路径鉴权/壳
# ---------------------------------------------------------------------------


def test_legacy_path_401_without_credentials(client, sales_env):
    resp = client.get(
        f"/api/v1/agent/projects/{sales_env['project_id']}/orders/summary"
        "?period=7d&country=US&group_by=asin",
    )
    assert resp.status_code == 401
    body = resp.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "AGENT_AUTH_FAILED"


def test_legacy_path_404_project_not_found(client, sales_env):
    resp = client.get(
        "/api/v1/agent/projects/99999999/orders/summary"
        "?period=7d&country=US&group_by=asin",
        headers=sales_env["headers"],
    )
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"
