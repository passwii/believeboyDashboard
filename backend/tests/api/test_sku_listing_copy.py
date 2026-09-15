"""SKU 产品文案（Listing Copy）字段组测试（BLF-1080，spec §2/§3）。

覆盖：
* 读：主列表返回 listing_* 全字段（含溯源列），存量空值为 null。
* 写：批量端点只更新显式提供字段（只改标题不清空 bullets）；显式 null 清空；
  未知 id → skipped；空 items → 422；extra=forbid 拒溯源列；写入刷新
  updated_at/by。
* 导出：export_type=listing 表头与行；既有 cost / dimension 两分支表头不变。
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select

from app.db.session import SessionLocal
from app.main import app
from app.models.project import Project
from app.models.sku_info import SkuRecord

TEST_PROJECT = "文案测试项目"


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _ensure_sku(
    *,
    sku: str = "LISTING-SKU-001",
    asin: str = "B0LISTING01",
    project_name: str = TEST_PROJECT,
    **listing: str | None,
) -> int:
    """幂等建一条 SKU 记录，返回 id（测试库持久，先清同键旧行）。"""
    db = SessionLocal()
    try:
        project = (
            db.execute(select(Project).where(Project.project_name == project_name))
            .scalars()
            .first()
        )
        if project is None:
            project = Project(project_name=project_name, sort_order=0)
            db.add(project)
            db.commit()
            db.refresh(project)

        db.execute(
            delete(SkuRecord).where(
                SkuRecord.project_id == project.id, SkuRecord.sku == sku
            )
        )
        db.commit()

        row = SkuRecord(
            project_id=project.id,
            project_name=project_name,
            sku=sku,
            asin=asin,
            fob_unit_cost=1.0,
            first_leg_cost_rmb=2.0,
            country="US",
            sort_order=1,
            is_active=True,
            **listing,
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return int(row.id)
    finally:
        db.close()


# ---------------------------------------------------------------------------
# 批量写端点
# ---------------------------------------------------------------------------


def test_batch_update_only_writes_provided_fields(client, admin_headers):
    """只提供 listing_title → bullets 保持原值（不清空）。"""
    record_id = _ensure_sku(
        sku="LISTING-SKU-PROVIDED",
        listing_bullet_1="原始第 1 点",
        listing_bullet_2="原始第 2 点",
    )

    response = client.post(
        "/api/v1/sku-info/batch-update-listing-copy",
        json={"items": [{"id": record_id, "listing_title": "新标题"}]},
        headers=admin_headers,
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["updated"] == 1
    assert body["skipped"] == 0
    assert body["updated_ids"] == [record_id]

    db = SessionLocal()
    try:
        row = db.get(SkuRecord, record_id)
        assert row is not None
        assert row.listing_title == "新标题"
        assert row.listing_bullet_1 == "原始第 1 点"
        assert row.listing_bullet_2 == "原始第 2 点"
        assert row.listing_copy_updated_at is not None
        assert row.listing_copy_updated_by is not None
    finally:
        db.close()


def test_batch_update_explicit_null_clears(client, admin_headers):
    """显式传 null → 清空该字段，其它字段不动。"""
    record_id = _ensure_sku(
        sku="LISTING-SKU-CLEAR",
        listing_title="待清空标题",
        listing_description="待保留描述",
    )

    response = client.post(
        "/api/v1/sku-info/batch-update-listing-copy",
        json={"items": [{"id": record_id, "listing_title": None}]},
        headers=admin_headers,
    )

    assert response.status_code == 200, response.text
    db = SessionLocal()
    try:
        row = db.get(SkuRecord, record_id)
        assert row is not None
        assert row.listing_title is None
        assert row.listing_description == "待保留描述"
    finally:
        db.close()


def test_batch_update_empty_string_clears(client, admin_headers):
    """空串等价 null（避免 "" 与 NULL 双态）。"""
    record_id = _ensure_sku(sku="LISTING-SKU-EMPTY", listing_title="有标题")

    response = client.post(
        "/api/v1/sku-info/batch-update-listing-copy",
        json={"items": [{"id": record_id, "listing_title": "   "}]},
        headers=admin_headers,
    )

    assert response.status_code == 200, response.text
    db = SessionLocal()
    try:
        row = db.get(SkuRecord, record_id)
        assert row is not None
        assert row.listing_title is None
    finally:
        db.close()


def test_batch_update_unknown_id_skipped(client, admin_headers):
    """未知 id → skipped，不整批失败；有效行仍写入。"""
    record_id = _ensure_sku(sku="LISTING-SKU-SKIP")

    response = client.post(
        "/api/v1/sku-info/batch-update-listing-copy",
        json={
            "items": [
                {"id": record_id, "listing_title": "有效"},
                {"id": 99_999_999, "listing_title": "不存在"},
            ]
        },
        headers=admin_headers,
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["updated"] == 1
    assert body["skipped"] == 1
    assert body["updated_ids"] == [record_id]


def test_batch_update_empty_items_422(client, admin_headers):
    """空 items → 422（min_length=1）。"""
    response = client.post(
        "/api/v1/sku-info/batch-update-listing-copy",
        json={"items": []},
        headers=admin_headers,
    )
    assert response.status_code == 422


def test_batch_update_rejects_unknown_field(client, admin_headers):
    """extra=forbid：未知字段（如溯源列）→ 422。"""
    record_id = _ensure_sku(sku="LISTING-SKU-EXTRA")
    response = client.post(
        "/api/v1/sku-info/batch-update-listing-copy",
        json={"items": [{"id": record_id, "listing_copy_updated_by": "伪造"}]},
        headers=admin_headers,
    )
    assert response.status_code == 422


def test_batch_update_all_bullets(client, admin_headers):
    """5 点描述全量写入（bullet 拆列的核心场景）。"""
    record_id = _ensure_sku(sku="LISTING-SKU-BULLETS")
    bullets = {f"listing_bullet_{i}": f"第 {i} 点内容" for i in range(1, 6)}

    response = client.post(
        "/api/v1/sku-info/batch-update-listing-copy",
        json={"items": [{"id": record_id, **bullets}]},
        headers=admin_headers,
    )

    assert response.status_code == 200, response.text
    db = SessionLocal()
    try:
        row = db.get(SkuRecord, record_id)
        assert row is not None
        for field, expected in bullets.items():
            assert getattr(row, field) == expected
    finally:
        db.close()


# ---------------------------------------------------------------------------
# 读：主列表
# ---------------------------------------------------------------------------


def test_list_endpoint_returns_listing_fields(client, admin_headers):
    """主列表返回文案字段（含溯源列），存量空值为 null。"""
    _ensure_sku(
        sku="LISTING-SKU-LIST",
        listing_title="列表标题",
        listing_bullet_1="第 1 点",
    )
    response = client.get(
        "/api/v1/sku-info",
        params={"project_name": TEST_PROJECT, "sku": "LISTING-SKU-LIST"},
        headers=admin_headers,
    )
    assert response.status_code == 200, response.text
    items = response.json()["items"]
    assert len(items) == 1
    item = items[0]
    assert item["listing_title"] == "列表标题"
    assert item["listing_bullet_1"] == "第 1 点"
    assert item["listing_bullet_2"] is None
    assert item["listing_description"] is None
    assert item["listing_selling_points"] is None
    assert "listing_copy_updated_by" in item


# ---------------------------------------------------------------------------
# 导出
# ---------------------------------------------------------------------------


def _export_rows(client, headers, **params) -> list[str]:
    response = client.get("/api/v1/sku-info/export", params=params, headers=headers)
    assert response.status_code == 200, response.text
    text = response.content.decode("utf-8-sig")
    return [line for line in text.splitlines() if line.strip()]


LISTING_HEADER = (
    "project_name,SKU,ASIN(可留空),FNSKU(可留空),品名(可留空),国家,"
    "标题,五点描述1,五点描述2,五点描述3,五点描述4,五点描述5,Description,卖点提炼"
)


def test_export_listing_headers_and_row(client, admin_headers):
    """export_type=listing → 文案表头 + 行内容。"""
    _ensure_sku(
        sku="LISTING-SKU-EXPORT",
        listing_title="导出标题",
        listing_bullet_1="要点一",
        listing_selling_points="卖点一；卖点二",
    )
    rows = _export_rows(
        client,
        admin_headers,
        project_name=TEST_PROJECT,
        sku="LISTING-SKU-EXPORT",
        export_type="listing",
    )
    assert rows[0] == LISTING_HEADER
    assert "导出标题" in rows[1]
    assert "要点一" in rows[1]
    assert "卖点一；卖点二" in rows[1]


def test_export_listing_header_has_fourteen_columns(client, admin_headers):
    """文案导出 14 列（6 身份列 + 8 文案列）。"""
    _ensure_sku(sku="LISTING-SKU-COLS")
    rows = _export_rows(
        client,
        admin_headers,
        project_name=TEST_PROJECT,
        sku="LISTING-SKU-COLS",
        export_type="listing",
    )
    assert len(rows[0].split(",")) == 14


def test_export_cost_header_unchanged(client, admin_headers):
    """既有 cost 分支表头逐字节不变（回归锁）。"""
    _ensure_sku(sku="LISTING-SKU-COST")
    rows = _export_rows(
        client, admin_headers, project_name=TEST_PROJECT, export_type="cost"
    )
    assert rows[0] == (
        "project_name,SKU,ASIN(可留空),FNSKU(可留空),品名(可留空),FOB单价(RMB),国家"
    )


def test_export_dimension_header_unchanged(client, admin_headers):
    """既有 dimension 分支表头逐字节不变（回归锁）。"""
    _ensure_sku(sku="LISTING-SKU-DIM")
    rows = _export_rows(
        client, admin_headers, project_name=TEST_PROJECT, export_type="dimension"
    )
    assert rows[0].startswith(
        "project_name,SKU,ASIN(可留空),FNSKU(可留空),品名(可留空),国家,单品长(cm)"
    )
    assert rows[0].endswith("装箱数量")


def test_export_unknown_type_falls_back_to_cost(client, admin_headers):
    """未知 export_type 仍走 cost 兜底（既有语义不变）。"""
    _ensure_sku(sku="LISTING-SKU-FALLBACK")
    rows = _export_rows(
        client, admin_headers, project_name=TEST_PROJECT, export_type="bogus"
    )
    assert rows[0] == (
        "project_name,SKU,ASIN(可留空),FNSKU(可留空),品名(可留空),FOB单价(RMB),国家"
    )


# ---------------------------------------------------------------------------
# 模型 / 契约
# ---------------------------------------------------------------------------


def test_listing_copy_fields_constant_shape():
    """LISTING_COPY_FIELDS = 8 个业务字段，不含溯源列（唯一事实源）。"""
    from app.schemas.sku_info import LISTING_COPY_FIELDS

    assert len(LISTING_COPY_FIELDS) == 8
    assert len(set(LISTING_COPY_FIELDS)) == 8
    assert LISTING_COPY_FIELDS[0] == "listing_title"
    assert "listing_copy_updated_at" not in LISTING_COPY_FIELDS
    assert "listing_copy_updated_by" not in LISTING_COPY_FIELDS


def test_model_has_ten_listing_columns():
    """模型层 10 个 listing_* 列，全部可空（无回填语义）。"""
    columns = {
        c.name: c for c in SkuRecord.__table__.columns if c.name.startswith("listing_")
    }
    assert len(columns) == 10
    for name, column in columns.items():
        assert column.nullable is True, f"{name} 应为 nullable"


# ---------------------------------------------------------------------------
# 通用 CRUD 路径（P1 修复回归：schema 公开接受文案字段 → 必须真落库）
# ---------------------------------------------------------------------------


def test_generic_create_persists_listing_fields(client, admin_headers):
    """POST /sku-info 接受文案 → 真落库（修复前静默丢弃）。"""
    sku = "LISTING-SKU-CREATE"
    response = client.post(
        "/api/v1/sku-info",
        json={
            "project_name": TEST_PROJECT,
            "sku": sku,
            "asin": "B0LISTINGCRT",
            "listing_title": "新建标题",
            "listing_bullet_1": "新建第 1 点",
            "listing_selling_points": "新建卖点",
        },
        headers=admin_headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    item = body["item"]
    assert item["listing_title"] == "新建标题"
    assert item["listing_bullet_1"] == "新建第 1 点"
    assert item["listing_selling_points"] == "新建卖点"
    # 未提供的文案字段保持 NULL（未录入）
    assert item["listing_bullet_2"] is None
    assert item["listing_description"] is None
    # 溯源列：有文案写入才盖
    assert item["listing_copy_updated_at"] is not None
    assert item["listing_copy_updated_by"] is not None

    db = SessionLocal()
    try:
        row = db.get(SkuRecord, item["id"])
        assert row is not None
        assert row.listing_title == "新建标题"
        assert row.listing_copy_updated_at is not None
    finally:
        db.close()


def test_generic_create_without_listing_leaves_null(client, admin_headers):
    """POST /sku-info 不带文案 → 10 列全 NULL，溯源列不盖（「未录入」语义）。"""
    sku = "LISTING-SKU-CREATE-PLAIN"
    response = client.post(
        "/api/v1/sku-info",
        json={
            "project_name": TEST_PROJECT,
            "sku": sku,
            "asin": "B0LISTINGPLN",
        },
        headers=admin_headers,
    )
    assert response.status_code == 200, response.text
    item = response.json()["item"]
    for field in (
        "listing_title",
        "listing_bullet_1",
        "listing_bullet_2",
        "listing_bullet_3",
        "listing_bullet_4",
        "listing_bullet_5",
        "listing_description",
        "listing_selling_points",
    ):
        assert item[field] is None, f"{field} 应为 NULL"
    assert item["listing_copy_updated_at"] is None
    assert item["listing_copy_updated_by"] is None


def test_generic_patch_updates_listing_fields(client, admin_headers):
    """PATCH /sku-info/{id} 接受文案 → 真落库，且只改显式提供项。"""
    record_id = _ensure_sku(
        sku="LISTING-SKU-PATCH",
        listing_bullet_1="原有第 1 点",
        listing_bullet_2="原有第 2 点",
    )
    response = client.patch(
        f"/api/v1/sku-info/{record_id}",
        json={"listing_title": "补丁标题"},
        headers=admin_headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["listing_title"] == "补丁标题"
    # 未提供字段保持原值（不被清空）
    assert body["listing_bullet_1"] == "原有第 1 点"
    assert body["listing_bullet_2"] == "原有第 2 点"
    assert body["listing_copy_updated_at"] is not None
    assert body["listing_copy_updated_by"] is not None


def test_generic_patch_explicit_null_clears_listing(client, admin_headers):
    """PATCH 显式 null → 清空该文案字段，其它文案字段不动。"""
    record_id = _ensure_sku(
        sku="LISTING-SKU-PATCH-CLEAR",
        listing_title="待清空",
        listing_description="保留",
    )
    response = client.patch(
        f"/api/v1/sku-info/{record_id}",
        json={"listing_title": None},
        headers=admin_headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["listing_title"] is None
    assert body["listing_description"] == "保留"
    assert body["listing_copy_updated_at"] is not None
    assert body["listing_copy_updated_by"] is not None


def test_generic_patch_empty_string_clears_listing(client, admin_headers):
    """PATCH 显式空串 → 清空该文案字段。"""
    record_id = _ensure_sku(
        sku="LISTING-SKU-PATCH-EMPTY",
        listing_title="待清空",
    )
    response = client.patch(
        f"/api/v1/sku-info/{record_id}",
        json={"listing_title": "   "},
        headers=admin_headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["listing_title"] is None
    assert body["listing_copy_updated_at"] is not None
    assert body["listing_copy_updated_by"] is not None


def test_generic_upsert_updates_existing_listing_fields(client, admin_headers):
    """POST /sku-info 命中既有唯一键 → 更新分支同样落文案字段。"""
    record_id = _ensure_sku(
        sku="LISTING-SKU-UPSERT",
        asin="B0LISTINGUPS",
        listing_title="旧标题",
    )
    response = client.post(
        "/api/v1/sku-info",
        json={
            "project_name": TEST_PROJECT,
            "sku": "LISTING-SKU-UPSERT",
            "asin": "B0LISTINGUPS",
            "listing_title": "新标题",
            "listing_bullet_3": "第 3 点",
        },
        headers=admin_headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["action"] == "updated"
    assert body["item"]["id"] == record_id
    assert body["item"]["listing_title"] == "新标题"
    assert body["item"]["listing_bullet_3"] == "第 3 点"


def test_csv_export_listing_roundtrip_into_import(client, admin_headers):
    """导出 listing 模板可直接回传导入（表头承诺的往返闭环）。"""
    _ensure_sku(
        sku="LISTING-SKU-ROUNDTRIP",
        asin="B0LISTINGRT",
        listing_title="往返标题",
        listing_bullet_1="往返第 1 点",
        listing_description="往返描述",
    )
    exported = _export_rows(
        client,
        admin_headers,
        project_name=TEST_PROJECT,
        sku="LISTING-SKU-ROUNDTRIP",
        export_type="listing",
    )
    assert exported[0] == LISTING_HEADER

    # 清空文案，再用导出的同一份 CSV 回传导入（update 模式）
    record_id = _ensure_sku(sku="LISTING-SKU-ROUNDTRIP", asin="B0LISTINGRT")

    csv_content = ("\r\n".join(exported) + "\r\n").encode("utf-8")
    response = client.post(
        "/api/v1/sku-info/import-csv",
        params={"import_mode": "update"},
        files={"file": ("listing.csv", csv_content, "text/csv")},
        headers=admin_headers,
    )
    assert response.status_code == 200, response.text

    db = SessionLocal()
    try:
        row = db.get(SkuRecord, record_id)
        assert row is not None
        assert row.listing_title == "往返标题"
        assert row.listing_bullet_1 == "往返第 1 点"
        assert row.listing_description == "往返描述"
        assert row.listing_copy_updated_at is not None
    finally:
        db.close()
