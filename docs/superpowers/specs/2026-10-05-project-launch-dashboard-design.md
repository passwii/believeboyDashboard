# 项目启动台设计稿（店铺启动单线程 + 产品开发多线程）

- Issue：BLF-1234
- 日期：2026-10-05
- 状态：后端已落地（revision 275）；前端待实现
- 相关：`backend/app/models/project_workflow.py`、`backend/app/services/project_workflow_service.py`、`backend/app/api/v1/endpoints/project_workflows.py`

## 1. 背景与目标

项目启动阶段的管理信息目前散落在 Excel、聊天记录和人工记忆里：新项目要收集哪些注册资料、
注册到哪一步、万里汇收款账户是否开通、产品开发走到选款还是打样，没有统一视图。

本设计交付一个**持久化的项目启动台**：

- 一条「店铺启动」单线程：注册资料收集 → 收款账户 → 业务审核 → 品牌备案 → UPC 豁免 → 收款账户绑定验证。
- 多条「产品开发」多线程：每个产品实例一条流程（选款 → 打样 → 包装 → 吊卡 → 洗标 → 完整款打样邮寄）。
- 每个项目可维护 **1 条店铺启动流程 + N 条产品开发流程**，同一时间段并行推进。

## 2. 范围与非目标

**范围内**

- 项目 × 流程 × 任务进度的持久化（PostgreSQL），模板快照复制。
- 汇总视图：所有可见项目的流程进度（Tab 分类切换）。
- 两个对外文档的受保护下载（注册信息收集表、万里汇收款注册流程）。

**非目标（本阶段不做）**

- 不把亚马逊注册表里的具体字段值（主体名称、税号等）抄进系统，只跟踪状态。
- 不做流程模板的可视化编辑器（模板先在后端定义，文案占位可改）。
- 不做节点自动通知/邮件发送（"到节点发送给对方的文件"下一阶段）。
- 不改动 `/api/v1/projects/manage` 的既有契约。

## 3. 领域模型

新增两张表（`backend/alembic/versions/20261005_275_create_project_workflows.py`）。

### 3.1 `project_workflows`（流程实例）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | Integer PK | |
| `project_id` | FK → `projects.id` | `ON DELETE CASCADE` |
| `kind` | String(32) | `store_launch` / `product_development`，Check 约束 |
| `title` | String(160) | 展示名（产品流程可为「女士泳衣A款」） |
| `template_key` | String(80) | 来源模板键，创建后仅作溯源 |
| `created_at` / `updated_at` | DateTime(tz) | |

约束：`ix_project_workflows_project_kind(project_id, kind)` +
**部分唯一索引** `uq_project_workflows_store_launch_project_id`
（`WHERE kind = 'store_launch'`）→ 每项目至多一条店铺启动；产品开发不受限，可多条。

### 3.2 `project_workflow_tasks`（任务快照）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | Integer PK | |
| `workflow_id` | FK → `project_workflows.id` | `ON DELETE CASCADE` |
| `title` | String(160) | 创建时从模板复制 |
| `description` | Text, nullable | 创建时从模板复制（占位文案） |
| `sort_order` | Integer | 稳定顺序（模板序号） |
| `status` | String(32) | 四态，Check 约束 |
| `attachment_key` | String(64), nullable | 白名单文档键 |
| `created_at` / `updated_at` | DateTime(tz) | |

约束：`ix_project_workflow_tasks_workflow_sort(workflow_id, sort_order)`。

### 3.3 快照语义（重要）

创建流程时把模板的任务标题/描述/顺序/附件键**复制**进项目行。

> 之后修改模板文案**不会**覆盖已有项目的进度与文案。
> 已开跑的项目保持历史口径，新项目才用新模板。

## 4. 状态机与派生规则

任务四态：`not_started` / `in_progress` / `waiting_on_partner` / `completed`。
流程状态**不落库**，由任务派生（优先级从高到低）：

1. 有任务且全部 `completed` → `completed`
2. 任一 `in_progress` → `in_progress`
3. 无进行中但存在 `waiting_on_partner` → `waiting_on_partner`
4. 否则 `not_started`

项目层不单独存状态：无任何流程 → UI 显示「未启动」；有流程 → 显示流程聚合结果
（店铺启动 + 各产品流程的进度分别展示，不强行压成单一值）。

## 5. API 契约

全部在 `protected`（API-Key）之下，项目级读写在服务调用前执行
`project_service.ensure_project_access`（非管理员的 operator 必须匹配项目负责人/助理）。
路径挂在 `/api/v1` 下，前端经 `/api/backend/api/v1/...` 代理访问。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/project-workflows/templates` | 模板元数据 `{templates:[{key,kind,title}]}`；不下发模板任务正文 |
| GET | `/project-workflows/summary` | 可见项目流程概要；一次批量查询，无逐项目 fan-out |
| GET | `/projects/{project_id}/workflows` | 单项目流程 + 有序任务 |
| POST | `/projects/{project_id}/workflows` | `{kind, template_key, title?}` → 快照复制 |
| PATCH | `/project-workflow-tasks/{task_id}` | `{status}` → 返回所属流程（含派生状态） |
| GET | `/projects/{project_id}/workflows/documents/{document_key}` | 白名单文档下载 |

响应要点（前端类型见 `frontend/lib/project-workflows-api.ts`）：

```ts
type WorkflowStatus = 'not_started' | 'in_progress' | 'waiting_on_partner' | 'completed'
type ProjectWorkflow = {
  id: number; project_id: number; kind: 'store_launch' | 'product_development'
  title: string; template_key: string; status: WorkflowStatus
  task_count: number; completed_task_count: number
  tasks: Array<{ id: number; workflow_id: number; title: string; description: string | null
                 sort_order: number; status: WorkflowStatus; attachment_key: string | null }>
}
type ProjectWorkflowSummary = {
  project_id: number
  workflows: Array<{ id: number; kind: string; title: string; template_key: string
                     status: WorkflowStatus; completed_task_count: number; task_count: number }>
}
```

错误语义：项目/任务不存在 → `404`；模板不存在、模板与 kind 不匹配、非法状态 → `422`；
无项目权限 → `403`。重复创建店铺启动流程 → `200` + **已存在的那条流程**（幂等，不重复建表行）。

## 6. 权限与文档保护

- 两个文档不进 `frontend/public`，不挂静态路由；只经上面的受保护 GET 流式返回。
- 服务器固定路径：`backend/app/resources/project_launch_documents/`。
- 白名单键 → 固定路径 + 原始文件名 + MIME，**绝不由用户输入拼路径**：

| document_key | 文件 | MIME |
| --- | --- | --- |
| `amazon_registration_form` | 亚马逊_注册信息收集表.xlsx | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` |
| `worldfirst_registration_guide` | 万里汇海外收款注册流程.pdf | `application/pdf` |

- 未知键或文件缺失 → `404`（不泄露路径细节），日志不记录文件字节或表格内容。

## 7. 前端 UX 契约

- **导航**：侧栏独立顶级分组「项目管理」，唯一入口「项目启动台」，
  路由 `/dashboard/operations/project-launch`（与「运营」并列，不挂在运营下）。
- **桌面布局**：左侧项目列表 + 右侧项目详情分栏；每行显示项目名、聚合状态、
  店铺启动进度、各产品流程进度。
- **Tab（分类展示）**：`概览 / 店铺启动 / 产品开发`（`Tabs variant="term"`）。
  - 概览：项目状态、各流程进度、每个流程的「第一个未完成任务」。
  - 店铺启动：6 条有序任务；不存在时提供「启用店铺启动流程」（创建 `store-launch-v1`）。
  - 产品开发：每个产品实例独立分组；新增对话框读取模板目录、要求填写产品/流程标题
    （默认「女士泳衣」），创建 `product-womens-swimwear-v1`。
- **任务行**：标题 + 模板短描述 + 状态控件 + （仅有 `attachment_key` 时）下载按钮。
- **状态呈现**：无流程 → 「未启动」；有流程 → 派生状态（未开始/进行中/等待对方/已完成）。
- **数据获取**：`fetchManagedProjectsCached(session)` + `fetchSummary(session)` 渲染列表，
  不做逐项目请求；创建/改状态成功后**同时**刷新详情与概要，保证列表与详情一致。
- **状态与错误**：loading / 无项目 / 无流程 / 概要请求失败 / 详情请求失败 分别显式呈现；
  写失败展示服务端错误并保留上一次已保存状态（乐观更新要回滚）。
- **响应式**：窄屏左侧列表换成项目选择器，内容纵向堆叠，不出现横向溢出。
- **视觉**：遵循 `frontend/docs/design-spec.md` 的 Terminal V3（term 令牌、零圆角、零阴影、1px 边框）。

## 8. 模板与可改文案

模板定义在 `backend/app/services/project_workflow_templates.py`（`store-launch-v1`、
`product-womens-swimwear-v1`），描述文案为占位符，业务方后续直接改这个文件即可，
不影响已创建项目的进度。

- 店铺启动 6 步：店铺注册资料收集（附收集表）/ 万里汇收款账户注册（附注册流程）/
  店铺业务审核 / 品牌备案 / UPC 注册豁免 / 收款账户后台绑定验证。
- 女士泳衣 6 步：产品选款对接 / 产品打样对接 / 产品包装设计 / 产品吊卡设计 / 产品洗标 /
  完整款打样、打包与邮寄。

## 9. 待确认（给业务方）

1. 「万里汇海外收款注册流程.pdf」原件来自本地 Downloads，请确认这就是要发给对方的那版；
   替换只需覆盖同名文件。
2. 产品模板除「女士泳衣」外，是否需要按品类（如家居、饰品）各建一套模板？当前接口已支持多模板。
3. 任务是否需要责任人/截止日期字段？当前版本只有状态（保持最小可用）。
4. 是否需要「到节点自动把附件发给对方」（邮件/飞书）？当前只有手动下载。

## 10. 验收与测试

- `backend/tests/api/test_project_workflows.py` 覆盖：模板目录、批量概要、店铺启动幂等、
  产品开发可重复、状态派生与流转、非法模板/状态校验、404/403、文档白名单与越权。
- 迁移可逆：`alembic upgrade head` / `alembic downgrade -1` 往返通过；
  `python scripts/check_alembic.py` 通过（单 head、命名合规）。
