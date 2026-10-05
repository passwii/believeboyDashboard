# 项目启动台 P2 设计稿：管理员自定义流程模板与节点 + 阶段排期 + 节点内容/附件（内务回传，复用 R2）

- Issue：BLF-1237（承接 BLF-1234 / P1 已上线）
- 日期：2026-10-05
- 状态：**口径已确认（Yawei 2026-10-05）**；后端已按本稿实现（revision 276），PR 待 Tia review
- 相关代码：`backend/app/models/project_workflow.py`、`backend/app/models/project_workflow_template.py`、
  `backend/app/services/project_workflow_service.py`、`backend/app/services/project_workflow_template_service.py`、
  `backend/app/services/project_workflow_attachment_service.py`、
  `backend/app/api/v1/endpoints/project_workflows.py`、
  `backend/app/api/v1/endpoints/project_workflow_templates.py`、
  `backend/app/services/r2_service.py`、`frontend/lib/project-workflows-api.ts`
- 前置设计稿：`docs/superpowers/specs/2026-10-05-project-launch-dashboard-design.md`（P1）

## 1. 背景与目标

P1 把「店铺启动 + 产品开发」的流程进度做成了持久化页面，但**模板是后端硬编码常量**
（`store-launch-v1` / `product-womens-swimwear-v1`），节点文案、顺序、附件都改不了，
新增品类或调整节点必须改代码发版。

Yawei 提出的 P2 目标：**每个节点可自定义内容，所有节点汇总成项目整体**；节点附件复用现有 R2 上传流程。

### 已确认口径（Yawei，不再讨论）

1. **自定义仅管理员维护**——不做项目负责人自改模板；沿用现有 `X-Is-Admin` 判定口径。
   **项目内节点的编辑也保持管理员方式。**
2. **附件只服务内务回传**——不做「发给合作方」语义，节点附件是单一用途的多文件集合。
3. **阶段排期**——节点记录「项目阶段的日期」和「项目时长」，并据此算出阶段的开始/结束日期。
4. **多条内容 + 多个附件**——一个阶段有对应的内容与附件，**内容可插多条、附件可挂多个**。
5. **复制记录**——模板附件在项目侧复制**记录**，模板与项目副本「共用一个 R2 的 URL」。
6. **附件桶公开与否不作为约束**——复制后在已登录状态下查看，key 不会对外泄露。
   实现上仍然**不把 key / URL 下发到前端**（下载走鉴权流式），所以公开桶不会因为页面而泄露 key。

### P2 交付四件事

- **模板层持久化**：模板与节点成为 DB 数据，管理员可增删改排序、可复制模板；不再依赖代码常量。
- **项目层可维护**：创建流程时从模板复制节点（沿用 P1 快照语义），项目内节点可增删改排序；
  模板后续修改**不回写**已有项目。
- **阶段排期**：节点带计划工期与起止日期，流程/项目整体起止与时长由节点派生。
- **节点内容与附件**：一个节点多条内容 + 多个附件；附件复用 R2，上传/列出/下载/删除
  全部走鉴权 + 项目权限校验。

## 2. 范围与非目标

**范围内**

- 模板 CRUD（仅管理员）：模板增删改、节点增删改排序、模板复制。
- 项目层节点：创建流程时从模板快照复制；项目内节点增删改排序（仅管理员）。
- 阶段排期：节点计划工期 + 起止日期；流程/项目整体起止与时长由节点派生。
- 节点多条内容 + 多个附件：模板侧与项目侧都支持；附件走 R2。
- 迁移：6 张新表 + P1 两张表追加可空列 + P1 两份模板种子数据；P1 数据与接口契约零破坏。

**非目标（明确不做）**

- 不做对外发送（邮件/飞书）、不做审批流、不做文件版本历史、不做项目负责人自改模板。
- 不做附件在线预览、图片缩略图、批量打包下载、附件级独立权限（附件权限 = 项目权限）。
- 不做甘特图/依赖关系/关键路径；排期只做「工期 → 日期」的线性推算与聚合，不做资源冲突检测。
- 不做「实际 vs 计划」双轨日期，也不做节点完成时间的自动回填。
- 不把 P1 的两份内置文档从 `backend/app/resources/` 搬进 R2（见 §3.3）。

## 3. 与 P1 的关系、兼容策略

### 3.1 P1 的 6 个接口：形状不变

| P1 接口 | P2 处理 |
| --- | --- |
| `GET /project-workflows/templates` | **形状不变**（`{templates:[{key,kind,title}]}`）；数据源从常量改为 DB 查询 |
| `GET /project-workflows/summary` | 形状为**超集**：项目项新增 `schedule_start/schedule_end/schedule_days`（不新增逐节点字段，避免拖慢列表） |
| `GET /projects/{id}/workflows` | 形状为**超集**：流程新增 `start_date/schedule_*`，任务新增 `duration_days/start_date/end_date/span_days/contents/attachments`（旧前端忽略即兼容） |
| `POST /projects/{id}/workflows` | 形状不变（`{kind,template_key,title?}` 全部保留），请求体**追加可选** `start_date`；模板改为从 DB 读，校验语义不变 |
| `PATCH /project-workflow-tasks/{task_id}` | **严格保持只接受 `{status}`**，非管理员 + 有项目权限仍可用（P1 行为一字不改） |
| `GET /projects/{id}/workflows/documents/{document_key}` | 不变（白名单两键继续从 `backend/app/resources/` 流式返回） |

> 关键取舍：项目节点的「改标题/改说明/排序/删除/排期」**不塞进** P1 的
> `PATCH /project-workflow-tasks/{task_id}`，而是新增管理员专用端点（§7.2）。
> 理由是 P1 该端点的语义是「改进度状态，非管理员可用」；若在同一路径上按请求体字段分流权限，
> 「非管理员改标题必须 403」会变成隐性契约，容易漏判。新增端点 = 零回归风险。

### 3.2 P1 数据：零改写

- `project_workflows` / `project_workflow_tasks` 只**追加可空列**（`start_date`、`duration_days`、
  `start_date`、`end_date`），不改列名、不改既有约束、不重写既有行。
- 已创建项目的节点标题/描述/顺序/状态/`attachment_key` 原样保留，页面表现与 P1 完全一致。
- 已创建项目的 `template_key` 只作溯源，模板被改/被删都不影响它们（快照语义）。

### 3.3 `attachment_key`（P1 固定文档）迁移策略 —— 决策：**保留 + 兼容读，不迁到附件表**

- `project_workflow_tasks.attachment_key` 继续存在，值仍是白名单键
  （`amazon_registration_form` / `worldfirst_registration_guide`），继续由 P1 的文档下载端点服务。
- 模板节点同样保留 `attachment_key` 列，管理员可在模板编辑器里从**两个白名单键**中选择或清空
  （固定文档仍由代码侧白名单控制，不允许管理员用它指向任意文件；非法值 422）。
- **不把两份内置文档迁进附件表**：它们在 `backend/app/resources/`，不在 R2。迁到附件表需要在迁移/
  部署时把它们上传到 R2，属于「迁移里做外部副作用」，失败会让 upgrade 半途而废，回滚还要额外删对象。
  收益（管理员可替换原件）用更轻的方式达到：**管理员把新版文件作为模板节点附件上传**即可（§8）。
- 前端表现：**共存，不替换**。节点行上「固定资料」下载按钮（`attachment_key`）与「附件」列表
  （R2 上传件）同时存在，两个入口视觉上分组呈现（§9）。

## 4. 领域模型

新增 6 张表；`project_workflows` / `project_workflow_tasks` 追加可空列。

### 4.1 `workflow_templates`（模板）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | Integer PK | |
| `key` | String(80), **unique** | 稳定键；`project_workflows.template_key` 以字符串引用它；**创建后不可改**（改键会断溯源） |
| `kind` | String(32) | `store_launch` / `product_development`，Check 约束 |
| `title` | String(160) | 展示名 |
| `description` | Text, nullable | 模板说明 |
| `sort_order` | Integer, not null, default 0 | 模板目录顺序 |
| `created_at` / `updated_at` | DateTime(tz) | |

索引：`ix_workflow_templates_kind_sort(kind, sort_order)` + `uq_workflow_templates_key(key)`。

> 不引入 P1 常量里的 `version` 字段：它从未出现在 API 契约里，模板可编辑后「版本号」没有可靠语义，
> 保留只会产生无意义状态。版本语义由 `key` 后缀（`-v1`）+ 复制功能承载。

### 4.2 `workflow_template_tasks`（模板节点）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | Integer PK | |
| `template_id` | FK → `workflow_templates.id`，`ON DELETE CASCADE` | |
| `title` | String(160), not null | |
| `description` | Text, nullable | 节点摘要（P1 兼容字段，仍可编辑） |
| `sort_order` | Integer, not null | 稳定顺序 |
| `attachment_key` | String(64), nullable | P1 兼容：固定白名单文档键 |
| `duration_days` | Integer, nullable | **计划工期（天）**；创建项目时复制，用于推算阶段日期 |
| `created_at` / `updated_at` | DateTime(tz) | |

索引：`ix_workflow_template_tasks_template_sort(template_id, sort_order)`。

> 排序**不加** `UNIQUE(template_id, sort_order)`：拖拽排序需在一次事务里整体重写序号，
> 唯一约束会让中间态互相冲突。序号唯一性由服务层在写事务内保证（重写为 `0..n-1`）。

### 4.3 `workflow_template_task_contents`（模板节点的多条内容）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | Integer PK | |
| `template_task_id` | FK → `workflow_template_tasks.id`，`ON DELETE CASCADE` | |
| `title` | String(160), nullable | 小标题（可选） |
| `body` | Text, not null | 内容正文 |
| `sort_order` | Integer, not null | 内容顺序 |
| `created_at` / `updated_at` | DateTime(tz) | |

索引：`ix_workflow_template_task_contents_task_sort(template_task_id, sort_order)`。

### 4.4 `workflow_template_task_attachments`（模板节点的多个附件）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | Integer PK | |
| `template_task_id` | FK → `workflow_template_tasks.id`，`ON DELETE CASCADE` | |
| `r2_key` | String(512), not null | R2 对象 key（服务端生成，受控） |
| `filename` | String(256), not null | 原始文件名（下载时回显，不参与路径拼接） |
| `content_type` | String(128), not null | 上传时记录的 MIME |
| `file_size` | Integer, not null | 字节数 |
| `uploader` | String(255), nullable | 操作者（`X-Operator`，与仓库其它 operator 列同宽，避免超长头部截断 500） |
| `created_at` | DateTime(tz) | |

索引：`ix_workflow_template_task_attachments_task(template_task_id)`。

### 4.5 `project_workflows`（P1 表追加 1 列）

| 新增字段 | 类型 | 说明 |
| --- | --- | --- |
| `start_date` | Date, nullable | **排期锚点**：节点未手填日期时，按工期从这里顺序推算 |

### 4.6 `project_workflow_tasks`（P1 表追加 3 列）

| 新增字段 | 类型 | 说明 |
| --- | --- | --- |
| `duration_days` | Integer, nullable | 阶段计划工期（创建时从模板复制，可改） |
| `start_date` | Date, nullable | 阶段开始日期（手填或推算，落库） |
| `end_date` | Date, nullable | 阶段结束日期（手填或推算，落库） |

### 4.7 `project_workflow_task_contents`（项目节点的多条内容）

字段同 §4.3，父键为 `task_id` → `project_workflow_tasks.id`（`ON DELETE CASCADE`），
索引 `ix_project_workflow_task_contents_task_sort(task_id, sort_order)`。

### 4.8 `project_workflow_task_attachments`（项目节点的多个附件）

字段同 §4.4，父键为 `task_id` → `project_workflow_tasks.id`（`ON DELETE CASCADE`），
索引 `ix_project_workflow_task_attachments_task(task_id)`，另加：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `origin` | String(16), not null, default `upload` | `upload`（项目内上传）/ `template`（模板附件副本），Check 约束 |

> **不做多态 owner（`owner_kind`+`owner_id`）**：会失去外键级联，删节点时留孤儿行。
> 两张附件表各自的 FK 级联更安全；模板→项目的复制在服务层显式完成。
> `origin` 只用于 UI 标注来源（「模板附件」徽标）与审计，**不参与 R2 归属判断**（归属见 §8.4）。

### 4.9 R2 key 列注册（必须）

两张附件表的列名是 `r2_key`（不以 `_r2_key` 结尾），不会被
`ArtifactService.discover_r2_key_columns()` 自动发现。必须加入
`ArtifactService._IRREGULAR_KEY_COLUMNS`：

```python
("WorkflowTemplateTaskAttachment", "r2_key"),   # P2
("ProjectWorkflowTaskAttachment", "r2_key"),    # P2
```

漏掉这一步的后果：`scripts/cleanup_r2_orphaned_files.py` 会把所有附件当成孤儿文件删掉。

## 5. 快照语义、排期推算与排序

### 5.1 模板 → 项目（沿用 P1 快照语义）

`POST /projects/{id}/workflows` 从 DB 读模板，把节点的 `title` / `description` / `sort_order` /
`attachment_key` / `duration_days` **复制**进 `project_workflow_tasks`（P1 行为不变），并**额外**：

- 复制模板节点的**多条内容**为新行。
- 复制模板节点的**附件**为新行：**只复制记录（同一个 `r2_key`），不复制 R2 对象**，
  新行 `origin='template'`。

因此「改模板不回写已有项目」依然成立：项目侧的行是独立快照，模板后续增删改都不影响它。

### 5.2 模板 → 模板（复制模板）

`POST /project-workflows/admin/templates/{id}/copy`：

- 复制模板行：`kind` 相同，`title` 默认 `"{源标题}（副本）"`（可被请求体覆盖），
  `key` = 请求体提供的（需唯一且 ≤80）或 `f"{source.key}-copy-{uuid4().hex[:6]}"`。
- 复制全部节点（含 `attachment_key` / `duration_days`）、节点的内容与附件行
  （附件同样只复制记录、共享 `r2_key`）。
- 复制出的模板与源模板**完全独立**，此后互不影响。

### 5.3 排期推算（`recompute_schedule`）

口径：**手填优先，其余按工期链式推算**，结果落库。

**触发点（缺一不可，漏掉就会出现「填了工期但日期是空」）**：

- 创建流程（从模板快照时就要按模板工期 + 请求里的锚点算出阶段日期）
- 新增项目节点
- 改节点定义（工期 / 手填日期）
- 删除节点、节点排序、改流程锚点 `start_date`

> 实现注意：新增节点的重算必须让新节点进入内存里的 `workflow.tasks` 集合
> （构造时用 `workflow=workflow` 而不是 `workflow_id=...`）。同一 session 的
> identity map 会复用那份「已加载」的旧集合，直接重查 `get_workflow()` 不会把新节点带进来。

```
cursor = workflow.start_date
按 sort_order 遍历节点：
  若节点 start_date 与 end_date 都为空 且 duration_days 有值 且 cursor 有值：
      start_date = cursor
      end_date   = cursor + (duration_days - 1) 天
  若 end_date 有值   → cursor = end_date + 1 天
  否则若 start_date 有值 → cursor = start_date + 1 天
```

派生值（不落库，读时计算）：

- 节点 `span_days = end_date - start_date + 1`（两端都有值时）。
- 流程 `schedule_start = min(节点 start_date)`、`schedule_end = max(节点 end_date)`、
  `schedule_days = schedule_end - schedule_start + 1`。
- 项目（概要接口）取所有流程的**并集区间**：`min(所有节点 start)` / `max(所有节点 end)`。

日期不合法（`end_date < start_date`）→ 422。工期范围 `0..3650`。

### 5.4 排序语义

- 模板节点排序：`PUT /project-workflows/admin/templates/{id}/tasks/order`，`{task_ids:[...]}`
  必须**恰好**是该模板现有节点 id 的集合（否则 422），事务内重写 `sort_order = 0..n-1`。
- 项目节点排序：同规则，作用域为一条 workflow。
- 新增节点：未指定 `sort_order` 时追加到末尾（`max+1`）；指定时插入并把后续节点顺移。
- 排序会触发排期重算（顺序变了，链式日期跟着变）。

## 6. 权限口径

| 操作 | 判定 | 越权返回 |
| --- | --- | --- |
| 模板 CRUD、模板节点增删改排序、模板复制、模板节点内容/附件写 | **仅管理员**（`X-Is-Admin`） | 非管理员 **403** |
| 项目内节点增删改排序、节点内容增删改、流程标题/排期锚点 | **仅管理员**（「项目内节点的编辑保持管理员方式」） | 非管理员 **403** |
| 任务状态流转 `PATCH /project-workflow-tasks/{task_id}` | `ensure_project_access`（P1 不变）：管理员或项目负责人/助理 | 无项目权限 **403** |
| 项目节点附件 上传/下载/删除 | `ensure_project_access`（内务回传是执行性工作，不卡管理员） | 无项目权限 **403**；跨项目/附件不属于该项目 → **404** |
| 模板目录、概要、流程读、固定文档下载 | `protected`（P1 不变） | — |

实现要点：

- 管理员判定用 `app/api/deps.py::require_admin`（沿用既有 `X-Is-Admin` 口径，
  与 `scheduled_reports.require_admin` 同形）。
- 项目级读写仍先 `project_service.ensure_project_access`，再校验资源归属：
  节点/内容/附件都必须能追溯到 `workflow.project_id == 路径里的 project_id`，否则 **404**
  （不泄露存在性，防枚举）。内容/附件 id 不带项目路径的端点，先解析所属项目再校验。
- 前端 `isAdmin(session)` 只用于隐藏入口，**不作为权限依据**；后端 403 是唯一权威。

## 7. API 契约

全部在 `protected`（API-Key）之下，路径挂在 `/api/v1`，前端经 `/api/backend/api/v1/...` 代理访问。

### 7.1 模板（仅管理员）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/project-workflows/admin/templates` | 模板列表（含节点数） |
| GET | `/project-workflows/admin/templates/{template_id}` | 模板详情：模板 + 有序节点 + 每节点的内容与附件 |
| POST | `/project-workflows/admin/templates` | `{kind, title, description?, key?, sort_order?}` → 新建（`key` 缺省自动生成） |
| PATCH | `/project-workflows/admin/templates/{template_id}` | `{title?, description?, sort_order?}`（**`key`/`kind` 不可改**） |
| DELETE | `/project-workflows/admin/templates/{template_id}` | 删除模板（级联节点/内容/附件记录） |
| POST | `/project-workflows/admin/templates/{template_id}/copy` | `{title?, key?}` → 复制模板 |
| POST | `/project-workflows/admin/templates/{template_id}/tasks` | `{title, description?, attachment_key?, duration_days?, sort_order?}` |
| PATCH | `/project-workflows/admin/template-tasks/{task_id}` | `{title?, description?, attachment_key?, duration_days?}` |
| DELETE | `/project-workflows/admin/template-tasks/{task_id}` | 删除节点 |
| PUT | `/project-workflows/admin/templates/{template_id}/tasks/order` | `{task_ids:[...]}` → 重排 |
| POST | `/project-workflows/admin/template-tasks/{task_id}/contents` | `{body, title?, sort_order?}` → 新增一条内容 |
| PATCH | `/project-workflows/admin/template-task-contents/{content_id}` | `{body?, title?}` |
| DELETE | `/project-workflows/admin/template-task-contents/{content_id}` | 删除一条内容 |
| POST | `/project-workflows/admin/template-tasks/{task_id}/attachments` | multipart `file` → 上传模板节点附件 |
| DELETE | `/project-workflows/admin/template-task-attachments/{attachment_id}` | 删除模板节点附件 |

`attachment_key` 取值校验：必须是两个白名单键之一或 `null`，否则 422。

### 7.2 流程定义与项目节点（仅管理员）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| PATCH | `/project-workflows/{workflow_id}` | `{title?, start_date?}` → 改流程标题/排期锚点（触发重算） |
| POST | `/projects/{project_id}/workflows/{workflow_id}/tasks` | `{title, description?, attachment_key?, duration_days?, sort_order?}` |
| PATCH | `/project-workflow-tasks/{task_id}/definition` | `{title?, description?, attachment_key?, duration_days?, start_date?, end_date?}`（**不含 status**） |
| DELETE | `/project-workflow-tasks/{task_id}` | 删除节点（级联内容与附件） |
| PUT | `/projects/{project_id}/workflows/{workflow_id}/tasks/order` | `{task_ids:[...]}` → 重排 |
| POST | `/projects/{project_id}/workflow-tasks/{task_id}/contents` | `{body, title?, sort_order?}` |
| PATCH | `/project-workflow-task-contents/{content_id}` | `{body?, title?}` |
| DELETE | `/project-workflow-task-contents/{content_id}` | 删除一条内容 |

`workflow_id` / `task_id` 都必须属于路径里的 `project_id`，否则 404。

### 7.3 项目节点附件（有项目权限的操作者）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/projects/{project_id}/workflow-tasks/{task_id}/attachments` | multipart `file` → 上传，返回所属流程（含附件列表） |
| GET | `/projects/{project_id}/workflow-task-attachments/{attachment_id}/download` | 受保护流式下载 |
| DELETE | `/projects/{project_id}/workflow-task-attachments/{attachment_id}` | 删除（按 §8.4 决定是否删 R2 对象） |

「列出」不单独开端点：附件内嵌在 `GET /projects/{id}/workflows` 的任务对象里
（`attachments` 数组，按 `id` 稳定排序）。理由是页面本来就整条 workflow 一起渲染，
单独列表端点只会多一次请求。

### 7.4 关键响应形状

```ts
type WorkflowAttachment = {
  id: number
  filename: string
  content_type: string
  file_size: number
  uploader: string | null
  created_at: string
  origin?: 'upload' | 'template'   // 仅项目侧返回
}

type WorkflowContent = { id: number; title: string | null; body: string; sort_order: number }

// 任务（GET /projects/{id}/workflows）——P1 字段全保留，仅追加
type ProjectWorkflowTask = {
  id: number; workflow_id: number; title: string; description: string | null
  sort_order: number; status: WorkflowStatus; attachment_key: string | null
  duration_days: number | null          // 计划工期
  start_date: string | null             // YYYY-MM-DD
  end_date: string | null
  span_days: number | null              // 派生：含头含尾天数
  contents: WorkflowContent[]           // 多条内容
  attachments: WorkflowAttachment[]     // 多个附件
}

type ProjectWorkflow = {
  id: number; project_id: number; kind: WorkflowKind; title: string; template_key: string
  status: WorkflowStatus; task_count: number; completed_task_count: number
  start_date: string | null             // 排期锚点
  schedule_start: string | null         // 派生：min(节点开始)
  schedule_end: string | null           // 派生：max(节点结束)
  schedule_days: number | null
  tasks: ProjectWorkflowTask[]
}

// 概要里的项目项
type ProjectWorkflowSummaryItem = {
  project_id: number
  workflows: Array<{ /* P1 字段 */ start_date: string | null; schedule_start: string | null
                     schedule_end: string | null; schedule_days: number | null }>
  schedule_start: string | null; schedule_end: string | null; schedule_days: number | null
}

// 模板详情（管理员）
type WorkflowTemplateDetail = {
  id: number; key: string; kind: WorkflowKind; title: string
  description: string | null; sort_order: number; task_count: number
  tasks: Array<{ id: number; template_id: number; title: string; description: string | null
                 sort_order: number; attachment_key: string | null; duration_days: number | null
                 contents: WorkflowContent[]; attachments: WorkflowAttachment[] }>
}
```

**不返回**任何公开 URL / presigned URL / 本地路径：附件只能通过 §7.3 的鉴权下载端点取得。

### 7.5 错误语义

| 场景 | 状态码 |
| --- | --- |
| 模板/节点/内容/附件不存在（含跨项目、不属于该 workflow） | 404 |
| 非管理员调用模板或项目节点/内容写接口 | 403 |
| 无项目权限（非管理员且 operator 不匹配） | 403 |
| `key` 重复、`kind` 非法、`attachment_key` 不在白名单、排序 id 集合不匹配、`end_date < start_date`、空标题/空正文、工期越界 | 422 |
| 扩展名/MIME 不允许 | 400 |
| 超过大小上限 | 413 |
| R2 未配置（`r2_enabled` 为假） | 503 |
| 下载时对象在 R2 已不存在 | 404 |

## 8. 附件上传/下载流程（R2 复用）

### 8.1 上传（复用既有基础设施，不新写 R2 客户端）

1. 端点收 `UploadFile`，做**三道校验**（读取前能做的先做）：
   `filename` 非空；后缀 ∈ `settings.workflow_attachment_allowed_extensions`（否则 400）；
   `content_type` ∈ `settings.workflow_attachment_allowed_content_types`（否则 400）。
2. 分块读入（1 MiB/块），累计超过 `settings.workflow_attachment_max_bytes` → **413**
   （与 `upload_service.save_upload_file` 同一写法，避免一次性吃满内存）。
3. `settings.r2_enabled` 为假 → **503**。
4. 生成受控 key 并上传（复用 `r2_service.upload_bytes_to_r2`，不新建客户端）：

```
key = f"{project_slug}/{file_type}/{uuid4().hex}_{safe_name}"
```

| 场景 | `project_slug` | `file_type` | 示例 key |
| --- | --- | --- | --- |
| 项目节点附件 | `project-launch-{project_id}` | `task-{task_id}` | `project-launch-12/task-345/a1b2…_注册表.xlsx` |
| 模板节点附件 | `project-launch-templates` | `template-task-{task_id}` | `project-launch-templates/template-task-7/a1b2…_万里汇.pdf` |

- `safe_name` 只保留**基名** + 小写后缀，经 `slugify` 截断（沿用 `upload_service._safe_name`），
  **杜绝 `../`、绝对路径、中文路径拼接风险**；R2 侧还有 `_sanitize_key` 兜底。
- `uuid4().hex` 前缀保证同名文件不互相覆盖。
- 上传成功后写附件行（`r2_key` / `filename`=原始名 / `content_type` / `file_size` / `uploader`），返回所属流程。
- 上传**不落本地缓存**：附件只存 R2（P1 文档那种「本地缓存供报表脚本读取」的语义不适用于附件）。

### 8.2 大小/类型限制（新增 settings，additive）

```python
workflow_attachment_max_bytes: int = 50 * 1024 * 1024          # 50 MB
workflow_attachment_allowed_extensions: set[str] = {
    ".pdf", ".xlsx", ".xls", ".docx", ".doc", ".csv", ".txt",
    ".zip", ".png", ".jpg", ".jpeg", ".webp",
}
workflow_attachment_allowed_content_types: set[str] = {  # 既有取值 + office/zip/图片
    "text/plain", "text/csv", "application/csv", "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/pdf", "application/octet-stream",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/msword", "application/zip", "application/x-zip-compressed",
    "image/png", "image/jpeg", "image/webp",
}
```

新增独立 setting（不复用 `allowed_upload_extensions`）的原因：报表上传是「固定业务类型 + 固定格式」，
附件是「内务回传，含打包 zip 与图片」，两者允许面不同，混用会让报表侧意外放宽。

### 8.3 下载：服务端流式，不暴露 R2

- 校验链：`protected` → `ensure_project_access(project_id)` → 附件行 → `task` → `workflow` →
  `workflow.project_id == project_id`（不等即 404）。
- 读取：`r2_service.iter_file_from_r2(settings, key, chunk_size=1 MiB)`（**P2 新增的小助手**），
  内部 `get_object` 按块 yield，`finally` 关闭 `StreamingBody`；端点返回 `StreamingResponse`，带：

```
Content-Type: <附件记录里的 content_type>
Content-Length: <file_size>
Content-Disposition: attachment; filename="attachment"; filename*=utf-8''<RFC 5987 编码的原始文件名>
```

- 下载前先 `check_file_exists`：对象不存在 → **404**（避免「响应已开始流式才报错」）。
  不记录文件字节、不记录对象内容。
- **为什么不用 presigned URL**（仓库里 inspections 用的是这条）：presigned URL 一旦签发，
  在 TTL 内**不需要任何鉴权**即可下载，等于把「项目权限校验」降级成「签发时刻校验一次」，
  与 issue 要求的「下载需鉴权 + 项目权限校验」不一致；且 URL 会经前端落入浏览器历史/日志。
- **为什么不用 `download_to_temp` + `FileResponse`**：`download_to_temp` 是 context manager，
  退出即删临时文件，而 `FileResponse` 是**返回之后**才流式读取，会把「文件已删除」变成偶发 404。
- 按 Yawei 口径，附件桶是否公开不作为约束；实现上仍不下发 key/URL，
  所以公开桶不会因为页面/接口而泄露 key。

### 8.4 R2 对象归属与删除（唯一规则）

> **规则**：删除任何附件行之前，先检查**两张附件表里是否还有其它行引用同一个 `r2_key`**
> （`WorkflowTemplateTaskAttachment` ∪ `ProjectWorkflowTaskAttachment`，排除当前行）。
> - 无其它引用 → 调 `try_delete_file_from_r2` 删对象；失败则写 `r2_delete_failures`
>   （`r2_lifecycle.record_delete_failure`，`source='workflow_attachment_delete'`），**不回滚**行删除。
> - 仍有引用 → **只删行，不碰对象**（共享对象仍被别的行需要）。
> - 残留的无引用对象由既有 `scripts/cleanup_r2_orphaned_files.py` 兜底（前提是 §4.9 的注册已做）。

这条规则一次性覆盖三种情况，不需要给行标记「谁拥有对象」：

- 项目侧 `origin='template'` 的副本被删除 → 模板行仍引用同一 key → 对象保留（正确）。
- 模板附件被删除但其副本仍在项目里 → 对象保留（正确）。
- 项目内上传的附件被删除且无人引用 → 对象删除（正确）。

顺序：**先提交行删除，再删 R2 对象**（行是事实来源；R2 删除失败有死信表可重试）。

## 9. 前端 UX 契约（等后端合并后由 Seth 实现）

### 9.1 入口与可见性

- **模板管理入口不放进侧栏**。理由：`frontend/lib/sidebar-config.ts` 顶部注释已确立约定——
  「整组/子项的 roles/groupRoles 标记已全部移除，可见性改由单页权限接管，sidebar 不再做角色墙」，
  且侧栏有既有一致性测试守卫。往侧栏塞 admin-only 项会重新引入角色墙，与该约定冲突。
- 改为：**项目启动台页内的「流程模板」按钮**（仅 `isAdmin(session)` 时渲染），
  跳 `/dashboard/operations/project-launch/templates`；该路由自身再做 `isAdmin(session)` 校验，
  非管理员直接访问显示「无权限」态（不渲染任何模板数据、不发模板请求）。
- `isAdmin(session)` 目前是 `frontend/lib/backend-auth.ts` 的模块私有函数，需要导出（或提供
  `getSessionRoleType(session)`）供页面复用；**前端判定只控制显示，后端 403 才是权威**。
- 非管理员在项目启动台里**看不到**节点编辑/排序/删除/内容编辑/排期编辑控件，
  但**看得到**附件上传/下载/删除（内务回传，§6）。

### 9.2 项目启动台（`/dashboard/operations/project-launch`）

- 任务行新增两块信息（在既有状态控件下方，与 P1 的固定资料按钮**分组共存**）：
  - **固定资料**（`attachment_key` 存在时）：沿用 P1 的下载按钮与中文文件名映射，行为不变。
  - **阶段排期**：`开始日期 ~ 结束日期`（未排期显示「未排期」）+ 工期天数（`span_days` 或
    `duration_days`）；管理员可见「编辑排期」入口。
  - **内容**：多条内容列表（小标题 + 正文）；管理员可增删改。
  - **附件**：已上传列表（文件名 + 大小 + 上传者 + 时间；`origin='template'` 加「模板附件」徽标）
    + 「下载」/「删除」按钮 + 「上传附件」按钮（`multipart/form-data`，新增客户端方法
    `uploadTaskAttachment`；成功后就地刷新该 workflow 详情，与 P1 改状态后的刷新策略一致）。
  - 删除附件需二次确认；失败展示服务端错误并保留原列表。
- 流程级排期摘要（`schedule_start ~ schedule_end`、`schedule_days`）显示在流程标题旁；
  项目整体时长来自概要接口的 `schedule_days`。
- 管理员额外可见：任务行「编辑节点」「删除节点」、「新增节点」按钮、拖拽/上下移排序。
- 空态/错误态沿用 P1 约定：loading / 无项目 / 无流程 / 读失败分别显式呈现，读失败不伪装成空态。
- 窄屏：内容与附件区在任务行内纵向堆叠，不出现横向溢出；操作按钮不小于既有 terminal 控件尺寸。

### 9.3 模板编辑器（`/dashboard/operations/project-launch/templates`，仅管理员）

- 左侧模板列表（标题 + kind 标签 + 节点数 + 排序），右侧模板详情。
- 详情：标题/描述编辑；节点列表（拖拽排序）；节点编辑（标题/描述/固定文档键/计划工期）；
  节点多条内容增删改；节点附件上传/删除。
- 顶部操作：新建模板（选 kind、填标题）、复制模板、删除模板（二次确认，
  提示「已创建的项目不受影响」）。
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
createTemplateContent(taskId, input, session)
updateTemplateContent(contentId, input, session)
deleteTemplateContent(contentId, session)
uploadTemplateTaskAttachment(taskId, file, session)
deleteTemplateTaskAttachment(attachmentId, session)
updateWorkflowDefinition(workflowId, input, session)      // PATCH /project-workflows/{id}
createProjectTask(projectId, workflowId, input, session)
updateProjectTaskDefinition(taskId, input, session)
deleteProjectTask(taskId, session)
reorderProjectTasks(projectId, workflowId, taskIds, session)
createProjectContent(projectId, taskId, input, session)
updateProjectContent(contentId, input, session)
deleteProjectContent(contentId, session)
uploadTaskAttachment(projectId, taskId, file, session)
deleteTaskAttachment(projectId, attachmentId, session)
downloadTaskAttachment(projectId, attachmentId, session)  // 鉴权 Blob + downloadBlob(原始文件名)
```

## 10. 迁移与回滚

- 建迁移前必做（仓库约定）：`git fetch origin && git rebase origin/main` →
  `cd backend && .venv/bin/alembic heads` 确认**只有一个 head** → 再建。
- 同步 head 为 275 时，新迁移为 **`20261005_276_project_launch_template_customization.py`，
  `--rev-id 276`**；若 rebase 后 head 变化，取新 head 的**下一个数字**并保持日期前缀文件名
  （禁止随机 hash）。
- `upgrade`：
  1. 建 6 张表 + 索引 + Check 约束（FK 全部 `ON DELETE CASCADE`）。
  2. `project_workflows` 追加 `start_date`；`project_workflow_tasks` 追加
     `duration_days` / `start_date` / `end_date`（全部可空，既有行不动）。
  3. **种子** P1 两份模板：`store-launch-v1`（6 节点，前两个节点 `attachment_key` =
     `amazon_registration_form` / `worldfirst_registration_guide`）、
     `product-womens-swimwear-v1`（6 节点，`attachment_key` 全 `null`），
     标题/描述/顺序与 P1 `project_workflow_templates.py` **逐字一致**。
     `duration_days` 一律留空——P1 没有定义工期，不在迁移里替业务方编造计划数据
     （管理员在模板编辑器里填）。
  4. 种子写法：`op.get_bind()` 先 `SELECT` 是否存在该 `key`，不存在才 `INSERT`（幂等，PG/SQLite 通用）；
     **迁移文件内冻结字面量，不 import 应用代码**（应用代码会演进，旧迁移必须自包含）。
- `downgrade`：按 `project_workflow_task_attachments` → `project_workflow_task_contents` →
  追加列 → `workflow_template_task_attachments` → `workflow_template_task_contents` →
  `workflow_template_tasks` → `workflow_templates` 顺序 drop / drop_column（先删子表）。
  种子数据随表一起消失，无需单独 delete。
- 回滚对 P1 无影响：P1 的表结构回到 275 时状态，`project_workflows.template_key` 是普通字符串列
  （无 FK）。
- 运行时改造：`project_workflow_templates.py` 只保留 `WORKFLOW_KIND_*` 与 `DOCUMENT_KEY_*`
  白名单常量（+ `DOCUMENT_KEYS` / `is_valid_document_key`），模板正文与 `list_templates()`
  等常量定义删除；`project_workflow_service` 改为从 DB 读模板。
- 部署顺序：迁移先于应用（新代码需要新表与种子数据）。
- `backend/scripts/check_alembic.py` 必须在 PR 前通过（单 head + 命名合规 + 无重复 id）。

## 11. 测试与验收

**新增测试（pytest，实测 47 例）**

- `backend/tests/api/test_project_workflow_templates.py`（16 例）：管理员模板 CRUD、节点增删改排序、
  多条内容增删改、复制模板（含节点/内容复制）、`key` 重复 422、`kind` 非法 422、
  `attachment_key` 白名单 422、排序 id 集合不匹配 422、**非管理员全部写接口 403**、
  **删除模板不影响已有项目进度**。
- `backend/tests/api/test_project_workflow_task_customization.py`（15 例）：项目节点增删改排序、
  多条内容增删改、**改模板不回写已有项目**、**工期+锚点推算阶段日期**、**手填日期优先且链式继续**、
  `end_date < start_date` 422、跨项目 404、非管理员写 403、
  **P1 `PATCH {status}` 对有项目权限的操作者仍 200（回归）**、概要暴露项目排期。
- `backend/tests/api/test_project_workflow_attachments.py`（16 例，R2 全部打桩）：上传（字段完整、
  key 前缀 `project-launch-{id}/task-{id}/` 且无 `..`）、列表（内嵌流程详情）、
  下载（`Content-Disposition` 带 RFC 5987 原始中文名、内容与 `Content-Type` 正确）、
  删除（**有其它引用时不调 R2 删除**、无引用时调用、R2 删除失败写 `r2_delete_failures`）、
  模板附件副本共享同一对象、跨项目下载 404、无权限 403、扩展名/MIME 400、超限 413、
  R2 未配置 503、对象缺失 404。

**回归测试（实测）**

- P1 既有 `backend/tests/api/test_project_workflows.py`：**17 passed / 0 failed**（契约不变）。
- P2 目标集（4 个文件）：**64 passed / 0 failed**。
- 全量 `tests/api`：**1490 passed / 21 failed / 11 skipped**，21 例全部是改动前既有失败
  （`platform_inspection` 8 / `page_render` 10 / `profile` 3，均为本地 R2 未配置等环境问题），
  与 main 上的失败集合一致；`passed` 增量 47 = 本 PR 新增测试数。
- 迁移往返：`276 → 275` 后 6 张新表与 4 个新列全部消失、`275 → 276` 重建并重新种入
  2 个模板 / 12 个节点 / 2 个 `attachment_key`；`python scripts/check_alembic.py` 通过。
- 前端（Seth）：`pnpm test` + `pnpm build` 通过；新增模板编辑器、内容/附件区、排期展示用例；
  非管理员不渲染模板入口的断言。

> 已知环境漂移（非本 PR 引入）：`frontend/types/api-generated/openapi.json` 在 main 上已落后于
> 后端（缺 P1 的 5 条 workflow 路径），且本地 FastAPI/Pydantic 版本重新导出会产生上万行噪声 diff。
> 本 PR **不动** `openapi.json` / `api.d.ts`；前端 `gen:api-types:check` 只校验这两个已提交文件
> 之间的一致性，不受影响。契约同步另开 issue 处理。

**验收标准（对齐 issue）**

- 管理员可新建/编辑模板与节点并排序；非管理员调用模板写接口 403。 ✅
- 项目内节点可增删改排序；改模板不回写已有项目进度。 ✅
- 节点附件可上传（R2）、列出、下载（鉴权 + 项目权限）、删除；跨项目越权被拒。 ✅
- 阶段日期/时长：按工期与锚点算出阶段起止，项目整体起止与时长由节点聚合。 ✅
- 一个节点支持多条内容与多个附件。 ✅
- 迁移可逆、`check_alembic.py` 通过；后端 pytest 目标集通过；前端 `pnpm test` + `pnpm build` 通过。
- P1 已上线的接口与数据不受破坏。 ✅

## 12. 口径确认状态

**已确认（Yawei 2026-10-05）**

1. 项目内节点的编辑**保持管理员方式** → 非管理员只能改状态 + 上传/删除附件。
2. 模板节点附件在创建项目时**复制记录**，与模板**共用同一个 R2 对象**。
3. 附件类型/大小上限：≤50 MB，允许 pdf/xlsx/xls/docx/doc/csv/txt/zip/png/jpg/jpeg/webp。
4. 附件桶公开与否**不作为约束**（登录态下查看，key 不外泄）；实现仍不下发 key/URL。
5. 模板删除：**硬删**（级联节点/内容/附件；已创建项目的快照不受影响）。
6. P1 两份固定文档：保留 `attachment_key` 兼容读、**不迁进附件表**；换原件用「上传模板节点附件」。

**仍待确认（不阻塞实现，实现按本稿默认）**

1. **排期口径的优先级规则**：当前是「手填日期优先；未手填的节点按 流程 `start_date` + 各自
   `duration_days` 链式推算；流程/项目整体取节点日期的并集区间」。
   若你期望的是「只填工期、日期全自动」或「只填日期、项目时长自动算」，说一声，服务层改一处即可
   （表结构不用动）。
2. **P1 种子模板的默认工期**：目前留空（不替业务方编造数据）。若你直接给一组默认天数，
   我可以补一条数据迁移。
3. 节点内容是否需要「每条内容各自带附件」？当前设计是**附件挂在节点层**（内容与附件并列）。
