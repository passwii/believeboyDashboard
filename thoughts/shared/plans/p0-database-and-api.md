# P0 计划：基础设施（数据库迁移 + API）

> 目标：完成数据层和接口层建设，为前端配置页面和 AI 集成提供基础能力

---

## 步骤概览

```
P0
├── 0.1 数据库迁移文件
├── 0.2 Model 层更新
├── 0.3 Schema 层更新
├── 0.4 Service 层更新
├── 0.5 API 端点实现
├── 0.6 列表接口更新
└── 0.7 缓存失效逻辑
```

---

## 0.1 数据库迁移文件

**目标**：在 `projects` 表新增 `project_context` 和 `sku_context` 两个 JSONB 字段

**文件**：`backend/alembic/versions/`

**迁移文件命名**：`add_project_context_fields.py`

**迁移内容**：

```python
"""add_project_context_fields

Revision ID: xxxxxx
Revises: xxxxxx  # 填入当前最新版本号
Create Date: 2026-05-13

"""
from alembic import op
import sqlalchemy as sa

# revision identifiers
revision = 'xxxxxx'
down_revision = 'xxxxxx'  # 当前最新版本
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        'projects',
        sa.Column('project_context', sa.JSONB, nullable=False, server_default='{}')
    )
    op.add_column(
        'projects',
        sa.Column('sku_context', sa.JSONB, nullable=False, server_default='{}')
    )
    # 可选：添加 GIN 索引（如果后续需要按内容查询）
    # op.execute("CREATE INDEX idx_projects_project_context ON projects USING GIN (project_context)")


def downgrade() -> None:
    op.drop_column('projects', 'sku_context')
    op.drop_column('projects', 'project_context')
```

**验证方式**：
```bash
cd backend && alembic upgrade head
# 检查 projects 表结构：
# SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'projects';
```

---

## 0.2 Model 层更新

**目标**：`Project` ORM 模型新增两个 JSONB 属性

**文件**：`backend/app/models/project.py`

**改动**：

```python
# 新增导入
from sqlalchemy import JSON
from sqlalchemy.dialects.postgresql import JSONB

# Project 类中新增字段
class Project(Base):
    # ... 现有字段 ...
    
    # 新增
    project_context: Mapped[dict | None] = mapped_column(
        JSONB.with_variant(JSON, "sqlite"),
        nullable=True,
        default=dict,
        server_default="{}",
    )
    sku_context: Mapped[dict | None] = mapped_column(
        JSONB.with_variant(JSON, "sqlite"),
        nullable=True,
        default=dict,
        server_default="{}",
    )
```

**验证方式**：
```bash
cd backend && python -c "from app.models import Project; print('Model OK')"
```

---

## 0.3 Schema 层更新

**目标**：新增 Pydantic Schema，用于 API 请求/响应

**文件**：`backend/app/schemas/project.py`

**新增 Schema**：

```python
# 1. Factory 维度
class FactoryContext(BaseModel):
    description: str | None = None
    productionCapacity: str | None = None
    communication: str | None = None

# 2. 淡旺季维度
class ProductSeasonalityContext(BaseModel):
    peakSeason: str | None = None
    offSeason: str | None = None
    restockStrategy: str | None = None

# 3. 产品增长维度
class ProductGrowthContext(BaseModel):
    description: str | None = None
    growthDriver: str | None = None

# 4. 项目状态维度
class ProjectStatusContext(BaseModel):
    description: str | None = None
    riskNotes: str | None = None

# 5. Project Context 主结构
class ProjectContext(BaseModel):
    factory: FactoryContext | None = None
    productSeasonality: ProductSeasonalityContext | None = None
    productGrowth: ProductGrowthContext | None = None
    projectStatus: ProjectStatusContext | None = None
    # 自由备注
    notes: str | None = None

# 6. SKU Context 单条
class SkuStatusItem(BaseModel):
    status: str | None = None
    reason: str | None = None
    action: str | None = None
    startDate: str | None = None
    endDate: str | None = None

# 7. SKU Context 主结构
class SkuContext(BaseModel):
    """Key 是 SKU，Value 是 SkuStatusItem"""
    model_config = {"extra": "allow"}  # 允许动态 Key

# 8. API 响应
class ProjectContextResponse(BaseModel):
    project_id: int
    project_name: str
    project_context: dict[str, Any] | None = None
    sku_context: dict[str, Any] | None = None

# 9. API 请求（部分更新，JSON Merge Patch 语义）
class ProjectContextUpdate(BaseModel):
    project_context: dict[str, Any] | None = None
    sku_context: dict[str, Any] | None = None
```

**验证方式**：
```bash
cd backend && python -c "from app.schemas.project import ProjectContextResponse, ProjectContextUpdate; print('Schema OK')"
```

---

## 0.4 Service 层更新

**目标**：在 `project_service.py` 中新增两个函数

**文件**：`backend/app/services/project_service.py`

**新增函数**：

```python
def get_project_context(db: Session, project_id: int) -> tuple[dict | None, dict | None]:
    """获取项目的背景配置"""
    row = db.execute(select(Project).where(Project.id == project_id)).scalars().first()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    return row.project_context, row.sku_context


def update_project_context(
    db: Session,
    project_id: int,
    project_context: dict | None = None,
    sku_context: dict | None = None,
    operator: str | None = None,
) -> Project:
    """更新项目的背景配置（JSON Merge Patch 语义）"""
    row = db.execute(select(Project).where(Project.id == project_id)).scalars().first()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")

    if project_context is not None:
        existing = row.project_context or {}
        existing.update(project_context)
        row.project_context = existing

    if sku_context is not None:
        existing = row.sku_context or {}
        existing.update(sku_context)
        row.sku_context = existing

    db.flush()
    db.refresh(row)
    invalidate_projects_cache()
    return row
```

**验证方式**：
```bash
cd backend && python -c "from app.services.project_service import get_project_context, update_project_context; print('Service OK')"
```

---

## 0.5 API 端点实现

**目标**：在 `projects.py` 中新增两个 API 端点

**文件**：`backend/app/api/v1/endpoints/projects.py`

**新增端点**：

```python
@router.get("/projects/{project_id}/context", response_model=ProjectContextResponse)
def get_project_context_endpoint(
    project_id: int,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
) -> ProjectContextResponse:
    """获取项目的背景配置"""
    project_service.ensure_project_access(db, project_id, operator=operator, is_admin=bool(is_admin))
    project_context, sku_context = project_service.get_project_context(db, project_id)
    row = db.get(Project, project_id)
    append_operation_view_log(...)
    db.commit()
    return ProjectContextResponse(
        project_id=project_id,
        project_name=row.project_name,
        project_context=project_context or {},
        sku_context=sku_context or {},
    )


@router.patch("/projects/{project_id}/context", response_model=ProjectContextResponse)
def update_project_context_endpoint(
    project_id: int,
    payload: ProjectContextUpdate,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
) -> ProjectContextResponse:
    """更新项目的背景配置"""
    before_project_context, before_sku_context = project_service.get_project_context(db, project_id)
    before = {"project_context": before_project_context, "sku_context": before_sku_context}
    
    row = project_service.update_project_context(
        db,
        project_id,
        project_context=payload.project_context,
        sku_context=payload.sku_context,
        operator=operator,
    )
    
    append_operation_audit_log(
        db,
        action='projects.context.update',
        target_type='project_context',
        target_id=project_id,
        operator=operator,
        before=before,
        after={"project_context": row.project_context, "sku_context": row.sku_context},
        request=request,
    )
    db.commit()
    
    return ProjectContextResponse(
        project_id=project_id,
        project_name=row.project_name,
        project_context=row.project_context or {},
        sku_context=row.sku_context or {},
    )
```

**验证方式**：
```bash
# 启动服务后测试
curl -X GET "http://127.0.0.1:8000/api/v1/projects/1/context" \
  -H "X-API-Key: YOUR_API_KEY"
# 预期：返回当前项目的 context（空对象或已有数据）
```

---

## 0.6 列表接口更新

**目标**：`/projects/manage` 接口返回 `has_context` 标识

**文件**：
- `backend/app/schemas/project.py` → `ProjectItem` 新增 `has_context: bool`
- `backend/app/api/v1/endpoints/projects.py` → `_serialize_project_item()` 和 `list_projects_manage()` 更新

**改动**：

```python
# schemas/project.py - ProjectItem 新增字段
class ProjectItem(BaseModel):
    # ... 现有字段 ...
    has_context: bool = False  # 新增

# endpoints/projects.py - _serialize_project_item()
def _serialize_project_item(row) -> dict[str, object | None]:
    return {
        # ... 现有字段 ...
        'has_context': bool(row.project_context or row.sku_context),  # 新增
    }

# endpoints/projects.py - 列表中 ProjectItem 构建也需更新
ProjectItem(
    # ... 现有字段 ...
    has_context=bool(row.project_context or row.sku_context),
)
```

**验证方式**：
```bash
curl "http://127.0.0.1:8000/api/v1/projects/manage" \
  -H "X-API-Key: YOUR_API_KEY" | jq '.[0].has_context'
```

---

## 0.7 缓存失效逻辑

**目标**：确保更新 context 时正确失效 projects 相关缓存

**文件**：`backend/app/services/project_service.py`

**检查项**：

1. 确认 `invalidate_projects_cache()` 函数已存在
2. 在 `update_project_context()` 中调用 `invalidate_projects_cache()`

**验证方式**：
- 手动测试：更新项目 context 后，列表接口返回的 `has_context` 应即时更新

---

## 验证测试用例

完成 P0 后，按以下顺序验证：

### 1. 数据库迁移
```bash
cd backend && alembic upgrade head
# 确认字段存在
psql $DATABASE_URL -c "\d projects" | grep context
```

### 2. Model 层
```bash
python -c "from app.models import Project; p = Project(project_name='test', project_context={'factory': {'description': 'test'}}); print('OK')"
```

### 3. API 端点

```bash
# 测试 GET
curl -s "http://127.0.0.1:8000/api/v1/projects/1/context" -H "X-API-Key: xxx" | jq .

# 测试 PATCH
curl -s -X PATCH "http://127.0.0.1:8000/api/v1/projects/1/context" \
  -H "X-API-Key: xxx" \
  -H "Content-Type: application/json" \
  -d '{"project_context": {"factory": {"description": "测试工厂"}}}' | jq .

# 测试列表 has_context
curl -s "http://127.0.0.1:8000/api/v1/projects/manage" -H "X-API-Key: xxx" | jq '.[0] | {name, has_context}'
```

---

## 预计产出

完成 P0 后，以下能力已就绪：

| 能力 | 说明 |
|------|------|
| 数据库字段 | `projects.project_context` 和 `projects.sku_context` |
| Model 映射 | ORM 可读写 JSON 字段 |
| GET 接口 | `GET /api/v1/projects/{id}/context` |
| PATCH 接口 | `PATCH /api/v1/projects/{id}/context` |
| 列表标识 | `/api/v1/projects/manage` 返回 `has_context` |
| 缓存失效 | 更新 context 后列表缓存自动失效 |