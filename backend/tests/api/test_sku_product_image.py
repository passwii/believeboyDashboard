"""SKU 产品图上传 / 删除端点测试

注：本测试需要 backend/.env 配置数据库连接才能跑（执行前需先 alembic upgrade head）。
本任务按"选项 2"模式仅写文件，跳过 pytest 验证。
"""

from __future__ import annotations

import io
from datetime import datetime
from unittest.mock import PropertyMock, patch

import pytest
from PIL import Image
from fastapi.testclient import TestClient
from sqlalchemy import delete, select

from app.main import app
from app.core.config import get_settings
from app.models.sku_info import SkuRecord
from app.models.project import Project


@pytest.fixture
def client():
    return TestClient(app)


def _make_png_bytes() -> bytes:
    """生成 100x100 红色 PNG"""
    img = Image.new("RGB", (100, 100), color="red")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _create_test_sku(db, project_name: str = "测试项目", sku: str = "TEST-SKU-001") -> SkuRecord:
    """在 DB 中创建一个测试 SKU 记录"""
    project = db.execute(
        select(Project).where(Project.project_name == project_name)
    ).scalars().first()
    if project is None:
        project = Project(project_name=project_name, sort_order=0)
        db.add(project)
        db.commit()
        db.refresh(project)

    # 幂等：测试库持久，先清同 (project, sku) 旧记录再建，保证可重复跑
    db.execute(
        delete(SkuRecord).where(SkuRecord.project_id == project.id, SkuRecord.sku == sku)
    )
    db.commit()

    row = SkuRecord(
        project_id=project.id,
        project_name=project_name,
        sku=sku,
        asin="B000TEST",
        fob_unit_cost=1.0,
        first_leg_cost_rmb=2.0,
        package_length_cm=10.0,
        package_width_cm=10.0,
        package_height_cm=10.0,
        weight_kg=0.5,
        carton_length_cm=30.0,
        carton_width_cm=30.0,
        carton_height_cm=30.0,
        carton_weight_kg=5.0,
        units_per_carton=10,
        currency="CNY",
        country="US",
        sort_order=1,
        is_active=True,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def test_upload_product_image_success(client):
    """成功上传 1 张 PNG 图片"""
    settings = get_settings()
    with patch("app.services.r2_service.upload_bytes_to_r2") as mock_upload, \
         patch("app.services.r2_service.delete_file_from_r2") as mock_delete, \
         patch.object(type(settings), "r2_enabled", new_callable=PropertyMock, return_value=True):
        mock_upload.side_effect = [
            {"key": "test/main.webp", "url": "https://r2.example/main.webp", "size": 1000},
            {"key": "test/thumb.webp", "url": "https://r2.example/thumb.webp", "size": 500},
        ]
        from app.db.session import SessionLocal
        db = SessionLocal()
        try:
            sku = _create_test_sku(db)
        finally:
            db.close()

        files = {"file": ("test.png", _make_png_bytes(), "image/png")}
        response = client.post(
            f"/api/v1/sku-info/{sku.id}/product-image",
            files=files,
            headers={"X-API-Key": settings.api_key, "X-Operator": "tester"},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["sku_record_id"] == sku.id
        assert data["product_image_r2_key"] == "test/main.webp"
        assert data["product_image_thumbnail_r2_key"] == "test/thumb.webp"
        assert mock_upload.call_count == 2
        assert mock_delete.call_count == 0


def test_upload_product_image_replaces_old(client):
    """替换已有产品图：先删除旧 R2 对象"""
    settings = get_settings()
    with patch("app.services.r2_service.upload_bytes_to_r2") as mock_upload, \
         patch("app.services.r2_service.delete_file_from_r2") as mock_delete, \
         patch.object(type(settings), "r2_enabled", new_callable=PropertyMock, return_value=True):
        mock_upload.side_effect = [
            {"key": "test/new_main.webp", "url": "https://r2.example/new_main.webp", "size": 1000},
            {"key": "test/new_thumb.webp", "url": "https://r2.example/new_thumb.webp", "size": 500},
        ]

        from app.db.session import SessionLocal
        db = SessionLocal()
        try:
            sku = _create_test_sku(db, project_name="测试项目-替换", sku="TEST-SKU-002")
            sku.product_image_r2_key = "test/old_main.webp"
            sku.product_image_thumbnail_r2_key = "test/old_thumb.webp"
            db.commit()
            db.refresh(sku)
        finally:
            db.close()

        files = {"file": ("test.png", _make_png_bytes(), "image/png")}
        response = client.post(
            f"/api/v1/sku-info/{sku.id}/product-image",
            files=files,
            headers={"X-API-Key": settings.api_key, "X-Operator": "tester"},
        )

        assert response.status_code == 200
        assert mock_delete.call_count == 2
        delete_keys = [call.args[1] for call in mock_delete.call_args_list]
        assert "test/old_main.webp" in delete_keys
        assert "test/old_thumb.webp" in delete_keys


def test_upload_product_image_oversize(client):
    """文件超过 10MB 应返回 400"""
    settings = get_settings()
    with patch.object(type(settings), "r2_enabled", new_callable=PropertyMock, return_value=True):
        from app.db.session import SessionLocal
        db = SessionLocal()
        try:
            sku = _create_test_sku(db, project_name="测试项目-超限", sku="TEST-SKU-003")
        finally:
            db.close()

        big = b"x" * (11 * 1024 * 1024)
        files = {"file": ("big.png", big, "image/png")}
        response = client.post(
            f"/api/v1/sku-info/{sku.id}/product-image",
            files=files,
            headers={"X-API-Key": settings.api_key, "X-Operator": "tester"},
        )
        assert response.status_code == 400


def test_upload_product_image_invalid_type(client):
    """上传 .txt 应返回 400"""
    settings = get_settings()
    with patch.object(type(settings), "r2_enabled", new_callable=PropertyMock, return_value=True):
        from app.db.session import SessionLocal
        db = SessionLocal()
        try:
            sku = _create_test_sku(db, project_name="测试项目-类型", sku="TEST-SKU-004")
        finally:
            db.close()

        files = {"file": ("test.txt", b"hello", "text/plain")}
        response = client.post(
            f"/api/v1/sku-info/{sku.id}/product-image",
            files=files,
            headers={"X-API-Key": settings.api_key, "X-Operator": "tester"},
        )
        assert response.status_code == 400


def test_upload_product_image_sku_not_found(client):
    """不存在的 SKU 应返回 404"""
    settings = get_settings()
    with patch.object(type(settings), "r2_enabled", new_callable=PropertyMock, return_value=True):
        files = {"file": ("test.png", _make_png_bytes(), "image/png")}
        response = client.post(
            "/api/v1/sku-info/999999/product-image",
            files=files,
            headers={"X-API-Key": settings.api_key, "X-Operator": "tester"},
        )
        assert response.status_code == 404


def test_upload_product_image_r2_disabled(client):
    """R2 未配置应返回 503"""
    settings = get_settings()
    with patch.object(type(settings), "r2_enabled", new_callable=PropertyMock, return_value=False):
        from app.db.session import SessionLocal
        db = SessionLocal()
        try:
            sku = _create_test_sku(db, project_name="测试项目-R2关闭", sku="TEST-SKU-005")
        finally:
            db.close()

        files = {"file": ("test.png", _make_png_bytes(), "image/png")}
        response = client.post(
            f"/api/v1/sku-info/{sku.id}/product-image",
            files=files,
            headers={"X-API-Key": settings.api_key, "X-Operator": "tester"},
        )
        assert response.status_code == 503


def test_delete_product_image_success(client):
    """删除有图 SKU：清空 DB 字段 + 删除 R2 对象"""
    settings = get_settings()
    with patch("app.services.r2_service.delete_file_from_r2") as mock_delete:
        from app.db.session import SessionLocal
        db = SessionLocal()
        try:
            sku = _create_test_sku(db, project_name="测试项目-删除", sku="TEST-SKU-006")
            sku.product_image_r2_key = "test/main.webp"
            sku.product_image_thumbnail_r2_key = "test/thumb.webp"
            sku.product_image_uploaded_at = datetime.now()
            sku.product_image_uploaded_by = "old_operator"
            db.commit()
            db.refresh(sku)
        finally:
            db.close()

        response = client.delete(
            f"/api/v1/sku-info/{sku.id}/product-image",
            headers={"X-API-Key": settings.api_key, "X-Operator": "tester"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["deleted"] is True
        assert mock_delete.call_count == 2

        db = SessionLocal()
        try:
            refreshed = db.execute(
                select(SkuRecord).where(SkuRecord.id == sku.id)
            ).scalars().first()
            assert refreshed.product_image_r2_key is None
            assert refreshed.product_image_thumbnail_r2_key is None
            assert refreshed.product_image_uploaded_at is None
            assert refreshed.product_image_uploaded_by is None
        finally:
            db.close()


def test_delete_product_image_idempotent(client):
    """删除无图 SKU：返回 200，DB 字段本就为 null"""
    settings = get_settings()
    with patch("app.services.r2_service.delete_file_from_r2") as mock_delete:
        from app.db.session import SessionLocal
        db = SessionLocal()
        try:
            sku = _create_test_sku(db, project_name="测试项目-无图删除", sku="TEST-SKU-007")
        finally:
            db.close()

        response = client.delete(
            f"/api/v1/sku-info/{sku.id}/product-image",
            headers={"X-API-Key": settings.api_key, "X-Operator": "tester"},
        )
        assert response.status_code == 200
        assert response.json()["deleted"] is True
        assert mock_delete.call_count == 0


def test_delete_product_image_sku_not_found(client):
    """删除不存在 SKU 应返回 404"""
    settings = get_settings()
    response = client.delete(
        "/api/v1/sku-info/999999/product-image",
        headers={"X-API-Key": settings.api_key, "X-Operator": "tester"},
    )
    assert response.status_code == 404
