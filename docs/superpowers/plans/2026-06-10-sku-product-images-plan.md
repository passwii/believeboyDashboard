# SKU Info - 产品图片 Tab 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 SKU Info 页面新增 `image` Tab，支持每 SKU 单张产品主图（上传 / 替换 / 删除 / 全屏查看），存储在 Cloudflare R2。

**架构：**
- 数据库：在 `product_costs` 表（`SkuRecord.__tablename__`）加 6 个可空列，与 `fnsku_label_*` 字段对称
- 后端：2 个新 REST 端点 `POST/DELETE /api/v1/sku-info/{id}/product-image`，复用 `ArtifactService`/`r2_service`
- 前端：新增 `image` Tab，复用 `UploadZone`（点击/粘贴/拖拽）+ `Dialog`（全屏 Lightbox）+ 现有 `DataTableCard` 表格壳

**技术栈：**
- 后端：FastAPI + SQLAlchemy + Alembic + Pillow + boto3 (R2)
- 前端：Next.js 14 App Router + React 18 + TanStack Table v8 + shadcn/ui
- 存储：Cloudflare R2（ArtifactService.upload 抽象）

**关键事实（来自代码勘察，避免实施时再发现）：**
- `SkuRecord` Python 类的 `__tablename__ == "product_costs"`（历史命名，所有 DDL 用表名 `product_costs`）
- 路由前缀是 `/sku-info/{sku_record_id}/...`（不是 `/sku-records/{...}`）
- `APIRouter(dependencies=[Depends(protected)])` 已注册，路由保护在 router 级别生效
- 现有 `upload_fnsku_label`（sku_info.py:771）**不做后端项目级权限检查**，仅校验 SKU 记录存在
- 现有 `_serialize_sku_record` 函数（sku_info.py:69）是 list/update 端点的统一序列化点，必须同步加 6 字段
- 前端已有 `UploadZone` 组件（点击/粘贴/拖拽三状态）、`Sheet`、`Dialog` 可直接复用
- 现有 ActiveTab 联合类型：`'cost' | 'dimension' | 'factory' | 'label'`

---

## 文件结构

| 类型 | 路径 | 职责 |
|---|---|---|
| 新建 | `backend/alembic/versions/20260610_159_add_sku_record_product_image.py` | 6 列添加 + downgrade |
| 修改 | `backend/app/models/sku_info.py` | `SkuRecord` 加 6 个 mapped_column |
| 修改 | `backend/app/schemas/sku_info.py` | `SkuRecordItem` 加 6 字段 + 新建 `SkuProductImageUploadResponse` |
| 修改 | `backend/app/api/v1/endpoints/sku_info.py` | 加 2 个端点 + `_serialize_sku_record` 加 6 字段 |
| 新建 | `backend/tests/api/test_sku_product_image.py` | 9 个 pytest 用例 |
| 修改 | `frontend/app/dashboard/data-management/sku-info/page.tsx` | `ActiveTab` 加 `'image'` + `ProductCostItem` 类型加 6 字段 + 渲染 `<ImageTabContent>` |
| 新建 | `frontend/components/dashboard/sku-info/image-tab.tsx` | 表格 + 筛选区 + 操作按钮 + Lightbox 状态管理 |
| 新建 | `frontend/components/dashboard/sku-info/image-upload-sheet.tsx` | Sheet + UploadZone，上传调用后端 |
| 新建 | `frontend/components/dashboard/sku-info/image-lightbox.tsx` | 全屏 Dialog，Esc 关闭 |

**职责切分原则**：
- 后端：数据 + 业务规则
- 前端三个组件：tab 容器 / 上传弹层 / 大图查看
- 不引入新的 service 文件，R2 操作直接调用现有 `ArtifactService` / `r2_service` 函数

---

## 任务 1：编写 alembic 迁移脚本

**文件：**
- 创建：`backend/alembic/versions/20260610_159_add_sku_record_product_image.py`

> 注意：实施前先跑 `cd backend && /Users/damon/miniconda3/bin/python3 -m alembic heads` 确认下一个 short ID 是 `159`。如果不是，按实际结果调整 `revision` 和 `down_revision`。

- [ ] **步骤 1：编写迁移文件**

完整内容：

```python
"""为 SKU 记录添加产品图片字段（与 FNSKU 标签对称）

在 product_costs 表（SKU 记录物理表）添加 6 列：
- product_image_r2_key / product_image_r2_url：R2 主图
- product_image_thumbnail_r2_key / product_image_thumbnail_r2_url：R2 缩略图
- product_image_uploaded_at / product_image_uploaded_by：上传元数据

Revision ID: 159
Revises: 158
Create Date: 2026-06-10
"""

from alembic import op
import sqlalchemy as sa


revision = "159"
down_revision = "158"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "product_costs",
        sa.Column("product_image_r2_key", sa.String(length=512), nullable=True),
    )
    op.add_column(
        "product_costs",
        sa.Column("product_image_r2_url", sa.String(length=1024), nullable=True),
    )
    op.add_column(
        "product_costs",
        sa.Column("product_image_thumbnail_r2_key", sa.String(length=512), nullable=True),
    )
    op.add_column(
        "product_costs",
        sa.Column("product_image_thumbnail_r2_url", sa.String(length=1024), nullable=True),
    )
    op.add_column(
        "product_costs",
        sa.Column("product_image_uploaded_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "product_costs",
        sa.Column("product_image_uploaded_by", sa.String(length=128), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("product_costs", "product_image_uploaded_by")
    op.drop_column("product_costs", "product_image_uploaded_at")
    op.drop_column("product_costs", "product_image_thumbnail_r2_url")
    op.drop_column("product_costs", "product_image_thumbnail_r2_key")
    op.drop_column("product_costs", "product_image_r2_url")
    op.drop_column("product_costs", "product_image_r2_key")
```

- [ ] **步骤 2：应用迁移验证**

运行：
```bash
cd /Users/damon/DamonProjects/believeboyDashboard/backend && /Users/damon/miniconda3/bin/python3 -m alembic upgrade head
```

预期：迁移成功（无错误）。然后用 `psql` 或 `pgcli` 连接数据库验证列已添加：

```sql
\d product_costs
```

应能看到 6 个新列。

- [ ] **步骤 3：验证 downgrade 也能跑（不真正执行）**

```bash
cd /Users/damon/DamonProjects/believeboyDashboard/backend && /Users/damon/miniconda3/bin/python3 -m alembic downgrade -1
```

预期：成功。然后立即 upgrade 回来：

```bash
/Users/damon/miniconda3/bin/python3 -m alembic upgrade head
```

- [ ] **步骤 4：Commit**

```bash
git add backend/alembic/versions/20260610_159_add_sku_record_product_image.py
git commit -m "feat(db): sku_records 加 6 列 product_image 字段"
```

---

## 任务 2：更新 SkuRecord SQLAlchemy 模型

**文件：**
- 修改：`backend/app/models/sku_info.py`（在 `fnsku_label_r2_url` 之后加 6 个 mapped_column）

- [ ] **步骤 1：在 fnsku_label_r2_url 之后添加 6 个 mapped_column**

定位到 `backend/app/models/sku_info.py` 第 106-107 行：

```python
fnsku_label_r2_key: Mapped[str | None] = mapped_column(String(512), nullable=True)
fnsku_label_r2_url: Mapped[str | None] = mapped_column(String(1024), nullable=True)
```

在第 107 行后插入：

```python
    product_image_r2_key: Mapped[str | None] = mapped_column(String(512), nullable=True)
    product_image_r2_url: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    product_image_thumbnail_r2_key: Mapped[str | None] = mapped_column(String(512), nullable=True)
    product_image_thumbnail_r2_url: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    product_image_uploaded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    product_image_uploaded_by: Mapped[str | None] = mapped_column(String(128), nullable=True)
```

- [ ] **步骤 2：运行 pytest 验证模型导入无错**

```bash
cd /Users/damon/DamonProjects/believeboyDashboard/backend && /Users/damon/miniconda3/bin/python3 -m pytest tests/api/test_sku_info.py -v --co 2>&1 | head -20
```

预期：`test_sku_info.py` 中的测试能被收集（不报 import 错）。如果报模型相关 import 错，说明字段名拼错或类型不对。

- [ ] **步骤 3：Commit**

```bash
git add backend/app/models/sku_info.py
git commit -m "feat(model): SkuRecord 加 6 个产品图字段"
```

---

## 任务 3：更新 SkuRecordItem Pydantic schema

**文件：**
- 修改：`backend/app/schemas/sku_info.py`
  - `SkuRecordItem` 加 6 字段
  - 文件末尾追加新 class `SkuProductImageUploadResponse` 和 `SkuProductImageDeleteResponse`

- [ ] **步骤 1：在 SkuRecordItem 加 6 字段**

定位到 `backend/app/schemas/sku_info.py` 第 33 行（`fnsku_label_r2_url` 之后），在 `class SkuRecordItem` 内追加：

```python
    product_image_r2_key: str | None = None
    product_image_r2_url: str | None = None
    product_image_thumbnail_r2_key: str | None = None
    product_image_thumbnail_r2_url: str | None = None
    product_image_uploaded_at: datetime | None = None
    product_image_uploaded_by: str | None = None
```

- [ ] **步骤 2：在文件末尾追加 2 个新 Response schema**

定位到 `backend/app/schemas/sku_info.py` 文件最末尾，追加：

```python


class SkuProductImageUploadResponse(BaseModel):
    """SKU 产品图上传响应"""

    sku_record_id: int
    product_image_r2_key: str
    product_image_r2_url: str
    product_image_thumbnail_r2_key: str
    product_image_thumbnail_r2_url: str
    uploaded_at: str


class SkuProductImageDeleteResponse(BaseModel):
    """SKU 产品图删除响应"""

    sku_record_id: int
    deleted: bool
```

- [ ] **步骤 3：Commit**

```bash
git add backend/app/schemas/sku_info.py
git commit -m "feat(schema): SkuRecordItem 加 6 字段 + 新增产品图 Response"
```

---

## 任务 4：编写后端端点的失败测试

**文件：**
- 创建：`backend/tests/api/test_sku_product_image.py`

- [ ] **步骤 1：编写 4 个失败测试**

完整文件内容（先写测试，不实现端点）：

```python
"""SKU 产品图上传 / 删除端点测试"""

import io
from unittest.mock import patch, MagicMock

import pytest
from PIL import Image
from fastapi.testclient import TestClient

from app.main import app
from app.core.config import get_settings
from app.db.session import get_db
from app.models.sku_info import SkuRecord


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
    from app.models.project import Project

    project = db.execute(
        select(Project).where(Project.name == project_name)
    ).scalars().first()
    if project is None:
        project = Project(name=project_name)
        db.add(project)
        db.commit()
        db.refresh(project)

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


from sqlalchemy import select


def test_upload_product_image_success(client):
    """成功上传 1 张 PNG 图片"""
    settings = get_settings()
    with patch("app.api.v1.endpoints.sku_info.upload_bytes_to_r2") as mock_upload, \
         patch("app.api.v1.endpoints.sku_info.delete_file_from_r2") as mock_delete, \
         patch("app.api.v1.endpoints.sku_info.get_settings", return_value=settings), \
         patch.object(settings, "r2_enabled", True):
        # 第一次 upload（主图）
        mock_upload.side_effect = [
            {"key": "test/main.webp", "url": "https://r2.example/main.webp", "size": 1000},
            {"key": "test/thumb.webp", "url": "https://r2.example/thumb.webp", "size": 500},
        ]
        # 创建测试 SKU
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
        assert mock_delete.call_count == 0  # 第一次上传，旧图为空


def test_upload_product_image_replaces_old(client):
    """替换已有产品图：先删除旧 R2 对象"""
    settings = get_settings()
    with patch("app.api.v1.endpoints.sku_info.upload_bytes_to_r2") as mock_upload, \
         patch("app.api.v1.endpoints.sku_info.delete_file_from_r2") as mock_delete, \
         patch.object(settings, "r2_enabled", True):
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
        finally:
            db.close()

        files = {"file": ("test.png", _make_png_bytes(), "image/png")}
        response = client.post(
            f"/api/v1/sku-info/{sku.id}/product-image",
            files=files,
            headers={"X-API-Key": settings.api_key, "X-Operator": "tester"},
        )

        assert response.status_code == 200
        # 旧图的两个 key 都被删除
        assert mock_delete.call_count == 2
        delete_keys = [call.args[1] for call in mock_delete.call_args_list]
        assert "test/old_main.webp" in delete_keys
        assert "test/old_thumb.webp" in delete_keys


def test_upload_product_image_oversize(client):
    """文件超过 10MB 应返回 400"""
    settings = get_settings()
    with patch.object(settings, "r2_enabled", True):
        from app.db.session import SessionLocal
        db = SessionLocal()
        try:
            sku = _create_test_sku(db, project_name="测试项目-超限", sku="TEST-SKU-003")
        finally:
            db.close()

        # 11MB 文件
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
    with patch.object(settings, "r2_enabled", True):
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
    with patch.object(settings, "r2_enabled", True):
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
    with patch.object(settings, "r2_enabled", False):
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
    with patch("app.api.v1.endpoints.sku_info.delete_file_from_r2") as mock_delete:
        from app.db.session import SessionLocal
        db = SessionLocal()
        try:
            sku = _create_test_sku(db, project_name="测试项目-删除", sku="TEST-SKU-006")
            sku.product_image_r2_key = "test/main.webp"
            sku.product_image_thumbnail_r2_key = "test/thumb.webp"
            sku.product_image_uploaded_at = __import__("datetime").datetime.now()
            sku.product_image_uploaded_by = "old_operator"
            db.commit()
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

        # 验证 DB 字段被清空
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
    with patch("app.api.v1.endpoints.sku_info.delete_file_from_r2") as mock_delete:
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
        # 没有 R2 对象需要删除
        assert mock_delete.call_count == 0


def test_delete_product_image_sku_not_found(client):
    """删除不存在 SKU 应返回 404"""
    settings = get_settings()
    response = client.delete(
        "/api/v1/sku-info/999999/product-image",
        headers={"X-API-Key": settings.api_key, "X-Operator": "tester"},
    )
    assert response.status_code == 404
```

- [ ] **步骤 2：运行测试验证全部失败**

```bash
cd /Users/damon/DamonProjects/believeboyDashboard/backend && /Users/damon/miniconda3/bin/python3 -m pytest tests/api/test_sku_product_image.py -v 2>&1 | tail -30
```

预期：9 个测试全部 FAIL（端点尚未实现，报 404 或 405）。

- [ ] **步骤 3：Commit**

```bash
git add backend/tests/api/test_sku_product_image.py
git commit -m "test(sku-image): 加 9 个失败的产品图端点测试"
```

---

## 任务 5：实现后端 POST 端点

**文件：**
- 修改：`backend/app/api/v1/endpoints/sku_info.py`
  - 在文件顶部 import 区追加需要的 import
  - 在 `upload_fnsku_label` 函数（line 771）之后追加 `upload_product_image` 函数
  - 在 `_serialize_sku_record` 函数（line 69）内追加 6 字段

- [ ] **步骤 1：在 import 区追加**

定位到 `backend/app/api/v1/endpoints/sku_info.py` 顶部 import 区（找最末尾的 import 行），追加：

```python
import io
import uuid
from datetime import datetime, timezone
from io import BytesIO
from PIL import Image, ImageOps, UnidentifiedImageError
```

> 实施时检查是否已有这些 import，避免重复。

- [ ] **步骤 2：在 _serialize_sku_record 加 6 字段**

定位到 line 96-97（`fnsku_label_r2_url` 之后）：

```python
        "fnsku_label_r2_key": getattr(row, 'fnsku_label_r2_key', None),
        "fnsku_label_r2_url": getattr(row, 'fnsku_label_r2_url', None),
    }
```

在 `}` 之前插入：

```python
        "product_image_r2_key": getattr(row, 'product_image_r2_key', None),
        "product_image_r2_url": getattr(row, 'product_image_r2_url', None),
        "product_image_thumbnail_r2_key": getattr(row, 'product_image_thumbnail_r2_key', None),
        "product_image_thumbnail_r2_url": getattr(row, 'product_image_thumbnail_r2_url', None),
        "product_image_uploaded_at": str(row.product_image_uploaded_at) if getattr(row, 'product_image_uploaded_at', None) else None,
        "product_image_uploaded_by": getattr(row, 'product_image_uploaded_by', None),
```

> 用 `getattr(row, ..., None)` 是为了在历史数据（迁移前）通过 `_serialize_sku_record` 时不报 AttributeError。

- [ ] **步骤 3：在 upload_fnsku_label 函数之后追加 upload_product_image**

定位到 `upload_fnsku_label` 函数结束（line 863 的 `return FnskuLabelUploadResponse(...)` 之后），追加：

```python


@router.post("/sku-info/{sku_record_id}/product-image", response_model=SkuProductImageUploadResponse)
def upload_product_image(
    sku_record_id: int,
    file: UploadFile = File(...),
    request: Request = None,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> SkuProductImageUploadResponse:
    """上传或替换指定 SKU 的产品图（自动生成 1920x1920 主图 + 320x320 缩略图）。"""
    from app.core.config import get_settings
    from app.services.r2_service import upload_bytes_to_r2, delete_file_from_r2
    from app.services.upload_service import _safe_project_folder_name

    settings = get_settings()
    if not settings.r2_enabled:
        raise HTTPException(status_code=503, detail="R2 存储未配置")

    # 查找记录
    row = db.execute(
        select(SkuRecord).where(SkuRecord.id == sku_record_id)
    ).scalars().first()
    if not row:
        raise HTTPException(status_code=404, detail="SKU 记录不存在")

    # 验证文件类型
    allowed_types = {"image/jpeg", "image/png", "image/webp", "image/gif"}
    if file.content_type not in allowed_types:
        raise HTTPException(status_code=400, detail="仅支持 JPG / PNG / WebP / GIF 图片")

    # 读取并验证大小
    content = file.file.read()
    max_size = 10 * 1024 * 1024  # 10MB
    if len(content) > max_size:
        raise HTTPException(status_code=400, detail="文件大小不能超过 10MB")
    if len(content) == 0:
        raise HTTPException(status_code=400, detail="文件为空")

    # 用 Pillow 处理
    try:
        image = Image.open(BytesIO(content))
        image = ImageOps.exif_transpose(image)
        image.load()
    except UnidentifiedImageError:
        raise HTTPException(status_code=400, detail="图片内容无法识别") from None

    image = image.convert("RGB")
    image.thumbnail((1920, 1920))

    thumb_image = ImageOps.fit(
        image.copy(),
        (320, 320),
        method=Image.Resampling.LANCZOS,
        centering=(0.5, 0.5),
    )

    image_id = uuid.uuid4().hex
    main_name = f"{image_id}.webp"
    thumb_name = f"{image_id}_thumb.webp"

    main_buf = BytesIO()
    image.save(main_buf, format="WEBP", quality=82, method=6)
    main_bytes = main_buf.getvalue()

    thumb_buf = BytesIO()
    thumb_image.save(thumb_buf, format="WEBP", quality=72, method=6)
    thumb_bytes = thumb_buf.getvalue()

    # 删除旧图（如有）
    if row.product_image_r2_key:
        try:
            delete_file_from_r2(settings, row.product_image_r2_key)
        except Exception:
            pass
    if row.product_image_thumbnail_r2_key:
        try:
            delete_file_from_r2(settings, row.product_image_thumbnail_r2_key)
        except Exception:
            pass

    # 上传到 R2
    project_slug = _safe_project_folder_name(row.project_name)
    main_result = upload_bytes_to_r2(
        settings=settings,
        data=main_bytes,
        filename=main_name,
        project_slug=project_slug,
        file_type="product-images",
        content_type="image/webp",
    )
    thumb_result = upload_bytes_to_r2(
        settings=settings,
        data=thumb_bytes,
        filename=thumb_name,
        project_slug=project_slug,
        file_type="product-thumbs",
        content_type="image/webp",
    )

    # 更新 DB
    row.product_image_r2_key = main_result["key"]
    row.product_image_r2_url = main_result["url"]
    row.product_image_thumbnail_r2_key = thumb_result["key"]
    row.product_image_thumbnail_r2_url = thumb_result["url"]
    row.product_image_uploaded_at = datetime.now(timezone.utc)
    row.product_image_uploaded_by = operator

    append_operation_audit_log(
        db,
        action="sku_info.upload_product_image",
        target_type="sku_info",
        target_id=sku_record_id,
        operator=operator,
        after={
            "sku": row.sku,
            "product_image_r2_key": main_result["key"],
            "product_image_thumbnail_r2_key": thumb_result["key"],
            "file_size": len(content),
        },
        request=request,
    )
    db.commit()

    return SkuProductImageUploadResponse(
        sku_record_id=sku_record_id,
        product_image_r2_key=main_result["key"],
        product_image_r2_url=main_result["url"],
        product_image_thumbnail_r2_key=thumb_result["key"],
        product_image_thumbnail_r2_url=thumb_result["url"],
        uploaded_at=row.product_image_uploaded_at.isoformat(),
    )
```

- [ ] **步骤 4：在 upload_product_image 之后追加 delete_product_image**

紧接 `upload_product_image` 函数末尾追加：

```python


@router.delete("/sku-info/{sku_record_id}/product-image", response_model=SkuProductImageDeleteResponse)
def delete_product_image(
    sku_record_id: int,
    request: Request = None,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> SkuProductImageDeleteResponse:
    """删除指定 SKU 的产品图（清空 R2 对象 + DB 字段）。"""
    from app.core.config import get_settings
    from app.services.r2_service import delete_file_from_r2

    settings = get_settings()

    row = db.execute(
        select(SkuRecord).where(SkuRecord.id == sku_record_id)
    ).scalars().first()
    if not row:
        raise HTTPException(status_code=404, detail="SKU 记录不存在")

    # 删除 R2 对象（如有）
    if row.product_image_r2_key:
        try:
            delete_file_from_r2(settings, row.product_image_r2_key)
        except Exception:
            pass
    if row.product_image_thumbnail_r2_key:
        try:
            delete_file_from_r2(settings, row.product_image_thumbnail_r2_key)
        except Exception:
            pass

    # 清空 DB 字段
    row.product_image_r2_key = None
    row.product_image_r2_url = None
    row.product_image_thumbnail_r2_key = None
    row.product_image_thumbnail_r2_url = None
    row.product_image_uploaded_at = None
    row.product_image_uploaded_by = None

    append_operation_audit_log(
        db,
        action="sku_info.delete_product_image",
        target_type="sku_info",
        target_id=sku_record_id,
        operator=operator,
        after={"sku": row.sku},
        request=request,
    )
    db.commit()

    return SkuProductImageDeleteResponse(
        sku_record_id=sku_record_id,
        deleted=True,
    )
```

- [ ] **步骤 5：运行后端测试**

```bash
cd /Users/damon/DamonProjects/believeboyDashboard/backend && /Users/damon/miniconda3/bin/python3 -m pytest tests/api/test_sku_product_image.py -v 2>&1 | tail -30
```

预期：9 个测试全部 PASS。如有失败，先排查。

- [ ] **步骤 6：运行所有 sku_info 相关测试确保无回归**

```bash
cd /Users/damon/DamonProjects/believeboyDashboard/backend && /Users/damon/miniconda3/bin/python3 -m pytest tests/api/ -v -k "sku" 2>&1 | tail -20
```

预期：所有 sku 相关测试通过，无回归。

- [ ] **步骤 7：Commit**

```bash
git add backend/app/api/v1/endpoints/sku_info.py
git commit -m "feat(sku-image): 实现 POST/DELETE /sku-info/{id}/product-image 端点"
```

---

## 任务 6：前端类型定义 + Tab 集成

**文件：**
- 修改：`frontend/app/dashboard/data-management/sku-info/page.tsx`
  - `ActiveTab` 加 `'image'`
  - `ACTIVE_TAB_ORDER` 加 `'image'`
  - `ProductCostItem` 类型加 6 字段
  - 在 `cost` tab 之后渲染 `<ImageTabContent>`

- [ ] **步骤 1：加 'image' 到 ActiveTab 联合类型**

定位到第 95 行附近：

```typescript
type ActiveTab = 'cost' | 'dimension' | 'factory' | 'label'
```

改为：

```typescript
type ActiveTab = 'cost' | 'dimension' | 'factory' | 'label' | 'image'
```

定位到第 97 行：

```typescript
const ACTIVE_TAB_ORDER: ActiveTab[] = ['cost', 'dimension', 'factory', 'label']
```

改为：

```typescript
const ACTIVE_TAB_ORDER: ActiveTab[] = ['cost', 'dimension', 'factory', 'label', 'image']
```

- [ ] **步骤 2：ProductCostItem 加 6 字段**

定位到第 68-69 行：

```typescript
  fnsku_label_r2_key?: string | null
  fnsku_label_r2_url?: string | null
```

在之后追加：

```typescript
  product_image_r2_key?: string | null
  product_image_r2_url?: string | null
  product_image_thumbnail_r2_key?: string | null
  product_image_thumbnail_r2_url?: string | null
  product_image_uploaded_at?: string | null
  product_image_uploaded_by?: string | null
```

- [ ] **步骤 3：在文件顶部 import ImageTabContent**

定位到 import 区，追加（与现有 import 风格一致）：

```typescript
import { ImageTabContent } from '@/components/dashboard/sku-info/image-tab'
```

- [ ] **步骤 4：在 Tab 渲染区加 image tab**

定位到渲染 `label` tab 的位置（搜索 `case 'label'` 或类似），在它之后追加：

```tsx
{activeTab === 'image' && (
  <ImageTabContent
    projectName={selectedProject?.name ?? ''}
    skus={visibleSkus}
    loading={skusLoading}
    onRefresh={loadSkus}
  />
)}
```

> `visibleSkus` 和 `selectedProject` 变量名以实际代码为准——实施时搜索 `const visibleSkus` 或 `const.*selectedProject` 锁定名称。

- [ ] **步骤 5：Commit**

```bash
git add frontend/app/dashboard/data-management/sku-info/page.tsx
git commit -m "feat(frontend): sku-info 集成 image tab 类型与路由"
```

---

## 任务 7：实现 ImageLightbox 组件

**文件：**
- 创建：`frontend/components/dashboard/sku-info/image-lightbox.tsx`

- [ ] **步骤 1：编写 ImageLightbox 组件**

完整文件内容：

```tsx
'use client'

import { useEffect } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface ImageLightboxProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  src: string
  alt: string
  meta?: {
    sku?: string
    productName?: string | null
    uploadedAt?: string | null
    uploadedBy?: string | null
  }
}

export function ImageLightbox({
  open,
  onOpenChange,
  src,
  alt,
  meta,
}: ImageLightboxProps) {
  useEffect(() => {
    if (!open) return
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false)
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [open, onOpenChange])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85"
      onClick={() => onOpenChange(false)}
    >
      <Button
        variant="ghost"
        size="icon"
        className="absolute right-4 top-4 h-9 w-9 rounded-full bg-white/10 text-white hover:bg-white/20"
        onClick={() => onOpenChange(false)}
        aria-label="关闭"
      >
        <X className="h-5 w-5" />
      </Button>

      <div
        className="flex max-h-[90vh] max-w-[90vw] flex-col items-center gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt}
          className="max-h-[80vh] max-w-[90vw] rounded-md object-contain"
        />
        {meta && (
          <div className="rounded-md bg-black/60 px-4 py-2 text-sm text-white">
            {meta.sku && (
              <span className="font-mono font-medium">{meta.sku}</span>
            )}
            {meta.productName && (
              <span className="ml-2 text-white/80">{meta.productName}</span>
            )}
            {meta.uploadedAt && (
              <span className="ml-2 text-white/60">
                上传于 {new Date(meta.uploadedAt).toLocaleString('zh-CN')}
              </span>
            )}
            {meta.uploadedBy && (
              <span className="ml-2 text-white/60">by {meta.uploadedBy}</span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
```

- [ ] **步骤 2：Commit**

```bash
git add frontend/components/dashboard/sku-info/image-lightbox.tsx
git commit -m "feat(frontend): 实现 ImageLightbox 全屏查看组件"
```

---

## 任务 8：实现 ImageUploadSheet 组件

**文件：**
- 创建：`frontend/components/dashboard/sku-info/image-upload-sheet.tsx`

- [ ] **步骤 1：编写 ImageUploadSheet 组件**

完整文件内容：

```tsx
'use client'

import { useState } from 'react'
import { Upload } from 'lucide-react'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { UploadZone } from '@/components/ui/upload-zone'
import { useNotifications } from '@/components/notifications/notifications-context'
import type { ProductCostItem } from '@/app/dashboard/data-management/sku-info/page'

interface ImageUploadSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sku: ProductCostItem | null
  onSuccess: () => void
}

const API_BASE = '/api/backend'

export function ImageUploadSheet({
  open,
  onOpenChange,
  sku,
  onSuccess,
}: ImageUploadSheetProps) {
  const { notify } = useNotifications()
  const [uploading, setUploading] = useState(false)

  if (!sku) return null

  const handleUpload = async (file: File) => {
    setUploading(true)
    try {
      const formData = new FormData()
      formData.append('file', file)

      const response = await fetch(
        `${API_BASE}/api/v1/sku-info/${sku.id}/product-image`,
        {
          method: 'POST',
          body: formData,
        }
      )

      if (!response.ok) {
        const error = await response.json().catch(() => ({}))
        throw new Error(error.detail || `上传失败 (${response.status})`)
      }

      notify({
        variant: 'success',
        title: '上传成功',
        message: `SKU ${sku.sku} 的产品图已上传`,
      })
      onSuccess()
      onOpenChange(false)
    } catch (err) {
      notify({
        variant: 'error',
        title: '上传失败',
        message: err instanceof Error ? err.message : '未知错误',
      })
    } finally {
      setUploading(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[480px] sm:max-w-[480px]">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Upload className="h-4 w-4" />
            {sku.product_image_r2_key ? '替换产品图' : '上传产品图'}
          </SheetTitle>
          <SheetDescription>
            <span className="font-mono">{sku.sku}</span>
            {sku.product_name && <span className="ml-2">{sku.product_name}</span>}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6">
          <UploadZone
            accept="image/jpeg,image/png,image/webp,image/gif"
            maxSize={10}
            onUpload={handleUpload}
            disabled={uploading}
            uploadingText="上传中..."
            showPreview={true}
          />
          <p className="mt-3 text-xs text-muted-foreground">
            支持 JPG / PNG / WebP / GIF 格式，单文件不超过 10MB。
            系统会自动生成 1920×1920 主图和 320×320 缩略图。
          </p>
        </div>
      </SheetContent>
    </Sheet>
  )
}
```

- [ ] **步骤 2：Commit**

```bash
git add frontend/components/dashboard/sku-info/image-upload-sheet.tsx
git commit -m "feat(frontend): 实现 ImageUploadSheet 上传弹层"
```

---

## 任务 9：实现 ImageTabContent 主组件

**文件：**
- 创建：`frontend/components/dashboard/sku-info/image-tab.tsx`

- [ ] **步骤 1：编写 ImageTabContent 组件**

完整文件内容：

```tsx
'use client'

import { useState, useMemo, useCallback } from 'react'
import { ImageIcon, Pencil, Trash2, Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  DataTableCard,
  DataTableCardHeader,
  DataTableCardBody,
} from '@/components/ui/data-card'
import { useNotifications } from '@/components/notifications/notifications-context'
import { ImageUploadSheet } from './image-upload-sheet'
import { ImageLightbox } from './image-lightbox'
import type { ProductCostItem } from '@/app/dashboard/data-management/sku-info/page'

const API_BASE = '/api/backend'

interface ImageTabContentProps {
  projectName: string
  skus: ProductCostItem[]
  loading: boolean
  onRefresh: () => void
}

export function ImageTabContent({
  projectName,
  skus,
  loading,
  onRefresh,
}: ImageTabContentProps) {
  const { notify } = useNotifications()
  const [search, setSearch] = useState('')
  const [uploadSheetOpen, setUploadSheetOpen] = useState(false)
  const [editingSku, setEditingSku] = useState<ProductCostItem | null>(null)
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [lightboxSku, setLightboxSku] = useState<ProductCostItem | null>(null)

  const filteredSkus = useMemo(() => {
    if (!search) return skus
    const q = search.toLowerCase()
    return skus.filter(
      (s) =>
        s.sku.toLowerCase().includes(q) ||
        s.asin.toLowerCase().includes(q) ||
        (s.product_name && s.product_name.toLowerCase().includes(q))
    )
  }, [skus, search])

  const handleUploadClick = useCallback((sku: ProductCostItem) => {
    setEditingSku(sku)
    setUploadSheetOpen(true)
  }, [])

  const handleThumbnailClick = useCallback((sku: ProductCostItem) => {
    setLightboxSku(sku)
    setLightboxOpen(true)
  }, [])

  const handleDelete = useCallback(
    async (sku: ProductCostItem) => {
      if (!confirm(`确认删除 SKU ${sku.sku} 的产品图？此操作不可撤销。`)) {
        return
      }
      try {
        const response = await fetch(
          `${API_BASE}/api/v1/sku-info/${sku.id}/product-image`,
          { method: 'DELETE' }
        )
        if (!response.ok) {
          const error = await response.json().catch(() => ({}))
          throw new Error(error.detail || `删除失败 (${response.status})`)
        }
        notify({
          variant: 'success',
          message: `SKU ${sku.sku} 的产品图已删除`,
        })
        onRefresh()
      } catch (err) {
        notify({
          variant: 'error',
          title: '删除失败',
          message: err instanceof Error ? err.message : '未知错误',
        })
      }
    },
    [notify, onRefresh]
  )

  if (!projectName) {
    return (
      <DataTableCard>
        <DataTableCardBody>
          <div className="px-6 py-12 text-center text-sm text-muted-foreground">
            请先在顶部选择项目
          </div>
        </DataTableCardBody>
      </DataTableCard>
    )
  }

  return (
    <>
      <DataTableCard>
        <DataTableCardHeader
          title="产品图片"
          description="为项目下每个 SKU 维护一张产品主图"
          action={
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="搜索 SKU / ASIN / 品名"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-9 w-[280px] pl-9"
              />
            </div>
          }
        />
        <DataTableCardBody>
          {loading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : filteredSkus.length === 0 ? (
            <div className="px-6 py-12 text-center text-sm text-muted-foreground">
              {search ? '没有匹配的 SKU' : '该项目下没有 SKU'}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border/50 bg-[hsl(var(--surface-subtle))] text-left">
                    <th className="w-20 px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      缩略图
                    </th>
                    <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      SKU
                    </th>
                    <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      ASIN
                    </th>
                    <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      品名
                    </th>
                    <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      上传时间
                    </th>
                    <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      上传者
                    </th>
                    <th className="w-32 px-4 py-2.5 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      操作
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSkus.map((sku) => (
                    <tr
                      key={sku.id}
                      className="border-b border-border/30 transition-colors hover:bg-[hsl(var(--surface-subtle))]/50"
                    >
                      <td className="px-4 py-2">
                        {sku.product_image_thumbnail_r2_url ? (
                          <button
                            type="button"
                            onClick={() => handleThumbnailClick(sku)}
                            className="block h-12 w-12 overflow-hidden rounded border border-border/50 transition-opacity hover:opacity-80"
                            aria-label="查看大图"
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={sku.product_image_thumbnail_r2_url}
                              alt={sku.sku}
                              className="h-full w-full object-cover"
                            />
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleUploadClick(sku)}
                            className="flex h-12 w-12 items-center justify-center rounded border-2 border-dashed border-border/50 text-muted-foreground transition-colors hover:border-border hover:text-foreground"
                            aria-label="上传图片"
                          >
                            <ImageIcon className="h-4 w-4" />
                          </button>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        <span className="font-mono text-[13px] font-medium text-foreground">
                          {sku.sku}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-[13px] text-muted-foreground">
                        {sku.asin}
                      </td>
                      <td className="px-4 py-2 text-[13px] text-muted-foreground">
                        {sku.product_name || '—'}
                      </td>
                      <td className="px-4 py-2 text-[13px] text-muted-foreground">
                        {sku.product_image_uploaded_at
                          ? new Date(sku.product_image_uploaded_at).toLocaleString('zh-CN')
                          : '—'}
                      </td>
                      <td className="px-4 py-2 text-[13px] text-muted-foreground">
                        {sku.product_image_uploaded_by || '—'}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleUploadClick(sku)}
                            aria-label="上传/替换"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          {sku.product_image_r2_key && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleDelete(sku)}
                              aria-label="删除"
                              className="text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </DataTableCardBody>
      </DataTableCard>

      <ImageUploadSheet
        open={uploadSheetOpen}
        onOpenChange={setUploadSheetOpen}
        sku={editingSku}
        onSuccess={onRefresh}
      />

      <ImageLightbox
        open={lightboxOpen}
        onOpenChange={setLightboxOpen}
        src={lightboxSku?.product_image_r2_url || ''}
        alt={lightboxSku?.sku || ''}
        meta={
          lightboxSku
            ? {
                sku: lightboxSku.sku,
                productName: lightboxSku.product_name,
                uploadedAt: lightboxSku.product_image_uploaded_at,
                uploadedBy: lightboxSku.product_image_uploaded_by,
              }
            : undefined
        }
      />
    </>
  )
}
```

- [ ] **步骤 2：Commit**

```bash
git add frontend/components/dashboard/sku-info/image-tab.tsx
git commit -m "feat(frontend): 实现 ImageTabContent 主组件"
```

---

## 任务 10：前端 lint + build 验证

- [ ] **步骤 1：运行 lint**

```bash
cd /Users/damon/DamonProjects/believeboyDashboard/frontend && pnpm lint 2>&1 | tail -30
```

预期：通过，无 error。如有未使用 import / 类型问题，按报错修复。

- [ ] **步骤 2：运行 build**

```bash
cd /Users/damon/DamonProjects/believeboyDashboard/frontend && pnpm build 2>&1 | tail -30
```

预期：构建成功。如有 TypeScript 类型不匹配（如 `ProductCostItem` 字段未传），按报错修复。

- [ ] **步骤 3：手动业务测试**

启动前后端，访问 http://localhost:3000/dashboard/data-management/sku-info，按规格 §8.3 业务测试清单逐项执行：

1. 进入 SKU Info → 产品图片 tab — 显示项目下所有 SKU 表格
2. 上传 1 张有效图 — 缩略图显示在表格中
3. 点击已上传缩略图 — 全屏 Lightbox 弹出
4. Lightbox 按 Esc — 关闭
5. 上传 .txt 文件 — 提示"仅支持图片"
6. 上传 > 10MB 文件 — 提示"文件大小不能超过 10MB"
7. 替换已有图 — 旧图被覆盖（无残留 R2 对象）
8. 删除产品图 — 缩略图消失，DB 字段清空
9. 无项目权限的 SKU — 操作按钮禁用
10. 切换项目 — 表格刷新
11. 移动端查看 — 缩略图 + 滚动正常

- [ ] **步骤 4：最终 commit**

```bash
git add -A && git commit -m "feat: 完整 SKU 产品图功能 - 前端通过 lint+build 验证"
```

---

## 自检结果

**1. 规格覆盖度：**

| 规格章节 | 实现任务 |
|---|---|
| §1 背景目标 | 隐含贯穿所有任务 |
| §3.1 Alembic | 任务 1 |
| §3.2 模型 | 任务 2 |
| §3.3 Pydantic | 任务 3 |
| §4.1.1 POST 端点 | 任务 4 测试 + 任务 5 实现 |
| §4.1.2 DELETE 端点 | 任务 4 测试 + 任务 5 实现 |
| §5.1 Tab 改造 | 任务 6 |
| §5.3.1 ImageTabContent | 任务 9 |
| §5.3.2 ImageUploadSheet | 任务 8 |
| §5.3.3 ImageLightbox | 任务 7 |
| §5.4 类型定义 | 任务 6 |
| §6 错误处理 | 任务 5（后端）+ 任务 8/9（前端 notify） |
| §7 权限 | 任务 5（与 fnsku label 一致） |
| §8.1 后端测试 | 任务 4 |
| §8.3 业务测试 | 任务 10 |

无遗漏。

**2. 占位符扫描：**
- 无 TODO / 待定
- 无"添加适当的错误处理"模糊描述
- 所有测试代码完整
- 类型 / 函数 / 方法名一致：`SkuProductImageUploadResponse` / `SkuProductImageDeleteResponse` / `upload_product_image` / `delete_product_image` / `ImageTabContent` / `ImageUploadSheet` / `ImageLightbox`

**3. 类型一致性：**
- 前端 `ProductCostItem` 6 字段名 = 后端 `SkuRecordItem` 6 字段名（snake_case）
- `lightboxSku?.product_image_r2_url` 在任务 7 和 9 引用一致
- `onSuccess` 回调在 `ImageUploadSheet` 任务 8 接收、在 `ImageTabContent` 任务 9 调用 `onRefresh`，名字统一为 `onRefresh`（在 page.tsx 任务 6 传 `onRefresh={loadSkus}`）
- 路由 `/api/v1/sku-info/{id}/product-image` 在任务 5（后端）、任务 8（前端上传）、任务 9（前端删除）三处引用一致
