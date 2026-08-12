"""Agent 报表上传状态读路由测试（BLF-484：R1 report-upload-status）。

覆盖（对齐 issue 验收清单）：
① 无凭据 401 / 错误凭据 401；
② business_scope 不含 report_upload_status → 403；
③ project_scope 过滤（``*`` 全放行 vs 白名单过滤 items）；
④ 坏 report_date → 400 VALIDATION_FAILED 壳；
⑤ summary 派生正确（全绿项目 / 缺报项目 / 顶层计数）；
⑥ 响应壳结构（ok/data）。
"""

from __future__ import annotations

import uuid
from datetime import date

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete

from app.api.v1.endpoints.agent.report_upload_status import (
    COUNTRY_LABELS,
    _status_to_dict,
)
from app.db.session import SessionLocal
from app.main import app
from app.models import Project, ReportUploadLog
from app.services.rpa_report_service import (
    REPORT_TYPE_LABELS,
    REPORT_TYPES,
    STATUS_SOURCE_LABELS,
    ReportTypeStatus,
)

REPORT_DATE = "2026-06-15"

# 活跃 15 类（5 基础 + 10 广告）——与端点 `_active_report_types()` 同一口径。
ACTIVE_BASE_TYPES = [
    "inventory_report",
    "business_report",
    "sales_report",
    "payment_report",
    "return_report",
]
ACTIVE_AD_TYPES = [
    "ad_search_term_share_report",
    "ad_budget_report",
    "ad_campaign_report",
    "ad_purchased_product_report",
    "ad_promoted_product_report",
    "ad_invalid_traffic_report",
    "ad_placement_report",
    "ad_target_report",
    "ad_search_term_report",
    "ad_time_trend_report",
]
ACTIVE_TYPES = ACTIVE_BASE_TYPES + ACTIVE_AD_TYPES

# BLF-649：库存分类账 2 类已从 REPORT_TYPES 移除——statuses 不再包含、
# missing 统计亦不涉及（分类账数据不来自 RPA 上传，矩阵中无意义）。
# （预留 9 类已随 BLF-647 删除，故不再有对应列。）
LEDGER_TYPES = ["inventory_ledger_summary", "inventory_ledger_detail"]

# BLF-647 回归：这 9 个预留类型必须从 statuses 中消失（前端矩阵列已删）。
DELETED_RESERVED_TYPES = [
    "storage_report",
    "returns_detail_report",
    "fba_inventory_report",
    "reimbursement_report",
    "tax_invoice_report",
    "health_report",
    "advertising_reports",
    "brand_report",
    "vendor_report",
]

# BLF-648：预期中文名（对齐前端 RPA 状态矩阵短名；2 分类账用全名）。
EXPECTED_REPORT_TYPE_NAMES = {
    "inventory_report": "库存",
    "business_report": "业务",
    "sales_report": "销售",
    "payment_report": "付款",
    "return_report": "退货",
    "ad_search_term_share_report": "广告-词份额",
    "ad_budget_report": "广告-预算",
    "ad_campaign_report": "广告-广告活动",
    "ad_purchased_product_report": "广告-已购商品",
    "ad_promoted_product_report": "广告-推广商品",
    "ad_invalid_traffic_report": "广告-无效流量",
    "ad_placement_report": "广告-广告位",
    "ad_target_report": "广告-搜索词投放",
    "ad_search_term_report": "广告-搜索词",
    "ad_time_trend_report": "广告-时间效果",
}


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _seed_upload_logs(project_id: int, report_types: list[str]) -> None:
    """为指定项目补当日上传记录（upload_date == REPORT_DATE）。"""
    db = SessionLocal()
    try:
        for rt in report_types:
            db.add(
                ReportUploadLog(
                    project_id=project_id,
                    report_type=rt,
                    country="US",
                    upload_date=date.fromisoformat(REPORT_DATE),
                    has_real_data=True,
                    original_filename=f"{rt}.csv",
                )
            )
        db.commit()
    finally:
        db.close()


@pytest.fixture
def report_env(make_api_key):
    """两个临时项目 + 上传记录 + 凭据。

    P_A：活跃 15 类全上传（全绿）；P_B：仅 5 基础类上传（缺 10 广告类）。
    默认凭据 project_scope = "A,B"（items 恰好两项目，计数可确定断言）。
    """
    suffix = uuid.uuid4().hex[:8]
    agent_id = f"rpa-agent-{suffix}"

    db = SessionLocal()
    try:
        p_a = Project(
            project_name=f"agent-rpa-a-{suffix}", sort_order=0, is_active=True
        )
        p_b = Project(
            project_name=f"agent-rpa-b-{suffix}", sort_order=1, is_active=True
        )
        db.add_all([p_a, p_b])
        db.commit()
        db.refresh(p_a)
        db.refresh(p_b)
        project_a, project_b = p_a.id, p_b.id
    finally:
        db.close()

    _seed_upload_logs(project_a, ACTIVE_TYPES)
    _seed_upload_logs(project_b, ACTIVE_BASE_TYPES)

    key = make_api_key(agent_id=agent_id, project_scope=f"{project_a},{project_b}")

    def _headers(k: dict) -> dict:
        return {
            "Authorization": f"Bearer {k['plaintext']}",
            "X-Agent-Id": agent_id,
        }

    yield {
        "agent_id": agent_id,
        "project_a": project_a,
        "project_b": project_b,
        "project_a_name": f"agent-rpa-a-{suffix}",
        "project_b_name": f"agent-rpa-b-{suffix}",
        "headers": _headers(key),
        "make_key": lambda **kw: _headers(make_api_key(agent_id=agent_id, **kw)),
    }

    db = SessionLocal()
    try:
        db.execute(
            delete(ReportUploadLog).where(
                ReportUploadLog.project_id.in_([project_a, project_b])
            )
        )
        for pid in (project_a, project_b):
            obj = db.get(Project, pid)
            if obj is not None:
                db.delete(obj)
        db.commit()
    finally:
        db.close()


def _url(project_id: int | None = None) -> str:
    path = "/api/v1/agent/report-upload-status"
    if project_id is not None:
        return f"{path}?project_id={project_id}"
    return path


def _get(client, project_id=None, headers=None, **query):
    """GET 报表状态；所有 query 统一走 params dict（httpx 0.28 会整体替换
    URL 里的 query，避免嵌在 path 里被吃掉）。"""
    params = {"report_date": REPORT_DATE, **query}
    if project_id is not None:
        params["project_id"] = project_id
    return client.get(_url(), params=params, headers=headers)


class TestAuth:
    def test_no_credentials_401(self, client):
        resp = client.get(_url())
        assert resp.status_code == 401, resp.text
        body = resp.json()
        assert body["ok"] is False
        assert body["error"]["code"] == "AGENT_AUTH_FAILED"

    def test_wrong_credentials_401(self, client):
        resp = client.get(
            _url(),
            headers={"Authorization": "Bearer bbx_deadbeef", "X-Agent-Id": "x"},
        )
        assert resp.status_code == 401, resp.text
        assert resp.json()["error"]["reason"] == "token_invalid"


class TestBusinessScope:
    def test_out_of_scope_403(self, client, report_env):
        headers = report_env["make_key"](business_scope="shipments")
        resp = client.get(_url(), headers=headers)
        assert resp.status_code == 403, resp.text
        body = resp.json()
        assert body["ok"] is False
        assert body["error"]["code"] == "AGENT_BUSINESS_OUT_OF_SCOPE"


class TestProjectScopeFilter:
    def test_star_allows_all(self, client, report_env):
        """``*`` 全放行：items 包含两个测试项目（test DB 里还有别家项目）。"""
        headers = report_env["make_key"](project_scope="*")
        resp = _get(client, headers=headers)
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["project_count"] == len(data["items"])
        pids = {item["project_id"] for item in data["items"]}
        assert report_env["project_a"] in pids
        assert report_env["project_b"] in pids

    def test_whitelist_filters_items(self, client, report_env):
        """白名单只返回可见项目：默认凭据 scope = "A,B" → items 恰好两项目。"""
        resp = _get(client, headers=report_env["headers"])
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["project_count"] == 2
        assert data["missing_project_count"] == 1
        pids = {item["project_id"] for item in data["items"]}
        assert pids == {report_env["project_a"], report_env["project_b"]}

    def test_project_id_narrows(self, client, report_env):
        resp = _get(
            client, project_id=report_env["project_a"], headers=report_env["headers"]
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["project_count"] == 1
        assert data["items"][0]["project_id"] == report_env["project_a"]

    def test_project_id_not_visible_404(self, client, report_env):
        resp = _get(client, project_id=999999, headers=report_env["headers"])
        assert resp.status_code == 404, resp.text
        body = resp.json()
        assert body["ok"] is False
        assert body["error"]["code"] == "RESOURCE_NOT_FOUND"


class TestValidation:
    def test_bad_report_date_400(self, client, report_env):
        resp = _get(client, headers=report_env["headers"], report_date="not-a-date")
        assert resp.status_code == 400, resp.text
        body = resp.json()
        assert body["ok"] is False
        assert body["error"]["code"] == "VALIDATION_FAILED"


class TestSummaryDerivation:
    def test_all_green_project(self, client, report_env):
        """P_A 全绿：15 类全上传 → uploaded=15、missing=[]；顶层缺报=0（只算 P_A）。"""
        headers = report_env["make_key"](project_scope=str(report_env["project_a"]))
        resp = _get(client, headers=headers)
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["project_count"] == 1
        assert data["missing_project_count"] == 0
        item = data["items"][0]
        assert item["project_id"] == report_env["project_a"]
        assert item["uploaded_report_count"] == 15
        assert item["missing_report_types"] == []

    def test_missing_project_derives_10_ad_types(self, client, report_env):
        """P_B 仅 5 基础类上传 → uploaded=5、missing=10 广告类（按口径顺序）。"""
        headers = report_env["make_key"](project_scope=str(report_env["project_b"]))
        resp = _get(client, headers=headers)
        assert resp.status_code == 200, resp.text
        item = resp.json()["data"]["items"][0]
        assert item["project_id"] == report_env["project_b"]
        assert item["uploaded_report_count"] == 5
        assert item["missing_report_types"] == ACTIVE_AD_TYPES

    def test_ledger_and_deleted_reserved_types_absent(self, client, report_env):
        """BLF-649：分类账 2 类不再出现在 statuses（也不在 missing 统计里）；
        预留 9 类已删除（BLF-647），同样不在 statuses。"""
        resp = _get(client, headers=report_env["headers"])
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["missing_project_count"] == 1  # 仅 P_B 缺报

        item_b = next(
            i for i in data["items"] if i["project_id"] == report_env["project_b"]
        )
        assert all(rt not in item_b["missing_report_types"] for rt in LEDGER_TYPES)
        status_types = {s["report_type"] for s in item_b["statuses"]}
        assert set(LEDGER_TYPES).isdisjoint(status_types)
        assert set(DELETED_RESERVED_TYPES).isdisjoint(status_types)
        # 活跃 15 类仍在 statuses（BLF-648 中文名契约不受影响）
        for rt in ACTIVE_TYPES:
            assert rt in status_types

    def test_statuses_shape_and_upload_log_fields(self, client, report_env):
        """statuses 字段与内部端点一致：report_type/has_data/is_uploaded/latest_date/
        original_filename/status_source；上传路径 status_source=upload_log。"""
        resp = _get(client, headers=report_env["headers"])
        assert resp.status_code == 200, resp.text
        item_a = next(
            i
            for i in resp.json()["data"]["items"]
            if i["project_id"] == report_env["project_a"]
        )
        inv = next(
            s for s in item_a["statuses"] if s["report_type"] == "inventory_report"
        )
        assert inv["has_data"] is True
        assert inv["is_uploaded"] is True
        assert inv["latest_date"] == REPORT_DATE
        assert inv["status_source"] == "upload_log"
        # original_filename 仅在 upload log 关联 source file 时有值；未关联时
        # 为 None（与内部端点一致，字段恒存在）。
        assert "original_filename" in inv



class TestChineseLabels:
    """BLF-648：响应新增中文字段（report_type_name / status_source_name /
    country_name / 顶层 report_type_labels），英文 key 不回归。"""

    def test_report_type_labels_covers_all_report_types(self):
        """后端 REPORT_TYPES 每个 key 都有非空中文名；字典无多余 key。"""
        assert set(REPORT_TYPE_LABELS) == set(REPORT_TYPES)
        for key, label in REPORT_TYPE_LABELS.items():
            assert label, f"empty label for {key}"
            assert label != key, f"label equals key for {key}"

    def test_deleted_reserved_types_not_in_labels(self):
        """BLF-647 已删 9 个预留类型不进入中文映射。"""
        assert set(DELETED_RESERVED_TYPES).isdisjoint(REPORT_TYPE_LABELS)

    def test_statuses_carry_report_type_name(self, client, report_env):
        """statuses[] 每项有 report_type_name，中文口径与前端矩阵一致。"""
        resp = _get(client, headers=report_env["headers"])
        assert resp.status_code == 200, resp.text
        item_a = next(
            i
            for i in resp.json()["data"]["items"]
            if i["project_id"] == report_env["project_a"]
        )
        name_by_type = {
            s["report_type"]: s["report_type_name"] for s in item_a["statuses"]
        }
        for rt in REPORT_TYPES:
            assert name_by_type.get(rt) == EXPECTED_REPORT_TYPE_NAMES[rt]

    def test_status_source_name_mapping(self, client, report_env):
        """upload_log → 上传记录（全端点）；business_date_backfill → 业务日期回填。"""
        resp = _get(client, headers=report_env["headers"])
        assert resp.status_code == 200, resp.text
        item_a = next(
            i
            for i in resp.json()["data"]["items"]
            if i["project_id"] == report_env["project_a"]
        )
        inv = next(
            s for s in item_a["statuses"] if s["report_type"] == "inventory_report"
        )
        assert inv["status_source"] == "upload_log"
        assert inv["status_source_name"] == "上传记录"
        backfill = _status_to_dict(
            ReportTypeStatus(
                report_type="sales_report",
                has_data=True,
                is_uploaded=True,
                status_source="business_date_backfill",
            )
        )
        assert backfill["status_source"] == "business_date_backfill"
        assert backfill["status_source_name"] == "业务日期回填"
        assert STATUS_SOURCE_LABELS == {
            "upload_log": "上传记录",
            "business_date_backfill": "业务日期回填",
        }

    def test_country_name_top_level(self, client, report_env):
        """顶层 country_name：US → 美国站（对齐前端 REPORT_UPLOAD_COUNTRY_OPTIONS）。"""
        resp = _get(client, headers=report_env["headers"])
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["country"] == "US"
        assert data["country_name"] == "美国站"

    def test_report_type_labels_top_level_keeps_missing_as_strings(
        self, client, report_env
    ):
        """顶层 report_type_labels 全量映射；missing_report_types 保持字符串数组。"""
        resp = _get(client, headers=report_env["headers"])
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["report_type_labels"] == REPORT_TYPE_LABELS
        item_b = next(
            i
            for i in data["items"]
            if i["project_id"] == report_env["project_b"]
        )
        # 仍是字符串数组（不破坏现有英文 key 形状）
        assert item_b["missing_report_types"] == ACTIVE_AD_TYPES
        for rt in item_b["missing_report_types"]:
            assert data["report_type_labels"][rt] == EXPECTED_REPORT_TYPE_NAMES[rt]

    def test_unknown_values_fallback_to_original(self):
        """未知 report_type / status_source / country → fallback 原值（不抛错）。"""
        unknown = _status_to_dict(
            ReportTypeStatus(
                report_type="unknown_type",
                has_data=False,
                is_uploaded=False,
                status_source="mystery",
            )
        )
        assert unknown["report_type"] == "unknown_type"
        assert unknown["report_type_name"] == "unknown_type"
        assert unknown["status_source"] == "mystery"
        assert unknown["status_source_name"] == "mystery"
        assert COUNTRY_LABELS.get("FR", "FR") == "FR"
        # status_source=None → 保持 None（不制造中文名）
        none_src = _status_to_dict(
            ReportTypeStatus(report_type="x", has_data=False, is_uploaded=False)
        )
        assert none_src["status_source"] is None
        assert none_src["status_source_name"] is None


class TestResponseShell:
    def test_ok_data_shell(self, client, report_env):
        resp = _get(client, headers=report_env["headers"])
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["ok"] is True
        data = body["data"]
        assert data["country"] == "US"
        assert data["report_date"] == REPORT_DATE
        assert data["generated_at"].endswith("Z")
        assert data["project_count"] == 2
        assert data["missing_project_count"] == 1
        item = data["items"][0]
        for field in (
            "project_id",
            "project_name",
            "country",
            "uploaded_report_count",
            "missing_report_types",
            "statuses",
        ):
            assert field in item, f"missing field {field}"
