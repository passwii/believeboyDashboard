# 项目启动台 P2 设计稿：管理员自定义流程模板与节点 + 节点附件（内务回传，复用 R2）

- Issue：BLF-1237（承接 BLF-1234 / P1 已上线）
- 日期：2026-10-05
- 状态：**待 Yawei 确认**（确认后才进入实现）
- 相关代码：`backend/app/models/project_workflow.py`、`backend/app/services/project_workflow_service.py`、
  `backend/app/services/project_workflow_templates.py`、`backend/app/api/v1/endpoints/project_workflows.py`、
  `backend/app/services/artifact_service.py`、`backend/app/services/r2_service.py`、
  `backend/app/services/upload_service.py`、`frontend/lib/project-workflows-api.ts`
- 前置设计稿：`docs/superpowers/specs/2026-10-05-project-launch-dashboard-design.md`（P1）

## 1. 背景与目标

P1 把「店铺启动 + 产品开发」的流程进度做成了持久化页面，但**模板是后端硬编码常量**
（`store-launch-v1` / `product-womens-swimwear-v1`），节点文案、顺序、附件都改不了，
新增品类或调整节点必须改代码发版。

Yawei 提出的 P2 目标：**每个节点可自定义内容，所有节点汇总成项目整体**；节点附件复用现有 R2 上传流程。
经确认的两条口径（已定，不再讨论）：

1. **自定义仅管理员维护**——不做项目负责人自改模板；沿用现有 `X-Is-Admin` / 管理员判定口径。
2. **附件只服务内务回传**——节点附件是内部上传/留档用途，不做「发给合作方」语义，
   因此**不需要**「发送资料 vs 回传文件」两套语义，节点附件是单一用途的多文件集合。

P2 交付三件事：

- **模板层持久化**：模板与节点成为 DB 数据，管理员可增删改排序、可复制模板；不再依赖代码常量。
- **项目层可维护**：创建流程时从模板复制节点（沿用 P1 快照语义），项目内节点可增删改排序；
  模板后续修改**不回写**已有项目。
- **节点附件**：复用 R2 基础设施，一个节点挂多个附件（对象 key、原文件名、MIME、大小、上传者、上传时间），
  上传/列出/下载/删除全部走鉴权 + 项目权限校验。

## 2. 范围与非目标

**范围内**

- 模板 CRUD（仅管理员）：模板增删改、节点增删改排序、模板复制。
- 项目层节点：创建流程时从模板快照复制；项目内节点增删改排序。
- 节点附件：模板节点附件 + 项目节点附件的上传/列出/下载/删除（R2）。
- 迁移：4 张新表 + P1 两份模板的种子数据；P1 数据与接口契约零破坏。

**非目标（明确不做）**

- 不做对外发送（邮件/飞书）、不做审批流、不做文件版本历史、不做项目负责人自改模板。
- 不做附件在线预览、图片缩略图、批量打包下载、附件级独立权限（附件权限 = 项目权限）。
- 不把 P1 的两份内置文档从 `backend/app/resources/` 搬进 R2（见 §3.3 迁移策略）。
- 不改动 P1 已上线的 6 个接口的**请求/响应形状**与既有错误语义。

## 3. 与 P1 的关系、兼容策略

### 3.1 P1 的 6 个接口：形状不变

| P1 接口 | P2 处理 |
| --- | --- |
| `GET /project-workflows/templates` | **形状不变**（`{templates:[{key,kind,title}]}`）；数据源从常量改为 DB 查询 |
| `GET /project-workflows/summary` | 不变（仍一次批量查询；不新增附件字段，避免拖慢列表） |
| `GET /projects/{id}/workflows` | 形状为**超集**：任务对象新增 `attachments: []` 字段（附加字段，旧前端忽略即兼容） |
| `POST /projects/{id}/workflows` | 不变（`{kind,template_key,title?}`；模板改为从 DB 读，校验语义不变） |
| `PATCH /project-workflow-tasks/{task_id}` | **严格保持只接受 `{status}`**，非管理员 + 有项目权限仍可用（P1 行为一字不改） |
| `GET /projects/{id}/workflows/documents/{document_key}` | 不变（白名单两键继续从 `backend/app/resources/` 流式返回） |

> 关键取舍：项目节点的「改标题/改说明/排序/删除」**不塞进** P1 的 `PATCH /project-workflow-tasks/{task_id}`，
> 而是新增管理员专用端点（§7.3）。理由是 P1 该端点的语义是「改进度状态，非管理员可用」，
> 若在同一路径上按请求体字段分流权限，会让「非管理员改标题必须 403」变成隐性契约，容易漏判。
> 新增端点 = 零回归风险。

### 3.2 P1 数据：零迁移、零改写

- `project_workflows` / `project_workflow_tasks` **不新增必填列、不改列名、不改约束**。
- 已创建项目的节点标题/描述/顺序/状态/`attachment_key` 原样保留，页面表现与 P1 完全一致。
- 已创建项目的 `template_key` 只作溯源，模板被改/被删都不影响它们（快照语义）。

### 3.3 `attachment_key`（P1 固定文档）迁移策略 —— 决策：**保留 + 兼容读，不迁到附件表**

- `project_workflow_tasks.attachment_key` 继续存在，值仍是白名单键
  （`amazon_registration_form` / `worldfirst_registration_guide`），继续由 P1 的文档下载端点服务。
- 模板节点同样保留 `attachment_key` 列，管理员可在模板编辑器里从**两个白名单键**中选择或清空
  （即：固定文档仍由代码侧白名单控制，不由管理员上传任意文件顶替）。
- **不把两份内置文档迁进附件表**，原因：这两份文件当前在
  `backend/app/resources/project_launch_documents/`，不在 R2。迁到附件表需要在迁移/部署时把它们上传到 R2，
  属于「迁移里做外部副作用」，失败会让 upgrade 半途而废，且回滚要额外删对象。
  收益（管理员可替换原件）可以用更轻的方式达到：**管理员把新版文件作为模板节点附件上传**即可（§8）。
- 兼容读路径长期保留；若后续确需收敛为单一模型，另开 issue 做「内置文档 → R2 附件」的一次性脚本迁移。
- 前端表现：**共存，不替换**。节点行上「固定资料」下载按钮（`attachment_key`）与「附件」列表（R2 上传件）
  同时存在，两个入口视觉上分组呈现（§9）。

## 4. 领域模型

新增 4 张表；`project_workflow_tasks` 复用 P1 表（不加列）。

### 4.1 `workflow_templates`（模板）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | Integer PK | |
| `key` | String(80), **unique** | 稳定键；`project_workflows.template_key` 以字符串引用它；**创建后不可改**（改键会断溯源） |
| `kind` | String(32) | `store_launch` / `product_development`，Check 约束 |
| `title` | String(160) | 展示名 |
| `description` | Text, nullable | 模板说明（可选） |
| `sort_order` | Integer, not null, default 0 | 模板目录顺序 |
| `created_at` / `updated_at` | DateTime(tz) | |

索引：`ix_workflow_templates_kind_sort(kind, sort_order)`；`uq_workflow_templates_key(key)`（唯一）。

> 不引入 P1 常量里的 `version` 字段：它从未出现在 API 契约里，且模板可编辑后「版本号」没有可靠语义
> （改一次算不算新版本？），保留只会产生无意义状态。版本语义由 `key` 后缀（`-v1`）+ 复制功能承载。

### 4.2 `workflow_template_tasks`（模板节点）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | Integer PK | |
| `template_id` | FK → `workflow_templates.id`，`ON DELETE CASCADE` | |
| `title` | String(160), not null | |
| `description` | Text, nullable | |
| `sort_order` | Integer, not null | 稳定顺序 |
| `attachment_key` | String(64), nullable | P1 兼容：固定白名单文档键 |
| `created_at` / `updated_at` | DateTime(tz) | |

索引：`ix_workflow_template_tasks_template_sort(template_id, sort_order)`。

> 排序**不加** `UNIQUE(template_id, sort_order)`：拖拽排序需要在一次事务里整体重写序号，
> 唯一约束会让中间态互相冲突。序号唯一性由服务层在写事务内保证（重写为 `0..n-1`）。

### 4.3 `workflow_template_task_attachments`（模板节点附件）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | Integer PK | |
| `template_task_id` | FK → `workflow_template_tasks.id`，`ON DELETE CASCADE` | |
| `r2_key` | String(512), not null | R2 对象 key（受控，由服务端生成） |
| `filename` | String(256), not null | 原始文件名（下载时回显，不参与路径拼接） |
| `content_type` | String(128), not null | 上传时记录的 MIME |
| `file_size` | Integer, not null | 字节数 |
| `uploader` | String(64), nullable | 操作者名（`X-Operator`） |
| `created_at` | DateTime(tz) | |

索引：`ix_workflow_template_task_attachments_task(template_task_id)`。

### 4.4 `project_workflow_task_attachments`（项目节点附件）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | Integer PK | |
| `task_id` | FK → `project_workflow_tasks.id`，`ON DELETE CASCADE` | |
| `r2_key` | String(512), not null | 受控 R2 key |
| `filename` | String(256), not null | 原始文件名 |
| `content_type` | String(128), not null | |
| `file_size` | Integer, not null | |
| `uploader` | String(64), nullable | 上传者 |
| `origin` | String(16), not null, default `'upload'` | `upload`（项目内上传）/ `template`（由模板附件复制而来），Check 约束 |
| `created_at` | DateTime(tz) | |

索引：`ix_project_workflow_task_attachments_task(task_id)`。

> **不做多态 owner（`owner_kind`+`owner_id`）**：会失去外键级联，删节点时留孤儿行。
> 两张表各自的 FK 级联更安全；模板→项目的复制在服务层显式完成。
> `origin` 只用于 UI 标注来源（「模板附件」徽标）与审计，**不参与 R2 归属判断**（归属见 §8.4）。

### 4.5 R2 key 列注册（必须）

两张附件表的列名是 `r2_key`（不以 `_r2_key` 结尾），不会被 `ArtifactService.discover_r2_key_columns()`
自动发现。必须加入 `ArtifactService._IRREGULAR_KEY_COLUMNS`：

```python
_IRREGULAR_KEY_COLUMNS: list[tuple[str, str]] = [
    ("InspectionScreenshot", "r2_key"),
    ("InspectionScreenshot", "thumbnail_key"),
    ("ScheduledReportDeliveryLog", "screenshot_r2_thumb_key"),
    ("WorkflowTemplateTaskAttachment", "r2_key"),      # P2
    ("ProjectWorkflowTaskAttachment", "r2_key"),       # P2
]
```

漏掉这一步的后果：`scripts/cleanup_r2_orphaned_files.py` 会把所有附件当成孤儿文件删掉。

## 5. 模板复制与快照语义

### 5.1 模板 → 项目（沿用 P1 快照语义）

`POST /projects/{id}/workflows` 从 DB 读模板，把节点的 `title` / `description` / `sort_order` /
`attachment_key` **复制**进 `project_workflow_tasks`（P1 行为不变），并**额外**：

- 把模板节点附件复制为项目节点附件行：**只复制记录（同一个 `r2_key`），不复制 R2 对象**，
  新行 `origin='template'`。
- 因此「改模板不回写已有项目」依然成立：项目侧的行是独立快照，模板后续增删改都不影响它。

### 5.2 模板 → 模板（复制模板）

`POST /project-workflows/admin/templates/{id}/copy`：

- 复制模板行：`kind` 相同，`title` = `"{源标题}（副本）"`（可被请求体覆盖），
  `key` = 请求体提供的 `key`（需唯一且 ≤80）或 `f"{source.key}-copy-{uuid4().hex[:6]}"`。
- 复制全部节点（含 `attachment_key`）与节点的附件行（同样只复制记录、共享 `r2_key`）。
- 复制出的模板与源模板**完全独立**，此后互不影响。

### 5.3 排序语义

- 模板节点排序：`PUT /project-workflows/admin/templates/{id}/tasks/order`，请求体 `{task_ids:[...]}`
  必须**恰好**是该模板现有节点 id 的集合（否则 422），事务内重写 `sort_order = 0..n-1`。
- 项目节点排序：同规则，作用域为一条 workflow。
- 新增节点：未指定 `sort_order` 时追加到末尾（`max+1`）；指定时插入并把后续节点顺移。

## 6. 权限口径

| 操作 | 判定 | 越权返回 |
| --- | --- | --- |
| 模板 CRUD、模板节点增删改排序、模板复制、模板节点附件上传/删除 | **仅管理员**（`X-Is-Admin`） | 非管理员 **403** |
| 项目内节点增删改排序（标题/说明/顺序/删除/新增） | **仅管理员**（属「自定义」范畴，见 §12 待确认 1） | 非管理员 **403** |
| 任务状态流转 `PATCH /project-workflow-tasks/{task_id}` | `ensure_project_access`（P1 不变）：管理员或项目负责人/助理 | 无项目权限 **403** |
| 项目节点附件 上传/下载/删除 | `ensure_project_access`（内务回传是执行性工作，不卡管理员） | 无项目权限 **403**；跨项目/附件不属于该项目 → **404** |
| 模板目录 `GET /project-workflows/templates`、概要、流程读 | `protected`（P1 不变） | — |

实现要点：

- 管理员判定复用既有 `X-Is-Admin` 头；后端提供 `require_admin` 依赖（与
  `backend/app/api/v1/endpoints/scheduled_reports.py` 的 `require_admin` 同形），模板/项目节点写端点直接挂它。
- 项目级读写仍先 `project_service.ensure_project_access`，再校验资源归属：
  附件 id 必须能追溯到 `workflow.project_id == 路径里的 project_id`，否则 **404**（不泄露存在性，防枚举）。
- 前端 `isAdmin(session)` 只用于隐藏入口，**不作为权限依据**；后端 403 是唯一权威。

## 7. API 契约

全部在 `protected`（API-Key）之下，路径挂在 `/api/v1`，前端经 `/api/backend/api/v1/...` 代理访问。

### 7.1 模板（仅管理员）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/project-workflows/admin/templates` | 模板列表（含节点数），管理员视图 |
| GET | `/project-workflows/admin/templates/{template_id}` | 模板详情：模板 + 有序节点 + 每节点的附件 |
| POST | `/project-workflows/admin/templates` | `{key?, kind, title, description?}` → 新建 |
| PATCH | `/project-workflows/admin/templates/{template_id}` | `{title?, description?, sort_order?}` → 改（**`key`/`kind` 不可改**） |
| DELETE | `/project-workflows/admin/templates/{template_id}` | 删除模板（级联节点与模板附件；已创建项目不受影响） |
| POST | `/project-workflows/admin/templates/{template_id}/copy` | `{title?, key?}` → 复制模板 |
| POST | `/project-workflows/admin/templates/{template_id}/tasks` | `{title, description?, attachment_key?, sort_order?}` → 新增节点 |
| PATCH | `/project-workflows/admin/template-tasks/{task_id}` | `{title?, description?, attachment_key?}` → 改节点 |
| DELETE | `/project-workflows/admin/template-tasks/{task_id}` | 删除节点（级联其附件） |
| PUT | `/project-workflows/admin/templates/{template_id}/tasks/order` | `{task_ids:[...]}` → 重排 |
| POST | `/project-workflows/admin/template-tasks/{task_id}/attachments` | multipart `file` → 上传模板节点附件 |
| DELETE | `/project-workflows/admin/template-task-attachments/{attachment_id}` | 删除模板节点附件 |

`attachment_key` 取值校验：必须是 `amazon_registration_form` / `worldfirst_registration_guide` 之一或 `null`，
否则 422（不让管理员把任意字符串写进固定文档键）。

### 7.2 项目节点（仅管理员）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/projects/{project_id}/workflows/{workflow_id}/tasks` | `{title, description?, attachment_key?, sort_order?}` → 新增节点 |
| PATCH | `/project-workflow-tasks/{task_id}/definition` | `{title?, description?, attachment_key?}` → 改节点（**不含 status**） |
| DELETE | `/project-workflow-tasks/{task_id}` | 删除节点（级联其附件） |
| PUT | `/projects/{project_id}/workflows/{workflow_id}/tasks/order` | `{task_ids:[...]}` → 重排 |

`workflow_id` 与 `task_id` 都必须属于路径里的 `project_id`，否则 404。

### 7.3 项目节点附件（有项目权限的操作者）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/projects/{project_id}/workflow-tasks/{task_id}/attachments` | multipart `file` → 上传，返回附件记录 |
| GET | `/projects/{project_id}/workflow-task-attachments/{attachment_id}/download` | 受保护流式下载 |
| DELETE | `/projects/{project_id}/workflow-task-attachments/{attachment_id}` | 删除（按 §8.4 决定是否删 R2 对象） |

「列出」不单独开端点：附件内嵌在 `GET /projects/{id}/workflows` 的任务对象里（`attachments` 数组，
按 `created_at, id` 稳定排序）。理由是页面本来就是整条 workflow 一起渲染，单独列表端点只会多一次请求。

### 7.4 关键响应形状

```ts
// 附件记录（模板侧与项目侧同形，模板侧无 origin）
type WorkflowAttachment = {
  id: number
  filename: string
  content_type: string
  file_size: number
  uploader: string | null
  created_at: string
  origin?: 'upload' | 'template'   // 仅项目侧返回
}

// 任务（GET /projects/{id}/workflows）——P1 字段全保留，仅追加 attachments
type ProjectWorkflowTask = {
  id: number; workflow_id: number; title: string; description: string | null
  sort_order: number; status: WorkflowStatus; attachment_key: string | null
  attachments: WorkflowAttachment[]        // P2 追加
}

// 模板详情（管理员）
type WorkflowTemplateDetail = {
  id: number; key: string; kind: WorkflowKind; title: string
  description: string | null; sort_order: number
  task_count: number
  tasks: Array<{
    id: number; title: string; description: string | null
    sort_order: number; attachment_key: string | null
    attachments: WorkflowAttachment[]
  }>
}
```

**不返回**任何公开 URL / presigned URL / 本地路径：附件只能通过 §7.3 的鉴权下载端点取得。

### 7.5 错误语义

| 场景 | 状态码 |
| --- | --- |
| 模板/节点/附件不存在（含跨项目、不属于该 workflow） | 404 |
| 非管理员调用模板或项目节点写接口 | 403 |
| 无项目权限（非管理员且 operator 不匹配） | 403 |
| `key` 重复、`kind` 非法、`attachment_key` 不在白名单、排序 id 集合不匹配 | 422 |
| 扩展名/MIME 不允许 | 400 |
| 超过大小上限 | 413 |
| R2 未配置（`r2_enabled` 为假） | 503 |
| 下载时对象在 R2 已不存在 | 404 |

## 8. 附件上传/下载流程（R2 复用）

### 8.1 上传（复用既有基础设施，不新写 R2 客户端）

1. 端点收 `UploadFile`，做**三道校验**（全部在读取前完成能做的部分）：
   - `filename` 非空；
   - 后缀 ∈ `settings.workflow_attachment_allowed_extensions`（否则 400）；
   - `content_type` ∈ `settings.workflow_attachment_allowed_content_types`（否则 400）。
2. 分块读入内存（1 MiB/块），累计超过 `settings.workflow_attachment_max_bytes` → **413**
   （与 `upload_service.save_upload_file` 同一写法，避免 `file.read()` 一次性吃满内存）。
3. `settings.r2_enabled` 为假 → **503**（复用既有文案「Cloud storage is not configured...」）。
4. 生成受控 key 并上传（复用 `r2_service.upload_bytes_to_r2`，不新建客户端）：

```
key = f"{project_slug}/{file_type}/{uuid4().hex}_{safe_name}"
```

| 场景 | `project_slug` | `file_type` | 示例 key |
| --- | --- | --- | --- |
| 项目节点附件 | `project-launch-{project_id}` | `task-{task_id}` | `project-launch-12/task-345/a1b2…_注册表.xlsx` |
| 模板节点附件 | `project-launch-templates` | `template-task-{task_id}` | `project-launch-templates/template-task-7/a1b2…_万里汇.pdf` |

- `safe_name` 只保留**基名**（`Path(filename).name`）+ 小写后缀，经 `slugify` 截断（沿用 `upload_service._safe_name`），
  **杜绝 `../`、绝对路径、中文路径拼接风险**；R2 侧还有 `_sanitize_key` 兜底。
- `uuid4().hex` 前缀保证同名文件不互相覆盖（这是既有 upload 流程的做法，附件沿用）。
- 上传成功后写附件行（`r2_key`/`filename`=原始名/`content_type`/`file_size`/`uploader`），返回附件记录。
- 上传**不落本地缓存**：附件只存 R2（P1 文档那种「本地缓存供报表脚本读取」的语义不适用于附件）。

### 8.2 大小/类型限制（新增 settings，additive）

```python
workflow_attachment_max_bytes: int = 50 * 1024 * 1024          # 50 MB
workflow_attachment_allowed_extensions: set[str] = {
    ".pdf", ".xlsx", ".xls", ".docx", ".doc", ".csv", ".txt",
    ".zip", ".png", ".jpg", ".jpeg", ".webp",
}
workflow_attachment_allowed_content_types: set[str] = {
    # 既有 allowed_content_types 的全部取值
    "text/plain", "text/csv", "application/csv", "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/pdf", "application/octet-stream",
    # P2 追加
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/msword", "application/zip", "application/x-zip-compressed",
    "image/png", "image/jpeg", "image/webp",
}
```

新增独立 setting（而不是复用 `allowed_upload_extensions`）的原因：报表上传是「固定业务类型 + 固定格式」，
附件是「内务回传，含打包 zip 与图片」，两者允许面不同，混用会让报表侧意外放宽。

### 8.3 下载：服务端流式，不暴露 R2

- 校验链：`protected` → `ensure_project_access(project_id)` → 附件行 → `task` → `workflow` →
  `workflow.project_id == project_id`（不等即 404）。
- 读取：**新增一个小助手** `r2_service.iter_file_from_r2(settings, key, chunk_size=1 MiB)`，
  内部 `get_object` 并把 `StreamingBody` 按块 yield，`finally` 关闭 body；
  端点返回 `StreamingResponse`，带：

```
Content-Type: <附件记录里的 content_type>
Content-Length: <file_size>
Content-Disposition: attachment; filename*=utf-8''<RFC 5987 编码的原始文件名>
```

- 对象不存在（R2 抛 `NoSuchKey`）→ **404**；不记录文件字节、不记录对象内容。
- **为什么不用 presigned URL**（仓库里 inspections 用的是这条）：presigned URL 一旦签发，
  在 TTL 内**不需要任何鉴权**即可下载，等于把「项目权限校验」降级成「签发时刻校验一次」，
  与 issue 要求的「下载需鉴权 + 项目权限校验」不一致；且 URL 会经前端落入浏览器历史/日志。
  服务端流式保持「每次请求都过一遍鉴权」。
- **为什么不用 `download_to_temp` + `FileResponse`**：`download_to_temp` 是 context manager，
  退出即删临时文件，而 `FileResponse` 是**返回之后**才流式读取，会把「文件已删除」变成偶发 404。
  要用这条路必须引入 `BackgroundTask` 延迟删除，徒增状态；流式更直接。

### 8.4 R2 对象归属与删除（唯一规则）

> **规则**：删除任何附件行之前，先检查**两张附件表里是否还有其它行引用同一个 `r2_key`**
> （`WorkflowTemplateTaskAttachment` ∪ `ProjectWorkflowTaskAttachment`，排除当前行）。
> - 无其它引用 → 调 `delete_file_from_r2` 删对象；失败则按既有模式写 `r2_delete_failures`
>   （`r2_lifecycle.record_delete_failure`，`source='workflow_attachment_delete'`），**不回滚**行删除。
> - 仍有引用 → **只删行，不碰对象**（共享对象仍被别的行需要）。
> - 残留的无引用对象由既有 `scripts/cleanup_r2_orphaned_files.py` 兜底（前提是 §4.5 的注册已做）。

这条规则一次性覆盖三种情况，不需要给行标记「谁拥有对象」：

- 项目侧 `origin='template'` 的副本被删除 → 模板行仍引用同一 key → 对象保留（正确）。
- 模板附件被删除但其副本仍在项目里 → 对象保留（正确）。
- 项目内上传的附件被删除且无人引用 → 对象删除（正确）。

行删除与 R2 删除的顺序：**先提交行删除，再删 R2 对象**（行是事实来源；R2 删除失败有死信表可重试）。

## 9. 前端 UX 契约（等后端合并后由 Seth 实现）

### 9.1 入口与可见性

- **模板管理入口不放进侧栏**。理由：`frontend/lib/sidebar-config.ts` 顶部注释已确立约定——
  「整组/子项的 roles/groupRoles 标记已全部移除，可见性改由单页权限接管，sidebar 不再做角色墙」，
  且侧栏有既有一致性测试守卫。往侧栏塞一个 admin-only 项会重新引入角色墙，与该约定冲突。
- 改为：**项目启动台页内的「流程模板」按钮**（右上角，仅 `isAdmin(session)` 时渲染），
  跳 `/dashboard/operations/project-launch/templates`；该路由自身再做 `isAdmin(session)` 校验，
  非管理员直接访问显示「无权限」态（不渲染任何模板数据、不发模板请求）。
- `isAdmin(session)` 目前是 `frontend/lib/backend-auth.ts` 的模块私有函数，需要导出（或提供
  `getSessionRoleType(session)`）供页面复用；**前端判定只控制显示，后端 403 才是权威**。
- 非管理员在项目启动台里**看不到**任何节点编辑/排序/删除控件，但**看得到**附件上传/下载/删除
  （内务回传，§6）。

### 9.2 项目启动台（`/dashboard/operations/project-launch`）

- 任务行新增「附件」区（在既有状态控件下方，与 P1 的固定资料按钮**分组共存**）：
  - **固定资料**（`attachment_key` 存在时）：沿用 P1 的下载按钮与中文文件名映射，行为不变。
  - **附件**：已上传列表（文件名 + 大小 + 上传者 + 时间；`origin='template'` 加「模板附件」徽标）
    + 「下载」/「删除」按钮 + 「上传附件」按钮。
  - 上传走 `multipart/form-data`（新增 API 客户端方法 `uploadTaskAttachment`）；
    成功后就地刷新该 workflow 详情（与 P1 改状态后的刷新策略一致）。
  - 删除需二次确认；失败展示服务端错误并保留原列表。
- 管理员额外可见：任务行「编辑节点」「删除节点」、「新增节点」按钮、拖拽/上下移排序。
- 空态/错误态沿用 P1 约定：loading / 无项目 / 无流程 / 读失败分别显式呈现，读失败不伪装成空态。
- 窄屏：附件区在任务行内纵向堆叠，不出现横向溢出；操作按钮不小于既有 terminal 控件尺寸。

### 9.3 模板编辑器（`/dashboard/operations/project-launch/templates`，仅管理员）

- 左侧模板列表（标题 + kind 标签 + 节点数 + 排序），右侧模板详情。
- 详情：标题/描述编辑；节点列表（拖拽排序）；节点编辑（标题/描述/固定文档键选择）；
  节点附件上传/删除。
- 顶部操作：新建模板（选 kind、填标题）、复制模板、删除模板（二次确认，提示「已创建的项目不受影响」）。
- 视觉：沿用 `frontend/docs/design-spec.md` Terminal V3（term 令牌、零圆角、零阴影、1px 边框）。
- 交互失败一律展示服务端错误原文（403/422/413 各自可读文案），不做静默吞错。

### 9.4 API 客户端（`frontend/lib/project-workflows-api.ts` 扩展）

新增方法（沿用 `buildBackendClientHeaders` + `fetchWithTimeout` + `parseResponseError`）：

```ts
fetchAdminTemplates(session)                       // GET  /project-workflows/admin/templates
fetchAdminTemplate(id, session)                    // GET  /project-workflows/admin/templates/{id}
createTemplate(input, session)                     // POST /project-workflows/admin/templates
updateTemplate(id, input, session)                 // PATCH …
deleteTemplate(id, session)                        // DELETE …
copyTemplate(id, input, session)                   // POST …/copy
createTemplateTask(templateId, input, session)     // POST …/tasks
updateTemplateTask(taskId, input, session)         // PATCH /project-workflows/admin/template-tasks/{id}
deleteTemplateTask(taskId, session)
reorderTemplateTasks(templateId, taskIds, session)
uploadTemplateTaskAttachment(taskId, file, session)
deleteTemplateTaskAttachment(attachmentId, session)
createProjectTask(projectId, workflowId, input, session)
updateProjectTaskDefinition(taskId, input, session)
deleteProjectTask(taskId, session)
reorderProjectTasks(projectId, workflowId, taskIds, session)
uploadTaskAttachment(projectId, taskId, file, session)
deleteTaskAttachment(projectId, attachmentId, session)
downloadTaskAttachment(projectId, attachmentId, session)  // 鉴权 Blob + downloadBlob(原始文件名)
```

## 10. 迁移与回滚

- 建迁移前必做（仓库约定）：`git fetch origin && git rebase origin/main` →
  `cd backend && .venv/bin/alembic heads` 确认**只有一个 head** → 再建。
- 当前同步 head 为 **275**（`20261005_275_create_project_workflows.py`），
  因此新迁移为 **`20261005_276_project_launch_template_customization.py`，`--rev-id 276`**；
  若 rebase 后 head 变化，取新 head 的**下一个数字**并保持日期前缀文件名（禁止随机 hash）。
- `upgrade`：
  1. 建 4 张表 + 索引 + Check 约束（FK 全部 `ON DELETE CASCADE`）。
  2. **种子** P1 两份模板：`store-launch-v1`（6 节点，前两个节点 `attachment_key` =
     `amazon_registration_form` / `worldfirst_registration_guide`）、
     `product-womens-swimwear-v1`（6 节点，`attachment_key` 全 `null`），
     标题/描述/顺序与 P1 `project_workflow_templates.py` **逐字一致**。
  3. 种子写法：用 `op.get_bind()` 先 `SELECT` 是否存在该 `key`，不存在才 `INSERT`（幂等，PG/SQLite 通用）；
     **迁移文件内冻结字面量，不 import 应用代码**（应用代码会演进，旧迁移必须自包含）。
- `downgrade`：按 `project_workflow_task_attachments` → `workflow_template_task_attachments` →
  `workflow_template_tasks` → `workflow_templates` 顺序 drop（先删子表）。
  种子数据随表一起消失，无需单独 delete。
- 回滚对 P1 无影响：P1 的表与数据不被触碰，`project_workflows.template_key` 是普通字符串列（无 FK）。
- 运行时改造：`project_workflow_templates.py` 删除模板常量与 `list_templates()`/`get_template()`/
  `default_product_template()`，只保留 `WORKFLOW_KIND_*` 与 `DOCUMENT_KEY_*` 白名单常量
  （后者仍被 endpoint 白名单映射使用）；`project_workflow_service` 改为从 DB 读模板。
- 部署顺序：迁移先于应用（新代码需要新表与种子数据）。
- `backend/scripts/check_alembic.py` 必须在 PR 前通过（单 head + 命名合规 + 无重复 id）。

## 11. 测试与验收

**新增测试（pytest）**

- `backend/tests/api/test_project_workflow_templates.py`：管理员模板 CRUD、节点增删改排序、
  排序 id 集合不匹配 → 422、`key` 重复 → 422、`kind`/`attachment_key` 非法 → 422、
  复制模板（key 生成 + 节点与附件记录复制）、**非管理员全部写接口 403**、删除模板不影响已有项目。
- `backend/tests/api/test_project_workflow_task_customization.py`：项目节点增删改排序、
  **改模板不回写已有项目**（改模板后重读项目节点断言不变）、非管理员写 → 403、
  跨项目 `task_id`/`workflow_id` → 404、P1 `PATCH {status}` 对非管理员仍 200（回归）。
- `backend/tests/api/test_project_workflow_attachments.py`（R2 用
  `patch("app.services.r2_service.upload_bytes_to_r2")` + `PropertyMock(r2_enabled=True)` 的既有写法）：
  上传（记录字段完整、key 前缀符合 §8.1）、列表（内嵌在 workflow 详情里、排序稳定）、
  下载（`Content-Disposition` 带 RFC 5987 原始中文名、`Content-Type`/`Content-Length` 正确）、
  删除（有其它引用时**不**调 R2 删除；无引用时调用；R2 删除失败写 `r2_delete_failures`）、
  跨项目下载/删除 → 404、无项目权限 → 403、扩展名/MIME 不允许 → 400、超限 → 413、R2 未配置 → 503。

**回归测试**

- P1 既有 `backend/tests/api/test_project_workflows.py`（15 例）**必须全绿**（契约不变）。
- 迁移往返：`alembic upgrade head` / `alembic downgrade -1` / 再 `upgrade head`，
  并断言种子数据在 upgrade 后存在、downgrade 后表消失。
- `python scripts/check_alembic.py` 通过。
- 前端（Seth）：`pnpm test` + `pnpm build` 通过；新增模板编辑器与附件区用例；
  非管理员不渲染模板入口的断言。

**验收标准（对齐 issue）**

- 管理员可新建/编辑模板与节点并排序；非管理员调用模板写接口 403。
- 项目内节点可增删改排序；改模板不回写已有项目进度。
- 节点附件可上传（R2）、列出、下载（鉴权 + 项目权限）、删除；跨项目越权被拒。
- 迁移可逆、`check_alembic.py` 通过；后端 pytest 目标集通过；前端 `pnpm test` + `pnpm build` 通过。
- P1 已上线的接口与数据不受破坏。

## 12. 待确认项（请 Yawei 拍板）

1. **项目内节点编辑是否也限管理员？** 本设计默认「限管理员」（与「自定义仅管理员维护」一致），
   非管理员只能改**状态**与**上传/删除附件**。若希望项目负责人也能增删改自己项目的节点，请说明。
2. **模板节点附件是否在创建项目时复制到项目节点？** 本设计默认「复制记录（共享同一个 R2 对象），
   不复制文件」。若希望模板附件只是模板侧参考、不进项目，请说明。
3. **附件类型与大小上限**：默认 ≤50 MB，允许 pdf/xlsx/xls/docx/doc/csv/txt/zip/png/jpg/jpeg/webp。
   是否需要更严（例如禁 zip）或更宽？
4. **R2 桶是否对外公开？** 若 `r2_public_url` 指向的域名可公开读取，附件 key 虽含 uuid 不可枚举，
   仍属「知道即可下载」。建议确认附件前缀（`project-launch-*`）不对外公开，或明确接受该风险。
5. **模板删除策略**：默认**硬删**（级联节点与模板附件；已创建项目的快照不受影响）。
   若希望改为「归档、不再出现在新建目录但保留数据」，请说明。
6. **P1 两份固定文档**：默认保留 `attachment_key` 兼容读、**不迁进附件表**；
   管理员若想替换原件，直接把新版文件作为模板节点附件上传即可。是否接受该方式？
