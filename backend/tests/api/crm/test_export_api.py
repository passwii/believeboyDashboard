"""CRM CSV 导出端点集成测试（碰数据库，由主 agent 串行跑）。

覆盖：鉴权、Content-Type/BOM/Content-Disposition、scope 过滤、管理员 vs 销售权限。
"""

from __future__ import annotations

import csv
import io

BOM = "\ufeff"


def _create_customer(client, headers, name="客户A", **extra):
    resp = client.post(
        "/api/v1/crm/customers", headers=headers, json={"name": name, **extra}
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _create_lead(client, headers, name="联系人A", **extra):
    resp = client.post(
        "/api/v1/crm/leads", headers=headers, json={"name": name, **extra}
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _parse(resp) -> list[list[str]]:
    text = resp.content.decode("utf-8-sig")  # 自动剥 BOM
    return list(csv.reader(io.StringIO(text)))


# ── 鉴权 ─────────────────────────────────────────────────────────────────────


def test_export_customers_requires_auth(client):
    resp = client.get("/api/v1/crm/customers/export")
    assert resp.status_code in (401, 403)


def test_export_leads_requires_auth(client):
    resp = client.get("/api/v1/crm/leads/export")
    assert resp.status_code in (401, 403)


# ── 响应头与编码 ─────────────────────────────────────────────────────────────


def test_export_customers_response_headers_and_bom(client, admin_headers):
    _create_customer(client, admin_headers, name="客户A")
    resp = client.get("/api/v1/crm/customers/export", headers=admin_headers)
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/csv")
    assert "attachment" in resp.headers["content-disposition"]
    assert "filename" in resp.headers["content-disposition"]
    # UTF-8 BOM 打头（Excel 中文不乱码）
    assert resp.content.startswith(BOM.encode("utf-8"))


def test_export_customers_content_rows(client, admin_headers):
    _create_customer(client, admin_headers, name="客户A")
    _create_customer(client, admin_headers, name="客户B")
    resp = client.get("/api/v1/crm/customers/export", headers=admin_headers)
    rows = _parse(resp)
    assert rows[0][0] == "名称"  # 表头第一列
    names = {r[0] for r in rows[1:]}
    assert names == {"客户A", "客户B"}


def test_export_leads_content_rows(client, admin_headers):
    _create_lead(client, admin_headers, name="联系人A", company="公司A")
    resp = client.get("/api/v1/crm/leads/export", headers=admin_headers)
    assert resp.status_code == 200
    rows = _parse(resp)
    assert rows[0][0] == "联系人名"
    assert rows[1][0] == "联系人A"
    assert rows[1][1] == "公司A"


# ── keyword 过滤 ─────────────────────────────────────────────────────────────


def test_export_customers_keyword_filter(client, admin_headers):
    _create_customer(client, admin_headers, name="苹果科技")
    _create_customer(client, admin_headers, name="香蕉贸易")
    resp = client.get(
        "/api/v1/crm/customers/export?keyword=苹果", headers=admin_headers
    )
    rows = _parse(resp)
    names = {r[0] for r in rows[1:]}
    assert names == {"苹果科技"}


# ── scope 权限（销售 vs 管理员）─────────────────────────────────────────────


def test_export_customers_scope_mine_only_own(
    client, admin_headers, operator_headers, test_operator
):
    # admin 名下客户
    _create_customer(client, admin_headers, name="admin的客户")
    # operator 名下客户（创建时默认归创建人）
    _create_customer(client, operator_headers, name="operator的客户")

    # 销售 scope=mine 只见自己
    resp = client.get(
        "/api/v1/crm/customers/export?scope=mine", headers=operator_headers
    )
    names = {r[0] for r in _parse(resp)[1:]}
    assert names == {"operator的客户"}


def test_export_customers_scope_all_downgraded_for_sales(
    client, admin_headers, operator_headers
):
    _create_customer(client, admin_headers, name="admin的客户")
    _create_customer(client, operator_headers, name="operator的客户")

    # 销售请求 scope=all → 降级 mine，仍只见自己
    resp = client.get(
        "/api/v1/crm/customers/export?scope=all", headers=operator_headers
    )
    names = {r[0] for r in _parse(resp)[1:]}
    assert names == {"operator的客户"}

    # 管理员 scope=all 见全部
    resp_all = client.get(
        "/api/v1/crm/customers/export?scope=all", headers=admin_headers
    )
    names_all = {r[0] for r in _parse(resp_all)[1:]}
    assert names_all == {"admin的客户", "operator的客户"}


def test_export_leads_scope_mine(client, admin_headers, operator_headers):
    _create_lead(client, admin_headers, name="admin的线索")
    _create_lead(client, operator_headers, name="operator的线索")
    resp = client.get("/api/v1/crm/leads/export?scope=mine", headers=operator_headers)
    names = {r[0] for r in _parse(resp)[1:]}
    assert names == {"operator的线索"}
