# Agent 新品测算对比矩阵导出设计

> **状态**：设计定稿（2026-09-29 用户确认接口、字段映射与异常策略）。
> **范围**：为 Agent 的新品测算域增加按快照记录 ID 导出 XLSX 对比矩阵的能力。
> **不涉及**：新增数据库迁移、修改前端现有手动导出、重新计算定价或改写已保存快照。

## 1. 目标

Agent 先通过现有新品测算接口提交快照，再调用列表接口获得 `snapshot_ids`，
选择最多 12 条记录导出与前端「测算对比矩阵」同构的 Excel 文件。

导出数据必须来自后端已保存的快照，不在 Agent 或客户端重新试算。

## 2. 接口

新增路由：

```http
GET /api/v1/agent/projects/{project_id}/new-product-calculations/export.xlsx
    ?snapshot_ids=1&snapshot_ids=2
```

### 2.1 请求参数

| 参数 | 位置 | 必填 | 约束 |
|---|---|---|---|
| `project_id` | path | 是 | 目标项目 |
| `snapshot_ids` | query，可重复 | 是 | 1 到 12 个正整数，不允许重复 |

鉴权、`business_scope=new_product_calculations` 和 `project_scope` 继续复用
现有 Agent 路由依赖。

### 2.2 成功响应

成功时直接返回 XLSX 二进制流，不包裹 `agent_ok`，不使用 Base64：

```http
Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
Content-Disposition: attachment; filename="..."; filename*=UTF-8''...
Content-Length: <bytes>
```

文件名包含项目名、选中记录数量和 UTC 导出时间。

## 3. 数据流

1. 路由解析并校验 `snapshot_ids`：数量、正整数、去重约束。
2. 路由确认项目存在，并执行一次按 `id IN (...)` 的快照查询。
3. 查询结果必须全部属于路径中的 `project_id`；否则整个请求失败，不生成部分文件。
4. 服务层按请求 ID 顺序排列快照，生成内存中的 XLSX 字节流。
5. 路由写一条成功导出审计并在同一事务提交。
6. 路由返回 `StreamingResponse` 或等价二进制响应。

任一 ID 不存在或跨项目时返回 `400 VALIDATION_FAILED`，`details` 包含
`missing_snapshot_ids`，调用方修正后整批重试。

## 4. Excel 结构

工作簿使用单 sheet `测算对比矩阵`，冻结首行和左侧两列。每个
`snapshot_id` 对应一个数据列，列顺序严格保持请求中的 `snapshot_ids` 顺序。

分区顺序固定为：

1. 货品数据
2. DDP 成本
3. 费用支出
4. 售价与利润
5. 核算规则

列结构和前端 `getExportComparisonSections()` 保持一致，包括前端导出额外附加的
SKU、国家站点、测算时间、竞品链接、体积、头程单价、头程数量、计费重规则、
产品重、体积重和尺寸行。

### 4.1 字段映射

| Excel 行 | 快照来源 |
|---|---|
| 产品名称 | `project_name / sku` |
| 测算类型 | `calculation_type` 映射中文标签 |
| SKU | `sku` |
| 国家站点 | `country`，空值显示 `-` |
| 测算时间 | `created_at` |
| 包装尺寸、重量、体积 | 快照尺寸/重量字段 |
| FOB、头程、DDP、售价、回款、利润 | 快照对应字段 |
| 平台佣金/广告费/派送/配置/仓储/退货损耗/费用合计 | 快照费用拆项 |
| 平台佣金率 | `referral_fee_usd / sale_price_usd` |
| 广告费率、退货折损率、利润率 | 快照对应比例 |
| 尺寸等级、售价带、规则标签、汇率、计费重 | 快照对应字段 |

### 4.2 缺失字段

以下字段在前端运行时记录中存在，但当前新品测算快照没有持久化：

| Excel 行 | 处理 |
|---|---|
| 竞品链接 | 显示 `-` |
| 头程单价(RMB/kg) | 显示 `-` |
| 头程数量 | 显示 `-` |

不得用默认值、重新计算或猜测值填充以上字段。平台佣金率只从已保存费用反推，
不调用定价引擎。

## 5. 错误处理

| 场景 | 结果 |
|---|---|
| `snapshot_ids` 缺失、空、超过 12 条或含非正整数 | `400 VALIDATION_FAILED` |
| `snapshot_ids` 重复 | `400 VALIDATION_FAILED` |
| 项目不存在 | `404 RESOURCE_NOT_FOUND` |
| 任一快照不存在 | `400 VALIDATION_FAILED`，details 返回缺失 ID |
| 任一快照不属于当前项目 | 与不存在相同处理，不泄露跨项目数据 |
| 记录数、权限或 scope 不合法 | 统一由现有 Agent 错误壳返回 |

## 6. 审计

成功导出写一条 `operation_audit_logs`：

- `action = "new_product_calculation.export"`
- `target_type = "new_product_calculation"`
- `target_id = project_id`
- `after.snapshot_ids`：请求顺序中的 ID
- `after.row_count`：实际导出记录数
- `after.column_count`：实际 Excel 数据列数
- `agent_id` / `agent_name` / `idempotency_key`：复用 Agent 审计归因
- 不记录文件内容

校验失败或未生成文件时不写成功导出审计。

## 7. 测试

### 7.1 服务层

- 按请求 ID 顺序生成列。
- 五个分区和列标签与前端导出结构一致。
- 快照字段数值、百分比和文本映射正确。
- `-` 缺失字段不会被默认值替换。
- 平台佣金率由 `referral_fee_usd / sale_price_usd` 反推。
- 12 条记录可导出，生成有效 XLSX。

### 7.2 API 层

- 成功导出返回 XLSX media type、`Content-Disposition` 和 `Content-Length`。
- 返回内容可被 `openpyxl` 读取。
- 请求顺序决定 Excel 列顺序。
- 缺失、重复、超过 12 条、非正整数参数返回统一错误壳。
- 跨项目或不存在记录整批拒绝。
- 成功导出写审计；失败不写成功导出审计。
- 缺少 `new_product_calculations` business scope 或 `project_scope` 时拒绝访问。

## 8. 决策记录

| 决策 | 结果 |
|---|---|
| 选择方式 | 使用 `snapshot_ids`，不使用 SKU 或 SKU + 类型组合 |
| 数量上限 | 最多 12 条，与前端对比矩阵一致 |
| HTTP 方式 | `GET` 文件资源，成功返回二进制流 |
| 数据源 | 只读 `new_product_calculations` 已保存快照 |
| 缺失字段 | 保留行并显示 `-` |
| 平台佣金率 | 由已保存平台佣金除以售价反推 |
| 项目隔离 | 任一记录跨项目即整批失败 |
| 数据库 | 不新增迁移 |
| 前端 | 不修改现有手动导出 |

## 9. 修订记录

- **v1.0（2026-09-29）**：用户确认接口为重复 Query 参数 `snapshot_ids`、
  最多 12 条、二进制 XLSX 流、缺失字段显示 `-`。
