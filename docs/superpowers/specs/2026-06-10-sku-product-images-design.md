# SKU Info - 产品图片 Tab

**日期**：2026-06-10
**作者**：AI（brainstorming + 方案 A）
**状态**：待用户审阅

---

## 1. 背景与目标

### 1.1 现状

`SKU Info` 页面（`/dashboard/data-management/sku-info`）是 Amazon 跨境运营管理 SKU 主数据的入口。当前已有 4 个 Tab：

- `cost` - 成本信息
- `dimension` - 尺寸重量
- `factory` - 工厂属性
- `label` - FNSKU 标签（已有 `fnsku_label_r2_key/url` 字段，存储 FNSKU PDF 标签）

运营在日常工作中需要**给每个 SKU 配产品图**（用于内部分享、报表、Listing 校对等）。当前没有合适的"产品图"承载位置——FNSKU 标签是 PDF（亚马逊 FBA 贴标）而不是产品图，混用会造成语义混乱。

### 1.2 目标

在 SKU Info 页面新增 `image` Tab，承载**每 SKU 单张产品主图**：

- 支持**点击、粘贴、拖拽**三种上传方式（复用 `UploadZone` 组件）
- 表格中以**缩略图**显示已上传图片
- 缩略图**点击展开**为全屏 Lightbox
- 支持**替换**和**删除**
- 图片存储在 **Cloudflare R2**（与 FNSKU 标签、汇率备注图共用基础设施）
- 与 FNSKU 标签**并列**而非合并（语义不同：FNSKU 标签是发货场景，产品图是展示场景）

### 1.3 非目标（YAGNI）

- ❌ 每 SKU 多张图（澄清决策：单张主图）
- ❌ 批量上传（澄清决策：只单行逐个上传）
- ❌ AI 自动识别 SKU 并匹配图片
- ❌ 图片内容校验（如识别是否真的产品图）
- ❌ 跨项目批量复制图

---

## 2. 关键决策记录

来自头脑风暴澄清环节：

| 决策点 | 选定方案 | 理由 |
|---|---|---|
| 图片数量 | 每 SKU 单张主图 | 用户已选；实现最简 |
| 与 FNSKU 标签关系 | 并列（独立字段） | 语义不同，避免污染 |
| 列表布局 | 表格 + 筛选区 | 与现有 4 个 tab 风格一致 |
| 查看交互 | 点击缩略图 → 全屏 Lightbox | 体验好 |
| 删除 | 支持替换 + 删除 | 用户已选 |
| 项目权限 | 查看 + 上传均受 `X-Operator` 权限控制 | 与 label tab 对齐 |
| 批量上传 | 不支持 | 用户已选（保持简单） |

---

## 3. 数据模型

### 3.1 数据库迁移（Alembic）

新建迁移：`backend/alembic/versions/20260610_159_add_sku_record_product_image.py`

- `revision = "159"`
- `down_revision = "158"`（最新已合并的 short ID；实施前先跑 `cd backend && /Users/damon/miniconda3/bin/python3 -m alembic heads` 确认无未合并分支；如有变化，使用实际 head 作为 down_revision）
- **重要**：`SkuRecord` 类的 `__tablename__` 是 `"product_costs"`（历史命名），迁移和所有 DDL 都用表名 `product_costs`

为 `product_costs` 表（SKU 记录实际物理表）添加 6 个可空列（与 `fnsku_label_*` 字段完全对称）：

```python
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
```

`downgrade()` 移除上述 6 列。

### 3.2 SQLAlchemy 模型更新

`backend/app/models/sku_info.py` 在 `SkuRecord` 类加 6 个 mapped_column（与 `fnsku_label_*` 对齐）：

> **注意**：`SkuRecord.__tablename__ == "product_costs"`（历史命名）。所有 DDL 用表名 `product_costs`，Python 类名仍用 `SkuRecord`。

```python
product_image_r2_key: Mapped[str | None] = mapped_column(String(512), nullable=True)
product_image_r2_url: Mapped[str | None] = mapped_column(String(1024), nullable=True)
product_image_thumbnail_r2_key: Mapped[str | None] = mapped_column(String(512), nullable=True)
product_image_thumbnail_r2_url: Mapped[str | None] = mapped_column(String(1024), nullable=True)
product_image_uploaded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
product_image_uploaded_by: Mapped[str | None] = mapped_column(String(128), nullable=True)
```

### 3.3 Pydantic Schema 更新

`backend/app/schemas/sku_info.py`：

- `SkuRecordItem` 新增 6 字段（与上面模型对齐），均为 `Optional`
- 新增 `SkuProductImageUploadResponse` 包含：`sku_record_id`、`r2_key`、`r2_url`、`thumbnail_r2_key`、`thumbnail_r2_url`、`uploaded_at`
- `SkuRecordItem` 不需要新增 PATCH 端点——产品图通过专用端点上传，不混入通用 update 流程

### 3.4 不新增表

- **不**新建 `sku_record_images` 子表（与"每 SKU 单张主图"决策一致）
- 后续如需多张图，扩展为子表时，本设计 API 兼容（路由路径可保持不变）

---

## 4. 后端设计

### 4.1 新增端点（在 `backend/app/api/v1/endpoints/sku_info.py`）

> 路由前缀与现有 FNSKU 标签端点保持一致：`/sku-info/{sku_record_id}/...`（非 `/sku-records/{...}`）

#### 4.1.1 `POST /api/v1/sku-info/{sku_record_id}/product-image`

**用途**：上传 / 替换指定 SKU 的产品图。

**流程**（参考 `exchange_rates.py:upload_exchange_rate_image`）：

1. 读取文件 → 校验 `content_type` ∈ `{'image/jpeg','image/png','image/webp','image/gif'}` → 校验 ≤ 10MB
2. `PIL.Image.open(BytesIO(payload))` + `exif_transpose` + 转 RGB
3. `image.thumbnail((1920, 1920))` 生成主图；`ImageOps.fit(...,(320,320))` 生成缩略图
4. 两图分别保存为 WebP 质量 82/72
5. 用 `ArtifactService.upload(...)` 上传到 R2，路径：`sku_records/{sku_record_id}/product/{image_id}.webp` + `.../thumbs/{image_id}_thumb.webp`
6. **如有旧图**：先 `ArtifactService.delete(old_key)` + `delete(old_thumb_key)`，再写新值
7. 更新 `product_costs` 表对应行（即 `SkuRecord`）：
   - `product_image_r2_key`, `product_image_r2_url`, `product_image_thumbnail_r2_key`, `product_image_thumbnail_r2_url`
   - `product_image_uploaded_at = now()`
   - `product_image_uploaded_by = X-Operator` header
8. 调用 `append_operation_audit_log(action="sku_info.upload_product_image", ...)` 记录审计日志（与现有 `update_sku_record` 端点保持一致风格）
9. 返回 `SkuProductImageUploadResponse`

**权限**：
- 路由级 `Depends(protected)`（APIRouter 已在 line 66 `dependencies=[Depends(protected)]` 注册）
- 业务级：与 `upload_fnsku_label` 一致——只查 SKU 记录存在性，不做后端项目级权限检查（事实模式）

**错误**：
- `404` - SKU 不存在
- `403` - 无项目权限
- `400` - 文件类型 / 大小 / 内容不支持
- `503` - R2 未配置（`settings.r2_enabled` 为 False）

#### 4.1.2 `DELETE /api/v1/sku-info/{sku_record_id}/product-image`

**用途**：删除指定 SKU 的产品图。

**流程**：
1. 校验 SKU 存在 + 操作人有权
2. 读出当前 `product_image_r2_key` / `product_image_thumbnail_r2_key`
3. 若有 key，调用 `ArtifactService.delete(key)` 与 `delete(thumb_key)`
4. DB UPDATE：清空 6 个产品图相关字段
5. 调用 `append_operation_audit_log(action="sku_info.delete_product_image", ...)` 记录审计日志
6. 返回 `{"deleted": true, "sku_record_id": ...}`

**权限**：同 4.1.1，与 `delete_fnsku_label` 风格一致。

**错误**：同上。

### 4.2 列表接口扩展

`GET /api/v1/sku-records` 已经在 `SkuRecordItem` schema 上加 6 字段，前端无需新接口即可在 `image` tab 直接使用。

### 4.3 服务层封装（可选）

为避免重复，**不新建独立 service 文件**——直接在 `sku_info.py` endpoint 中调用 `ArtifactService.upload / delete`。理由：

- 复用度高：`ArtifactService` 已是跨页面共享的 R2 抽象
- 新代码量小：上传 / 删除路径各 ~20 行 endpoint 代码
- 避免引入新 service 层带来的间接性

如后续出现第二种业务对象使用相同图片处理（缩放 1920/320 + WebP），再抽 `image_processing_service.py`。

---

## 5. 前端设计

### 5.1 Tab 改造

`frontend/app/dashboard/data-management/sku-info/page.tsx`：

```typescript
type ActiveTab = 'cost' | 'dimension' | 'factory' | 'label' | 'image'
const ACTIVE_TAB_ORDER: ActiveTab[] = ['cost', 'dimension', 'factory', 'label', 'image']
```

Tab 标题：`{ id: 'image', label: '产品图片' }`

### 5.2 `image` Tab 内容结构

```
<ImageTabContent>
  ├── 顶部筛选条（项目选择器 + 状态 + SKU 搜索）  // 复用现成 FilterBar
  ├── 主表格
  │   ├── 列：缩略图(64x64) | SKU | ASIN | 品名 | 上传时间 | 上传者 | 操作
  │   ├── 缩略图可点击 → 全屏 Lightbox
  │   ├── 操作列：[上传/替换] [删除]
  │   └── 无图：占位框（Upload icon + "点击上传"）
  ├── 单行上传流程：操作列点击[上传] → 弹出 Sheet → 内嵌 UploadZone
  └── 通用 DataTableCard 包壳
```

### 5.3 新建组件

#### 5.3.1 `frontend/components/dashboard/sku-info/image-tab.tsx`

- 接收 props：`projectName, skus, loading, onUpload, onDelete, onRefresh`
- 内部用 TanStack Table v8（与现有 tab 风格一致）
- 缩略图列使用 `next/image` 关闭优化（`unoptimized`）+ `<img>` 也可——为兼容性用 `<img>`
- Lightbox：参考 `frontend/components/ui/dialog.tsx`（项目已有）实现全屏 Dialog

#### 5.3.2 `frontend/components/dashboard/sku-info/image-upload-sheet.tsx`

- `Sheet` + 内嵌 `UploadZone`（`accept="image/*"`, `maxSize=10`）
- `onUpload` 流程：
  1. 调用后端 `POST /sku-records/{id}/product-image`
  2. 成功后 `onRefresh()` 重拉列表
  3. 关闭 Sheet

#### 5.3.3 `frontend/components/dashboard/sku-info/image-lightbox.tsx`

- 全屏 Dialog（`fixed inset-0 z-50 bg-black/85`）
- 中央图片 + 右上角 X 关闭
- 键盘 `Esc` 关闭
- 显示元数据：SKU、品名、上传时间、上传者

### 5.4 类型定义

在 `frontend/app/dashboard/data-management/sku-info/page.tsx` 的 `ProductCostItem` 类型加 6 个可选字段（与后端 schema 对齐）：

```typescript
product_image_r2_key?: string | null
product_image_r2_url?: string | null
product_image_thumbnail_r2_key?: string | null
product_image_thumbnail_r2_url?: string | null
product_image_uploaded_at?: string | null
product_image_uploaded_by?: string | null
```

### 5.5 复用现有抽象

- `UploadZone` - `frontend/components/ui/upload-zone.tsx`（已存在，3 状态）
- `DataTableCard` / `DataTableCardHeader` - `frontend/components/ui/data-card.tsx`（表格卡片壳）
- `Sheet` - `frontend/components/ui/sheet.tsx`（弹层）
- `Dialog` - `frontend/components/ui/dialog.tsx`（全屏 Lightbox）
- `Button` / `Badge` / `Skeleton` - `frontend/components/ui/*`
- 现有 `FilterBar` 模式 - 复用 `cost` tab 的筛选区

### 5.6 状态管理

- 复用现有 `useState` 模式（与 `cost` tab 一致），**不引入** SWR / React Query
- 列表数据通过 `useEffect` 拉取（项目既定范式）
- 上传 / 删除后调用现有的 `loadSkus()` 重拉

---

## 6. 错误处理

### 6.1 后端

| 场景 | HTTP | 错误消息（中文） |
|---|---|---|
| SKU 不存在 | 404 | "SKU 记录不存在" |
| 无项目权限 | 403 | "无权操作此项目的 SKU" |
| R2 未配置 | 503 | "Cloud storage is not configured. Please contact administrator." |
| 文件类型不支持 | 400 | "仅支持 JPG / PNG / WebP / GIF 图片" |
| 文件超 10MB | 400 | "文件大小不能超过 10MB" |
| 文件内容损坏 | 400 | "图片内容无法识别" |
| R2 删除失败 | 200（部分降级） | 返回成功但记录 warning 日志 |

### 6.2 前端

| 场景 | 反馈 |
|---|---|
| 上传中网络中断 | `notify({variant:'error', title:'上传失败', message:err.message})` |
| 删除确认 | `confirm()` 对话框，文本 "确认删除该 SKU 的产品图？此操作不可撤销" |
| 删除成功 | `notify({variant:'success', message:'产品图已删除'})` |
| 列表加载失败 | DataTableCard 内显示错误占位 + 重试按钮 |
| 缩略图 404 | 静默回退到占位框（`onerror` handler） |

---

## 7. 权限模型

- 路由 `require_api_key` - 强制（APIRouter 级别 `Depends(protected)`）
- 业务权限：**与现有 FNSKU 标签上传端点保持一致**——后端不显式做项目级权限校验（仅校验 SKU 记录存在），依赖 `X-Operator` 头 + 前端项目级访问控制。
  - 这是事实模式：现有 `upload_fnsku_label`（sku_info.py:771-863）和 `update_sku_record`（sku_info.py:288-316）都未做后端项目级权限检查
  - 审计日志 `append_operation_audit_log` 记录 `operator` 用于事后追责
- 管理员可上传 / 删除所有 SKU；普通运营只能操作其被授权的项目（前端控制显示）
- 与现有 `label` tab 的 FNSKU 标签上传权限完全对称

---

## 8. 测试策略

### 8.1 单元 / 集成测试（后端）

`backend/tests/api/test_sku_product_image.py` 新文件，测试：

1. `POST /sku-records/{id}/product-image`：
   - 上传 1x1 PNG → 200，验证响应字段 + DB 字段被写入
   - 上传 11MB 文件 → 400
   - 上传 .txt → 400
   - 上传损坏 PNG → 400
   - 不存在的 sku_record_id → 404
   - 替换已有图 → 旧 R2 对象被删除 + DB 更新
   - 无项目权限 → 403
2. `DELETE /sku-records/{id}/product-image`：
   - 有图时 → R2 主图 + 缩略图都删除 + DB 字段清空
   - 无图时 → 200 idempotent（DB 字段本就为 null）
   - 无项目权限 → 403

### 8.2 前端

- **不引入**单测框架（按项目规则）
- 通过 `pnpm lint` + `pnpm build` + 业务测试清单三层验证

### 8.3 手动业务测试清单

| 测试项 | 期望 |
|---|---|
| 进入 SKU Info → 产品图片 tab | 显示项目下所有 SKU 表格 |
| 上传 1 张有效图 | 缩略图显示在表格中 |
| 点击已上传缩略图 | 全屏 Lightbox 弹出，显示原图 |
| Lightbox 按 Esc | 关闭 |
| 上传 .txt 文件 | 提示"仅支持图片" |
| 上传 > 10MB 文件 | 提示"文件大小不能超过 10MB" |
| 替换已有图 | 旧图被覆盖（无残留 R2 对象） |
| 删除产品图 | 缩略图消失，DB 字段清空 |
| 无项目权限的 SKU | 行不显示 / 操作按钮禁用 |
| 切换项目 | 表格刷新，显示该项目下 SKU |
| 移动端查看 | 缩略图 + 滚动正常 |

---

## 9. 实施范围

### 9.1 新增 / 修改文件清单

**新增**：
- `backend/alembic/versions/20260610_159_add_sku_record_product_image.py`
- `backend/tests/api/test_sku_product_image.py`
- `frontend/components/dashboard/sku-info/image-tab.tsx`
- `frontend/components/dashboard/sku-info/image-upload-sheet.tsx`
- `frontend/components/dashboard/sku-info/image-lightbox.tsx`

**修改**：
- `backend/app/models/sku_info.py` - SkuRecord 加 6 列
- `backend/app/schemas/sku_info.py` - SkuRecordItem 加 6 字段 + 新 SkuProductImageUploadResponse
- `backend/app/api/v1/endpoints/sku_info.py` - 新增 2 个端点
- `frontend/app/dashboard/data-management/sku-info/page.tsx` - ActiveTab 加 'image' + ProductCostItem 类型加 6 字段 + 渲染 ImageTabContent

### 9.2 实施顺序

1. 数据库迁移 + 模型
2. 后端 Pydantic schema + 端点 + 测试
3. 前端：类型定义 + UploadZone 集成 + 表格 + Lightbox
4. lint + build + 业务测试

---

## 10. 风险与缓解

| 风险 | 缓解 |
|---|---|
| R2 上传失败但 DB 已更新 | 上传成功后才写 DB；删除时 R2 失败也允许 DB 清空 + warning 日志 |
| 旧 R2 对象在替换时残留 | 端点逻辑中先 `ArtifactService.delete(old_key)` 失败时也继续走 |
| 缩略图 404（用户清空 R2 桶） | 前端 `<img onerror>` 回退到占位 |
| 大量旧 SKU 没有产品图 | 列表正常显示，缩略图列显示占位符 |
| Alembic 序号冲突 | 实施前运行 `alembic heads` 确认下个 short ID |

---

## 11. 后续可能演进（不实现）

- 多张图：扩展为 `sku_record_images` 子表，主图 = `is_primary=true`
- 批量上传：项目维度拖拽多文件，弹 SKU 匹配对话框
- AI 选主图：根据清晰度 / 构图自动选 is_primary
- 内容校验：调用 vision 模型判断是否产品图
- 跨项目模板：从一个项目复制产品图到另一个项目

---

## 12. 自检

- [x] 占位符扫描：无 TODO / 模糊字段
- [x] 内部一致性：模型、schema、端点、类型、组件全部对齐 6 字段
- [x] 范围检查：单 tab + 单行上传，单一可实现计划覆盖
- [x] 模糊性检查：
  - "主图"和"缩略图"是否两个 R2 对象？——是（参考汇率页面实现）
  - 替换时旧图是否删除？——是（先 delete old，再 upload new）
  - 删除时是否弹 confirm？——是（前端 Sheet 内 confirm 对话框）
  - 移动端如何？——表格支持横向滚动，缩略图列自适应
