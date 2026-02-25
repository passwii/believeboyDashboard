# SQLite 查询缓存机制（SKU 成本列表）

> 更新时间：2026-02-25  
> 作用范围：`/api/v1/product-costs` 列表查询

## 目标

- 降低后端对 Supabase 的重复查询压力。
- 提升相同筛选条件下的重复访问响应速度。
- 在不引入额外中间件的前提下，提供可落盘、可观测的短期缓存。

## 架构说明

- 主数据源：Supabase PostgreSQL（业务真值）。
- 缓存数据源：本地 SQLite（仅缓存列表查询结果）。
- 缓存逻辑位置：`backend/app/services/product_cost_cache_service.py`。

## 缓存文件路径

- 默认路径：`backend/storage/cache/query_cache.db`
- 由配置项控制：`PRODUCT_COST_CACHE_SQLITE_PATH`

## 缓存表结构

缓存库中的表名为 `query_cache`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `cache_key` | `text` | 主键，包含筛选参数与分页参数 |
| `payload` | `text` | JSON 字符串，保存接口响应体 |
| `expires_at` | `integer` | 过期时间（Unix 时间戳，秒） |
| `updated_at` | `integer` | 写入/更新时间（Unix 时间戳，秒） |

## 缓存 Key 规则

缓存前缀：`product_costs:list:`  
Key 组成元素：

- `project_name`
- `sku`
- `asin`
- `page`
- `page_size`
- `include_total`

说明：不同筛选条件或分页参数会生成不同缓存条目。

## 命中与回填流程

1. 请求 `/api/v1/product-costs`。
2. 先按当前参数生成 `cache_key`，查询 SQLite 缓存表。
3. 命中且未过期：直接返回缓存结果。
4. 未命中或已过期：查询 Supabase，拿到结果后写入 SQLite 缓存，再返回。

## 失效策略

以下写操作成功后，会清空 SKU 列表缓存前缀（避免脏读）：

- `POST /api/v1/product-costs`
- `POST /api/v1/product-costs/bulk`
- `POST /api/v1/product-costs/import-csv`
- `POST /api/v1/product-costs/import-blf-basic-info`

## TTL 配置

- 配置项：`PRODUCT_COST_LIST_CACHE_TTL_SECONDS`
- 默认值：`259200` 秒（72 小时）
- 建议值：按业务实时性调整；当前系统默认以稳定性优先。

## 配置示例（backend/.env）

```bash
PRODUCT_COST_LIST_CACHE_TTL_SECONDS=259200
PRODUCT_COST_CACHE_SQLITE_PATH=./storage/cache/query_cache.db
```

## 系统管理数据管理页（新增）

在前端页面 `/dashboard/system-management/data-management` 可查看数据库与缓存状态，并手动清理缓存。

### 状态接口

- `GET /api/v1/system-management/data-management/status`
- 返回信息包含：
  - 服务端时间
  - 数据库引擎、数据源、连通性、检查时间
  - 缓存文件路径、是否存在、文件大小、TTL、总记录/有效记录/过期记录
  - 最近写入时间、最近到期时间

### 清除缓存接口

- `POST /api/v1/system-management/data-management/cache/clear`
- 行为：清空 `query_cache` 全部记录
- 返回：清理时间、删除记录数

## 生效与验证

1. 重启后端服务。
2. 访问一次 SKU 成本列表页面（或直接调用列表接口）。
3. 检查缓存库和记录：

```bash
ls -la /Users/damon/PycharmProjects/believeboyDashboard/backend/storage/cache
sqlite3 /Users/damon/PycharmProjects/believeboyDashboard/backend/storage/cache/query_cache.db ".tables"
sqlite3 /Users/damon/PycharmProjects/believeboyDashboard/backend/storage/cache/query_cache.db "select count(*) from query_cache;"
```

当 `query_cache` 存在且记录数大于 0，表示缓存已生效。

## 注意事项

- SQLite 缓存属于“单机本地缓存”，多实例部署不会自动共享。
- 缓存库是性能加速层，不是主数据源；业务数据仍以 Supabase 为准。
- 如果缓存文件被删除，系统会在下一次请求时自动重建缓存表。
