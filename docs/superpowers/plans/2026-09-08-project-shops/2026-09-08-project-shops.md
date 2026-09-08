# 项目店铺映射实现计划

> **状态：** ✅ **计划完成，待执行**

> Issue: BLF-990；当前阶段：实现前计划已完成。

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。
**目标：** 为 Agent `GET /api/v1/agent/projects` 增加真实 `shop_id`、国家站点和项目级 `is_active`，以持久化映射表为唯一身份来源，不增加 shop 级 status。

**架构：** 新建 `project_shops` 表保存 `project_id + country + shop_id`，由外部店铺清单或后续绑定流程写入真实 ID。项目状态继续只读 `projects.is_active`；列表查询先按 agent `project_scope` 过滤项目，再一次性批量加载映射，避免 N+1 和越权泄露。现有响应字段保留，新增 `is_active` 与 `shops`。

**技术栈：** FastAPI、Pydantic、SQLAlchemy 2、Alembic、pytest、PostgreSQL/SQLite。

---

## 文件职责

- 创建 `backend/app/models/project_shop.py`：店铺映射 ORM 模型。
- 修改 `backend/app/models/project.py`：声明项目到店铺映射关系。
- 修改 `backend/app/models/__init__.py`：导出新模型，确保 metadata/Alembic 可发现。
- 创建 `backend/alembic/versions/20260908_265_project_shops.py`：创建表、外键、唯一约束和索引。
- 修改 `backend/app/schemas/external/projects.py`：定义 nested shop 和扩展 Agent 项目响应。
- 修改 `backend/app/services/external/projects_query.py`：批量读取 project_shops。
- 修改 `backend/app/api/v1/endpoints/agent/projects.py`：按权限范围组装 `is_active + shops`。
- 修改 `backend/tests/api/agent/test_projects_native.py`：覆盖响应字段、映射、状态和 scope 隔离。
- 修改 `backend/tests/services/test_external_projects_query.py`：覆盖批量店铺查询的空输入和排序契约。

## 数据契约

```json
{
  "project_id": 10,
  "project_name": "弥森",
  "country": "US",
  "country_name": "美国站",
  "is_active": true,
  "shops": [
    {"shop_id": "shop_7966...", "country": "US", "site": "美国站"}
  ]
}
```

- `country` 统一使用后端规范 `US / DE / UK`；`GB` 输入在写入前归一为 `UK`。
- `site` 由后端 `get_country_label_cn()` 派生，不落库，避免文案漂移。
- 不返回 shop 级 `status`。
- `is_active=false` 仍返回项目和映射，调用方可据此跳过整个项目；不制造第二个状态源。
- `project_id + country` 唯一；`shop_id` 全局唯一。
- 未有映射数据时 `shops=[]`，不生成伪造 ID。

### 任务 1：创建映射模型和数据库结构

- [ ] 编写模型级约束测试，确认 project/country 与 shop_id 唯一性契约。
- [ ] 运行定向测试确认新模型尚不存在并正确失败。
- [ ] 新建 `ProjectShop`，使用 Integer 主键、Project 外键、规范国家字符串、非空 shop_id、时间戳及唯一约束。
- [ ] 在 `Project` 添加 `shops` relationship，并导出 `ProjectShop`。
- [ ] 创建 revision `265`，`down_revision='264'`，表名 `project_shops`，添加 project FK `ON DELETE CASCADE`、唯一约束和 `(project_id, country)` 索引。
- [ ] 运行模型测试和 `python scripts/check_alembic.py`。

### 任务 2：扩展共享 schema、查询和 Agent 端点

- [ ] 先添加端点行为测试：带映射返回 nested shops、项目级 `is_active` 原样返回、scope 外项目及其 shops 不返回。
- [ ] 运行测试确认因 schema/查询尚未实现而失败。
- [ ] 添加 `AgentShopItem` 与 `ProjectItem.is_active/shops`，保留原字段默认值以兼容既有消费者。
- [ ] 在 `projects_query` 增加按 project ID 批量读取映射的函数；空项目列表不查询数据库，结果按 project 与 country 稳定排序。
- [ ] 在 Agent handler 完成 project scope 过滤后批量加载 shops，使用 `get_country_label_cn` 生成 site，并组装项目级 `is_active`。
- [ ] 更新 parity 断言为新响应契约。
- [ ] 运行 Agent 定向测试。

### 任务 3：补齐维护边界和回归验证

- [ ] 添加 service 测试覆盖空项目列表、无映射返回空集合、多个项目批量分组。
- [ ] 添加端点测试覆盖 archived/all 状态下的 `is_active` 语义及 name 精确过滤不破坏 nested shops。
- [ ] 检查所有公共符号引用，确认未修改内部 `/api/v1/projects` dropdown 契约。
- [ ] 运行 `cd backend && pytest tests/api/agent/test_projects_native.py tests/services/test_external_projects_query.py -q`。
- [ ] 运行 `cd backend && python scripts/check_alembic.py`；若环境具备迁移数据库，再执行迁移 smoke check。
- [ ] 记录 CodeGraph 影响面结论：Agent projects handler 唯一响应组装调用方；shared `projects_query.list_projects` 的既有调用方保持签名不变。
