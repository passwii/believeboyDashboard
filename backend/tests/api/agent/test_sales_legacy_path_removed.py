"""sales/summary 旧路径 /orders/summary v3 下线测试（BLF-571）。

BLF-571（2026-08-10 用户拍板提前执行，不等原 Sunset 预告 2026-12-31）：
agent 命名空间旧路径 ``/api/v1/agent/projects/{project_id}/orders/summary``
双挂路由已移除（含 ``_mark_legacy_deprecation`` 迁移提示头），仅保留
``/sales/summary`` 原生路径。

覆盖（对应原 test_sales_summary_migration.py 的 v3 阶段）：

1. **已鉴权 + 旧路径 → 404 壳**：未注册路径由 ``agent_router`` 兜底路由返回
   404（``error.code = RESOURCE_NOT_FOUND``），不再暴露旧 handler 行为。
2. **未鉴权 + 旧路径 → 401 壳**：兜底路由挂在 agent_router 之下，鉴权依赖
   先跑——未鉴权得 ``AGENT_AUTH_FAILED``（与 agent 命名空间其他未注册路径一致）。
3. **新路径 /sales/summary 回归**：主路径不受下线影响，正常返回 200。

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
    agent_id = f"blf571-{uuid.uuid4().hex[:8]}"
    key = make_api_key(agent_id=agent_id, project_scope="*")
    suffix = uuid.uuid4().hex[:8]

    db = SessionLocal()
    try:
        project = Project(
            project_name=f"blf571-{suffix}",
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
# v3 下线：旧路径 /orders/summary 已移除
# ---------------------------------------------------------------------------


def test_legacy_path_removed_404(client, sales_env):
    """已鉴权请求旧路径 /orders/summary → 404 壳（路由已移除）。"""
    resp = client.get(
        f"/api/v1/agent/projects/{sales_env['project_id']}/orders/summary"
        "?period=7d&country=US&group_by=asin",
        headers=sales_env["headers"],
    )
    assert resp.status_code == 404, resp.text
    body = resp.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "RESOURCE_NOT_FOUND"


def test_legacy_path_unauthenticated_401(client, sales_env):
    """未鉴权请求旧路径 → 401 壳（兜底路由鉴权依赖先跑）。"""
    resp = client.get(
        f"/api/v1/agent/projects/{sales_env['project_id']}/orders/summary"
        "?period=7d&country=US&group_by=asin",
    )
    assert resp.status_code == 401
    body = resp.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "AGENT_AUTH_FAILED"


def test_native_sales_path_still_works(client, sales_env):
    """回归：新路径 /sales/summary 不受下线影响，正常返回 200。"""
    resp = client.get(
        f"/api/v1/agent/projects/{sales_env['project_id']}/sales/summary"
        "?period=7d&country=US&group_by=asin",
        headers=sales_env["headers"],
    )
    assert resp.status_code == 200, resp.text
